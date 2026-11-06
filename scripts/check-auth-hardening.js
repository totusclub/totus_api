'use strict';
/**
 * Проверки укрепления авторизации (SECURITY_AUDIT_2026-11_RU.md: C5, H1, M2, M7, M8).
 * Без БД и сети: db, почта, капча, axios подменяются. Запуск: node scripts/check-auth-hardening.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const root = path.resolve(__dirname, '..');
let passed = 0;
let failed = 0;
async function check(name, fn) {
    try { await fn(); passed++; console.log(`  ok   ${name}`); }
    catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e && e.message ? e.message : e}`); }
}

// ── заглушки ─────────────────────────────────────────────────────────────────────
function makeDb({ codeCols = true } = {}) {
    const user = { id: 7, name: 'Иван', email: 'u@example.com', code: '4821', code_attempts: 0, code_expires_at: null, access: 0 };
    const log = [];
    return {
        user, log,
        async query(sql, params = []) {
            log.push({ sql, params });
            if (/INFORMATION_SCHEMA\.COLUMNS/.test(sql) && /code_expires_at/.test(sql)) {
                return [codeCols ? [{ COLUMN_NAME: 'code_expires_at' }, { COLUMN_NAME: 'code_attempts' }] : []];
            }
            if (/INFORMATION_SCHEMA\.COLUMNS/.test(sql)) return [[]];
            if (/^SELECT \* FROM users WHERE email = \?/.test(sql)) return [params[0] === user.email ? [{ ...user }] : []];
            if (/UPDATE users SET code_attempts = COALESCE/.test(sql)) { user.code_attempts += 1; return [{ affectedRows: 1 }]; }
            if (/UPDATE users SET code = NULL/.test(sql)) { user.code = null; if (/code_attempts = 0/.test(sql)) user.code_attempts = 0; return [{ affectedRows: 1 }]; }
            if (/UPDATE users SET code = \?/.test(sql)) { user.code = params[0]; return [{ affectedRows: 1 }]; }
            if (/UPDATE users SET code_expires_at/.test(sql)) { user.code_expires_at = new Date(Date.now() + params[0] * 1000); user.code_attempts = 0; return [{ affectedRows: 1 }]; }
            return [[]];
        },
    };
}
const stubs = (db) => ({
    '../db': db,
    '../utils/yandexCloudEmail': { sendEmail: async () => {} },
    '../utils/emailTemplates': { verificationCodeTemplate: () => ({ subject: 's', text: 't', html: 'h' }) },
    '../utils/yandexSmartCaptcha': { verifyYandexSmartCaptcha: async () => ({ ok: true }) },
    '../utils/loyaltyGenerator': { generateUniqueLoyaltyId: () => '0000 0000 0000 0001' },
    '../lib/auth': {
        signUserToken: (u) => `access-${u.id}`, signRefreshToken: (id) => `refresh-${id}`,
        publicUser: (u) => ({ id: u.id, email: u.email }), roleOf: () => 'user', signAgentToken: () => 'a',
    },
    axios: { post: async () => ({ data: {} }) },
    // В проверке нет node_modules проекта — на сервере эти пакеты настоящие.
    bcryptjs: { compare: async () => false, hash: async (v) => `hash:${v}` },
    jsonwebtoken: { sign: () => 'jwt', verify: () => ({}) },
});
function loadFresh(rel, db) {
    const abs = path.join(root, rel);
    const map = stubs(db);
    const realLoad = Module._load;
    Module._load = function (request, parent, isMain) {
        if (parent && parent.filename === abs && map[request]) return map[request];
        return realLoad.call(this, request, parent, isMain);
    };
    delete require.cache[abs];
    try { return require(abs); } finally { Module._load = realLoad; }
}
function fakeRes() {
    const res = { statusCode: 200, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    return res;
}

(async () => {
    console.log('Укрепление авторизации: коды входа, секретные поля, /init, ошибки');

    await check('C5: код генерируется crypto.randomInt, длина 4 по умолчанию, без ведущего нуля', () => {
        const src = fs.readFileSync(path.join(root, 'controllers/auth.controller.js'), 'utf8');
        assert.match(src, /crypto\.randomInt\(min, max\)/);
        assert.ok(!/Math\.random\(\) \* 9000/.test(src), 'старый Math.random убран');
        const c = loadFresh('controllers/auth.controller.js', makeDb());
        // generateCode не экспортируется — проверяем через verificationCode: не 1111, 4 цифры
        assert.ok(!/const code = 1111;/.test(src), 'литерал 1111 в телефонной верификации убран (M2)');
        assert.match(src, /code_length: LOGIN_CODE_LENGTH/);
        assert.ok(c.verifyCode && c.signin && c.signup);
    });

    await check('C5: лимит попыток — после 5 неверных кодов 429, счётчик растёт', async () => {
        const db = makeDb();
        const c = loadFresh('controllers/auth.controller.js', db);
        for (let i = 0; i < 5; i++) {
            const res = fakeRes();
            await c.verifyCode({ body: { email: 'u@example.com', code: '0000' } }, res);
            assert.strictEqual(res.statusCode, 400, `попытка ${i + 1}`);
        }
        assert.strictEqual(db.user.code_attempts, 5);
        const res = fakeRes();
        await c.verifyCode({ body: { email: 'u@example.com', code: '4821' } }, res); // даже верный код
        assert.strictEqual(res.statusCode, 429);
        assert.strictEqual(res.body.error, 'too_many_attempts');
    });

    await check('C5: просроченный код не принимается', async () => {
        const db = makeDb();
        db.user.code_expires_at = new Date(Date.now() - 1000);
        const c = loadFresh('controllers/auth.controller.js', db);
        const res = fakeRes();
        await c.verifyCode({ body: { email: 'u@example.com', code: '4821' } }, res);
        assert.strictEqual(res.statusCode, 400);
    });

    await check('C5: верный живой код → токены, код гасится, счётчик сброшен', async () => {
        const db = makeDb();
        db.user.code_attempts = 3;
        db.user.code_expires_at = new Date(Date.now() + 60000);
        const c = loadFresh('controllers/auth.controller.js', db);
        const res = fakeRes();
        await c.verifyCode({ body: { email: 'u@example.com', code: '4821' } }, res);
        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.accessToken, 'access-7');
        assert.strictEqual(db.user.code, null);
        assert.strictEqual(db.user.code_attempts, 0);
    });

    await check('C5: без колонок (до миграции) — поведение как раньше: совпадение кода, без 429', async () => {
        const db = makeDb({ codeCols: false });
        const c = loadFresh('controllers/auth.controller.js', db);
        for (let i = 0; i < 7; i++) { const r = fakeRes(); await c.verifyCode({ body: { email: 'u@example.com', code: '0000' } }, r); assert.strictEqual(r.statusCode, 400); }
        const res = fakeRes();
        await c.verifyCode({ body: { email: 'u@example.com', code: '4821' } }, res);
        assert.strictEqual(res.statusCode, 200);
        assert.ok(!db.log.some((q) => /code_attempts/.test(q.sql) && /COALESCE/.test(q.sql)), 'без колонки счётчик не пишется');
    });

    await check('C5: signin выставляет срок жизни кода и обнуляет попытки', async () => {
        const db = makeDb();
        const c = loadFresh('controllers/auth.controller.js', db);
        const res = fakeRes();
        await c.signin({ body: { email: 'u@example.com' }, headers: {} }, res);
        assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
        assert.ok(db.user.code_expires_at instanceof Date && db.user.code_expires_at > new Date());
        assert.match(String(db.user.code), /^\d{4}$/);
    });

    await check('M7: тексты внутренних ошибок не уходят клиенту (auth.controller, authController)', () => {
        for (const f of ['controllers/auth.controller.js', 'controllers/authController.js']) {
            const src = fs.readFileSync(path.join(root, f), 'utf8');
            assert.ok(!/error: err\.message/.test(src), `${f}: error: err.message`);
            assert.ok(!/error\.sqlMessage/.test(src), `${f}: sqlMessage`);
        }
    });

    await check('H1: списки пользователей без code/password/refresh_token', () => {
        const src = fs.readFileSync(path.join(root, 'controllers/authController.js'), 'utf8');
        assert.match(src, /USER_SECRET_FIELDS = \['code', 'password', 'refresh_token'/);
        assert.match(src, /res\.json\(users\.map\(stripUserSecrets\)\)/);
        assert.match(src, /users:users\.map\(stripUserSecrets\)/);
        assert.ok(!/console\.log\('decoded'/.test(src), 'лог decoded-токена убран');
    });

    await check('M8: /api/admin/auth/init под проверкой роли staff', () => {
        const src = fs.readFileSync(path.join(root, 'routes/authRoutes.js'), 'utf8');
        assert.match(src, /router\.post\('\/init', staffOnly, authController\.userInit\)/);
    });

    await check('M1: демо-аккаунт Apple отключается APPLE_DEMO_ENABLED=0', () => {
        const src = fs.readFileSync(path.join(root, 'controllers/auth.controller.js'), 'utf8');
        assert.match(src, /APPLE_DEMO_ENABLED = process\.env\.APPLE_DEMO_ENABLED !== '0'/);
        assert.match(src, /return APPLE_DEMO_ENABLED && normalizeEmail\(email\) === APPLE_DEMO_EMAIL/);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
