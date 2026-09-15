// Проверка диагностики наших Room Type без БД и сети: node scripts/check-custom-rooms-diag.js
// Причины пропуска в inject.js (no_pricing / search_type / source_room_missing / no_offers / offer_map_failed),
// запасная связь по названию номера, сериализация last_skip_reason, счётчики middleware, ответ GET /api/admin/rooms/diagnostics.
// Основные проверки витрины/бронирований — scripts/check-custom-rooms.js.
'use strict';
const assert = require('assert');
process.env.DB_HOST = process.env.DB_HOST || 'localhost';
process.env.JWT_SECRET = process.env.JWT_SECRET || 's1';

const dbMod = require('../db');
dbMod.query = async (sql) => { throw new Error(`fake db: ${String(sql).slice(0, 40)}`); };
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

const { normalizeRule, normalizePricing } = require('../lib/customRooms/pricing');
const inject = require('../lib/customRooms/inject');
const store = require('../lib/customRooms/store');
const diag = require('../lib/customRooms/diag');
const ctrl = require('../controllers/customRooms.controller');
const mw = require('../middleware/customRooms');

// --- данные: номер LT с предложениями Coral/Anex (нашего оператора нет) ---
const mkRoom = () => ({
    ID: 'r1', min_price: 97500, bonus_count: 0, cashback_identifier: null,
    meal_types: [{ id: 'AI', min_price: 97500, description: 'Всё включено' }, { id: 'UAI', min_price: 112300, description: 'Ультра' }],
    room: { id: 501, name_ru: 'Deluxe Room Sea View', name_en: 'Deluxe', area: 38, facilities: [], images: [{ x900: 'https://lt/1.jpg' }] },
    offers: {
        AI: [{ id: '8001', price: 98900, nights_count: 7, start_date: '2026-10-12', operator_id: 33, operator_name: 'Coral Travel' }, { id: '8002', price: 97500, nights_count: 7, start_date: '2026-10-12', operator_id: 44, operator_name: 'Anex' }],
        UAI: [{ id: '8003', price: 112300, nights_count: 7, start_date: '2026-10-12', operator_id: 33, operator_name: 'Coral Travel' }],
    },
    lt_extras: {},
});
const fixedRt = (extra) => ({ id: 9, hotelId: 123, hotelName: 'Rixos', sourceRoomId: 501, sourceRoomName: 'Deluxe Room Sea View', sourceSnapshot: null, operatorIds: [], operatorNames: [], mealTypes: null, sortOrder: 0, badge: 'Totus', packageTypes: [], active: true,
    pricingMode: 'fixed', fixedPrice: 1, fixedPriceUnit: 'total', operatorName: 'Arlekino', operatorId: null, rule: null,
    pricing: normalizePricing({ mode: 'fixed', fixedPrice: 1 }), content: { nameRu: 'Arlekino Deluxe' }, last: { seenAt: null }, lastSkipReason: null, lastCheckedAt: null, ...(extra || {}) });
const ltData = (rooms) => ({ search_type: 1, min_price: 97500, currency_code: 'RUB', result: rooms, filters: { meals: [{ id: 'AI', min_price: 97500 }] } });

// --- подмена store (без БД) ---
const stub = { rts: [], settings: { ...store.DEFAULT_SETTINGS }, offerMap: [], seen: [], checked: [] };
const origMarkChecked = store.markChecked;
store.getSettings = async () => stub.settings;
store.activeRoomTypesForHotel = async () => stub.rts;
store.saveOfferMap = async (entries) => { stub.offerMap.push(...entries); };
store.logPrice = async () => {};
store.touchLastSeen = async (id, info) => { stub.seen.push({ id, ...info }); };
store.markChecked = async (id, reason) => { stub.checked.push({ id, reason }); return true; };
const lastSkip = () => (stub.checked.length ? stub.checked[stub.checked.length - 1].reason : undefined);
const ctx = (searchType) => ({ requestId: 'req-diag', hotelId: '123', searchType: searchType || 'package' }); // hotel_id с сайта — строка

async function injectReasons() {
    // вставлена: id совпал, hotel_id строкой, search_type package (как у сайта)
    stub.rts = [fixedRt()];
    let out = await inject.injectRooms(ltData([mkRoom()]), ctx());
    assert.strictEqual(out.result.length, 2, 'вставлена при package и строковом hotel_id'); assert.strictEqual(out.result[1].ID, 'totus-9');
    assert.strictEqual(out.result[1].offers.AI[0].start_date, '2026-10-12', 'клон сохраняет start_date (сайт фильтрует по дате)'); assert.strictEqual(out.result[1].offers.AI[0].nights_count, 7);
    assert.strictEqual(stub.checked.length, 0, 'вставлена — причина не пишется (сбрасывает touchLastSeen)'); assert.strictEqual(stub.seen.length, 1);
    assert.strictEqual(diag.stats.hotelsRoomsInjected, 1, 'счётчик вставок');

    // source_room_missing с перечнем id выдачи (sourceRoomName не совпадает ни с одним номером)
    stub.rts = [fixedRt({ sourceRoomId: 999, sourceRoomName: 'Standard', sourceSnapshot: null })];
    out = await inject.injectRooms(ltData([mkRoom()]), ctx());
    assert.strictEqual(out.result.length, 1);
    assert.strictEqual(lastSkip(), 'source_room_missing (source 999; ids in result: 501)');

    // запасная связь по названию: LT отдал тот же номер под другим room.id
    stub.checked = []; stub.seen = [];
    stub.rts = [fixedRt({ sourceRoomId: 777 })];
    out = await inject.injectRooms(ltData([mkRoom()]), ctx('hotel'));
    assert.strictEqual(out.result.length, 2, 'id не совпал, название совпало → вставлена'); assert.strictEqual(stub.checked.length, 0);
    assert.deepStrictEqual(inject.findSourceIndex([mkRoom()], new Map([[501, 0]]), fixedRt({ sourceRoomId: 777, sourceRoomName: '  deluxe room   sea view ' })), { idx: 0, by: 'name' }, 'регистр/пробелы не важны');
    assert.deepStrictEqual(inject.findSourceIndex([mkRoom()], new Map([[501, 0]]), fixedRt({ sourceRoomId: 777, sourceRoomName: null, sourceSnapshot: { name_en: 'DELUXE' } })), { idx: 0, by: 'name' }, 'по name_en из снимка');
    assert.strictEqual(inject.findSourceIndex([mkRoom(), { ...mkRoom(), room: { id: 502, name_ru: 'Deluxe Room Sea View' } }], new Map([[501, 0], [502, 1]]), fixedRt({ sourceRoomId: 777 })), null, 'два номера с таким названием — не угадываем');
    assert.strictEqual(inject.findSourceIndex([mkRoom()], new Map([[501, 0]]), fixedRt({ sourceRoomId: 777, sourceRoomName: null, sourceSnapshot: null })), null, 'нет названия — нет связи');
    assert.deepStrictEqual(inject.findSourceIndex([mkRoom()], new Map([[501, 0]]), fixedRt()), { idx: 0, by: 'id' });

    // no_offers: нет предложений / нет нужного питания
    stub.rts = [fixedRt()];
    out = await inject.injectRooms(ltData([{ ...mkRoom(), offers: {} }]), ctx());
    assert.strictEqual(out.result.length, 1); assert.strictEqual(lastSkip(), 'no_offers (у источника нет предложений)');
    stub.rts = [fixedRt({ mealTypes: ['HB'] })];
    out = await inject.injectRooms(ltData([mkRoom()]), ctx());
    assert.strictEqual(lastSkip(), 'no_offers (у источника питание AI,UAI, требуется HB)');

    // search_type: hotelOnly / packageTypes
    stub.settings = { ...store.DEFAULT_SETTINGS, hotelOnly: true }; stub.rts = [fixedRt()];
    out = await inject.injectRooms(ltData([mkRoom()]), ctx('package'));
    assert.strictEqual(out.result.length, 1); assert.strictEqual(lastSkip(), 'search_type (package; настройка hotelOnly=true)');
    stub.settings = { ...store.DEFAULT_SETTINGS }; stub.rts = [fixedRt({ packageTypes: ['hotel'] })];
    out = await inject.injectRooms(ltData([mkRoom()]), ctx('package'));
    assert.strictEqual(lastSkip(), 'search_type (package; packageTypes [hotel])');
    out = await inject.injectRooms(ltData([mkRoom()]), ctx('hotel'));
    assert.strictEqual(out.result.length, 2, 'packageTypes [hotel] при hotel — вставлена');

    // no_pricing: раньше отфильтровывалось молча в store.activeRoomTypesForHotel
    stub.rts = [fixedRt({ pricingMode: 'rule', fixedPrice: null, pricing: null, rule: null })];
    out = await inject.injectRooms(ltData([mkRoom()]), ctx());
    assert.strictEqual(out.result.length, 1); assert.strictEqual(lastSkip(), 'no_pricing (mode rule: fixed_price или правило не заданы)');
    // rule-режим: pricing null, но rule есть → считается по правилу (обратная совместимость)
    stub.rts = [fixedRt({ pricingMode: 'rule', fixedPrice: null, pricing: null, rule: normalizeRule({ ruleType: 'percent', ruleValue: -10 }, {}) })];
    out = await inject.injectRooms(ltData([mkRoom()]), ctx());
    assert.strictEqual(out.result[1].offers.AI[0].price, 87750);

    // сбой карты предложений → исключение (клиент получит оригинал LT) + причина offer_map_failed
    stub.checked = []; stub.rts = [fixedRt()];
    const okSave = store.saveOfferMap;
    store.saveOfferMap = async () => { throw new Error('Data too long'); };
    await assert.rejects(() => inject.injectRooms(ltData([mkRoom()]), ctx()), /Data too long/);
    store.saveOfferMap = okSave;
    assert.strictEqual(lastSkip(), 'offer_map_failed (Data too long)');

    // несколько Room Type одного отеля: у каждой своя строка/причина
    stub.checked = [];
    stub.rts = [fixedRt({ id: 9 }), fixedRt({ id: 10, sourceRoomId: 999, sourceRoomName: 'Other' })];
    out = await inject.injectRooms(ltData([mkRoom()]), ctx());
    assert.strictEqual(out.result.length, 2); assert.deepStrictEqual(stub.checked.map((c) => c.id), [10]);
    const lines = diag.snapshot().events.map((e) => e.line);
    assert.ok(lines.some((l) => /^\[custom-rooms\] hotel 123: rt 9 — injected \(1 offer\(s\), fixed, source room 501\)$/.test(l)), `строка injected: ${lines.slice(-3).join(' | ')}`);
    assert.ok(lines.some((l) => /^\[custom-rooms\] hotel 123: rt 10 — skipped:source_room_missing/.test(l)), 'строка skipped');
}

// --- сериализация last_skip_reason / last_checked_at; markChecked без колонок — no-op ---
{
    const row = { id: 3, hotel_id: 123, source_room_id: 501, name_ru: 'X', pricing_mode: 'fixed', fixed_price: '1.00', rule_type: null, rule_value: null, active: 1, last_skip_reason: 'source_room_missing (source 501; ids in result: 9)', last_checked_at: '2026-09-15T10:00:00Z' };
    const s1 = store.serializeRoomType(row, store.DEFAULT_SETTINGS);
    assert.strictEqual(s1.lastSkipReason, row.last_skip_reason); assert.strictEqual(s1.lastCheckedAt, '2026-09-15T10:00:00.000Z');
    assert.strictEqual(s1.last.skipReason, row.last_skip_reason); assert.strictEqual(s1.last.checkedAt, s1.lastCheckedAt);
    const s2 = store.serializeRoomType({ ...row, last_skip_reason: undefined, last_checked_at: undefined }, store.DEFAULT_SETTINGS);
    assert.strictEqual(s2.lastSkipReason, null, 'без колонок диагностики — null'); assert.strictEqual(s2.lastCheckedAt, null);
}

async function diagChecks() {
    assert.strictEqual(await origMarkChecked(3, 'x'), false, 'без колонок диагностики markChecked — no-op (колонки проверяет ensureReady)');
    // middleware: счётчик любого запроса (признак app.use в app.js); WATCHED-путь при DISABLED → notReadySkips
    const before = { ...diag.stats };
    await new Promise((resolve) => mw({ method: 'GET', path: '/references/hotels', query: {} }, {}, resolve));
    assert.strictEqual(diag.stats.middlewareCalls, before.middlewareCalls + 1); assert.strictEqual(diag.stats.watchedCalls, before.watchedCalls);
    const okReady = store.isReady;
    store.isReady = async () => false;
    await new Promise((resolve) => mw({ method: 'GET', path: '/hotels-rooms', query: { request_id: 'r', hotel_id: '1' } }, {}, resolve));
    store.isReady = okReady;
    assert.strictEqual(diag.stats.watchedCalls, before.watchedCalls + 1); assert.strictEqual(diag.stats.notReadySkips, before.notReadySkips + 1);
    // /hotels-rooms через wrapJson: счётчик и hotel_id/search_type последнего запроса
    store.isReady = async () => true;
    store.getSearch = async () => ({ requestId: 'r', searchType: 'package', params: {} });
    stub.rts = [fixedRt()]; stub.checked = [];
    const sent = [];
    const res = { statusCode: 200, json: (b) => { sent.push(b); return res; } };
    await new Promise((resolve) => mw({ method: 'GET', path: '/hotels-rooms', query: { request_id: 'r', hotel_id: '123' } }, res, resolve));
    res.json(ltData([mkRoom()]));
    await new Promise((r) => setTimeout(r, 20));
    store.isReady = okReady;
    assert.strictEqual(sent.length, 1); assert.strictEqual(sent[0].result.length, 2, 'ответ сайту с нашей комнатой');
    assert.strictEqual(diag.stats.lastHotelsRoomsHotelId, '123'); assert.strictEqual(diag.stats.lastHotelsRoomsSearchType, 'package'); assert.ok(diag.stats.lastInjectAt);

    // GET /diagnostics: DISABLED → подсказка про миграцию; ready → подсказки по каждой Room Type
    const call = async (query) => { let out; await ctrl.diagnostics({ query: query || {} }, { json: (b) => { out = b; }, status() { return this; } }); return out; };
    store.getReadyState = async (force) => ({ ready: false, disabledReason: 'columns missing: custom_room_types.pricing_mode', missingTables: [], missingColumns: ['custom_room_types.pricing_mode'], diagColumns: false, checkedAt: 'x', error: null, forced: Boolean(force) });
    let d = await call({ recheck: '1' });
    assert.strictEqual(d.ready, false); assert.strictEqual(d.disabledReason, 'columns missing: custom_room_types.pricing_mode');
    assert.strictEqual(d.appJsHooks.middleware.mounted, true); assert.strictEqual(d.appJsHooks.adminRoutes, true); assert.strictEqual(d.settings, null);
    assert.ok(d.hints.some((h) => /run-custom-rooms-migration\.js и pm2 restart api/.test(h)), 'подсказка про миграцию');
    store.getReadyState = async () => ({ ready: true, disabledReason: null, missingTables: [], missingColumns: [], diagColumns: true, checkedAt: 'x', error: null });
    store.getSettings = async () => ({ ...store.DEFAULT_SETTINGS, hotelOnly: true });
    store.listActiveRoomTypes = async () => [
        fixedRt({ id: 9, lastCheckedAt: '2026-09-15T10:00:00.000Z', lastSkipReason: 'search_type (package; настройка hotelOnly=true)' }),
        fixedRt({ id: 10, packageTypes: ['hotel'], pricing: null }),
    ];
    d = await call();
    assert.strictEqual(d.ready, true); assert.strictEqual(d.settings.hotelOnly, true); assert.strictEqual(d.activeRoomTypes.length, 2);
    assert.deepStrictEqual(Object.keys(d.activeRoomTypes[0]), ['id', 'hotelId', 'hotelName', 'sourceRoomId', 'sourceRoomName', 'pricingMode', 'pricingOk', 'pricingLabel', 'packageTypes', 'lastSeenAt', 'lastCheckedAt', 'lastSkipReason']);
    assert.strictEqual(d.activeRoomTypes[0].lastSkipReason, 'search_type (package; настройка hotelOnly=true)'); assert.strictEqual(d.activeRoomTypes[0].pricingLabel, '1 ₽ (фикс.)');
    assert.strictEqual(d.activeRoomTypes[1].pricingOk, false);
    assert.ok(d.hints.some((h) => /Показывать только при поиске отелей/.test(h)), 'подсказка hotelOnly');
    assert.ok(d.hints.some((h) => /#9 .*последний раз пропущен — search_type/.test(h)), 'подсказка по lastSkipReason');
    assert.ok(d.hints.some((h) => /#10 .*без цены\/правила/.test(h)), 'подсказка no_pricing');
    assert.ok(d.hints.some((h) => /#10 .*только при поиске hotel/.test(h)), 'подсказка packageTypes');
    assert.ok(d.hints.some((h) => /#10 .*ни один запрос \/hotels-rooms/.test(h)), 'подсказка «ещё не проверялся»');
    assert.ok(Array.isArray(d.events) && d.events.length > 0 && typeof d.appJsHooks.middleware.hotelsRoomsSeen === 'number' && d.appJsHooks.middleware.startedAt);
    assert.strictEqual(d.env.hotelSearchTypeCodes, '1'); // LT: 0 — package, 1 — hotel
    store.getSettings = async () => stub.settings;
    // ready, но колонок диагностики нет — подсказка повторить миграцию
    store.getReadyState = async () => ({ ready: true, disabledReason: null, missingTables: [], missingColumns: ['custom_room_types.last_skip_reason (диагностика, необязательно)'], diagColumns: false, checkedAt: 'x', error: null });
    store.listActiveRoomTypes = async () => [];
    d = await call();
    assert.ok(d.hints.some((h) => /last_skip_reason/.test(h)) && d.hints.some((h) => /Нет активных Room Type/.test(h)));
}

// --- миграция: колонки диагностики объявлены идемпотентно ---
{
    const src = require('fs').readFileSync(require('path').join(__dirname, 'run-custom-rooms-migration.js'), 'utf8');
    assert.ok(/\['last_skip_reason', 'VARCHAR\(255\) NULL'\]/.test(src) && /\['last_checked_at', 'DATETIME NULL'\]/.test(src), 'ROOM_TYPE_COLUMNS содержит колонки диагностики');
    assert.ok(/last_skip_reason VARCHAR\(255\) NULL,\s*last_checked_at DATETIME NULL/.test(src), 'CREATE TABLE тоже содержит их');
}

injectReasons().then(diagChecks).then(() => {
    console.log('ALL CUSTOM ROOMS DIAG CHECKS PASSED');
    process.exit(0);
}).catch((e) => { console.error(e); process.exit(1); });
