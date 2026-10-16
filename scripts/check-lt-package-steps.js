'use strict';

/**
 * Шаги бронирования через Level.Travel: таймауты, ошибки, выбранный перелёт (?view=pair).
 * Без БД и сети: node scripts/check-lt-package-steps.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    LT_STEP_TIMEOUT_MS,
    isTimeoutError,
    ltStepErrorResponse,
    pickFlightPair,
    firstQueryValue,
} = require('../utils/ltPackageProxy');

let passed = 0;
function check(name, fn) {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
}

const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
function handler(start) {
    const i = src.indexOf(start);
    assert.ok(i >= 0, `нет обработчика ${start}`);
    return src.slice(i, src.indexOf('\n});', i));
}

console.log('Шаги бронирования через Level.Travel');

check('таймауты шагов меньше 60 с прокси перед API', () => {
    for (const [k, v] of Object.entries(LT_STEP_TIMEOUT_MS)) {
        assert.ok(Number.isFinite(v) && v >= 10000 && v < 60000, `${k}=${v}`);
    }
});

check('таймаут axios → 504 lt_timeout, прежнее поле error сохранено', () => {
    const e = Object.assign(new Error('timeout of 45000ms exceeded'), { code: 'ECONNABORTED' });
    assert.ok(isTimeoutError(e));
    const r = ltStepErrorResponse(e, 'Failed to start search');
    assert.strictEqual(r.status, 504);
    assert.strictEqual(r.body.error, 'Failed to start search');
    assert.strictEqual(r.body.code, 'lt_timeout');
    assert.strictEqual(r.body.success, false);
});

check('ошибка LT → его статус, текст и тело; нет связи → 502; прочее → 500', () => {
    const lt = { response: { status: 422, data: { success: false, error: 'Package not found' } } };
    const r = ltStepErrorResponse(lt);
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.body.code, 'lt_error');
    assert.strictEqual(r.body.message, 'Package not found');
    assert.deepStrictEqual(r.body.lt, lt.response.data);
    assert.strictEqual(ltStepErrorResponse({ response: { status: 503, data: '<html>busy</html>' } }).body.message, '<html>busy</html>');
    assert.strictEqual(ltStepErrorResponse({ code: 'ECONNRESET', message: 'socket hang up' }).status, 502);
    assert.strictEqual(ltStepErrorResponse(new Error('boom')).status, 500);
    assert.strictEqual(ltStepErrorResponse(new Error('boom')).body.code, 'internal');
});

check('view=pair: остаётся только выбранный перелёт, форма ответа прежняя', () => {
    const flights = Array.from({ length: 2000 }, (_, i) => ({ flight_pair_id: `p${i}`, fuel_charge: i, to: { big: 'x'.repeat(200) } }));
    const body = { success: true, flights, filters: { a: [1, 2, 3] } };
    const out = pickFlightPair(body, 'p1234');
    assert.strictEqual(out.success, true);
    assert.strictEqual(out.flights.length, 1);
    assert.strictEqual(out.flights[0], flights[1234]);
    assert.strictEqual(out.found, true);
    assert.strictEqual(out.total_flights, 2000);
    assert.ok(!('filters' in out));
    const before = JSON.stringify(body).length;
    const after = JSON.stringify(out).length;
    console.log(`       2000 рейсов: ${Math.round(before / 1024)} КБ → ${(after / 1024).toFixed(1)} КБ`);
    assert.ok(after < 2048);
});

check('view=pair: перелёт не найден / нет id / странный ответ — не падает', () => {
    assert.deepStrictEqual(pickFlightPair({ success: true, flights: [{ flight_pair_id: 'a' }] }, 'b').flights, []);
    assert.strictEqual(pickFlightPair({ success: true, flights: [{ flight_pair_id: 'a' }] }, '').found, false);
    assert.strictEqual(pickFlightPair(null, 'a'), null);
    assert.deepStrictEqual(pickFlightPair({ success: false, error: 'x' }, 'a'), { success: false, error: 'x', flights: [], found: false, total_flights: 0, pair_view: true });
    assert.strictEqual(firstQueryValue(['a', 'a']), 'a');
    assert.strictEqual(firstQueryValue('a'), 'a');
});

check('app.js: actualize и package_details — с таймаутом и понятной ошибкой вместо голого 500', () => {
    for (const [route, key] of [["app.get('/packages/actualize'", 'actualize'], ["app.get('/packages/package_details'", 'packageDetails']]) {
        const h = handler(route);
        assert.match(h, new RegExp(`timeout: LT_STEP_TIMEOUT_MS\\.${key}`));
        assert.match(h, /ltStepErrorResponse\(error, 'Failed to start search'\)/);
        assert.match(h, /res\.status\(status\)\.json\(body\)/);
        assert.ok(!/res\.status\(500\)\.json\(\{ error: 'Failed to start search' \}\)/.test(h));
        assert.match(h, /params: req\.query/);
    }
});

check('app.js: prebuild и проверка туристов — с таймаутом, прежняя форма ответа', () => {
    const pb = handler("app.post('/orders/prebuild'");
    assert.match(pb, /timeout: LT_STEP_TIMEOUT_MS\.prebuild/);
    assert.match(pb, /error: error\.response\?\.data \|\| error\.message/);
    const vt = handler("app.post('/validate-tourists'");
    assert.match(vt, /timeout: LT_STEP_TIMEOUT_MS\.validateTourists/);
    assert.match(vt, /error: error\.response\?\.data \|\| 'Validation failed'/);
});

check('app.js: flights ?view=pair после ?view=list; без параметра — прежний ответ; flight_pair_id в LT не уходит', () => {
    const h = handler("app.post('/packages/flights'");
    const list = h.indexOf("=== 'list'");
    const pair = h.indexOf("=== 'pair'");
    assert.ok(list > 0 && pair > list);
    assert.match(h, /pickFlightPair\(response\.data, firstQueryValue\(req\.query\.flight_pair_id\)\)/);
    assert.match(h, /res\.json\(response\.data\);/);
    assert.ok(!/data\.flight_pair_id|data\.view/.test(h));
});

check('app.js: модуль подключён один раз, рядом с levelTravelHttp (до обработчиков)', () => {
    const req = src.indexOf("require('./utils/ltPackageProxy')");
    assert.ok(req > 0 && src.indexOf("require('./utils/ltPackageProxy')", req + 1) === -1);
    assert.ok(req < src.indexOf("app.get('/packages/actualize'"));
});

console.log(`\n${passed} passed`);
