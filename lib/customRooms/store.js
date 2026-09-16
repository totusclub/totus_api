'use strict';

/**
 * Хранилище наших Room Type (MySQL kedam, таблицы — scripts/run-custom-rooms-migration.js).
 * Только доступ к данным; логика цены — pricing.js, витрина — inject.js / packageFlow.js.
 */

const db = require('../../db');
const { normalizeRule, normalizePricing, computePrice } = require('./pricing');

const OFFER_MAP_TTL_H = 3;     // время жизни поиска LT
const PACKAGE_MAP_TTL_H = 24;  // от package_details до оплаты
const SEARCH_TTL_H = 6;
const PRICE_LOG_MIN_INTERVAL_MIN = 60;

let ready = false;
let readyChecked = false;
let lastCheckAt = 0;
const RECHECK_MS = 60 * 1000; // без миграции — не дёргать БД на каждый запрос

const REQUIRED_TABLES = ['custom_room_types', 'custom_room_settings', 'custom_room_price_log', 'custom_room_change_log', 'custom_room_offer_map', 'custom_room_package_map', 'custom_room_searches', 'custom_room_bookings', 'custom_room_booking_events'];
// обязательные колонки по волнам миграции: без них модуль DISABLED целиком
const REQUIRED_COLUMNS = {
    custom_room_package_map: ['package_snapshot', 'hotel_id', 'meal'],                                   // бронирования
    custom_room_types: ['pricing_mode', 'fixed_price', 'fixed_price_unit', 'operator_name', 'operator_id'], // v2
};
// необязательные колонки диагностики (last_skip_reason/last_checked_at): без них модуль работает, причина пропуска не сохраняется
const DIAG_COLUMNS = ['last_skip_reason', 'last_checked_at'];
// необязательные колонки «продавать только наши предложения» (exclusive/exclusive_scope): без них флаг недоступен,
// модуль работает ровно как раньше (обе группы предложений)
const EXCLUSIVE_COLUMNS = ['exclusive', 'exclusive_scope'];

// Состояние последней проверки схемы — для GET /api/admin/rooms/diagnostics
const readyState = { ready: false, checkedAt: null, disabledReason: null, missingTables: [], missingColumns: [], diagColumns: false, exclusiveColumns: false, error: null };
let hasDiagColumns = false;
let hasExclusiveColumns = false;

async function checkSchema() {
    const missingTables = [];
    const missingColumns = [];
    for (const t of REQUIRED_TABLES) {
        try { await db.query(`SELECT 1 FROM ${t} LIMIT 1`); } catch (e) { missingTables.push(t); }
    }
    for (const [table, cols] of Object.entries(REQUIRED_COLUMNS)) {
        if (missingTables.includes(table)) continue;
        const [rows] = await db.query(`SHOW COLUMNS FROM ${table}`);
        const have = new Set(rows.map((c) => c.Field));
        for (const c of cols) if (!have.has(c)) missingColumns.push(`${table}.${c}`);
    }
    let diag = false;
    let exclusive = false;
    if (!missingTables.includes('custom_room_types')) {
        const [rows] = await db.query('SHOW COLUMNS FROM custom_room_types');
        const have = new Set(rows.map((c) => c.Field));
        diag = DIAG_COLUMNS.every((c) => have.has(c));
        if (!diag) for (const c of DIAG_COLUMNS) if (!have.has(c)) missingColumns.push(`custom_room_types.${c} (диагностика, необязательно)`);
        exclusive = EXCLUSIVE_COLUMNS.every((c) => have.has(c));
        if (!exclusive) for (const c of EXCLUSIVE_COLUMNS) if (!have.has(c)) missingColumns.push(`custom_room_types.${c} (exclusive, необязательно)`);
    }
    return { missingTables, missingColumns, diag, exclusive };
}

async function ensureReady() {
    if (readyChecked) return ready;
    readyChecked = true;
    lastCheckAt = Date.now();
    readyState.checkedAt = new Date().toISOString();
    try {
        const s = await checkSchema();
        const requiredMissing = s.missingColumns.filter((c) => !/необязательно/.test(c));
        readyState.missingTables = s.missingTables;
        readyState.missingColumns = s.missingColumns;
        readyState.diagColumns = s.diag;
        hasDiagColumns = s.diag;
        readyState.exclusiveColumns = s.exclusive;
        hasExclusiveColumns = s.exclusive;
        invalidateExclusiveCache();
        readyState.error = null;
        if (s.missingTables.length || requiredMissing.length) {
            ready = false;
            readyState.disabledReason = s.missingTables.length
                ? `tables missing: ${s.missingTables.join(', ')}`
                : `columns missing: ${requiredMissing.join(', ')}`;
            console.error(`[custom-rooms] DISABLED — ${readyState.disabledReason}. Run: node scripts/run-custom-rooms-migration.js && pm2 restart api`);
        } else {
            ready = true;
            readyState.disabledReason = null;
            console.log(`[custom-rooms] ready${s.diag ? '' : ' (diag columns missing — run migration to store last_skip_reason)'}`);
        }
    } catch (e) {
        ready = false;
        readyState.error = e.message;
        readyState.disabledReason = `db error: ${e.message}`;
        console.error(`[custom-rooms] DISABLED — schema check failed (${e.message}). Run: node scripts/run-custom-rooms-migration.js && pm2 restart api`);
    }
    readyState.ready = ready;
    return ready;
}

/** Снимок состояния готовности (для диагностики); force — перепроверить схему прямо сейчас. */
async function getReadyState(force) {
    if (force || !readyChecked) { readyChecked = false; await ensureReady(); }
    return { ...readyState, missingTables: readyState.missingTables.slice(), missingColumns: readyState.missingColumns.slice() };
}

async function isReady() {
    if (ready) return true;
    if (!readyChecked) return ensureReady();
    if (Date.now() - lastCheckAt < RECHECK_MS) return false;
    readyChecked = false;
    return ensureReady();
}

function parseJson(v, fallback = null) {
    if (v === null || v === undefined) return fallback;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch (e) { return fallback; }
}

function iso(d) { return d ? new Date(d).toISOString() : null; }

// ---------------------------------------------------------------------------
// Настройки
// ---------------------------------------------------------------------------
const DEFAULT_SETTINGS = {
    minMarginType: null,     // 'percent' | 'absolute' | null
    minMarginValue: null,
    rounding: 1,
    badge: 'Totus',
    hotelOnly: false,        // v2: показывать при любом типе поиска; true — только при search_type = hotel
};

let settingsCache = { at: 0, value: null };

async function getSettings(force) {
    if (!force && settingsCache.value && Date.now() - settingsCache.at < 30000) return settingsCache.value;
    const out = { ...DEFAULT_SETTINGS };
    try {
        const [rows] = await db.query('SELECT `key`, `value` FROM custom_room_settings');
        for (const r of rows) {
            const v = parseJson(r.value, r.value);
            if (r.key in out) out[r.key] = v;
        }
    } catch (e) { /* таблицы нет — defaults */ }
    settingsCache = { at: Date.now(), value: out };
    return out;
}

async function updateSettings(patch) {
    const cur = await getSettings(true);
    const next = { ...cur };
    const p = patch || {};
    if ('minMarginType' in p) next.minMarginType = ['percent', 'absolute'].includes(p.minMarginType) ? p.minMarginType : null;
    if ('minMarginValue' in p) next.minMarginValue = p.minMarginValue === null || p.minMarginValue === '' ? null : Number(p.minMarginValue);
    if (next.minMarginType && !Number.isFinite(next.minMarginValue)) return { error: 'min_margin_invalid' };
    if (!next.minMarginType) next.minMarginValue = null;
    if ('rounding' in p) next.rounding = [1, 10, 100].includes(Number(p.rounding)) ? Number(p.rounding) : 1;
    if ('badge' in p) next.badge = String(p.badge || 'Totus').slice(0, 64);
    if ('hotelOnly' in p) next.hotelOnly = p.hotelOnly === true || p.hotelOnly === 'true' || p.hotelOnly === 1;
    for (const [k, v] of Object.entries(next)) {
        await db.query('INSERT INTO custom_room_settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)', [k, JSON.stringify(v)]);
    }
    settingsCache = { at: 0, value: null };
    return getSettings(true);
}

// ---------------------------------------------------------------------------
// Room Type
// ---------------------------------------------------------------------------
/** Синтетический id оператора «Arlekino» в терминах LT, если настоящий не задан. */
function syntheticOperatorId(roomTypeId) { return 990000 + Number(roomTypeId); }

function serializeRoomType(row, settings) {
    const rule = row.rule_type === null || row.rule_type === undefined ? { error: 'rule_type_invalid' } : normalizeRule({
        ruleType: row.rule_type, ruleValue: row.rule_value, rounding: row.rounding,
        minPrice: row.min_price, maxPrice: row.max_price,
        minMarginType: row.min_margin_type, minMarginValue: row.min_margin_value,
    }, settings || DEFAULT_SETTINGS);
    // v2: режим цены. Строки до миграции (нет pricing_mode) — rule, если правило есть, иначе fixed
    const pricingMode = row.pricing_mode === 'fixed' || row.pricing_mode === 'rule' ? row.pricing_mode : (rule.error ? 'fixed' : 'rule');
    const fixedPrice = row.fixed_price === null || row.fixed_price === undefined ? null : Number(row.fixed_price);
    const fixedPriceUnit = row.fixed_price_unit === 'per_night' ? 'per_night' : 'total';
    const pricingN = normalizePricing({ mode: pricingMode, fixedPrice, fixedPriceUnit, rule: rule.error ? null : rule });
    const pricing = pricingN.error ? null : pricingN;
    const lastProvider = row.last_provider_price === null || row.last_provider_price === undefined ? null : Number(row.last_provider_price);
    const previewPrice = pricing ? computePrice(lastProvider, null, pricing).final : null;
    return {
        id: Number(row.id),
        hotelId: Number(row.hotel_id),
        hotelName: row.hotel_name || null,
        hotelStars: row.hotel_stars === null ? null : Number(row.hotel_stars),
        hotelCity: row.hotel_city || null,
        sourceRoomId: Number(row.source_room_id),
        sourceRoomName: row.source_room_name || null,
        sourceSnapshot: parseJson(row.source_snapshot),
        operatorIds: parseJson(row.operator_ids, []) || [],
        operatorNames: parseJson(row.operator_names, []) || [],
        mealTypes: parseJson(row.meal_types),
        // v2
        pricingMode,
        fixedPrice,
        fixedPriceUnit,
        operatorName: row.operator_name || 'Arlekino',
        operatorId: row.operator_id === null || row.operator_id === undefined ? null : Number(row.operator_id),
        effectiveOperatorId: row.operator_id === null || row.operator_id === undefined ? syntheticOperatorId(row.id) : Number(row.operator_id),
        pricing,
        previewPrice,
        content: {
            nameRu: row.name_ru, nameEn: row.name_en || null, accommodation: row.accommodation || null,
            area: row.area === null ? null : Number(row.area), view: row.view || null, description: row.description || null,
            facilities: parseJson(row.facilities, []), images: parseJson(row.images, []),
        },
        rule: rule.error ? null : rule,
        ruleType: row.rule_type || null, ruleValue: row.rule_value === null || row.rule_value === undefined ? null : Number(row.rule_value), rounding: Number(row.rounding || 1),
        minPrice: row.min_price === null ? null : Number(row.min_price),
        maxPrice: row.max_price === null ? null : Number(row.max_price),
        minMarginType: row.min_margin_type || null,
        minMarginValue: row.min_margin_value === null ? null : Number(row.min_margin_value),
        packageTypes: parseJson(row.package_types, []) || [],
        // «продавать только наши предложения»: по умолчанию выключено — поведение витрины не меняется
        exclusive: Number(row.exclusive || 0) === 1,
        exclusiveScope: row.exclusive_scope === 'hotel' ? 'hotel' : 'room',
        badge: row.badge || null,
        active: Number(row.active) === 1,
        sortOrder: Number(row.sort_order || 0),
        last: {
            providerPrice: row.last_provider_price === null ? null : Number(row.last_provider_price),
            finalPrice: row.last_final_price === null ? null : Number(row.last_final_price),
            operator: row.last_operator || null,
            seenAt: iso(row.last_seen_at),
            marginClamped: Number(row.last_margin_clamped || 0) === 1,
            skipReason: row.last_skip_reason || null,
            checkedAt: iso(row.last_checked_at),
        },
        // диагностика: причина, по которой комната не была вставлена в последний ответ /hotels-rooms этого отеля
        // (null — вставлена или ещё не проверялась; см. lastCheckedAt)
        lastSkipReason: row.last_skip_reason || null,
        lastCheckedAt: iso(row.last_checked_at),
        ordersCount: row.orders_count === undefined ? undefined : Number(row.orders_count || 0),
        createdBy: row.created_by || null,
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
    };
}

const RT_SELECT = `SELECT r.*, (SELECT COUNT(*) FROM orders o WHERE o.custom_room_type_id = r.id) AS orders_count FROM custom_room_types r`;

async function listRoomTypes(opts = {}) {
    const where = [];
    const args = [];
    if (opts.hotelId) { where.push('r.hotel_id = ?'); args.push(Number(opts.hotelId)); }
    if (opts.active === true) where.push('r.active = 1');
    if (opts.active === false) where.push('r.active = 0');
    if (opts.q) { const q = `%${String(opts.q).slice(0, 64)}%`; where.push('(r.name_ru LIKE ? OR r.hotel_name LIKE ? OR r.source_room_name LIKE ?)'); args.push(q, q, q); }
    const [rows] = await db.query(`${RT_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY r.hotel_name, r.sort_order, r.id LIMIT 500`, args);
    const settings = await getSettings();
    return rows.map((r) => serializeRoomType(r, settings));
}

/**
 * Активные Room Type отеля — для витрины (без orders_count, быстро). v2: операторы/питание не требуются — только номер.
 * Строки без корректного режима цены (pricing === null) НЕ отфильтровываются здесь: inject.js пропускает их
 * с причиной `no_pricing`, чтобы это было видно в диагностике.
 */
async function activeRoomTypesForHotel(hotelId) {
    const [rows] = await db.query('SELECT * FROM custom_room_types WHERE hotel_id = ? AND active = 1 ORDER BY sort_order, id', [Number(hotelId)]);
    const settings = await getSettings();
    return rows.map((r) => serializeRoomType(r, settings));
}

/** Все активные Room Type (все отели) — для GET /api/admin/rooms/diagnostics. */
async function listActiveRoomTypes() {
    const [rows] = await db.query('SELECT * FROM custom_room_types WHERE active = 1 ORDER BY hotel_id, sort_order, id LIMIT 500');
    const settings = await getSettings();
    return rows.map((r) => serializeRoomType(r, settings));
}

async function getRoomType(id) {
    const [rows] = await db.query(`${RT_SELECT} WHERE r.id = ? LIMIT 1`, [Number(id)]);
    if (!rows.length) return null;
    return serializeRoomType(rows[0], await getSettings());
}

function rowFromInput(v) {
    const rule = v.rule || null;
    const pricing = v.pricing || {};
    const vals = [
        v.hotelId, v.hotelName, v.hotelStars, v.hotelCity, v.sourceRoomId, v.sourceRoomName,
        v.sourceSnapshot ? JSON.stringify(v.sourceSnapshot) : null,
        JSON.stringify(v.operatorIds || []), JSON.stringify(v.operatorNames || []), v.mealTypes && v.mealTypes.length ? JSON.stringify(v.mealTypes) : null,
        v.content.nameRu, v.content.nameEn, v.content.accommodation, v.content.area, v.content.view, v.content.description,
        JSON.stringify(v.content.facilities || []), JSON.stringify(v.content.images || []),
        rule ? rule.ruleType : null, rule ? rule.ruleValue : null, rule ? rule.rounding : 1, rule ? rule.minPrice : null, rule ? rule.maxPrice : null,
        rule && rule.ownMargin ? rule.minMarginType : null, rule && rule.ownMargin ? rule.minMarginValue : null,
        JSON.stringify(v.packageTypes || []), v.badge, v.active ? 1 : 0, v.sortOrder || 0,
        pricing.mode === 'rule' ? 'rule' : 'fixed', pricing.fixedPrice === undefined ? null : pricing.fixedPrice, pricing.fixedPriceUnit === 'per_night' ? 'per_night' : 'total',
        v.operatorName ? String(v.operatorName).slice(0, 128) : 'Arlekino', v.operatorId === undefined || v.operatorId === null ? null : Number(v.operatorId),
    ];
    if (hasExclusiveColumns) vals.push(v.exclusive ? 1 : 0, v.exclusiveScope === 'hotel' ? 'hotel' : 'room');
    return vals;
}

/** Список колонок INSERT/UPDATE: exclusive добавляется только если миграция прошла. */
function rtCols() { return hasExclusiveColumns ? `${RT_COLS}, exclusive, exclusive_scope` : RT_COLS; }

const RT_COLS = `hotel_id, hotel_name, hotel_stars, hotel_city, source_room_id, source_room_name, source_snapshot,
    operator_ids, operator_names, meal_types, name_ru, name_en, accommodation, area, view, description, facilities, images,
    rule_type, rule_value, rounding, min_price, max_price, min_margin_type, min_margin_value, package_types, badge, active, sort_order,
    pricing_mode, fixed_price, fixed_price_unit, operator_name, operator_id`;

async function createRoomType(v, staffName) {
    const vals = rowFromInput(v);
    const [r] = await db.query(
        `INSERT INTO custom_room_types (${rtCols()}, created_by) VALUES (${vals.map(() => '?').join(', ')}, ?)`,
        [...vals, staffName || null],
    );
    invalidateExclusiveCache();
    return r.insertId;
}

async function updateRoomType(id, v) {
    const vals = rowFromInput(v);
    const sets = rtCols().split(',').map((c) => `${c.trim()} = ?`).join(', ');
    await db.query(`UPDATE custom_room_types SET ${sets} WHERE id = ?`, [...vals, Number(id)]);
    invalidateExclusiveCache();
}

async function setActive(id, active) {
    await db.query('UPDATE custom_room_types SET active = ? WHERE id = ?', [active ? 1 : 0, Number(id)]);
    invalidateExclusiveCache();
}

async function deleteRoomType(id) {
    const [r] = await db.query('DELETE FROM custom_room_types WHERE id = ?', [Number(id)]);
    invalidateExclusiveCache();
    return r.affectedRows > 0;
}

async function touchLastSeen(id, { providerPrice, finalPrice, operator, marginClamped }) {
    // вставлена → причина пропуска сбрасывается (если колонки диагностики есть)
    const diag = hasDiagColumns ? ', last_skip_reason = NULL, last_checked_at = NOW()' : '';
    await db.query(
        `UPDATE custom_room_types SET last_provider_price = ?, last_final_price = ?, last_operator = ?, last_margin_clamped = ?, last_seen_at = NOW()${diag} WHERE id = ?`,
        [providerPrice, finalPrice, operator ? String(operator).slice(0, 128) : null, marginClamped ? 1 : 0, Number(id)],
    );
}

/** Диагностика: комната проверена в ответе /hotels-rooms и пропущена по причине reason (см. inject.js). Без колонок — no-op. */
async function markChecked(id, reason) {
    if (!hasDiagColumns) return false;
    await db.query('UPDATE custom_room_types SET last_skip_reason = ?, last_checked_at = NOW() WHERE id = ?', [reason ? String(reason).slice(0, 255) : null, Number(id)]);
    return true;
}

// ---------------------------------------------------------------------------
// Логи
// ---------------------------------------------------------------------------
async function logChange(roomTypeId, staff, changes) {
    try {
        await db.query('INSERT INTO custom_room_change_log (room_type_id, staff_id, staff_name, changes) VALUES (?, ?, ?, ?)',
            [Number(roomTypeId), staff && staff.id ? Number(staff.id) : null, staff && staff.name ? String(staff.name).slice(0, 128) : null, JSON.stringify(changes || {})]);
    } catch (e) { console.warn('[custom-rooms] change log failed:', e.message); }
}

async function listChanges(roomTypeId, limit = 50) {
    const [rows] = await db.query('SELECT * FROM custom_room_change_log WHERE room_type_id = ? ORDER BY id DESC LIMIT ?', [Number(roomTypeId), Math.min(Number(limit) || 50, 200)]);
    return rows.map((r) => ({ id: Number(r.id), staffId: r.staff_id === null ? null : Number(r.staff_id), staffName: r.staff_name || null, changes: parseJson(r.changes, {}), createdAt: iso(r.created_at) }));
}

/** История цен: не чаще одной записи на (комната, оператор, питание) в час. */
async function logPrice(entry) {
    try {
        const [rows] = await db.query(
            'SELECT id, seen_at, provider_price FROM custom_room_price_log WHERE room_type_id = ? AND operator_id <=> ? AND meal <=> ? ORDER BY id DESC LIMIT 1',
            [entry.roomTypeId, entry.operatorId === undefined ? null : entry.operatorId, entry.meal || null],
        );
        if (rows.length) {
            const ageMin = (Date.now() - new Date(rows[0].seen_at).getTime()) / 60000;
            if (ageMin < PRICE_LOG_MIN_INTERVAL_MIN && Number(rows[0].provider_price) === Number(entry.providerPrice)) return;
        }
        await db.query(
            `INSERT INTO custom_room_price_log (room_type_id, request_id, source_offer_id, operator_id, operator_name, meal, provider_price, final_price, rule_snapshot, margin_clamped)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [entry.roomTypeId, entry.requestId || null, entry.sourceOfferId ? String(entry.sourceOfferId).slice(0, 64) : null,
                entry.operatorId === undefined ? null : entry.operatorId, entry.operatorName ? String(entry.operatorName).slice(0, 128) : null,
                entry.meal || null, entry.providerPrice, entry.finalPrice, JSON.stringify(entry.rule || {}), entry.marginClamped ? 1 : 0],
        );
    } catch (e) { console.warn('[custom-rooms] price log failed:', e.message); }
}

async function listPriceLog(roomTypeId, opts = {}) {
    const where = ['room_type_id = ?'];
    const args = [Number(roomTypeId)];
    if (opts.from) { where.push('seen_at >= ?'); args.push(new Date(opts.from)); }
    if (opts.to) { where.push('seen_at <= ?'); args.push(new Date(opts.to)); }
    if (opts.operatorId) { where.push('operator_id = ?'); args.push(Number(opts.operatorId)); }
    if (opts.meal) { where.push('meal = ?'); args.push(String(opts.meal)); }
    const [rows] = await db.query(`SELECT * FROM custom_room_price_log WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`, [...args, Math.min(Number(opts.limit) || 200, 1000)]);
    return rows.map((r) => ({
        id: Number(r.id), requestId: r.request_id, sourceOfferId: r.source_offer_id, operatorId: r.operator_id === null ? null : Number(r.operator_id),
        operatorName: r.operator_name, meal: r.meal, providerPrice: Number(r.provider_price), finalPrice: Number(r.final_price),
        margin: Number(r.final_price) - Number(r.provider_price), rule: parseJson(r.rule_snapshot, {}), marginClamped: Number(r.margin_clamped) === 1, seenAt: iso(r.seen_at),
    }));
}

// ---------------------------------------------------------------------------
// Карты поиска / предложений / пакетов (короткоживущие)
// ---------------------------------------------------------------------------
async function rememberSearch(requestId, searchType, params) {
    if (!requestId) return;
    try {
        await db.query(
            'INSERT INTO custom_room_searches (request_id, search_type, params, expires_at) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? HOUR)) ON DUPLICATE KEY UPDATE search_type = VALUES(search_type), params = VALUES(params), expires_at = VALUES(expires_at)',
            [String(requestId).slice(0, 64), String(searchType || '').slice(0, 16), JSON.stringify(params || {}), SEARCH_TTL_H],
        );
    } catch (e) { console.warn('[custom-rooms] rememberSearch failed:', e.message); }
}

async function getSearch(requestId) {
    if (!requestId) return null;
    const [rows] = await db.query('SELECT * FROM custom_room_searches WHERE request_id = ? LIMIT 1', [String(requestId).slice(0, 64)]);
    if (!rows.length) return null;
    return { requestId: rows[0].request_id, searchType: rows[0].search_type, params: parseJson(rows[0].params, {}) };
}

async function saveOfferMap(entries) {
    if (!entries.length) return;
    // request_id/source_offer_id — VARCHAR(64): режем, чтобы слишком длинный id LT не ронял вставку (и всю подмену ответа)
    const values = entries.map((e) => [String(e.virtualOfferId).slice(0, 64), e.roomTypeId, e.requestId ? String(e.requestId).slice(0, 64) : null, String(e.sourceOfferId).slice(0, 64), e.operatorId === undefined ? null : e.operatorId, e.meal ? String(e.meal).slice(0, 16) : null, e.providerPrice, e.finalPrice]);
    await db.query(
        `INSERT INTO custom_room_offer_map (virtual_offer_id, room_type_id, request_id, source_offer_id, operator_id, meal, provider_price, final_price, expires_at)
         VALUES ${values.map(() => `(?, ?, ?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ${OFFER_MAP_TTL_H} HOUR))`).join(', ')}
         ON DUPLICATE KEY UPDATE provider_price = VALUES(provider_price), final_price = VALUES(final_price), expires_at = VALUES(expires_at)`,
        values.flat(),
    );
}

async function getOffer(virtualOfferId) {
    const [rows] = await db.query('SELECT * FROM custom_room_offer_map WHERE virtual_offer_id = ? AND expires_at > NOW() LIMIT 1', [String(virtualOfferId)]);
    if (!rows.length) return null;
    const r = rows[0];
    return { virtualOfferId: r.virtual_offer_id, roomTypeId: Number(r.room_type_id), requestId: r.request_id, sourceOfferId: r.source_offer_id, operatorId: r.operator_id === null ? null : Number(r.operator_id), meal: r.meal, providerPrice: Number(r.provider_price), finalPrice: Number(r.final_price) };
}

async function savePackageMap(entry) {
    await db.query(
        `INSERT INTO custom_room_package_map (lt_package_id, room_type_id, virtual_offer_id, source_offer_id, operator_name, provider_price, final_price, rule_snapshot, hotel_id, meal, package_snapshot, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ${PACKAGE_MAP_TTL_H} HOUR))
         ON DUPLICATE KEY UPDATE room_type_id = VALUES(room_type_id), virtual_offer_id = VALUES(virtual_offer_id), provider_price = VALUES(provider_price), final_price = VALUES(final_price), rule_snapshot = VALUES(rule_snapshot),
             hotel_id = COALESCE(VALUES(hotel_id), hotel_id), meal = COALESCE(VALUES(meal), meal), package_snapshot = COALESCE(VALUES(package_snapshot), package_snapshot), expires_at = VALUES(expires_at)`,
        [String(entry.ltPackageId).slice(0, 64), entry.roomTypeId, entry.virtualOfferId || null, entry.sourceOfferId ? String(entry.sourceOfferId) : null, entry.operatorName ? String(entry.operatorName).slice(0, 128) : null, entry.providerPrice, entry.finalPrice, JSON.stringify(entry.rule || {}),
            entry.hotelId ? Number(entry.hotelId) : null, entry.meal ? String(entry.meal).slice(0, 16) : null, entry.snapshot ? JSON.stringify(entry.snapshot) : null],
    );
}

async function getPackage(ltPackageId) {
    if (ltPackageId === undefined || ltPackageId === null || ltPackageId === '') return null;
    const [rows] = await db.query('SELECT * FROM custom_room_package_map WHERE lt_package_id = ? AND expires_at > NOW() LIMIT 1', [String(ltPackageId).slice(0, 64)]);
    if (!rows.length) return null;
    const r = rows[0];
    return {
        ltPackageId: r.lt_package_id, roomTypeId: Number(r.room_type_id), virtualOfferId: r.virtual_offer_id, sourceOfferId: r.source_offer_id, operatorName: r.operator_name,
        providerPrice: Number(r.provider_price), finalPrice: Number(r.final_price), rule: parseJson(r.rule_snapshot, {}),
        hotelId: r.hotel_id === null || r.hotel_id === undefined ? null : Number(r.hotel_id), meal: r.meal || null, snapshot: parseJson(r.package_snapshot),
    };
}

async function updatePackagePrices(ltPackageId, providerPrice, finalPrice) {
    await db.query('UPDATE custom_room_package_map SET provider_price = ?, final_price = ? WHERE lt_package_id = ?', [providerPrice, finalPrice, String(ltPackageId).slice(0, 64)]);
}

/** Снимок пакета (переписанный ответ package_details/actualize) — из него собирается заказ без LT. */
async function savePackageSnapshot(ltPackageId, snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    await db.query('UPDATE custom_room_package_map SET package_snapshot = ? WHERE lt_package_id = ?', [JSON.stringify(snapshot), String(ltPackageId).slice(0, 64)]);
}

// ---------------------------------------------------------------------------
// Заказы
// ---------------------------------------------------------------------------
async function markOrder(orderId, m) {
    await db.query('UPDATE orders SET custom_room_type_id = ?, provider_price = ?, final_price = ?, price_rule = ? WHERE order_id = ?',
        [m.roomTypeId, m.providerPrice, m.finalPrice, JSON.stringify(m.rule || {}), String(orderId)]);
}

async function getOrderMark(orderId) {
    if (!orderId) return null;
    try {
        const [rows] = await db.query('SELECT custom_room_type_id, provider_price, final_price, price_rule FROM orders WHERE order_id = ? LIMIT 1', [String(orderId)]);
        if (!rows.length || !rows[0].custom_room_type_id) return null;
        return { roomTypeId: Number(rows[0].custom_room_type_id), providerPrice: Number(rows[0].provider_price), finalPrice: Number(rows[0].final_price), rule: parseJson(rows[0].price_rule, {}) };
    } catch (e) { return null; }
}

async function getOrderMarks(orderIds) {
    const ids = [...new Set((orderIds || []).map(String).filter(Boolean))];
    if (!ids.length) return new Map();
    try {
        const [rows] = await db.query('SELECT order_id, custom_room_type_id, provider_price, final_price FROM orders WHERE order_id IN (?) AND custom_room_type_id IS NOT NULL', [ids]);
        return new Map(rows.map((r) => [String(r.order_id), { roomTypeId: Number(r.custom_room_type_id), providerPrice: Number(r.provider_price), finalPrice: Number(r.final_price) }]));
    } catch (e) { return new Map(); }
}

async function listOrdersForRoomType(roomTypeId, limit = 50) {
    const [rows] = await db.query('SELECT order_id, user_id, pay_status, order_state, provider_price, final_price, price_rule FROM orders WHERE custom_room_type_id = ? ORDER BY order_id DESC LIMIT ?', [Number(roomTypeId), Math.min(Number(limit) || 50, 200)]);
    return rows.map((r) => ({ orderId: String(r.order_id), userId: r.user_id === null ? null : Number(r.user_id), payStatus: r.pay_status || null, orderState: r.order_state || null, providerPrice: Number(r.provider_price), finalPrice: Number(r.final_price), rule: parseJson(r.price_rule, {}) }));
}

// ---------------------------------------------------------------------------
// Exclusive — «продавать только наши предложения» (флаг Room Type, по умолчанию выключен)
// ---------------------------------------------------------------------------
const EXCLUSIVE_CACHE_MS = 60 * 1000;
let exclusiveCache = null;
let exclusiveCacheAt = 0;

/** Пустой свод: exclusive выключен. */
function emptyExclusive() { return { rooms: new Set(), wholeHotel: false }; }

/** Свод по уже загруженным Room Type отеля (serializeRoomType) — без единого запроса в БД. */
function exclusiveFromRoomTypes(rts) {
    const out = emptyExclusive();
    for (const rt of rts || []) {
        if (!rt || rt.exclusive !== true || rt.active === false) continue;
        if (rt.exclusiveScope === 'hotel') out.wholeHotel = true;
        else out.rooms.add(Number(rt.sourceRoomId));
    }
    return out;
}

/**
 * hotelId → { rooms:Set<sourceRoomId>, wholeHotel } по всем активным Room Type с exclusive = 1.
 * Кэш 60 с + сброс на любое изменение Room Type. Нет колонок миграции → пустая карта без запросов.
 */
async function exclusiveMap(force) {
    if (!force && exclusiveCache && Date.now() - exclusiveCacheAt < EXCLUSIVE_CACHE_MS) return exclusiveCache;
    const map = new Map();
    if (hasExclusiveColumns) {
        try {
            const [rows] = await db.query('SELECT hotel_id, source_room_id, exclusive_scope FROM custom_room_types WHERE active = 1 AND exclusive = 1');
            for (const r of rows || []) {
                const hid = Number(r.hotel_id);
                if (!map.has(hid)) map.set(hid, emptyExclusive());
                const e = map.get(hid);
                if (String(r.exclusive_scope) === 'hotel') e.wholeHotel = true;
                else e.rooms.add(Number(r.source_room_id));
            }
        } catch (e) { /* колонок нет или БД недоступна — считаем, что exclusive выключен */ }
    }
    exclusiveCache = map;
    exclusiveCacheAt = Date.now();
    return map;
}

/** Свод exclusive одного отеля. Отеля нет в карте → { rooms: пусто, wholeHotel: false } (обычный отель). */
async function exclusiveFor(hotelId) {
    const map = await exclusiveMap();
    return map.get(Number(hotelId)) || emptyExclusive();
}

function invalidateExclusiveCache() { exclusiveCache = null; exclusiveCacheAt = 0; }

async function cleanup() {
    try {
        await db.query('DELETE FROM custom_room_offer_map WHERE expires_at < NOW()');
        await db.query('DELETE FROM custom_room_package_map WHERE expires_at < NOW()');
        await db.query('DELETE FROM custom_room_searches WHERE expires_at < NOW()');
    } catch (e) { /* ignore */ }
}

module.exports = {
    ensureReady, isReady, getReadyState, checkSchema, parseJson,
    DEFAULT_SETTINGS, getSettings, updateSettings,
    serializeRoomType, syntheticOperatorId, listRoomTypes, activeRoomTypesForHotel, listActiveRoomTypes, getRoomType, createRoomType, updateRoomType, setActive, deleteRoomType, touchLastSeen, markChecked,
    logChange, listChanges, logPrice, listPriceLog,
    rememberSearch, getSearch, saveOfferMap, getOffer, savePackageMap, getPackage, updatePackagePrices, savePackageSnapshot,
    markOrder, getOrderMark, getOrderMarks, listOrdersForRoomType, cleanup,
    exclusiveFromRoomTypes, exclusiveMap, exclusiveFor, invalidateExclusiveCache,
};
