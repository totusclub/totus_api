// Журнал согласий (consent_log). Без npm install и без БД:
//   node scripts/check-consents.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

// Поддельная БД: строки журнала в памяти.
const rows = [];
const queries = [];
const dbPath = path.join(root, 'db.js');
require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
        async query(sql, params = []) {
            const s = sql.replace(/\s+/g, ' ').trim();
            queries.push(s);
            if (/^CREATE TABLE IF NOT EXISTS consent_log/.test(s)) return [{}];
            if (/^INSERT INTO consent_log/.test(s)) {
                const cols = ['user_id', 'email', 'phone', 'consent_type', 'granted', 'doc_url', 'doc_version', 'form', 'ref_id', 'source', 'ip', 'user_agent'];
                for (const values of params[0]) rows.push(Object.fromEntries(cols.map((c, i) => [c, values[i]])));
                return [{ affectedRows: params[0].length }];
            }
            throw new Error('unexpected sql: ' + s);
        },
    },
};

const consents = require(path.join(root, 'lib/consents'));
const recorder = require(path.join(root, 'middleware/consentsRecorder'));
const ctrl = require(path.join(root, 'controllers/consents.controller'));

const warnings = [];
const origWarn = console.warn;
console.warn = (...a) => { warnings.push(a.join(' ')); };

let passed = 0;
let failed = 0;
async function check(name, fn) {
    try {
        await fn();
        passed += 1;
        console.log(`  ok   ${name}`);
    } catch (e) {
        failed += 1;
        console.log(`  FAIL ${name}\n       ${e && e.message ? e.message : e}`);
    }
}

const tick = () => new Promise((r) => setTimeout(r, 5));

/** Прогон запроса через middleware: handler отвечает как настоящий обработчик формы. */
async function run(method, url, body, handler, extra = {}) {
    const req = { method, path: url, body, ip: '10.0.0.1', headers: { origin: 'https://totus.club', ...(extra.headers || {}) }, get: () => 'UA/1', ...extra.req };
    const res = new EventEmitter();
    res.statusCode = 200;
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    let nextCalled = false;
    recorder()(req, res, () => { nextCalled = true; });
    assert.ok(nextCalled, 'middleware всегда зовёт next()');
    handler(req, res);
    res.emit('finish');
    await tick();
    return res;
}

const ok200 = (body) => (req, res) => res.status(200).json(body);

(async () => {
    console.log('Журнал согласий');

    await check('нормализация: только известные типы и булевы значения', () => {
        assert.deepStrictEqual(
            consents.normalizeConsents({ pd: true, ads: 'false', tour_offer: 1, evil: true, hotel_terms: 'yes' }),
            { pd: true, ads: false, tour_offer: true },
        );
        assert.deepStrictEqual(consents.normalizeConsents(null), {});
        assert.deepStrictEqual(consents.normalizeConsents([true]), {});
    });

    await check('обязательные: бронирование — pd и (оферта тура ИЛИ условия отеля)', () => {
        assert.deepStrictEqual(consents.missingRequired('booking', { pd: true, tour_offer: true }), []);
        assert.deepStrictEqual(consents.missingRequired('booking', { pd: true, hotel_terms: true }), []);
        assert.deepStrictEqual(consents.missingRequired('booking', { pd: true }), ['tour_offer|hotel_terms']);
        assert.deepStrictEqual(consents.missingRequired('callback', { ads: true }), ['pd']);
        assert.deepStrictEqual(consents.missingRequired('account', {}), []);
    });

    await check('обратный звонок: после 201 пишутся pd и отказ от рекламы, версия и адрес документа — с сервера', async () => {
        await run('POST', '/api/callback-requests', { phone: '79001234567', consents: { pd: true, ads: false, doc_version: 'x' } },
            (req, res) => res.status(201).json({ ok: true, id: 7 }));
        const pd = rows.find((r) => r.form === 'callback' && r.consent_type === 'pd');
        const ads = rows.find((r) => r.form === 'callback' && r.consent_type === 'ads');
        assert.ok(pd && ads, JSON.stringify(rows));
        assert.strictEqual(pd.granted, 1);
        assert.strictEqual(ads.granted, 0);
        assert.strictEqual(pd.doc_url, '/consent');
        assert.strictEqual(ads.doc_url, '/ads-consent');
        assert.strictEqual(pd.doc_version, consents.DOC_VERSION);
        assert.strictEqual(pd.phone, '79001234567');
        assert.strictEqual(pd.ref_id, '7');
        assert.strictEqual(pd.ip, '10.0.0.1');
        assert.strictEqual(pd.source, 'web');
        assert.ok(queries.some((q) => /^CREATE TABLE IF NOT EXISTS consent_log/.test(q)), 'таблица создаётся сама');
    });

    await check('ошибка формы (400) — ничего не пишется', async () => {
        const before = rows.length;
        await run('POST', '/api/callback-requests', { phone: '1', consents: { pd: true } },
            (req, res) => res.status(400).json({ error: 'invalid_phone' }));
        assert.strictEqual(rows.length, before);
    });

    await check('регистрация: пишется только при screen в ответе; почта в нижнем регистре', async () => {
        const before = rows.length;
        await run('POST', '/api/auth/signup', { email: 'X@Y.RU', consents: { pd: true } }, ok200({ message: 'captcha failed' }));
        assert.strictEqual(rows.length, before, 'нет screen — не успех');
        await run('POST', '/api/auth/signup', { email: 'X@Y.RU', phone: '+79001112233', consents: { pd: true, ads: true } }, ok200({ screen: 'VERIFICATION' }));
        const added = rows.slice(before);
        assert.strictEqual(added.length, 2);
        assert.ok(added.every((r) => r.form === 'signup' && r.email === 'x@y.ru'));
    });

    await check('бронирование: отказ Level.Travel (200 + error) не пишется; успех — с номером заказа и id пользователя', async () => {
        const before = rows.length;
        const body = { client: { email: 'a@b.ru', phone: '79000000000' }, consents: { pd: true, tour_offer: true, ads: false } };
        await run('POST', '/create-package', body, ok200({ error: { message: 'no seats' } }));
        assert.strictEqual(rows.length, before);
        await run('POST', '/create-package', body, (req, res) => { req.auth = { id: 42, role: 'user' }; res.json({ success: true, order: { id: 555 } }); });
        const added = rows.slice(before);
        assert.deepStrictEqual(added.map((r) => r.consent_type).sort(), ['ads', 'pd', 'tour_offer']);
        assert.ok(added.every((r) => r.user_id === 42 && r.ref_id === '555' && r.email === 'a@b.ru'));
        assert.strictEqual(added.find((r) => r.consent_type === 'tour_offer').doc_url, '/tour-offer');
    });

    await check('отель без перелёта: условия бронирования размещения /hotel-booking', async () => {
        const before = rows.length;
        await run('POST', '/create-package', { client: { email: 'h@b.ru', phone: '1' }, consents: { pd: true, hotel_terms: true } }, ok200({ success: true, order: { id: 9 } }));
        const hotel = rows.slice(before).find((r) => r.consent_type === 'hotel_terms');
        assert.ok(hotel);
        assert.strictEqual(hotel.doc_url, '/hotel-booking');
    });

    await check('заявка партнёра: ловушка для ботов (201 без id) не пишется', async () => {
        const before = rows.length;
        await run('POST', '/api/partner-requests', { email: 'p@p.ru', consents: { pd: true } }, (req, res) => res.status(201).json({ ok: true }));
        assert.strictEqual(rows.length, before);
        await run('POST', '/api/partner-requests/', { email: 'p@p.ru', consents: { pd: true } }, (req, res) => res.status(201).json({ ok: true, id: 3 }));
        assert.strictEqual(rows.length, before + 1);
    });

    await check('режим наблюдения: старое приложение без consents — запрос проходит, в лог [CONSENTS] missing, источник app', async () => {
        warnings.length = 0;
        const before = rows.length;
        const res = await run('POST', '/api/callback-requests', { phone: '79001234567' },
            (req, res) => res.status(201).json({ ok: true, id: 8 }), { headers: { origin: undefined } });
        assert.strictEqual(res.statusCode, 201);
        assert.strictEqual(rows.length, before);
        assert.ok(warnings.some((w) => /\[CONSENTS\] missing form=callback types=pd source=app/.test(w)), warnings.join('\n'));
    });

    await check('другие маршруты и GET не трогаются (res.json не подменяется)', async () => {
        const req = { method: 'GET', path: '/api/callback-requests', body: {}, headers: {} };
        const res = { json() {} };
        const orig = res.json;
        recorder()(req, res, () => {});
        assert.strictEqual(res.json, orig);
        assert.strictEqual(recorder.findRoute({ method: 'POST', path: '/api/auth/signin' }), null);
    });

    await check('POST /api/consents: пишет согласия вошедшего (Яндекс ID), пустой запрос — 400', async () => {
        const before = rows.length;
        const r = new EventEmitter();
        r.status = (c) => { r.statusCode = c; return r; };
        r.json = (b) => { r.body = b; return r; };
        await ctrl.create({
            body: { form: 'signup_yandex', consents: { pd: true, ads: false } },
            auth: { id: 77, role: 'user', payload: { email: 'Ya@Yandex.ru', phone: null } },
            headers: { origin: 'https://totus.club' }, ip: '1.1.1.1', get: () => 'UA',
        }, r);
        assert.strictEqual(r.statusCode, 201, JSON.stringify(r.body));
        const added = rows.slice(before);
        assert.strictEqual(added.length, 2);
        assert.ok(added.every((x) => x.user_id === 77 && x.form === 'signup_yandex' && x.email === 'ya@yandex.ru'));
        const empty = new EventEmitter();
        empty.status = (c) => { empty.statusCode = c; return empty; };
        empty.json = (b) => { empty.body = b; return empty; };
        await ctrl.create({ body: { consents: {} }, auth: { id: 1, payload: {} }, headers: {}, get: () => '' }, empty);
        assert.strictEqual(empty.statusCode, 400);
    });

    await check('подключение: middleware сразу после express.json, маршрут с strict JWT, миграция и npm-скрипты', () => {
        const app = read('app.js');
        const jsonAt = app.indexOf('app.use(express.json());');
        const recAt = app.indexOf("app.use(require('./middleware/consentsRecorder')());");
        assert.ok(jsonAt > 0 && recAt > jsonAt, 'recorder после express.json');
        assert.ok(recAt < app.indexOf("app.post('/create-package'"), 'recorder до обработчиков форм');
        assert.ok(app.includes("app.use('/api/consents', require('./routes/consents.routes'));"));
        assert.match(read('routes/consents.routes.js'), /router\.post\('\/', requireAuth\(\['user'\], \{ strict: true \}\), controller\.create\)/);
        const pkg = JSON.parse(read('package.json'));
        assert.ok(pkg.scripts.check.includes('node scripts/check-consents.js'));
        assert.strictEqual(pkg.scripts['migrate:consents'], 'node scripts/run-consents-migration.js');
        assert.ok(read('scripts/run-consents-migration.js').includes('CREATE_TABLE_SQL'));
    });

    console.warn = origWarn;
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
