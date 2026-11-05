// История чатов с Машей в админке: /api/admin/ai-chats (только staff, только чтение).
//   node scripts/check-admin-ai-chats.js
// Без БД и сети: таблица ai_chats подменена.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
process.env.JWT_SECRET = 'check-secret';
delete process.env.AUTH_MODE;

const { signStaffToken, signUserToken } = require(path.join(root, 'lib/auth'));
const chats = require(path.join(root, 'lib/aiChatsAdmin'));
const { buildAdminAiChatsRoutes } = require(path.join(root, 'routes/adminAiChats.routes'));

const T0 = Date.parse('2026-11-01T10:00:00Z');
const ROWS = [
    {
        id: 'chat-a', user_id: 7, title: 'Турция в июле', updated_at: T0 + 3600e3, created_at: new Date(T0),
        messages_json: JSON.stringify([
            { id: 'm1', role: 'assistant', content: 'Привет! Я Маша.', timestamp: new Date(T0).toISOString() },
            { id: 'm2', role: 'user', content: 'Хочу в Турцию в июле, нас двое', timestamp: new Date(T0 + 60e3).toISOString() },
            {
                id: 'm3', role: 'assistant', content: 'Нашла варианты:', timestamp: T0 + 120e3,
                metadata: {
                    tool_calls: [{ name: 'search_tours', arguments: { secret: 'x' }, result: { raw: 1 }, label: 'Подбираю туры', summary: 'Нашла 42 отеля' }],
                    tour_results: [{
                        id: 'lt_1', name: 'Rixos Sungate', destination: 'Кемер', price: 152340, currency: 'RUB', stars: 5,
                        duration: '7 ночей', pick_label: 'Лучшая цена', link: 'https://totus.club/hotel-details?x=1',
                        images: ['a.jpg'], itinerary: [{ title: 'x' }], reviews: [{ author: 'Иван' }],
                    }, { name: 'Bad link', link: 'javascript:alert(1)' }],
                    room_cards: { hotel: { id: 1, name: 'Rixos' }, rooms: [{ room_type: 'Deluxe', min_price: 100000, currency: 'RUB', booking_url: 'https://totus.club/b' }] },
                    destination_cards: [{ name: 'Анталья', country: 'Турция', image: 'x.jpg' }],
                },
            },
        ]),
    },
    {
        id: 'chat-b', user_id: 7, title: '', updated_at: T0, created_at: null,
        messages_json: [{ role: 'user', content: '  ' }, { role: 'weird', content: 5 }],
    },
    { id: 'chat-c', user_id: 9, title: 'Чужой', updated_at: T0, created_at: new Date(T0), messages_json: '[]' },
];

function fakeDb({ missing = false, broken = false } = {}) {
    const sqls = [];
    return {
        sqls,
        async query(sql, params = []) {
            sqls.push({ sql, params });
            if (broken) throw new Error('db down');
            if (missing) { const e = new Error("Table 'kedam.ai_chats' doesn't exist"); e.code = 'ER_NO_SUCH_TABLE'; throw e; }
            assert(!/\b(INSERT|UPDATE|DELETE|DROP|ALTER)\b/i.test(sql), 'только чтение');
            if (/GROUP BY user_id/.test(sql)) {
                const by = {};
                for (const r of ROWS) {
                    const k = r.user_id;
                    by[k] = by[k] || { user_id: k, chats: 0, last_at: 0 };
                    by[k].chats += 1;
                    by[k].last_at = Math.max(by[k].last_at, r.updated_at);
                }
                return [Object.values(by)];
            }
            if (/WHERE user_id = \?/.test(sql)) {
                assert(/LIMIT \?$/.test(sql.trim()) && params[1] === chats.MAX_CHATS);
                return [ROWS.filter((r) => r.user_id === params[0]).sort((a, b) => b.updated_at - a.updated_at)];
            }
            if (/WHERE id = \?/.test(sql)) return [ROWS.filter((r) => r.id === params[0])];
            throw new Error(`unexpected sql ${sql}`);
        },
    };
}

function call(router, { url, token, method = 'GET' }) {
    return new Promise((resolve, reject) => {
        const [p, qs] = url.split('?');
        const req = {
            method, url, originalUrl: `/api/admin/ai-chats${url}`, baseUrl: '/api/admin/ai-chats', path: p,
            query: Object.fromEntries(new URLSearchParams(qs || '')), params: {},
            headers: token ? { authorization: `Bearer ${token}` } : {}, ip: '127.0.0.1',
        };
        const res = {
            statusCode: 200, headers: {},
            set(k, v) { this.headers[k.toLowerCase()] = v; return this; },
            setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
            getHeader(k) { return this.headers[k.toLowerCase()]; },
            status(c) { this.statusCode = c; return this; },
            json(b) { resolve({ status: this.statusCode, body: b, headers: this.headers }); return this; },
        };
        router(req, res, (err) => (err ? reject(err) : resolve({ status: 404, body: null, headers: res.headers })));
    });
}

const staff = signStaffToken({ id: 3, email: 'admin@totus.club' });
const user = signUserToken({ id: 7, email: 'u@x.ru' });

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('Без токена — 401, с токеном пользователя — 403, в базу не ходим', async () => {
    const db = fakeDb();
    const r = buildAdminAiChatsRoutes({ getDb: () => db, log: () => {} });
    assert.strictEqual((await call(r, { url: '/?userId=7' })).status, 401);
    assert.strictEqual((await call(r, { url: '/chat-a', token: 'bad.token.x' })).status, 401);
    assert.strictEqual((await call(r, { url: '/summary', token: user })).status, 403);
    assert.strictEqual(db.sqls.length, 0);
});

test('Строго и при AUTH_MODE=log (раньше /api/admin пропускал без токена)', async () => {
    process.env.AUTH_MODE = 'log';
    const r = buildAdminAiChatsRoutes({ getDb: () => fakeDb(), log: () => {} });
    assert.strictEqual((await call(r, { url: '/?userId=7' })).status, 401);
    delete process.env.AUTH_MODE;
});

test('Сводка: число чатов и последний чат по каждому пользователю, без кеша', async () => {
    const r = buildAdminAiChatsRoutes({ getDb: () => fakeDb(), log: () => {} });
    const res = await call(r, { url: '/summary', token: staff });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.users, { 7: { chats: 2, lastAt: T0 + 3600e3 }, 9: { chats: 1, lastAt: T0 } });
    assert.strictEqual(res.headers['cache-control'], 'no-store');
});

test('Список чатов пользователя: новые сверху, первое сообщение пользователя, число сообщений', async () => {
    const logs = [];
    const r = buildAdminAiChatsRoutes({ getDb: () => fakeDb(), log: (m) => logs.push(m) });
    const res = await call(r, { url: '/?userId=7', token: staff });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.chats.map((c) => c.id), ['chat-a', 'chat-b']);
    const a = res.body.chats[0];
    assert.deepStrictEqual(
        { title: a.title, preview: a.preview, messagesCount: a.messagesCount, userMessages: a.userMessages, createdAt: a.createdAt, updatedAt: a.updatedAt },
        { title: 'Турция в июле', preview: 'Хочу в Турцию в июле, нас двое', messagesCount: 3, userMessages: 1, createdAt: T0, updatedAt: T0 + 3600e3 },
    );
    assert.strictEqual(res.body.chats[1].title, 'Новый чат');
    assert.strictEqual(res.body.chats[1].preview, null);
    assert(!JSON.stringify(res.body).includes('Нашла варианты'), 'в списке нет текста ответов');
    assert(/\[AI-CHATS\] staff=3 list user=7 chats=2/.test(logs[0]), logs[0]);
    for (const bad of ['', 'abc', '0', '-1', '1.5']) {
        assert.strictEqual((await call(r, { url: `/?userId=${bad}`, token: staff })).status, 400, bad);
    }
});

test('Чат целиком: роли, текст, время; карточки без служебных полей; опасные ссылки убраны', async () => {
    const logs = [];
    const r = buildAdminAiChatsRoutes({ getDb: () => fakeDb(), log: (m) => logs.push(m) });
    const res = await call(r, { url: '/chat-a', token: staff });
    assert.strictEqual(res.status, 200);
    const c = res.body.chat;
    assert.deepStrictEqual([c.id, c.userId, c.title, c.createdAt], ['chat-a', 7, 'Турция в июле', T0]);
    assert.deepStrictEqual(c.messages.map((m) => [m.role, m.text, m.at]), [
        ['assistant', 'Привет! Я Маша.', T0],
        ['user', 'Хочу в Турцию в июле, нас двое', T0 + 60e3],
        ['assistant', 'Нашла варианты:', T0 + 120e3],
    ]);
    const cards = c.messages[2].cards;
    assert.deepStrictEqual(cards.tours[0], {
        name: 'Rixos Sungate', destination: 'Кемер', price: 152340, currency: 'RUB', stars: 5, nights: '7 ночей',
        label: 'Лучшая цена', comment: null, link: 'https://totus.club/hotel-details?x=1',
    });
    assert.strictEqual(cards.tours[1].link, null, 'javascript: ссылка не отдаётся');
    assert.deepStrictEqual(cards.rooms, { hotel: 'Rixos', rooms: [{ roomType: 'Deluxe', minPrice: 100000, currency: 'RUB', link: 'https://totus.club/b' }] });
    assert.deepStrictEqual(cards.destinations, [{ name: 'Анталья', country: 'Турция' }]);
    assert.deepStrictEqual(cards.steps, ['Нашла 42 отеля']);
    const json = JSON.stringify(res.body);
    for (const leak of ['"secret"', 'raw', 'itinerary', 'reviews', 'images']) assert(!json.includes(leak), `не отдаётся: ${leak}`);
    assert.strictEqual(c.messages[0].cards, null);
    assert(!logs.join(' ').includes('Турци'), 'текст переписки в лог не пишется');
});

test('Странные сообщения не ломают просмотр; нет чата — 404; плохой id — 400', async () => {
    const r = buildAdminAiChatsRoutes({ getDb: () => fakeDb(), log: () => {} });
    const b = (await call(r, { url: '/chat-b', token: staff })).body.chat;
    assert.deepStrictEqual(b.messages.map((m) => [m.id, m.role, m.text]), [['m0', 'user', '  '], ['m1', 'user', '']]);
    assert.strictEqual((await call(r, { url: '/nope', token: staff })).status, 404);
    assert.strictEqual((await call(r, { url: `/${'x'.repeat(65)}`, token: staff })).status, 400);
    assert.strictEqual((await call(r, { url: '/a%20b', token: staff })).status, 400);
});

test('Таблицы ai_chats ещё нет — пусто, а не ошибка; сбой базы — 500 без подробностей', async () => {
    let r = buildAdminAiChatsRoutes({ getDb: () => fakeDb({ missing: true }), log: () => {} });
    assert.deepStrictEqual((await call(r, { url: '/summary', token: staff })).body, { users: {} });
    assert.deepStrictEqual((await call(r, { url: '/?userId=7', token: staff })).body, { userId: 7, chats: [] });
    assert.strictEqual((await call(r, { url: '/chat-a', token: staff })).status, 404);
    const errOrig = console.error;
    console.error = () => {};
    try {
        r = buildAdminAiChatsRoutes({ getDb: () => fakeDb({ broken: true }), log: () => {} });
        const res = await call(r, { url: '/?userId=7', token: staff });
        assert.deepStrictEqual([res.status, res.body], [500, { error: 'ai_chats_failed' }]);
    } finally { console.error = errOrig; }
});

test('Время сообщения: ISO, число, строка-число, мусор', () => {
    assert.strictEqual(chats.toMs('2026-11-01T10:00:00.000Z'), T0);
    assert.strictEqual(chats.toMs(T0), T0);
    assert.strictEqual(chats.toMs(String(T0)), T0);
    assert.strictEqual(chats.toMs('вчера'), null);
    assert.strictEqual(chats.toMs(undefined), null);
});

test('Подключено в app.js: /api/admin/ai-chats, только чтение (GET)', () => {
    const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
    assert(app.includes("app.use('/api/admin/ai-chats', require('./routes/adminAiChats.routes').buildAdminAiChatsRoutes());"));
    const routes = fs.readFileSync(path.join(root, 'routes/adminAiChats.routes.js'), 'utf8');
    assert(!/router\.(post|put|patch|delete)\(/.test(routes), 'никаких изменений чатов');
    assert(/router\.use\(requireStaff\)/.test(routes));
});

(async () => {
    let failed = 0;
    for (const t of tests) {
        try {
            await t.fn();
            console.log(`  ✓ ${t.name}`);
        } catch (err) {
            failed++;
            console.log(`  ✗ ${t.name}\n    ${err.message}`);
        }
    }
    console.log(`check-admin-ai-chats: ${tests.length - failed}/${tests.length}`);
    if (failed) process.exit(1);
})();
