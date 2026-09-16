'use strict';

/**
 * Цепочка бронирования для наших Room Type (план §6):
 *   package_details?tour_id=<наш id> → подмена на tour_id шаблона, цены в ответе → наши, package.id → карта
 *   actualize → по карте: свежая цена LT → при rule пересчёт, при fixed цена НЕ пересчитывается (v2) → цены в ответе, снимок пакета в карту
 *   orders/prebuild / packages/prebook / packages/flights → для пакета из карты LT НЕ вызывается:
 *     synthesizePackageStep (снимок + totus_booking) — отвечает middleware
 *   create-package → для пакета из карты LT НЕ вызывается: заказ у нас (internalOrders.js, bookings.js);
 *     beforeCreatePackage/afterCreatePackage остаются на случай прямого прокси (не используются в middleware)
 *   /orders, /user/orders, /client/orders* → цены помеченных заказов → наши, + totus_booking ТОЛЬКО у внутренних
 *     (v3: GET /orders?order_id=<внутренний> middleware отвечает сам из БД — internalOrders.orderSnapshot, без LT)
 *   Чистый LT-путь: для не-виртуального tour_id beforePackageDetails → null, для чужого package_id/order_id → null —
 *   ответы LT не трогаются, auth_token/order_id LT и наши booking data не смешиваются.
 *   /vtb/create-order, /orders/:id/payment → сумма платежа = Final Price
 *
 * Поля цены LT известны по коду клиентов: package.price (package_details/actualize/prebook), order.package.price,
 * order.full_price, order.remaining_amount (prebuild/create). Остальные числовые поля с «ценовыми» именами и
 * значением, равным цене провайдера, тоже переписываются (точный список — проверить на проде, см. docs).
 */

const db = require('../../db');
const store = require('./store');
const { normalizeRule, normalizePricing, computePrice, pricingSnapshot } = require('./pricing');
const { isVirtualOfferId } = require('./inject');

const PRICE_KEYS = new Set(['price', 'full_price', 'total_price', 'remaining_amount', 'amount', 'analytics_price', 'price_rub', 'total', 'sum', 'cost', 'net_price', 'client_price', 'pay_amount', 'to_pay']);
const MAX_DEPTH = 8;

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

/** Express 5: req.query — getter от req.url, поэтому параметр меняем в самом URL. */
function setQueryParam(req, name, value) {
    try {
        const u = new URL(req.url, 'http://local');
        u.searchParams.set(name, String(value));
        req.url = u.pathname + u.search;
    } catch (e) { /* ignore */ }
    try { if (req.query && typeof req.query === 'object') req.query[name] = String(value); } catch (e) { /* getter-only */ }
}
function near(a, b) { return a !== null && b !== null && Math.abs(a - b) < 1; }

/** Заменить в объекте все «ценовые» числа, равные provider, на final (рекурсивно, копия). */
function rewritePrices(obj, provider, final, depth = 0) {
    if (obj === null || typeof obj !== 'object' || depth > MAX_DEPTH) return obj;
    if (Array.isArray(obj)) return obj.map((x) => rewritePrices(x, provider, final, depth + 1));
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
        if (PRICE_KEYS.has(k) && (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))))) {
            const n = Number(v);
            out[k] = near(n, provider) ? (typeof v === 'string' ? String(final) : final) : v;
        } else if (v && typeof v === 'object') {
            out[k] = rewritePrices(v, provider, final, depth + 1);
        } else out[k] = v;
    }
    return out;
}

/** Актуальная цена провайдера из ответа пакета (package.price | order.package.price | package_price). */
function extractProviderPrice(data) {
    if (!data || typeof data !== 'object') return null;
    const cands = [
        data.package && data.package.price,
        data.order && data.order.package && data.order.package.price,
        data.package_price,
        data.price,
    ];
    for (const c of cands) { const n = num(c); if (n !== null && n > 0) return n; }
    return null;
}

function extractPackageId(data) {
    if (!data || typeof data !== 'object') return null;
    const cands = [data.package && data.package.id, data.package_id, data.order && data.order.package && data.order.package.id, data.id];
    for (const c of cands) if (c !== undefined && c !== null && c !== '') return String(c);
    return null;
}

/** Режим цены из снимка карты/заказа: { mode:'fixed', fixedPrice, unit } | { mode:'rule'|undefined, type, value, … } → pricing или null. */
async function pricingFromSnapshot(fallback) {
    const f = fallback || {};
    if (f.mode === 'fixed') {
        const p = normalizePricing({ mode: 'fixed', fixedPrice: f.fixedPrice, fixedPriceUnit: f.unit || f.fixedPriceUnit });
        return p.error ? null : p;
    }
    const r = normalizeRule({ ruleType: f.type, ruleValue: f.value, rounding: f.rounding, minPrice: f.minPrice, maxPrice: f.maxPrice, minMarginType: f.minMarginType, minMarginValue: f.minMarginValue }, await store.getSettings());
    return r.error ? null : { mode: 'rule', fixedPrice: null, fixedPriceUnit: 'total', rule: r };
}

/** Актуальный режим цены Room Type; комната выключена/удалена после выбора → из снимка (цена для клиента не должна прыгать). */
async function currentPricing(roomTypeId, fallback) {
    const rt = await store.getRoomType(roomTypeId);
    if (rt && rt.active && rt.pricing) return rt.pricing;
    return pricingFromSnapshot(fallback);
}

/** Количество ночей из ответа пакета (для fixed per_night). */
function extractNights(data) {
    if (!data || typeof data !== 'object') return null;
    const pkg = data.package && typeof data.package === 'object' ? data.package : data;
    const di = pkg.dates_info && typeof pkg.dates_info === 'object' ? pkg.dates_info : {};
    for (const c of [pkg.nights_count, di.nights_count, di.hotel_nights, pkg.nights, di.nights, pkg.hotel_nights]) { const n = num(c); if (n !== null && n > 0) return n; }
    return null;
}

/**
 * Наша цена для пакета: rule — от свежей цены LT; fixed — фиксированная (per_night × ночи пакета,
 * если ночей в ответе нет — прежняя итоговая цена из карты, чтобы не прыгать).
 */
function priceForPackage(pricing, provider, data, prevFinal) {
    if (!pricing) return null;
    if (pricing.mode === 'fixed' && pricing.fixedPriceUnit === 'per_night' && extractNights(data) === null && num(prevFinal) !== null) return num(prevFinal);
    return computePrice(provider, extractNights(data), pricing).final;
}

// ---------------------------------------------------------------------------
// package_details
// ---------------------------------------------------------------------------
/** До прокси: подменить tour_id. Возвращает контекст (offer) или null. */
async function beforePackageDetails(req) {
    const tourId = req.query && req.query.tour_id;
    if (!tourId || !isVirtualOfferId(tourId)) return null;
    const offer = await store.getOffer(String(tourId));
    if (!offer) { req.customRoomsError = 'offer_expired'; return null; }
    setQueryParam(req, 'tour_id', offer.sourceOfferId);
    return offer;
}

/** После прокси: цены → наши, package.id → карта. */
async function afterPackageDetails(data, offer) {
    const rt = await store.getRoomType(offer.roomTypeId);
    const pricing = rt && rt.pricing ? rt.pricing : null;
    if (!pricing) return data;
    const provider = extractProviderPrice(data) || offer.providerPrice;
    const final = priceForPackage(pricing, provider, data, offer.finalPrice);
    if (final === null) return data;
    const pkgId = extractPackageId(data);
    const out = rewritePrices(data, provider, final);
    out.totus_room = { roomTypeId: rt.id, providerPrice: provider, finalPrice: final, mode: pricing.mode };
    if (pkgId) {
        const hotelId = (data.package && data.package.hotel && data.package.hotel.id) || rt.hotelId || null;
        // v2: оператор нашего предложения — из Room Type («Arlekino»)
        const operatorName = rt.operatorName || 'Arlekino';
        await store.savePackageMap({ ltPackageId: pkgId, roomTypeId: rt.id, virtualOfferId: offer.virtualOfferId, sourceOfferId: offer.sourceOfferId, operatorName, providerPrice: provider, finalPrice: final, rule: pricingSnapshot(pricing), hotelId, meal: offer.meal || null, snapshot: out });
    }
    return out;
}

// ---------------------------------------------------------------------------
// actualize / prebuild / prebook — по package_id
// ---------------------------------------------------------------------------
function packageIdFromReq(req) {
    const q = req.query || {};
    const b = req.body || {};
    const c = q.package_id || b.package_id || (b.package && b.package.id) || (b.order && b.order.package_id);
    return c === undefined || c === null || c === '' ? null : String(c);
}

async function beforePackageStep(req) {
    const pkgId = packageIdFromReq(req);
    if (!pkgId) return null;
    return store.getPackage(pkgId);
}

async function afterPackageStep(data, map) {
    const pricing = await currentPricing(map.roomTypeId, map.rule);
    if (!pricing) return data;
    const provider = extractProviderPrice(data) || map.providerPrice;
    // fixed: итоговая цена не зависит от свежей цены LT; меняется только если владелец поменял её в админке
    const final = priceForPackage(pricing, provider, data, map.finalPrice);
    if (final === null) return data;
    if (provider !== map.providerPrice || final !== map.finalPrice) {
        await store.updatePackagePrices(map.ltPackageId, provider, final);
        if (provider !== map.providerPrice) console.log(`[custom-rooms] package ${map.ltPackageId}: provider price ${map.providerPrice} → ${provider}, final ${final} (${pricing.mode})`);
    }
    const priceChanged = pricing.mode === 'fixed' ? final !== map.finalPrice : provider !== map.providerPrice;
    const out = rewritePrices(data, provider, final);
    out.totus_room = { roomTypeId: map.roomTypeId, providerPrice: provider, finalPrice: final, mode: pricing.mode, priceChanged: priceChanged ? { from: map.finalPrice, to: final } : null };
    // actualize — свежий состав пакета с нашими ценами → снимок (из него собирается заказ без LT)
    if (out && out.package && typeof out.package === 'object') {
        try { await store.savePackageSnapshot(map.ltPackageId, out); } catch (e) { console.warn('[custom-rooms] snapshot save failed:', e.message); }
    }
    return out;
}

/**
 * Бронирование без Level.Travel: ответ на prebuild / prebook / flights для пакета из карты — сами,
 * в формате package_details (снимок), + totus_room + totus_booking { internal, operator }.
 * Нет снимка (карта создана до миграции или пакет протух) → null → 410 offer_expired.
 */
function synthesizePackageStep(map) {
    if (!map || !map.snapshot || typeof map.snapshot !== 'object') return null;
    const snap = map.snapshot;
    const out = Object.assign({}, snap, { success: true });
    out.totus_room = Object.assign({}, snap.totus_room || {}, { roomTypeId: map.roomTypeId, providerPrice: map.providerPrice, finalPrice: map.finalPrice, priceChanged: null });
    out.totus_booking = { internal: true, operator: map.operatorName || null };
    return out;
}

// ---------------------------------------------------------------------------
// create-package
// ---------------------------------------------------------------------------
/** До прокси: сумма платежа принудительно = Final Price (по актуальной карте пакета). */
async function beforeCreatePackage(req) {
    const map = await beforePackageStep(req);
    if (!map) return null;
    // app.js: paymentAmount = payload.amount || payload.payment.amount || цена заказа LT — задаём оба
    const body = req.body || {};
    body.amount = map.finalPrice;
    body.payment = Object.assign({}, body.payment || {}, { amount: map.finalPrice });
    req.body = body;
    return map;
}

/** После прокси: пометить заказ, переписать цены в package JSON и в ответе. */
async function afterCreatePackage(data, map) {
    const orderId = data && data.order && data.order.id;
    if (!orderId) return data;
    const pricing = await currentPricing(map.roomTypeId, map.rule);
    try {
        await store.markOrder(orderId, { roomTypeId: map.roomTypeId, providerPrice: map.providerPrice, finalPrice: map.finalPrice, rule: Object.assign({}, pricing ? pricingSnapshot(pricing) : (map.rule || {}), { operator: map.operatorName || null }) });
        const [rows] = await db.query('SELECT package FROM orders WHERE order_id = ? LIMIT 1', [String(orderId)]);
        if (rows.length && rows[0].package) {
            const pkg = store.parseJson(rows[0].package);
            if (pkg) {
                const rewritten = rewritePrices(pkg, map.providerPrice, map.finalPrice);
                rewritten._totus_room = { roomTypeId: map.roomTypeId, providerPrice: map.providerPrice, finalPrice: map.finalPrice, operator: map.operatorName || null };
                await db.query('UPDATE orders SET package = ? WHERE order_id = ?', [JSON.stringify(rewritten), String(orderId)]);
            }
        }
        console.log(`[custom-rooms] order ${orderId}: room type ${map.roomTypeId}, provider ${map.providerPrice}, final ${map.finalPrice}`);
    } catch (e) {
        console.error('[custom-rooms] afterCreatePackage failed:', e.message);
    }
    return rewritePrices(data, map.providerPrice, map.finalPrice);
}

// ---------------------------------------------------------------------------
// Платежи и просмотр заказов
// ---------------------------------------------------------------------------
function orderIdFromReq(req) {
    const q = req.query || {};
    const b = req.body || {};
    const p = req.params || {};
    const c = p.order_id || q.order_id || b.orderId || b.order_id;
    return c === undefined || c === null || c === '' ? null : String(c).replace(/^ORDER/i, '');
}

/** До прокси платежа: сумма = Final Price помеченного заказа. */
async function beforePayment(req) {
    const orderId = orderIdFromReq(req);
    if (!orderId) return null;
    const mark = await store.getOrderMark(orderId);
    if (!mark) return null;
    if (req.body && typeof req.body === 'object') {
        if (req.body.amount && typeof req.body.amount === 'object') req.body.amount = { ...req.body.amount, value: mark.finalPrice };
        else req.body.amount = { value: mark.finalPrice, code: 'RUB' };
    }
    if (req.query && req.query.amount !== undefined) setQueryParam(req, 'amount', String(mark.finalPrice));
    return mark;
}

/** После прокси просмотра заказов: цены помеченных заказов → наши. */
async function afterOrders(data) {
    if (!data || typeof data !== 'object') return data;
    const ids = [];
    const collect = (o, depth = 0) => {
        if (!o || typeof o !== 'object' || depth > 4) return;
        if (Array.isArray(o)) { o.forEach((x) => collect(x, depth + 1)); return; }
        if (o.order_id !== undefined) ids.push(String(o.order_id));
        if (o.id !== undefined && (o.package || o.full_price !== undefined)) ids.push(String(o.id));
        if (o.order) collect(o.order, depth + 1);
        if (o.orders) collect(o.orders, depth + 1);
        if (o.result) collect(o.result, depth + 1);
    };
    collect(data);
    if (!ids.length) return data;
    const marks = await store.getOrderMarks(ids);
    if (!marks.size) return data;
    // внутренние заказы (без LT) → totus_booking + order_state из бронирования
    const bookings = require('./bookings');
    const internal = await bookings.getByOrderIds([...marks.keys()]);
    const apply = (o, depth = 0) => {
        if (!o || typeof o !== 'object' || depth > 4) return o;
        if (Array.isArray(o)) return o.map((x) => apply(x, depth + 1));
        const oid = o.order_id !== undefined ? String(o.order_id) : (o.id !== undefined && (o.package || o.full_price !== undefined) ? String(o.id) : null);
        const m = oid ? marks.get(oid) : null;
        if (m) {
            const res = Object.assign(rewritePrices(o, m.providerPrice, m.finalPrice), { totus_room: { roomTypeId: m.roomTypeId, providerPrice: m.providerPrice, finalPrice: m.finalPrice } });
            const b = internal.get(oid);
            if (b) { res.totus_booking = bookings.serialize(b); res.order_state = b.status; }
            return res;
        }
        const out = {};
        for (const [k, v] of Object.entries(o)) out[k] = v && typeof v === 'object' ? apply(v, depth + 1) : v;
        return out;
    };
    return apply(data);
}

module.exports = {
    setQueryParam, rewritePrices, extractProviderPrice, extractPackageId, extractNights, priceForPackage, pricingFromSnapshot, currentPricing, packageIdFromReq, orderIdFromReq,
    beforePackageDetails, afterPackageDetails, beforePackageStep, afterPackageStep, synthesizePackageStep,
    beforeCreatePackage, afterCreatePackage, beforePayment, afterOrders, PRICE_KEYS,
};
