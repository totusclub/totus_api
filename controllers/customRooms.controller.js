'use strict';

/**
 * Админка «Отели и номера» — /api/admin/rooms/* (staff-JWT strict). docs/CUSTOM_ROOMS_API.md.
 * Поиск отелей/номеров для админки — через Level.Travel (тот же flow, что у сайта: enqueue → status → grouped_hotels → hotel_rooms).
 */

const path = require('path');
const fs = require('fs');
const { ltRequest, logLtError, sendLtAxiosError } = require('../utils/levelTravelHttp');
const store = require('../lib/customRooms/store');
const { normalizeRule, finalPrice, ruleLabel } = require('../lib/customRooms/pricing');
const { pickSourceOffers } = require('../lib/customRooms/inject');

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

    const ours = rts.map((rt) => {
        const src = byRoom.get(Number(rt.sourceRoomId));
        const preview = [];
        let status = 'source_missing';
        if (src && rt.rule) {
            for (const { meal, offer } of pickSourceOffers(src, rt)) {
                const p = finalPrice(offer.price, rt.rule);
                preview.push({ offer_id: String(offer.id), meal, operator_id: offer.operator_id, operator_name: offer.operator_name, provider_price: Number(offer.price), final_price: p.final, margin: p.margin, margin_percent: p.marginPercent, margin_clamped: p.marginClamped });
            }
            if (preview.length) status = preview.some((x) => x.margin_clamped) ? 'margin_clamped' : (rt.active ? 'replacing' : 'inactive');
        }
        return { ...rt, ruleLabel: rt.rule ? ruleLabel(rt.rule) : null, status, preview };
    });

    // группировка по операторам: оператор → номера с его предложениями
    const operators = new Map();
    for (const r of rooms) {
        for (const [meal, list] of Object.entries(r.offers || {})) for (const o of list || []) {
            const key = Number(o.operator_id);
            if (!operators.has(key)) operators.set(key, { operator_id: key, operator_name: o.operator_name, rooms: new Map() });
            const op = operators.get(key);
            const roomId = Number(r.room && r.room.id);
            if (!op.rooms.has(roomId)) op.rooms.set(roomId, { room_id: roomId, ID: r.ID, room: r.room, offers: [], room_types: ours.filter((x) => x.sourceRoomId === roomId && x.operatorIds.map(Number).includes(key)).map((x) => x.id) });
            op.rooms.get(roomId).offers.push({ id: String(o.id), meal, price: o.price, nights_count: o.nights_count, extras: o.extras ? { cancellation_policy: o.extras.cancellation_policy || null, instant_confirm: o.extras.instant_confirm } : null, availability: o.availability || null });
        }
    }
    const grouped = [...operators.values()].map((op) => ({ ...op, rooms: [...op.rooms.values()] }));

    res.json({
        request_id: requestId, hotel_id: hotelId, search_type: data && data.search_type, currency: data && data.currency_code,
        operators: grouped,
        rooms: rooms.map((r) => ({ ID: r.ID, room: r.room, min_price: r.min_price, meal_types: r.meal_types, offers: summarizeOffers(r) })),
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
    const operatorIds = [...new Set((Array.isArray(b.operatorIds) ? b.operatorIds : (existing ? existing.operatorIds : [])).map(Number).filter((x) => Number.isInteger(x) && x > 0))];
    if (!operatorIds.length) return { error: 'operator_required' };
    const operatorNames = Array.isArray(b.operatorNames) ? b.operatorNames.map((x) => String(x).slice(0, 128)).slice(0, 20) : (existing ? existing.operatorNames : []);
    const mealTypes = Array.isArray(b.mealTypes) && b.mealTypes.length ? b.mealTypes.map((x) => String(x).slice(0, 16)).slice(0, 20) : (b.mealTypes === null ? null : (existing ? existing.mealTypes : null));
    const c = validateContent(b.content || (existing ? { ...existing.content, ...(b.content || {}) } : b));
    if (c.error) return c;
    const rule = normalizeRule(Object.assign({}, existing ? { ruleType: existing.ruleType, ruleValue: existing.ruleValue, rounding: existing.rounding, minPrice: existing.minPrice, maxPrice: existing.maxPrice, minMarginType: existing.minMarginType, minMarginValue: existing.minMarginValue } : {}, b.rule || b), settings);
    if (rule.error) return rule;
    const packageTypes = Array.isArray(b.packageTypes) && b.packageTypes.length ? b.packageTypes.filter((x) => ['hotel', 'package'].includes(x)) : (existing ? existing.packageTypes : ['hotel']);
    return {
        value: {
            hotelId, hotelName: str(b.hotelName, 255) || (existing && existing.hotelName) || null,
            hotelStars: b.hotelStars === undefined ? (existing ? existing.hotelStars : null) : (intParam(b.hotelStars) || null),
            hotelCity: str(b.hotelCity, 128) || (existing && existing.hotelCity) || null,
            sourceRoomId, sourceRoomName: str(b.sourceRoomName, 255) || (existing && existing.sourceRoomName) || null,
            sourceSnapshot: b.sourceSnapshot && typeof b.sourceSnapshot === 'object' ? b.sourceSnapshot : (existing ? existing.sourceSnapshot : null),
            operatorIds, operatorNames, mealTypes,
            content: c.content, rule, packageTypes: packageTypes.length ? packageTypes : ['hotel'],
            badge: str(b.badge, 64) || (existing ? existing.badge : null) || settings.badge,
            active: b.active === undefined ? (existing ? existing.active : true) : b.active !== false,
            sortOrder: b.sortOrder === undefined ? (existing ? existing.sortOrder : 0) : (Number(b.sortOrder) || 0),
        },
    };
}

function diff(before, after) {
    const out = {};
    const keys = ['operatorIds', 'mealTypes', 'ruleType', 'ruleValue', 'rounding', 'minPrice', 'maxPrice', 'minMarginType', 'minMarginValue', 'badge', 'active', 'sortOrder', 'packageTypes'];
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
    res.json({ room_type: { ...rt, ruleLabel: rt.rule ? ruleLabel(rt.rule) : null } });
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
    await store.logChange(id, staff, { created: true, rule: `${v.value.rule.ruleType} ${v.value.rule.ruleValue}`, operators: v.value.operatorIds });
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
        content: b.copyContent === false && src.sourceSnapshot ? { nameRu: `${src.sourceSnapshot.name_ru || src.content.nameRu} (копия)`, description: src.sourceSnapshot.description, area: src.sourceSnapshot.area, view: src.sourceSnapshot.view, facilities: src.sourceSnapshot.facilities, images: b.images === 'none' ? [] : (src.sourceSnapshot.images || []).map((im) => ({ source: 'lt', url: im.x900 || im.x900x380 || im })) }
            : { ...src.content, nameRu: str(b.name, 255) || `${src.content.nameRu} (копия)`, images: b.images === 'none' ? [] : src.content.images },
        rule: b.copyRule === false ? { ruleType: 'percent', ruleValue: 0 } : { ruleType: src.ruleType, ruleValue: src.ruleValue, rounding: src.rounding, minPrice: src.minPrice, maxPrice: src.maxPrice, minMarginType: src.minMarginType, minMarginValue: src.minMarginValue },
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

/** POST /room-types/preview-price { rule, offers: [{operator_name, meal, price}] } | { providerPrice } — расчёт без сохранения. */
const previewPrice = wrap(async (req, res) => {
    const b = req.body || {};
    const settings = await store.getSettings();
    const rule = normalizeRule(b.rule || b, settings);
    if (rule.error) return fail(res, rule.error);
    const offers = Array.isArray(b.offers) && b.offers.length ? b.offers : (b.providerPrice ? [{ price: b.providerPrice }] : []);
    const rows = offers.map((o) => { const p = finalPrice(o.price, rule); return { operator_name: o.operator_name || null, meal: o.meal || null, provider_price: Number(o.price), final_price: p.final, margin: p.margin, margin_percent: p.marginPercent, margin_clamped: p.marginClamped, floor: p.floor }; });
    res.json({ rule: { ...rule, label: ruleLabel(rule) }, rows });
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

const getSettings = wrap(async (req, res) => { res.json({ settings: await store.getSettings(true) }); });
const putSettings = wrap(async (req, res) => {
    const r = await store.updateSettings(req.body || {});
    if (r && r.error) return fail(res, r.error);
    res.json({ ok: true, settings: r });
});

module.exports = {
    readyGuard, searchHotels, hotelRooms, list, get, create, update, toggle, remove, duplicate, previewPrice, priceLog, changeLog, orders,
    uploadImage, deleteImage, getSettings, putSettings,
    _internal: { validateContent, validateRoomType, diff },
};
