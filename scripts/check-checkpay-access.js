#!/usr/bin/env node
/**
 * Повторный аудит 06.11 §3.5/§3.6: доступ к статусу оплаты и к заказам клиента Level.Travel.
 * Проверяет без сети, с подменой БД:
 *   1) POST /check_pay зарегистрирован с optionalAuth + checkPayAccess ДО middleware customRooms;
 *   2) без токена ответ урезается до статуса оплаты (нет transaction_*, notify_*, totus_booking), ошибки не трогаются;
 *   3) с токеном владельца / staff — полный ответ; чужой заказ в enforce — 403;
 *   4) GET /client/orders: LT-токен должен принадлежать заказу вызывающего (enforce — 403), staff — любой.
 * Запуск: node scripts/check-checkpay-access.js
 */
const fs = require('fs');
const path = require('path');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'check-checkpay-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'check-checkpay-refresh';
process.env.AUTH_MODE = 'enforce';
delete process.env.AUTH_LOG_ONLY_PATHS;

const Module = require('module');
const root = path.join(__dirname, '..');
// lib/paymentPolicy.js тянет utils/orderPayment.js -> ../db (MySQL); подменяем только этот модуль.
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === '../db' && parent && String(parent.filename || '').startsWith(root)) return { query: async () => [[]] };
    return realLoad.call(this, request, parent, isMain);
};
const auth = require('../lib/auth');
const policy = require('../lib/paymentPolicy');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
    if (ok) passed += 1;
    else failed += 1;
    console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

// ---------------------------------------------------------------------------
// 1. Регистрация в app.js
// ---------------------------------------------------------------------------
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const guardPos = appSrc.indexOf("app.post('/check_pay', optionalAuth, paymentPolicy.checkPayAccess({ db, assertOrderOwner }));");
const customRoomsPos = appSrc.indexOf("app.use(require('./middleware/customRooms'))");
const jsonPos = appSrc.indexOf('app.use(express.json(');
check('/check_pay: optionalAuth + checkPayAccess зарегистрированы', guardPos > 0);
check('/check_pay: защита стоит после express.json() и до middleware customRooms',
    guardPos > jsonPos && customRoomsPos > guardPos, `json=${jsonPos} guard=${guardPos} customRooms=${customRoomsPos}`);
check('/client/orders: проверка принадлежности LT-токена (orders.user_id + lt_auth_token)',
    /SELECT 1 FROM orders WHERE user_id = \? AND lt_auth_token = \? LIMIT 1/.test(appSrc)
    && /reason=lt_token_mismatch GET \/client\/orders/.test(appSrc));

// ---------------------------------------------------------------------------
// 2. publicCheckPayView
// ---------------------------------------------------------------------------
const fullBody = {
    message: 'Payment reconciled', status: 'RECONCILED', paid: true, order_id: '123456',
    qrcId: 'AD1000', transaction_id: 'T-1', transaction_code: 'AD1000',
    notify_status: 200, notify_result: 'ok', notify_data: { token: 'lt-secret' }, notify_error: null,
    totus_booking: { id: 1 }, internal: true,
};
const limited = policy.publicCheckPayView(fullBody);
check('анонимный вид: только message/status/paid/order_id/internal + limited',
    JSON.stringify(Object.keys(limited).sort()) === JSON.stringify(['internal', 'limited', 'message', 'order_id', 'paid', 'status'])
    && limited.paid === true && limited.limited === true, Object.keys(limited).join(','));
check('анонимный вид: нет transaction_*, notify_*, qrcId, totus_booking',
    ['qrcId', 'transaction_id', 'transaction_code', 'notify_data', 'notify_result', 'totus_booking'].every((k) => !(k in limited)));
check('анонимный вид: не-объект возвращается как есть', policy.publicCheckPayView('x') === 'x' && policy.publicCheckPayView(null) === null);

// ---------------------------------------------------------------------------
// 3. checkPayAccess
// ---------------------------------------------------------------------------
function fakeRes() {
    return {
        statusCode: 200, body: undefined, headersSent: false,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; this.headersSent = true; return this; },
    };
}
const ordersDb = { 123456: 101, 777: 555 };
const db = {
    async query(sql, params) {
        if (/SELECT user_id FROM orders/.test(sql)) {
            const uid = ordersDb[params[0]];
            return [uid === undefined ? [] : [{ user_id: uid }]];
        }
        throw new Error(`unexpected sql: ${sql}`);
    },
};
const quietLog = { warn() {} };
const guard = policy.checkPayAccess({ db, assertOrderOwner: auth.assertOrderOwner }, { log: quietLog });
const optional = auth.optionalAuth;

const userToken = auth.signUserToken({ id: 101, email: 'u101@example.test', role: 'user' });
const staffToken = auth.signStaffToken({ id: 7, email: 'staff@example.test' });

async function run(token, body, handler) {
    const req = { method: 'POST', path: '/check_pay', originalUrl: '/check_pay', headers: {}, query: {}, ip: '127.0.0.1', body };
    if (token) req.headers.authorization = `Bearer ${token}`;
    const res = fakeRes();
    await new Promise((resolve) => optional(req, res, resolve));
    let nexted = false;
    await guard(req, res, () => { nexted = true; });
    if (nexted) handler(req, res);
    return { req, res, nexted };
}
const fullHandler = (req, res) => res.status(200).json({ ...fullBody });
const errorHandler = (req, res) => res.status(500).json({ error: 'VTB check failed', detail: 'x' });

(async () => {
    let r = await run(null, { orderId: 'ORDER123456' }, fullHandler);
    check('без токена: handler вызван, ответ урезан', r.nexted && r.res.body.limited === true && !('transaction_id' in r.res.body) && r.res.body.paid === true,
        JSON.stringify(r.res.body));
    r = await run(null, { orderId: '123456' }, errorHandler);
    check('без токена: ответ с ошибкой (status>=400) не трогается', r.nexted && r.res.statusCode === 500 && r.res.body.error === 'VTB check failed');

    r = await run(userToken, { orderId: 'ORDER123456' }, fullHandler);
    check('владелец заказа: полный ответ', r.nexted && r.res.body.transaction_id === 'T-1' && !('limited' in r.res.body));
    r = await run(userToken, { orderId: '777' }, fullHandler);
    check('чужой заказ в enforce: 403 forbidden, handler не вызван', !r.nexted && r.res.statusCode === 403 && r.res.body.error === 'forbidden');
    r = await run(userToken, { orderId: '999999' }, fullHandler);
    check('неизвестный заказ с токеном: пропускаем к handler (сам ответит), полный ответ', r.nexted && !('limited' in r.res.body));
    r = await run(userToken, { qrcId: 'AD1' }, fullHandler);
    check('только qrcId с токеном: handler вызван', r.nexted);
    r = await run(staffToken, { orderId: '777' }, fullHandler);
    check('staff: любой заказ, полный ответ', r.nexted && r.res.body.transaction_id === 'T-1');
    r = await run('garbage.token', { orderId: '123456' }, fullHandler);
    check('мусорный токен = аноним: ответ урезан', r.nexted && r.res.body.limited === true);

    const failingGuard = policy.checkPayAccess({ db: { async query() { throw new Error('db down'); } }, assertOrderOwner: auth.assertOrderOwner }, { log: quietLog });
    const req = { method: 'POST', path: '/check_pay', originalUrl: '/check_pay', headers: { authorization: `Bearer ${userToken}` }, query: {}, ip: '127.0.0.1', body: { orderId: '1' } };
    await new Promise((resolve) => optional(req, fakeRes(), resolve));
    let err = null;
    await failingGuard(req, fakeRes(), (e) => { err = e; });
    check('ошибка БД уходит в next(err), не в 200', err instanceof Error && /db down/.test(err.message));

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
