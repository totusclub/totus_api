'use strict';
// Поставщик для агентского чека — туроператор КОНКРЕТНОГО заказа Level.Travel (решение владельца 05.11.2026).
//
// Откуда реквизиты: Level.Travel в ответе на создание заказа (/orders/create → orders.package) отдаёт юрлицо
// туроператора этого тура — `operator_organization: { name, inn, phone }` (и в `package.operator_organization`).
// Номер туроператора (operator.id) — это бренд, а не юрлицо: у одного бренда бывают разные юрлица
// (у «своего» оператора Level.Travel №78 юрлицо подбирается под каждый пакет). Поэтому таблицы
// «номер туроператора → ИНН» нет и общего поставщика для всех туров нет.
//
// Как работает:
//   1. /create-package: сразу после записи заказа реквизиты из ответа Level.Travel сохраняются в order_suppliers
//      (снимок на момент продажи; первая запись не перезаписывается — вебхуки могут переписать orders.package).
//   2. Оплата подтверждена: чек пробивается ТОЛЬКО по снимку этого заказа. Снимка нет (заказ до выкладки) —
//      он делается из orders.package этого же заказа. Реквизитов нет / неверные / туроператор заказа не тот,
//      что в снимке — чек НЕ пробивается, причина пишется в fiscal_blocked и видна в /api/admin/fiscal.
//
// Номера Arlekino сюда не относятся (свой продукт, поставщик — FERMA_SUPPLIERS.arlekino).

const R = require('./receipt');

const SUPPLIERS_SQL = `
    CREATE TABLE IF NOT EXISTS order_suppliers (
      order_id VARCHAR(32) NOT NULL PRIMARY KEY,
      source VARCHAR(16) NOT NULL,
      operator_id VARCHAR(32) NULL,
      operator_name VARCHAR(128) NULL,
      supplier_inn VARCHAR(12) NULL,
      supplier_name VARCHAR(256) NULL,
      supplier_phone VARCHAR(20) NULL,
      status VARCHAR(16) NOT NULL,
      problems VARCHAR(255) NULL,
      origin VARCHAR(32) NOT NULL,
      raw_json TEXT NULL,
      captured_at DATETIME NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_status (status),
      KEY idx_operator (operator_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

const BLOCKED_SQL = `
    CREATE TABLE IF NOT EXISTS fiscal_blocked (
      id INT AUTO_INCREMENT PRIMARY KEY,
      order_id VARCHAR(32) NOT NULL,
      kind VARCHAR(16) NOT NULL,
      mode VARCHAR(8) NOT NULL,
      source VARCHAR(16) NULL,
      reason VARCHAR(64) NOT NULL,
      message VARCHAR(500) NOT NULL,
      via VARCHAR(32) NULL,
      amount_kop BIGINT NULL,
      attempts INT NOT NULL DEFAULT 1,
      first_at DATETIME NOT NULL,
      last_at DATETIME NOT NULL,
      resolved_at DATETIME NULL,
      receipt_id INT NULL,
      UNIQUE KEY uq_order_kind_mode (order_id, kind, mode),
      KEY idx_open (resolved_at, last_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

const STATUSES = ['ok', 'missing', 'invalid'];

// ---------------------------------------------------------------------------
// Разбор заказа Level.Travel
// ---------------------------------------------------------------------------

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const idOf = (v) => (v !== undefined && v !== null && /^[A-Za-z0-9_-]{1,32}$/.test(String(v)) ? String(v) : null);

/** Туроператор заказа (бренд): { id, name }. Источник — package.operator, затем запасные поля. */
function extractOperator(orderData) {
    const o = obj(orderData) || {};
    const pkg = obj(o.package) || {};
    const op = obj(pkg.operator) || obj(o.operator) || obj(pkg.tour_operator) || obj(o.tour_operator) || {};
    const id = idOf(op.id) || idOf(pkg.operator_id) || idOf(o.operator_id);
    const tourPrefix = /^(\d{1,4})-/.exec(String(pkg.tour_id || o.tour_id || ''));
    return {
        id: id || (tourPrefix ? String(Number(tourPrefix[1])) : null),
        name: op.name ? R.sanitizeText(op.name).slice(0, 128) : null,
    };
}

/** Юрлицо туроператора из ответа Level.Travel: { raw, conflict }. */
function extractOrganization(orderData) {
    const o = obj(orderData) || {};
    const pkg = obj(o.package) || {};
    const top = obj(o.operator_organization);
    const inner = obj(pkg.operator_organization);
    const innOf = (x) => String((x && x.inn) || '').replace(/\D/g, '');
    const conflict = Boolean(top && inner && innOf(top) && innOf(inner) && innOf(top) !== innOf(inner));
    return { raw: top || inner || null, conflict };
}

/**
 * Наименование для тега 1225: без лишних пробелов, кавычки — прямые двойные (касса портит «»),
 * без пробелов сразу внутри кавычек: «ООО 'Анекс Туризм '» → «ООО "Анекс Туризм"».
 */
function normalizeSupplierName(value) {
    let s = R.sanitizeText(value).replace(/'/g, '"');
    s = s.replace(/"\s*([^"]*?)\s*"/g, '"$1"');
    return s.replace(/\s+/g, ' ').trim();
}

/**
 * Снимок поставщика заказа из данных Level.Travel.
 * status: ok — можно пробивать; missing — Level.Travel реквизитов не прислал; invalid — прислал, но с ошибкой.
 */
function buildSnapshot(orderId, orderData, origin) {
    const operator = extractOperator(orderData);
    const { raw, conflict } = extractOrganization(orderData);
    const snap = {
        order_id: String(orderId),
        source: 'lt',
        operator_id: operator.id,
        operator_name: operator.name,
        supplier_inn: null,
        supplier_name: null,
        supplier_phone: null,
        status: 'missing',
        problems: [],
        origin,
        raw_json: raw ? JSON.stringify({ name: raw.name ?? null, inn: raw.inn ?? null, phone: raw.phone ?? null }) : null,
    };
    if (!raw) {
        snap.problems.push('organization_missing');
        return snap;
    }
    const inn = String(raw.inn == null ? '' : raw.inn).replace(/\s/g, '');
    const name = normalizeSupplierName(raw.name);
    const phone = R.normalizePhone(raw.phone);
    if (!inn) snap.problems.push('inn_missing');
    else if (!R.isValidInn(inn)) snap.problems.push('inn_invalid');
    if (!name) snap.problems.push('name_missing');
    else if (name.length > 256) snap.problems.push('name_too_long');
    if (!raw.phone) snap.problems.push('phone_missing');
    else if (!phone) snap.problems.push('phone_invalid');
    if (conflict) snap.problems.push('organization_conflict');
    snap.supplier_inn = inn ? inn.slice(0, 12) : null;
    snap.supplier_name = name ? name.slice(0, 256) : null;
    snap.supplier_phone = phone;
    snap.status = snap.problems.length ? 'invalid' : 'ok';
    return snap;
}

const PROBLEM_TEXT = {
    organization_missing: 'Level.Travel не передал реквизиты туроператора (operator_organization)',
    inn_missing: 'нет ИНН туроператора',
    inn_invalid: 'ИНН туроператора не проходит проверку контрольных цифр',
    name_missing: 'нет наименования туроператора',
    name_too_long: 'наименование туроператора длиннее 256 символов',
    phone_missing: 'нет телефона туроператора',
    phone_invalid: 'телефон туроператора не распознан',
    organization_conflict: 'в заказе два разных юрлица туроператора (operator_organization и package.operator_organization)',
};

function operatorLabel(snap) {
    if (!snap) return 'туроператор';
    const name = snap.operator_name ? `«${snap.operator_name}»` : '';
    const id = snap.operator_id ? `id ${snap.operator_id}` : 'id неизвестен';
    return `туроператор ${name ? `${name} ` : ''}(${id})`;
}

/** Понятный текст причины для лога и админки (без персональных данных покупателя). */
function describeSnapshot(snap) {
    if (!snap) return 'реквизиты туроператора не найдены';
    const parts = (Array.isArray(snap.problems) ? snap.problems : String(snap.problems || '').split(',').filter(Boolean))
        .map((p) => PROBLEM_TEXT[p] || p);
    const what = snap.supplier_inn ? `, ИНН ${snap.supplier_inn}` : '';
    return `Заказ ${snap.order_id}: ${operatorLabel(snap)}${what} — ${parts.join('; ') || 'реквизиты некорректны'}. Чек не пробит`;
}

// ---------------------------------------------------------------------------
// Хранилища (MySQL и память для проверок) — один интерфейс
// ---------------------------------------------------------------------------

const toRow = (snap, capturedAt) => ({
    ...snap,
    problems: (snap.problems || []).join(',') || null,
    captured_at: capturedAt,
});
const fromRow = (row) => (row ? { ...row, problems: String(row.problems || '').split(',').filter(Boolean) } : null);

function createMysqlSupplierStore(db) {
    let ready = null;
    const ensure = () => {
        if (!ready) ready = db.query(SUPPLIERS_SQL).catch((e) => { ready = null; throw e; });
        return ready;
    };
    return {
        kind: 'mysql',
        ensure,
        async get(orderId) {
            await ensure();
            const [rows] = await db.query('SELECT * FROM order_suppliers WHERE order_id = ? LIMIT 1', [String(orderId)]);
            return fromRow(rows[0] || null);
        },
        /** Первая запись побеждает: снимок на момент продажи не перезаписывается. true — записали. */
        async insertIfAbsent(snap, now = new Date()) {
            await ensure();
            const r = toRow(snap, now);
            const cols = ['order_id', 'source', 'operator_id', 'operator_name', 'supplier_inn', 'supplier_name', 'supplier_phone',
                'status', 'problems', 'origin', 'raw_json', 'captured_at'];
            const [res] = await db.query(
                `INSERT IGNORE INTO order_suppliers (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
                cols.map((c) => r[c] === undefined ? null : r[c]),
            );
            return Boolean(res && res.affectedRows);
        },
        /** Заменить снимок без реквизитов (missing / invalid) на исправный из этого же заказа. true — заменили. */
        async upgrade(snap, now = new Date()) {
            await ensure();
            const r = toRow(snap, now);
            const cols = ['operator_id', 'operator_name', 'supplier_inn', 'supplier_name', 'supplier_phone', 'status', 'problems', 'origin', 'raw_json', 'captured_at'];
            const [res] = await db.query(
                `UPDATE order_suppliers SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE order_id = ? AND status <> 'ok'`,
                [...cols.map((c) => r[c] === undefined ? null : r[c]), String(snap.order_id)],
            );
            return Boolean(res && res.affectedRows);
        },
        async list({ status, operatorId, limit = 50, offset = 0 } = {}) {
            await ensure();
            const where = [];
            const params = [];
            if (status) { where.push('status = ?'); params.push(status); }
            if (operatorId) { where.push('operator_id = ?'); params.push(String(operatorId)); }
            const w = where.length ? ` WHERE ${where.join(' AND ')}` : '';
            const [rows] = await db.query(`SELECT * FROM order_suppliers${w} ORDER BY captured_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
            const [[{ total }]] = await db.query(`SELECT COUNT(*) AS total FROM order_suppliers${w}`, params);
            return { rows: rows.map(fromRow), total: Number(total) || 0 };
        },
    };
}

function createMemorySupplierStore() {
    const rows = [];
    return {
        kind: 'memory',
        rows,
        async ensure() {},
        async get(orderId) {
            const r = rows.find((x) => x.order_id === String(orderId));
            return r ? fromRow({ ...r }) : null;
        },
        async insertIfAbsent(snap, now = new Date()) {
            if (rows.some((r) => r.order_id === String(snap.order_id))) return false;
            rows.push(toRow(snap, now));
            return true;
        },
        async upgrade(snap, now = new Date()) {
            const r = rows.find((x) => x.order_id === String(snap.order_id));
            if (!r || r.status === 'ok') return false;
            Object.assign(r, toRow(snap, now));
            return true;
        },
        async list({ status, operatorId, limit = 50, offset = 0 } = {}) {
            const m = rows.filter((r) => (!status || r.status === status) && (!operatorId || r.operator_id === String(operatorId)));
            return { rows: m.slice().reverse().slice(offset, offset + limit).map((r) => fromRow({ ...r })), total: m.length };
        },
    };
}

function createMysqlBlockedStore(db) {
    let ready = null;
    const ensure = () => {
        if (!ready) ready = db.query(BLOCKED_SQL).catch((e) => { ready = null; throw e; });
        return ready;
    };
    return {
        kind: 'mysql',
        ensure,
        async record({ orderId, kind = 'income', mode, source, reason, message, via, amountKop }, now = new Date()) {
            await ensure();
            await db.query(
                `INSERT INTO fiscal_blocked (order_id, kind, mode, source, reason, message, via, amount_kop, attempts, first_at, last_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
                 ON DUPLICATE KEY UPDATE source = VALUES(source), reason = VALUES(reason), message = VALUES(message),
                   via = VALUES(via), amount_kop = COALESCE(VALUES(amount_kop), amount_kop), attempts = attempts + 1,
                   last_at = VALUES(last_at), resolved_at = NULL, receipt_id = NULL`,
                [String(orderId), kind, mode, source || null, String(reason).slice(0, 64), String(message).slice(0, 500),
                    via || null, amountKop || null, now, now],
            );
        },
        async resolve({ orderId, kind = 'income', mode, receiptId }, now = new Date()) {
            await ensure();
            await db.query(
                'UPDATE fiscal_blocked SET resolved_at = ?, receipt_id = ? WHERE order_id = ? AND kind = ? AND mode = ? AND resolved_at IS NULL',
                [now, receiptId || null, String(orderId), kind, mode],
            );
        },
        async list({ open = true, mode, orderId, limit = 50, offset = 0 } = {}) {
            await ensure();
            const where = [];
            const params = [];
            if (open) where.push('resolved_at IS NULL');
            if (mode) { where.push('mode = ?'); params.push(mode); }
            if (orderId) { where.push('order_id = ?'); params.push(String(orderId)); }
            const w = where.length ? ` WHERE ${where.join(' AND ')}` : '';
            const [rows] = await db.query(`SELECT * FROM fiscal_blocked${w} ORDER BY last_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
            const [[{ total }]] = await db.query(`SELECT COUNT(*) AS total FROM fiscal_blocked${w}`, params);
            return { rows, total: Number(total) || 0 };
        },
    };
}

function createMemoryBlockedStore() {
    const rows = [];
    const key = (r) => `${r.order_id}|${r.kind}|${r.mode}`;
    return {
        kind: 'memory',
        rows,
        async ensure() {},
        async record({ orderId, kind = 'income', mode, source, reason, message, via, amountKop }, now = new Date()) {
            const k = `${orderId}|${kind}|${mode}`;
            const ex = rows.find((r) => key(r) === k);
            if (ex) {
                Object.assign(ex, { source, reason, message, via, amount_kop: amountKop || ex.amount_kop, attempts: ex.attempts + 1, last_at: now, resolved_at: null, receipt_id: null });
            } else {
                rows.push({ id: rows.length + 1, order_id: String(orderId), kind, mode, source, reason, message, via, amount_kop: amountKop || null,
                    attempts: 1, first_at: now, last_at: now, resolved_at: null, receipt_id: null });
            }
        },
        async resolve({ orderId, kind = 'income', mode, receiptId }, now = new Date()) {
            for (const r of rows) {
                if (r.order_id === String(orderId) && r.kind === kind && r.mode === mode && !r.resolved_at) Object.assign(r, { resolved_at: now, receipt_id: receiptId || null });
            }
        },
        async list({ open = true, mode, orderId, limit = 50, offset = 0 } = {}) {
            const m = rows.filter((r) => (!open || !r.resolved_at) && (!mode || r.mode === mode) && (!orderId || r.order_id === String(orderId)));
            return { rows: m.slice().reverse().slice(offset, offset + limit).map((r) => ({ ...r })), total: m.length };
        },
    };
}

// ---------------------------------------------------------------------------
// Сохранение при создании заказа и выбор поставщика при оплате
// ---------------------------------------------------------------------------

/**
 * Сохранить реквизиты туроператора заказа. Никогда не бросает.
 * Возвращает снимок (тот, что в базе) или null при ошибке хранилища.
 */
async function captureLtOrderSupplier(orderId, orderData, { store, origin = 'lt_order_create', log = console.log, now = new Date() } = {}) {
    try {
        const snap = buildSnapshot(orderId, orderData, origin);
        const inserted = await store.insertIfAbsent(snap, now);
        const saved = inserted ? snap : await store.get(orderId);
        const tag = `[FERMA] supplier order=${orderId} operator=${snap.operator_id || '—'}`;
        if (inserted) {
            log(snap.status === 'ok'
                ? `${tag} status=ok inn=${snap.supplier_inn} (${origin})`
                : `${tag} status=${snap.status} — ${describeSnapshot(snap).replace(/\. Чек не пробит$/, '')} (${origin})`);
        }
        return saved;
    } catch (err) {
        log(`[FERMA] supplier order=${orderId} не сохранён: ${err.message}`);
        return null;
    }
}

/**
 * Поставщик для чека по оплаченному заказу Level.Travel.
 * { supplier, snapshot } — можно пробивать; { error: 'supplier_missing'|'supplier_invalid'|'supplier_mismatch', message, snapshot }.
 * Источник — только снимок этого заказа (или orders.package этого же заказа, если снимка нет). Чужих реквизитов нет.
 */
async function resolveLtOrderSupplier(orderId, orderData, { store, log = console.log, now = new Date() } = {}) {
    let snap = null;
    try {
        snap = await store.get(orderId);
        if (!snap) {
            snap = await captureLtOrderSupplier(orderId, orderData, { store, origin: 'lt_order_package', log, now });
        } else if (snap.status !== 'ok') {
            // При создании реквизитов не было (или были с ошибкой), а теперь в этом же заказе они исправны — берём их.
            const fresh = buildSnapshot(orderId, orderData, 'lt_order_package');
            if (fresh.status === 'ok' && await store.upgrade(fresh, now)) {
                log(`[FERMA] supplier order=${orderId} operator=${fresh.operator_id || '—'} status=ok inn=${fresh.supplier_inn} (было ${snap.status}, lt_order_package)`);
                snap = fresh;
            }
        }
    } catch (err) {
        log(`[FERMA] supplier order=${orderId}: хранилище недоступно (${err.message}) — реквизиты из заказа`);
    }
    // Хранилище недоступно — снимок из этого же заказа (orders.package), без записи.
    if (!snap) snap = buildSnapshot(orderId, orderData, 'lt_order_package');
    return evaluateSnapshot(snap, orderData, orderId);
}

/**
 * Можно ли по снимку пробивать чек этого заказа (без чтения и записи базы).
 * { supplier, snapshot } | { error, message, snapshot }.
 */
function evaluateSnapshot(snap, orderData, orderId) {
    if (!snap) return { error: 'supplier_missing', message: `Заказ ${orderId}: реквизиты туроператора не найдены. Чек не пробит`, snapshot: null };
    if (snap.status === 'missing') return { error: 'supplier_missing', message: describeSnapshot(snap), snapshot: snap };
    if (snap.status !== 'ok') return { error: 'supplier_invalid', message: describeSnapshot(snap), snapshot: snap };

    const current = extractOperator(orderData).id;
    if (current && snap.operator_id && current !== snap.operator_id) {
        return {
            error: 'supplier_mismatch',
            message: `Заказ ${snap.order_id}: туроператор заказа (id ${current}) не совпадает с сохранёнными реквизитами (id ${snap.operator_id}, ИНН ${snap.supplier_inn}). Чек не пробит`,
            snapshot: snap,
        };
    }
    return { supplier: { inn: snap.supplier_inn, name: snap.supplier_name, phone: snap.supplier_phone }, snapshot: snap };
}

// ---------------------------------------------------------------------------
// Экземпляры на MySQL (лениво)
// ---------------------------------------------------------------------------

let supplierStore = null;
let blockedStore = null;
function getSupplierStore() {
    if (!supplierStore) supplierStore = createMysqlSupplierStore(require('../../db'));
    return supplierStore;
}
function getBlockedStore() {
    if (!blockedStore) blockedStore = createMysqlBlockedStore(require('../../db'));
    return blockedStore;
}

/** Из /create-package: сохранить реквизиты, не ждать и не бросать. */
function fireCaptureLtOrderSupplier(orderId, orderData) {
    try {
        captureLtOrderSupplier(orderId, orderData, { store: getSupplierStore() }).catch(() => {});
    } catch (err) {
        console.error('[FERMA] supplier capture failed:', err.message);
    }
}

module.exports = {
    extractOperator, extractOrganization, normalizeSupplierName, buildSnapshot, describeSnapshot,
    captureLtOrderSupplier, resolveLtOrderSupplier, evaluateSnapshot, fireCaptureLtOrderSupplier,
    createMysqlSupplierStore, createMemorySupplierStore, createMysqlBlockedStore, createMemoryBlockedStore,
    getSupplierStore, getBlockedStore, SUPPLIERS_SQL, BLOCKED_SQL, STATUSES,
};
