'use strict';

// Проверка сервера для постепенной выдачи поиска (план claude/HOTEL_SEARCH_PROGRESSIVE_PLAN_RU.md, 02.11.2026):
//   - таймауты /start-search, /search-status, /grouped-hotels к Level.Travel;
//   - ошибки: прежнее поле error и прежний HTTP-статус (500) для старых клиентов, причина — в code / message;
//   - /start-search не ждёт записи в БД (middleware/customRooms → rememberSearch);
//   - кеш поиска отдаёт первую страницу и клиентам без operator_ids / readyOperators.
//
// Запуск: node scripts/check-search-progressive-api.js   (без сети и БД)

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const root = path.resolve(__dirname, '..');
let passed = 0;
let failed = 0;
const pending = [];

function check(name, fn) {
    pending.push(Promise.resolve().then(fn).then(() => {
        passed += 1;
        console.log(`  ok   ${name}`);
    }, (e) => {
        failed += 1;
        console.log(`  FAIL ${name}\n       ${e && e.message ? e.message : e}`);
    }));
}

const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const app = read('app.js');

function handlerBody(route) {
    const start = app.indexOf(`app.get('${route}'`);
    assert.ok(start >= 0, `нет обработчика ${route}`);
    const end = app.indexOf('\napp.', start + 10);
    return app.slice(start, end > 0 ? end : undefined);
}

const proxy = require(path.join(root, 'utils/ltSearchProxy'));

function axiosError({ code, message, status, data } = {}) {
    const e = new Error(message || 'boom');
    if (code) e.code = code;
    if (status) e.response = { status, data };
    return e;
}

console.log('Поиск: сервер для постепенной выдачи');

check('таймауты поиска: enqueue 15 с, status 10 с, grouped 20 с (меньше 60 с nginx)', () => {
    assert.deepStrictEqual({ ...proxy.LT_SEARCH_TIMEOUT_MS }, { enqueue: 15000, status: 10000, grouped: 20000 });
    assert.ok(Object.isFrozen(proxy.LT_SEARCH_TIMEOUT_MS));
});

check('обработчики передают таймаут в axios', () => {
    assert.match(handlerBody('/start-search'), /\/search\/enqueue`,\s*\{[\s\S]*?timeout: LT_SEARCH_TIMEOUT_MS\.enqueue/);
    assert.match(handlerBody('/search-status'), /\/search\/status`,\s*\{[\s\S]*?timeout: LT_SEARCH_TIMEOUT_MS\.status/);
    assert.match(handlerBody('/grouped-hotels'), /\/search\/get_grouped_hotels`,\s*\{[\s\S]*?timeout: LT_SEARCH_TIMEOUT_MS\.grouped/);
});

check('таймаут LT → 504, code lt_timeout, прежнее поле error', () => {
    const { status, body } = proxy.searchErrorResponse(axiosError({ code: 'ECONNABORTED', message: 'timeout of 15000ms exceeded' }), 'Failed to start search');
    assert.strictEqual(status, 504);
    assert.strictEqual(body.error, 'Failed to start search');
    assert.strictEqual(body.code, 'lt_timeout');
});

check('ошибка LT 422 → HTTP 500 как раньше, статус и тело LT внутри ответа', () => {
    const { status, body } = proxy.searchErrorResponse(axiosError({ status: 422, data: { success: false, error: 'Invalid to_country' } }), 'Failed to start search');
    assert.strictEqual(status, 500);
    assert.strictEqual(body.error, 'Failed to start search');
    assert.strictEqual(body.code, 'lt_error');
    assert.strictEqual(body.status, 422);
    assert.strictEqual(body.message, 'Invalid to_country');
    assert.deepStrictEqual(body.lt, { success: false, error: 'Invalid to_country' });
});

check('нет связи с LT → HTTP 500 как раньше, code lt_unreachable', () => {
    const { status, body } = proxy.searchErrorResponse(axiosError({ code: 'ECONNRESET' }), 'Failed to check status');
    assert.strictEqual(status, 500);
    assert.strictEqual(body.error, 'Failed to check status');
    assert.strictEqual(body.code, 'lt_unreachable');
});

check('обработчики отвечают через searchErrorResponse; /grouped-hotels — тело LT как раньше, новый только таймаут', () => {
    assert.match(handlerBody('/start-search'), /searchErrorResponse\(error, 'Failed to start search'\)/);
    assert.match(handlerBody('/search-status'), /searchErrorResponse\(error, 'Failed to check status'\)/);
    const grouped = handlerBody('/grouped-hotels');
    assert.match(grouped, /if \(isTimeoutError\(error\)\) \{\s*const \{ status, body \} = ltStepErrorResponse\(error, 'Failed to get grouped hotels'\);/);
    assert.match(grouped, /return sendLtAxiosError\(res, error, 'Failed to get grouped hotels'\);/);
    assert.match(handlerBody('/search-status'), /return res\.status\(400\)\.json\(\{ error: 'Missing request_id' \}\)/);
});

check('кеш поиска по-прежнему первым в /start-search, /search-status, /grouped-hotels', () => {
    assert.match(handlerBody('/start-search'), /searchCache\.lookupStart\(req\.query\)[\s\S]*\/search\/enqueue/);
    assert.match(handlerBody('/search-status'), /searchCache\.lookupStatus\(request_id\)[\s\S]*\/search\/status/);
    assert.match(handlerBody('/grouped-hotels'), /searchCache\.lookupGrouped\(params\)[\s\S]*\/search\/get_grouped_hotels/);
});

check('кеш: первая страница без operator_ids — тот же вариант, что с operator_ids', () => {
    const { buildGroupedHotelsParams, variantKey } = require(path.join(root, 'lib/searchCache'));
    const base = { request_id: 'r1', page_limit: '50', page_number: '0', sort_by: 'relevance', filter_stars: '3,4,5', filter_instant_confirm: 'false' };
    const withOps = buildGroupedHotelsParams({ ...base, readyOperators: '7,78' });
    const withoutOps = buildGroupedHotelsParams(base);
    assert.strictEqual(withOps.operator_ids, '7,78');
    assert.strictEqual(withoutOps.operator_ids, undefined);
    assert.strictEqual(variantKey(withOps), variantKey(withoutOps));
});

// middleware/customRooms с подменёнными store / diag / inject / packageFlow / internalOrders (без БД).
function loadCustomRooms(store) {
    const errors = [];
    const fakes = {
        '../lib/customRooms/store': store,
        '../lib/customRooms/diag': {
            stats: { middlewareCalls: 0, watchedCalls: 0, notReadySkips: 0 },
            bump() {},
            log() {},
            error(msg) { errors.push(msg); },
        },
        '../lib/customRooms/inject': { injectRooms: async (b) => b },
        '../lib/customRooms/packageFlow': {},
        '../lib/customRooms/internalOrders': {},
    };
    const file = path.join(root, 'middleware/customRooms.js');
    const origLoad = Module._load;
    Module._load = function load(request, parent, isMain) {
        if (parent && parent.filename === file && Object.prototype.hasOwnProperty.call(fakes, request)) return fakes[request];
        return origLoad.apply(this, arguments);
    };
    const origSetTimeout = global.setTimeout;
    const origSetInterval = global.setInterval;
    global.setTimeout = () => ({ unref() {} });
    global.setInterval = () => ({ unref() {} });
    try {
        delete require.cache[require.resolve(file)];
        return { mw: require(file), errors };
    } finally {
        Module._load = origLoad;
        global.setTimeout = origSetTimeout;
        global.setInterval = origSetInterval;
    }
}

function runStartSearch(mw, body) {
    return new Promise((resolve) => {
        const sent = [];
        const res = {
            statusCode: 200,
            json(b) { sent.push(b); resolve(sent); return this; },
            status(c) { this.statusCode = c; return this; },
        };
        const req = { method: 'GET', path: '/start-search', query: { search_type: 'hotel', to_country: 'TR' } };
        mw(req, res, () => { res.json(body); });
    });
}

function within(ms, promise, label) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); }),
    ]).finally(() => clearTimeout(timer));
}

check('/start-search: ответ уходит, не дожидаясь записи в БД (rememberSearch)', async () => {
    const calls = [];
    const store = {
        isReady: async () => true,
        rememberSearch: (...args) => { calls.push(args); return new Promise(() => {}); }, // запись «висит»
    };
    const { mw } = loadCustomRooms(store);
    const sent = await within(500, runStartSearch(mw, { request_id: 'rid-1', status: {} }), 'ответ ждал rememberSearch');
    assert.deepStrictEqual(sent[0], { request_id: 'rid-1', status: {} });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0][0], 'rid-1');
    assert.strictEqual(calls[0][1], 'hotel');
});

check('/start-search: ошибка записи в БД — только в лог, клиент получает ответ LT', async () => {
    const store = {
        isReady: async () => true,
        rememberSearch: async () => { throw new Error('db down'); },
    };
    const { mw, errors } = loadCustomRooms(store);
    const sent = await within(500, runStartSearch(mw, { request_id: 'rid-2' }), 'нет ответа');
    assert.deepStrictEqual(sent[0], { request_id: 'rid-2' });
    await new Promise((r) => setImmediate(r));
    assert.ok(errors.some((m) => /rememberSearch failed for rid-2/.test(m)), 'ошибка не записана в лог');
});

Promise.all(pending).then(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
});
