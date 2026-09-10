'use strict';
// Клиент хаба уведомлений calling_api_v2 (POST /internal/notify, заголовок X-Internal-Key).
// План: PUSH_NOTIFICATIONS_PLAN_RU.md (этап 5), контракт: API.md §5 «Внутренний API».
//
// Правила:
//  - fire-and-forget: ни один вызов не бросает исключений и не блокирует основной поток;
//  - таймаут 5 с, все результаты пишутся в лог с префиксом [notify-hub];
//  - без NOTIFY_HUB_URL / INTERNAL_API_KEY — один warn при первом вызове, дальше no-op;
//  - в хаб уходят только userId/loyaltyId, номер заказа, тип и короткий текст — никаких ПД
//    (имён, e-mail, телефонов). Поиск users.id по e-mail покупателя делается здесь,
//    сам e-mail в payload не попадает.

const LOG = '[notify-hub]';
const TIMEOUT_MS = 5000;
const DEDUPE_TTL_MS = 10 * 60 * 1000;
const TITLE_MAX = 160;
const BODY_MAX = 512;

// Типы из API.md §2 (категории orders / documents — обязательные, нельзя отключить).
const TYPES = new Set([
  'order_created',
  'payment_success',
  'payment_failed',
  'order_confirmed',
  'order_status',
  'order_cancelled',
  'documents_ready',
  'order_request_status',
  'system',
]);

// Русские подписи статусов заказа Level.Travel (order_state / changes.state) для order_status.
const ORDER_STATE_LABELS_RU = {
  new: 'заказ создан',
  created: 'заказ создан',
  pending: 'заказ в обработке',
  processing: 'заказ в обработке',
  in_progress: 'заказ в обработке',
  wait_payment: 'ожидает оплаты',
  awaiting_payment: 'ожидает оплаты',
  paid: 'оплата получена',
  partially_paid: 'получена частичная оплата',
  booked: 'тур забронирован',
  confirmed: 'тур подтверждён',
  flight_confirmed: 'перелёт подтверждён',
  documents_sent: 'документы отправлены',
  completed: 'поездка завершена',
  finished: 'поездка завершена',
  canceled: 'заказ отменён',
  cancelled: 'заказ отменён',
  annulled: 'заказ аннулирован',
  rejected: 'заказ отклонён',
  refunded: 'оформлен возврат средств',
};

// Русские подписи статусов обращения (order_requests.status).
const REQUEST_STATUS_LABELS_RU = {
  new: 'принято',
  in_progress: 'в работе',
  done: 'выполнено',
  rejected: 'отклонено',
};

let warnedNotConfigured = false;
const dedupe = new Map();

function getConfig() {
  const url = String(process.env.NOTIFY_HUB_URL || '').trim().replace(/\/+$/, '');
  const key = String(process.env.INTERNAL_API_KEY || '').trim();
  return { url, key, configured: Boolean(url && key) };
}

function isConfigured() {
  return getConfig().configured;
}

function trimText(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function normalizeOrderId(orderId) {
  if (orderId == null) return '';
  return String(orderId).trim().replace(/^ORDER/i, '');
}

function toUserId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Ключ «один раз за TTL» на процесс: защита от повторных хуков (callback + письмо, retry LT). */
function seenRecently(key) {
  if (!key) return false;
  const now = Date.now();
  if (dedupe.size > 500) {
    for (const [k, ts] of dedupe) {
      if (now - ts > DEDUPE_TTL_MS) dedupe.delete(k);
    }
  }
  const last = dedupe.get(key);
  if (last && now - last < DEDUPE_TTL_MS) return true;
  dedupe.set(key, now);
  return false;
}

function resetDedupe() {
  dedupe.clear();
}

function pickCustomerEmail(pkg) {
  if (!pkg || typeof pkg !== 'object') return null;
  if (pkg._customer_email) return String(pkg._customer_email).trim();
  const client = pkg.client || pkg.package?.client;
  if (client?.email) return String(client.email).trim();
  const tourists = pkg.tourists || pkg.package?.tourists;
  if (Array.isArray(tourists)) {
    const tourist = tourists.find((item) => item?.email);
    if (tourist?.email) return String(tourist.email).trim();
  }
  return null;
}

/**
 * userId получателя по строке orders: orders.user_id, иначе users.id по e-mail покупателя
 * из package (один SELECT). Возвращает null, если найти не удалось (в лог — без e-mail).
 */
async function resolveOrderUserId(orderRow) {
  const direct = toUserId(orderRow?.user_id);
  if (direct) return direct;

  let pkg = orderRow?.package;
  if (typeof pkg === 'string') {
    try {
      pkg = JSON.parse(pkg || '{}');
    } catch {
      pkg = {};
    }
  }
  const email = pickCustomerEmail(pkg);
  if (!email) {
    console.log(`${LOG} skip: order ${normalizeOrderId(orderRow?.order_id) || '?'} has no user_id and no customer email`);
    return null;
  }

  try {
    const db = require('../db');
    const [rows] = await db.query('SELECT id FROM users WHERE email = ? LIMIT 1', [email]);
    const found = toUserId(rows[0]?.id);
    if (!found) {
      console.log(`${LOG} skip: no user for customer email of order ${normalizeOrderId(orderRow?.order_id) || '?'}`);
    }
    return found;
  } catch (err) {
    console.error(`${LOG} user lookup failed:`, err.message);
    return null;
  }
}

async function postWithTimeout(url, key, body) {
  const headers = { 'Content-Type': 'application/json', 'X-Internal-Key': key };
  const json = JSON.stringify(body);

  if (typeof fetch === 'function') {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), TIMEOUT_MS) : null;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: json,
        signal: controller ? controller.signal : undefined,
      });
      let data = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }
      return { status: response.status, data };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Node без глобального fetch — axios уже есть в package.json.
  const axios = require('axios');
  const response = await axios.post(url, body, {
    headers,
    timeout: TIMEOUT_MS,
    validateStatus: () => true,
  });
  return { status: response.status, data: response.data };
}

/** Сборка и валидация payload для /internal/notify (чистая функция, используется в scripts/check-notify-hub.js). */
function buildPayload({ userId, userIds, loyaltyId, type, title, body, data, collapseKey, source } = {}) {
  if (!TYPES.has(type)) throw new Error(`type_invalid: ${type}`);
  const text = trimText(body, BODY_MAX);
  if (!text) throw new Error('body_required');

  const payload = { type, body: text, source: source || 'totus_api' };
  const uid = toUserId(userId);
  if (uid) payload.userId = uid;
  else if (Array.isArray(userIds) && userIds.length) payload.userIds = userIds.map(toUserId).filter(Boolean);
  else if (loyaltyId) payload.loyaltyId = String(loyaltyId).trim();
  if (!payload.userId && !payload.userIds?.length && !payload.loyaltyId) throw new Error('user_required');

  const heading = trimText(title, TITLE_MAX);
  if (heading) payload.title = heading;
  if (data && typeof data === 'object') {
    payload.data = {};
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined || v === null || v === '') continue;
      payload.data[k] = typeof v === 'object' ? v : String(v);
    }
  }
  if (collapseKey) payload.collapseKey = String(collapseKey);
  return payload;
}

/**
 * Отправка в хаб. Никогда не бросает. Возвращает { ok, skipped?, status?, data?, error? }.
 * opts.dedupeKey — не слать повторно тот же ключ в течение 10 минут (в рамках процесса).
 */
async function notify(input, opts = {}) {
  let payload;
  try {
    payload = buildPayload(input);
  } catch (err) {
    console.error(`${LOG} invalid payload:`, err.message);
    return { ok: false, skipped: 'invalid', error: err.message };
  }

  const { url, key, configured } = getConfig();
  if (!configured) {
    if (!warnedNotConfigured) {
      warnedNotConfigured = true;
      console.warn(`${LOG} NOTIFY_HUB_URL / INTERNAL_API_KEY not set — notifications disabled`);
    }
    return { ok: false, skipped: 'not_configured', payload };
  }

  if (opts.dedupeKey && seenRecently(opts.dedupeKey)) {
    console.log(`${LOG} skip duplicate ${opts.dedupeKey}`);
    return { ok: false, skipped: 'duplicate', payload };
  }

  const target = `${payload.type} → ${payload.userId ? `user ${payload.userId}` : payload.loyaltyId ? `loyalty ${payload.loyaltyId}` : `users ${payload.userIds?.length || 0}`}`;
  try {
    const { status, data } = await postWithTimeout(`${url}/internal/notify`, key, payload);
    if (status >= 200 && status < 300) {
      const push = data?.push || {};
      console.log(`${LOG} sent ${target}: inapp=${data?.inapp ?? '?'} push=${push.sent ?? 0}/${push.failed ?? 0} deferred=${data?.deferred ?? 0}`);
      return { ok: true, status, data, payload };
    }
    console.error(`${LOG} hub responded ${status} for ${target}:`, data?.error || data || '');
    return { ok: false, status, data, payload };
  } catch (err) {
    const reason = err?.name === 'AbortError' ? `timeout ${TIMEOUT_MS}ms` : err.message;
    console.error(`${LOG} request failed for ${target}: ${reason}`);
    return { ok: false, error: reason, payload };
  }
}

/** Fire-and-forget: запустить notify() и не ждать (ошибки уже залогированы внутри). */
function fire(input, opts) {
  notify(input, opts).catch((err) => console.error(`${LOG} unexpected:`, err?.message || err));
}

// ---------- Тексты по типам (без ПД: только номер заказа / обращения и статус) ----------

function orderData(orderId, route, extra) {
  return { orderId: normalizeOrderId(orderId), route, ...(extra || {}) };
}

const texts = {
  orderCreated: ({ orderId }) => ({
    type: 'order_created',
    title: `Заказ №${normalizeOrderId(orderId)} ожидает оплаты`,
    body: 'Оплатите заказ, чтобы забронировать тур. Ссылка на оплату — в деталях заказа.',
  }),
  paymentSuccess: ({ orderId }) => ({
    type: 'payment_success',
    title: 'Оплата прошла',
    body: `Заказ №${normalizeOrderId(orderId)} оплачен. Документы будут готовы в течение 15 минут.`,
  }),
  paymentFailed: ({ orderId }) => ({
    type: 'payment_failed',
    title: 'Оплата не прошла',
    body: `Заказ №${normalizeOrderId(orderId)}: платёж не подтверждён. Попробуйте ещё раз.`,
  }),
  orderConfirmed: ({ orderId }) => ({
    type: 'order_confirmed',
    title: 'Тур подтверждён',
    body: `Туроператор подтвердил заказ №${normalizeOrderId(orderId)}.`,
  }),
  orderStatus: ({ orderId, statusText }) => ({
    type: 'order_status',
    title: 'Статус заказа изменился',
    body: `Заказ №${normalizeOrderId(orderId)}: ${trimText(statusText, 120).replace(/[.!]+$/, '')}.`,
  }),
  orderCancelled: ({ orderId }) => ({
    type: 'order_cancelled',
    title: 'Заказ отменён',
    body: `Заказ №${normalizeOrderId(orderId)} отменён. Если это ошибка — напишите в чат поддержки.`,
  }),
  documentsReady: ({ orderId, kind }) => {
    const n = normalizeOrderId(orderId);
    const body =
      kind === 'voucher'
        ? `Ваучер по заказу №${n} доступен в приложении.`
        : kind === 'tickets'
          ? `Билеты по заказу №${n} доступны в приложении.`
          : kind === 'other'
            ? `Новый документ по заказу №${n} доступен в приложении.`
            : `Ваучер и билеты по заказу №${n} доступны в приложении.`;
    return { type: 'documents_ready', title: 'Документы готовы', body };
  },
  orderRequestStatus: ({ requestId, orderId, status }) => ({
    type: 'order_request_status',
    title: 'Ответ по обращению',
    body: `Обращение №${requestId} по заказу №${normalizeOrderId(orderId)}: ${REQUEST_STATUS_LABELS_RU[status] || status}.`,
  }),
};

/** Вид документа по названию файла (для documentsReady): voucher | tickets | agreement | other. */
function detectDocumentKind(title) {
  const t = String(title || '').toLowerCase();
  if (/договор|оферт|лиценз|agreement|license|contract/.test(t)) return 'agreement';
  if (/ваучер|voucher/.test(t)) return 'voucher';
  if (/билет|ticket|маршрут|itinerary|boarding/.test(t)) return 'tickets';
  return 'other';
}

/**
 * Русская подпись статуса заказа: только словарь ORDER_STATE_LABELS_RU и, если состояние
 * в нём не найдено, `status_for_client` от LT (structured-поле, а не свободный текст `message`
 * события — его сюда передавать нельзя, см. RULES.md п.3). Неизвестное состояние без
 * status_for_client — «статус заказа обновлён» (никогда не null, вызывающий код не должен
 * проверять пустой результат).
 */
function orderStatusText(state, statusForClient) {
  const key = String(state || '').trim().toLowerCase();
  if (ORDER_STATE_LABELS_RU[key]) return ORDER_STATE_LABELS_RU[key];
  const firstLine = String(statusForClient || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine ? trimText(firstLine, 120) : 'статус заказа обновлён';
}

function collapse(orderId, type) {
  return `order_${normalizeOrderId(orderId)}_${type}`;
}

function helper(name, route, extraData) {
  return (args = {}) => {
    const t = texts[name](args);
    const orderId = normalizeOrderId(args.orderId);
    const extra = typeof extraData === 'function' ? extraData(args) : extraData;
    const collapseKey = collapse(orderId, t.type);
    // Дедуп на процесс (10 мин): по collapseKey; для order_status — ещё и по тексту,
    // для documents_ready — по виду документа (ваучер / билеты / прочее).
    let dedupeKey = collapseKey;
    if (t.type === 'order_status') dedupeKey = `${collapseKey}:${t.body}`;
    if (t.type === 'documents_ready' && args.kind) dedupeKey = `${collapseKey}:${args.kind}`;
    if (args.dedupeKey === null) dedupeKey = null;
    else if (args.dedupeKey) dedupeKey = args.dedupeKey;
    return notify(
      {
        userId: args.userId,
        loyaltyId: args.loyaltyId,
        ...t,
        data: orderData(orderId, route, extra),
        collapseKey,
      },
      { dedupeKey }
    );
  };
}

const orderCreated = helper('orderCreated', 'order');
const paymentSuccess = helper('paymentSuccess', 'order');
const paymentFailed = helper('paymentFailed', 'order');
const orderConfirmed = helper('orderConfirmed', 'order');
const orderStatus = helper('orderStatus', 'order');
const orderCancelled = helper('orderCancelled', 'order');
const documentsReady = helper('documentsReady', 'documents');
const orderRequestStatus = helper('orderRequestStatus', 'order_request', (a) => ({ requestId: a.requestId }));

module.exports = {
  TYPES,
  ORDER_STATE_LABELS_RU,
  REQUEST_STATUS_LABELS_RU,
  isConfigured,
  buildPayload,
  notify,
  fire,
  texts,
  detectDocumentKind,
  orderStatusText,
  resolveOrderUserId,
  resetDedupe,
  orderCreated,
  paymentSuccess,
  paymentFailed,
  orderConfirmed,
  orderStatus,
  orderCancelled,
  documentsReady,
  orderRequestStatus,
};
