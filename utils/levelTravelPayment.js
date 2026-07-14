require('dotenv').config();
const db = require('../db');
const axios = require('axios');
const crypto = require('crypto');
const { logCallback, logCallbackError } = require('./callbackLogger');

const LOG = 'LT_PAY_NOTIFY';
const LT_BASE_URL = 'https://api.level.travel';
const LT_API_TOKEN =
  process.env.LT_API_TOKEN || process.env.LT_PARTNER_API_KEY || '6a6ca82f341fea2a9d19b0d581c448e7';
const LT_SIGN_KEY = process.env.LT_SIGN_KEY || LT_API_TOKEN;

const LT_HEADERS = {
  Accept: 'application/vnd.leveltravel.v3.7',
  Authorization: `Token token="${LT_API_TOKEN}"`,
  'Content-Type': 'application/json',
};

const sha256 = (data) =>
  crypto.createHash('sha256').update(String(data)).digest('hex');

function generateSignature(order_id, status, amount, partner_api_key) {
  return sha256(
    sha256(order_id) + sha256(status) + sha256(amount) + sha256(partner_api_key)
  );
}

async function resolveAmountFromDb(orderId) {
  const [rows] = await db.query(
    'SELECT package FROM orders WHERE order_id = ? LIMIT 1',
    [orderId]
  );
  if (!rows[0]?.package) return null;

  try {
    const pkg = JSON.parse(rows[0].package);
    const { resolveLtOrderPayAmount } = require('./orderPayment');
    return (
      resolveLtOrderPayAmount(pkg) ??
      pkg.paid_amount ??
      pkg.full_price ??
      pkg.remaining_amount ??
      pkg.price ??
      null
    );
  } catch {
    return null;
  }
}

/**
 * Notify Level Travel that order is paid.
 * POST https://api.level.travel/orders/{order_id}/notify
 */
async function notifyLevelTravelOrderPaid({ order_id, amount }) {
  const orderId = String(order_id).replace(/^ORDER/i, '');

  if (!orderId) {
    const err = new Error('Missing order_id');
    err.status = 400;
    throw err;
  }

  const resolvedAmount =
    amount != null ? amount : await resolveAmountFromDb(orderId);

  if (resolvedAmount == null) {
    const err = new Error('Missing amount — pass in body or save order in DB with price');
    err.status = 400;
    throw err;
  }

  const status = 'paid';
  const signature = generateSignature(
    orderId,
    status,
    resolvedAmount,
    LT_SIGN_KEY
  );

  const payload = {
    order_id: orderId,
    status,
    amount: resolvedAmount,
    signature,
  };

  logCallback(LOG, 'OUT', 'Sending paid notify to Level Travel', payload);

  try {
    const response = await axios.post(
      `${LT_BASE_URL}/orders/${orderId}/notify`,
      payload,
      { headers: LT_HEADERS }
    );

    try {
      await db.query(
        "UPDATE orders SET pay_status = ? WHERE order_id = ?",
        ['PAID', orderId]
      );
    } catch (dbErr) {
      logCallbackError(LOG, 'DB', 'LT notify OK but DB update failed', {
        order_id: orderId,
        error: dbErr.message,
      });
    }

    logCallback(LOG, 'OK', 'Level Travel accepted paid notify', {
      order_id: orderId,
      http_status: response.status,
      data: response.data,
    });

    return {
      success: true,
      order_id: orderId,
      amount: resolvedAmount,
      status,
      lt_response: response.data,
    };
  } catch (err) {
    logCallbackError(LOG, 'ERROR', 'Level Travel rejected paid notify', {
      order_id: orderId,
      http_status: err.response?.status || 500,
      error: err.response?.data || err.message,
    });

    const apiErr = new Error(
      err.response?.data?.message ||
        err.response?.data?.error ||
        err.message ||
        'Level Travel notify failed'
    );
    apiErr.status = err.response?.status || 500;
    apiErr.lt_error = err.response?.data;
    throw apiErr;
  }
}

module.exports = { notifyLevelTravelOrderPaid, generateSignature };
