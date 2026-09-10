const db = require('../db');
const axios = require('axios');
const crypto = require('crypto');
const { logCallback, logCallbackError } = require('./callbackLogger');
const { requireEnv } = require('../lib/env');
const notifyHub = require('../lib/notifyHub');

const LOG = 'VTB_CALLBACK';

// Статусы банка, означающие неуспешный платёж (отклонён / отменён / истёк / ошибка).
const FAILED_PAY_STATUS_RE = /REJECT|DECLIN|CANCEL|EXPIR|FAIL|ERROR|REVOK/i;
const isFailedPayStatus = (status) => Boolean(status) && FAILED_PAY_STATUS_RE.test(String(status));

// Fire-and-forget: push «Оплата не прошла» в хаб уведомлений; ошибки только в лог.
function notifyPaymentFailed(dbOrderId) {
  db.query('SELECT order_id, user_id, package FROM orders WHERE order_id = ? LIMIT 1', [dbOrderId])
    .then(([rows]) => (rows[0] ? notifyHub.resolveOrderUserId(rows[0]) : null))
    .then((userId) => (userId ? notifyHub.paymentFailed({ userId, orderId: dbOrderId }) : null))
    .catch((err) => console.error('[notify-hub] payment_failed hook failed:', err.message));
}

// Внутренний ли заказ (бронирование наших Room Type без Level.Travel). Никогда не бросает.
async function isInternalOrder(orderId) {
  try {
    return await require('../lib/customRooms/bookings').isInternalOrder(orderId);
  } catch (err) {
    return false;
  }
}

const LT_BASE_URL = 'https://api.level.travel';
// Без fallback-литерала (Б.1). Тот же partner token, что и в остальных LT-модулях (LT_API_TOKEN / алиас LT_PARTNER_API_KEY).
const getLtToken = () =>
  process.env.LT_API_TOKEN || process.env.LT_PARTNER_API_KEY || requireEnv('LT_API_TOKEN');
const getLtHeaders = () => ({
  Accept: 'application/vnd.leveltravel.v3.7',
  Authorization: `Token token="${getLtToken()}"`,
  'Content-Type': 'application/json',
});

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
    logCallback(LOG, 'LT_NOTIFY', 'NOT sent — no order_id');
    return { result: 'skipped', reason: 'no_order_id' };
  }

  let ltKey;
  try {
    ltKey = getLtToken();
  } catch (envErr) {
    logCallbackError(LOG, 'LT_NOTIFY', 'NOT sent — LT token is not configured', {
      order_id: orderId,
      error: envErr.message,
    });
    return { result: 'error', order_id: orderId, status: 500, error: envErr.message };
  }

  const status = 'paid';
  const signature = generateSignature(
    orderId,
    status,
    amount,
    ltKey
  );

  logCallback(LOG, 'LT_NOTIFY', 'Sending payment notify to Level Travel', {
    order_id: orderId,
    amount,
    status,
  });

  try {
    const response = await axios.post(
      `${LT_BASE_URL}/orders/${orderId}/notify`,
      { order_id: orderId, status, amount, signature },
      { headers: getLtHeaders() }
    );
    logCallback(LOG, 'LT_NOTIFY', 'OK — Level Travel accepted payment', {
      order_id: orderId,
      http_status: response.status,
      data: response.data,
    });
    return { result: 'ok', order_id: orderId, status: response.status, data: response.data };
  } catch (err) {
    logCallbackError(LOG, 'LT_NOTIFY', 'FAILED — Level Travel rejected payment', {
      order_id: orderId,
      http_status: err.response?.status || 500,
      error: err.response?.data || err.message,
    });
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

  logCallback(LOG, 'IN', 'Bank callback received', {
    type,
    paymentId: object?.paymentId,
    orderId: object?.orderId,
    description: object?.description,
    pay_status: object?.status?.value,
    qrcId: object?.sbpParams?.qrcId,
    amount: object?.amount?.value,
  });

  if (!type || !object) {
    logCallbackError(LOG, 'ERROR', 'Invalid payload — missing type or object');
    const err = new Error('Invalid callback: missing type or object');
    err.status = 400;
    throw err;
  }

  const payStatus = object.status?.value || null;
  const sbp = object.sbpParams || {};
  const dbOrder = await findOrderInDb(object);
  const dbOrderId = dbOrder?.order_id ?? null;

  logCallback(LOG, 'DB', dbOrderId ? 'Order found in DB' : 'Order NOT found in DB', {
    db_order_id: dbOrderId,
    parsed_from_description: resolveLtOrderId(object),
    qrcId: sbp.qrcId,
  });

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
        logCallback(LOG, 'SKIP', 'Duplicate payment callback — already RECONCILED', {
          order_id: dbOrderId,
          transaction_code: transactionCode,
        });
      } else {
        await db.query(
          'UPDATE orders SET pay_status = ?, transaction_id = ?, transaction_code = ? WHERE order_id = ?',
          [payStatus, String(transactionId), transactionCode, dbOrderId]
        );
        logCallback(LOG, 'DB', 'Order payment fields updated', {
          order_id: dbOrderId,
          pay_status: payStatus,
          transaction_id: transactionId,
          transaction_code: transactionCode,
        });
      }

      if (payStatus === 'RECONCILED' && !duplicate && (await isInternalOrder(dbOrderId))) {
        // Наше бронирование без Level.Travel (lib/customRooms/bookings.js): LT не уведомляем,
        // письма/push — свои (onPaid), sendOrderPaidPendingEmail не подходит по тексту.
        ltNotify = { result: 'skipped', reason: 'internal_order' };
        logCallback(LOG, 'LT_NOTIFY', 'NOT sent — internal order (custom room booking)', { order_id: dbOrderId });
        require('../lib/customRooms/bookings')
          .onPaid(dbOrderId, amount, { source: 'vtb_callback' })
          .catch((err) => logCallbackError(LOG, 'BOOKING', 'Internal booking onPaid failed', { order_id: dbOrderId, error: err.message }));
      } else if (payStatus === 'RECONCILED' && !duplicate) {
        ltNotify = await notifyLevelTravelPaid(dbOrderId, amount);

        try {
          const [rows] = await db.query(
            'SELECT * FROM orders WHERE order_id = ? LIMIT 1',
            [dbOrderId]
          );
          if (rows[0]) {
            const { sendOrderPaidPendingEmail } = require('./orderEmails');
            sendOrderPaidPendingEmail(dbOrderId, rows[0], { amount }).catch((err) => {
              logCallbackError(LOG, 'EMAIL', 'Paid pending email failed', {
                order_id: dbOrderId,
                error: err.message,
              });
            });
          }
        } catch (emailErr) {
          logCallbackError(LOG, 'EMAIL', 'Paid pending email setup failed', {
            order_id: dbOrderId,
            error: emailErr.message,
          });
        }
      } else if (payStatus !== 'RECONCILED') {
        logCallback(LOG, 'LT_NOTIFY', 'NOT sent — payment not RECONCILED', {
          pay_status: payStatus,
        });
        // Push «Оплата не прошла» при отклонённом/просроченном платеже (один раз на смену статуса).
        // Успешная оплата уходит в хаб из sendOrderPaidPendingEmail (см. utils/orderEmails.js).
        if (isFailedPayStatus(payStatus) && dbOrder.pay_status !== payStatus) {
          notifyPaymentFailed(dbOrderId);
          // внутреннее бронирование: событие payment_failed в таймлайне (статус не меняем)
          isInternalOrder(dbOrderId)
            .then((yes) => (yes ? require('../lib/customRooms/bookings').onPaymentFailed(dbOrderId, payStatus) : null))
            .catch(() => {});
        }
      }
    } else {
      logCallback(LOG, 'LT_NOTIFY', 'NOT sent — order not found in DB');
    }

    const result = {
      success: true,
      type,
      order_id: dbOrderId,
      pay_status: payStatus,
      duplicate,
      order_found: Boolean(dbOrderId),
      lt_notify: ltNotify,
    };
    logCallback(LOG, 'OUT', 'Bank callback processed', result);
    return result;
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
      logCallback(LOG, 'DB', 'Order refund fields updated', {
        order_id: dbOrderId,
        pay_status: payStatus,
        refund_amount: amount,
      });
      // Внутреннее бронирование: отметить возврат выполненным (возвраты делаются вручную, это только запись).
      if (await isInternalOrder(dbOrderId)) {
        await require('../lib/customRooms/bookings')
          .onBankRefund(dbOrderId, amount)
          .catch((err) => logCallbackError(LOG, 'BOOKING', 'Internal booking refund mark failed', { order_id: dbOrderId, error: err.message }));
      }
    } else {
      logCallback(LOG, 'DB', 'Refund callback — order NOT found in DB');
    }

    const result = {
      success: true,
      type,
      order_id: dbOrderId,
      pay_status: payStatus,
      refund_amount: amount,
      order_found: Boolean(dbOrderId),
    };
    logCallback(LOG, 'OUT', 'Bank refund callback processed', result);
    return result;
  }

  logCallbackError(LOG, 'ERROR', `Unsupported callback type: ${type}`);
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
