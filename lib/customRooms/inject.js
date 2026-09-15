'use strict';

/**
 * Витрина: подмена предложений источника нашими Room Type в ответе LT /search/hotel_rooms
 * (прокси GET /hotels-rooms). План §6. Frontend получает тот же формат HotelRoom:
 *   { ID, min_price, meal_types[], room {...}, offers { [meal]: Offer[] }, lt_extras, labels? }
 *
 * Для каждой активной Room Type отеля:
 *   - ищем исходный номер (room.id === sourceRoomId);
 *   - из его offers забираем предложения выбранных операторов (и типов питания, если ограничены);
 *   - удаляем их из исходного номера (номер без предложений исчезает);
 *   - вставляем нашу комнату рядом: клоны предложений с нашей ценой, id = "t<rt>-<n>", оператор сохранён;
 *   - пересчитываем min_price, meal_types[].min_price, filters.meals[].min_price.
 * Всё остальное — как отдал LT. Нет источника в выдаче — нашей комнаты нет.
 */

const store = require('./store');
const { finalPrice, ruleLabel } = require('./pricing');

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

/** Собрать список предложений источника, которые замещает Room Type: [{meal, offer}] */
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

/** Клон предложения с нашей ценой. */
function makeVirtualOffer(o, rt, meal, idx, priced) {
    const nights = nightsOf(o);
    const clone = JSON.parse(JSON.stringify(o));
    clone.id = `t${rt.id}-${idx}-${hash(o.id)}`;
    clone.price = priced.final;
    if ('analytics_price' in clone) clone.analytics_price = priced.final;
    if (nights && ('price_per_night' in clone)) clone.price_per_night = Math.round(priced.final / nights);
    if (clone.extras && typeof clone.extras === 'object') {
        // спец-метки LT про цену (cheap/best_price) относятся к цене провайдера — снимаем
        if ('cheap' in clone.extras) clone.extras.cheap = false;
        if ('best_price' in clone.extras) clone.extras.best_price = false;
    }
    clone.lt_extras = Object.assign({}, clone.lt_extras || {}, { totus: { custom: true, roomTypeId: rt.id, sourceOfferId: String(o.id), meal } });
    return clone;
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
        if (Array.isArray(rt.packageTypes) && rt.packageTypes.length && !rt.packageTypes.includes(ctx.searchType || 'hotel')) continue;
        const idx = byRoomId.get(Number(rt.sourceRoomId));
        if (idx === undefined || !rt.rule) continue;
        const sourceRoom = result[idx];
        const picked = pickSourceOffers(sourceRoom, rt);
        if (!picked.length) continue;

        const vroom = buildVirtualRoom(sourceRoom, rt, rt.badge || settings.badge);
        let n = 0;
        let bestProvider = null;
        let bestFinal = null;
        let bestOperator = null;
        let anyClamped = false;
        for (const { meal, offer } of picked) {
            const priced = finalPrice(offer.price, rt.rule);
            if (priced.final === null) continue;
            n += 1;
            const v = makeVirtualOffer(offer, rt, meal, n, priced);
            if (!vroom.offers[meal]) vroom.offers[meal] = [];
            vroom.offers[meal].push(v);
            mapEntries.push({ virtualOfferId: v.id, roomTypeId: rt.id, requestId: ctx.requestId, sourceOfferId: offer.id, operatorId: offer.operator_id === undefined ? null : Number(offer.operator_id), meal, providerPrice: Number(offer.price), finalPrice: priced.final });
            priceLogs.push({ roomTypeId: rt.id, requestId: ctx.requestId, sourceOfferId: offer.id, operatorId: offer.operator_id === undefined ? null : Number(offer.operator_id), operatorName: offer.operator_name, meal, providerPrice: Number(offer.price), finalPrice: priced.final, rule: { type: rt.rule.ruleType, value: rt.rule.ruleValue, label: ruleLabel(rt.rule) }, marginClamped: priced.marginClamped });
            if (priced.marginClamped) anyClamped = true;
            if (bestFinal === null || priced.final < bestFinal) { bestFinal = priced.final; bestProvider = Number(offer.price); bestOperator = offer.operator_name || null; }
            // удаляем исходное предложение
            const list = sourceRoom.offers[meal];
            const at = list.indexOf(offer);
            if (at >= 0) list.splice(at, 1);
            if (!list.length) delete sourceRoom.offers[meal];
        }
        if (!n) continue;
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
    // фильтры по питанию: минимальные цены
    if (next.filters && Array.isArray(next.filters.meals)) {
        const mins = {};
        for (const r of out) for (const [meal, list] of Object.entries(r.offers || {})) for (const o of list || []) {
            const p = Number(o && o.price);
            if (Number.isFinite(p) && (mins[meal] === undefined || p < mins[meal])) mins[meal] = p;
        }
        next.filters = { ...next.filters, meals: next.filters.meals.map((m) => (m && mins[m.id] !== undefined ? { ...m, min_price: mins[m.id] } : m)) };
    }

    await store.saveOfferMap(mapEntries);
    for (const e of priceLogs) await store.logPrice(e);
    console.log(`[custom-rooms] hotel ${ctx.hotelId}: injected ${inserts.length} room type(s), ${mapEntries.length} offer(s)`);
    return next;
}

module.exports = { injectRooms, isVirtualOfferId, pickSourceOffers, buildVirtualRoom, makeVirtualOffer, recomputeRoomMins, VIRTUAL_ROOM_PREFIX };
