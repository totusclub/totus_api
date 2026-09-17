'use strict';

/**
 * Справочник операторов — /api/admin/operators/* (staff-JWT strict). docs/OPERATORS_API.md.
 * Данные — lib/customRooms/operators.js (таблица custom_room_operators).
 * Связь с Room Type — по custom_room_types.operator_id.
 */

const operators = require('../lib/customRooms/operators');

const ERROR_STATUS = {
    not_found: 404,
    operators_not_migrated: 503,
    operator_in_use: 409,
    operator_id_taken: 409,
};

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
    console.error('[operators] admin error:', e);
    if (!res.headersSent) res.status(500).json({ error: 'internal_error', message: e.message });
});

function fail(res, error, extra) { return res.status(ERROR_STATUS[error] || 400).json({ error, ...(extra || {}) }); }

function staffOf(req) {
    const p = (req.auth && req.auth.payload) || req.authStaff || {};
    return { id: req.auth ? req.auth.id : null, name: [p.name, p.lastname].filter(Boolean).join(' ').trim() || p.email || null };
}

function intParam(v) { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; }

/** Мутации требуют миграции; чтение отвечает и без неё (available: false). */
async function readyGuard(req, res, next) {
    if (await operators.isAvailable()) return next();
    return fail(res, 'operators_not_migrated');
}

/**
 * GET / — список операторов со счётчиком Room Type.
 * Пока миграция не прогнана: { operators: [], available: false } и 200 —
 * админка показывает подсказку, а не ошибку.
 */
const list = wrap(async (req, res) => {
    const available = await operators.isAvailable();
    if (!available) return res.json({ operators: [], available: false, suggestedOperatorId: operators.OPERATOR_ID_BASE });
    res.json({
        operators: await operators.listWithUsage(),
        available: true,
        suggestedOperatorId: await operators.nextOperatorId(),
        operatorIdBase: operators.OPERATOR_ID_BASE,
    });
});

const get = wrap(async (req, res) => {
    const id = intParam(req.params.id);
    const operator = id ? await operators.get(id) : null;
    if (!operator) return fail(res, 'not_found');
    res.json({ operator });
});

const create = wrap(async (req, res) => {
    const v = await operators.validate(req.body, null);
    if (v.error) return fail(res, v.error);
    const id = await operators.create(v.value, staffOf(req).name);
    res.json({ ok: true, operator: await operators.get(id) });
});

/** PUT /:id — сохраняет оператора и переносит имя в его Room Type (roomTypesUpdated). */
const update = wrap(async (req, res) => {
    const id = intParam(req.params.id);
    const existing = id ? await operators.get(id) : null;
    if (!existing) return fail(res, 'not_found');
    const v = await operators.validate(req.body, existing);
    if (v.error) return fail(res, v.error);
    const roomTypesUpdated = await operators.update(id, v.value, existing);
    res.json({ ok: true, operator: await operators.get(id), roomTypesUpdated });
});

const toggle = wrap(async (req, res) => {
    const id = intParam(req.params.id);
    const existing = id ? await operators.get(id) : null;
    if (!existing) return fail(res, 'not_found');
    const next = req.body && req.body.active !== undefined
        ? (req.body.active === true || req.body.active === 'true' || req.body.active === 1 || req.body.active === '1')
        : !existing.active;
    await operators.setActive(id, next);
    res.json({ ok: true, operator: await operators.get(id) });
});

/**
 * POST /:id/duplicate — копия с новым operator_id.
 * Room Type исходного оператора не копируются: копия создаётся пустой.
 */
const duplicate = wrap(async (req, res) => {
    const id = intParam(req.params.id);
    const src = id ? await operators.get(id) : null;
    if (!src) return fail(res, 'not_found');
    const b = req.body || {};
    const copyEmails = b.copyEmails === undefined ? true : (b.copyEmails === true || b.copyEmails === 'true');
    const body = {
        name: b.name !== undefined && String(b.name).trim() ? b.name : `${src.name} (копия)`,
        operatorId: b.operatorId !== undefined ? b.operatorId : undefined,
        sortOrder: src.sortOrder,
        active: b.active === undefined ? false : b.active,
        emailFromName: copyEmails ? src.emailFromName : null,
        notifyEmails: copyEmails ? src.notifyEmails : null,
    };
    const v = await operators.validate(body, null);
    if (v.error) return fail(res, v.error);
    const newId = await operators.create(v.value, staffOf(req).name);
    res.json({ ok: true, operator: await operators.get(newId) });
});

/** DELETE /:id — только если за оператором не закреплён ни один Room Type. */
const remove = wrap(async (req, res) => {
    const id = intParam(req.params.id);
    const existing = id ? await operators.get(id) : null;
    if (!existing) return fail(res, 'not_found');
    const used = await operators.roomTypesCount(existing.operatorId);
    if (used > 0) return fail(res, 'operator_in_use', { roomTypesCount: used });
    await operators.remove(id);
    res.json({ ok: true });
});

module.exports = { readyGuard, list, get, create, update, toggle, duplicate, remove };
