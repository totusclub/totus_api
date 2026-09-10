'use strict';

/**
 * Цепочка бронирования для наших Room Type (план §6):
 *   package_details?tour_id=<наш id> → подмена на исходный tour_id, цены в ответе → наши, package.id → карта
 *   actualize / orders/prebuild / packages/prebook → по карте: свежая цена LT → пересчёт → цены в ответе
 *   create-package → сумма платежа = Final Price, пометка заказа (orders.custom_room_type_id …), цены в package JSON
 *   /orders, /user/orders, /client/orders* → цены помеченных заказов → наши
 *   /vtb/create-order, /orders/:id/payment → сумма платежа = Final Price
 *
 * Поля цены LT известны по коду клиентов: package.price (package_details/actualize/prebook), order.package.price,
 * order.full_price, order.remaining_amount (prebuild/create). Остальные числовые поля с «ценовыми» именами и
 * значением, равным цене провайдера, тоже переписываются (точный список — проверить на проде, см. docs).
 */

const db = require('../../db');
const store = require('./store');
const { finalPrice, normalizeRule } = require('./pricing');
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

async function currentRule(roomTypeId, fallback) {
    const rt = await store.getRoomType(roomTypeId);
    if (rt && rt.active && rt.rule) return rt.rule;
    // правило из снимка (комната выключена/удалена после выбора — цена для клиента не должна прыгать)
    const r = normalizeRule({ ruleType: fallback && fallback.type, ruleValue: fallback && fallback.value, rounding: fallback && fallback.rounding, minPrice: fallback && fallback.minPrice, maxPrice: fallback && fallback.maxPrice, minMarginType: fallback && fallback.minMarginType, minMarginValue: fallback && fallback.minMarginValue }, await store.getSettings());
    return r.error ? null : r;
}

function ruleSnapshot(rule) {
    return rule ? { type: rule.ruleType, value: rule.ruleValue, rounding: rule.rounding, minPrice: rule.minPrice, maxPrice: rule.maxPrice, minMarginType: rule.minMarginType, minMarginValue: rule.minMarginValue } : {};
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
    const rule = rt && rt.rule ? rt.rule : null;
    if (!rule) return data;
    const provider = extractProviderPrice(data) || offer.providerPrice;
    const priced = finalPrice(provider, rule);
    if (priced.final === null) return data;
    const pkgId = extractPackageId(data);
    if (pkgId) {
        await store.savePackageMap({ ltPackageId: pkgId, roomTypeId: rt.id, virtualOfferId: offer.virtualOfferId, sourceOfferId: offer.sourceOfferId, operatorName: rt.last && rt.last.operator, providerPrice: provider, finalPrice: priced.final, rule: ruleSnapshot(rule) });
    }
    const out = rewritePrices(data, provider, priced.final);
    out.totus_room = { roomTypeId: rt.id, providerPrice: provider, finalPrice: priced.final };
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
    const rule = await currentRule(map.roomTypeId, map.rule);
    if (!rule) return data;
    const provider = extractProviderPrice(data) || map.providerPrice;
    const priced = finalPrice(provider, rule);
    if (priced.final === null) return data;
    if (provider !== map.providerPrice || priced.final !== map.finalPrice) {
        await store.updatePackagePrices(map.ltPackageId, provider, priced.final);
        if (provider !== map.providerPrice) console.log(`[custom-rooms] package ${map.ltPackageId}: provider price ${map.providerPrice} → ${provider}, final ${priced.final}`);
    }
    const out = rewritePrices(data, provider, priced.final);
    out.totus_room = { roomTypeId: map.roomTypeId, providerPrice: provider, finalPrice: priced.final, priceChanged: provider !== map.providerPrice ? { from: map.finalPrice, to: priced.final } : null };
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
    const rule = await currentRule(map.roomTypeId, map.rule);
    try {
        await store.markOrder(orderId, { roomTypeId: map.roomTypeId, providerPrice: map.providerPrice, finalPrice: map.finalPrice, rule: Object.assign({}, ruleSnapshot(rule), { operator: map.operatorName || null }) });
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
    const apply = (o, depth = 0) => {
        if (!o || typeof o !== 'object' || depth > 4) return o;
        if (Array.isArray(o)) return o.map((x) => apply(x, depth + 1));
        const oid = o.order_id !== undefined ? String(o.order_id) : (o.id !== undefined && (o.package || o.full_price !== undefined) ? String(o.id) : null);
        const m = oid ? marks.get(oid) : null;
        if (m) return Object.assign(rewritePrices(o, m.providerPrice, m.finalPrice), { totus_room: { roomTypeId: m.roomTypeId, providerPrice: m.providerPrice, finalPrice: m.finalPrice } });
        const out = {};
        for (const [k, v] of Object.entries(o)) out[k] = v && typeof v === 'object' ? apply(v, depth + 1) : v;
        return out;
    };
    return apply(data);
}

module.exports = {
    setQueryParam, rewritePrices, extractProviderPrice, extractPackageId, packageIdFromReq, orderIdFromReq,
    beforePackageDetails, afterPackageDetails, beforePackageStep, afterPackageStep,
    beforeCreatePackage, afterCreatePackage, beforePayment, afterOrders, PRICE_KEYS,
};
