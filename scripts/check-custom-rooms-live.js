// Проверка витрины наших Room Type на РЕАЛЬНОМ ответе Level.Travel (без БД и сети):
//   node scripts/check-custom-rooms-live.js
// Данные — scripts/fixtures/hotel_rooms_sample.json: урезанный ответ GET /hotels-rooms прод-API за 15.09.2026
// (Rixos Premium Seagate, hotel_id 9022465, Москва → Египет, 29.09.2026, 7 ночей, 2 взрослых, search_type=package):
// номер 101879 «Улучшенный номер Aqua» с предложениями шести операторов (в т.ч. Level.Travel 78 за 258 996 ₽),
// номер 101880 и «динамический» номер LT с room.id = 0 и hash-ID (такие есть в поиске сайта с hotel_ids=<id>).
// Особенности реального payload, которые здесь закреплены: lt_extras: null, labels: null у предложений,
// search_type: 0 (package) / 1 (hotel) в теле ответа, ID и hotel_id — строки, room.id = 0 у части номеров.
// v3 (15.09): ОДИН номер — наши предложения («Arlekino», lt_extras.totus.custom) внутри исходного номера первыми, LT нетронуты,
// связь только по room.id (без fallback по названию), «от 1 ₽» при fixed 1 ₽ / «от 233 096 ₽» при −10 %.
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
const SOURCE = (out) => out.result.find((r) => Number(r.room && r.room.id) === SOURCE_ROOM_ID);
const offersOf = (room) => Object.values(room.offers).flat();
const arlekino = (room) => offersOf(room).filter(inject.isArlekinoOffer);
const levelTravel = (room) => offersOf(room).filter((o) => !inject.isArlekinoOffer(o));
const LT_IDS = sample.result[0].offers.UAI.map((o) => o.id);
const LT_PRICES = sample.result[0].offers.UAI.map((o) => o.price);

async function checks() {
    // 0. сам fixture: реальные особенности payload
    {
        assert.strictEqual(sample.search_type, 0, 'package-поиск LT: search_type 0');
        assert.ok(sample.result.some((r) => r.room.id === 0), 'в выдаче есть номер с room.id = 0');
        assert.ok(offersOf(sample.result[0]).every((o) => o.lt_extras === null && o.labels === undefined), 'lt_extras: null у предложений');
        assert.strictEqual(typeof sample.result[0].ID, 'string');
        assert.strictEqual(sample.result[0].lt_extras, null, 'lt_extras: null у номера');
        assert.strictEqual(LT_IDS.length, 7); assert.strictEqual(LT_PRICES[0], 258996);
    }

    // 1. Сценарий владельца (Rixos Premium Seagate 9022465, Room Type fixed 1 ₽ «Arlekino» на номер 101879 «Улучшенный номер Aqua»):
    //    ОДНА карточка номера, внутри — группа Arlekino (наше, первым) и группа Level.Travel (7 оригиналов), «от 1 ₽»
    reset(); stub.rts = [rtFixed()];
    let out = await inject.injectRooms(ltBody(), ctx('package'));
    assert.strictEqual(out.result.length, sample.result.length, 'v3: количество номеров не меняется — отдельной комнаты totus-* нет');
    assert.ok(!out.result.some((r) => String(r.ID).startsWith('totus-')), 'нет ID totus-*');
    assert.strictEqual(out.result.filter((r) => r.room && r.room.name_ru === 'Улучшенный номер Aqua').length, 1, 'на витрине один «Улучшенный номер Aqua»');
    let room = SOURCE(out);
    assert.strictEqual(out.result.indexOf(room), 0, 'источник на своём месте'); assert.strictEqual(room.ID, '13705');
    assert.strictEqual(room.room.name_ru, 'Улучшенный номер Aqua', 'карточка LT-шная: контент Room Type «(Arlekino)» не применяется');
    assert.deepStrictEqual(Object.keys(room.offers), ['UAI']);
    assert.strictEqual(room.offers.UAI.length, 8, '7 LT + 1 наше');
    const ours = arlekino(room);
    assert.strictEqual(ours.length, 1, 'одно наше предложение (шаблон — самое дешёвое: Level.Travel 258 996)');
    assert.strictEqual(room.offers.UAI[0], ours[0], 'наше — первым в offers[UAI]');
    assert.strictEqual(ours[0].operator_name, 'Arlekino'); assert.strictEqual(ours[0].operator_id, 990001);
    assert.strictEqual(ours[0].price, 1); assert.strictEqual(ours[0].price_per_night, 0, 'round(1 / 7)');
    assert.strictEqual(ours[0].nights_count, 7); assert.strictEqual(ours[0].start_date, '2026-09-29', 'клон проходит фильтры сайта по дате/ночам');
    assert.deepStrictEqual(ours[0].lt_extras.totus, { custom: true, roomTypeId: 1, sourceOfferId: '078-4a3340af5bd0fdf50d0272286c4773a4', meal: 'UAI', mode: 'fixed', source: 'arlekino' });
    assert.ok(inject.isVirtualOfferId(ours[0].id)); assert.ok(ours[0].link.includes(ours[0].id) && !ours[0].link.includes('078-4a3340af5bd0fdf50d0272286c4773a4'), 'link ведёт на наш tour_id');
    assert.strictEqual(ours[0].extras.best_price, false, 'метка best_price LT снята'); assert.strictEqual(ours[0].extras.instant_confirm, true, 'условия шаблона сохранены');
    // LT нетронуты: количество, id, цены, порядок, метки
    const lt = levelTravel(room);
    assert.deepStrictEqual(lt.map((o) => o.id), LT_IDS, 'id и порядок LT как были');
    assert.deepStrictEqual(lt.map((o) => o.price), LT_PRICES, 'цены LT как были');
    assert.ok(lt.every((o) => o.lt_extras === null), 'lt_extras LT-предложений не тронуты');
    assert.strictEqual(lt[0].extras.best_price, true); assert.strictEqual(lt[0].operator_name, 'Level.Travel');
    assert.deepStrictEqual(lt, sample.result[0].offers.UAI, 'LT-предложения байт-в-байт как в оригинале');
    // метка номера и минимумы
    assert.deepStrictEqual(room.lt_extras.totus, { roomTypeId: 1, customOffers: 1, sourceRoomId: SOURCE_ROOM_ID });
    assert.strictEqual(room.min_price, 1, '«от 1 ₽» у номера'); assert.deepStrictEqual(room.meal_types, [{ id: 'UAI', min_price: 1, description: 'Ультра всё включено' }]);
    assert.strictEqual(out.filters.meals.find((m) => m.id === 'UAI').min_price, 1, 'фильтр питания — наша цена');
    assert.strictEqual(out.filters.meals.find((m) => m.id === 'BB').min_price, 456138, 'другие фильтры без изменений');
    // остальные номера не тронуты
    for (let i = 1; i < out.result.length; i++) assert.deepStrictEqual(out.result[i], sample.result[i], `номер ${i} без изменений`);
    assert.strictEqual(stub.offerMap.length, 1);
    assert.strictEqual(stub.offerMap[0].sourceOfferId, '078-4a3340af5bd0fdf50d0272286c4773a4');
    assert.strictEqual(stub.offerMap[0].operatorId, 78, 'в карте — реальный оператор шаблона (у кого покупаем)');
    assert.ok(stub.offerMap[0].requestId.length > 64, 'request_id LT (80 символов) длиннее VARCHAR(64) — режет store.saveOfferMap');
    assert.strictEqual(stub.checked.length, 0, 'причины пропуска нет');
    assert.strictEqual(stub.seen[0].providerPrice, 258996);

    // 2. searchType не определён (request_id не в custom_room_searches) — вставляется всё равно; и при hotel
    reset(); stub.rts = [rtFixed()];
    out = await inject.injectRooms(ltBody(), ctx(null));
    assert.strictEqual(arlekino(SOURCE(out)).length, 1, 'searchType null → без ограничений');
    reset(); stub.rts = [rtFixed()];
    out = await inject.injectRooms(ltBody(), ctx('hotel'));
    assert.strictEqual(arlekino(SOURCE(out)).length, 1);

    // 3. Room Type v1 (правило −10 %, operator_ids [78]) — как #5 на проде: наше 233 096 первым, оригинал Level.Travel 258 996 рядом, «от 233 096 ₽»
    reset(); stub.rts = [rtRuleV1()];
    out = await inject.injectRooms(ltBody(), ctx('package'));
    room = SOURCE(out);
    assert.strictEqual(room.offers.UAI.length, 8);
    assert.strictEqual(room.offers.UAI[0].price, 233096, '258 996 − 10 %'); assert.ok(inject.isArlekinoOffer(room.offers.UAI[0]));
    assert.strictEqual(room.offers.UAI[0].operator_id, 990005); assert.strictEqual(room.offers.UAI[0].lt_extras.totus.mode, 'rule');
    assert.deepStrictEqual(levelTravel(room), sample.result[0].offers.UAI, 'предложения LT не тронуты (оригинал Level.Travel 78 остался)');
    assert.strictEqual(room.min_price, 233096, '«от 233 096 ₽»');
    assert.strictEqual(out.filters.meals.find((m) => m.id === 'UAI').min_price, 233096);
    assert.strictEqual(room.lt_extras.totus.roomTypeId, 5);

    // 4. номер с room.id = 0 (hash-ID) не мешает: Room Type на источник 0 создать нельзя, связь других номеров по id не ломается
    reset(); stub.rts = [rtFixed({ id: 2, sourceRoomId: 101880, sourceRoomName: 'Делюкс Aqua', sourceSnapshot: null, content: { nameRu: 'Делюкс Aqua (Arlekino)', facilities: [], images: [] } })];
    out = await inject.injectRooms(ltBody(), ctx('package'));
    room = out.result.find((r) => r.room.id === 101880);
    assert.strictEqual(arlekino(room).length, 1, 'наше предложение у второго номера');
    assert.strictEqual(room.offers.BB[0].lt_extras.totus.custom, true, 'самое дешёвое предложение источника — BB 456 138 → наше первым в BB');
    assert.strictEqual(room.offers.FB.every((o) => !inject.isArlekinoOffer(o)), true, 'в FB наших нет');
    assert.deepStrictEqual(SOURCE(out), sample.result[0], 'номер 101879 без изменений');

    // 5. причины пропуска на реальном payload; связь по названию УБРАНА — чужой id при совпавшем названии не источник
    reset(); stub.rts = [rtFixed({ id: 3, sourceRoomId: 777777, sourceRoomName: 'Нет такого', sourceSnapshot: null })];
    let body = ltBody();
    out = await inject.injectRooms(body, ctx('package'));
    assert.strictEqual(out, body, 'тело без изменений');
    assert.ok(/^source_room_missing \(source 777777; ids in result: 101879,101880,0\)/.test(lastSkip()), lastSkip());
    reset(); stub.rts = [rtFixed({ id: 4, sourceRoomId: 777777, sourceRoomName: 'Делюкс Aqua', sourceSnapshot: { name_ru: 'Делюкс Aqua', name_en: 'Deluxe Aqua' } })];
    body = ltBody();
    out = await inject.injectRooms(body, ctx('package'));
    assert.strictEqual(out, body, 'название совпало, id нет → НЕ вставляется (без name-fallback)');
    assert.ok(/^source_room_missing \(source 777777;/.test(lastSkip()), lastSkip());
    assert.strictEqual(out.result.every((r) => arlekino(r).length === 0), true);
    reset(); stub.rts = [rtFixed({ pricing: null, fixedPrice: null })]; // строка после backfill без цены
    out = await inject.injectRooms(ltBody(), ctx('package'));
    assert.strictEqual(lastSkip(), 'no_pricing (mode fixed: fixed_price или правило не заданы)');
    // package = hotel: Room Type с packageTypes ['hotel'] не попадает в пакетную выдачу (и наоборот)
    reset(); stub.rts = [rtFixed({ packageTypes: ['hotel'] })];
    out = await inject.injectRooms(ltBody(), ctx('package'));
    assert.strictEqual(lastSkip(), 'search_type (package; packageTypes [hotel])'); assert.strictEqual(arlekino(SOURCE(out)).length, 0);
    out = await inject.injectRooms(ltBody(), ctx('hotel'));
    assert.strictEqual(arlekino(SOURCE(out)).length, 1, 'packageTypes [hotel] при поиске hotel — есть');
    reset(); stub.rts = [rtFixed({ packageTypes: ['package'] })];
    out = await inject.injectRooms(ltBody(), ctx('hotel'));
    assert.strictEqual(lastSkip(), 'search_type (hotel; packageTypes [package])');
    out = await inject.injectRooms(ltBody(), ctx('package'));
    assert.strictEqual(arlekino(SOURCE(out)).length, 1);
    reset(); stub.rts = [rtFixed({ mealTypes: ['AI'] })];
    out = await inject.injectRooms(ltBody(), ctx('package'));
    assert.strictEqual(lastSkip(), 'no_offers (у источника питание UAI, требуется AI)');

    // 6. повторная обработка уже обработанного тела (кэш/повторный вызов): наши предложения шаблоном не становятся, дубликатов нет
    reset(); stub.rts = [rtFixed()];
    const once = await inject.injectRooms(ltBody(), ctx('package'));
    const twice = await inject.injectRooms(JSON.parse(JSON.stringify(once)), ctx('package'));
    assert.strictEqual(arlekino(SOURCE(twice)).length, 2, 'второй вызов добавляет своё (шаблон — LT 258 996, не наше 1 ₽)');
    assert.strictEqual(SOURCE(twice).offers.UAI[1].lt_extras.totus.sourceOfferId, '078-4a3340af5bd0fdf50d0272286c4773a4');
    assert.deepStrictEqual(levelTravel(SOURCE(twice)), sample.result[0].offers.UAI);

    // 7. middleware: search_type из тела ответа LT, когда request_id не сохранён (поиск начат не через /start-search: ассистент, устаревшая запись)
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

    // 8. полный путь через middleware на реальном payload: сайт получает один номер с двумя группами
    reset(); stub.rts = [rtFixed()];
    store.getSearch = async () => ({ requestId: 'r', searchType: 'package', params: {} });
    const sent = [];
    const res = { statusCode: 200, json: (b) => { sent.push(b); return res; } };
    await new Promise((resolve) => mw({ method: 'GET', path: '/hotels-rooms', query: { request_id: 'r', hotel_id: HOTEL_ID } }, res, resolve));
    res.json(ltBody());
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(sent.length, 1); assert.strictEqual(sent[0].result.length, sample.result.length);
    assert.strictEqual(arlekino(SOURCE(sent[0])).length, 1); assert.strictEqual(SOURCE(sent[0]).min_price, 1);
    // пример для фронта
    const ex = SOURCE(sent[0]);
    console.log('пример offer (Arlekino):', JSON.stringify(ex.offers.UAI[0]));
    console.log('пример lt_extras номера:', JSON.stringify(ex.lt_extras), 'min_price:', ex.min_price, 'meal_types:', JSON.stringify(ex.meal_types));
}

// middleware ждёт store.isReady()
store.isReady = async () => true;
checks().then(() => { console.log('ALL CUSTOM ROOMS LIVE-PAYLOAD CHECKS PASSED'); process.exit(0); }).catch((e) => { console.error(e); process.exit(1); });
