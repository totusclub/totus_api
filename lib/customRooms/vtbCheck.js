'use strict';

/**
 * Проверка статуса платежа VTB для внутренних заказов (без Level.Travel).
 * Новый заказ → GET e-commerce/v1/orders/{наш числовой orderId}. orderCode банк по этому URL не находит.
 * Старый qrcId → POST qr/dynamics/info.
 * env: VTB_CLIENT_ID, VTB_CLIENT_SECRET, VTB_MERCHANT_AUTH (lib/env.requireEnv — без fallback-литералов).
 */

const axios = require('axios');
const https = require('https');
const { requireEnv } = require('../env');

const TOKEN_URL = 'https://open.api.vtb.ru:443/passport/oauth2/token';
const INFO_URL = 'https://gw.api.vtb.ru/openapi/smb/efcp/sbp-gateway/v1/qr/dynamics/info';
const ORDER_URL = 'https://gw.api.vtb.ru/openapi/smb/efcp/e-commerce/v1/orders';
const ORDER_CODE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAID_STATUSES = new Set(['RECONCILED', 'PAID', 'DEPOSITED', 'CONFIRMED', 'SUCCESS', 'ACWP', 'OK', 'COMPLETED']);
// Как в app.js: сертификат шлюза VTB не проверяется
const vtbAxiosConfig = { httpsAgent: new https.Agent({ rejectUnauthorized: false }), timeout: 30000 };

async function getBankToken() {
    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('client_id', requireEnv('VTB_CLIENT_ID'));
    params.append('client_secret', requireEnv('VTB_CLIENT_SECRET'));
    const response = await axios.post(TOKEN_URL, params, vtbAxiosConfig);
    return response.data;
}

function nestedPaymentStatus(info) {
    const payments = info && info.transactions && info.transactions.payments;
    if (!Array.isArray(payments) || !payments.length) return '';
    const last = payments[payments.length - 1];
    return (last && last.object && last.object.status && last.object.status.value) || '';
}

function isVtbSbpPaid(info) {
    const state = String((info && (info.state || (info.data && info.data.state))) || '').toUpperCase();
    if (PAID_STATUSES.has(state)) return true;
    const statusVal = String((info && ((info.status && info.status.value) || (info.data && info.data.status && info.data.status.value))) || '').toUpperCase();
    if (PAID_STATUSES.has(statusVal)) return true;
    return PAID_STATUSES.has(String(nestedPaymentStatus(info)).toUpperCase());
}

function canonicalPayStatus(status) {
    if (status == null || status === '') return null;
    const value = String(status).toUpperCase();
    return PAID_STATUSES.has(value) ? 'RECONCILED' : value;
}

function unwrapVtbPayment(data) {
    if (!data || typeof data !== 'object') return null;
    if (data.object && typeof data.object === 'object') return data.object;
    if (data.data && typeof data.data === 'object') return data.data;
    return data;
}

function resolveVtbPayStatus(info) {
    if (isVtbSbpPaid(info)) return 'RECONCILED';
    const nested = String(nestedPaymentStatus(info) || '').toUpperCase();
    if (nested) return nested;
    const state = info && (info.state || (info.data && info.data.state));
    if (state) return String(state).toUpperCase();
    const statusVal = info && ((info.status && info.status.value) || (info.data && info.data.status && info.data.status.value));
    return statusVal || 'PENDING';
}

/**
 * Статус QR-платежа по qrcId → { payment, payStatus, paid, transactionId, transactionCode, amount }.
 * Бросает Error с полем `reason`: 'token_failed' | 'not_found' | ошибка axios (response).
 */
async function checkSbpPayment(qrcId, orderId) {
    const tokenData = await getBankToken().catch((e) => { const err = new Error(`Failed to obtain VTB access token: ${e.message}`); err.reason = 'token_failed'; throw err; });
    if (!tokenData || !tokenData.access_token) { const err = new Error('Failed to obtain VTB access token'); err.reason = 'token_failed'; throw err; }
    const headers = {
        'X-IBM-Client-Id': requireEnv('VTB_CLIENT_ID'),
        'Merchant-Authorization': requireEnv('VTB_MERCHANT_AUTH'),
        Authorization: `Bearer ${tokenData.access_token}`,
        'Content-Type': 'application/json',
    };
    const lookup = qrcId == null ? '' : String(qrcId);
    const numericOrderId = String(orderId || '').replace(/^ORDER/i, '');
    const oldQr = Boolean(lookup) && !ORDER_CODE_RE.test(lookup);
    const newOrder = !oldQr && /^\d+$/.test(numericOrderId);
    if (!oldQr && !newOrder) {
        const err = new Error('No payment info found');
        err.reason = 'not_found';
        throw err;
    }
    let response;
    try {
        response = oldQr
            ? await axios.post(INFO_URL, { qrcId: lookup }, { headers, ...vtbAxiosConfig })
            : await axios.get(`${ORDER_URL}/${encodeURIComponent(numericOrderId)}`, { headers, ...vtbAxiosConfig });
    } catch (e) {
        if (e.response && e.response.status === 404) {
            const err = new Error('No payment info found');
            err.reason = 'not_found';
            throw err;
        }
        throw e;
    }
    const payment = unwrapVtbPayment(response && response.data);
    if (!payment) { const err = new Error('No payment info found'); err.reason = 'not_found'; throw err; }
    const payStatus = resolveVtbPayStatus(payment);
    const requestId = payment.requestId || payment.orderId;
    const amountRaw = payment.amount && payment.amount.value !== undefined ? payment.amount.value : payment.amount;
    const amount = amountRaw === undefined || amountRaw === null ? null : Number(String(amountRaw).replace(/[^\d.,]/g, '').replace(',', '.'));
    return {
        payment,
        payStatus,
        paid: payStatus === 'RECONCILED',
        requestId: requestId || null,
        transactionId: payment.paymentId || payment.transactionId || payment.orderCode || qrcId,
        transactionCode: payment.orderCode || qrcId,
        amount: Number.isFinite(amount) ? amount : null,
    };
}

module.exports = { checkSbpPayment, isVtbSbpPaid, resolveVtbPayStatus, canonicalPayStatus, getBankToken };
