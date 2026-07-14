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

function toMoney(value) {
    const n = typeof value === 'number' ? value : Number(String(value ?? '').replace(/[^\d.-]/g, ''));
    return Number.isFinite(n) ? n : 0;
}

/**
 * SBP / notify amount from Level Travel order JSON.
 * Prefer remaining_amount, else max(full_price, package.price + fuel_charge).
 */
function resolveLtOrderPayAmount(orderLike) {
    if (!orderLike || typeof orderLike !== 'object') return null;

    const remaining = toMoney(orderLike.remaining_amount);
    if (remaining > 0) return remaining;

    const nested =
        orderLike.package && (orderLike.package.price != null || orderLike.package.hotel)
            ? orderLike.package
            : orderLike;

    const full = toMoney(orderLike.full_price ?? nested.full_price);
    const base =
        toMoney(nested.price) ||
        toMoney(orderLike.price) ||
        toMoney(nested.net_price);
    const fees =
        toMoney(nested.fuel_charge) ||
        toMoney(orderLike.fuel_charge) ||
        toMoney(nested.predicted_surcharge);
    const withFees = base + fees;

    if (full > 0 && withFees > 0) return Math.max(full, withFees);
    if (withFees > 0) return withFees;
    if (full > 0) return full;
    return base > 0 ? base : null;
}

/** Ensure order JSON has full_price reflecting price + fuel for payments. */
function normalizeOrderPayFields(orderData) {
    if (!orderData || typeof orderData !== 'object') return orderData;
    const total = resolveLtOrderPayAmount(orderData);
    if (total == null) return orderData;

    const next = { ...orderData };
    const currentFull = toMoney(next.full_price);
    if (total > currentFull) {
        next.full_price = total;
    }
    if (next.remaining_amount == null || toMoney(next.remaining_amount) <= 0) {
        next.remaining_amount = next.full_price ?? total;
    }
    next._pay_amount = next._pay_amount ?? total;
    return next;
}

function getStoredPayment(pkg, orderRow) {
    const payUrl = pkg?._pay_url || null;
    if (!payUrl) return null;

    const payStatus = String(orderRow?.pay_status || '').toUpperCase();
    const amount = pkg._pay_amount ?? resolveLtOrderPayAmount(pkg) ?? null;
    if (payStatus === 'RECONCILED') {
        return {
            paid: true,
            payUrl: null,
            qrcId: pkg._pay_qrc_id || orderRow?.transaction_code || null,
            amount,
            paymentMinutes: pkg._payment_minutes ?? 30,
            checkoutUrl: buildCheckoutUrl(orderRow?.order_id),
            payStatus,
        };
    }

    return {
        paid: false,
        payUrl,
        qrcId: pkg._pay_qrc_id || orderRow?.transaction_code || null,
        amount,
        paymentMinutes: pkg._payment_minutes ?? 30,
        checkoutUrl: buildCheckoutUrl(orderRow?.order_id),
        payStatus: payStatus || 'CREATED',
    };
}

async function savePaymentToPackage(orderId, { payUrl, qrcId, amount, paymentMinutes = 30 }) {
    const [rows] = await db.query('SELECT package FROM orders WHERE order_id = ? LIMIT 1', [orderId]);
    if (!rows[0]) return;

    let pkg = parsePackage(rows[0]);
    pkg._pay_url = payUrl;
    pkg._pay_qrc_id = qrcId || pkg._pay_qrc_id || null;
    pkg._pay_amount = amount ?? pkg._pay_amount ?? resolveLtOrderPayAmount(pkg) ?? null;
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
            amount: pkg._pay_amount ?? resolveLtOrderPayAmount(pkg) ?? null,
            paymentMinutes: pkg._payment_minutes ?? 30,
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
            amount: pkg._pay_amount ?? resolveLtOrderPayAmount(pkg) ?? null,
            paymentMinutes: pkg._payment_minutes ?? 30,
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
    resolveLtOrderPayAmount,
    normalizeOrderPayFields,
};
