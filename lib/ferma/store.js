'use strict';
// Хранилище чеков: MySQL (таблица fiscal_receipts создаётся сама) и память (тесты, scripts/ferma-selftest.js).
// Оба варианта — один интерфейс. Все даты сравнения (next_check_at) пишет Node, а не MySQL,
// чтобы не зависеть от часового пояса сессии БД.

const STATES = ['draft', 'sent', 'confirmed', 'kkt_error', 'rejected', 'send_failed'];
const COLUMNS = [
    'mode', 'scenario', 'kind', 'order_ref', 'parent_id', 'invoice_id', 'attempt', 'receipt_id', 'amount_kop',
    'label', 'supplier_inn', 'state', 'status_code', 'status_name', 'status_message', 'description',
    'error_code', 'error_text', 'rnm', 'fn', 'fdn', 'fpd', 'ofd_receipt_url', 'receipt_date',
    'input_json', 'request_json', 'send_attempts', 'next_check_at', 'last_checked_at', 'callback_at', 'created_at',
];

const CREATE_TABLE_SQL = `
    CREATE TABLE IF NOT EXISTS fiscal_receipts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      mode VARCHAR(8) NOT NULL,
      scenario VARCHAR(32) NOT NULL,
      kind VARCHAR(24) NOT NULL,
      order_ref VARCHAR(64) NOT NULL,
      parent_id INT NULL,
      invoice_id VARCHAR(64) NOT NULL,
      attempt INT NOT NULL DEFAULT 1,
      receipt_id VARCHAR(64) NULL,
      amount_kop BIGINT NOT NULL,
      label VARCHAR(128) NULL,
      supplier_inn VARCHAR(12) NULL,
      state VARCHAR(16) NOT NULL,
      status_code TINYINT NULL,
      status_name VARCHAR(32) NULL,
      status_message VARCHAR(500) NULL,
      description VARCHAR(500) NULL,
      error_code INT NULL,
      error_text VARCHAR(1000) NULL,
      rnm VARCHAR(32) NULL,
      fn VARCHAR(32) NULL,
      fdn VARCHAR(32) NULL,
      fpd VARCHAR(32) NULL,
      ofd_receipt_url VARCHAR(255) NULL,
      receipt_date VARCHAR(64) NULL,
      input_json MEDIUMTEXT NULL,
      request_json MEDIUMTEXT NULL,
      send_attempts INT NOT NULL DEFAULT 0,
      next_check_at DATETIME NULL,
      last_checked_at DATETIME NULL,
      callback_at DATETIME NULL,
      created_at DATETIME NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_invoice (invoice_id),
      KEY idx_receipt (receipt_id),
      KEY idx_order (order_ref, kind),
      KEY idx_pending (mode, state, next_check_at),
      KEY idx_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

function pick(fields) {
    const out = {};
    for (const k of Object.keys(fields)) {
        if (COLUMNS.includes(k)) out[k] = fields[k];
    }
    return out;
}

function createMysqlStore(db) {
    let ready = null;
    const ensure = () => {
        if (!ready) {
            ready = db.query(CREATE_TABLE_SQL).catch((err) => { ready = null; throw err; });
        }
        return ready;
    };
    const one = async (sql, params) => { const [rows] = await db.query(sql, params); return rows[0] || null; };

    return {
        kind: 'mysql',
        ensure,
        async insert(fields) {
            await ensure();
            const f = pick(fields);
            const cols = Object.keys(f);
            const [r] = await db.query(
                `INSERT INTO fiscal_receipts (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
                cols.map((c) => f[c]),
            );
            return r.insertId;
        },
        async update(id, fields) {
            await ensure();
            const f = pick(fields);
            const cols = Object.keys(f);
            if (!cols.length) return;
            await db.query(`UPDATE fiscal_receipts SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [...cols.map((c) => f[c]), id]);
        },
        async get(id) { await ensure(); return one('SELECT * FROM fiscal_receipts WHERE id = ?', [id]); },
        async findByInvoice(invoiceId) { await ensure(); return one('SELECT * FROM fiscal_receipts WHERE invoice_id = ?', [invoiceId]); },
        async findByReceiptId(receiptId) { await ensure(); return one('SELECT * FROM fiscal_receipts WHERE receipt_id = ?', [receiptId]); },
        async latestFor(orderRef, kind, mode) {
            await ensure();
            return one('SELECT * FROM fiscal_receipts WHERE order_ref = ? AND kind = ? AND mode = ? ORDER BY attempt DESC, id DESC LIMIT 1', [orderRef, kind, mode]);
        },
        async children(parentId) {
            await ensure();
            const [rows] = await db.query('SELECT * FROM fiscal_receipts WHERE parent_id = ? ORDER BY id', [parentId]);
            return rows;
        },
        async pending(mode, now, limit = 50) {
            await ensure();
            const [rows] = await db.query(
                "SELECT * FROM fiscal_receipts WHERE mode = ? AND state IN ('draft', 'sent', 'send_failed') AND next_check_at <= ? ORDER BY next_check_at, id LIMIT ?",
                [mode, now, limit],
            );
            return rows;
        },
        async list({ mode, state, orderRef, scenario, limit = 50, offset = 0 } = {}) {
            await ensure();
            const where = [];
            const params = [];
            if (mode) { where.push('mode = ?'); params.push(mode); }
            if (state) { where.push('state = ?'); params.push(state); }
            if (orderRef) { where.push('order_ref = ?'); params.push(orderRef); }
            if (scenario) { where.push('scenario = ?'); params.push(scenario); }
            const w = where.length ? ` WHERE ${where.join(' AND ')}` : '';
            const [rows] = await db.query(`SELECT * FROM fiscal_receipts${w} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
            const [[{ total }]] = await db.query(`SELECT COUNT(*) AS total FROM fiscal_receipts${w}`, params);
            return { rows, total: Number(total) || 0 };
        },
        async createdBetween(mode, from, to) {
            await ensure();
            const [rows] = await db.query(
                'SELECT * FROM fiscal_receipts WHERE mode = ? AND created_at >= ? AND created_at < ? ORDER BY id',
                [mode, from, to],
            );
            return rows;
        },
    };
}

function createMemoryStore() {
    const rows = [];
    const clone = (r) => (r ? { ...r } : null);
    return {
        kind: 'memory',
        rows,
        async ensure() {},
        async insert(fields) {
            const f = pick(fields);
            if (rows.some((r) => r.invoice_id === f.invoice_id)) {
                const e = new Error(`Duplicate entry '${f.invoice_id}' for key 'uq_invoice'`);
                e.code = 'ER_DUP_ENTRY';
                throw e;
            }
            const row = { id: rows.length + 1, parent_id: null, receipt_id: null, send_attempts: 0, ...f };
            rows.push(row);
            return row.id;
        },
        async update(id, fields) { Object.assign(rows.find((r) => r.id === id) || {}, pick(fields)); },
        async get(id) { return clone(rows.find((r) => r.id === Number(id))); },
        async findByInvoice(inv) { return clone(rows.find((r) => r.invoice_id === inv)); },
        async findByReceiptId(rid) { return clone(rows.find((r) => r.receipt_id === rid)); },
        async latestFor(orderRef, kind, mode) {
            const m = rows.filter((r) => r.order_ref === orderRef && r.kind === kind && r.mode === mode)
                .sort((a, b) => b.attempt - a.attempt || b.id - a.id);
            return clone(m[0]);
        },
        async children(parentId) { return rows.filter((r) => r.parent_id === parentId).map(clone); },
        async pending(mode, now, limit = 50) {
            return rows.filter((r) => r.mode === mode && ['draft', 'sent', 'send_failed'].includes(r.state) && r.next_check_at && r.next_check_at <= now)
                .sort((a, b) => a.next_check_at - b.next_check_at || a.id - b.id).slice(0, limit).map(clone);
        },
        async list({ mode, state, orderRef, scenario, limit = 50, offset = 0 } = {}) {
            const m = rows.filter((r) => (!mode || r.mode === mode) && (!state || r.state === state)
                && (!orderRef || r.order_ref === orderRef) && (!scenario || r.scenario === scenario));
            return { rows: m.slice().reverse().slice(offset, offset + limit).map(clone), total: m.length };
        },
        async createdBetween(mode, from, to) {
            return rows.filter((r) => r.mode === mode && r.created_at >= from && r.created_at < to).map(clone);
        },
    };
}

module.exports = { createMysqlStore, createMemoryStore, CREATE_TABLE_SQL, STATES, COLUMNS };
