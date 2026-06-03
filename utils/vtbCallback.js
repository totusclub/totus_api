const db = require('../db');
const axios = require('axios');
const crypto = require('crypto');

const LT_BASE_URL = 'https://api.level.travel';
const LT_PARTNER_API_KEY =
  process.env.LT_PARTNER_API_KEY || '6a6ca82f341fea2a9d19b0d581c448e7';
const LT_HEADERS = {
  Accept: 'application/vnd.leveltravel.v3.7',
  Authorization: `Token token="${LT_PARTNER_API_KEY}"`,
  'Content-Type': 'application/json',
};

const sha256 = (data) =>
  crypto.createHash('sha256').update(String(data)).digest('hex');

function generateSignature(order_id, status, amount, partner_api_key) {
  return sha256(
    sha256(order_id) + sha256(status) + sha256(amount) + sha256(partner_api_key)
  );
}

function cleanOrderId(orderId) {
  if (orderId == null || orderId === 'n/a') return null;
  return String(orderId).replace(/^ORDER/i, '');
}

async function notifyLevelTravelPaid(orderId, amount) {
  const clean_order_id = cleanOrderId(orderId);
  if (!clean_order_id) {
    return { result: 'skipped', reason: 'no_order_id' };
  }

  const status = 'paid';
  const signature = generateSignature(
    clean_order_id,
    status,
    amount,
    LT_PARTNER_API_KEY
  );

  try {
    const response = await axios.post(
      `${LT_BASE_URL}/orders/${clean_order_id}/notify`,
      { order_id: clean_order_id, status, amount, signature },
      { headers: LT_HEADERS }
    );
    return { result: 'ok', status: response.status, data: response.data };
  } catch (err) {
    return {
      result: 'error',
      status: err.response?.status || 500,
      error: err.response?.data || err.message,
    };
  }
}

async function processVtbCallback(payload) {
  const { type, object } = payload;

  if (!type || !object) {
    const err = new Error('Invalid callback: missing type or object');
    err.status = 400;
    throw err;
  }

  const payStatus = object.status?.value || null;
  const orderId = cleanOrderId(object.orderId);
  const transactionId = String(object.orderId ?? object.paymentId ?? '');
  const transactionCode = object.orderCode || object.paymentCode || null;
  const amount = object.amount?.value ?? null;

  if (type === 'PAYMENT') {
    let ltNotify = null;
    let duplicate = false;

    if (orderId) {
      const [rows] = await db.query(
        'SELECT pay_status, transaction_code FROM orders WHERE order_id = ? LIMIT 1',
        [orderId]
      );
      const existing = rows[0];

      if (
        existing &&
        existing.pay_status === 'RECONCILED' &&
        payStatus === 'RECONCILED' &&
        existing.transaction_code === transactionCode
      ) {
        duplicate = true;
      } else {
        await db.query(
          'UPDATE orders SET pay_status = ?, transaction_id = ?, transaction_code = ? WHERE order_id = ?',
          [payStatus, transactionId, transactionCode, orderId]
        );
      }

      if (payStatus === 'RECONCILED' && !duplicate) {
        ltNotify = await notifyLevelTravelPaid(orderId, amount);
      }
    }

    return {
      success: true,
      type,
      order_id: orderId,
      pay_status: payStatus,
      duplicate,
      lt_notify: ltNotify,
    };
  }

  if (type === 'REFUND') {
    if (orderId) {
      await db.query(
        `UPDATE orders
         SET pay_status = ?, transaction_id = ?, transaction_code = ?,
             refund_amount = COALESCE(?, refund_amount), refund_at = NOW()
         WHERE order_id = ?`,
        [payStatus, transactionId, transactionCode, amount, orderId]
      );
    }

    return {
      success: true,
      type,
      order_id: orderId,
      pay_status: payStatus,
      refund_amount: amount,
    };
  }

  const err = new Error(`Unsupported callback type: ${type}`);
  err.status = 400;
  throw err;
}

module.exports = { processVtbCallback, cleanOrderId };
