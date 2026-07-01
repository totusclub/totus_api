const db = require('../db');

const CHECKOUT_BASE_URL = (
    process.env.CHECKOUT_URL || 'https://totus.club/checkout'
).replace(/\/$/, '');

function buildCheckoutUrl(orderId) {
    return `${CHECKOUT_BASE_URL}?order_id=${encodeURIComponent(orderId)}`;
}

function parsePackage(orderRow) {
    try {
        return JSON.parse(orderRow?.package || '{}');
    } catch {
        return {};
    }
}

function getStoredPayment(pkg, orderRow) {
    const payUrl = pkg?._pay_url || null;
    if (!payUrl) return null;

    const payStatus = String(orderRow?.pay_status || '').toUpperCase();
    if (payStatus === 'RECONCILED') {
        return {
            paid: true,
            payUrl: null,
            qrcId: pkg._pay_qrc_id || orderRow?.transaction_code || null,
            amount: pkg._pay_amount ?? null,
            paymentMinutes: pkg._payment_minutes ?? 15,
            checkoutUrl: buildCheckoutUrl(orderRow?.order_id),
            payStatus,
        };
    }

    return {
        paid: false,
        payUrl,
        qrcId: pkg._pay_qrc_id || orderRow?.transaction_code || null,
        amount: pkg._pay_amount ?? null,
        paymentMinutes: pkg._payment_minutes ?? 15,
        checkoutUrl: buildCheckoutUrl(orderRow?.order_id),
        payStatus: payStatus || 'CREATED',
    };
}

async function savePaymentToPackage(orderId, { payUrl, qrcId, amount, paymentMinutes = 15 }) {
    const [rows] = await db.query('SELECT package FROM orders WHERE order_id = ? LIMIT 1', [orderId]);
    if (!rows[0]) return;

    let pkg = parsePackage(rows[0]);
    pkg._pay_url = payUrl;
    pkg._pay_qrc_id = qrcId || pkg._pay_qrc_id || null;
    pkg._pay_amount = amount ?? pkg._pay_amount ?? null;
    pkg._payment_minutes = paymentMinutes;
    pkg._pay_created_at = new Date().toISOString();

    await db.query('UPDATE orders SET package = ? WHERE order_id = ?', [
        JSON.stringify(pkg),
        orderId,
    ]);
}

async function getOrderPayment(orderId) {
    const cleanOrderId = String(orderId).replace(/^ORDER/i, '');
    const [rows] = await db.query('SELECT * FROM orders WHERE order_id = ? LIMIT 1', [cleanOrderId]);
    const orderRow = rows[0];
    if (!orderRow) return null;

    const pkg = parsePackage(orderRow);
    const stored = getStoredPayment(pkg, orderRow);

    return {
        order_id: cleanOrderId,
        ...(stored || {
            paid: String(orderRow.pay_status || '').toUpperCase() === 'RECONCILED',
            payUrl: null,
            qrcId: orderRow.transaction_code || null,
            amount: pkg._pay_amount ?? pkg.price ?? pkg.total_price ?? null,
            paymentMinutes: pkg._payment_minutes ?? 15,
            checkoutUrl: buildCheckoutUrl(cleanOrderId),
            payStatus: orderRow.pay_status || null,
        }),
    };
}

function attachPaymentToOrderResponse(orderRow, clientOrder) {
    const pkg = parsePackage(orderRow);
    const payment = getStoredPayment(pkg, orderRow);

    return {
        ...clientOrder,
        payment: payment || {
            paid: String(orderRow.pay_status || '').toUpperCase() === 'RECONCILED',
            payUrl: null,
            qrcId: orderRow.transaction_code || null,
            amount: pkg._pay_amount ?? pkg.price ?? pkg.total_price ?? null,
            paymentMinutes: pkg._payment_minutes ?? 15,
            checkoutUrl: buildCheckoutUrl(orderRow.order_id),
            payStatus: orderRow.pay_status || null,
        },
    };
}

module.exports = {
    CHECKOUT_BASE_URL,
    buildCheckoutUrl,
    getStoredPayment,
    savePaymentToPackage,
    getOrderPayment,
    attachPaymentToOrderResponse,
};
