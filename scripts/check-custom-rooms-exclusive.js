// «Наш отель» — продавать только наши предложения (бриф BRIEF_EXCLUSIVE, 16.09.2026):
//   NODE_PATH=/home/claude/stubs/node_modules node scripts/check-custom-rooms-exclusive.js
// Без БД и сети. Проверяем: exclusive=0 — поведение не меняется; scope='room' — LT скрыт только в исходном номере;
// scope='hotel' — LT скрыт во всех номерах отеля, номера без наших предложений выпадают из result;
// пересчёт min_price / meal_types / filters.meals / min_price отеля; 410 offer_expired для LT-пакета в exclusive-отеле
// и полное невмешательство в обычный отель; валидация exclusive/exclusiveScope в админке.
'use strict';
const assert = require('assert');
process.env.DB_HOST = process.env.DB_HOST || 'localhost';
process.env.JWT_SECRET = process.env.JWT_SECRET || 's1';

// Level.Travel в проверках не вызывается: если utils/levelTravelHttp недоступен (частичная копия репозитория) — заглушка
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

const dbMod = require('../db');
const dbCalls = [];
dbMod.query = (sql, args) => { dbCalls.push(String(sql).replace(/\s+/g, ' ').trim()); return Promise.resolve([[]]); };

const { normalizePricing } = require('../lib/customRooms/pricing');
const inject = require('../lib/customRooms/inject');
const store = require('../lib/customRooms/store');
const flow = require('../lib/customRooms/packageFlow');
const ctrl = require('../controllers/customRooms.controller');

// --- фикстуры ----------------------------------------------------------------
const ourOffers = (room) => Object.values(room.offers).flat().filter(inject.isArlekinoOffer);
const ltOffers = (room) => Object.values(room.offers).flat().filter((o) => !inject.isArlekinoOffer(o));

const mkRoom = (id, ID) => ({ ID, room: { id, name_ru: `Room ${id}` }, min_price: 97500, meal_types: [{ id: 'AI', min_price: 97500 }, { id: 'UAI', min_price: 112300 }], offers: {
    AI: [{ id: `${id}-1`, price: 98900, nights_count: 7, operator_id: 33, operator_name: 'Coral Travel', extras: { cheap: true } }, { id: `${id}-2`, price: 97500, nights_count: 7, operator_id: 44, operator_name: 'Anex' }],
    UAI: [{ id: `${id}-3`, price: 112300, nights_count: 7, operator_id: 33, operator_name: 'Coral Travel' }],
} });
const rt = (extra) => ({ id: 9, hotelId: 123, sourceRoomId: 501, operatorIds: [], operatorNames: [], mealTypes: null, sortOrder: 0, badge: 'Totus', packageTypes: [], active: true,
    pricingMode: 'fixed', fixedPrice: 1, fixedPriceUnit: 'total', operatorName: 'Arlekino', operatorId: null, rule: null, exclusive: false, exclusiveScope: 'room',
    pricing: normalizePricing({ mode: 'fixed', fixedPrice: 1 }), content: { nameRu: 'Arlekino Deluxe' }, ...(extra || {}) });
const ltData = () => ({ search_type: 2, min_price: 97500, currency_code: 'RUB', result: [mkRoom(501, 'r1'), mkRoom(502, 'r2')],
    filters: { meals: [{ id: 'AI', min_price: 97500 }, { id: 'UAI', min_price: 112300 }] } });

// store без БД
const stub = { rts: [], settings: { ...store.DEFAULT_SETTINGS }, offerMap: [] };
store.getSettings = async () => stub.settings;
store.activeRoomTypesForHotel = async () => stub.rts;
store.saveOfferMap = async (e) => { stub.offerMap.push(...e); };
store.logPrice = async () => {};
store.touchLastSeen = async () => {};
store.markChecked = async () => true;

// --- 1) exclusive = 0 (по умолчанию): поведение НЕ меняется -------------------
async function defaultUnchanged() {
    stub.rts = [rt()];
    const out = await inject.injectRooms(ltData(), { requestId: 'req1', hotelId: 123, searchType: 'hotel' });
    assert.strictEqual(out.result.length, 2, 'номера на месте');
    assert.strictEqual(ourOffers(out.result[0]).length, 1, 'наше предложение вставлено');
    assert.deepStrictEqual(ltOffers(out.result[0]).map((o) => o.id), ['501-1', '501-2', '501-3'], 'предложения LT нетронуты');
    assert.deepStrictEqual(ltOffers(out.result[1]).map((o) => o.id), ['502-1', '502-2', '502-3'], 'соседний номер нетронут');
    assert.strictEqual(out.result[0].min_price, 1); assert.strictEqual(out.min_price, 1, 'минимум отеля только понижается');
    assert.strictEqual(out.filters.meals.length, 2);
    // без exclusive и без активных Room Type ответ возвращается байт-в-байт
    stub.rts = [];
    const body = ltData();
    assert.strictEqual(await inject.injectRooms(body, { requestId: 'r', hotelId: 123, searchType: 'hotel' }), body, 'нет Room Type — тот же объект');
    // applyExclusive на выключенном флаге не трогает ответ
    const res = ltData().result;
    assert.deepStrictEqual(inject.applyExclusive(res, [rt()]), { applied: false, scope: null, hidden: 0, dropped: 0 });
    assert.strictEqual(ltOffers(res[0]).length, 3);
}

// --- 2) scope = 'room' --------------------------------------------------------
async function scopeRoom() {
    stub.rts = [rt({ exclusive: true, exclusiveScope: 'room' })];
    const out = await inject.injectRooms(ltData(), { requestId: 'req2', hotelId: 123, searchType: 'hotel' });
    assert.strictEqual(out.result.length, 2, 'номера не выпали: во втором остались предложения LT');
    const src = out.result[0];
    assert.strictEqual(ltOffers(src).length, 0, 'в исходном номере предложений LT нет');
    assert.strictEqual(ourOffers(src).length, 1, 'наше предложение осталось');
    assert.deepStrictEqual(Object.keys(src.offers), ['AI'], 'питание без предложений убрано');
    assert.strictEqual(src.min_price, 1);
    assert.deepStrictEqual(src.meal_types.map((m) => m.id), ['AI'], 'meal_types пересчитаны');
    assert.strictEqual(src.meal_types[0].min_price, 1);
    assert.deepStrictEqual(ltOffers(out.result[1]).map((o) => o.id), ['502-1', '502-2', '502-3'], 'другой номер не тронут');
    assert.strictEqual(out.result[1].min_price, 97500);
    assert.deepStrictEqual(out.filters.meals, [{ id: 'AI', min_price: 1 }, { id: 'UAI', min_price: 112300 }], 'UAI остался от второго номера');
    assert.strictEqual(out.min_price, 1);
}

// --- 3) scope = 'hotel' -------------------------------------------------------
async function scopeHotel() {
    stub.rts = [rt({ exclusive: true, exclusiveScope: 'hotel' })];
    const out = await inject.injectRooms(ltData(), { requestId: 'req3', hotelId: 123, searchType: 'hotel' });
    assert.strictEqual(out.result.length, 1, 'номер без наших предложений убран из выдачи');
    const src = out.result[0];
    assert.strictEqual(src.room.id, 501);
    assert.strictEqual(ltOffers(src).length, 0); assert.strictEqual(ourOffers(src).length, 1);
    assert.strictEqual(src.min_price, 1);
    assert.deepStrictEqual(out.filters.meals, [{ id: 'AI', min_price: 1 }], 'питание без предложений убрано из фильтров');
    assert.strictEqual(out.min_price, 1, 'минимум отеля — наша цена');

    // наша цена ВЫШЕ LT: минимум отеля растёт (раньше он бы остался LT-шным)
    stub.rts = [rt({ exclusive: true, exclusiveScope: 'hotel', fixedPrice: 150000, pricing: normalizePricing({ mode: 'fixed', fixedPrice: 150000 }) })];
    const up = await inject.injectRooms(ltData(), { requestId: 'req3b', hotelId: 123, searchType: 'hotel' });
    assert.strictEqual(up.result.length, 1); assert.strictEqual(up.result[0].min_price, 150000);
    assert.strictEqual(up.min_price, 150000, 'минимум отеля пересчитан вверх');
    assert.deepStrictEqual(up.filters.meals, [{ id: 'AI', min_price: 150000 }]);

    // exclusive без вставки наших (Room Type без цены): предложения LT всё равно скрываются
    stub.rts = [rt({ exclusive: true, exclusiveScope: 'hotel', pricing: null, pricingMode: 'rule', fixedPrice: null })];
    const before = stub.offerMap.length;
    const empty = await inject.injectRooms(ltData(), { requestId: 'req3c', hotelId: 123, searchType: 'hotel' });
    assert.strictEqual(empty.result.length, 0, 'нечего продавать — номеров в выдаче нет');
    assert.strictEqual(stub.offerMap.length, before, 'карта предложений не растёт без вставки');
}

// --- 4) applyExclusive точечно ------------------------------------------------
function applyExclusiveUnit() {
    // наше предложение не удаляется никогда
    const rooms = [mkRoom(501, 'r1')];
    rooms[0].offers.AI.unshift({ id: 't9-1-x', price: 1, lt_extras: { totus: { custom: true, roomTypeId: 9 } } });
    const r1 = inject.applyExclusive(rooms, [rt({ exclusive: true, exclusiveScope: 'room' })]);
    assert.deepStrictEqual(r1, { applied: true, scope: 'room', hidden: 3, dropped: 0 });
    assert.deepStrictEqual(rooms[0].offers.AI.map((o) => o.id), ['t9-1-x']);
    // номер, не попадающий под scope='room', не трогаем
    const other = [mkRoom(777, 'r7')];
    assert.deepStrictEqual(inject.applyExclusive(other, [rt({ exclusive: true, exclusiveScope: 'room' })]), { applied: false, scope: 'room', hidden: 0, dropped: 0 });
    assert.strictEqual(ltOffers(other[0]).length, 3);
    // неактивный Room Type с флагом — не в счёт
    assert.strictEqual(inject.applyExclusive([mkRoom(501, 'r1')], [rt({ exclusive: true, active: false })]).applied, false);
    // scope='hotel': номер целиком выпадает
    const all = [mkRoom(501, 'r1'), mkRoom(502, 'r2')];
    const r2 = inject.applyExclusive(all, [rt({ exclusive: true, exclusiveScope: 'hotel' })]);
    assert.deepStrictEqual(r2, { applied: true, scope: 'hotel', hidden: 6, dropped: 2 });
    assert.strictEqual(all.length, 0);
    // свод по Room Type
    const ex = store.exclusiveFromRoomTypes([rt({ exclusive: true }), rt({ id: 10, sourceRoomId: 777, exclusive: true }), rt({ id: 11, exclusive: false, sourceRoomId: 999 })]);
    assert.deepStrictEqual([...ex.rooms].sort((a, b) => a - b), [501, 777]); assert.strictEqual(ex.wholeHotel, false);
    assert.strictEqual(store.exclusiveFromRoomTypes([rt({ exclusive: true, exclusiveScope: 'hotel' })]).wholeHotel, true);
    assert.deepStrictEqual(store.exclusiveFromRoomTypes([]), { rooms: new Set(), wholeHotel: false });
}

// --- 5) package_details для НЕ нашего tour_id ---------------------------------
const origExclusiveFor = store.exclusiveFor;
async function foreignPackage() {
    const ltPkg = (hotelId, roomId) => ({ success: true, package: { id: 'LT-555', price: 98900, nights_count: 7, hotel: { id: hotelId, room_id: roomId } } });
    assert.strictEqual(flow.extractHotelId(ltPkg(123, 501)), 123);
    assert.strictEqual(flow.extractHotelId({ package: { hotel_id: 9022465 } }), 9022465);
    assert.strictEqual(flow.extractHotelId({}), null);
    assert.strictEqual(flow.extractRoomId(ltPkg(123, 501)), 501);
    assert.strictEqual(flow.extractRoomId({ package: { room: { id: 77 } } }), 77);

    // обычный отель: exclusive выключен → ни одной блокировки
    store.exclusiveFor = async () => ({ rooms: new Set(), wholeHotel: false });
    assert.strictEqual(await flow.afterForeignPackageDetails(ltPkg(999, 501)), null, 'обычный отель — ответ LT не трогаем');
    // exclusive scope='hotel'
    store.exclusiveFor = async (id) => (Number(id) === 123 ? { rooms: new Set(), wholeHotel: true } : { rooms: new Set(), wholeHotel: false });
    const blocked = await flow.afterForeignPackageDetails(ltPkg(123, 501));
    assert.strictEqual(blocked.status, 410);
    assert.deepStrictEqual(blocked.body, { success: false, error: 'offer_expired', message: 'Предложение больше не доступно — обновите список номеров' });
    assert.strictEqual(await flow.afterForeignPackageDetails(ltPkg(999, 501)), null, 'другой отель — не трогаем');
    // exclusive scope='room': только исходный номер
    store.exclusiveFor = async (id) => (Number(id) === 123 ? { rooms: new Set([501]), wholeHotel: false } : { rooms: new Set(), wholeHotel: false });
    assert.ok(await flow.afterForeignPackageDetails(ltPkg(123, 501)), 'номер под запретом → 410');
    assert.strictEqual(await flow.afterForeignPackageDetails(ltPkg(123, 502)), null, 'другой номер отеля — продаётся');
    assert.strictEqual(await flow.afterForeignPackageDetails({ package: { id: 'x', hotel: { id: 123 } } }), null, 'номер не определён → не блокируем');
    // наше предложение сюда не попадает
    assert.strictEqual(await flow.afterForeignPackageDetails(Object.assign(ltPkg(123, 501), { totus_room: { roomTypeId: 9 } })), null);
    assert.strictEqual(await flow.afterForeignPackageDetails(null), null);
    // ошибка БД не ломает продажу
    store.exclusiveFor = async () => { throw new Error('db down'); };
    assert.strictEqual(await flow.afterForeignPackageDetails(ltPkg(123, 501)), null, 'ошибка проверки → ответ LT как есть');
    store.exclusiveFor = origExclusiveFor;
}

// --- 6) админка: валидация и сериализация -------------------------------------
async function adminChecks() {
    const settings = { ...store.DEFAULT_SETTINGS };
    const base = { hotelId: 123, sourceRoomId: 501, content: { nameRu: 'Arlekino Deluxe' }, pricingMode: 'fixed', fixedPrice: 1 };
    let v = await ctrl._internal.validateRoomType({ ...base }, settings, null);
    assert.ok(!v.error, v.error); assert.strictEqual(v.value.exclusive, false, 'по умолчанию выключено'); assert.strictEqual(v.value.exclusiveScope, 'room');
    v = await ctrl._internal.validateRoomType({ ...base, exclusive: true }, settings, null);
    assert.strictEqual(v.value.exclusive, true); assert.strictEqual(v.value.exclusiveScope, 'room', 'область по умолчанию — только номер');
    v = await ctrl._internal.validateRoomType({ ...base, exclusive: 1, exclusiveScope: 'hotel' }, settings, null);
    assert.strictEqual(v.value.exclusive, true); assert.strictEqual(v.value.exclusiveScope, 'hotel');
    v = await ctrl._internal.validateRoomType({ ...base, exclusive: '1', exclusive_scope: 'hotel' }, settings, null);
    assert.strictEqual(v.value.exclusive, true); assert.strictEqual(v.value.exclusiveScope, 'hotel', 'snake_case тоже принимаем');
    v = await ctrl._internal.validateRoomType({ ...base, exclusive: true, exclusiveScope: 'city' }, settings, null);
    assert.strictEqual(v.error, 'exclusive_scope_invalid');
    // PUT без полей — не меняем
    const existing = { ...rt({ exclusive: true, exclusiveScope: 'hotel' }), hotelName: 'Rixos', content: { nameRu: 'Old' } };
    v = await ctrl._internal.validateRoomType({}, settings, existing);
    assert.strictEqual(v.value.exclusive, true); assert.strictEqual(v.value.exclusiveScope, 'hotel', 'PUT без полей — флаг не меняется');
    v = await ctrl._internal.validateRoomType({ exclusive: false }, settings, existing);
    assert.strictEqual(v.value.exclusive, false, 'выключить можно явно');
    // change-log видит флаг
    assert.deepStrictEqual(Object.keys(ctrl._internal.diff({ ...existing }, { ...existing, exclusive: false, exclusiveScope: 'room' })), ['exclusive', 'exclusiveScope']);
    // сериализация строки БД
    const row = { id: 1, hotel_id: 123, source_room_id: 501, rule_type: null, rounding: 1, pricing_mode: 'fixed', fixed_price: 1, name_ru: 'x', active: 1 };
    assert.strictEqual(store.serializeRoomType({ ...row }, settings).exclusive, false, 'строка до миграции — флаг выключен');
    assert.strictEqual(store.serializeRoomType({ ...row }, settings).exclusiveScope, 'room');
    const on = store.serializeRoomType({ ...row, exclusive: 1, exclusive_scope: 'hotel' }, settings);
    assert.strictEqual(on.exclusive, true); assert.strictEqual(on.exclusiveScope, 'hotel');
}

// --- 7) кэш exclusive-отелей: без колонок миграции — ни одного запроса ---------
async function cacheChecks() {
    store.invalidateExclusiveCache();
    dbCalls.length = 0;
    const map = await store.exclusiveMap(true);
    assert.strictEqual(map.size, 0, 'без миграции exclusive выключен');
    assert.strictEqual(dbCalls.filter((q) => /exclusive/i.test(q)).length, 0, 'без колонок — ни одного запроса');
    const ex = await store.exclusiveFor(123);
    assert.deepStrictEqual(ex, { rooms: new Set(), wholeHotel: false });
}

Promise.resolve()
    .then(defaultUnchanged).then(scopeRoom).then(scopeHotel)
    .then(applyExclusiveUnit).then(foreignPackage).then(adminChecks).then(cacheChecks)
    .then(() => { console.log('ALL EXCLUSIVE CHECKS PASSED'); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
