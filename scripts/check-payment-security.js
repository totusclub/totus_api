'use strict';
/**
 * Проверки платёжного контура после аудита (SECURITY_AUDIT_2026-11_RU.md: C2, C3, H4, H5, M3, M4).
 * Без БД, сети и банка. Запуск: node scripts/check-payment-security.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
let passed = 0;
let failed = 0;
async function check(name, fn) {
    try { await fn(); passed++; console.log(`  ok   ${name}`); }
    catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e && e.message ? e.message : e}`); }
}
const quiet = { warn() {}, error() {}, log() {} };

// Заглушки остаются активными и для «ленивых» require внутри обработчиков (ferma/hooks, orderEmails …).
let activeStubs = {};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (parent && activeStubs[request] && String(parent.filename || '').startsWith(root)) return activeStubs[request];
    return realLoad.call(this, request, parent, isMain);
};
function loadWithStubs(rel, stubs) {
    const abs = path.join(root, rel);
    activeStubs = stubs;
    delete require.cache[abs];
    return require(abs);
}
const dbStub = { query: async () => [[]] };
// Общие заглушки для utils/vtbCallback.js (сеть, хаб уведомлений).
const callbackBase = {
    axios: { post: async () => { throw new Error('LT не должен уведомляться'); } },
    '../lib/notifyHub': { resolveOrderUserId: async () => null, paymentFailed: async () => {} },
    '../lib/env': { requireEnv: (n) => `stub-${n}`, env: () => undefined },
};
const policy = loadWithStubs('lib/paymentPolicy.js', { '../db': dbStub });

function withEnv(vars, fn) {
    const saved = {};
    for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] == null) delete process.env[k]; else process.env[k] = vars[k]; }
    const restore = () => { for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } };
    let out;
    try { out = fn(); } catch (e) { restore(); throw e; }
    if (out && typeof out.then === 'function') return out.finally(restore);
    restore();
    return out;
}

(async () => {
    console.log('Платежи: сумма с сервера, payUrl, callback банка, TLS, капча, загрузки');

    await check('C3: сумма берётся из заказа, значение клиента игнорируется (server-first)', () => {
        withEnv({ PAYMENT_AMOUNT_SOURCE: null }, () => {
            const row = { package: JSON.stringify({ _pay_amount: 150000 }) };
            const r = policy.chooseAmount({ serverAmount: policy.resolveServerAmount(row), clientAmount: { value: 1, code: 'RUB' }, orderId: 1, log: quiet });
            assert.strictEqual(r.amount, 150000);
            assert.strictEqual(r.source, 'server');
            assert.strictEqual(r.mismatch, true);
        });
    });

    await check('C3: нет суммы в заказе — server-first берёт клиентскую (с логом), strict отказывает', () => {
        withEnv({ PAYMENT_AMOUNT_SOURCE: null }, () => {
            const r = policy.chooseAmount({ serverAmount: null, clientAmount: 999, orderId: 2, log: quiet });
            assert.strictEqual(r.amount, 999); assert.strictEqual(r.source, 'client');
        });
        withEnv({ PAYMENT_AMOUNT_SOURCE: 'server' }, () => {
            const r = policy.chooseAmount({ serverAmount: null, clientAmount: 999, orderId: 2, log: quiet });
            assert.strictEqual(r.amount, null);
        });
    });

    await check('C3: resolveServerAmount — _pay_amount, затем цена LT (price + fuel_charge), затем full_price', () => {
        assert.strictEqual(policy.resolveServerAmount({ package: JSON.stringify({ _pay_amount: '120 500' }) }), 120500);
        assert.strictEqual(policy.resolveServerAmount({ package: JSON.stringify({ package: { price: 100000, fuel_charge: 5000 } }) }), 105000);
        assert.strictEqual(policy.resolveServerAmount({ package: JSON.stringify({ full_price: 77000 }) }), 77000);
        assert.strictEqual(policy.resolveServerAmount({ package: '{}' }), null);
        assert.strictEqual(policy.resolveServerAmount(null), null);
    });

    await check('C3: payUrl клиента — только https на хосты платёжных систем', () => {
        assert.strictEqual(policy.clientPayUrlAllowed('https://qr.nspk.ru/AS1A0023'), true);
        assert.strictEqual(policy.clientPayUrlAllowed('https://pay.vtb.ru/x'), true);
        assert.strictEqual(policy.clientPayUrlAllowed('https://evil.example/pay'), false);
        assert.strictEqual(policy.clientPayUrlAllowed('http://qr.nspk.ru/x'), false);
        assert.strictEqual(policy.clientPayUrlAllowed('javascript:alert(1)'), false);
        assert.strictEqual(policy.clientPayUrlAllowed(''), false);
        withEnv({ PAYMENT_PAYURL_HOSTS: 'pay.example.com' }, () => {
            assert.strictEqual(policy.clientPayUrlAllowed('https://pay.example.com/a'), true);
            assert.strictEqual(policy.clientPayUrlAllowed('https://qr.nspk.ru/a'), false);
        });
    });

    await check('C2: guard callback — allowlist IP (точный и CIDR), секрет, пустые настройки = пропуск', async () => {
        const run = (env, req) => withEnv(env, () => new Promise((resolve) => {
            const res = { status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b }); } };
            policy.vtbCallbackGuard({ log: quiet })(req, res, () => resolve({ next: true }));
        }));
        assert.deepStrictEqual(await run({ VTB_CALLBACK_ALLOWED_IPS: null, VTB_CALLBACK_SECRET: null }, { ip: '1.2.3.4', headers: {}, query: {} }), { next: true });
        assert.strictEqual((await run({ VTB_CALLBACK_ALLOWED_IPS: '10.0.0.5, 185.12.0.0/16', VTB_CALLBACK_SECRET: null }, { ip: '1.2.3.4', headers: {}, query: {} })).code, 403);
        assert.deepStrictEqual(await run({ VTB_CALLBACK_ALLOWED_IPS: '10.0.0.5, 185.12.0.0/16', VTB_CALLBACK_SECRET: null }, { ip: '185.12.77.3', headers: {}, query: {} }), { next: true });
        assert.deepStrictEqual(await run({ VTB_CALLBACK_ALLOWED_IPS: '10.0.0.5', VTB_CALLBACK_SECRET: null }, { ip: '::ffff:10.0.0.5', headers: {}, query: {} }), { next: true });
        assert.strictEqual((await run({ VTB_CALLBACK_ALLOWED_IPS: null, VTB_CALLBACK_SECRET: 's3cret' }, { ip: '1.1.1.1', headers: {}, query: {} })).code, 403);
        assert.deepStrictEqual(await run({ VTB_CALLBACK_ALLOWED_IPS: null, VTB_CALLBACK_SECRET: 's3cret' }, { ip: '1.1.1.1', headers: { 'x-callback-secret': 's3cret' }, query: {} }), { next: true });
        assert.deepStrictEqual(await run({ VTB_CALLBACK_ALLOWED_IPS: null, VTB_CALLBACK_SECRET: 's3cret' }, { ip: '1.1.1.1', headers: {}, query: { secret: 's3cret' } }), { next: true });
    });

    await check('C2: при VTB_CALLBACK_VERIFY=1 неподтверждённый банком RECONCILED ничего не меняет в заказе', async () => {
        const queries = [];
        const db = {
            async query(sql, params) {
                queries.push(sql);
                if (/SELECT order_id, pay_status, transaction_code FROM orders WHERE order_id/.test(sql)) return [[{ order_id: 555, pay_status: 'CREATED', transaction_code: 'qr1' }]];
                if (/SELECT package FROM orders/.test(sql)) return [[{ package: JSON.stringify({ _pay_amount: 150000 }) }]];
                return [[]];
            },
        };
        const vtbCallback = loadWithStubs('utils/vtbCallback.js', {
            ...callbackBase,
            '../db': db,
            './callbackLogger': { logCallback() {}, logCallbackError() {}, logCallbackBanner() {} },
            '../lib/customRooms/vtbCheck': { canonicalPayStatus: (v) => (String(v).toUpperCase() === 'RECONCILED' ? 'RECONCILED' : String(v).toUpperCase()), checkSbpPayment: async () => ({ paid: false, payStatus: 'CREATED', amount: null }) },
            '../lib/ferma/hooks': { firePaymentReceipt() { throw new Error('чек не должен пробиваться'); } },
            './orderEmails': { sendOrderPaidPendingEmail: async () => { throw new Error('письмо не должно уходить'); } },
            '../lib/customRooms/bookings': { isInternalOrder: async () => false },
        });
        const out = await withEnv({ VTB_CALLBACK_VERIFY: '1' }, () => vtbCallback.processVtbCallback({
            type: 'PAYMENT', object: { description: 'ORDER555', status: { value: 'RECONCILED' }, amount: { value: '150000' } },
        }));
        assert.strictEqual(out.verified, false);
        assert.strictEqual(out.reason, 'bank_not_paid');
        assert.ok(!queries.some((q) => /^UPDATE/.test(q)), 'UPDATE не выполнялся');
    });

    await check('C2: при VTB_CALLBACK_VERIFY=1 расхождение суммы отклоняется ещё до запроса в банк', async () => {
        let bankCalled = false;
        const vtbCallback = loadWithStubs('utils/vtbCallback.js', {
            ...callbackBase,
            '../db': { async query(sql) {
                if (/SELECT order_id, pay_status, transaction_code FROM orders WHERE order_id/.test(sql)) return [[{ order_id: 7, pay_status: 'CREATED', transaction_code: null }]];
                if (/SELECT package FROM orders/.test(sql)) return [[{ package: JSON.stringify({ _pay_amount: 150000 }) }]];
                return [[]];
            } },
            './callbackLogger': { logCallback() {}, logCallbackError() {}, logCallbackBanner() {} },
            '../lib/customRooms/vtbCheck': { canonicalPayStatus: () => 'RECONCILED', checkSbpPayment: async () => { bankCalled = true; return { paid: true, payStatus: 'RECONCILED', amount: 1 }; } },
            '../lib/ferma/hooks': { firePaymentReceipt() {} },
            '../lib/customRooms/bookings': { isInternalOrder: async () => false },
        });
        const out = await withEnv({ VTB_CALLBACK_VERIFY: '1' }, () => vtbCallback.processVtbCallback({
            type: 'PAYMENT', object: { description: 'ORDER7', status: { value: 'RECONCILED' }, amount: { value: '1' } },
        }));
        assert.strictEqual(out.verified, false);
        assert.strictEqual(out.reason, 'amount_mismatch');
        assert.strictEqual(bankCalled, false);
    });

    await check('C2: без VTB_CALLBACK_VERIFY поведение прежнее (статус пишется в БД)', async () => {
        const queries = [];
        const vtbCallback = loadWithStubs('utils/vtbCallback.js', {
            ...callbackBase,
            '../db': { async query(sql) {
                queries.push(sql);
                if (/SELECT order_id, pay_status, transaction_code FROM orders WHERE order_id/.test(sql)) return [[{ order_id: 9, pay_status: 'CREATED', transaction_code: null }]];
                return [[]];
            } },
            './callbackLogger': { logCallback() {}, logCallbackError() {}, logCallbackBanner() {} },
            '../lib/customRooms/vtbCheck': { canonicalPayStatus: () => 'REJECTED' },
            '../lib/ferma/hooks': { firePaymentReceipt() {} },
            '../lib/customRooms/bookings': { isInternalOrder: async () => false },
        });
        const out = await withEnv({ VTB_CALLBACK_VERIFY: null }, () => vtbCallback.processVtbCallback({
            type: 'PAYMENT', object: { description: 'ORDER9', status: { value: 'REJECTED' }, amount: { value: '10' } },
        }));
        assert.strictEqual(out.success, true);
        assert.ok(queries.some((q) => /^UPDATE orders SET pay_status/.test(q)));
    });

    await check('app.js: маршруты платежей под requireAuth, guard на callback, сумма через paymentPolicy', () => {
        const app = read('app.js');
        assert.match(app, /app\.post\('\/vtb\/create-order', requireAuth\(\['user'\]\)/);
        assert.match(app, /app\.post\('\/vtb\/callback', paymentPolicy\.vtbCallbackGuard\(\)/);
        assert.match(app, /app\.post\('\/level_travel\/notify-paid', requireAuth\(\['user'\]\)/);
        assert.match(app, /app\.post\('\/payment\/status', requireAuth\(\['staff'\]\)/);
        assert.ok((app.match(/paymentPolicy\.chooseAmount\(/g) || []).length >= 3, 'chooseAmount в create-order, create-package, notify-paid');
        assert.match(app, /clientPayUrlAllowed\(payload\?\.payUrl\)/);
        assert.match(app, /req\.auth && req\.auth\.role === 'staff' \? normalizeAmount\(req\.query\.amount\) : null/);
        assert.ok(!/console\.log\('auth_token'/.test(app), 'лог auth_token убран (M6)');
    });

    await check('H4: /client/orders/:id и /sync проверяют владельца; env-токен LT только для staff', () => {
        const app = read('app.js');
        const byId = app.slice(app.indexOf("app.get('/client/orders/:order_id'"), app.indexOf("app.post('/client/orders/:order_id/sync'"));
        assert.match(byId, /assertOrderOwner\(req, res, orderRow\.user_id\)/);
        const sync = app.slice(app.indexOf("app.post('/client/orders/:order_id/sync'"), app.indexOf("app.get('/orders', requireAuth"));
        assert.match(sync, /assertOrderOwner\(req, res, ownerRows\[0\]\.user_id\)/);
        assert.match(sync, /isStaff \? process\.env\.LT_CLIENT_AUTH_TOKEN : null/);
    });

    await check('H5: сертификат банка проверяется по умолчанию (VTB_TLS_INSECURE=1 — только аварийно)', () => {
        assert.match(read('utils/vtbCreatePayment.js'), /rejectUnauthorized: !vtbTlsInsecure/);
        assert.match(read('lib/customRooms/vtbCheck.js'), /rejectUnauthorized: process\.env\.VTB_TLS_INSECURE !== '1'/);
        assert.ok(!/rejectUnauthorized: false/.test(read('utils/vtbCreatePayment.js') + read('lib/customRooms/vtbCheck.js')));
    });

    await check('M3: капча без ключа — отказ (fail-closed), IP из req.ip', async () => {
        const cap = loadWithStubs('utils/yandexSmartCaptcha.js', { axios: { post: async () => ({ status: 200, data: { status: 'ok' } }) } });
        const r = await withEnv({ YANDEX_SMARTCAPTCHA_SERVER_KEY: null, CAPTCHA_FAIL_OPEN: null }, () => cap.verifyYandexSmartCaptcha({ ip: '1.1.1.1', headers: {} }, 'tok'));
        assert.strictEqual(r.ok, false);
        const r2 = await withEnv({ YANDEX_SMARTCAPTCHA_SERVER_KEY: null, CAPTCHA_FAIL_OPEN: '1' }, () => cap.verifyYandexSmartCaptcha({ ip: '1.1.1.1', headers: {} }, 'tok'));
        assert.strictEqual(r2.ok, true);
        assert.strictEqual(cap.getClientIp({ ip: '9.9.9.9', headers: { 'x-forwarded-for': '6.6.6.6' } }), '9.9.9.9');
    });

    await check('M4: SVG не принимается в /api/content/upload; popular-загрузка с лимитом и расширением по MIME', () => {
        assert.ok(!/svg\\\+xml/.test(read('routes/content.routes.js')));
        const up = read('middleware/upload.js');
        assert.match(up, /limits: \{ fileSize: MAX_IMAGE_BYTES \}/);
        assert.match(up, /EXT_BY_MIME\[file\.mimetype\]/);
    });

    await check('internalOrders: payUrl клиента — через ту же политику', () => {
        assert.match(read('lib/customRooms/internalOrders.js'), /paymentPolicy\.clientPayUrlAllowed\(payload\.payUrl\)/);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
