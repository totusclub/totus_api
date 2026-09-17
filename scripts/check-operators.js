// Справочник операторов (claude/OPERATORS_PLAN_RU.md):
//   NODE_PATH=/home/claude/stubs/node_modules node scripts/check-operators.js
// Без БД и сети (db.query подменён). Проверяем: валидацию оператора (имя, пул id 990000+,
// уникальность, порядок, адреса почты), связь с Room Type по custom_room_types.operator_id,
// перенос имени в Room Type при переименовании оператора и то, что без миграции справочник
// просто пуст и ничего не ломает.
'use strict';
const assert = require('assert');
process.env.DB_HOST = process.env.DB_HOST || 'localhost';

// --- заглушка БД -------------------------------------------------------------
const state = {
    hasTable: true,
    taken: new Set(),
    rows: [
        { id: 1, operator_id: 990000, name: 'Arlekino', active: 1, sort_order: 0, email_from_name: 'Arlekino Tour', notify_emails: 'booking@arlekino.ru', created_by: 'migration', created_at: null, updated_at: null },
        { id: 2, operator_id: 990001, name: 'Sunrise Travel', active: 0, sort_order: 1, email_from_name: null, notify_emails: null, created_by: 'Ирина', created_at: null, updated_at: null },
    ],
};
const calls = [];
const dbMod = require('../db');
dbMod.query = (sql, args) => {
    const q = String(sql).replace(/\s+/g, ' ').trim();
    calls.push({ q, args });
    if (/custom_room_operators/.test(q) && !state.hasTable) return Promise.reject(new Error("Table 'custom_room_operators' doesn't exist"));
    if (/^SELECT 1 FROM custom_room_operators/.test(q)) return Promise.resolve([[{ 1: 1 }]]);
    if (/SELECT MAX\(operator_id\)/.test(q)) return Promise.resolve([[{ m: Math.max(0, ...state.rows.map((r) => r.operator_id)) }]]);
    if (/^SELECT id FROM custom_room_operators WHERE operator_id = \?/.test(q)) {
        return Promise.resolve([state.taken.has(Number(args[0])) ? [{ id: 99 }] : []]);
    }
    if (/COUNT\(\*\) AS c FROM custom_room_types WHERE operator_id/.test(q)) return Promise.resolve([[{ c: Number(args[0]) === 990000 ? 12 : 0 }]]);
    if (/^SELECT o\.\*/.test(q) && /WHERE o\.id = \?/.test(q)) {
        const row = state.rows.find((r) => r.id === Number(args[0]));
        return Promise.resolve([row ? [{ ...row, room_types_count: 0, active_room_types_count: 0 }] : []]);
    }
    if (/^SELECT o\.\*/.test(q)) return Promise.resolve([state.rows.map((r) => ({ ...r, room_types_count: 0, active_room_types_count: 0 }))]);
    if (/^SELECT \* FROM custom_room_operators/.test(q)) return Promise.resolve([state.rows]);
    if (/^UPDATE custom_room_types SET operator_id = \?, operator_name = \?/.test(q)) return Promise.resolve([{ affectedRows: 12 }]);
    return Promise.resolve([{ affectedRows: 0, insertId: 3 }]);
};

const operators = require('../lib/customRooms/operators');

(async () => {
    // --- 1. Валидация оператора ----------------------------------------------
    operators.invalidate();
    let v = await operators.validate({ name: '' }, null);
    assert.strictEqual(v.error, 'operator_name_required', 'без имени — ошибка');

    v = await operators.validate({ name: 'Новый' }, null);
    assert.ok(!v.error, 'имени достаточно');
    assert.strictEqual(v.value.operatorId, 990002, 'operator_id выдаётся следующим из пула');
    assert.strictEqual(v.value.active, true, 'по умолчанию активен');
    assert.strictEqual(v.value.sortOrder, 0);
    assert.strictEqual(v.value.notifyEmails, null);

    v = await operators.validate({ name: 'Новый', operatorId: 78 }, null);
    assert.strictEqual(v.error, 'operator_id_invalid', 'id ниже 990000 запрещён — это диапазон Level.Travel');

    v = await operators.validate({ name: 'Новый', operatorId: 990500.5 }, null);
    assert.strictEqual(v.error, 'operator_id_invalid', 'дробный id запрещён');

    v = await operators.validate({ name: 'Новый', operatorId: 990500 }, null);
    assert.strictEqual(v.value.operatorId, 990500, 'свой id из пула принимается');

    state.taken.add(990500);
    v = await operators.validate({ name: 'Новый', operatorId: 990500 }, null);
    assert.strictEqual(v.error, 'operator_id_taken', 'занятый id отклоняется');
    state.taken.clear();

    v = await operators.validate({ name: 'Новый', sortOrder: -1 }, null);
    assert.strictEqual(v.error, 'operator_sort_order_invalid');

    v = await operators.validate({ name: 'Новый', notifyEmails: 'a@b.ru,  c@d.ru ' }, null);
    assert.strictEqual(v.value.notifyEmails, 'a@b.ru, c@d.ru', 'адреса нормализуются');

    v = await operators.validate({ name: 'Новый', notifyEmails: 'a@b.ru, кто-то' }, null);
    assert.strictEqual(v.error, 'operator_emails_invalid');

    v = await operators.validate({ name: 'Новый', emailFromName: '  Tour  ' }, null);
    assert.strictEqual(v.value.emailFromName, 'Tour');

    // редактирование: не переданные поля берутся у существующего
    const existing = { id: 1, operatorId: 990000, name: 'Arlekino', active: true, sortOrder: 0, emailFromName: 'Arlekino Tour', notifyEmails: 'booking@arlekino.ru' };
    v = await operators.validate({ name: 'Arlekino Travel' }, existing);
    assert.strictEqual(v.value.operatorId, 990000, 'id сохраняется при переименовании');
    assert.strictEqual(v.value.emailFromName, 'Arlekino Tour', 'почта не затирается');
    assert.strictEqual(v.value.active, true);

    v = await operators.validate({ active: false }, existing);
    assert.strictEqual(v.value.name, 'Arlekino', 'имя сохраняется');
    assert.strictEqual(v.value.active, false);

    console.log('✅ валидация оператора');

    // --- 2. Связь с Room Type по operator_id ---------------------------------
    operators.invalidate();
    const byOperatorId = await operators.mapByOperatorId();
    assert.strictEqual(byOperatorId.size, 2, 'справочник прочитан');
    assert.strictEqual(byOperatorId.get(990000).name, 'Arlekino');
    assert.strictEqual(byOperatorId.get(990001).active, false, 'состояние оператора видно в админке');

    assert.strictEqual(await operators.roomTypesCount(990000), 12, 'счёт Room Type идёт по custom_room_types.operator_id');
    assert.strictEqual(await operators.roomTypesCount(990001), 0);

    console.log('✅ связь Room Type с оператором по operator_id');

    // --- 3. Переименование переносится в Room Type ----------------------------
    calls.length = 0;
    const affected = await operators.update(1, { operatorId: 990000, name: 'Arlekino Travel', active: true, sortOrder: 0, emailFromName: null, notifyEmails: null }, existing);
    assert.strictEqual(affected, 12, 'Room Type оператора обновлены');
    const propagate = calls.find((c) => /^UPDATE custom_room_types SET operator_id = \?, operator_name = \?/.test(c.q.replace(/\s+/g, ' ').trim()));
    assert.ok(propagate, 'имя переносится в custom_room_types');
    assert.deepStrictEqual(propagate.args, [990000, 'Arlekino Travel', 990000], 'обновляются строки прежнего operator_id');

    // смена самого operator_id: строки переезжают со старого id на новый
    calls.length = 0;
    await operators.update(1, { operatorId: 990009, name: 'Arlekino Travel', active: true, sortOrder: 0, emailFromName: null, notifyEmails: null }, existing);
    const moved = calls.find((c) => /^UPDATE custom_room_types SET operator_id/.test(c.q.replace(/\s+/g, ' ').trim()));
    assert.deepStrictEqual(moved.args, [990009, 'Arlekino Travel', 990000], 'старый id → новый');

    console.log('✅ переименование оператора доходит до Room Type');

    // --- 4. Без миграции — справочник пуст, ничего не ломается ----------------
    state.hasTable = false;
    operators.invalidate();
    assert.strictEqual(await operators.isAvailable(true), false, 'без таблицы справочник недоступен');
    assert.deepStrictEqual(await operators.list(), [], 'список пуст');
    assert.strictEqual((await operators.mapByOperatorId()).size, 0);
    assert.strictEqual(await operators.get(1), null);
    assert.strictEqual(await operators.nextOperatorId(), operators.OPERATOR_ID_BASE, 'первый id — 990000');
    state.hasTable = true;
    operators.invalidate();

    console.log('✅ без миграции справочник просто пуст');
    console.log('ALL OPERATORS CHECKS PASSED');
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
