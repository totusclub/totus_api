'use strict';

/**
 * HTTP-обработчики внутренних заказов (бронирования наших Room Type без Level.Travel).
 * Вызываются из middleware/customRooms.js и отвечают САМИ (без next()) — app.js не трогаем.
 * Бриф §2: create-package, check_pay, client/orders/:id (+sync), level_travel/notify-paid, payment/status;
 * v3: GET /orders?order_id=<внутренний> — снимок заказа из БД (orderSnapshot), LT не вызывается.
 * Форматы ответов — как у соответствующих маршрутов app.js (frontend не меняется).
 * Level.Travel здесь не вызывается нигде.
 */

const db = require('../../db');
const store = require('./store');
const bookings = require('./bookings');
const { requireAuth, resolveOwnerId, assertOrderOwner } = require('../auth');

const LOG = '[custom-rooms:order]';

function runAuth(req, res, roles) {
    return new Promise((resolve) => { requireAuth(roles)(req, res, () => resolve(true)); if (res.headersSent) resolve(false); });
}

function emptyNotify(extra) {
    return Object.assign({ notify_status: null, notify_result: 'skipped_internal', notify_data: null, notify_error: null }, extra || {});
}

// ---------------------------------------------------------------------------
// POST /create-package — заказ у нас, оплата VTB, ответ в формате LT create
// ---------------------------------------------------------------------------
async function createPackage(req, res, map) {
    if (!(await runAuth(req, res, ['user']))) return;
    const payload = req.body || {};
    try {
        const contact = bookings.extractContact(payload);
        if (!contact.email || !contact.phone) {
            return res.status(400).json({ success: false, error: 'Buyer email and phone are required' });
        }
        // Владелец заказа — из токена; user_id из body только без токена (log-режим) или для staff (как в app.js).
        const userId = resolveOwnerId(req, res, payload.user_id);
        if (userId === null && res.headersSent) return;

        if (!map.snapshot) {
            return res.status(410).json({ success: false, error: 'offer_expired', message: 'Предложение устарело — выберите номер заново' });
        }
        const rt = await store.getRoomType(map.roomTypeId);
        const { booking, orderData } = await bookings.create({ map, rt, payload, userId });
        const orderId = booking.orderId;
        const amount = map.finalPrice;

        // Платёж: ссылка от фронта (payUrl) или создаём СБП-QR сами — как в app.js /create-package.
        let payment = null;
        try {
            if (payload.payUrl) {
                const { savePaymentToPackage } = require('../../utils/orderPayment');
                const { normalizeAmount } = require('../../utils/vtbCreatePayment');
                const normalized = normalizeAmount(amount);
                await savePaymentToPackage(orderId, { payUrl: payload.payUrl, qrcId: payload.qrcId || null, amount: normalized && normalized.value, paymentMinutes: 30 });
                const [rows] = await db.query('SELECT * FROM orders WHERE order_id = ? LIMIT 1', [orderId]);
                if (rows[0]) {
                    const { sendOrderCreatedEmail } = require('../../utils/orderEmails');
                    sendOrderCreatedEmail(orderId, rows[0], { payUrl: payload.payUrl, amount: normalized && normalized.value, paymentMinutes: 30 })
                        .catch((err) => console.error(`${LOG} created email failed:`, err.message));
                }
                payment = { payUrl: payload.payUrl, qrcId: payload.qrcId || null, amount };
            } else {
                const { createVtbPaymentForOrder } = require('../../utils/vtbCreatePayment');
                const r = await createVtbPaymentForOrder({
                    orderId,
                    orderName: payload.orderName || `ORDER${orderId}`,
                    amount,
                    paymentPurpose: payload.paymentPurpose || payload.purposeText,
                    paymentMinutes: 30,
                    sendEmail: true,
                });
                payment = { payUrl: r && r.payUrl, qrcId: r && r.qrcId, amount, checkoutUrl: r && r.checkoutUrl };
            }
        } catch (payErr) {
            // Заказ создан; ссылку на оплату фронт получит через GET /orders/:id/payment?ensure=1
            console.error(`${LOG} payment create failed for ${orderId}:`, payErr.message);
        }

        return res.json({
            success: true,
            order: Object.assign({}, orderData, { id: Number(orderId), auth_token: null }),
            totus_room: orderData._totus_room,
            totus_booking: bookings.serialize(booking),
            payment,
        });
    } catch (e) {
        if (e && e.code === 'offer_expired') return res.status(410).json({ success: false, error: 'offer_expired', message: 'Предложение устарело — выберите номер заново' });
        console.error(`${LOG} create-package failed:`, e && e.message);
        return res.status(500).json({ success: false, error: e && e.message ? e.message : 'internal_error' });
    }
}

// ---------------------------------------------------------------------------
// POST /check_pay — проверка СБП без LT notify. true = ответили сами, false = не наш заказ (next()).
// ---------------------------------------------------------------------------
async function resolveInternalOrder(body) {
    const b = body || {};
    let orderId = bookings.cleanOrderId(b.orderId || b.order_id);
    let row = null;
    if (orderId && !bookings.isInternalOrderId(orderId)) return null;
    if (!orderId && b.qrcId) {
        try {
            const [rows] = await db.query('SELECT order_id, pay_status, transaction_code FROM orders WHERE transaction_code = ? LIMIT 1', [String(b.qrcId)]);
            if (!rows.length || !bookings.isInternalOrderId(rows[0].order_id)) return null;
            row = rows[0];
            orderId = String(rows[0].order_id);
        } catch (e) { return null; }
    }
    if (!orderId) return null;
    const booking = await bookings.getByOrderId(orderId);
    if (!booking) return null;
    if (!row) {
        const [rows] = await db.query('SELECT order_id, pay_status, transaction_code FROM orders WHERE order_id = ? LIMIT 1', [orderId]);
        row = rows[0] || null;
    }
    return { orderId, booking, row };
}

async function checkPay(req, res) {
    const ctx = await resolveInternalOrder(req.body);
    if (!ctx) return false;
    const { orderId, booking, row } = ctx;
    try {
        if (row && row.pay_status === 'RECONCILED') {
            // уже оплачен — как в app.js, но без LT; статус бронирования тоже приводим (на случай пропущенного onPaid)
            if (booking.status === 'pending_payment') await bookings.onPaid(orderId, null, { source: 'check_pay' });
            return res.status(200).json(emptyNotify({ message: 'Order already paid', status: 'RECONCILED', paid: true, order_id: orderId, internal: true, totus_booking: bookings.serialize(await bookings.getByOrderId(orderId)) }));
        }
        const qrcId = (req.body && req.body.qrcId) || (row && row.transaction_code) || null;
        if (!qrcId && !/^\d+$/.test(String(orderId || '').replace(/^ORDER/i, ''))) {
            return res.status(200).json(emptyNotify({ status: 'error', message: "Missing required 'qrcId' (or orderId with saved QR)", order_id: orderId, internal: true }));
        }
        const { checkSbpPayment } = require('./vtbCheck');
        let info;
        try {
            info = await checkSbpPayment(qrcId, orderId);
        } catch (e) {
            if (e.reason === 'token_failed') return res.status(200).json(emptyNotify({ status: 'error', message: 'Failed to obtain VTB access token', order_id: orderId, internal: true }));
            if (e.reason === 'not_found') return res.status(200).json(emptyNotify({ status: 'not_found', message: 'No payment info found', order_id: orderId, internal: true }));
            throw e;
        }
        try {
            await db.query('UPDATE orders SET pay_status = ?, transaction_id = ?, transaction_code = ? WHERE order_id = ?', [info.payStatus, info.transactionId, info.transactionCode, orderId]);
        } catch (dbErr) { console.error(`${LOG} check_pay DB update failed:`, dbErr.message); }
        let fresh = booking;
        if (info.paid) fresh = (await bookings.onPaid(orderId, info.amount, { source: 'check_pay' })) || booking;
        return res.status(200).json(emptyNotify({
            message: 'Order status checked',
            status: info.payStatus,
            paid: info.paid,
            qrcId,
            order_id: orderId,
            transaction_id: info.transactionId,
            transaction_code: info.transactionCode,
            internal: true,
            totus_booking: bookings.serialize(fresh),
        }));
    } catch (err) {
        console.error(`${LOG} check_pay error:`, (err.response && err.response.data) || err.message);
        return res.status(200).json({
            status: 'error', message: 'Failed to check payment status', order_id: orderId, internal: true,
            notify_status: null, notify_result: 'skipped_internal', notify_data: (err.response && err.response.data) || null,
            notify_error: (err.response && err.response.data && err.response.data.message) || err.message, vtb_status: (err.response && err.response.status) || null,
        });
    }
}

// ---------------------------------------------------------------------------
// GET /client/orders/:id, POST /client/orders/:id/sync
// ---------------------------------------------------------------------------
async function clientOrder(req, res, orderId, { sync } = {}) {
    if (!bookings.isInternalOrderId(orderId)) return false;
    const booking = await bookings.getByOrderId(orderId);
    if (!booking) return false;
    if (!(await runAuth(req, res, ['user']))) return true;
    if (!assertOrderOwner(req, res, booking.userId)) return true;
    if (sync) {
        res.status(200).json({ success: true, synced: false, internal: true, order_id: Number(booking.orderId), totus_booking: bookings.serialize(booking) });
        return true;
    }
    let pkg = null;
    try {
        const [rows] = await db.query('SELECT * FROM orders WHERE order_id = ? LIMIT 1', [booking.orderId]);
        if (rows[0]) {
            const { prepareOrderRowForClient } = require('../../utils/orderDocuments');
            const prepared = await prepareOrderRowForClient(rows[0]);
            pkg = prepared.package || null;
        }
    } catch (e) { console.error(`${LOG} client order load failed:`, e.message); }
    if (!pkg) pkg = { id: Number(booking.orderId), state: booking.status, package: booking.snapshot && booking.snapshot.package };
    pkg.state = booking.status;
    res.status(200).json({ success: true, order: pkg, internal: true, totus_booking: bookings.serialize(booking) });
    return true;
}

// ---------------------------------------------------------------------------
// GET /orders?order_id=9000000xx — снимок внутреннего заказа из БД (v3). Level.Travel не вызывается:
// у внутреннего заказа нет lt_auth_token, и LT-ветка app.js для него бессмысленна (при env-fallback —
// ещё и опасна: чужой токен). Формат — как DB-ветка app.js (prepareOrderRowForClient + payment) +
// totus_room/totus_booking, lt_auth_token: null, last_lt_event: null. true = ответили сами, false = не наш заказ (next()).
// ---------------------------------------------------------------------------
async function orderSnapshot(req, res, orderId) {
    const oid = bookings.cleanOrderId(orderId);
    if (!oid || !bookings.isInternalOrderId(oid)) return false;
    const booking = await bookings.getByOrderId(oid);
    if (!booking) return false;
    // /orders в app.js: requireAuth(['user']) — staff в ['user'] не входит (→ 403 forbidden в админке); для внутренних заказов пускаем и staff
    if (!(await runAuth(req, res, ['user', 'staff']))) return true;
    let row = null;
    try {
        const [rows] = await db.query('SELECT * FROM orders WHERE order_id = ? LIMIT 1', [oid]);
        row = rows[0] || null;
    } catch (e) { console.error(`${LOG} order snapshot load failed:`, e.message); }
    if (row && !assertOrderOwner(req, res, row.user_id)) return true;
    if (!row && !assertOrderOwner(req, res, booking.userId)) return true;
    const out = await buildOrderSnapshot(row, booking, oid);
    res.status(200).json(out);
    return true;
}

/** Тело ответа GET /orders для внутреннего заказа (без HTTP) — используется также тестами. */
async function buildOrderSnapshot(row, booking, oid) {
    let pkg = null;
    let payment = null;
    if (row) {
        try {
            const { prepareOrderRowForClient } = require('../../utils/orderDocuments');
            pkg = (await prepareOrderRowForClient(row)).package || null;
        } catch (e) {
            console.error(`${LOG} order snapshot prepare failed:`, e.message);
            pkg = store.parseJson(row.package) || null;
        }
        try {
            const { attachPaymentToOrderResponse } = require('../../utils/orderPayment');
            payment = attachPaymentToOrderResponse(row, {}).payment || null;
        } catch (e) { console.error(`${LOG} order snapshot payment failed:`, e.message); }
    }
    if (!pkg) pkg = Object.assign({ id: Number(oid) }, booking.snapshot && typeof booking.snapshot === 'object' ? { package: booking.snapshot.package || null } : {});
    if (pkg && typeof pkg === 'object') pkg.state = booking.status;
    const totusRoom = (pkg && pkg._totus_room) || { roomTypeId: booking.roomTypeId, providerPrice: booking.providerPrice, finalPrice: booking.finalPrice, operator: booking.operatorName || null };
    return {
        order_id: String(oid),
        package: pkg,
        pay_status: row ? row.pay_status || null : (booking.paymentStatus === 'paid' ? 'RECONCILED' : null),
        transaction_code: row ? row.transaction_code || null : null,
        order_state: booking.status,
        user_id: row && row.user_id !== undefined ? row.user_id : (booking.userId === undefined ? null : booking.userId),
        lt_auth_token: null,
        last_lt_event: null,
        internal: true,
        payment,
        totus_room: totusRoom,
        totus_booking: bookings.serialize(booking),
    };
}

// ---------------------------------------------------------------------------
// POST /level_travel/notify-paid, POST /payment/status — для внутренних заказов LT не уведомляем
// ---------------------------------------------------------------------------
async function skipLtNotify(req, res) {
    const b = req.body || {};
    const orderId = bookings.cleanOrderId(b.order_id || b.orderId);
    if (!orderId || !(await bookings.isInternalOrder(orderId))) return false;
    console.log(`${LOG} ${req.path}: internal order ${orderId} — Level.Travel notify skipped`);
    res.status(200).json({ success: true, skipped: 'internal_order', order_id: orderId });
    return true;
}

module.exports = { createPackage, checkPay, clientOrder, orderSnapshot, buildOrderSnapshot, skipLtNotify, resolveInternalOrder };
