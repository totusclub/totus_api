'use strict';

/**
 * Витрина v2: наша комната рядом с выбранным номером LT в ответе /search/hotel_rooms
 * (прокси GET /hotels-rooms). Бриф BRIEF_ROOM_LINK_V2 §2. Frontend получает тот же формат HotelRoom:
 *   { ID, min_price, meal_types[], room {...}, offers { [meal]: Offer[] }, lt_extras, labels? }
 *
 * Для каждой активной Room Type отеля:
 *   - ищем исходный номер (room.id === sourceRoomId) — при ЛЮБЫХ параметрах поиска (дата, ночи, гости);
 *     связь только по номеру, наличие предложения конкретного оператора не требуется;
 *   - шаблоны: если meal_types заданы — самое дешёвое предложение источника на каждое питание,
 *     иначе — одно самое дешёвое предложение источника;
 *   - вставляем нашу комнату рядом: клоны шаблонов с нашей ценой (fixed | rule), id = "t<rt>-<n>-<hash>",
 *     operator_id/operator_name = наши («Arlekino»);
 *   - исходный номер и его операторы остаются; только при заданных operator_ids их предложения удаляются (замещение v1);
 *   - пересчитываем min_price, meal_types[].min_price, filters.meals[].min_price.
 * Всё остальное — как отдал LT. Нет источника в выдаче (или у него нет offers) — нашей комнаты нет.
 */

const store = require('./store');
const { computePrice, pricingSnapshot, pricingLabel } = require('./pricing');

const VIRTUAL_ROOM_PREFIX = 'totus-';
const VIRTUAL_OFFER_RE = /^t(\d+)-(\d+)-([a-z0-9]+)$/i;

function isVirtualOfferId(id) { return VIRTUAL_OFFER_RE.test(String(id || '')); }

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
 * v2: предложения-шаблоны исходного номера: [{meal, offer}].
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

/** v1 (совместимость/замещение): предложения источника выбранных операторов (и питания, если ограничено): [{meal, offer}] */
function pickSourceOffers(sourceRoom, rt) {
    const ops = new Set((rt.operatorIds || []).map(Number));
    const meals = rt.mealTypes && rt.mealTypes.length ? new Set(rt.mealTypes.map(String)) : null;
    const out = [];
    const offers = sourceRoom.offers && typeof sourceRoom.offers === 'object' ? sourceRoom.offers : {};
    for (const [meal, list] of Object.entries(offers)) {
        if (!Array.isArray(list)) continue;
        if (meals && !meals.has(String(meal))) continue;
        for (const o of list) {
            if (!o || typeof o !== 'object') continue;
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

/** Клон предложения-шаблона с нашей ценой и нашим оператором («Arlekino»). */
function makeVirtualOffer(o, rt, meal, idx, priced) {
    const nights = nightsOf(o);
    const clone = JSON.parse(JSON.stringify(o));
    clone.id = `t${rt.id}-${idx}-${hash(o.id)}`;
    clone.price = priced.final;
    clone.operator_id = operatorIdOf(rt);
    clone.operator_name = operatorNameOf(rt);
    if ('analytics_price' in clone) clone.analytics_price = priced.final;
    if (nights) clone.price_per_night = Math.round(priced.final / nights);
    if (clone.extras && typeof clone.extras === 'object') {
        // спец-метки LT про цену (cheap/best_price) относятся к цене провайдера — снимаем
        if ('cheap' in clone.extras) clone.extras.cheap = false;
        if ('best_price' in clone.extras) clone.extras.best_price = false;
    }
    const mode = priced.mode || (rt.pricing && rt.pricing.mode) || rt.pricingMode || 'rule';
    clone.lt_extras = Object.assign({}, clone.lt_extras || {}, { totus: { custom: true, roomTypeId: rt.id, sourceOfferId: String(o.id), meal, mode } });
    return clone;
}

/** Замещение (только при заданных operator_ids): удалить из источника предложения этих операторов. */
function removeReplacedOffers(sourceRoom, rt) {
    if (!Array.isArray(rt.operatorIds) || !rt.operatorIds.length) return 0;
    let removed = 0;
    for (const { meal, offer } of pickSourceOffers(sourceRoom, rt)) {
        const list = sourceRoom.offers[meal];
        const at = Array.isArray(list) ? list.indexOf(offer) : -1;
        if (at >= 0) { list.splice(at, 1); removed += 1; }
        if (Array.isArray(list) && !list.length) delete sourceRoom.offers[meal];
    }
    return removed;
}

function buildVirtualRoom(sourceRoom, rt, badge) {
    const c = rt.content || {};
    const room = JSON.parse(JSON.stringify(sourceRoom.room || {}));
    room.id = Number(`${rt.id}`) + 10000000; // числовой id, не пересекается с LT
    room.name_ru = c.nameRu || room.name_ru;
    room.name_en = c.nameEn || room.name_en;
    if (c.accommodation) room.accommodation = c.accommodation;
    if (c.area !== null && c.area !== undefined) room.area = c.area;
    if (c.view) room.view = c.view;
    if (c.description) room.description = c.description;
    if (Array.isArray(c.facilities) && c.facilities.length) {
        room.facilities = c.facilities.map((f, i) => (typeof f === 'string' ? { id: 900000 + i, name: f, group_identifier: null } : f));
    }
    if (Array.isArray(c.images) && c.images.length) {
        room.images = c.images.map((im) => {
            if (typeof im === 'string') return { x900: im, x900x380: im };
            if (im && im.url) return { x900: im.url, x900x380: im.url, ...(im.sizes || {}) };
            return im;
        });
    }
    return {
        ID: `${VIRTUAL_ROOM_PREFIX}${rt.id}`,
        min_price: null,
        bonus_count: sourceRoom.bonus_count,
        cashback_identifier: sourceRoom.cashback_identifier === undefined ? null : sourceRoom.cashback_identifier,
        meal_types: [],
        room,
        offers: {},
        lt_extras: Object.assign({}, sourceRoom.lt_extras || {}, { totus: { custom: true, roomTypeId: rt.id, sourceRoomId: rt.sourceRoomId, badge } }),
        labels: Array.isArray(sourceRoom.labels) ? sourceRoom.labels.slice() : [],
    };
}

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
        // типы питания без оставшихся предложений убираем, остальным — актуальный минимум
        room.meal_types = room.meal_types.filter((mt) => mt && mealMins[mt.id] !== undefined);
        for (const mt of room.meal_types) mt.min_price = mealMins[mt.id];
    }
    return mealMins;
}

/**
 * Основная функция. data — тело ответа LT. ctx: { requestId, hotelId, searchType }.
 * Возвращает новое тело (или исходное, если нечего менять).
 */
async function injectRooms(data, ctx) {
    if (!data || typeof data !== 'object' || !Array.isArray(data.result) || !data.result.length) return data;
    const settings = await store.getSettings();
    const rts = await store.activeRoomTypesForHotel(ctx.hotelId);
    if (!rts.length) return data;

    const result = data.result;
    const byRoomId = new Map();
    result.forEach((r, i) => { if (r && r.room && r.room.id !== undefined) byRoomId.set(Number(r.room.id), i); });

    const inserts = [];   // { afterIndex, room }
    const mapEntries = [];
    const priceLogs = [];
    const touched = new Set();

    for (const rt of rts) {
        if (settings.hotelOnly && ctx.searchType && ctx.searchType !== 'hotel') continue;
        if (Array.isArray(rt.packageTypes) && rt.packageTypes.length && ctx.searchType && !rt.packageTypes.includes(ctx.searchType)) continue;
        const idx = byRoomId.get(Number(rt.sourceRoomId));
        const pricing = rt.pricing || (rt.rule ? { mode: 'rule', rule: rt.rule } : null);
        if (idx === undefined || !pricing) continue;
        const sourceRoom = result[idx];
        // v2: связь по номеру — шаблоны берём из любых предложений источника (оператор LT не важен)
        const picked = pickTemplateOffers(sourceRoom, rt);
        if (!picked.length) continue;

        const vroom = buildVirtualRoom(sourceRoom, rt, rt.badge || settings.badge);
        let n = 0;
        let bestProvider = null;
        let bestFinal = null;
        let bestOperator = null;
        let anyClamped = false;
        const snap = Object.assign(pricingSnapshot(pricing), { label: pricingLabel(pricing) });
        for (const { meal, offer } of picked) {
            const priced = computePrice(offer.price, nightsOf(offer), pricing);
            if (priced.final === null) continue;
            n += 1;
            const v = makeVirtualOffer(offer, rt, meal, n, priced);
            if (!vroom.offers[meal]) vroom.offers[meal] = [];
            vroom.offers[meal].push(v);
            // providerPrice = цена шаблона LT (для маржи), operatorId = оператор шаблона (у кого реально куплено)
            mapEntries.push({ virtualOfferId: v.id, roomTypeId: rt.id, requestId: ctx.requestId, sourceOfferId: offer.id, operatorId: offer.operator_id === undefined ? null : Number(offer.operator_id), meal, providerPrice: Number(offer.price), finalPrice: priced.final });
            priceLogs.push({ roomTypeId: rt.id, requestId: ctx.requestId, sourceOfferId: offer.id, operatorId: offer.operator_id === undefined ? null : Number(offer.operator_id), operatorName: offer.operator_name, meal, providerPrice: Number(offer.price), finalPrice: priced.final, rule: snap, marginClamped: priced.marginClamped });
            if (priced.marginClamped) anyClamped = true;
            if (bestFinal === null || priced.final < bestFinal) { bestFinal = priced.final; bestProvider = Number(offer.price); bestOperator = offer.operator_name || null; }
        }
        if (!n) continue;
        // замещение только при заданных operator_ids (чтобы «Arlekino» не дублировался); иначе источник не трогаем
        removeReplacedOffers(sourceRoom, rt);
        // meal_types нашей комнаты — только те, что есть
        const srcMeals = Array.isArray(sourceRoom.meal_types) ? sourceRoom.meal_types : [];
        vroom.meal_types = Object.keys(vroom.offers).map((meal) => {
            const src = srcMeals.find((m) => m && String(m.id) === String(meal));
            return src ? JSON.parse(JSON.stringify(src)) : { id: meal, min_price: null, description: meal };
        });
        recomputeRoomMins(vroom);
        recomputeRoomMins(sourceRoom);
        inserts.push({ afterIndex: idx, room: vroom, sort: rt.sortOrder });
        touched.add(rt.id);
        store.touchLastSeen(rt.id, { providerPrice: bestProvider, finalPrice: bestFinal, operator: bestOperator, marginClamped: anyClamped }).catch(() => {});
    }

    if (!inserts.length) return data;

    // Собираем result: источник без оставшихся предложений исчезает, наши комнаты — сразу после источника
    const sourceIdx = new Set(inserts.map((x) => x.afterIndex));
    const out = [];
    result.forEach((r, i) => {
        const hasOffers = Boolean(r && r.offers && Object.values(r.offers).some((l) => Array.isArray(l) && l.length));
        if (hasOffers || !sourceIdx.has(i)) out.push(r);
        inserts.filter((x) => x.afterIndex === i).sort((a, b) => a.sort - b.sort).forEach((x) => out.push(x.room));
    });

    const next = { ...data, result: out };
    // фильтры по питанию и минимум отеля: если наше предложение самое дешёвое — «от N ₽» = наша цена
    const mins = {};
    let hotelMin = null;
    for (const r of out) for (const [meal, list] of Object.entries(r.offers || {})) for (const o of list || []) {
        const p = Number(o && o.price);
        if (!Number.isFinite(p)) continue;
        if (mins[meal] === undefined || p < mins[meal]) mins[meal] = p;
        if (hotelMin === null || p < hotelMin) hotelMin = p;
    }
    if (next.filters && Array.isArray(next.filters.meals)) {
        next.filters = { ...next.filters, meals: next.filters.meals.map((m) => (m && mins[m.id] !== undefined ? { ...m, min_price: mins[m.id] } : m)) };
    }
    if (hotelMin !== null && next.min_price !== undefined && next.min_price !== null && Number.isFinite(Number(next.min_price))) next.min_price = Math.min(Number(next.min_price), hotelMin);
    if (hotelMin !== null && next.hotel && typeof next.hotel === 'object' && Number.isFinite(Number(next.hotel.min_price))) next.hotel = { ...next.hotel, min_price: Math.min(Number(next.hotel.min_price), hotelMin) };

    await store.saveOfferMap(mapEntries);
    for (const e of priceLogs) await store.logPrice(e);
    console.log(`[custom-rooms] hotel ${ctx.hotelId}: injected ${inserts.length} room type(s), ${mapEntries.length} offer(s)`);
    return next;
}

module.exports = { injectRooms, isVirtualOfferId, pickSourceOffers, pickTemplateOffers, removeReplacedOffers, buildVirtualRoom, makeVirtualOffer, recomputeRoomMins, operatorIdOf, operatorNameOf, VIRTUAL_ROOM_PREFIX };
