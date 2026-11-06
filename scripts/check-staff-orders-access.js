#!/usr/bin/env node
/**
 * Админка получает список и карточки заказов со staff-токеном (AUTH_MODE=enforce).
 * Проверяет без БД и сети:
 *   1) маршруты просмотра заказов пускают user/agent/staff, изменяющие — как раньше;
 *   2) requireAuth(['user','staff']) в enforce: staff/user/agent проходят, без токена и с мусором — 401;
 *   3) ограничения для клиента не ослаблены: чужой user_id / чужой заказ — 403, свой — да;
 *      staff — любой (как и задумано в resolveOwnerId / assertOrderOwner).
 * Запуск: node scripts/check-staff-orders-access.js
 */
const fs = require('fs');
const path = require('path');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'check-staff-orders-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'check-staff-orders-refresh';
process.env.AUTH_MODE = 'enforce';
delete process.env.AUTH_LOG_ONLY_PATHS;

const auth = require('../lib/auth');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
    if (ok) passed += 1;
    else failed += 1;
    console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

// ---------------------------------------------------------------------------
// 1. Роли маршрутов в app.js
// ---------------------------------------------------------------------------
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const constMatch = appSrc.match(/const ORDER_VIEW_ROLES = (\[[^\]]*\]);/);
const viewRoles = constMatch ? JSON.parse(constMatch[1].replace(/'/g, '"')) : null;
check('ORDER_VIEW_ROLES = user + staff', JSON.stringify(viewRoles) === JSON.stringify(['user', 'staff']), String(constMatch && constMatch[1]));

function rolesOf(method, route) {
    const esc = route.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    const re = new RegExp(`app\\.${method}\\('${esc}',\\s*requireAuth\\(([^)]*)\\)`);
    const m = appSrc.match(re);
    return m ? m[1].trim() : null;
}

const viewRoutes = [
    ['get', '/user/orders'],
    ['get', '/orders'],
    ['get', '/orders/documents'],
    ['get', '/client/orders'],
    ['get', '/client/orders/:order_id'],
];
const viewOk = viewRoutes.every(([m, r]) => rolesOf(m, r) === 'ORDER_VIEW_ROLES');
check('просмотр заказов (5 маршрутов) — ORDER_VIEW_ROLES', viewOk,
    viewRoutes.map(([m, r]) => `${r}=${rolesOf(m, r)}`).join(', '));

const unchanged = [
    ['post', '/vtb/create-order', "['user']"],
    ['post', '/create-package', "['user']"],
    ['post', '/client/orders/:order_id/sync', "['user']"],
    ['get', '/orders/:order_id/payment', "['user']"],
    ['post', '/level_travel/notify-paid', "['user']"],
    ['post', '/payment/status', "['staff']"],
];
const unchangedOk = unchanged.every(([m, r, want]) => rolesOf(m, r) === want);
check('изменяющие маршруты не тронуты (создание платежа, sync, notify-paid, payment/status)', unchangedOk,
    unchanged.map(([m, r]) => `${r}=${rolesOf(m, r)}`).join(', '));
check("/api/admin — по-прежнему requireAuth(['staff'])", /app\.use\('\/api\/admin', requireAuth\(\['staff'\]\)\)/.test(appSrc));

// ---------------------------------------------------------------------------
// 2. requireAuth в enforce
// ---------------------------------------------------------------------------
function fakeRes() {
    return {
        statusCode: 200,
        body: undefined,
        headersSent: false,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; this.headersSent = true; return this; },
    };
}
function run(mw, token, extra = {}) {
    const req = { method: 'GET', path: '/user/orders', originalUrl: '/user/orders', headers: {}, query: {}, ip: '127.0.0.1', ...extra };
    if (token) req.headers.authorization = `Bearer ${token}`;
    const res = fakeRes();
    let nexted = false;
    mw(req, res, () => { nexted = true; });
    return { req, res, nexted };
}

const staffToken = auth.signStaffToken({ id: 7, email: 'staff@example.test' });
const userToken = auth.signUserToken({ id: 101, email: 'u101@example.test', role: 'user' });
const agentToken = auth.signAgentToken({ id: 202, email: 'a202@example.test', role: 'agent' });

const viewMw = auth.requireAuth(['user', 'staff']);
let r = run(viewMw, staffToken);
check('enforce: staff-токен на просмотре заказов — проходит', r.nexted && r.req.auth && r.req.auth.role === 'staff', `status=${r.res.statusCode}`);
r = run(viewMw, userToken);
check('enforce: user-токен — проходит', r.nexted && r.req.auth.role === 'user');
r = run(viewMw, agentToken);
check('enforce: agent-токен — проходит', r.nexted && r.req.auth.role === 'agent');
r = run(viewMw, null);
check('enforce: без токена — 401 unauthorized', !r.nexted && r.res.statusCode === 401 && r.res.body.error === 'unauthorized');
r = run(viewMw, 'garbage.token.value');
check('enforce: мусорный токен — 401', !r.nexted && r.res.statusCode === 401);

const userOnlyMw = auth.requireAuth(['user']);
r = run(userOnlyMw, staffToken);
check("enforce: staff на requireAuth(['user']) (создание платежа и т.п.) — по-прежнему 403", !r.nexted && r.res.statusCode === 403 && r.res.body.error === 'forbidden');

// ---------------------------------------------------------------------------
// 3. Владелец данных
// ---------------------------------------------------------------------------
function owner(token, requested) {
    const pass = run(viewMw, token);
    const res = fakeRes();
    const out = auth.resolveOwnerId(pass.req, res, requested);
    return { out, res };
}
let o = owner(staffToken, '555');
check('staff: /user/orders?user_id=555 — заказы любого клиента', o.out === '555' && o.res.statusCode === 200);
o = owner(userToken, '555');
check('user: чужой user_id — 403 (не ослаблено)', o.out === null && o.res.statusCode === 403);
o = owner(userToken, '101');
check('user: свой user_id — свои заказы', String(o.out) === '101');
o = owner(userToken, undefined);
check('user: без user_id — id из токена', o.out === 101);

function orderOwner(token, orderUserId) {
    const pass = run(viewMw, token);
    const res = fakeRes();
    return { ok: auth.assertOrderOwner(pass.req, res, orderUserId), res };
}
let a = orderOwner(staffToken, 555);
check('staff: карточка чужого заказа — да', a.ok === true);
a = orderOwner(userToken, 555);
check('user: карточка чужого заказа — 403 (не ослаблено)', a.ok === false && a.res.statusCode === 403);
a = orderOwner(userToken, 101);
check('user: свой заказ — да', a.ok === true);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
