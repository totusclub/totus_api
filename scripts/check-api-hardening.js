'use strict';
/**
 * Проверки SECURITY_AUDIT_2026-11 (H7/L1/L3/H9) без БД и сети:
 *   node scripts/check-api-hardening.js
 *  - lib/auth.js: токены с другим алгоритмом не принимаются (только HS256);
 *    JWT_PAYLOAD_MINIMAL=1 — в access-токене нет email/phone/имени;
 *  - lib/security.js apiLimiter: log-режим пропускает с записью в лог, enforce — 429,
 *    callback-пути без лимита, API_RATE_LIMIT=0 — выключен.
 */
const assert = require('assert');
const path = require('path');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'test-secret-1234567890';
process.env.JWT_REFRESH_SECRET = 'test-refresh-1234567890';

const root = path.join(__dirname, '..');
const auth = require(path.join(root, 'lib/auth.js'));
const security = require(path.join(root, 'lib/security.js'));

let passed = 0;
function test(name, fn) {
    try {
        fn();
        passed += 1;
        console.log(`ok   - ${name}`);
    } catch (e) {
        console.error(`FAIL - ${name}: ${e.message}`);
        process.exitCode = 1;
    }
}

const row = { id: 7, name: 'Ivan', l_name: 'Petrov', email: 'ivan@example.com', phone: '79990000000', loyalty_id: 'L1', role: 'user' };

test('HS256 access-токен принимается', () => {
    const t = auth.signUserToken(row);
    const p = auth.verifyAccessToken(t);
    assert.ok(p && Number(p.id) === 7);
});

test('access-токен с другим алгоритмом (HS512) отклоняется', () => {
    const t = jwt.sign({ id: 7, scope: 'user' }, process.env.JWT_SECRET, { algorithm: 'HS512' });
    assert.strictEqual(auth.verifyAccessToken(t), null);
});

test('refresh-токен с другим алгоритмом отклоняется', () => {
    const t = jwt.sign({ id: 7, scope: 'user', typ: 'refresh' }, process.env.JWT_REFRESH_SECRET, { algorithm: 'HS384' });
    assert.strictEqual(auth.verifyRefreshToken(t), null);
    const ok = auth.signRefreshToken(7, 'user');
    assert.ok(auth.verifyRefreshToken(ok));
});

test('по умолчанию payload содержит профиль (совместимость с клиентами)', () => {
    delete process.env.JWT_PAYLOAD_MINIMAL;
    const p = jwt.decode(auth.signUserToken(row));
    assert.strictEqual(p.email, 'ivan@example.com');
});

test('JWT_PAYLOAD_MINIMAL=1 — без email/phone/имени', () => {
    process.env.JWT_PAYLOAD_MINIMAL = '1';
    const p = jwt.decode(auth.signUserToken(row));
    assert.strictEqual(p.email, undefined);
    assert.strictEqual(p.phone, undefined);
    assert.strictEqual(p.name, undefined);
    assert.strictEqual(Number(p.id), 7);
    assert.strictEqual(p.scope, 'user');
    const a = jwt.decode(auth.signAgentToken({ ...row, role: 'agent' }));
    assert.strictEqual(a.email, undefined);
    assert.strictEqual(a.role, 'agent');
    delete process.env.JWT_PAYLOAD_MINIMAL;
});

// --- apiLimiter ---
function makeReq(ip, p) {
    return { ip, method: 'GET', path: p, originalUrl: p, headers: {}, app: { get: () => 1 }, socket: { remoteAddress: ip }, connection: { remoteAddress: ip } };
}
function makeRes() {
    const res = { statusCode: 200, headers: {}, body: null };
    res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; return res; };
    res.getHeader = (k) => res.headers[k.toLowerCase()];
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    res.send = res.json;
    res.end = () => res;
    return res;
}
function run(mw, req) {
    return new Promise((resolve, reject) => {
        const res = makeRes();
        let nexted = false;
        mw(req, res, (err) => { if (err) return reject(err); nexted = true; resolve({ res, nexted }); });
        setTimeout(() => resolve({ res, nexted }), 20);
    });
}

async function limiterTests() {
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...a) => warnings.push(a.join(' '));
    try {
        process.env.API_RATE_LIMIT = '2';
        process.env.API_RATE_WINDOW_MS = '60000';
        delete process.env.API_RATE_MODE;
        let mw = security.apiLimiter();
        let r;
        for (let i = 0; i < 3; i += 1) r = await run(mw, makeReq('10.0.0.1', '/start-search'));
        assert.strictEqual(r.nexted, true, 'log-режим должен пропускать');
        assert.ok(warnings.some((w) => w.includes('[RATE] mode=log exceeded ip=10.0.0.1')), 'лог превышения');
        passed += 1; console.log('ok   - лимитер log-режим: пропускает, пишет [RATE]');

        process.env.API_RATE_MODE = 'enforce';
        mw = security.apiLimiter();
        for (let i = 0; i < 3; i += 1) r = await run(mw, makeReq('10.0.0.2', '/start-search'));
        assert.strictEqual(r.nexted, false);
        assert.strictEqual(r.res.statusCode, 429);
        assert.deepStrictEqual(r.res.body, { error: 'too_many_requests' });
        passed += 1; console.log('ok   - лимитер enforce: 429 too_many_requests');

        for (let i = 0; i < 5; i += 1) r = await run(mw, makeReq('10.0.0.3', '/vtb/callback'));
        assert.strictEqual(r.nexted, true, 'callback банка без лимита');
        for (let i = 0; i < 5; i += 1) r = await run(mw, makeReq('10.0.0.3', '/tours/level_travel/notify'));
        assert.strictEqual(r.nexted, true, 'callback LT без лимита');
        passed += 1; console.log('ok   - callback-пути вне лимита');

        process.env.API_RATE_LIMIT = '0';
        mw = security.apiLimiter();
        for (let i = 0; i < 5; i += 1) r = await run(mw, makeReq('10.0.0.4', '/start-search'));
        assert.strictEqual(r.nexted, true);
        passed += 1; console.log('ok   - API_RATE_LIMIT=0 выключает лимитер');
    } catch (e) {
        console.error(`FAIL - apiLimiter: ${e.message}`);
        process.exitCode = 1;
    } finally {
        console.warn = origWarn;
    }
}

limiterTests().then(() => {
    console.log(`\n${passed} проверок прошло${process.exitCode ? ', есть ошибки' : ''}`);
});
