'use strict';

/**
 * Витрина v3 (решение владельца 15.09, вечер): ОДИН Room Type — две группы предложений.
 * В ответе /search/hotel_rooms (прокси GET /hotels-rooms) отдельная комната `totus-<id>` больше НЕ создаётся:
 * наши предложения («Arlekino») добавляются ВНУТРЬ исходного номера LT — в начало соответствующих `offers[meal]`.
 * Frontend получает тот же формат HotelRoom:
 *   { ID, min_price, meal_types[], room {...}, offers { [meal]: Offer[] }, lt_extras, labels? }
 * и делит предложения номера на группы «Arlekino» / «Level.Travel» по `offer.lt_extras.totus.custom` (хелпер isArlekinoOffer).
 *
 * Для каждой активной Room Type отеля:
 *   - ищем исходный номер ТОЛЬКО по `room.id === source_room_id` (числовой ключ; запасной связи по названию нет —
 *     дедупликация по имени запрещена);
 *   - шаблоны: если meal_types заданы — самое дешёвое предложение источника на каждое питание,
 *     иначе — одно самое дешёвое предложение источника;
 *   - клоны шаблонов с нашей ценой (fixed | rule), id = "t<rt>-<n>-<hash>", operator_id/operator_name = наши («Arlekino»),
 *     `lt_extras.totus = { custom:true, roomTypeId, sourceOfferId, meal, mode, source:'arlekino' }` — вставляются
 *     в начало `offers[meal]` исходного номера; предложения LT не удаляются и не переписываются (их порядок сохраняется);
 *   - у номера `lt_extras.totus = { roomTypeId, customOffers, sourceRoomId }` (у LT `lt_extras` обычно null — создаём объект);
 *   - контент Room Type (описание/удобства/фото) на витрину НЕ применяется — карточка одна, LT-шная; `content` — для админки;
 *   - пересчитываем min_price, meal_types[].min_price, filters.meals[].min_price, min_price отеля по всем предложениям.
 * Всё остальное — как отдал LT. Нет источника в выдаче (или у него нет offers) — наших предложений нет.
 *
 * Exclusive (бриф «Наш отель», 16.09.2026): если у Room Type включён флаг `exclusive` («продавать только наши
 * предложения»), после вставки наших offers из ответа убираются предложения Level.Travel — при `exclusiveScope='room'`
 * только в исходном номере Room Type, при `'hotel'` во всех номерах отеля (applyExclusive). Наши offers не удаляются
 * никогда; номера, оставшиеся без предложений, убираются из `result`; минимумы пересчитываются. По умолчанию
 * (`exclusive = 0` у всех Room Type отеля) не выполняется ни одной дополнительной проверки — поведение прежнее.
 */

const store = require('./store');
const diag = require('./diag');
const { computePrice, pricingSnapshot, pricingLabel } = require('./pricing');

// Префикс отдельной комнаты v2 (`ID: totus-<id>`) — с v3 на витрине не используется; оставлен для обратной совместимости/тестов.
const VIRTUAL_ROOM_PREFIX = 'totus-';
const VIRTUAL_OFFER_RE = /^t(\d+)-(\d+)-([a-z0-9]+)$/i;
const OFFER_SOURCE = 'arlekino';

function isVirtualOfferId(id) { return VIRTUAL_OFFER_RE.test(String(id || '')); }

/** Наше предложение (группа «Arlekino») — только по метке lt_extras.totus.custom, не по id/оператору/названию. */
function isArlekinoOffer(o) { return Boolean(o && o.lt_extras && o.lt_extras.totus && o.lt_extras.totus.custom); }

function hash(s) {
    let h = 5381;
    const str = String(s);
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
}

function nightsOf(offer) {
    const n = Number(offer && offer.nights_count);
    return Number.isFinite(n) && n > 0 ? n : null;
}

function priceOf(o) { const p = Number(o && o.price); return Number.isFinite(p) && p > 0 ? p : null; }

/**
 * Предложения-шаблоны исходного номера: [{meal, offer}]. Наши предложения (уже вставленные) шаблоном не бывают.
 * meal_types заданы → самое дешёвое предложение на каждое указанное питание (если оно есть у номера);
 * иначе → одно самое дешёвое предложение номера (любое питание, любой оператор).
 */
function pickTemplateOffers(sourceRoom, rt) {
    const meals = rt.mealTypes && rt.mealTypes.length ? rt.mealTypes.map(String) : null;
    const offers = sourceRoom && sourceRoom.offers && typeof sourceRoom.offers === 'object' ? sourceRoom.offers : {};
    const cheapest = {};
    for (const [meal, list] of Object.entries(offers)) {
        if (!Array.isArray(list)) continue;
        if (meals && !meals.includes(String(meal))) continue;
        for (const o of list) {
            if (isArlekinoOffer(o)) continue;
            const p = priceOf(o);
            if (p === null) continue;
            if (!cheapest[meal] || p < priceOf(cheapest[meal])) cheapest[meal] = o;
        }
    }
    if (meals) return meals.filter((m) => cheapest[m]).map((m) => ({ meal: m, offer: cheapest[m] }));
    let best = null;
    for (const [meal, offer] of Object.entries(cheapest)) if (!best || priceOf(offer) < priceOf(best.offer)) best = { meal, offer };
    return best ? [best] : [];
}

/** v1 (совместимость/админка): предложения источника выбранных операторов (и питания, если ограничено): [{meal, offer}] */
function pickSourceOffers(sourceRoom, rt) {
    const ops = new Set((rt.operatorIds || []).map(Number));
    const meals = rt.mealTypes && rt.mealTypes.length ? new Set(rt.mealTypes.map(String)) : null;
    const out = [];
    const offers = sourceRoom.offers && typeof sourceRoom.offers === 'object' ? sourceRoom.offers : {};
    for (const [meal, list] of Object.entries(offers)) {
        if (!Array.isArray(list)) continue;
        if (meals && !meals.has(String(meal))) continue;
        for (const o of list) {
            if (!o || typeof o !== 'object' || isArlekinoOffer(o)) continue;
            if (ops.size && !ops.has(Number(o.operator_id))) continue;
            out.push({ meal, offer: o });
        }
    }
    return out;
}

function operatorIdOf(rt) {
    const own = Number(rt.operatorId);
    if (Number.isInteger(own) && own > 0) return own;
    return 990000 + Number(rt.id);
}
function operatorNameOf(rt) { return rt.operatorName ? String(rt.operatorName) : 'Arlekino'; }

/** Клон предложения-шаблона с нашей ценой и нашим оператором («Arlekino»). Шаблон не мутируется. */
function makeVirtualOffer(o, rt, meal, idx, priced) {
    const nights = nightsOf(o);
    const clone = JSON.parse(JSON.stringify(o));
    clone.id = `t${rt.id}-${idx}-${hash(o.id)}`;
    clone.price = priced.final;
    clone.operator_id = operatorIdOf(rt);
    clone.operator_name = operatorNameOf(rt);
    if ('analytics_price' in clone) clone.analytics_price = priced.final;
    if (nights) clone.price_per_night = Math.round(priced.final / nights);
    if (typeof clone.link === 'string' && o.id !== undefined && o.id !== null) clone.link = clone.link.split(String(o.id)).join(clone.id);
    if (clone.extras && typeof clone.extras === 'object') {
        // спец-метки LT про цену (cheap/best_price) относятся к цене провайдера — снимаем
        if ('cheap' in clone.extras) clone.extras.cheap = false;
        if ('best_price' in clone.extras) clone.extras.best_price = false;
    }
    const mode = priced.mode || (rt.pricing && rt.pricing.mode) || rt.pricingMode || 'rule';
    clone.lt_extras = Object.assign({}, clone.lt_extras || {}, { totus: { custom: true, roomTypeId: rt.id, sourceOfferId: String(o.id), meal, mode, source: OFFER_SOURCE } });
    return clone;
}

/** Наши предложения — в начало offers[meal] (после уже вставленных наших, чтобы сохранить порядок Room Type). */
function prependOffers(sourceRoom, meal, ours) {
    if (!sourceRoom.offers || typeof sourceRoom.offers !== 'object') sourceRoom.offers = {};
    const list = Array.isArray(sourceRoom.offers[meal]) ? sourceRoom.offers[meal] : [];
    let at = 0;
    while (at < list.length && isArlekinoOffer(list[at])) at += 1;
    list.splice(at, 0, ...ours);
    sourceRoom.offers[meal] = list;
}

/** Пересчёт минимумов номера по всем предложениям (наши + LT). Возвращает минимумы по питанию. */
function recomputeRoomMins(room) {
    let min = null;
    const mealMins = {};
    for (const [meal, list] of Object.entries(room.offers || {})) {
        for (const o of list || []) {
            const p = Number(o && o.price);
            if (!Number.isFinite(p)) continue;
            if (min === null || p < min) min = p;
            if (mealMins[meal] === undefined || p < mealMins[meal]) mealMins[meal] = p;
        }
    }
    room.min_price = min;
    if (Array.isArray(room.meal_types)) {
        // типы питания без предложений убираем, остальным — актуальный минимум
        room.meal_types = room.meal_types.filter((mt) => mt && mealMins[mt.id] !== undefined);
        for (const mt of room.meal_types) mt.min_price = mealMins[mt.id];
    }
    return mealMins;
}

/**
 * Exclusive: убрать из ответа предложения Level.Travel там, где владелец включил «продавать только наши предложения».
 * `rts` — уже загруженные активные Room Type отеля (дополнительных запросов в БД нет).
 * Наши предложения (`lt_extras.totus.custom`) не удаляются никогда; питание без предложений убирается из `offers`,
 * номер без предложений — из `result` (массив правится на месте). Минимумы номера пересчитываются.
 * Возвращает { applied, scope: 'room'|'hotel'|null, hidden, dropped }; applied=false — ответ не изменён.
 */
function applyExclusive(result, rts) {
    const ex = store.exclusiveFromRoomTypes(rts);
    if (!ex.wholeHotel && !ex.rooms.size) return { applied: false, scope: null, hidden: 0, dropped: 0 };
    const scope = ex.wholeHotel ? 'hotel' : 'room';
    const keep = [];
    let hidden = 0;
    let dropped = 0;
    for (const room of result) {
        const roomId = room && room.room && room.room.id !== undefined && room.room.id !== null ? Number(room.room.id) : null;
        const affected = ex.wholeHotel || (roomId !== null && ex.rooms.has(roomId));
        if (!affected || !room || !room.offers || typeof room.offers !== 'object') { keep.push(room); continue; }
        let changed = false;
        for (const [meal, list] of Object.entries(room.offers)) {
            if (!Array.isArray(list)) continue;
            const ours = list.filter(isArlekinoOffer);
            if (ours.length === list.length) continue;
            hidden += list.length - ours.length;
            changed = true;
            if (ours.length) room.offers[meal] = ours;
            else delete room.offers[meal];
        }
        if (!changed) { keep.push(room); continue; }
        recomputeRoomMins(room);
        const left = Object.values(room.offers).reduce((n, l) => n + (Array.isArray(l) ? l.length : 0), 0);
        if (!left) { dropped += 1; continue; }
        keep.push(room);
    }
    if (dropped) result.splice(0, result.length, ...keep);
    return { applied: hidden > 0 || dropped > 0, scope, hidden, dropped };
}

/**
 * Индекс исходного номера в result[]: ТОЛЬКО по room.id === source_room_id (стабильный числовой ключ).
 * Запасной связи по названию нет (v3): один и тот же номер под другим room.id — это другой номер.
 * Возвращает { idx, by: 'id' } или null.
 */
function findSourceIndex(result, byRoomId, rt) {
    const idx = byRoomId.get(Number(rt.sourceRoomId));
    return idx !== undefined ? { idx, by: 'id' } : null;
}

/** Причина пропуска: одна строка в лог + last_skip_reason (если колонки есть). */
function skip(ctx, rt, reason) {
    diag.log(`hotel ${ctx.hotelId}: rt ${rt.id} — skipped:${reason}`);
    store.markChecked(rt.id, reason).catch(() => {});
}

/**
 * Основная функция. data — тело ответа LT. ctx: { requestId, hotelId, searchType }.
 * Возвращает новое тело (или исходное, если нечего менять). Номера в result не добавляются и не удаляются —
 * меняются только offers/минимумы исходных номеров.
 * Для каждой активной Room Type отеля пишется строка `[custom-rooms] hotel <id>: rt <id> — injected|skipped:<reason>`
 * (reason: no_pricing | search_type | source_room_missing (ids in result: …) | no_offers | no_priced_offers)
 * и сохраняется last_skip_reason/last_checked_at — видно в админке и в GET /api/admin/rooms/diagnostics.
 */
async function injectRooms(data, ctx) {
    if (!data || typeof data !== 'object' || !Array.isArray(data.result) || !data.result.length) return data;
    const settings = await store.getSettings();
    const rts = await store.activeRoomTypesForHotel(ctx.hotelId);
    if (!rts.length) return data;

    const result = data.result;
    const byRoomId = new Map();
    result.forEach((r, i) => { if (r && r.room && r.room.id !== undefined && r.room.id !== null) byRoomId.set(Number(r.room.id), i); });
    const idsInResult = [...byRoomId.keys()];

    const injected = [];   // { idx, rt, n }
    const mapEntries = [];
    const priceLogs = [];
    const touched = new Set();
    const backups = new Map(); // idx → копия исходного номера до вставки наших предложений

    for (const rt of rts) {
        const pricing = rt.pricing || (rt.rule ? { mode: 'rule', rule: rt.rule } : null);
        if (!pricing) { skip(ctx, rt, `no_pricing (mode ${rt.pricingMode || '?'}: fixed_price или правило не заданы)`); continue; }
        if (settings.hotelOnly && ctx.searchType && ctx.searchType !== 'hotel') { skip(ctx, rt, `search_type (${ctx.searchType}; настройка hotelOnly=true)`); continue; }
        if (Array.isArray(rt.packageTypes) && rt.packageTypes.length && ctx.searchType && !rt.packageTypes.includes(ctx.searchType)) { skip(ctx, rt, `search_type (${ctx.searchType}; packageTypes [${rt.packageTypes.join(',')}])`); continue; }
        const found = findSourceIndex(result, byRoomId, rt);
        if (!found) { skip(ctx, rt, `source_room_missing (source ${rt.sourceRoomId}; ids in result: ${idsInResult.slice(0, 40).join(',')}${idsInResult.length > 40 ? ',…' : ''})`); continue; }
        const idx = found.idx;
        const sourceRoom = result[idx];
        // связь по номеру — шаблоны берём из любых предложений LT источника (оператор LT не важен)
        const picked = pickTemplateOffers(sourceRoom, rt);
        if (!picked.length) {
            const meals = Object.keys(sourceRoom.offers && typeof sourceRoom.offers === 'object' ? sourceRoom.offers : {});
            skip(ctx, rt, meals.length ? `no_offers (у источника питание ${meals.join(',')}, требуется ${(rt.mealTypes || []).join(',') || 'любое'})` : 'no_offers (у источника нет предложений)');
            continue;
        }

        let n = 0;
        let bestProvider = null;
        let bestFinal = null;
        let bestOperator = null;
        let anyClamped = false;
        const byMeal = {};
        const snap = Object.assign(pricingSnapshot(pricing), { label: pricingLabel(pricing) });
        for (const { meal, offer } of picked) {
            const priced = computePrice(offer.price, nightsOf(offer), pricing);
            if (priced.final === null) continue;
            n += 1;
            const v = makeVirtualOffer(offer, rt, meal, n, priced);
            (byMeal[meal] = byMeal[meal] || []).push(v);
            // providerPrice = цена шаблона LT (для маржи), operatorId = оператор шаблона (у кого реально куплено)
            mapEntries.push({ virtualOfferId: v.id, roomTypeId: rt.id, requestId: ctx.requestId, sourceOfferId: offer.id, operatorId: offer.operator_id === undefined ? null : Number(offer.operator_id), meal, providerPrice: Number(offer.price), finalPrice: priced.final });
            priceLogs.push({ roomTypeId: rt.id, requestId: ctx.requestId, sourceOfferId: offer.id, operatorId: offer.operator_id === undefined ? null : Number(offer.operator_id), operatorName: offer.operator_name, meal, providerPrice: Number(offer.price), finalPrice: priced.final, rule: snap, marginClamped: priced.marginClamped });
            if (priced.marginClamped) anyClamped = true;
            if (bestFinal === null || priced.final < bestFinal) { bestFinal = priced.final; bestProvider = Number(offer.price); bestOperator = offer.operator_name || null; }
        }
        if (!n) { skip(ctx, rt, 'no_priced_offers (у шаблонов нет цены > 0)'); continue; }
        diag.log(`hotel ${ctx.hotelId}: rt ${rt.id} — injected (${n} offer(s), ${pricing.mode}, source room ${sourceRoom.room && sourceRoom.room.id})`);

        // v3: наши предложения — внутрь исходного номера, в начало offers[meal]; предложения LT не трогаем.
        // Номер мутируется в теле ответа — перед первой правкой сохраняем копию для отката при сбое карты предложений.
        if (!backups.has(idx)) backups.set(idx, JSON.parse(JSON.stringify(sourceRoom)));
        for (const [meal, ours] of Object.entries(byMeal)) prependOffers(sourceRoom, meal, ours);
        const prevTotus = sourceRoom.lt_extras && typeof sourceRoom.lt_extras === 'object' && sourceRoom.lt_extras.totus && typeof sourceRoom.lt_extras.totus === 'object' ? sourceRoom.lt_extras.totus : null;
        sourceRoom.lt_extras = Object.assign({}, sourceRoom.lt_extras && typeof sourceRoom.lt_extras === 'object' ? sourceRoom.lt_extras : {}, {
            totus: {
                roomTypeId: prevTotus && prevTotus.roomTypeId ? prevTotus.roomTypeId : rt.id,
                customOffers: (prevTotus && Number(prevTotus.customOffers)) > 0 ? Number(prevTotus.customOffers) + n : n,
                sourceRoomId: Number(rt.sourceRoomId),
            },
        });
        recomputeRoomMins(sourceRoom);
        injected.push({ idx, rt, n });
        touched.add(rt.id);
        store.touchLastSeen(rt.id, { providerPrice: bestProvider, finalPrice: bestFinal, operator: bestOperator, marginClamped: anyClamped }).catch(() => {});
    }

    // exclusive: планируем до записи карты предложений, чтобы понять, нужно ли вообще менять ответ
    const exPlan = store.exclusiveFromRoomTypes(rts);
    const hasExclusive = exPlan.wholeHotel || exPlan.rooms.size > 0;
    if (!injected.length && !hasExclusive) return data;

    if (mapEntries.length) {
        try {
            await store.saveOfferMap(mapEntries);
        } catch (e) {
            // без карты предложений бронирование невозможно — откатываем номера к оригиналу LT (middleware отдаст исходное тело),
            // причину сохраняем для диагностики
            for (const [idx, copy] of backups) result[idx] = copy;
            for (const id of touched) store.markChecked(id, `offer_map_failed (${String(e.message).slice(0, 120)})`).catch(() => {});
            throw e;
        }
    }

    // exclusive («продавать только наши предложения») — после вставки наших и записи карты
    let ex = { applied: false, scope: null, hidden: 0, dropped: 0 };
    if (hasExclusive) {
        ex = applyExclusive(result, rts);
        if (ex.applied) diag.log(`hotel ${ctx.hotelId}: exclusive ${ex.scope} — LT offers hidden: ${ex.hidden} (rooms dropped: ${ex.dropped})`);
    }
    if (!injected.length && !ex.applied) return data;

    const next = { ...data, result };
    // фильтры по питанию и минимум отеля: если наше предложение самое дешёвое — «от N ₽» = наша цена
    const mins = {};
    let hotelMin = null;
    for (const r of result) for (const [meal, list] of Object.entries((r && r.offers) || {})) for (const o of list || []) {
        const p = Number(o && o.price);
        if (!Number.isFinite(p)) continue;
        if (mins[meal] === undefined || p < mins[meal]) mins[meal] = p;
        if (hotelMin === null || p < hotelMin) hotelMin = p;
    }
    if (next.filters && Array.isArray(next.filters.meals)) {
        // exclusive: питание, от которого не осталось предложений, убираем из фильтров целиком
        const meals = ex.applied ? next.filters.meals.filter((m) => m && mins[m.id] !== undefined) : next.filters.meals;
        next.filters = { ...next.filters, meals: meals.map((m) => (m && mins[m.id] !== undefined ? { ...m, min_price: mins[m.id] } : m)) };
    }
    // exclusive: после скрытия предложений LT минимум может только вырасти — ставим точное значение, иначе (как раньше) только понижаем
    if (hotelMin !== null && next.min_price !== undefined && next.min_price !== null && Number.isFinite(Number(next.min_price))) next.min_price = ex.applied ? hotelMin : Math.min(Number(next.min_price), hotelMin);
    if (hotelMin !== null && next.hotel && typeof next.hotel === 'object' && Number.isFinite(Number(next.hotel.min_price))) next.hotel = { ...next.hotel, min_price: ex.applied ? hotelMin : Math.min(Number(next.hotel.min_price), hotelMin) };

    for (const e of priceLogs) await store.logPrice(e);
    if (injected.length) {
        diag.bump('hotelsRoomsInjected', { lastInjectAt: new Date().toISOString() });
        diag.log(`hotel ${ctx.hotelId}: injected ${injected.length} room type(s), ${mapEntries.length} offer(s) into ${new Set(injected.map((x) => x.idx)).size} room(s)`);
    }
    return next;
}

module.exports = { injectRooms, applyExclusive, isVirtualOfferId, isArlekinoOffer, pickSourceOffers, pickTemplateOffers, makeVirtualOffer, prependOffers, recomputeRoomMins, operatorIdOf, operatorNameOf, findSourceIndex, VIRTUAL_ROOM_PREFIX, OFFER_SOURCE };
