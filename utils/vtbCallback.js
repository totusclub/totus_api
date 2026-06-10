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

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    String(value)
  );
}

function parseOrderIdFromText(value) {
  if (value == null || value === 'n/a') return null;
  const str = String(value).trim();
  const orderMatch = str.match(/ORDER(\d+)/i);
  if (orderMatch) return orderMatch[1];
  const cleaned = str.replace(/^ORDER/i, '');
  if (/^\d+$/.test(cleaned)) return cleaned;
  return null;
}

function cleanOrderId(orderId) {
  if (orderId == null || orderId === 'n/a') return null;
  const fromText = parseOrderIdFromText(orderId);
  if (fromText) return fromText;
  if (isUuid(orderId)) return null;
  return String(orderId).replace(/^ORDER/i, '');
}

function parseAmount(value) {
  if (value == null) return null;
  const str = String(value).replace(/[^\d.,]/g, '').replace(',', '.');
  const num = parseFloat(str);
  return Number.isFinite(num) ? num : null;
}

function resolveLtOrderId(object) {
  const candidates = [
    object.description,
    object.orderId,
    object.sbpParams?.paymentPurpose,
    object.sbpParams?.requestId,
  ];

  for (const raw of candidates) {
    const id = cleanOrderId(raw) || parseOrderIdFromText(raw);
    if (id) return id;
  }
  return null;
}

async function findOrderInDb(object) {
  const sbp = object.sbpParams || {};
  const qrcId = sbp.qrcId;
  const parsedId = resolveLtOrderId(object);
  const paymentId = object.paymentId || sbp.transactionId;

  if (qrcId) {
    const [rows] = await db.query(
      'SELECT order_id, pay_status, transaction_code FROM orders WHERE transaction_code = ? LIMIT 1',
      [qrcId]
    );
    if (rows[0]) return rows[0];
  }

  if (parsedId) {
    const [rows] = await db.query(
      'SELECT order_id, pay_status, transaction_code FROM orders WHERE order_id = ? LIMIT 1',
      [parsedId]
    );
    if (rows[0]) return rows[0];
  }

  if (paymentId) {
    const [rows] = await db.query(
      'SELECT order_id, pay_status, transaction_code FROM orders WHERE transaction_id = ? LIMIT 1',
      [String(paymentId)]
    );
    if (rows[0]) return rows[0];
  }

  return null;
}

async function notifyLevelTravelPaid(dbOrderId, amount) {
  const orderId = String(dbOrderId);
  if (!orderId) {
    return { result: 'skipped', reason: 'no_order_id' };
  }

  const status = 'paid';
  const signature = generateSignature(
    orderId,
    status,
    amount,
    LT_PARTNER_API_KEY
  );

  try {
    const response = await axios.post(
      `${LT_BASE_URL}/orders/${orderId}/notify`,
      { order_id: orderId, status, amount, signature },
      { headers: LT_HEADERS }
    );
    return { result: 'ok', order_id: orderId, status: response.status, data: response.data };
  } catch (err) {
    return {
      result: 'error',
      order_id: orderId,
      status: err.response?.status || 500,
      error: err.response?.data || err.message,
    };
  }
}

async function processVtbCallback(payload) {
  const type = String(payload?.type || '')
    .trim()
    .toUpperCase();
  const object = payload?.object;

  if (!type || !object) {
    const err = new Error('Invalid callback: missing type or object');
    err.status = 400;
    throw err;
  }

  const payStatus = object.status?.value || null;
  const sbp = object.sbpParams || {};
  const dbOrder = await findOrderInDb(object);
  const dbOrderId = dbOrder?.order_id ?? null;

  const transactionId =
    object.paymentId || sbp.transactionId || object.orderId || '';
  const transactionCode = sbp.qrcId || object.paymentCode || object.orderCode;
  const amount = parseAmount(object.amount?.value ?? sbp.amount);

  if (type === 'PAYMENT') {
    let duplicate = false;
    let ltNotify = null;

    if (dbOrderId) {
      if (
        dbOrder.pay_status === 'RECONCILED' &&
        payStatus === 'RECONCILED' &&
        dbOrder.transaction_code === transactionCode
      ) {
        duplicate = true;
      } else {
        await db.query(
          'UPDATE orders SET pay_status = ?, transaction_id = ?, transaction_code = ? WHERE order_id = ?',
          [payStatus, String(transactionId), transactionCode, dbOrderId]
        );
      }

      if (payStatus === 'RECONCILED' && !duplicate) {
        ltNotify = await notifyLevelTravelPaid(dbOrderId, amount);
      }
    }

    return {
      success: true,
      type,
      order_id: dbOrderId,
      pay_status: payStatus,
      duplicate,
      order_found: Boolean(dbOrderId),
      lt_notify: ltNotify,
    };
  }

  if (type === 'REFUND') {
    if (dbOrderId) {
      await db.query(
        `UPDATE orders
         SET pay_status = ?, transaction_id = ?, transaction_code = ?,
             refund_amount = COALESCE(?, refund_amount), refund_at = NOW()
         WHERE order_id = ?`,
        [payStatus, String(transactionId), transactionCode, amount, dbOrderId]
      );
    }

    return {
      success: true,
      type,
      order_id: dbOrderId,
      pay_status: payStatus,
      refund_amount: amount,
      order_found: Boolean(dbOrderId),
    };
  }

  const err = new Error(`Unsupported callback type: ${type}`);
  err.status = 400;
  throw err;
}

module.exports = {
  processVtbCallback,
  findOrderInDb,
  cleanOrderId,
  resolveLtOrderId,
  parseOrderIdFromText,
};
