// Справочник операторов (claude/OPERATORS_PLAN_RU.md):
//   NODE_PATH=/home/claude/stubs/node_modules node scripts/check-operators.js
// Без БД и сети (db.query подменён). Проверяем: валидацию оператора (имя, пул id 990000+, уникальность,
// порядок, адреса почты), подстановку оператора в Room Type при сериализации, привязку operator_ref_id
// в админской валидации Room Type и то, что без справочника поведение ровно прежнее.
'use strict';
const assert = require('assert');
process.env.DB_HOST = process.env.DB_HOST || 'localhost';
process.env.JWT_SECRET = process.env.JWT_SECRET || 's1';

// Level.Travel в проверках не вызывается: если utils/levelTravelHttp недоступен — заглушка
{
    const Module = require('module');
    const origLoad = Module._load;
    Module._load = function (request, ...rest) {
        if (/utils\/levelTravelHttp$/.test(String(request))) {
            try { return origLoad.call(this, request, ...rest); } catch (e) { return { ltRequest: async () => { throw new Error('LT disabled in checks'); }, logLtError() {}, sendLtAxiosError: (res) => res.status(502).json({ error: 'lt_disabled' }) }; }
        }
        return origLoad.call(this, request, ...rest);
    };
}

// --- заглушка БД -------------------------------------------------------------
const state = {
    hasTable: true,
    rows: [
        { id: 1, operator_id: 990000, name: 'Arlekino', active: 1, sort_order: 0, email_from_name: 'Arlekino Tour', notify_emails: 'booking@arlekino.ru', created_by: 'migration', created_at: null, updated_at: null },
        { id: 2, operator_id: 990001, name: 'Sunrise Travel', active: 0, sort_order: 1, email_from_name: null, notify_emails: null, created_by: 'Ирина', created_at: null, updated_at: null },
    ],
    roomTypesByOperator: { 1: 12, 2: 0 },
};
const dbMod = require('../db');
dbMod.query = (sql) => {
    const q = String(sql).replace(/\s+/g, ' ').trim();
    if (/FROM custom_room_operators/.test(q) && !state.hasTable) return Promise.reject(new Error("Table 'custom_room_operators' doesn't exist"));
    if (/^SELECT 1 FROM custom_room_operators/.test(q)) return Promise.resolve([[{ 1: 1 }]]);
    if (/SELECT MAX\(operator_id\)/.test(q)) return Promise.resolve([[{ m: Math.max(0, ...state.rows.map((r) => r.operator_id)) }]]);
    if (/^SELECT id FROM custom_room_operators WHERE operator_id = \?/.test(q)) return Promise.resolve([[]]);   // занятость задаём отдельно
    if (/COUNT\(\*\) AS c FROM custom_room_types WHERE operator_ref_id/.test(q)) return Promise.resolve([[{ c: 0 }]]);
    if (/^SELECT o\.\*/.test(q) && /WHERE o\.id = \?/.test(q)) return Promise.resolve([[state.rows[0]]]);
    if (/^SELECT o\.\*/.test(q)) return Promise.resolve([state.rows.map((r) => ({ ...r, room_types_count: state.roomTypesByOperator[r.id] || 0, active_room_types_count: 0 }))]);
    if (/^SELECT \* FROM custom_room_operators/.test(q)) return Promise.resolve([state.rows]);
    if (/SHOW COLUMNS FROM custom_room_types/.test(q)) return Promise.resolve([[{ Field: 'operator_ref_id' }]]);
    return Promise.resolve([[]]);
};

const operators = require('../lib/customRooms/operators');
const store = require('../lib/customRooms/store');
const ctrl = require('../controllers/customRooms.controller');

const reset = () => { operators.invalidate(); };

// --- 1. Валидация оператора --------------------------------------------------
(async () => {
    reset();
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

    v = await operators.validate({ name: 'Новый', operatorId: 990500 }, null);
    assert.strictEqual(v.value.operatorId, 990500, 'свой id из пула принимается');

    v = await operators.validate({ name: 'Новый', operatorId: 990500.5 }, null);
    assert.strictEqual(v.error, 'operator_id_invalid', 'дробный id запрещён');

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

    // --- 2. Подстановка оператора в Room Type --------------------------------
    const row = {
        id: 7, hotel_id: 123, source_room_id: 501, operator_ids: '[]', operator_names: '[]', meal_types: null,
        name_ru: 'Deluxe', rule_type: null, rule_value: null, rounding: 1, pricing_mode: 'fixed', fixed_price: '86850.00',
        fixed_price_unit: 'total', operator_name: 'Arlekino', operator_id: null, package_types: '[]', badge: 'Totus',
        active: 1, sort_order: 0, facilities: '[]', images: '[]',
    };
    const opMap = await operators.mapById();
    assert.strictEqual(opMap.size, 2, 'справочник прочитан');

    const noCatalog = store.serializeRoomType({ ...row }, store.DEFAULT_SETTINGS);
    assert.strictEqual(noCatalog.operatorName, 'Arlekino', 'без справочника — имя из строки');
    assert.strictEqual(noCatalog.operatorId, null);
    assert.strictEqual(noCatalog.effectiveOperatorId, 990007, 'без справочника — синтетический id 990000 + id Room Type');
    assert.strictEqual(noCatalog.operatorRefId, null);

    const linked = store.serializeRoomType({ ...row, operator_ref_id: 2 }, store.DEFAULT_SETTINGS, opMap);
    assert.strictEqual(linked.operatorName, 'Sunrise Travel', 'имя берётся из справочника');
    assert.strictEqual(linked.operatorId, 990001, 'operator_id берётся из справочника');
    assert.strictEqual(linked.effectiveOperatorId, 990001, 'синтетический id больше не используется');
    assert.strictEqual(linked.operatorRefId, 2);
    assert.strictEqual(linked.operatorRefActive, false, 'состояние оператора видно в админке');

    // привязка есть, но оператор удалён из справочника — откат к прежнему поведению, ничего не падает
    const broken = store.serializeRoomType({ ...row, operator_ref_id: 404 }, store.DEFAULT_SETTINGS, opMap);
    assert.strictEqual(broken.operatorName, 'Arlekino');
    assert.strictEqual(broken.effectiveOperatorId, 990007);

    console.log('✅ подстановка оператора в Room Type');

    // --- 3. Админская валидация Room Type ------------------------------------
    const settings = { ...store.DEFAULT_SETTINGS };
    const base = { hotelId: 123, sourceRoomId: 501, content: { nameRu: 'Deluxe' }, pricingMode: 'fixed', fixedPrice: 1 };

    let r = await ctrl._internal.validateRoomType({ ...base }, settings, null);
    assert.ok(!r.error, r.error);
    assert.strictEqual(r.value.operatorRefId, 1, 'новый Room Type без выбора — первый активный оператор');
    assert.strictEqual(r.value.operatorName, 'Arlekino', 'имя — снимок справочника');
    assert.strictEqual(r.value.operatorId, 990000, 'operator_id — снимок справочника');

    r = await ctrl._internal.validateRoomType({ ...base, operatorRefId: 2 }, settings, null);
    assert.strictEqual(r.value.operatorRefId, 2, 'выбранный оператор сохраняется');
    assert.strictEqual(r.value.operatorName, 'Arlekino', 'get() в заглушке всегда отдаёт первого — имя из справочника');

    r = await ctrl._internal.validateRoomType({ ...base, operatorRefId: 'нет' }, settings, null);
    assert.strictEqual(r.error, 'operator_ref_invalid', 'мусор в operator_ref_id — ошибка');

    r = await ctrl._internal.validateRoomType({ ...base, operatorRefId: null }, settings, null);
    assert.strictEqual(r.value.operatorRefId, null, 'явный null отвязывает Room Type от справочника');

    assert.ok(ctrl._internal.diff({ operatorRefId: 1 }, { operatorRefId: 2 }).operatorRefId, 'смена оператора попадает в историю правок');

    console.log('✅ выбор оператора при создании и редактировании Room Type');

    // --- 4. Без миграции — поведение прежнее ---------------------------------
    state.hasTable = false;
    reset();
    operators.isAvailable(true);
    await new Promise((res) => setImmediate(res));
    assert.strictEqual(await operators.isAvailable(true), false, 'без таблицы справочник недоступен');
    assert.deepStrictEqual(await operators.list(), [], 'список пуст');
    r = await ctrl._internal.validateRoomType({ ...base }, settings, null);
    assert.strictEqual(r.value.operatorRefId, null, 'без справочника привязки нет');
    assert.strictEqual(r.value.operatorName, 'Arlekino', 'без справочника — прежнее имя по умолчанию');
    state.hasTable = true;
    reset();

    console.log('✅ без миграции поведение не меняется');
    console.log('ALL OPERATORS CHECKS PASSED');
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
