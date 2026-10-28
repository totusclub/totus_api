'use strict';
// Прогретый кеш поиска туров Level.Travel (docs/SEARCH_CACHE_RU.md).
//
// Первый поиск у LT идёт 2–25 с (операторы отвечают по очереди), повторный с тем же ключом —
// мгновенно, но кеш LT живёт ~13 мин (замер 26.10) и повторными запросами не продлевается. Поэтому:
//  1. Каждый час (SEARCH_CACHE_EVERY_MINUTES, по умолчанию 60, в :05 по Москве — SEARCH_CACHE_TIME) сервер
//     сам ищет форму по умолчанию для всех стран из /references/destinations: Москва → страна, вылет через
//     7 дней, 7 ночей, 2 взрослых, тур. Страну, обновлённую за последние SEARCH_CACHE_REFRESH_MINUTES
//     (её только что искал пользователь), пропускает.
//     Ждёт, пока операторы ответят, и сохраняет снимок: ответ enqueue, итоговые статусы операторов
//     и первую страницу выдачи — в том виде, в каком её просят сайт и приложение.
//  2. Пользователь ищет то же самое → /start-search, /search-status и первая страница /grouped-hotels
//     отдаются из снимка сразу, без ожидания операторов. В фоне сервер повторяет поиск в LT (не чаще
//     раза в SEARCH_CACHE_REFRESH_MINUTES на ключ) и обновляет снимок — поэтому следующие страницы и
//     фильтры идут в уже обновлённый кеш LT, а снимок не стареет у популярных направлений.
//  3. Всё остальное (другие даты, дети, город, фильтры, отель) — как раньше, напрямую в LT.
//  4. Состояние по странам — GET /api/search-cache/summary (публично, без выдачи и цен): какие
//     направления обновлены за последний прогон, какие нет и почему (нет туров, ошибка LT, устарело).
//
// Выключено по умолчанию: SEARCH_CACHE=on включает. Личных данных в кеше нет — только параметры
// поиска и выдача отелей. Снимки лежат в памяти и на диске (SEARCH_CACHE_DIR), переживают перезапуск.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000; // UTC+3 круглый год

// Первая страница выдачи, как её просят клиенты после /start-search (параметры к LT после
// buildGroupedHotelsParams, без request_id и operator_ids).
// Сайт: searchForm.dispatchSearch → page 1 → API 0 (toApiPageNumber), 50 на странице, 3–5★.
// Приложение: Search.tsx → page_number 1, 20 на странице, 3–5★ (search_type к LT не уходит).
const DEFAULT_VARIANTS = {
    web: { filter_instant_confirm: 'false', filter_stars: '3,4,5', page_limit: '50', page_number: '0', sort_by: 'relevance' },
    app: { filter_instant_confirm: 'false', filter_stars: '3,4,5', page_limit: '20', page_number: '1', sort_by: 'relevance' },
};

const READY = new Set(['completed', 'cached']);
const TERMINAL = new Set(['completed', 'cached', 'no_results', 'failed', 'skipped', 'all_filtered']);

function intEnv(env, name, def, min, max) {
    const n = parseInt(env[name], 10);
    if (!Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, n));
}

function loadConfig(env = process.env) {
    const time = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(env.SEARCH_CACHE_TIME || '00:05').trim()) || [null, '0', '5'];
    const countries = String(env.SEARCH_CACHE_COUNTRIES || '')
        .split(',').map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z]{2}$/.test(s));
    return {
        enabled: String(env.SEARCH_CACHE || 'off').trim().toLowerCase() === 'on',
        timeHour: Number(time[1]),
        timeMinute: Number(time[2]),
        // Как часто прогревать: от времени SEARCH_CACHE_TIME шагами по столько минут (60 — каждый час в :05,
        // 1440 — раз в сутки).
        everyMinutes: intEnv(env, 'SEARCH_CACHE_EVERY_MINUTES', 60, 10, 1440),
        fromCity: String(env.SEARCH_CACHE_FROM_CITY || 'Moscow').trim() || 'Moscow',
        daysAhead: intEnv(env, 'SEARCH_CACHE_DAYS_AHEAD', 7, 0, 180),
        nights: intEnv(env, 'SEARCH_CACHE_NIGHTS', 7, 1, 30),
        adults: intEnv(env, 'SEARCH_CACHE_ADULTS', 2, 1, 9),
        countries, // пусто — все страны из /references/destinations
        concurrency: intEnv(env, 'SEARCH_CACHE_CONCURRENCY', 3, 1, 10),
        maxAgeHours: intEnv(env, 'SEARCH_CACHE_MAX_AGE_HOURS', 26, 1, 72),
        refreshMinutes: intEnv(env, 'SEARCH_CACHE_REFRESH_MINUTES', 10, 1, 1440),
        searchTimeoutSec: intEnv(env, 'SEARCH_CACHE_SEARCH_TIMEOUT_SEC', 90, 20, 300),
        pollMs: intEnv(env, 'SEARCH_CACHE_POLL_MS', 2000, 200, 10000),
        dir: path.resolve(String(env.SEARCH_CACHE_DIR || path.join(__dirname, '..', 'var', 'search-cache'))),
    };
}

// ---------- даты по Москве ----------

function moscowParts(ms) {
    const d = new Date(ms + MOSCOW_OFFSET_MS);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), min: d.getUTCMinutes() };
}

function ymd(y, m, d) {
    const x = new Date(Date.UTC(y, m, d));
    return x.toISOString().slice(0, 10);
}

/** Сегодня + days по Москве, YYYY-MM-DD. */
function moscowDate(ms, days = 0) {
    const p = moscowParts(ms);
    return ymd(p.y, p.m, p.d + days);
}

function addDays(dateStr, days) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return ymd(y, m - 1, d + days);
}

/**
 * Сколько мс до следующего запуска (строго в будущем): HH:MM по Москве и дальше каждые everyMinutes.
 * everyMinutes = 60, 00:05 → каждый час в :05; 1440 → раз в сутки.
 */
function msUntilNextRun(ms, hour, minute, everyMinutes = 1440) {
    const p = moscowParts(ms);
    const anchor = Date.UTC(p.y, p.m, p.d, hour, minute) - MOSCOW_OFFSET_MS;
    const step = everyMinutes * 60 * 1000;
    let target = anchor + (Math.floor((ms - anchor) / step) + 1) * step;
    if (target <= ms) target += step;
    return target - ms;
}

/** Сколько мс до следующего HH:MM по Москве (строго в будущем). */
function msUntilMoscowTime(ms, hour, minute) {
    return msUntilNextRun(ms, hour, minute, 1440);
}

// ---------- ключ поиска ----------

// Параметры /start-search, которые шлют сайт и приложение для обычного поиска. Любой другой —
// поиск не кешируем (вдруг он меняет выдачу).
const START_KEYS = new Set([
    'from_city', 'from_country', 'to_country', 'to_city', 'hotel_ids', 'adults', 'kids', 'kids_ages',
    'nights', 'start_date', 'start_date_from', 'start_date_till', 'end_date_from', 'end_date_till',
    'flex_dates', 'search_type',
    // Приложение шлёт в /start-search и параметры страницы — на ключ поиска LT они не влияют.
    'page_number', 'page_limit', 'sort_by',
]);

function scalar(v) {
    if (Array.isArray(v)) v = v.length ? v[v.length - 1] : '';
    if (v === undefined || v === null) return '';
    return String(v).trim();
}

function list(v) {
    const raw = Array.isArray(v) ? v : String(v ?? '').split(',');
    return raw.map((x) => String(x).trim()).filter(Boolean).join(',');
}

/**
 * Ключ поиска по параметрам /start-search или null, если поиск не из тех, что мы кешируем.
 * Совпадает для сайта и приложения: лишние поля дат (start_date_from = start_date, end_date_till)
 * на ключ LT не влияют и в ключ не входят.
 */
function searchKey(query) {
    if (!query || typeof query !== 'object') return null;
    for (const k of Object.keys(query)) {
        if (!START_KEYS.has(k)) return null;
    }
    const startDate = scalar(query.start_date);
    const nights = scalar(query.nights);
    const adults = scalar(query.adults);
    const fromCity = scalar(query.from_city);
    const toCountry = scalar(query.to_country).toUpperCase();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{1,2}$/.test(nights) || !/^\d$/.test(adults)) return null;
    if (!fromCity || !/^[A-Z]{2}$/.test(toCountry)) return null;
    const from = scalar(query.start_date_from);
    const till = scalar(query.start_date_till);
    if (from && from !== startDate) return null; // гибкие даты — не кешируем
    if (till && till !== startDate) return null;
    if (scalar(query.end_date_from)) return null;
    const flex = scalar(query.flex_dates);
    if (flex && flex !== '0' && flex !== 'false') return null;
    const type = scalar(query.search_type) || 'package';
    if (type !== 'package' && type !== 'hotel') return null;
    const kids = scalar(query.kids) || '0';
    if (!/^\d$/.test(kids)) return null;
    return [
        `from=${fromCity.toLowerCase()}`,
        `to=${toCountry}`,
        `city=${scalar(query.to_city).toLowerCase()}`,
        `hotels=${list(query.hotel_ids)}`,
        `date=${startDate}`,
        `nights=${Number(nights)}`,
        `adults=${Number(adults)}`,
        `kids=${Number(kids)}`,
        `ages=${Number(kids) > 0 ? list(query.kids_ages) : ''}`,
        `type=${type}`,
    ].join('|');
}

/**
 * Параметры к LT /search/get_grouped_hotels из query /grouped-hotels — одна функция для маршрута
 * и для прогрева, чтобы снимок совпадал с тем, что просит клиент.
 */
function buildGroupedHotelsParams(query) {
    const { request_id, operator_ids, readyOperators, ...rest } = query || {};
    const params = { request_id };
    // Level.Travel expects operator_ids; frontend may send readyOperators.
    // Axios may deliver repeated keys as an array — always forward as CSV.
    const rawOperatorIds = operator_ids || readyOperators;
    if (rawOperatorIds !== undefined && rawOperatorIds !== null && rawOperatorIds !== '') {
        params.operator_ids = Array.isArray(rawOperatorIds)
            ? rawOperatorIds.map(String).filter(Boolean).join(',')
            : String(rawOperatorIds);
    }
    const passthroughKeys = new Set(['page_limit', 'page_number', 'sort_by']);
    for (const [key, value] of Object.entries(rest)) {
        if (value === undefined || value === null || value === '') continue;
        if (!key.startsWith('filter_') && !passthroughKeys.has(key)) continue;
        // Amenity toggles are omit-when-off; only instant_confirm sends explicit false.
        if (String(value) === 'false' && key !== 'filter_instant_confirm') continue;
        params[key] = value;
    }
    return params;
}

/** Ключ варианта выдачи: параметры к LT без request_id и operator_ids, по алфавиту. */
function variantKey(ltParams) {
    return Object.keys(ltParams || {})
        .filter((k) => k !== 'request_id' && k !== 'operator_ids')
        .sort()
        .map((k) => `${k}=${Array.isArray(ltParams[k]) ? ltParams[k].join(',') : String(ltParams[k])}`)
        .join('&');
}

function readyOperators(status) {
    return Object.entries(status || {}).filter(([, s]) => READY.has(String(s))).map(([id]) => id);
}

function allTerminal(status) {
    const v = Object.values(status || {});
    return v.length > 0 && v.every((s) => TERMINAL.has(String(s)));
}

function countStatuses(status) {
    const out = {};
    for (const s of Object.values(status || {})) out[s] = (out[s] || 0) + 1;
    return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- кеш ----------

/**
 * @param {object} o
 * @param {object} o.lt  { enqueue(params), status(requestId), grouped(params), destinations() } → data LT
 * @param {object} [o.config] loadConfig()
 * @param {Function} [o.now]
 * @param {object} [o.log]
 * @param {Function} [o.wait] пауза между опросами (в проверках — мгновенно)
 * @param {boolean} [o.persist] писать снимки на диск (по умолчанию да)
 */
function createSearchCache({ lt, config = loadConfig(), now = Date.now, log = console, wait = sleep, persist = true } = {}) {
    const entries = new Map(); // key → entry
    const byRequestId = new Map(); // request_id → key
    const state = { running: null, lastRun: null, timer: null, nextRunAt: null, currentDate: null, currentKeys: null };

    const maxAgeMs = () => config.maxAgeHours * 60 * 60 * 1000;
    const isFresh = (e) => Boolean(e && e.refreshedAt && now() - e.refreshedAt < maxAgeMs());
    const isServable = (e) => isFresh(e) && e.servable;

    function fileFor(key) {
        return path.join(config.dir, `${crypto.createHash('sha1').update(key).digest('hex').slice(0, 20)}.json`);
    }

    function save(entry) {
        if (!persist) return;
        try {
            fs.mkdirSync(config.dir, { recursive: true });
            const file = fileFor(entry.key);
            const tmp = `${file}.${process.pid}.tmp`;
            const data = {
                key: entry.key, params: entry.params, requestId: entry.requestId, enqueue: entry.enqueue,
                status: entry.status, completeness: entry.completeness, variants: entry.variants,
                refreshedAt: entry.refreshedAt, servable: entry.servable, hotelsCount: entry.hotelsCount,
                name: entry.name, lastAttemptAt: entry.lastAttemptAt, lastResult: entry.lastResult, lastError: entry.lastError,
            };
            fs.writeFileSync(tmp, JSON.stringify(data));
            fs.renameSync(tmp, file);
        } catch (e) {
            log.warn('[SEARCH-CACHE] не удалось записать снимок на диск:', e.message);
        }
    }

    function remove(key) {
        const e = entries.get(key);
        if (!e) return;
        entries.delete(key);
        if (e.requestId && byRequestId.get(e.requestId) === key) byRequestId.delete(e.requestId);
        if (persist) {
            try { fs.unlinkSync(fileFor(key)); } catch (_) { /* нет файла */ }
        }
    }

    function put(entry) {
        entries.set(entry.key, entry);
        if (entry.requestId) byRequestId.set(entry.requestId, entry.key);
    }

    /** Снимки с диска после перезапуска; устаревшие удаляются. */
    function load() {
        if (!persist) return 0;
        let files = [];
        try { files = fs.readdirSync(config.dir).filter((f) => f.endsWith('.json')); } catch (_) { return 0; }
        let n = 0;
        for (const f of files) {
            const file = path.join(config.dir, f);
            try {
                const d = JSON.parse(fs.readFileSync(file, 'utf8'));
                const e = { ...d, refreshing: null, lastRefreshStart: 0 };
                if (!e.key || !isFresh(e)) { fs.unlinkSync(file); continue; }
                put(e);
                n++;
            } catch (_) {
                try { fs.unlinkSync(file); } catch (__) { /* */ }
            }
        }
        return n;
    }

    function ensureEntry(params, name) {
        const key = searchKey(params);
        if (!key) throw new Error(`search params are not cacheable: ${JSON.stringify(params)}`);
        let e = entries.get(key);
        if (!e) {
            e = {
                key, params, requestId: null, enqueue: null, status: null, completeness: 0, variants: {}, refreshedAt: 0,
                servable: false, hotelsCount: 0, refreshing: null, lastRefreshStart: 0,
                name: null, lastAttemptAt: 0, lastResult: null, lastError: null,
            };
            entries.set(key, e);
        }
        if (name) e.name = name;
        return e;
    }

    /**
     * Один поиск в LT: enqueue → опрос статуса → первая страница для сайта и приложения.
     * Снимок заменяется только при успехе; при сбое остаётся прежний.
     */
    function refresh(entry, reason) {
        if (entry.refreshing) return entry.refreshing;
        entry.lastRefreshStart = now();
        entry.lastAttemptAt = now();
        const started = now();
        entry.refreshing = (async () => {
            const enq = await lt.enqueue(entry.params);
            const requestId = enq && enq.request_id;
            if (!requestId) throw new Error('LT enqueue: нет request_id');
            const atStart = countStatuses(enq.status);
            let status = enq.status || {};
            let completeness = 0;
            const deadline = started + config.searchTimeoutSec * 1000;
            // Ждём всех операторов (как на хорошем повторном поиске), но не дольше таймаута.
            while (!(completeness >= 100 || allTerminal(status))) {
                if (now() >= deadline) break;
                await wait(config.pollMs);
                const st = await lt.status(requestId);
                if (st && st.status && typeof st.status === 'object') status = st.status;
                completeness = Number(st && st.completeness) || 0;
            }
            const ready = readyOperators(status);
            const variants = {};
            let hotelsCount = 0;
            if (ready.length) {
                for (const v of Object.values(DEFAULT_VARIANTS)) {
                    const params = buildGroupedHotelsParams({ request_id: requestId, operator_ids: ready.join(','), ...v });
                    const body = await lt.grouped(params);
                    if (body && Array.isArray(body.hotels)) {
                        variants[variantKey(params)] = body;
                        hotelsCount = Math.max(hotelsCount, Number(body.hotels_count) || body.hotels.length);
                    }
                }
            }
            const { status: _ignore, ...enqueueRest } = enq;
            const servable = hotelsCount > 0 && Object.keys(variants).length === Object.keys(DEFAULT_VARIANTS).length;
            if (!servable && entry.servable && isFresh(entry)) {
                // LT ничего не нашёл или сбой — прежний снимок не трогаем, пусть доживает.
                log.warn(`[SEARCH-CACHE] ${entry.key}: поиск без результатов (${JSON.stringify(countStatuses(status))}), оставлен прежний снимок`);
                entry.lastResult = 'kept';
                entry.lastError = null;
                return { key: entry.key, ok: false, hotels: 0, atStart, ms: now() - started };
            }
            if (entry.requestId && entry.requestId !== requestId) byRequestId.delete(entry.requestId);
            Object.assign(entry, {
                requestId, enqueue: enqueueRest, status, completeness: completeness >= 100 ? 100 : completeness,
                variants, refreshedAt: now(), servable, hotelsCount,
                lastResult: servable ? 'ok' : 'empty', lastError: null,
            });
            put(entry);
            save(entry);
            log.log(`[SEARCH-CACHE] ${reason} ${entry.key}: отелей ${hotelsCount}, операторы ${JSON.stringify(countStatuses(status))}, в начале ${JSON.stringify(atStart)}, ${Math.round((now() - started) / 1000)} с`);
            return { key: entry.key, ok: servable, hotels: hotelsCount, atStart, ms: now() - started };
        })().catch((e) => {
            log.warn(`[SEARCH-CACHE] ${reason} ${entry.key}: ошибка ${e && e.message}`);
            entry.lastResult = 'error';
            entry.lastError = String((e && e.message) || e).slice(0, 200);
            return { key: entry.key, ok: false, error: e && e.message, ms: now() - started };
        }).finally(() => {
            entry.refreshing = null;
        });
        return entry.refreshing;
    }

    function backgroundRefresh(entry) {
        if (entry.refreshing) return;
        if (now() - entry.lastRefreshStart < config.refreshMinutes * 60 * 1000) return;
        refresh(entry, 'обновление').catch(() => {});
    }

    // ---------- то, что вызывают маршруты ----------

    /** /start-search: ответ из снимка или null (идти в LT как обычно). */
    function lookupStart(query) {
        if (!config.enabled) return null;
        const key = searchKey(query);
        if (!key) return null;
        const e = entries.get(key);
        if (!isServable(e)) return null;
        backgroundRefresh(e);
        return {
            ...e.enqueue,
            success: true,
            request_id: e.requestId,
            status: e.status,
            cached_at: new Date(e.refreshedAt).toISOString(),
        };
    }

    /** /search-status: итоговые статусы снимка (completeness 100) или null. */
    function lookupStatus(requestId) {
        if (!config.enabled || !requestId) return null;
        const e = entries.get(byRequestId.get(String(requestId)));
        if (!isServable(e)) return null;
        return {
            status: e.status,
            size: e.hotelsCount,
            completeness: 100,
            request_id: e.requestId,
            success: true,
            cached_at: new Date(e.refreshedAt).toISOString(),
        };
    }

    /** /grouped-hotels: первая страница из снимка (только тот же набор фильтров) или null. */
    function lookupGrouped(ltParams) {
        if (!config.enabled || !ltParams || !ltParams.request_id) return null;
        const e = entries.get(byRequestId.get(String(ltParams.request_id)));
        if (!isServable(e)) return null;
        return e.variants[variantKey(ltParams)] || null;
    }

    // ---------- прогрев ----------

    /** Страны: [{ iso2, name }] из /references/destinations или SEARCH_CACHE_COUNTRIES. */
    async function countryList() {
        if (config.countries.length) return config.countries.map((iso2) => ({ iso2, name: iso2 }));
        const data = await lt.destinations();
        const seen = new Set();
        const list = [];
        for (const c of (data && Array.isArray(data.countries) ? data.countries : [])) {
            const iso2 = String(c && c.iso2 || '').toUpperCase();
            if (!/^[A-Z]{2}$/.test(iso2) || seen.has(iso2)) continue;
            seen.add(iso2);
            list.push({ iso2, name: String(c.name_ru || c.name_en || iso2) });
        }
        return list;
    }

    function warmParams(country, startDate) {
        return {
            from_city: config.fromCity,
            from_country: 'RU',
            to_country: country,
            adults: String(config.adults),
            nights: String(config.nights),
            flex_dates: '0',
            start_date: startDate,
            start_date_from: startDate,
            end_date_till: addDays(startDate, config.nights),
            kids: '0',
            search_type: 'package',
        };
    }

    /** Прогрев всех стран. Повторный вызов во время прогрева возвращает тот же прогон. */
    function warmAll(reason = 'прогрев') {
        if (state.running) return state.running;
        const started = now();
        state.running = (async () => {
            // Вчерашние и устаревшие снимки больше никто не попросит.
            const today = moscowDate(now());
            for (const [key, e] of [...entries]) {
                if (!isFresh(e) || String(e.params && e.params.start_date) < today) remove(key);
            }
            const countries = await countryList();
            const startDate = moscowDate(now(), config.daysAhead);
            const all = countries.map((c) => ensureEntry(warmParams(c.iso2, startDate), c.name));
            state.currentDate = startDate;
            state.currentKeys = all.map((e) => e.key);
            // Только что обновлённые (их искал пользователь) не трогаем — они и так свежие.
            const recentMs = config.refreshMinutes * 60 * 1000;
            const queue = all.filter((e) => !(e.lastResult === 'ok' && e.refreshedAt && now() - e.refreshedAt < recentMs));
            const skipped = all.length - queue.length;
            const results = [];
            async function worker() {
                while (queue.length) {
                    const e = queue.shift();
                    results.push(await refresh(e, reason));
                }
            }
            await Promise.all(Array.from({ length: Math.min(config.concurrency, queue.length || 1) }, worker));
            const summary = {
                reason,
                startedAt: new Date(started).toISOString(),
                finishedAt: new Date(now()).toISOString(),
                seconds: Math.round((now() - started) / 1000),
                date: startDate,
                countries: countries.length,
                skippedFresh: skipped,
                withHotels: results.filter((r) => r.ok).length + skipped,
                empty: results.filter((r) => !r.ok && !r.error).length,
                errors: results.filter((r) => r.error).length,
                // Сколько поисков LT уже держал в кеше к началу прогрева (оценка срока жизни кеша LT).
                alreadyCachedAtLt: results.filter((r) => r.atStart && r.atStart.cached).length,
            };
            summary.notUpdated = summaryRows().filter((r) => r.state !== 'ok').map((r) => `${r.iso2} ${r.state}`);
            state.lastRun = summary;
            log.log(`[SEARCH-CACHE] ${reason} готов: стран ${summary.countries}, с отелями ${summary.withHotels} (свежих без поиска ${skipped}), пусто ${summary.empty}, ошибки ${summary.errors}, ${summary.seconds} с, вылет ${startDate}`);
            if (persist) {
                try {
                    fs.mkdirSync(config.dir, { recursive: true });
                    fs.writeFileSync(path.join(config.dir, 'last-run.txt'), JSON.stringify(summary, null, 2));
                } catch (_) { /* не критично */ }
            }
            return summary;
        })().catch((e) => {
            log.warn(`[SEARCH-CACHE] ${reason} не выполнен: ${e && e.message}`);
            state.lastRun = { reason, startedAt: new Date(started).toISOString(), error: e && e.message };
            return state.lastRun;
        }).finally(() => {
            state.running = null;
        });
        return state.running;
    }

    function scheduleNext() {
        const ms = msUntilNextRun(now(), config.timeHour, config.timeMinute, config.everyMinutes);
        state.nextRunAt = now() + ms;
        state.timer = setTimeout(() => {
            warmAll(config.everyMinutes >= 1440 ? 'ночной прогрев' : 'прогрев по расписанию').finally(scheduleNext);
        }, ms);
        if (state.timer.unref) state.timer.unref();
        return ms;
    }

    /** Запуск при старте API: снимки с диска, расписание, догрев, если на сегодня снимков нет. */
    function start({ startupDelayMs = 60 * 1000 } = {}) {
        if (!config.enabled) {
            log.log('[SEARCH-CACHE] выключен (SEARCH_CACHE=on включает)');
            return false;
        }
        const loaded = load();
        const ms = scheduleNext();
        const date = moscowDate(now(), config.daysAhead);
        const hasToday = [...entries.values()].some((e) => e.params && e.params.start_date === date && isFresh(e));
        log.log(`[SEARCH-CACHE] включён: снимков с диска ${loaded}, прогрев ${scheduleText()} (следующий через ${Math.round(ms / 60000)} мин), ${config.fromCity} +${config.daysAhead} дн., ${config.nights} ноч., ${config.adults} взр.`);
        if (!hasToday) {
            const t = setTimeout(() => warmAll('прогрев после запуска'), startupDelayMs);
            if (t.unref) t.unref();
        }
        return true;
    }

    function stop() {
        if (state.timer) clearTimeout(state.timer);
        state.timer = null;
    }

    function scheduleText() {
        const hhmm = `${String(config.timeHour).padStart(2, '0')}:${String(config.timeMinute).padStart(2, '0')}`;
        if (config.everyMinutes >= 1440) return `каждый день в ${hhmm} МСК`;
        if (config.everyMinutes === 60) return `каждый час в :${String(config.timeMinute).padStart(2, '0')} МСК`;
        return `каждые ${config.everyMinutes} мин от ${hhmm} МСК`;
    }

    /**
     * Состояние каждой страны на текущую дату вылета:
     *   ok      — снимок обновлён за последний интервал прогрева (+15 мин запаса);
     *   empty   — поиск прошёл, но туров на эту дату нет (из кеша не отдаётся, ищется вживую);
     *   kept    — LT ничего не вернул, отдаётся прежний снимок;
     *   error   — поиск не удался (текст ошибки), отдаётся прежний снимок, если есть;
     *   stale   — снимок старше интервала прогрева;
     *   pending — ещё не искали (прогрев идёт или ещё не запускался).
     */
    function summaryRows() {
        const date = state.currentDate || moscowDate(now(), config.daysAhead);
        const staleMs = (config.everyMinutes + 15) * 60 * 1000;
        const keys = state.currentKeys && state.currentDate === date
            ? state.currentKeys
            : [...entries.values()].filter((e) => e.params && e.params.start_date === date).map((e) => e.key);
        return keys.map((k) => entries.get(k)).filter(Boolean).map((e) => {
            const age = e.refreshedAt ? now() - e.refreshedAt : null;
            let st;
            if (e.lastResult === 'error') st = 'error';
            else if (e.lastResult === 'kept') st = 'kept';
            else if (!e.lastAttemptAt && !e.refreshedAt) st = 'pending';
            else if (age === null || age > staleMs) st = 'stale';
            else st = e.servable ? 'ok' : 'empty';
            return {
                iso2: e.params.to_country,
                name: e.name || e.params.to_country,
                state: st,
                hotels: e.hotelsCount || 0,
                updated_at: e.refreshedAt ? new Date(e.refreshedAt).toISOString() : null,
                age_minutes: age === null ? null : Math.round(age / 60000),
                attempted_at: e.lastAttemptAt ? new Date(e.lastAttemptAt).toISOString() : null,
                error: e.lastResult === 'error' ? e.lastError : undefined,
                refreshing: Boolean(e.refreshing) || undefined,
            };
        }).sort((a, b) => a.iso2.localeCompare(b.iso2));
    }

    /**
     * Публичная сводка для чекапа и админки: какие направления обновлены, какие нет. Без выдачи и цен.
     */
    function summary() {
        const rows = summaryRows();
        const count = (st) => rows.filter((r) => r.state === st).length;
        const last = state.lastRun || {};
        return {
            enabled: config.enabled,
            schedule: scheduleText(),
            every_minutes: config.everyMinutes,
            date: state.currentDate || moscowDate(now(), config.daysAhead),
            search: { from_city: config.fromCity, days_ahead: config.daysAhead, nights: config.nights, adults: config.adults },
            running: Boolean(state.running),
            last_run: last.startedAt ? {
                started_at: last.startedAt, finished_at: last.finishedAt || null, seconds: last.seconds,
                errors: last.errors, error: last.error,
            } : null,
            next_run_at: state.nextRunAt ? new Date(state.nextRunAt).toISOString() : null,
            countries: rows.length,
            updated: count('ok'),
            no_tours: rows.filter((r) => r.state === 'empty').map((r) => ({ iso2: r.iso2, name: r.name, updated_at: r.updated_at })),
            not_updated: rows.filter((r) => !['ok', 'empty'].includes(r.state)),
            rows,
        };
    }

    /** Для админки: что в кеше, без выдачи. */
    function info() {
        const list = [...entries.values()]
            .map((e) => ({
                to_country: e.params && e.params.to_country,
                start_date: e.params && e.params.start_date,
                hotels: e.hotelsCount,
                servable: isServable(e),
                age_minutes: e.refreshedAt ? Math.round((now() - e.refreshedAt) / 60000) : null,
                refreshing: Boolean(e.refreshing),
                operators: countStatuses(e.status),
            }))
            .sort((a, b) => String(a.to_country).localeCompare(String(b.to_country)) || String(a.start_date).localeCompare(String(b.start_date)));
        return {
            enabled: config.enabled,
            schedule: scheduleText(),
            summary: summary(),
            config: {
                every_minutes: config.everyMinutes,
                time_msk: `${String(config.timeHour).padStart(2, '0')}:${String(config.timeMinute).padStart(2, '0')}`,
                from_city: config.fromCity,
                days_ahead: config.daysAhead,
                nights: config.nights,
                adults: config.adults,
                countries: config.countries.length ? config.countries : 'все из /references/destinations',
                max_age_hours: config.maxAgeHours,
                refresh_minutes: config.refreshMinutes,
            },
            running: Boolean(state.running),
            lastRun: state.lastRun,
            entries: list,
        };
    }

    return { lookupStart, lookupStatus, lookupGrouped, refresh, warmAll, start, stop, load, info, summary, _entries: entries };
}

module.exports = {
    loadConfig,
    createSearchCache,
    searchKey,
    buildGroupedHotelsParams,
    variantKey,
    moscowDate,
    msUntilMoscowTime,
    msUntilNextRun,
    DEFAULT_VARIANTS,
};
