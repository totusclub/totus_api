const axios = require('axios');
const https = require('https');
const db = require('../db');
const { buildVtbPaymentPurpose } = require('./vtbPaymentPurpose');
const { sendOrderCreatedEmail } = require('./orderEmails');
const { getStoredPayment, savePaymentToPackage, buildCheckoutUrl } = require('./orderPayment');
const { logCallback, logCallbackError } = require('./callbackLogger');
const { requireEnv } = require('../lib/env');

const LOG = 'VTB_PAYMENT';
const vtbHttpsAgent = new https.Agent({ rejectUnauthorized: false });
const vtbAxiosConfig = { httpsAgent: vtbHttpsAgent };

async function generationBankToken() {
    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('client_id', requireEnv('VTB_CLIENT_ID'));
    params.append('client_secret', requireEnv('VTB_CLIENT_SECRET'));

    const response = await axios.post(
        'https://open.api.vtb.ru:443/passport/oauth2/token',
        params,
        vtbAxiosConfig
    );

    return response.data;
}

function normalizeAmount(amount) {
    if (amount == null) return null;

    if (typeof amount === 'object' && amount.value != null) {
        return {
            value: Number(amount.value),
            code: amount.code || 'RUB',
        };
    }

    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) return null;

    return { value, code: 'RUB' };
}

function customerReturnUrl(returnUrl, fallback) {
    const value = String(returnUrl || '').trim();
    if (/^https:\/\/totus\.club\//i.test(value)) return value;
    return fallback;
}

async function createVtbPaymentForOrder({
    orderId,
    orderName,
    amount,
    returnUrl,
    paymentPurpose,
    purposeText,
    paymentMinutes = 30,
    sendEmail = true,
}) {
    const normalizedAmount = normalizeAmount(amount);
    if (!normalizedAmount) {
        throw new Error('Invalid payment amount');
    }

    const tokenData = await generationBankToken();
    if (!tokenData?.access_token) {
        throw new Error('Failed to obtain VTB access token');
    }

    const cleanOrderId = String(orderId).replace(/^ORDER/i, '');
    let orderPackage = null;

    const [rows] = await db.query(
        'SELECT * FROM orders WHERE order_id = ? LIMIT 1',
        [cleanOrderId]
    );
    const orderRow = rows[0] || null;

    if (orderRow?.package) {
        try {
            orderPackage = JSON.parse(orderRow.package);
        } catch {
            orderPackage = null;
        }
    }

    const existingPayment = orderRow ? getStoredPayment(orderPackage, orderRow) : null;
    if (existingPayment?.payUrl && !existingPayment.paid) {
        logCallback(LOG, 'REUSE', 'Using existing payment link', {
            order_id: cleanOrderId,
            qrcId: existingPayment.qrcId,
        });

        if (sendEmail && orderRow) {
            sendOrderCreatedEmail(cleanOrderId, orderRow, {
                payUrl: existingPayment.payUrl,
                amount: existingPayment.amount ?? normalizedAmount.value,
                paymentMinutes: existingPayment.paymentMinutes ?? paymentMinutes,
            }).catch((err) => {
                logCallbackError(LOG, 'EMAIL', 'Payment email failed', {
                    order_id: cleanOrderId,
                    error: err.message,
                });
            });
        }

        return {
            reused: true,
            qrcId: existingPayment.qrcId,
            payload: existingPayment.payUrl,
            payUrl: existingPayment.payUrl,
            checkoutUrl: existingPayment.checkoutUrl,
            object: {
                payUrl: existingPayment.payUrl,
                qrcId: existingPayment.qrcId,
            },
        };
    }

    const headers = {
        'X-IBM-Client-Id': requireEnv('VTB_CLIENT_ID'),
        'Merchant-Authorization': requireEnv('VTB_MERCHANT_AUTH'),
        Authorization: `Bearer ${tokenData.access_token}`,
        'Content-Type': 'application/json',
    };

    const { purpose } = buildVtbPaymentPurpose({
        orderId,
        orderName,
        paymentPurpose: paymentPurpose || purposeText,
        package: orderPackage,
    });

    const checkoutUrl = buildCheckoutUrl(cleanOrderId);
    const response = await axios.post(
        'https://gw.api.vtb.ru/openapi/smb/efcp/e-commerce/v1/orders',
        {
            orderId: cleanOrderId,
            orderName: String(orderName || purpose || `ORDER${cleanOrderId}`).slice(0, 140),
            amount: normalizedAmount,
            returnUrl: customerReturnUrl(returnUrl, checkoutUrl),
        },
        { headers, ...vtbAxiosConfig }
    );

    const vtbBody = response.data || {};
    const order = vtbBody.object || {};
    const payUrl = order.payUrl || null;
    const orderCode = order.orderCode || null;
    const preparedSbp = (Array.isArray(order.preparedPayments) ? order.preparedPayments : [])
        .find((item) => String(item?.type || '').toLowerCase() === 'sbp');
    const qrcId = preparedSbp?.object?.qrcId || null;
    const minutes = minutesUntil(order.expire, paymentMinutes);
    const lookupCode = orderCode || qrcId;

    if (lookupCode && cleanOrderId) {
        await db.query(
            'UPDATE orders SET pay_status = ?, transaction_code = ? WHERE order_id = ?',
            ['CREATED', lookupCode, cleanOrderId]
        );
    }

    if (payUrl && cleanOrderId) {
        await savePaymentToPackage(cleanOrderId, {
            payUrl,
            qrcId: lookupCode,
            amount: normalizedAmount.value,
            paymentMinutes: minutes,
        });
    }

    if (sendEmail && payUrl && orderRow) {
        sendOrderCreatedEmail(cleanOrderId, orderRow, {
            payUrl,
            amount: normalizedAmount.value,
            paymentMinutes: minutes,
        }).catch((err) => {
            logCallbackError(LOG, 'EMAIL', 'Payment email failed', {
                order_id: cleanOrderId,
                error: err.message,
            });
        });
    }

    logCallback(LOG, 'OK', 'VTB payment created', {
        order_id: cleanOrderId,
        orderCode,
        qrcId,
        has_pay_url: Boolean(payUrl),
        email_scheduled: Boolean(sendEmail && payUrl && orderRow),
    });

    return {
        ...vtbBody,
        reused: false,
        qrcId: lookupCode,
        orderCode,
        payload: payUrl,
        payUrl,
        checkoutUrl,
        object: {
            payUrl,
            qrcId: lookupCode,
            orderCode,
        },
    };
}

function minutesUntil(expire, fallback) {
    const ts = Date.parse(expire);
    if (!Number.isFinite(ts)) return fallback;
    const minutes = Math.round((ts - Date.now()) / 60000);
    return minutes > 0 ? minutes : fallback;
}

module.exports = {
    createVtbPaymentForOrder,
    normalizeAmount,
};
