'use strict';

/**
 * Проверка статуса СБП-платежа VTB для внутренних заказов (без Level.Travel) — копия логики
 * POST /check_pay из app.js (generationBankToken + qr/dynamics/info + isVtbSbpPaid), без LT notify.
 * env: VTB_CLIENT_ID, VTB_CLIENT_SECRET, VTB_MERCHANT_AUTH (lib/env.requireEnv — без fallback-литералов).
 */

const axios = require('axios');
const https = require('https');
const { requireEnv } = require('../env');

const TOKEN_URL = 'https://open.api.vtb.ru:443/passport/oauth2/token';
const INFO_URL = 'https://gw.api.vtb.ru/openapi/smb/efcp/sbp-gateway/v1/qr/dynamics/info';
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

function isVtbSbpPaid(info) {
    const state = String((info && (info.state || (info.data && info.data.state))) || '').toUpperCase();
    if (state === 'ACWP' || state === 'OK') return true;
    const statusVal = info && ((info.status && info.status.value) || (info.data && info.data.status && info.data.status.value));
    return statusVal === 'RECONCILED';
}

function resolveVtbPayStatus(info) {
    if (isVtbSbpPaid(info)) return 'RECONCILED';
    const state = info && (info.state || (info.data && info.data.state));
    if (state) return String(state).toUpperCase();
    const statusVal = info && ((info.status && info.status.value) || (info.data && info.data.status && info.data.status.value));
    return statusVal || 'PENDING';
}

/**
 * Статус QR-платежа по qrcId → { payment, payStatus, paid, transactionId, transactionCode, amount }.
 * Бросает Error с полем `reason`: 'token_failed' | 'not_found' | ошибка axios (response).
 */
async function checkSbpPayment(qrcId) {
    const tokenData = await getBankToken().catch((e) => { const err = new Error(`Failed to obtain VTB access token: ${e.message}`); err.reason = 'token_failed'; throw err; });
    if (!tokenData || !tokenData.access_token) { const err = new Error('Failed to obtain VTB access token'); err.reason = 'token_failed'; throw err; }
    const headers = {
        'X-IBM-Client-Id': requireEnv('VTB_CLIENT_ID'),
        'Merchant-Authorization': requireEnv('VTB_MERCHANT_AUTH'),
        Authorization: `Bearer ${tokenData.access_token}`,
        'Content-Type': 'application/json',
    };
    const response = await axios.post(INFO_URL, { qrcId }, { headers, ...vtbAxiosConfig });
    const payment = (response && response.data && (response.data.data || response.data)) || null;
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
        transactionId: payment.transactionId || requestId || null,
        transactionCode: payment.orderCode || qrcId,
        amount: Number.isFinite(amount) ? amount : null,
    };
}

module.exports = { checkSbpPayment, isVtbSbpPaid, resolveVtbPayStatus, getBankToken };
