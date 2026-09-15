// Проверка перехвата GET /orders?order_id=<внутренний> без БД и сети (v3, 15.09): node scripts/check-custom-rooms-orders.js
// internalOrders.orderSnapshot / buildOrderSnapshot: ответ из БД в формате DB-ветки app.js (+ payment, totus_room, totus_booking,
// lt_auth_token: null, last_lt_event: null), requireAuth(['user','staff']) — staff допускается, чужой пользователь → 403,
// LT-заказы → next() (app.js как раньше); resolveAuthToken без env-fallback для внутренних id и с opts.allowEnv=false.
// Основные проверки — scripts/check-custom-rooms.js, витрина на реальном payload — check-custom-rooms-live.js.
'use strict';
const assert = require('assert');
process.env.DB_HOST = process.env.DB_HOST || 'localhost';
process.env.JWT_SECRET = process.env.JWT_SECRET || 's1';
process.env.AUTH_MODE = 'enforce';

// Зависимости, которых может не быть в частичной копии репозитория: JWT (payload как есть), orderDocuments/orderPayment (как в main, без документов)
{
    const Module = require('module');
    const origLoad = Module._load;
    Module._load = function (request, ...rest) {
        const r = String(request);
        if (r === 'jsonwebtoken') {
            return {
                sign: (payload) => `chk.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`,
                verify: (token) => { const [h, b] = String(token).split('.'); if (h !== 'chk' || !b) throw new Error('invalid'); return JSON.parse(Buffer.from(b, 'base64url').toString('utf8')); },
            };
        }
        if (/(^\.\/|utils\/)orderDocuments$/.test(r)) {
            try { return origLoad.call(this, request, ...rest); } catch (e) {
                return { prepareOrderRowForClient: async (row) => ({ ...row, package: (() => { try { return JSON.parse(row.package || '{}'); } catch (x) { return {}; } })() }), getOrderDocuments: async () => [] };
            }
        }
        if (/(^\.\/|utils\/)orderPayment$/.test(r)) {
            try { return origLoad.call(this, request, ...rest); } catch (e) {
                return { attachPaymentToOrderResponse: (row, clientOrder) => { let pkg = {}; try { pkg = JSON.parse(row.package || '{}'); } catch (x) { pkg = {}; }
                    const paid = String(row.pay_status || '').toUpperCase() === 'RECONCILED';
                    return { ...clientOrder, payment: { paid, payUrl: paid ? null : pkg._pay_url || null, qrcId: pkg._pay_qrc_id || row.transaction_code || null, amount: pkg._pay_amount ?? pkg.remaining_amount ?? pkg.full_price ?? null, paymentMinutes: pkg._payment_minutes ?? 30, checkoutUrl: `https://totus.club/checkout?order_id=${row.order_id}`, payStatus: row.pay_status || (paid ? 'RECONCILED' : 'CREATED') } }; } };
            }
        }
        if (/(^\.\/|utils\/)callbackLogger$/.test(r)) {
            try { return origLoad.call(this, request, ...rest); } catch (e) { return { logCallback() {}, logCallbackError() {} }; }
        }
        if (/utils\/levelTravelHttp$/.test(r)) {
            try { return origLoad.call(this, request, ...rest); } catch (e) { return { ltRequest: async () => { throw new Error('LT disabled in checks'); }, logLtError() {}, sendLtAxiosError: (res) => res.status(502).json({ error: 'lt_disabled' }) }; }
        }
        return origLoad.call(this, request, ...rest);
    };
}

// --- фейковая БД: одна строка orders + одно бронирование; любые запросы к LT/документам не нужны ---
const ORDER_PKG = { id: 900000012, state: 'pending_confirmation', full_price: 86850, remaining_amount: 86850, package: { id: 555, price: 86850, hotel: { id: 123, name: 'Rixos Premium' } }, _totus_booking: { internal: true, operator: 'Arlekino', bookingId: 12 }, _totus_room: { roomTypeId: 7, providerPrice: 96500, finalPrice: 86850, operator: 'Arlekino' }, _pay_url: 'https://qr.nspk.ru/x', _pay_qrc_id: 'qrc-1', _pay_amount: 86850 };
const orderRow = { id: 1, order_id: '900000012', user_id: 5, pay_status: 'PENDING', transaction_code: 'qrc-1', order_state: 'pending_confirmation', lt_auth_token: null, custom_room_type_id: 7, provider_price: '96500.00', final_price: '86850.00', package: JSON.stringify(ORDER_PKG) };
const bookingRow = { id: 12, order_id: '900000012', user_id: 5, room_type_id: 7, hotel_id: 123, hotel_name: 'Rixos Premium', hotel_stars: 5, hotel_city: 'Белек', room_name: 'Deluxe Sea View', operator_name: 'Arlekino', meal: 'AI', meal_name: 'Всё включено', check_in: '2026-10-12', check_out: '2026-10-19', nights: 7, adults: 2, kids: 0, contact_json: '{"name":"Иван","email":"i@x.ru","phone":"79001112233"}', provider_price: '96500.00', final_price: '86850.00', price_rule: '{"type":"percent","value":-10}', payment_status: 'paid', paid_at: '2026-09-10T14:20:00Z', paid_amount: '86850.00', status: 'pending_confirmation', created_at: '2026-09-10T14:00:00Z' };
const dbMod = require('../db');
const ltCalls = [];
dbMod.query = async (sql, args = []) => {
    const q = String(sql).replace(/\s+/g, ' ').trim();
    if (/^SELECT \* FROM custom_room_bookings WHERE order_id = \?/i.test(q)) return [String(args[0]) === '900000012' ? [{ ...bookingRow }] : []];
    if (/^SELECT \* FROM orders WHERE order_id = \?/i.test(q)) return [String(args[0]) === '900000012' ? [{ ...orderRow }] : []];
    if (/FROM order_documents/i.test(q)) return [[]];
    if (/FROM custom_room_types|FROM custom_room_searches|FROM custom_room_offer_map/i.test(q)) return [[]];
    throw new Error(`fake db: unsupported query ${q.slice(0, 60)}`);
};

const internal = require('../lib/customRooms/internalOrders');
const bookings = require('../lib/customRooms/bookings');
const store = require('../lib/customRooms/store');
const mw = require('../middleware/customRooms');
const { signUserToken, signStaffToken } = require('../lib/auth');
const { resolveAuthToken, isInternalOrderId } = require('../utils/levelTravelClientOrder');
store.isReady = async () => true;

function mkRes(sent) { return { status(c) { this.code = c; return this; }, json(body) { sent.push([this.code === undefined ? 200 : this.code, body]); this.headersSent = true; return this; } }; }
async function viaMw(query, headers) {
    const sent = [];
    let nextCalled = false;
    await new Promise((resolve) => { mw({ method: 'GET', path: '/orders', query, headers: headers || {} }, mkRes(sent), () => { nextCalled = true; resolve(); }); setTimeout(resolve, 40); });
    return { sent, nextCalled };
}

async function checks() {
    // --- resolveAuthToken (utils/levelTravelClientOrder.js) ---
    process.env.LT_CLIENT_AUTH_TOKEN = 'ENV-TOKEN';
    assert.ok(isInternalOrderId('900000012') && isInternalOrderId('ORDER900000012') && isInternalOrderId(900000000) && !isInternalOrderId('48311') && !isInternalOrderId(null));
    assert.strictEqual(resolveAuthToken({ order_id: '48311', lt_auth_token: null, package: '{}' }), 'ENV-TOKEN', 'LT-заказ без токена → env (как раньше, для запроса к LT)');
    assert.strictEqual(resolveAuthToken({ order_id: '48311', lt_auth_token: 'ROW' }), 'ROW'); assert.strictEqual(resolveAuthToken({ order_id: '48311' }, 'Q'), 'Q');
    assert.strictEqual(resolveAuthToken({ order_id: '48311', package: '{"_lt_auth_token":"PKG"}' }), 'PKG');
    assert.strictEqual(resolveAuthToken({ order_id: '900000012', lt_auth_token: null, package: '{}' }), null, 'внутренний заказ: env-fallback НЕ применяется');
    assert.strictEqual(resolveAuthToken({ order_id: 900000012 }), null); assert.strictEqual(resolveAuthToken({ order_id: '900000012' }, 'Q'), 'Q', 'явный токен — как есть');
    assert.strictEqual(resolveAuthToken({ order_id: '48311' }, null, { allowEnv: false }), null, 'allowEnv=false: env наружу не отдаём (lt_auth_token в GET /orders)');
    assert.strictEqual(resolveAuthToken({ order_id: '48311', lt_auth_token: 'ROW' }, null, { allowEnv: false }), 'ROW');
    assert.strictEqual(resolveAuthToken(null), 'ENV-TOKEN'); delete process.env.LT_CLIENT_AUTH_TOKEN; assert.strictEqual(resolveAuthToken(null), null);

    // --- buildOrderSnapshot: формат DB-ветки app.js ---
    const b = bookings.fromRow(bookingRow);
    const snap = await internal.buildOrderSnapshot(orderRow, b, '900000012');
    assert.deepStrictEqual(Object.keys(snap), ['order_id', 'package', 'pay_status', 'transaction_code', 'order_state', 'user_id', 'lt_auth_token', 'last_lt_event', 'internal', 'payment', 'totus_room', 'totus_booking']);
    assert.strictEqual(snap.order_id, '900000012'); assert.strictEqual(snap.lt_auth_token, null); assert.strictEqual(snap.last_lt_event, null); assert.strictEqual(snap.internal, true);
    assert.strictEqual(snap.user_id, 5); assert.strictEqual(snap.pay_status, 'PENDING'); assert.strictEqual(snap.transaction_code, 'qrc-1'); assert.strictEqual(snap.order_state, 'pending_confirmation', 'order_state — из бронирования');
    assert.strictEqual(snap.package.id, 900000012); assert.strictEqual(snap.package.full_price, 86850); assert.strictEqual(snap.package.package.price, 86850); assert.strictEqual(snap.package.state, 'pending_confirmation');
    assert.deepStrictEqual(snap.totus_room, { roomTypeId: 7, providerPrice: 96500, finalPrice: 86850, operator: 'Arlekino' });
    assert.strictEqual(snap.totus_booking.internal, true); assert.strictEqual(snap.totus_booking.orderId, '900000012'); assert.strictEqual(snap.totus_booking.statusLabel, 'Проверяем бронирование');
    assert.ok(!('customer' in snap.totus_booking) && !('contact' in snap.totus_booking), 'ПД в ответе нет');
    assert.strictEqual(snap.payment.paid, false, 'payment — как attachPaymentToOrderResponse'); assert.strictEqual(snap.payment.payUrl, 'https://qr.nspk.ru/x'); assert.strictEqual(snap.payment.amount, 86850); assert.strictEqual(snap.payment.qrcId, 'qrc-1'); assert.ok(/order_id=900000012/.test(snap.payment.checkoutUrl));
    const paidSnap = await internal.buildOrderSnapshot({ ...orderRow, pay_status: 'RECONCILED' }, b, '900000012');
    assert.strictEqual(paidSnap.payment.paid, true); assert.strictEqual(paidSnap.payment.payUrl, null); assert.strictEqual(paidSnap.pay_status, 'RECONCILED');
    // строки orders нет (не должно быть, но не падаем): пакет из снимка бронирования, payment null
    const noRow = await internal.buildOrderSnapshot(null, bookings.fromRow({ ...bookingRow, package_snapshot: '{"package":{"id":555,"price":86850}}' }), '900000012');
    assert.strictEqual(noRow.payment, null); assert.strictEqual(noRow.user_id, 5); assert.strictEqual(noRow.package.id, 900000012); assert.strictEqual(noRow.package.package.price, 86850); assert.strictEqual(noRow.pay_status, 'RECONCILED', 'оплачено по бронированию');

    // --- orderSnapshot / middleware ---
    assert.strictEqual(await internal.orderSnapshot({}, {}, '48311'), false, 'LT-заказ → false (next)');
    assert.strictEqual(await internal.orderSnapshot({}, {}, 'ORDER48311'), false); assert.strictEqual(await internal.orderSnapshot({}, {}, ''), false); assert.strictEqual(await internal.orderSnapshot({}, {}, 'abc'), false);
    assert.strictEqual(await internal.orderSnapshot({}, {}, '900000099'), false, 'внутренний id без бронирования → next() (app.js отдаст 404/DB)');
    let r = await viaMw({ order_id: '900000012' });
    assert.strictEqual(r.nextCalled, false, 'внутренний заказ — app.js (LT-ветка) не вызывается'); assert.deepStrictEqual(r.sent[0], [401, { error: 'unauthorized' }], 'без токена в enforce — 401');
    for (const [label, token] of [['user', signUserToken({ id: 5 })], ['agent', signUserToken({ id: 5, role: 'agent' })], ['staff', signStaffToken({ id: 1 })]]) {
        r = await viaMw({ order_id: 'ORDER900000012' }, { authorization: `Bearer ${token}` });
        assert.strictEqual(r.nextCalled, false, `${label}: отвечает middleware`); assert.strictEqual(r.sent[0][0], 200, `${label}: 200 (staff в requireAuth(['user']) app.js получал бы 403)`);
        assert.strictEqual(r.sent[0][1].order_id, '900000012'); assert.strictEqual(r.sent[0][1].lt_auth_token, null); assert.strictEqual(r.sent[0][1].totus_booking.internal, true); assert.strictEqual(r.sent[0][1].internal, true);
    }
    r = await viaMw({ order_id: '900000012' }, { authorization: `Bearer ${signUserToken({ id: 6 })}` });
    assert.deepStrictEqual(r.sent[0], [403, { error: 'forbidden' }], 'чужой пользователь → 403'); assert.strictEqual(r.nextCalled, false);
    r = await viaMw({ order_id: '900000012' }, { authorization: 'Bearer bad' });
    assert.deepStrictEqual(r.sent[0], [401, { error: 'unauthorized' }]);
    r = await viaMw({ order_id: '48311' }, { authorization: `Bearer ${signStaffToken({ id: 1 })}` });
    assert.strictEqual(r.nextCalled, true, 'обычный заказ LT идёт в app.js (afterOrders обёрнут, ответ LT не подменяется)'); assert.strictEqual(r.sent.length, 0);
    r = await viaMw({});
    assert.strictEqual(r.nextCalled, true, 'без order_id — app.js (400 Missing order_id)');
    assert.strictEqual(ltCalls.length, 0);
}

checks().then(() => { console.log('ALL CUSTOM ROOMS ORDERS CHECKS PASSED'); process.exit(0); }).catch((e) => { console.error(e); process.exit(1); });
