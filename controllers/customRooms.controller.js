'use strict';

/**
 * Админка «Отели и номера» — /api/admin/rooms/* (staff-JWT strict). docs/CUSTOM_ROOMS_API.md.
 * Поиск отелей/номеров для админки — через Level.Travel (тот же flow, что у сайта: enqueue → status → grouped_hotels → hotel_rooms).
 * Бронирования без Level.Travel — /api/admin/rooms/bookings/* (lib/customRooms/bookings.js).
 */

const path = require('path');
const fs = require('fs');
const { ltRequest, logLtError, sendLtAxiosError } = require('../utils/levelTravelHttp');
const store = require('../lib/customRooms/store');
const diag = require('../lib/customRooms/diag');
const { normalizeRule, ruleLabel, normalizePricing, computePrice, pricingLabel, PRICING_MODES, FIXED_UNITS } = require('../lib/customRooms/pricing');
const { pickSourceOffers, pickTemplateOffers, operatorIdOf, operatorNameOf } = require('../lib/customRooms/inject');
const bookings = require('../lib/customRooms/bookings');

const ERROR_STATUS = { not_found: 404, custom_rooms_not_migrated: 503, source_room_not_found: 404, request_id_required: 400 };
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
    console.error('[custom-rooms] admin error:', e);
    if (!res.headersSent) res.status(500).json({ error: 'internal_error', message: e.message });
});
function fail(res, error, extra) { return res.status(ERROR_STATUS[error] || 400).json({ error, ...(extra || {}) }); }
function staffOf(req) {
    const p = (req.auth && req.auth.payload) || req.authStaff || {};
    return { id: req.auth ? req.auth.id : null, name: [p.name, p.lastname].filter(Boolean).join(' ').trim() || p.email || null };
}
function intParam(v) { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; }
function str(v, max) { if (v === undefined || v === null) return null; const s = String(v).trim(); return s ? s.slice(0, max) : null; }

async function readyGuard(req, res, next) {
    if (await store.isReady()) return next();
    return fail(res, 'custom_rooms_not_migrated');
}

// ---------------------------------------------------------------------------
// Level.Travel для админки
// ---------------------------------------------------------------------------
/** GET /hotels/search — enqueue + status (до ~25 с) + grouped hotels с фильтром звёзд. */
const searchHotels = wrap(async (req, res) => {
    const q = req.query || {};
    let requestId = q.request_id;
    try {
        if (!requestId) {
            const params = { search_type: 'hotel', from_city: q.from_city || 'Moscow', to_country: q.to_country, adults: q.adults || 2, start_date: q.start_date, nights: q.nights };
            if (q.to_city) params.to_city = q.to_city;
            if (q.hotel_ids) params.hotel_ids = q.hotel_ids;
            if (q.kids) params.kids = q.kids;
            if (q.kids_ages) params.kids_ages = q.kids_ages;
            if (q.end_date) { params.end_date = q.end_date; delete params.nights; }
            const enq = await ltRequest({ path: '/search/enqueue', params, versions: ['3.7'] });
            requestId = enq.data && (enq.data.request_id || (enq.data.search && enq.data.search.request_id));
            if (!requestId) return res.status(502).json({ error: 'lt_enqueue_failed', data: enq.data });
            await store.rememberSearch(requestId, 'hotel', params);
        }
        // ждём готовности хотя бы части операторов
        const deadline = Date.now() + Math.min(Number(q.wait_ms) || 20000, 45000);
        let status = null;
        let ready = [];
        while (Date.now() < deadline) {
            const st = await ltRequest({ path: '/search/status', params: { request_id: requestId }, versions: ['3.7'] });
            status = st.data && st.data.status ? st.data.status : st.data;
            ready = Object.entries(status || {}).filter(([, s]) => ['completed', 'cached', 'no_results', 'failed', 'skipped', 'all_filtered'].includes(String(s))).map(([id]) => id);
            const total = Object.keys(status || {}).length;
            if (total && ready.length === total) break;
            if (ready.length && Date.now() > deadline - 12000) break;
            await new Promise((r) => setTimeout(r, 2000));
        }
        const params = { request_id: requestId, page_limit: q.page_limit || 30, page_number: q.page_number || 0 };
        if (q.stars) params.filter_stars = String(q.stars);
        if (q.q) params.filter_hotel_name = String(q.q);
        if (q.sort_by) params.sort_by = q.sort_by;
        const gh = await ltRequest({ path: '/search/get_grouped_hotels', params, versions: ['3.7'] });
        const hotels = Array.isArray(gh.data && gh.data.hotels) ? gh.data.hotels : (Array.isArray(gh.data && gh.data.result) ? gh.data.result : []);
        const ids = hotels.map((h) => Number((h.hotel && h.hotel.id) || h.hotel_id || h.id)).filter(Boolean);
        const counts = new Map();
        if (ids.length) {
            const all = await store.listRoomTypes({});
            for (const rt of all) if (ids.includes(rt.hotelId)) counts.set(rt.hotelId, (counts.get(rt.hotelId) || 0) + 1);
        }
        const onlyOurs = q.only_ours === '1' || q.only_ours === 'true';
        const list = hotels.map((h) => {
            const id = Number((h.hotel && h.hotel.id) || h.hotel_id || h.id);
            return { ...h, totus_room_types: counts.get(id) || 0 };
        }).filter((h) => !onlyOurs || h.totus_room_types > 0);
        res.json({ request_id: requestId, status, ready_operators: ready, hotels: list, raw_meta: { total: gh.data && gh.data.total, page: gh.data && gh.data.page } });
    } catch (e) {
        logLtError('[custom-rooms] hotels/search', e, { query: q });
        return sendLtAxiosError(res, e, 'Level.Travel search failed');
    }
});

function summarizeOffers(room) {
    const out = [];
    for (const [meal, list] of Object.entries(room.offers || {})) for (const o of list || []) {
        out.push({ id: String(o.id), meal, operator_id: o.operator_id, operator_name: o.operator_name, price: o.price, nights_count: o.nights_count, start_date: o.start_date, availability: o.availability || null, extras: o.extras ? { cancellation_policy: o.extras.cancellation_policy || null, instant_confirm: o.extras.instant_confirm } : null });
    }
    return out;
}

function nightsOf(o) { const n = Number(o && o.nights_count); return Number.isFinite(n) && n > 0 ? n : null; }

/** v2: превью наших предложений по выдаче: шаблоны (самое дешёвое по питанию) × режим цены. */
function previewRows(src, rt) {
    if (!src || !rt.pricing) return [];
    return pickTemplateOffers(src, rt).map(({ meal, offer }) => {
        const p = computePrice(offer.price, nightsOf(offer), rt.pricing);
        return { offer_id: String(offer.id), meal, operator_id: offer.operator_id, operator_name: offer.operator_name, nights_count: nightsOf(offer), provider_price: Number(offer.price), final_price: p.final, margin: p.margin, margin_percent: p.marginPercent, margin_clamped: p.marginClamped, mode: rt.pricing.mode, our_operator_id: operatorIdOf(rt), our_operator_name: operatorNameOf(rt) };
    });
}

/** GET /hotels/:hotelId/rooms?request_id — номера LT по операторам + наши Room Type с расчётом по этой выдаче. */
const hotelRooms = wrap(async (req, res) => {
    const hotelId = intParam(req.params.hotelId);
    const requestId = req.query && req.query.request_id;
    if (!hotelId) return fail(res, 'hotel_id_invalid');
    if (!requestId) return fail(res, 'request_id_required');
    let data;
    try {
        const r = await ltRequest({ path: '/search/hotel_rooms', params: { request_id: requestId, hotel_id: hotelId }, versions: ['3.7'] });
        data = r.data;
    } catch (e) {
        logLtError('[custom-rooms] hotel_rooms', e, { hotelId, requestId });
        return sendLtAxiosError(res, e, 'Level.Travel hotel_rooms failed');
    }
    const rooms = Array.isArray(data && data.result) ? data.result : [];
    const rts = await store.listRoomTypes({ hotelId });
    const settings = await store.getSettings();
    const byRoom = new Map(rooms.map((r) => [Number(r.room && r.room.id), r]));

    // v2: наши Room Type показываем под исходным номером всегда, когда номер есть в выдаче (оператор LT не важен)
    const ours = rts.map((rt) => {
        const src = byRoom.get(Number(rt.sourceRoomId));
        const preview = previewRows(src, rt);
        // диагностика: no_pricing (нет цены/правила) и no_offers (номер есть, предложений нет) вместо ложного source_missing
        let status = rt.active ? (src ? (rt.pricing ? 'no_offers' : 'no_pricing') : 'source_missing') : 'inactive';
        if (src && preview.length && rt.active) {
            if (rt.pricing && rt.pricing.mode === 'fixed') status = 'fixed';
            else status = preview.some((x) => x.margin_clamped) ? 'margin_clamped' : 'replacing';
        }
        const replaces = src && Array.isArray(rt.operatorIds) && rt.operatorIds.length ? pickSourceOffers(src, rt).map((x) => String(x.offer.id)) : [];
        return { ...rt, ruleLabel: rt.rule ? ruleLabel(rt.rule) : null, pricingLabel: pricingLabel(rt.pricing), status, preview, replaces_offer_ids: replaces };
    });

    // группировка по операторам: оператор → номера с его предложениями
    const operators = new Map();
    for (const r of rooms) {
        for (const [meal, list] of Object.entries(r.offers || {})) for (const o of list || []) {
            const key = Number(o.operator_id);
            if (!operators.has(key)) operators.set(key, { operator_id: key, operator_name: o.operator_name, rooms: new Map() });
            const op = operators.get(key);
            const roomId = Number(r.room && r.room.id);
            if (!op.rooms.has(roomId)) op.rooms.set(roomId, { room_id: roomId, ID: r.ID, room: r.room, offers: [], room_types: ours.filter((x) => x.sourceRoomId === roomId && (!x.operatorIds.length || x.operatorIds.map(Number).includes(key))).map((x) => x.id) });
            op.rooms.get(roomId).offers.push({ id: String(o.id), meal, price: o.price, nights_count: o.nights_count, extras: o.extras ? { cancellation_policy: o.extras.cancellation_policy || null, instant_confirm: o.extras.instant_confirm } : null, availability: o.availability || null });
        }
    }
    const grouped = [...operators.values()].map((op) => ({ ...op, rooms: [...op.rooms.values()] }));

    res.json({
        request_id: requestId, hotel_id: hotelId, search_type: data && data.search_type, currency: data && data.currency_code,
        operators: grouped,
        rooms: rooms.map((r) => ({ ID: r.ID, room: r.room, min_price: r.min_price, meal_types: r.meal_types, offers: summarizeOffers(r), room_types: ours.filter((x) => x.sourceRoomId === Number(r.room && r.room.id)).map((x) => x.id) })),
        room_types: ours,
        settings,
    });
});

// ---------------------------------------------------------------------------
// Room Type CRUD
// ---------------------------------------------------------------------------
function validateContent(c) {
    const b = c || {};
    const nameRu = str(b.nameRu !== undefined ? b.nameRu : b.name_ru, 255);
    if (!nameRu) return { error: 'name_required' };
    const images = Array.isArray(b.images) ? b.images.map((im) => {
        if (typeof im === 'string') return { source: /^\/uploads\//.test(im) ? 'upload' : 'lt', url: im };
        if (im && typeof im === 'object' && im.url) return { source: im.source === 'upload' ? 'upload' : 'lt', url: String(im.url).slice(0, 1024) };
        return null;
    }).filter(Boolean).slice(0, 30) : [];
    const facilities = Array.isArray(b.facilities) ? b.facilities.map((f) => (typeof f === 'string' ? f.slice(0, 120) : (f && f.name ? { id: f.id, name: String(f.name).slice(0, 120), group_identifier: f.group_identifier || null } : null))).filter(Boolean).slice(0, 60) : [];
    const area = b.area === undefined || b.area === null || b.area === '' ? null : Number(b.area);
    if (area !== null && !(Number.isFinite(area) && area >= 0)) return { error: 'area_invalid' };
    return {
        content: {
            nameRu, nameEn: str(b.nameEn !== undefined ? b.nameEn : b.name_en, 255), accommodation: str(b.accommodation, 64), area, view: str(b.view, 128),
            description: b.description === undefined || b.description === null ? null : String(b.description).slice(0, 8000), facilities, images,
        },
    };
}

async function validateRoomType(body, settings, existing) {
    const b = body || {};
    const hotelId = intParam(b.hotelId !== undefined ? b.hotelId : (existing && existing.hotelId));
    const sourceRoomId = intParam(b.sourceRoomId !== undefined ? b.sourceRoomId : (existing && existing.sourceRoomId));
    if (!hotelId) return { error: 'hotel_id_invalid' };
    if (!sourceRoomId) return { error: 'source_room_id_invalid' };
    // v2: operatorIds / mealTypes необязательны (пустые = не ограничивать)
    const operatorIds = [...new Set((Array.isArray(b.operatorIds) ? b.operatorIds : (existing ? existing.operatorIds : [])).map(Number).filter((x) => Number.isInteger(x) && x > 0))];
    const operatorNames = Array.isArray(b.operatorNames) ? b.operatorNames.map((x) => String(x).slice(0, 128)).slice(0, 20) : (existing ? existing.operatorNames : []);
    const mealTypes = Array.isArray(b.mealTypes) && b.mealTypes.length ? b.mealTypes.map((x) => String(x).slice(0, 16)).slice(0, 20) : (b.mealTypes === null || (Array.isArray(b.mealTypes) && !b.mealTypes.length) ? null : (existing ? existing.mealTypes : null));
    const c = validateContent(b.content || (existing ? { ...existing.content, ...(b.content || {}) } : b));
    if (c.error) return c;
    // v2: режим цены — fixed (по умолчанию для новых) | rule
    const pricingMode = PRICING_MODES.includes(b.pricingMode) ? b.pricingMode : PRICING_MODES.includes(b.pricing_mode) ? b.pricing_mode
        : (existing ? existing.pricingMode : (b.rule && (b.rule.ruleType || b.rule.rule_type) && b.fixedPrice === undefined ? 'rule' : 'fixed'));
    const ruleInput = Object.assign({}, existing && existing.ruleType ? { ruleType: existing.ruleType, ruleValue: existing.ruleValue, rounding: existing.rounding, minPrice: existing.minPrice, maxPrice: existing.maxPrice, minMarginType: existing.minMarginType, minMarginValue: existing.minMarginValue } : {}, b.rule || (b.ruleType || b.rule_type ? b : {}));
    const ruleN = normalizeRule(ruleInput, settings);
    if (pricingMode === 'rule' && ruleN.error) return ruleN;
    const rule = ruleN.error ? null : ruleN;
    const fixedPrice = b.fixedPrice !== undefined ? b.fixedPrice : b.fixed_price !== undefined ? b.fixed_price : (existing ? existing.fixedPrice : null);
    const fixedPriceUnit = FIXED_UNITS.includes(b.fixedPriceUnit) ? b.fixedPriceUnit : FIXED_UNITS.includes(b.fixed_price_unit) ? b.fixed_price_unit : (existing ? existing.fixedPriceUnit : 'total');
    const pricing = normalizePricing({ mode: pricingMode, fixedPrice, fixedPriceUnit, rule });
    if (pricing.error) return { error: pricing.error };
    const operatorName = str(b.operatorName !== undefined ? b.operatorName : b.operator_name, 128) || (existing && existing.operatorName) || 'Arlekino';
    const operatorIdRaw = b.operatorId !== undefined ? b.operatorId : b.operator_id !== undefined ? b.operator_id : (existing ? existing.operatorId : null);
    const operatorId = operatorIdRaw === null || operatorIdRaw === '' || operatorIdRaw === undefined ? null : intParam(operatorIdRaw);
    if (operatorIdRaw !== null && operatorIdRaw !== '' && operatorIdRaw !== undefined && !operatorId) return { error: 'operator_id_invalid' };
    // packageTypes: пустые = любой тип поиска
    const packageTypes = Array.isArray(b.packageTypes) ? b.packageTypes.filter((x) => ['hotel', 'package'].includes(x)) : (existing ? existing.packageTypes : []);
    return {
        value: {
            hotelId, hotelName: str(b.hotelName, 255) || (existing && existing.hotelName) || null,
            hotelStars: b.hotelStars === undefined ? (existing ? existing.hotelStars : null) : (intParam(b.hotelStars) || null),
            hotelCity: str(b.hotelCity, 128) || (existing && existing.hotelCity) || null,
            sourceRoomId, sourceRoomName: str(b.sourceRoomName, 255) || (existing && existing.sourceRoomName) || null,
            sourceSnapshot: b.sourceSnapshot && typeof b.sourceSnapshot === 'object' ? b.sourceSnapshot : (existing ? existing.sourceSnapshot : null),
            operatorIds, operatorNames, mealTypes,
            content: c.content, rule, pricing, pricingMode: pricing.mode, fixedPrice: pricing.fixedPrice, fixedPriceUnit: pricing.fixedPriceUnit, operatorName, operatorId,
            packageTypes,
            badge: str(b.badge, 64) || (existing ? existing.badge : null) || settings.badge,
            active: b.active === undefined ? (existing ? existing.active : true) : b.active !== false,
            sortOrder: b.sortOrder === undefined ? (existing ? existing.sortOrder : 0) : (Number(b.sortOrder) || 0),
        },
    };
}

function diff(before, after) {
    const out = {};
    const keys = ['operatorIds', 'mealTypes', 'pricingMode', 'fixedPrice', 'fixedPriceUnit', 'operatorName', 'operatorId', 'ruleType', 'ruleValue', 'rounding', 'minPrice', 'maxPrice', 'minMarginType', 'minMarginValue', 'badge', 'active', 'sortOrder', 'packageTypes'];
    for (const k of keys) if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) out[k] = { from: before[k], to: after[k] };
    for (const k of Object.keys(after.content || {})) if (JSON.stringify(before.content && before.content[k]) !== JSON.stringify(after.content[k])) out[`content.${k}`] = { from: before.content ? before.content[k] : null, to: after.content[k] };
    return out;
}

const list = wrap(async (req, res) => {
    const q = req.query || {};
    res.json({ room_types: await store.listRoomTypes({ hotelId: q.hotel_id, active: q.active === '1' ? true : q.active === '0' ? false : undefined, q: q.q }), settings: await store.getSettings() });
});

const get = wrap(async (req, res) => {
    const rt = await store.getRoomType(intParam(req.params.id));
    if (!rt) return fail(res, 'not_found');
    res.json({ room_type: { ...rt, ruleLabel: rt.rule ? ruleLabel(rt.rule) : null, pricingLabel: pricingLabel(rt.pricing) } });
});

/** POST /room-types — создать (в т.ч. «на основе номера»: body.source = { room, offers } из выдачи). */
const create = wrap(async (req, res) => {
    const settings = await store.getSettings();
    const body = req.body || {};
    // предзаполнение из источника, если контент не задан
    if (body.source && body.source.room && !body.content) {
        const r = body.source.room;
        body.content = { nameRu: r.name_ru, nameEn: r.name_en, accommodation: r.accommodation, area: r.area, view: r.view, description: r.description, facilities: r.facilities, images: (r.images || []).map((im) => ({ source: 'lt', url: im.x900 || im.x900x380 || im })) };
        body.sourceRoomId = body.sourceRoomId || r.id;
        body.sourceRoomName = body.sourceRoomName || r.name_ru;
        body.sourceSnapshot = body.sourceSnapshot || r;
    }
    const v = await validateRoomType(body, settings, null);
    if (v.error) return fail(res, v.error);
    const staff = staffOf(req);
    const id = await store.createRoomType(v.value, staff.name);
    await store.logChange(id, staff, { created: true, pricing: pricingLabel(v.value.pricing), rule: v.value.rule ? `${v.value.rule.ruleType} ${v.value.rule.ruleValue}` : null, operators: v.value.operatorIds });
    const rt = await store.getRoomType(id);
    res.status(201).json({ ok: true, room_type: rt });
});

const update = wrap(async (req, res) => {
    const id = intParam(req.params.id);
    const existing = await store.getRoomType(id);
    if (!existing) return fail(res, 'not_found');
    const settings = await store.getSettings();
    const v = await validateRoomType(req.body, settings, existing);
    if (v.error) return fail(res, v.error);
    await store.updateRoomType(id, v.value);
    const rt = await store.getRoomType(id);
    const changes = diff(existing, rt);
    if (Object.keys(changes).length) await store.logChange(id, staffOf(req), changes);
    res.json({ ok: true, room_type: rt });
});

const toggle = wrap(async (req, res) => {
    const id = intParam(req.params.id);
    const existing = await store.getRoomType(id);
    if (!existing) return fail(res, 'not_found');
    const active = typeof (req.body || {}).active === 'boolean' ? req.body.active : !existing.active;
    await store.setActive(id, active);
    await store.logChange(id, staffOf(req), { active: { from: existing.active, to: active } });
    res.json({ ok: true, room_type: await store.getRoomType(id) });
});

const remove = wrap(async (req, res) => {
    const id = intParam(req.params.id);
    const existing = await store.getRoomType(id);
    if (!existing) return fail(res, 'not_found');
    await store.logChange(id, staffOf(req), { deleted: true, name: existing.content.nameRu });
    await store.deleteRoomType(id);
    res.json({ ok: true });
});

/** POST /room-types/:id/duplicate { name?, copyContent=true, copyRule=true, images: 'same'|'none' } */
const duplicate = wrap(async (req, res) => {
    const id = intParam(req.params.id);
    const src = await store.getRoomType(id);
    if (!src) return fail(res, 'not_found');
    const b = req.body || {};
    const settings = await store.getSettings();
    const body = {
        hotelId: src.hotelId, hotelName: src.hotelName, hotelStars: src.hotelStars, hotelCity: src.hotelCity,
        sourceRoomId: src.sourceRoomId, sourceRoomName: src.sourceRoomName, sourceSnapshot: src.sourceSnapshot,
        operatorIds: src.operatorIds, operatorNames: src.operatorNames, mealTypes: src.mealTypes,
        pricingMode: src.pricingMode, fixedPrice: src.fixedPrice, fixedPriceUnit: src.fixedPriceUnit, operatorName: src.operatorName, operatorId: src.operatorId,
        content: b.copyContent === false && src.sourceSnapshot ? { nameRu: `${src.sourceSnapshot.name_ru || src.content.nameRu} (копия)`, description: src.sourceSnapshot.description, area: src.sourceSnapshot.area, view: src.sourceSnapshot.view, facilities: src.sourceSnapshot.facilities, images: b.images === 'none' ? [] : (src.sourceSnapshot.images || []).map((im) => ({ source: 'lt', url: im.x900 || im.x900x380 || im })) }
            : { ...src.content, nameRu: str(b.name, 255) || `${src.content.nameRu} (копия)`, images: b.images === 'none' ? [] : src.content.images },
        rule: b.copyRule === false ? { ruleType: 'percent', ruleValue: 0 } : (src.ruleType ? { ruleType: src.ruleType, ruleValue: src.ruleValue, rounding: src.rounding, minPrice: src.minPrice, maxPrice: src.maxPrice, minMarginType: src.minMarginType, minMarginValue: src.minMarginValue } : undefined),
        packageTypes: src.packageTypes, badge: src.badge, active: false, sortOrder: src.sortOrder + 1,
    };
    if (str(b.name, 255)) body.content.nameRu = str(b.name, 255);
    const v = await validateRoomType(body, settings, null);
    if (v.error) return fail(res, v.error);
    const staff = staffOf(req);
    const newId = await store.createRoomType(v.value, staff.name);
    await store.logChange(newId, staff, { duplicatedFrom: id });
    res.status(201).json({ ok: true, room_type: await store.getRoomType(newId) });
});

/**
 * POST /room-types/preview-price — расчёт без сохранения.
 * rule: { rule, offers: [{operator_name, meal, price, nights_count}] } | { providerPrice }
 * v2 fixed: { pricingMode:'fixed', fixedPrice, fixedPriceUnit, offers? } → final = fixedPrice (per_night × nights_count).
 */
const previewPrice = wrap(async (req, res) => {
    const b = req.body || {};
    const settings = await store.getSettings();
    const mode = PRICING_MODES.includes(b.pricingMode) ? b.pricingMode : PRICING_MODES.includes(b.pricing_mode) ? b.pricing_mode : 'rule';
    let rule = null;
    if (mode === 'rule') {
        rule = normalizeRule(b.rule || b, settings);
        if (rule.error) return fail(res, rule.error);
    }
    const pricing = normalizePricing({ mode, fixedPrice: b.fixedPrice !== undefined ? b.fixedPrice : b.fixed_price, fixedPriceUnit: b.fixedPriceUnit || b.fixed_price_unit, rule });
    if (pricing.error) return fail(res, pricing.error);
    const offers = Array.isArray(b.offers) && b.offers.length ? b.offers : (b.providerPrice ? [{ price: b.providerPrice, nights_count: b.nights }] : (mode === 'fixed' ? [{ price: null, nights_count: b.nights }] : []));
    const rows = offers.map((o) => { const p = computePrice(o.price, nightsOf(o), pricing); return { operator_name: o.operator_name || null, meal: o.meal || null, nights_count: nightsOf(o), provider_price: o.price === null || o.price === undefined ? null : Number(o.price), final_price: p.final, margin: p.margin, margin_percent: p.marginPercent, margin_clamped: p.marginClamped, floor: p.floor, mode: pricing.mode }; });
    res.json({ pricingMode: pricing.mode, fixedPrice: pricing.fixedPrice, fixedPriceUnit: pricing.fixedPriceUnit, label: pricingLabel(pricing), rule: rule ? { ...rule, label: ruleLabel(rule) } : null, rows });
});

const priceLog = wrap(async (req, res) => {
    const id = intParam(req.params.id);
    if (!(await store.getRoomType(id))) return fail(res, 'not_found');
    res.json({ items: await store.listPriceLog(id, req.query || {}) });
});
const changeLog = wrap(async (req, res) => {
    const id = intParam(req.params.id);
    if (!(await store.getRoomType(id))) return fail(res, 'not_found');
    res.json({ items: await store.listChanges(id, (req.query || {}).limit) });
});
const orders = wrap(async (req, res) => {
    const id = intParam(req.params.id);
    if (!(await store.getRoomType(id))) return fail(res, 'not_found');
    res.json({ items: await store.listOrdersForRoomType(id, (req.query || {}).limit) });
});

/** POST /images (multipart image) → { url } для content.images[{source:'upload', url}] */
const uploadImage = wrap(async (req, res) => {
    if (!req.file) return fail(res, 'file_required');
    res.status(201).json({ ok: true, image: { source: 'upload', url: `/uploads/rooms/${req.file.filename}` } });
});
const deleteImage = wrap(async (req, res) => {
    const name = String((req.body || {}).url || req.params.name || '').split('/').pop();
    if (!/^[\w.-]+$/.test(name)) return fail(res, 'name_invalid');
    const p = path.join(__dirname, '..', 'uploads', 'rooms', name);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    res.json({ ok: true });
});

/**
 * GET /diagnostics?recheck=1 — почему Room Type не виден на витрине (без логов сервера). Работает и при DISABLED
 * (маршрут смонтирован до readyGuard). Ответ:
 * { ready, disabledReason, missingTables, missingColumns, diagColumns, checkedAt, settings, env,
 *   activeRoomTypes: [{ id, hotelId, hotelName, sourceRoomId, sourceRoomName, pricingMode, pricingOk, packageTypes, lastSeenAt, lastCheckedAt, lastSkipReason }],
 *   appJsHooks: { middleware: { mounted, middlewareCalls, watchedCalls, notReadySkips, startSearchSeen, hotelsRoomsSeen, hotelsRoomsInjected, hotelsRoomsErrors, lastStartSearchAt, lastHotelsRoomsAt, lastHotelsRoomsHotelId, lastHotelsRoomsSearchType, lastInjectAt, lastError, startedAt }, adminRoutes: true },
 *   events: [{ at, line }], hints: ['…'] }
 */
const diagnostics = wrap(async (req, res) => {
    const q = req.query || {};
    const ready = await store.getReadyState(q.recheck === '1' || q.recheck === 'true');
    const s = diag.snapshot();
    const { events, ...mw } = s;
    const hints = [];
    let settings = null;
    let activeRoomTypes = [];
    if (!ready.ready) {
        hints.push(`Модуль выключен целиком (${ready.disabledReason}): на сервере выполнить node scripts/run-custom-rooms-migration.js и pm2 restart api, затем открыть эту страницу с ?recheck=1.`);
    } else {
        settings = await store.getSettings(true);
        try {
            activeRoomTypes = (await store.listActiveRoomTypes()).map((rt) => ({
                id: rt.id, hotelId: rt.hotelId, hotelName: rt.hotelName, sourceRoomId: rt.sourceRoomId, sourceRoomName: rt.sourceRoomName,
                pricingMode: rt.pricingMode, pricingOk: Boolean(rt.pricing), pricingLabel: pricingLabel(rt.pricing), packageTypes: rt.packageTypes,
                lastSeenAt: rt.last.seenAt, lastCheckedAt: rt.lastCheckedAt, lastSkipReason: rt.lastSkipReason,
            }));
        } catch (e) { hints.push(`Не удалось прочитать custom_room_types: ${e.message}`); }
        if (!ready.diagColumns) hints.push('Колонок last_skip_reason/last_checked_at нет: причина пропуска не сохраняется — повторно выполнить node scripts/run-custom-rooms-migration.js && pm2 restart api.');
        if (settings.hotelOnly) hints.push('Настройка «Показывать только при поиске отелей» включена, а сайт по умолчанию ищет с search_type=package — выключить в настройках или ограничить на самих Room Type.');
        if (!activeRoomTypes.length) hints.push('Нет активных Room Type — включить Room Type в админке.');
        for (const rt of activeRoomTypes) {
            const tag = `Room Type #${rt.id} (${rt.hotelName || `отель ${rt.hotelId}`})`;
            if (!rt.pricingOk) hints.push(`${tag}: режим цены ${rt.pricingMode} без цены/правила — открыть «Изменить» и сохранить цену.`);
            if (rt.packageTypes && rt.packageTypes.length && !rt.packageTypes.includes('package')) hints.push(`${tag}: показывается только при поиске ${rt.packageTypes.join(',')}, а сайт по умолчанию ищет package — переключить «Показывать при типе поиска» на «Любой».`);
            if (!rt.lastCheckedAt && !rt.lastSeenAt) hints.push(`${tag}: ещё ни один запрос /hotels-rooms по отелю ${rt.hotelId} не прошёл через middleware после запуска (${s.startedAt}) — открыть страницу отеля на сайте и обновить диагностику; если hotelsRoomsSeen растёт, а lastCheckedAt пуст — hotel_id в запросе сайта отличается от hotelId Room Type.`);
            else if (rt.lastSkipReason) hints.push(`${tag}: последний раз пропущен — ${rt.lastSkipReason}.`);
        }
    }
    if (mw.middlewareCalls === 0) hints.push('Через middleware не прошло ни одного запроса — проверить app.js: app.use(require(\'./middleware/customRooms\')) до прокси-маршрутов и pm2 restart api.');
    else if (mw.hotelsRoomsSeen === 0) hints.push(`Middleware подключён (${mw.middlewareCalls} запросов), но GET /hotels-rooms с request_id и hotel_id ещё не было с ${s.startedAt} — открыть страницу отеля на сайте.`);
    else if (mw.hotelsRoomsInjected === 0) hints.push(`GET /hotels-rooms обработано ${mw.hotelsRoomsSeen} раз (последний: отель ${mw.lastHotelsRoomsHotelId}, search_type ${mw.lastHotelsRoomsSearchType || '—'}), вставок не было — смотреть lastSkipReason у Room Type и events ниже.`);
    if (mw.hotelsRoomsErrors) hints.push(`Ошибок трансформации ответа: ${mw.hotelsRoomsErrors} (клиент получил оригинал LT) — последняя: ${mw.lastError && mw.lastError.message}.`);
    res.json({
        ready: ready.ready, disabledReason: ready.disabledReason, missingTables: ready.missingTables, missingColumns: ready.missingColumns, diagColumns: ready.diagColumns, checkedAt: ready.checkedAt, dbError: ready.error,
        settings, env: { hotelSearchTypeCodes: String(process.env.CUSTOM_ROOMS_HOTEL_SEARCH_TYPE_CODES || '1') },
        activeRoomTypes,
        appJsHooks: { middleware: { mounted: mw.middlewareCalls > 0, ...mw }, adminRoutes: true },
        events, hints,
    });
});

const getSettings = wrap(async (req, res) => { res.json({ settings: await store.getSettings(true) }); });
const putSettings = wrap(async (req, res) => {
    const r = await store.updateSettings(req.body || {});
    if (r && r.error) return fail(res, r.error);
    res.json({ ok: true, settings: r });
});

// ---------------------------------------------------------------------------
// Бронирования без Level.Travel — /api/admin/rooms/bookings/* (бриф §4)
// ---------------------------------------------------------------------------
const BOOKING_ERROR_STATUS = { not_found: 404, invalid_status: 409, reason_invalid: 400, refund_amount_invalid: 400, voucher_required: 400, file_required: 400 };
function bookingFail(res, r) {
    const { error, ...extra } = r;
    return res.status(BOOKING_ERROR_STATUS[error] || 400).json({ error, ...extra });
}
function bookingResult(res, r, extra) {
    if (r && r.error) return bookingFail(res, r);
    return res.json(Object.assign({ ok: true, booking: bookings.serializeAdmin(r.booking) }, extra || {}));
}

/** GET /bookings?status=all|pending|confirmed|rejected|refund|unpaid&hotel_id&operator&q&from&to&page&limit */
const bookingsList = wrap(async (req, res) => {
    const q = req.query || {};
    const { items, total, page, limit } = await bookings.list(q);
    res.json({ items, total, page, limit, summary: await bookings.summary() });
});

const bookingsSummary = wrap(async (req, res) => { res.json({ summary: await bookings.summary() }); });

/** GET /bookings/:id → { booking, roomType, events, order } */
const bookingGet = wrap(async (req, res) => {
    const d = await bookings.details(intParam(req.params.id));
    if (!d) return fail(res, 'not_found');
    res.json(d);
});

/** POST /bookings/:id/confirm { hotelBookingRef?, clientMessage?, notify=true } — только из pending_confirmation */
const bookingConfirm = wrap(async (req, res) => {
    const b = req.body || {};
    const r = await bookings.confirm(intParam(req.params.id), { hotelBookingRef: b.hotelBookingRef, clientMessage: b.clientMessage, notify: b.notify !== false && b.notify !== 'false' }, staffOf(req));
    return bookingResult(res, r);
});

/** POST /bookings/:id/voucher (multipart поле `voucher`, PDF ≤ 10 МБ) */
const bookingVoucher = wrap(async (req, res) => {
    if (!req.file) return fail(res, 'file_required');
    const r = await bookings.attachVoucher(intParam(req.params.id), req.file, staffOf(req));
    return bookingResult(res, r);
});

/** POST /bookings/:id/resend-voucher — письмо с ваучером + push documents_ready */
const bookingResendVoucher = wrap(async (req, res) => {
    const r = await bookings.resendVoucher(intParam(req.params.id), staffOf(req));
    return bookingResult(res, r, r && r.result ? { result: r.result } : null);
});

/** POST /bookings/:id/reject { reason, message?, refundAmount?, refundDone?, notify=true } — из pending_confirmation */
const bookingReject = wrap(async (req, res) => {
    const b = req.body || {};
    const r = await bookings.reject(intParam(req.params.id), { reason: b.reason, message: b.message, refundAmount: b.refundAmount, refundDone: b.refundDone === true || b.refundDone === 'true', notify: b.notify !== false && b.notify !== 'false' }, staffOf(req));
    return bookingResult(res, r);
});

/** POST /bookings/:id/cancel — то же для подтверждённого (confirmed → cancelled) */
const bookingCancel = wrap(async (req, res) => {
    const b = req.body || {};
    const r = await bookings.cancel(intParam(req.params.id), { reason: b.reason || 'other', message: b.message, refundAmount: b.refundAmount, refundDone: b.refundDone === true || b.refundDone === 'true', notify: b.notify !== false && b.notify !== 'false' }, staffOf(req));
    return bookingResult(res, r);
});

/** POST /bookings/:id/refund-done { amount?, notify=true } */
const bookingRefundDone = wrap(async (req, res) => {
    const b = req.body || {};
    const r = await bookings.refundDone(intParam(req.params.id), { amount: b.amount, notify: b.notify !== false && b.notify !== 'false' }, staffOf(req));
    return bookingResult(res, r);
});

/** POST /bookings/:id/comment { text } */
const bookingComment = wrap(async (req, res) => {
    const r = await bookings.comment(intParam(req.params.id), (req.body || {}).text, staffOf(req));
    return bookingResult(res, r);
});

module.exports = {
    readyGuard, searchHotels, hotelRooms, list, get, create, update, toggle, remove, duplicate, previewPrice, priceLog, changeLog, orders,
    uploadImage, deleteImage, getSettings, putSettings, diagnostics,
    bookingsList, bookingsSummary, bookingGet, bookingConfirm, bookingVoucher, bookingResendVoucher, bookingReject, bookingCancel, bookingRefundDone, bookingComment,
    _internal: { validateContent, validateRoomType, diff, previewRows },
};
