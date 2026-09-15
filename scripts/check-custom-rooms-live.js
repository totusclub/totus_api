// Проверка витрины наших Room Type на РЕАЛЬНОМ ответе Level.Travel (без БД и сети):
//   node scripts/check-custom-rooms-live.js
// Данные — scripts/fixtures/hotel_rooms_sample.json: урезанный ответ GET /hotels-rooms прод-API за 15.09.2026
// (Rixos Premium Seagate, hotel_id 9022465, Москва → Египет, 29.09.2026, 7 ночей, 2 взрослых, search_type=package):
// номер 101879 «Улучшенный номер Aqua» с предложениями шести операторов (в т.ч. Level.Travel 78 за 258 996 ₽),
// номер 101880 и «динамический» номер LT с room.id = 0 и hash-ID (такие есть в поиске сайта с hotel_ids=<id>).
// Особенности реального payload, которые здесь закреплены: lt_extras: null, labels: null у предложений,
// search_type: 0 (package) / 1 (hotel) в теле ответа, ID и hotel_id — строки, room.id = 0 у части номеров.
// Основные проверки — scripts/check-custom-rooms.js, диагностика — scripts/check-custom-rooms-diag.js.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
process.env.DB_HOST = process.env.DB_HOST || 'localhost';
process.env.JWT_SECRET = process.env.JWT_SECRET || 's1';

const dbMod = require('../db');
dbMod.query = async (sql) => { throw new Error(`fake db: ${String(sql).slice(0, 40)}`); };

const { normalizePricing, normalizeRule } = require('../lib/customRooms/pricing');
const inject = require('../lib/customRooms/inject');
const store = require('../lib/customRooms/store');
const diag = require('../lib/customRooms/diag');
const mw = require('../middleware/customRooms');

const FIXTURE = path.join(__dirname, 'fixtures', 'hotel_rooms_sample.json');
const sample = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const ltBody = () => JSON.parse(JSON.stringify(sample));
const HOTEL_ID = '9022465'; // сайт шлёт hotel_id строкой
const SOURCE_ROOM_ID = 101879;

// --- подмена store (без БД) ---
const stub = { rts: [], settings: { ...store.DEFAULT_SETTINGS }, offerMap: [], seen: [], checked: [] };
store.getSettings = async () => stub.settings;
store.activeRoomTypesForHotel = async (hotelId) => stub.rts.filter((r) => r.hotelId === Number(hotelId));
store.saveOfferMap = async (entries) => { stub.offerMap.push(...entries); };
store.logPrice = async () => {};
store.touchLastSeen = async (id, info) => { stub.seen.push({ id, ...info }); };
store.markChecked = async (id, reason) => { stub.checked.push({ id, reason }); return true; };
const reset = () => { stub.rts = []; stub.offerMap = []; stub.seen = []; stub.checked = []; stub.settings = { ...store.DEFAULT_SETTINGS }; };
const lastSkip = () => (stub.checked.length ? stub.checked[stub.checked.length - 1].reason : undefined);

/** Room Type в том виде, как его отдаёт store.serializeRoomType для строки, созданной админкой v2 (fixed 1 ₽, «Arlekino», без операторов/питания, любой тип поиска). */
function rtFixed(extra) {
    const base = {
        id: 1, hotelId: 9022465, hotelName: 'Rixos Premium Seagate', hotelStars: 5, hotelCity: 'Шарм-эль-Шейх',
        sourceRoomId: SOURCE_ROOM_ID, sourceRoomName: 'Улучшенный номер Aqua', sourceSnapshot: sample.result[0].room,
        operatorIds: [], operatorNames: [], mealTypes: null,
        pricingMode: 'fixed', fixedPrice: 1, fixedPriceUnit: 'total', operatorName: 'Arlekino', operatorId: null, effectiveOperatorId: 990001,
        pricing: normalizePricing({ mode: 'fixed', fixedPrice: 1, fixedPriceUnit: 'total', rule: null }), previewPrice: 1,
        content: { nameRu: 'Улучшенный номер Aqua (Arlekino)', nameEn: null, accommodation: null, area: null, view: null, description: null, facilities: [], images: [] },
        rule: null, ruleType: null, ruleValue: null, rounding: 1, minPrice: null, maxPrice: null, minMarginType: null, minMarginValue: null,
        packageTypes: [], badge: null, active: true, sortOrder: 0,
        last: { providerPrice: null, finalPrice: null, operator: null, seenAt: null, marginClamped: false, skipReason: null, checkedAt: null },
        lastSkipReason: null, lastCheckedAt: null, createdBy: 'admin', createdAt: null, updatedAt: null,
    };
    return Object.assign(base, extra || {});
}
/** Строка v1 (до миграции v2), как её отдаёт serializeRoomType: правило −10 % и замещение Level.Travel (operator_ids [78]) — Room Type #5 на проде. */
function rtRuleV1(extra) {
    const rule = normalizeRule({ ruleType: 'percent', ruleValue: -10, rounding: 1 }, {});
    return rtFixed(Object.assign({ id: 5, operatorIds: [78], operatorNames: ['Level.Travel'], pricingMode: 'rule', fixedPrice: null, rule, ruleType: 'percent', ruleValue: -10, effectiveOperatorId: 990005,
        pricing: normalizePricing({ mode: 'rule', fixedPrice: null, fixedPriceUnit: 'total', rule }), content: { nameRu: 'Улучшенный номер Aqua', nameEn: 'Superior Room Aqua', facilities: [], images: [] } }, extra || {}));
}
const ctx = (searchType, requestId) => ({ requestId: requestId || 'MjEzfDIyNXwwfDEwNTZ8fDIwMjYtMDktMjksMjAyNi0wOS0yOXwwfDcsN3wyfDB8fHwwfDB8fHwxMjUz', hotelId: HOTEL_ID, searchType: searchType === undefined ? 'package' : searchType });
const ours = (out, id) => out.result.find((r) => r.ID === `totus-${id}`);
const offersOf = (room) => Object.values(room.offers).flat();

async function checks() {
    // 0. сам fixture: реальные особенности payload
    {
        assert.strictEqual(sample.search_type, 0, 'package-поиск LT: search_type 0');
        assert.ok(sample.result.some((r) => r.room.id === 0), 'в выдаче есть номер с room.id = 0');
        assert.ok(offersOf(sample.result[0]).every((o) => o.lt_extras === null && o.labels === undefined), 'lt_extras: null у предложений');
        assert.strictEqual(typeof sample.result[0].ID, 'string');
    }

    // 1. Room Type v2 (fixed 1 ₽, «Arlekino») на реальном payload, ctx как у сайта → вставлена сразу после источника, источник цел
    reset(); stub.rts = [rtFixed()];
    let out = await inject.injectRooms(ltBody(), ctx('package'));
    assert.strictEqual(out.result.length, sample.result.length + 1, 'одна наша комната добавлена');
    assert.strictEqual(out.result[0].room.id, SOURCE_ROOM_ID, 'источник на месте');
    assert.strictEqual(out.result[1].ID, 'totus-1', 'наша комната сразу после источника');
    let v = ours(out, 1);
    assert.strictEqual(v.room.id, 10000001);
    assert.strictEqual(v.min_price, 1);
    assert.deepStrictEqual(Object.keys(v.offers), ['UAI']);
    assert.strictEqual(v.offers.UAI.length, 1, 'шаблон — одно самое дешёвое предложение источника (Level.Travel 258 996)');
    assert.strictEqual(v.offers.UAI[0].operator_name, 'Arlekino');
    assert.strictEqual(v.offers.UAI[0].operator_id, 990001);
    assert.strictEqual(v.offers.UAI[0].price, 1);
    assert.strictEqual(v.offers.UAI[0].price_per_night, 0, 'round(1 / 7)');
    assert.deepStrictEqual(v.offers.UAI[0].lt_extras.totus, { custom: true, roomTypeId: 1, sourceOfferId: '078-4a3340af5bd0fdf50d0272286c4773a4', meal: 'UAI', mode: 'fixed' });
    assert.strictEqual(v.offers.UAI[0].extras.best_price, false, 'метка best_price LT снята');
    assert.deepStrictEqual(v.labels, [], 'labels: null у источника → []');
    assert.strictEqual(offersOf(out.result[0]).length, 7, 'без operator_ids предложения источника не удаляются');
    assert.strictEqual(out.result[0].min_price, 258996);
    assert.strictEqual(out.filters.meals.find((m) => m.id === 'UAI').min_price, 1, 'фильтр питания — наша цена');
    assert.strictEqual(stub.offerMap.length, 1);
    assert.strictEqual(stub.offerMap[0].sourceOfferId, '078-4a3340af5bd0fdf50d0272286c4773a4');
    assert.strictEqual(stub.offerMap[0].operatorId, 78, 'в карте — реальный оператор шаблона (у кого покупаем)');
    assert.ok(stub.offerMap[0].requestId.length > 64, 'request_id LT (80 символов) длиннее VARCHAR(64) — режет store.saveOfferMap');
    assert.strictEqual(stub.checked.length, 0, 'причины пропуска нет');
    assert.strictEqual(stub.seen[0].providerPrice, 258996);

    // 2. searchType не определён (request_id не в custom_room_searches) — вставляется всё равно
    reset(); stub.rts = [rtFixed()];
    out = await inject.injectRooms(ltBody(), ctx(null));
    assert.ok(ours(out, 1), 'searchType null → без ограничений');
    // и при hotel
    reset(); stub.rts = [rtFixed()];
    out = await inject.injectRooms(ltBody(), ctx('hotel'));
    assert.ok(ours(out, 1));

    // 3. Room Type v1 (правило −10 %, operator_ids [78]) — как #5 на проде: цена 233 096, оригинал Level.Travel остаётся рядом
    reset(); stub.rts = [rtRuleV1()];
    out = await inject.injectRooms(ltBody(), ctx('package'));
    v = ours(out, 5);
    assert.ok(v, 'вставлена');
    assert.strictEqual(v.offers.UAI[0].price, 233096, '258 996 − 10 %');
    assert.strictEqual(v.offers.UAI[0].operator_id, 990005);
    assert.strictEqual(v.offers.UAI[0].lt_extras.totus.mode, 'rule');
    assert.strictEqual(offersOf(out.result[0]).length, 7, 'предложения источника не тронуты (с 15.09 показываются оба)');
    assert.ok(offersOf(out.result[0]).some((o) => o.operator_id === 78), 'оригинал Level.Travel (78) остался');
    assert.strictEqual(out.result[0].min_price, 258996, 'минимум источника не изменился');
    assert.strictEqual(out.filters.meals.find((m) => m.id === 'UAI').min_price, 233096);

    // 4. номер с room.id = 0 (hash-ID) не мешает: Room Type на источник 0 создать нельзя, но связь других номеров по id не ломается
    reset(); stub.rts = [rtFixed({ id: 2, sourceRoomId: 101880, sourceRoomName: 'Делюкс Aqua', sourceSnapshot: null, content: { nameRu: 'Делюкс Aqua (Arlekino)', facilities: [], images: [] } })];
    out = await inject.injectRooms(ltBody(), ctx('package'));
    v = ours(out, 2);
    assert.ok(v, 'вставлена для второго номера');
    assert.deepStrictEqual(Object.keys(v.offers), ['BB'], 'самое дешёвое предложение источника — BB 456 138');
    assert.strictEqual(out.result.indexOf(v), 2, 'после источника 101880');

    // 5. причины пропуска на реальном payload
    reset(); stub.rts = [rtFixed({ id: 3, sourceRoomId: 777777, sourceRoomName: 'Нет такого', sourceSnapshot: null })];
    out = await inject.injectRooms(ltBody(), ctx('package'));
    assert.strictEqual(out.result.length, sample.result.length);
    assert.ok(/^source_room_missing \(source 777777; ids in result: 101879,101880,0\)/.test(lastSkip()), lastSkip());
    reset(); stub.rts = [rtFixed({ id: 4, sourceRoomId: 777777, sourceRoomName: 'Делюкс Aqua', sourceSnapshot: null })];
    out = await inject.injectRooms(ltBody(), ctx('package'));
    assert.ok(ours(out, 4), 'запасная связь по названию номера');
    reset(); stub.rts = [rtFixed({ pricing: null, fixedPrice: null })]; // строка после backfill без цены
    out = await inject.injectRooms(ltBody(), ctx('package'));
    assert.strictEqual(lastSkip(), 'no_pricing (mode fixed: fixed_price или правило не заданы)');
    reset(); stub.rts = [rtFixed({ packageTypes: ['hotel'] })];
    out = await inject.injectRooms(ltBody(), ctx('package'));
    assert.strictEqual(lastSkip(), 'search_type (package; packageTypes [hotel])');
    out = await inject.injectRooms(ltBody(), ctx('hotel'));
    assert.ok(ours(out, 1), 'packageTypes [hotel] при поиске hotel — вставлена');
    reset(); stub.rts = [rtFixed({ mealTypes: ['AI'] })];
    out = await inject.injectRooms(ltBody(), ctx('package'));
    assert.strictEqual(lastSkip(), 'no_offers (у источника питание UAI, требуется AI)');

    // 6. middleware: search_type из тела ответа LT, когда request_id не сохранён (поиск начат не через /start-search: ассистент, устаревшая запись)
    //    LT: 0 — package, 1 — hotel (снято с прода 15.09.2026). Раньше по умолчанию считался код 2 → hotel-поиск принимался за package.
    store.getSearch = async () => null;
    const seenTypes = [];
    for (const [code, expected] of [[0, 'package'], [1, 'hotel']]) {
        const sent = [];
        const req = { method: 'GET', path: '/hotels-rooms', query: { request_id: 'r-' + code, hotel_id: HOTEL_ID } };
        const res = { statusCode: 200, json: (b) => { sent.push(b); return res; } };
        await new Promise((resolve) => { mw(req, res, () => { res.json({ ...ltBody(), search_type: code, result: [] }); setTimeout(resolve, 10); }); });
        seenTypes.push([code, diag.stats.lastHotelsRoomsSearchType]);
        assert.strictEqual(diag.stats.lastHotelsRoomsSearchType, expected, `search_type ${code} → ${expected}`);
    }
    console.log('search_type из тела LT:', JSON.stringify(seenTypes));
}

// middleware ждёт store.isReady()
store.isReady = async () => true;
checks().then(() => { console.log('ALL CUSTOM ROOMS LIVE-PAYLOAD CHECKS PASSED'); process.exit(0); }).catch((e) => { console.error(e); process.exit(1); });
