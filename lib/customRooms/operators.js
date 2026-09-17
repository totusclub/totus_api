'use strict';

/**
 * Справочник наших операторов (таблица custom_room_operators, миграция —
 * scripts/run-operators-migration.js). Room Type ссылается на оператора колонкой
 * custom_room_types.operator_ref_id; имя и operator_id для витрины берутся отсюда,
 * а не из захардкоженного «Arlekino».
 *
 * Зависимость мягкая: пока миграция не прогнана, isAvailable() = false и весь модуль
 * custom rooms работает ровно как раньше (имя из custom_room_types.operator_name,
 * operator_id = 990000 + id Room Type). Ничего не выключается.
 */

const db = require('../../db');

/** Пул id для наших операторов: у Level.Travel id маленькие, пересечься нельзя. */
const OPERATOR_ID_BASE = 990000;
/** Имя оператора, если справочник недоступен и у Room Type ничего не записано. */
const DEFAULT_OPERATOR_NAME = 'Arlekino';
const CACHE_MS = 30 * 1000;
const RECHECK_MS = 60 * 1000;

let available = false;
let availableCheckedAt = 0;
let cache = { at: 0, rows: null };

function invalidate() { cache = { at: 0, rows: null }; }

/** Есть ли таблица справочника. Проверяется не чаще раза в минуту. */
async function isAvailable(force) {
    if (!force && availableCheckedAt && Date.now() - availableCheckedAt < RECHECK_MS) return available;
    availableCheckedAt = Date.now();
    try {
        await db.query('SELECT 1 FROM custom_room_operators LIMIT 1');
        available = true;
    } catch (e) {
        available = false;
        invalidate();
    }
    return available;
}

function serialize(row) {
    return {
        id: Number(row.id),
        operatorId: Number(row.operator_id),
        name: row.name || DEFAULT_OPERATOR_NAME,
        active: Number(row.active) === 1,
        sortOrder: Number(row.sort_order || 0),
        emailFromName: row.email_from_name || null,
        notifyEmails: row.notify_emails || null,
        roomTypesCount: row.room_types_count === undefined ? undefined : Number(row.room_types_count || 0),
        activeRoomTypesCount: row.active_room_types_count === undefined ? undefined : Number(row.active_room_types_count || 0),
        createdBy: row.created_by || null,
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
        updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    };
}

/** Все операторы (с кэшем 30 с). Пустой массив, если справочника ещё нет. */
async function list(force) {
    if (!(await isAvailable())) return [];
    if (!force && cache.rows && Date.now() - cache.at < CACHE_MS) return cache.rows;
    const [rows] = await db.query('SELECT * FROM custom_room_operators ORDER BY sort_order, id');
    const out = rows.map(serialize);
    cache = { at: Date.now(), rows: out };
    return out;
}

/** Операторы со счётчиком Room Type — для списка в админке. */
async function listWithUsage() {
    if (!(await isAvailable())) return [];
    const [rows] = await db.query(
        `SELECT o.*,
                (SELECT COUNT(*) FROM custom_room_types r WHERE r.operator_ref_id = o.id) AS room_types_count,
                (SELECT COUNT(*) FROM custom_room_types r WHERE r.operator_ref_id = o.id AND r.active = 1) AS active_room_types_count
           FROM custom_room_operators o
          ORDER BY o.sort_order, o.id`,
    );
    return rows.map(serialize);
}

/** Map<id оператора в справочнике, оператор> — для подстановки в Room Type. */
async function mapById() {
    const rows = await list();
    const m = new Map();
    for (const o of rows) m.set(o.id, o);
    return m;
}

async function get(id) {
    if (!(await isAvailable())) return null;
    const [rows] = await db.query(
        `SELECT o.*,
                (SELECT COUNT(*) FROM custom_room_types r WHERE r.operator_ref_id = o.id) AS room_types_count,
                (SELECT COUNT(*) FROM custom_room_types r WHERE r.operator_ref_id = o.id AND r.active = 1) AS active_room_types_count
           FROM custom_room_operators o WHERE o.id = ? LIMIT 1`,
        [Number(id)],
    );
    return rows.length ? serialize(rows[0]) : null;
}

/** Оператор по id витрины (operator_id) — для писем и снимков брони. */
async function getByOperatorId(operatorId) {
    const n = Number(operatorId);
    if (!Number.isInteger(n)) return null;
    const rows = await list();
    return rows.find((o) => o.operatorId === n) || null;
}

/** Следующий свободный operator_id из пула 990000+. */
async function nextOperatorId() {
    if (!(await isAvailable())) return OPERATOR_ID_BASE;
    const [rows] = await db.query('SELECT MAX(operator_id) AS m FROM custom_room_operators');
    const max = Number(rows[0] && rows[0].m) || 0;
    return max >= OPERATOR_ID_BASE ? max + 1 : OPERATOR_ID_BASE;
}

async function operatorIdTaken(operatorId, exceptId) {
    const [rows] = await db.query(
        'SELECT id FROM custom_room_operators WHERE operator_id = ?' + (exceptId ? ' AND id <> ?' : '') + ' LIMIT 1',
        exceptId ? [Number(operatorId), Number(exceptId)] : [Number(operatorId)],
    );
    return rows.length > 0;
}

const EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

/** Нормализует список адресов «a@b.ru, c@d.ru» → строка через запятую; null — пусто. */
function normalizeEmails(value) {
    if (value === undefined || value === null) return { value: null };
    const parts = String(value).split(',').map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return { value: null };
    if (parts.some((s) => !EMAIL_RE.test(s))) return { error: 'operator_emails_invalid' };
    const joined = parts.join(', ');
    if (joined.length > 512) return { error: 'operator_emails_invalid' };
    return { value: joined };
}

/**
 * Проверяет тело запроса. `existing` — текущий оператор при редактировании.
 * operator_id: только целое ≥ 990000 и только уникальное; если не передан — берётся следующий свободный.
 */
async function validate(body, existing) {
    const b = body || {};
    const name = b.name === undefined && existing ? existing.name : String(b.name === undefined || b.name === null ? '' : b.name).trim().slice(0, 128);
    if (!name) return { error: 'operator_name_required' };

    let operatorId;
    const rawId = b.operatorId !== undefined ? b.operatorId : b.operator_id;
    if (rawId === undefined || rawId === null || rawId === '') {
        operatorId = existing ? existing.operatorId : await nextOperatorId();
    } else {
        operatorId = Number(rawId);
        if (!Number.isInteger(operatorId) || operatorId < OPERATOR_ID_BASE) return { error: 'operator_id_invalid' };
    }
    if (await operatorIdTaken(operatorId, existing ? existing.id : null)) return { error: 'operator_id_taken' };

    const sortOrderRaw = b.sortOrder !== undefined ? b.sortOrder : b.sort_order;
    let sortOrder = existing ? existing.sortOrder : 0;
    if (sortOrderRaw !== undefined && sortOrderRaw !== null && sortOrderRaw !== '') {
        sortOrder = Number(sortOrderRaw);
        if (!Number.isInteger(sortOrder) || sortOrder < 0) return { error: 'operator_sort_order_invalid' };
    }

    let active = existing ? existing.active : true;
    if (b.active !== undefined) active = b.active === true || b.active === 'true' || b.active === 1 || b.active === '1';

    const fromRaw = b.emailFromName !== undefined ? b.emailFromName : b.email_from_name;
    const emailFromName = fromRaw === undefined
        ? (existing ? existing.emailFromName : null)
        : (String(fromRaw || '').trim().slice(0, 128) || null);

    const mailsRaw = b.notifyEmails !== undefined ? b.notifyEmails : b.notify_emails;
    const mails = mailsRaw === undefined ? { value: existing ? existing.notifyEmails : null } : normalizeEmails(mailsRaw);
    if (mails.error) return { error: mails.error };

    return { value: { name, operatorId, sortOrder, active, emailFromName, notifyEmails: mails.value } };
}

async function create(v, staffName) {
    const [r] = await db.query(
        'INSERT INTO custom_room_operators (operator_id, name, active, sort_order, email_from_name, notify_emails, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [v.operatorId, v.name, v.active ? 1 : 0, v.sortOrder, v.emailFromName, v.notifyEmails, staffName || null],
    );
    invalidate();
    return r.insertId;
}

async function update(id, v) {
    await db.query(
        'UPDATE custom_room_operators SET operator_id = ?, name = ?, active = ?, sort_order = ?, email_from_name = ?, notify_emails = ? WHERE id = ?',
        [v.operatorId, v.name, v.active ? 1 : 0, v.sortOrder, v.emailFromName, v.notifyEmails, Number(id)],
    );
    invalidate();
}

async function setActive(id, active) {
    await db.query('UPDATE custom_room_operators SET active = ? WHERE id = ?', [active ? 1 : 0, Number(id)]);
    invalidate();
}

/** Сколько Room Type ссылается на оператора — удалять можно только когда ноль. */
async function roomTypesCount(id) {
    const [rows] = await db.query('SELECT COUNT(*) AS c FROM custom_room_types WHERE operator_ref_id = ?', [Number(id)]);
    return Number(rows[0] && rows[0].c) || 0;
}

async function remove(id) {
    const [r] = await db.query('DELETE FROM custom_room_operators WHERE id = ?', [Number(id)]);
    invalidate();
    return r.affectedRows > 0;
}

module.exports = {
    OPERATOR_ID_BASE,
    DEFAULT_OPERATOR_NAME,
    isAvailable,
    invalidate,
    list,
    listWithUsage,
    mapById,
    get,
    getByOperatorId,
    nextOperatorId,
    validate,
    create,
    update,
    setActive,
    roomTypesCount,
    remove,
};
