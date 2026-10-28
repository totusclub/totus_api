// Кеш поиска LT (lib/searchCache.js): ключи, снимок, прогрев, обновление, диск, подключение в app.js.
//   node scripts/check-search-cache.js
// Без npm install, без сети и без БД: Level.Travel — поддельный, часы — свои.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const {
    loadConfig, createSearchCache, searchKey, buildGroupedHotelsParams, variantKey, moscowDate, msUntilMoscowTime, msUntilNextRun,
} = require(path.join(root, 'lib/searchCache'));

let passed = 0;
let failed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---------- параметры, как их шлют клиенты ----------

// Сайт: searchForm (форма по умолчанию) → prepareStartSearchParams (пустые строки и массивы выкинуты).
const webStart = (date, country = 'EG') => ({
    from_city: 'Moscow', from_country: 'RU', to_country: country, adults: '2', nights: '7', flex_dates: '0',
    start_date: date, start_date_from: date, end_date_till: '2026-11-09', kids: '0', search_type: 'package',
});
// Приложение: Search.tsx → buildApiSearchParams → prepareStartSearchParams (числа как есть, страница — тоже).
const appStart = (date, country = 'EG') => ({
    from_city: 'Moscow', from_country: 'RU', to_country: country, adults: '2', kids: '0', start_date: date,
    start_date_from: date, end_date_till: '2026-11-09', nights: '7', search_type: 'package', flex_dates: '0',
    page_number: '1', page_limit: '20', sort_by: 'relevance',
});
// Первая страница: сайт (readyOperators CSV, page 0, 50) и приложение (page 1, 20, search_type).
const webGrouped = (requestId, ops) => ({
    request_id: requestId, readyOperators: ops, filter_instant_confirm: 'false', page_number: '0', page_limit: '50',
    sort_by: 'relevance', filter_stars: '3,4,5',
});
const appGrouped = (requestId, ops) => ({
    request_id: requestId, readyOperators: ops, filter_instant_confirm: 'false', page_number: '1', page_limit: '20',
    sort_by: 'relevance', filter_stars: '3,4,5', search_type: 'package',
});

// ---------- поддельный Level.Travel ----------

function fakeLt({ results = {}, polls = 2 } = {}) {
    const calls = { enqueue: 0, status: 0, grouped: 0, destinations: 0, groupedParams: [] };
    const searches = new Map(); // request_id → { country, left }
    const lt = {
        calls,
        down: false,
        async destinations() {
            calls.destinations++;
            return { success: true, countries: Object.keys(results).map((iso2) => ({ iso2, name_ru: iso2 })) };
        },
        async enqueue(params) {
            calls.enqueue++;
            if (lt.down) throw new Error('LT недоступен');
            const id = Buffer.from(`213|${params.to_country}|${params.start_date}|${params.nights}|${params.adults}`).toString('base64');
            searches.set(id, { country: params.to_country, left: polls });
            return { success: true, request_id: id, status: { 6: 'pending', 7: 'pending', 78: 'pending' }, search_params: { query: params.to_country } };
        },
        async status(id) {
            calls.status++;
            const s = searches.get(id);
            const r = results[s.country];
            if (s.left-- > 0) return { status: { 6: 'performing', 7: 'pending', 78: 'pending' }, completeness: 30 };
            if (r === 'never') return { status: { 6: 'completed', 7: 'pending', 78: 'pending' }, completeness: 60 };
            return r > 0
                ? { status: { 6: 'completed', 7: 'failed', 78: 'completed' }, completeness: 100 }
                : { status: { 6: 'no_results', 7: 'skipped', 78: 'no_results' }, completeness: 100 };
        },
        async grouped(params) {
            calls.grouped++;
            calls.groupedParams.push(params);
            const s = searches.get(params.request_id);
            const n = results[s.country] === 'never' ? 5 : results[s.country];
            const limit = Number(params.page_limit) || 50;
            return {
                success: true, hotels_count: n, page: params.page_number,
                hotels: Array.from({ length: Math.min(n, limit) }, (_, i) => ({ hotel: { id: i + 1 }, min_price: 100000 + i })),
            };
        },
    };
    return lt;
}

function clock(iso) {
    let t = Date.parse(iso);
    return { now: () => t, wait: async (ms) => { t += ms; }, add: (ms) => { t += ms; } };
}

const quiet = { log() {}, warn() {} };
const ON = { SEARCH_CACHE: 'on' };

// ---------- ключ поиска ----------

test('сайт и приложение с формой по умолчанию дают один ключ', () => {
    const k = searchKey(webStart('2026-11-02'));
    assert.ok(k, 'ключ сайта');
    assert.strictEqual(searchKey(appStart('2026-11-02')), k);
    assert.strictEqual(searchKey({ ...webStart('2026-11-02'), to_country: ['EG', 'EG'] }), k, 'повтор параметра');
    assert.notStrictEqual(searchKey(webStart('2026-11-03')), k, 'другая дата');
    assert.notStrictEqual(searchKey(webStart('2026-11-02', 'TR')), k, 'другая страна');
    assert.notStrictEqual(searchKey({ ...webStart('2026-11-02'), adults: '3' }), k, 'другие взрослые');
    assert.notStrictEqual(searchKey({ ...webStart('2026-11-02'), kids: '1', kids_ages: '5' }), k, 'с детьми');
    assert.notStrictEqual(searchKey({ ...webStart('2026-11-02'), to_city: 'Hurghada' }), k, 'город');
    assert.notStrictEqual(searchKey({ ...webStart('2026-11-02'), hotel_ids: '537' }), k, 'отель');
});

test('гибкие даты, диапазоны и незнакомые параметры не кешируются', () => {
    assert.strictEqual(searchKey({ ...webStart('2026-11-02'), flex_dates: '2' }), null);
    assert.strictEqual(searchKey({ ...webStart('2026-11-02'), start_date_from: '2026-10-31' }), null);
    assert.strictEqual(searchKey({ ...webStart('2026-11-02'), start_date_till: '2026-11-04' }), null);
    assert.strictEqual(searchKey({ ...webStart('2026-11-02'), end_date_from: '2026-11-08' }), null);
    assert.strictEqual(searchKey({ ...webStart('2026-11-02'), nights: '7..9' }), null);
    assert.strictEqual(searchKey({ ...webStart('2026-11-02'), stars: '4..5' }), null);
    assert.strictEqual(searchKey({ ...webStart('2026-11-02'), start_date: '02.11.2026' }), null);
    assert.strictEqual(searchKey(null), null);
});

// ---------- первая страница ----------

test('buildGroupedHotelsParams — как прежний код маршрута', () => {
    const p = buildGroupedHotelsParams({
        request_id: 'R', readyOperators: ['6', '78'], filter_stars: '3,4,5', filter_instant_confirm: 'false',
        filter_pool: 'false', filter_beach: 'true', page_number: '0', page_limit: '50', sort_by: 'price', search_type: 'package', foo: 'x', filter_x: '',
    });
    assert.deepStrictEqual(p, {
        request_id: 'R', operator_ids: '6,78', filter_stars: '3,4,5', filter_instant_confirm: 'false', filter_beach: 'true',
        page_number: '0', page_limit: '50', sort_by: 'price',
    });
    assert.deepStrictEqual(buildGroupedHotelsParams({ request_id: 'R', operator_ids: '6', readyOperators: '7' }).operator_ids, '6');
});

test('ключ варианта: операторы и request_id не важны, search_type приложения отбрасывается', () => {
    const a = variantKey(buildGroupedHotelsParams(webGrouped('R1', '6,78')));
    const b = variantKey(buildGroupedHotelsParams(webGrouped('R2', '6')));
    assert.strictEqual(a, b);
    const app1 = variantKey(buildGroupedHotelsParams(appGrouped('R1', ['6', '78'])));
    assert.notStrictEqual(app1, a, 'у приложения своя страница');
    assert.strictEqual(variantKey(buildGroupedHotelsParams({ ...webGrouped('R1', '6'), sort_by: 'price' })) === a, false, 'другая сортировка — другой вариант');
});

// ---------- даты по Москве ----------

test('дата и время прогрева считаются по Москве', () => {
    assert.strictEqual(moscowDate(Date.parse('2026-10-26T20:59:00Z')), '2026-10-26'); // 23:59 МСК
    assert.strictEqual(moscowDate(Date.parse('2026-10-26T21:01:00Z')), '2026-10-27'); // 00:01 МСК
    assert.strictEqual(moscowDate(Date.parse('2026-10-26T21:01:00Z'), 7), '2026-11-03');
    assert.strictEqual(msUntilMoscowTime(Date.parse('2026-10-26T20:00:00Z'), 0, 5), 65 * 60 * 1000); // 23:00 → 00:05
    assert.strictEqual(msUntilMoscowTime(Date.parse('2026-10-26T21:05:00Z'), 0, 5), 24 * 60 * 60 * 1000); // ровно 00:05 → завтра
    const c = loadConfig({});
    assert.strictEqual(c.enabled, false, 'по умолчанию выключено');
    assert.deepStrictEqual([c.timeHour, c.timeMinute, c.fromCity, c.daysAhead, c.nights, c.adults], [0, 5, 'Moscow', 7, 7, 2]);
    assert.deepStrictEqual(loadConfig({ SEARCH_CACHE_COUNTRIES: 'eg, TR,xx1,' }).countries, ['EG', 'TR']);
});

test('прогрев каждый час в :05 по Москве (SEARCH_CACHE_EVERY_MINUTES=60 по умолчанию)', () => {
    assert.strictEqual(loadConfig({}).everyMinutes, 60);
    assert.strictEqual(loadConfig({ SEARCH_CACHE_EVERY_MINUTES: '1440' }).everyMinutes, 1440);
    assert.strictEqual(loadConfig({ SEARCH_CACHE_EVERY_MINUTES: '1' }).everyMinutes, 10, 'не чаще раза в 10 минут');
    const min = 60 * 1000;
    assert.strictEqual(msUntilNextRun(Date.parse('2026-10-28T11:20:00Z'), 0, 5, 60), 45 * min); // 14:20 МСК → 15:05
    assert.strictEqual(msUntilNextRun(Date.parse('2026-10-28T11:05:00Z'), 0, 5, 60), 60 * min); // ровно 14:05 → 15:05
    assert.strictEqual(msUntilNextRun(Date.parse('2026-10-28T20:59:00Z'), 0, 5, 60), 6 * min); // 23:59 → 00:05
    assert.strictEqual(msUntilNextRun(Date.parse('2026-10-28T21:01:00Z'), 0, 5, 60), 4 * min); // 00:01 → 00:05
    assert.strictEqual(msUntilNextRun(Date.parse('2026-10-28T11:20:00Z'), 0, 5, 1440), msUntilMoscowTime(Date.parse('2026-10-28T11:20:00Z'), 0, 5));
});

// ---------- прогрев и выдача из снимка ----------

async function warmed({ results = { EG: 120, TR: 1459, TN: 0 }, env = ON, persist = false, dir } = {}) {
    const c = clock('2026-10-26T21:05:00Z'); // 00:05 МСК 27.10 → вылет 03.11
    const lt = fakeLt({ results });
    const config = loadConfig({ ...env, ...(dir ? { SEARCH_CACHE_DIR: dir } : {}) });
    const cache = createSearchCache({ lt, config, now: c.now, wait: c.wait, log: quiet, persist });
    const summary = await cache.warmAll('прогрев');
    return { c, lt, cache, summary, config };
}

test('прогрев: все страны, первая страница сайта и приложения, пустые страны отмечены', async () => {
    const { lt, summary } = await warmed();
    assert.strictEqual(summary.date, '2026-11-03');
    assert.deepStrictEqual([summary.countries, summary.withHotels, summary.empty, summary.errors], [3, 2, 1, 0]);
    assert.strictEqual(lt.calls.enqueue, 3);
    // по 2 страницы (сайт и приложение) у стран с результатами
    assert.strictEqual(lt.calls.grouped, 4);
    const eg = lt.calls.groupedParams[0];
    assert.strictEqual(eg.operator_ids, '6,78', 'только готовые операторы');
});

test('повторный поиск сайта: старт, статус и первая страница из снимка, без LT', async () => {
    const { lt, cache } = await warmed();
    const before = { ...lt.calls };
    const start = cache.lookupStart(webStart('2026-11-03'));
    assert.ok(start, 'попадание');
    assert.strictEqual(start.success, true);
    assert.ok(start.request_id);
    assert.deepStrictEqual(start.status, { 6: 'completed', 7: 'failed', 78: 'completed' });
    assert.ok(start.search_params, 'search_params из ответа LT сохранён');
    assert.ok(start.cached_at);
    const st = cache.lookupStatus(start.request_id);
    assert.strictEqual(st.completeness, 100);
    const ready = Object.entries(st.status).filter(([, s]) => s === 'completed' || s === 'cached').map(([k]) => k).join(',');
    const page = cache.lookupGrouped(buildGroupedHotelsParams(webGrouped(start.request_id, ready)));
    assert.ok(page && page.hotels.length === 50 && page.hotels_count === 120, 'страница сайта: 50 из 120');
    const appPage = cache.lookupGrouped(buildGroupedHotelsParams(appGrouped(start.request_id, ready.split(','))));
    assert.ok(appPage && appPage.hotels.length === 20, 'страница приложения: 20');
    // Другой фильтр или вторая страница — в LT, как раньше.
    assert.strictEqual(cache.lookupGrouped(buildGroupedHotelsParams({ ...webGrouped(start.request_id, ready), page_number: '1' })), null);
    assert.strictEqual(cache.lookupGrouped(buildGroupedHotelsParams({ ...webGrouped(start.request_id, ready), filter_meals: 'AI' })), null);
    // В LT при попадании ушёл только фоновый поиск (обновление снимка), не больше одного.
    assert.ok(lt.calls.enqueue - before.enqueue <= 1);
});

test('приложение попадает в тот же снимок', async () => {
    const { cache } = await warmed();
    assert.ok(cache.lookupStart(appStart('2026-11-03')));
});

test('промахи: другая дата, пустая страна, чужой request_id, кеш выключен', async () => {
    const { cache } = await warmed();
    assert.strictEqual(cache.lookupStart(webStart('2026-11-04')), null);
    assert.strictEqual(cache.lookupStart(webStart('2026-11-03', 'TN')), null, 'пустую выдачу не отдаём — пусть ищет живьём');
    assert.strictEqual(cache.lookupStatus('другой'), null);
    assert.strictEqual(cache.lookupGrouped({ request_id: 'другой' }), null);
    const off = await warmed({ env: {} });
    assert.strictEqual(off.cache.lookupStart(webStart('2026-11-03')), null);
});

test('фоновое обновление при попадании — не чаще раза в 10 минут', async () => {
    const { c, lt, cache } = await warmed();
    const n0 = lt.calls.enqueue;
    c.add(11 * 60 * 1000);
    cache.lookupStart(webStart('2026-11-03'));
    cache.lookupStart(webStart('2026-11-03'));
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(lt.calls.enqueue, n0 + 1, 'один фоновый поиск');
    // дождаться окончания и проверить, что снимок свежий
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    const s = cache.lookupStart(webStart('2026-11-03'));
    assert.ok(c.now() - Date.parse(s.cached_at) < 60 * 1000, 'снимок обновлён');
    c.add(2 * 60 * 1000);
    cache.lookupStart(webStart('2026-11-03'));
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(lt.calls.enqueue, n0 + 1, 'через 2 минуты — без нового поиска');
});

test('снимок живёт SEARCH_CACHE_MAX_AGE_HOURS (26 ч)', async () => {
    const { c, cache } = await warmed();
    c.add(25 * 60 * 60 * 1000);
    assert.ok(cache.lookupStart(webStart('2026-11-03')));
    const { c: c2, cache: cache2 } = await warmed();
    c2.add(27 * 60 * 60 * 1000);
    assert.strictEqual(cache2.lookupStart(webStart('2026-11-03')), null);
});

test('сбой LT при обновлении не портит снимок', async () => {
    const { c, lt, cache } = await warmed();
    lt.down = true;
    c.add(11 * 60 * 1000);
    const r = await cache.refresh(cache._entries.get(searchKey(webStart('2026-11-03'))), 'обновление');
    assert.strictEqual(r.ok, false);
    assert.ok(cache.lookupStart(webStart('2026-11-03')), 'старый снимок отдаётся');
    const summary = await cache.warmAll('прогрев');
    assert.strictEqual(summary.errors, 3, 'ночной прогрев при недоступном LT — ошибки по всем странам');
    assert.ok(cache.lookupStart(webStart('2026-11-03')), 'а вчерашний снимок по-прежнему отдаётся');
});

test('оператор не отвечает — снимок после таймаута с готовыми операторами', async () => {
    const { lt, summary, cache } = await warmed({ results: { EG: 'never' } });
    assert.strictEqual(summary.withHotels, 1);
    assert.ok(lt.calls.status >= 40, `ждали до таймаута (${lt.calls.status} опросов)`);
    const s = cache.lookupStart(webStart('2026-11-03'));
    assert.strictEqual(s.status[6], 'completed');
});

test('снимки на диске переживают перезапуск API', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-cache-'));
    try {
        const { c } = await warmed({ persist: true, dir });
        const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
        assert.strictEqual(files.length, 3);
        assert.ok(fs.existsSync(path.join(dir, 'last-run.txt')));
        const again = createSearchCache({ lt: fakeLt(), config: loadConfig({ ...ON, SEARCH_CACHE_DIR: dir }), now: c.now, log: quiet });
        assert.strictEqual(again.load(), 3);
        assert.ok(again.lookupStart(webStart('2026-11-03')));
        // устаревшие файлы удаляются при загрузке
        c.add(30 * 60 * 60 * 1000);
        const old = createSearchCache({ lt: fakeLt(), config: loadConfig({ ...ON, SEARCH_CACHE_DIR: dir }), now: c.now, log: quiet });
        assert.strictEqual(old.load(), 0);
        assert.strictEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length, 0);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('в снимке нет личных данных: только параметры поиска и выдача', async () => {
    const { cache } = await warmed();
    const e = cache._entries.get(searchKey(webStart('2026-11-03')));
    const keys = Object.keys(e.params).sort();
    assert.deepStrictEqual(keys, ['adults', 'end_date_till', 'flex_dates', 'from_city', 'from_country', 'kids', 'nights', 'search_type', 'start_date', 'start_date_from', 'to_country']);
    const info = cache.info();
    assert.strictEqual(info.entries.length, 3);
    assert.ok(!JSON.stringify(info).includes('hotels":['), 'в админке нет самой выдачи');
});

test('ежечасный прогрев: только что обновлённые страны не ищет повторно, пустые ищет', async () => {
    const { c, lt, cache } = await warmed();
    const n0 = lt.calls.enqueue;
    c.add(5 * 60 * 1000);
    const s1 = await cache.warmAll('прогрев по расписанию');
    assert.strictEqual(lt.calls.enqueue - n0, 1, 'через 5 мин — только страна без туров');
    assert.strictEqual(s1.skippedFresh, 2);
    assert.strictEqual(s1.withHotels, 2);
    c.add(60 * 60 * 1000);
    await cache.warmAll('прогрев по расписанию');
    assert.strictEqual(lt.calls.enqueue - n0, 4, 'через час — все страны');
});

test('сводка: обновлённые, без туров и не обновлённые с причиной', async () => {
    const results = { EG: 120, TR: 1459, TN: 0 };
    const c = clock('2026-10-28T11:05:00Z');
    const lt = fakeLt({ results });
    const cache = createSearchCache({ lt, config: loadConfig(ON), now: c.now, wait: c.wait, log: quiet, persist: false });
    await cache.warmAll('прогрев по расписанию');
    let s = cache.summary();
    assert.strictEqual(s.schedule, 'каждый час в :05 МСК');
    assert.strictEqual(s.date, '2026-11-04');
    assert.deepStrictEqual([s.countries, s.updated], [3, 2]);
    assert.deepStrictEqual(s.no_tours.map((r) => r.iso2), ['TN']);
    assert.deepStrictEqual(s.not_updated, []);
    assert.ok(s.last_run && s.last_run.started_at);
    // LT упал на следующем прогоне — все три не обновлены, с текстом ошибки
    lt.down = true;
    c.add(61 * 60 * 1000);
    await cache.warmAll('прогрев по расписанию');
    s = cache.summary();
    assert.strictEqual(s.updated, 0);
    assert.deepStrictEqual(s.not_updated.map((r) => `${r.iso2}:${r.state}`), ['EG:error', 'TN:error', 'TR:error']);
    assert.match(s.not_updated[0].error, /LT недоступен/);
    assert.ok(cache.lookupStart(webStart('2026-11-04')), 'прежний снимок Египта отдаётся');
    // LT снова жив, но по Египту ничего не нашёл — прежний снимок оставлен, страна в списке «не обновлены»
    lt.down = false;
    results.EG = 0;
    c.add(61 * 60 * 1000);
    await cache.warmAll('прогрев по расписанию');
    s = cache.summary();
    assert.deepStrictEqual(s.not_updated.map((r) => `${r.iso2}:${r.state}`), ['EG:kept']);
    assert.strictEqual(s.updated, 1);
    // Прогрев не запускался больше часа — всё «устарело»
    results.EG = 120;
    await cache.warmAll('прогрев по расписанию');
    c.add(80 * 60 * 1000);
    s = cache.summary();
    assert.deepStrictEqual(s.not_updated.map((r) => `${r.iso2}:${r.state}:${r.age_minutes}`), ['EG:stale:80', 'TN:stale:80', 'TR:stale:80']);
    assert.ok(!/min_price|"hotels":\[/.test(JSON.stringify(s)), 'в сводке нет выдачи и цен');
});

// ---------- подключение ----------

test('app.js: кеш в /start-search, /search-status, /grouped-hotels, запуск и админка', () => {
    const app = read('app.js');
    assert.match(app, /require\('\.\/lib\/searchCache'\)/);
    assert.match(app, /searchCache\.lookupStart\(req\.query\)/);
    assert.match(app, /searchCache\.lookupStatus\(request_id\)/);
    assert.match(app, /const params = buildGroupedHotelsParams\(req\.query\);[\s\S]{0,200}searchCache\.lookupGrouped\(params\)/);
    assert.doesNotMatch(app, /const passthroughKeys/, 'параметры выдачи строятся в одном месте');
    assert.match(app, /searchCache\.start\(\)/);
    assert.match(app, /\/api\/admin\/search-cache/);
    assert.match(app, /app\.use\('\/api\/search-cache', require\('\.\/routes\/searchCache\.routes'\)\.buildSearchCachePublicRoutes\(searchCache\)\)/);
    const routes = read('routes/searchCache.routes.js');
    assert.match(routes, /router\.use\(requireStaff\)/);
    const pub = routes.slice(routes.indexOf('function buildSearchCachePublicRoutes'), routes.indexOf('function buildSearchCacheRoutes'));
    assert.match(pub, /router\.get\('\/summary'/);
    assert.doesNotMatch(pub, /requireStaff/, 'сводка доступна чекапу без входа');
    assert.match(pub, /searchCache\.summary\(\)/, 'наружу — только сводка, без выдачи');
    assert.match(read('.gitignore'), /^var\/$/m);
    assert.match(read('.env.example'), /^SEARCH_CACHE=off$/m);
});

(async () => {
    for (const [name, fn] of tests) {
        try {
            await fn();
            passed++;
            console.log(`  ok   ${name}`);
        } catch (e) {
            failed++;
            console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n       ') : e}`);
        }
    }
    console.log(`\ncheck-search-cache: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
