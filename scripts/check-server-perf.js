'use strict';

/**
 * Скорость сайта, этап A (сервер): кеш статики, WebP-копии, сжатие, кеш справочников.
 * Без сети, БД, express, sharp и compression: node scripts/check-server-perf.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const { cacheControlFor, staticOptions, PRIVATE, IMMUTABLE, FIXED_NAME } = require('../lib/staticCache');
const { webpNegotiation } = require('../middleware/webpNegotiation');
const { makeWebpSibling, uploadedFilePaths, optimizeUploadedImages } = require('../lib/imageOptimize');
const { publicCacheFor, publicCache } = require('../lib/publicCache');
const { optionalCompression } = require('../lib/optionalCompression');

let passed = 0;
const pending = [];
function check(name, fn) {
    pending.push(
        Promise.resolve()
            .then(fn)
            .then(() => {
                passed += 1;
                console.log(`  ok  ${name}`);
            })
    );
}

function fakeRes() {
    const res = new EventEmitter();
    res.headers = {};
    res.statusCode = 200;
    res.setHeader = (k, v) => {
        res.headers[k.toLowerCase()] = v;
    };
    res.getHeader = (k) => res.headers[k.toLowerCase()];
    res.vary = (v) => {
        res.headers.vary = res.headers.vary ? `${res.headers.vary}, ${v}` : v;
    };
    res.writeHead = function writeHead(code) {
        res.statusCode = code;
        return res;
    };
    return res;
}

function run(mw, req, res = fakeRes()) {
    let nextCalled = false;
    mw(req, res, () => {
        nextCalled = true;
    });
    return { res, nextCalled };
}

console.log('Сервер: скорость загрузки сайта (этап A)');

check('Cache-Control: уникальные имена — год immutable; постоянные — сутки; документы заказов — private', () => {
    assert.strictEqual(cacheControlFor('/hero/1791305414070-756639211.webp'), IMMUTABLE);
    assert.strictEqual(cacheControlFor('/banners/1783948867959-314060517.png'), IMMUTABLE);
    assert.strictEqual(cacheControlFor('/banners/1783948867959-314060517.png.webp'), IMMUTABLE);
    assert.strictEqual(cacheControlFor('/egypt.png'), FIXED_NAME);
    assert.strictEqual(cacheControlFor('/partners/tezTour.svg'), FIXED_NAME);
    assert.strictEqual(cacheControlFor('/orders/331445018/1783948867959-314060517.pdf'), PRIVATE);
    assert.strictEqual(cacheControlFor('/orders/foo.pdf'), PRIVATE);
    assert.ok(!/immutable|max-age=[1-9]/.test(PRIVATE));
    const root = path.join('/srv', 'api', 'uploads');
    const res = fakeRes();
    staticOptions(root).setHeaders(res, path.join(root, 'orders', '5', 'Ваучер.pdf'));
    assert.strictEqual(res.headers['cache-control'], PRIVATE, 'аварийный режим ORDER_DOCS_ACCESS=log не кеширует документы');
    staticOptions(root).setHeaders(res, path.join(root, 'hero', '1783950462399-145913179.jpg'));
    assert.strictEqual(res.headers['cache-control'], IMMUTABLE);
});

check('WebP по тому же адресу: только если копия есть и браузер принимает image/webp; Vary: Accept', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webpneg-'));
    fs.writeFileSync(path.join(dir, 'egypt.png'), 'png');
    fs.writeFileSync(path.join(dir, 'egypt.png.webp'), 'webp');
    fs.writeFileSync(path.join(dir, 'turky.png'), 'png');
    fs.mkdirSync(path.join(dir, 'orders'));
    fs.writeFileSync(path.join(dir, 'orders', 'a.png'), 'png');
    fs.writeFileSync(path.join(dir, 'orders', 'a.png.webp'), 'webp');
    const mw = webpNegotiation(dir);
    const chrome = 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8';

    let req = { method: 'GET', path: '/egypt.png', url: '/egypt.png?v=1', headers: { accept: chrome } };
    let r = run(mw, req);
    assert.ok(r.nextCalled);
    assert.strictEqual(req.url, '/egypt.png.webp?v=1');
    assert.strictEqual(r.res.headers.vary, 'Accept');

    req = { method: 'GET', path: '/egypt.png', url: '/egypt.png', headers: { accept: 'image/png,image/*' } };
    r = run(mw, req);
    assert.strictEqual(req.url, '/egypt.png', 'старый браузер получает PNG');
    assert.strictEqual(r.res.headers.vary, 'Accept');

    req = { method: 'GET', path: '/turky.png', url: '/turky.png', headers: { accept: chrome } };
    r = run(mw, req);
    assert.strictEqual(req.url, '/turky.png', 'нет копии — оригинал');
    assert.strictEqual(r.res.headers.vary, undefined);

    req = { method: 'GET', path: '/orders/a.png', url: '/orders/a.png', headers: { accept: chrome } };
    run(mw, req);
    assert.strictEqual(req.url, '/orders/a.png', 'документы заказов не трогаем');

    for (const bad of ['/../secret.png', '/%2e%2e/secret.png', '/%E0%A4%A.png']) {
        req = { method: 'GET', path: bad, url: bad, headers: { accept: chrome } };
        r = run(mw, req);
        assert.ok(r.nextCalled && req.url === bad, `выход за папку: ${bad}`);
    }
    req = { method: 'POST', path: '/egypt.png', url: '/egypt.png', headers: { accept: chrome } };
    run(mw, req);
    assert.strictEqual(req.url, '/egypt.png');
    fs.rmSync(dir, { recursive: true, force: true });
});

check('WebP-копия: создаётся рядом, только если меньше; без sharp — ничего не ломается', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webpmk-'));
    const big = path.join(dir, 'egypt.png');
    fs.writeFileSync(big, Buffer.alloc(4000));
    const fakeSharp = (size) => () => {
        const chain = {
            rotate: () => chain,
            resize: () => chain,
            webp: () => chain,
            toFile: async (out) => fs.writeFileSync(out, Buffer.alloc(size)),
        };
        return chain;
    };
    let r = await makeWebpSibling(big, { sharp: fakeSharp(300) });
    assert.strictEqual(r.status, 'created');
    assert.strictEqual(fs.statSync(`${big}.webp`).size, 300);
    assert.strictEqual(fs.statSync(big).size, 4000, 'оригинал на месте');
    r = await makeWebpSibling(big, { sharp: fakeSharp(300) });
    assert.strictEqual(r.status, 'exists');
    const small = path.join(dir, 'tiny.png');
    fs.writeFileSync(small, Buffer.alloc(100));
    r = await makeWebpSibling(small, { sharp: fakeSharp(500) });
    assert.strictEqual(r.status, 'larger');
    assert.ok(!fs.existsSync(`${small}.webp`));
    assert.strictEqual((await makeWebpSibling(big, { sharp: null })).status, 'no-sharp');
    assert.strictEqual((await makeWebpSibling(path.join(dir, 'logo.svg'), { sharp: fakeSharp(1) })).status, 'skipped');
    assert.strictEqual((await makeWebpSibling(path.join(dir, 'missing.png'), { sharp: fakeSharp(1) })).status, 'error');
    assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), [], 'временных файлов не осталось');
    fs.rmSync(dir, { recursive: true, force: true });
});

check('Загрузка из админки → WebP-копия в фоне после ответа (single / array / fields); ошибка ответа — нет', async () => {
    assert.deepStrictEqual(
        uploadedFilePaths({ file: { path: 'a.png' }, files: { image: [{ path: 'b.jpg' }], logo: [{ path: 'c.svg' }] } }),
        ['a.png', 'b.jpg', 'c.svg']
    );
    assert.deepStrictEqual(uploadedFilePaths({ files: [{ path: 'd.png' }] }), ['d.png']);
    const done = [];
    const mw = optimizeUploadedImages({ convert: async (p) => done.push(p) && { status: 'created' }, log: { warn() {} } });
    const req = { method: 'POST', file: { path: '/u/hero/1.png' }, files: [{ path: '/u/partners/x.svg' }] };
    const { res } = run(mw, req);
    assert.deepStrictEqual(done, [], 'до ответа ничего не делаем');
    res.emit('finish');
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(done, ['/u/hero/1.png'], 'SVG не конвертируем');
    const failed = run(mw, { method: 'PUT', file: { path: '/u/x.png' } }).res;
    failed.statusCode = 400;
    failed.emit('finish');
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(done, ['/u/hero/1.png']);
});

check('Публичный кеш: справочник городов 5 мин, контент главной 60 с; hero, авторизованные и POST — нет; ошибка — no-store', () => {
    assert.match(publicCacheFor('GET', '/references/departures', false), /max-age=300/);
    for (const p of ['/home/data', '/api/home/data', '/api/home-banners', '/api/home-partners', '/api/faq', '/api/footer-social']) {
        assert.match(publicCacheFor('GET', p, false), /^public, max-age=60/, p);
    }
    assert.strictEqual(publicCacheFor('GET', '/api/home-hero', false), null);
    assert.strictEqual(publicCacheFor('GET', '/api/home-banners', true), null);
    assert.strictEqual(publicCacheFor('POST', '/api/faq', false), null);
    assert.strictEqual(publicCacheFor('GET', '/user/orders', false), null);
    const { res } = run(publicCache(), { method: 'GET', path: '/api/faq', headers: {} });
    assert.match(res.headers['cache-control'], /max-age=60/);
    res.writeHead(500);
    assert.strictEqual(res.headers['cache-control'], 'no-store');
});

check('Сжатие: compression с порогом 1 КБ; если пакет не установлен — API работает без него', () => {
    let opts;
    const mw = optionalCompression({ load: () => (o) => { opts = o; return 'mw'; }, log: { warn() {} } });
    assert.strictEqual(mw, 'mw');
    assert.deepStrictEqual(opts, { threshold: 1024 });
    const warns = [];
    const noop = optionalCompression({ load: () => { throw new Error('Cannot find module'); }, log: { warn: (m) => warns.push(m) } });
    assert.ok(run(noop, {}).nextCalled);
    assert.strictEqual(warns.length, 1);
});

check('app.js: порядок middleware и кеш городов вылета', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    const at = (s) => {
        const i = src.indexOf(s);
        assert.ok(i >= 0, `нет: ${s}`);
        return i;
    };
    assert.ok(at('app.use(optionalCompression());') < at('app.use(helmetMiddleware());'));
    assert.ok(at("app.use('/uploads/orders', require('./middleware/orderDocumentsAccess')());") < at('app.use(mount, webpNegotiation(root), express.static(root, staticOptions(root)));'));
    assert.ok(!/express\.static\(path\.join\(__dirname, 'uploads'\)\)/.test(src), 'нет статики без заголовков');
    assert.ok(at("app.use('/api/admin', optimizeUploadedImages());") < at("app.use('/api/admin/rooms'"));
    assert.ok(at('app.use(publicCache());') < at("app.get('/home/data'"));
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    assert.ok(pkg.dependencies.compression);
    assert.ok(pkg.optionalDependencies && pkg.optionalDependencies.sharp, 'sharp необязателен: без него npm install не падает');
    const h = src.slice(at("app.get('/references/departures'"), src.indexOf("app.get('/references/destinations'"));
    assert.match(h, /if \(cached && Date\.now\(\) - cached\.at < DEPARTURES_FRESH_MS\) \{\s*return res\.json\(cached\.data\);/);
    assert.match(h, /departuresCache\.set\(cacheKey, \{ at: Date\.now\(\), data: response\.data \}\);/);
    assert.match(src, /const DEPARTURES_FRESH_MS = 10 \* 60 \* 1000;/);
});

Promise.all(pending)
    .then(() => console.log(`\n${passed} passed`))
    .catch((e) => {
        console.error(e);
        process.exit(1);
    });
