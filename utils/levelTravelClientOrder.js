require('dotenv').config();
const axios = require('axios');
const db = require('../db');
const {
  saveAllDocumentsFromOrder,
  extractDownloadablesFromOrder,
} = require('./orderDocuments');
const { logCallback, logCallbackError } = require('./callbackLogger');
const { requireEnv } = require('../lib/env');
const notifyHub = require('../lib/notifyHub');

const LOG = 'LT_CLIENT';
const BASE_URL = 'https://api.level.travel';
// Без fallback-литерала (Б.1). Заголовки строятся при вызове — с понятной ошибкой, если токен не задан.
const getLtToken = () =>
  process.env.LT_API_TOKEN || process.env.LT_PARTNER_API_KEY || requireEnv('LT_API_TOKEN');

const getHeaders34 = () => ({
  Accept: 'application/vnd.leveltravel.v3.4',
  Authorization: `Token token="${getLtToken()}"`,
  'Content-Type': 'application/json',
});

// Push «Документы готовы» при первом появлении документов тура в синхронизации
// (fire-and-forget). «Новые» = реально скачанные сейчас (не cached / skipped_duplicate / error);
// договоры оферты/лицензии не считаем. Повторы за 10 минут гасит dedupe в notifyHub.
function notifyHubDocumentsReady(orderId, savedDocuments) {
  const kinds = new Set();
  for (const doc of savedDocuments || []) {
    if (!doc?.public_url || doc.error || doc.cached || doc.skipped_duplicate) continue;
    const kind = notifyHub.detectDocumentKind(doc.title);
    if (kind !== 'agreement') kinds.add(kind);
  }
  if (!kinds.size) return;

  db.query('SELECT order_id, user_id, package FROM orders WHERE order_id = ? LIMIT 1', [orderId])
    .then(([rows]) => (rows[0] ? notifyHub.resolveOrderUserId(rows[0]) : null))
    .then(async (userId) => {
      if (!userId) return;
      for (const kind of kinds) {
        await notifyHub.documentsReady({ userId, orderId, kind });
      }
    })
    .catch((err) => console.error('[notify-hub] documents sync hook failed:', err.message));
}

// opts.allowEnv=false — только токен самого заказа (query/строка БД/package), без общего LT_CLIENT_AUTH_TOKEN:
// используется, когда токен отдаётся клиенту (lt_auth_token в GET /orders) — чужой env-токен наружу не уходит.
function resolveAuthToken(orderRow, overrideToken, opts = {}) {
  const explicit = String(overrideToken || '').trim();
  if (explicit) return explicit;

  // Prefer per-order client token — env token only sees a subset of orders.
  const rowToken = String(orderRow?.lt_auth_token || '').trim();
  if (rowToken) return rowToken;

  if (orderRow?.package) {
    try {
      const pkg =
        typeof orderRow.package === 'string'
          ? JSON.parse(orderRow.package)
          : orderRow.package;
      const pkgToken =
        pkg?._lt_auth_token || pkg?.auth_token || pkg?.client?.auth_token || null;
      if (pkgToken) return String(pkgToken).trim();
    } catch {
      // ignore parse errors
    }
  }

  // Внутренние заказы (бронирования Arlekino, order_id >= 900000000) в Level.Travel не существуют —
  // общий env-токен к ним не применяем (иначе LT вернёт чужой заказ / order not found).
  if (isInternalOrderId(orderRow?.order_id)) return null;
  if (opts && opts.allowEnv === false) return null;

  const envToken = String(process.env.LT_CLIENT_AUTH_TOKEN || '').trim();
  if (envToken) return envToken;

  return null;
}

function isInternalOrderId(orderId) {
  const n = Number(String(orderId ?? '').replace(/^ORDER/i, '').trim());
  return Number.isFinite(n) && n >= 900000000;
}

function parseLtOrderResponse(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.success === true && data.order) return data.order;
  if (data.order && typeof data.order === 'object') return data.order;
  if (data.data?.order) return data.data.order;
  if (Array.isArray(data.orders) && data.orders.length) return data.orders[0];
  if (data.id != null && (data.state != null || data.attachments)) return data;
  return null;
}

async function fetchClientOrderRaw(orderId, authToken) {
  const url = `${BASE_URL}/client/orders/${orderId}`;
  const payload = { auth_token: authToken };

  logCallback(LOG, 'FETCH', 'GET /client/orders/:id', { order_id: orderId });

  const attempts = [
    () => axios.post(url, payload, { headers: getHeaders34(), timeout: 60000 }),
    () =>
      axios({
        method: 'GET',
        url,
        headers: getHeaders34(),
        data: payload,
        timeout: 60000,
      }),
    () =>
      axios.get(url, {
        headers: getHeaders34(),
        params: payload,
        timeout: 60000,
      }),
  ];

  let lastError = null;
  for (const attempt of attempts) {
    try {
      const response = await attempt();
      const order = parseLtOrderResponse(response.data);
      if (order) {
        return { raw: response.data, order };
      }
      lastError = new Error('Empty order in LT response');
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error('Failed to fetch order from Level Travel');
}

async function fetchClientOrder(orderId, authToken) {
  const { order } = await fetchClientOrderRaw(orderId, authToken);
  logCallback(LOG, 'FETCH', 'Order parsed', {
    order_id: orderId,
    state: order.state,
    attachments: Array.isArray(order.attachments) ? order.attachments.length : 0,
    agreement_doc: Boolean(order.agreement_doc),
    agreement_license: Boolean(order.agreement_license),
  });
  return order;
}

/**
 * List client orders from Level Travel.
 * Tries several transport shapes because LT accepts auth_token inconsistently
 * across GET query / GET body / POST body depending on client.
 */
async function fetchClientOrdersList({
  authToken,
  pageNumber = '0',
  pageLimit = '10',
} = {}) {
  const token = String(authToken || '').trim();
  if (!token) {
    const err = new Error('Missing auth_token');
    err.status = 400;
    err.code = 'missing_auth_token';
    throw err;
  }

  const payload = {
    auth_token: token,
    page_number: String(pageNumber ?? '0'),
    page_limit: String(pageLimit ?? '10'),
  };

  logCallback(LOG, 'FETCH', 'GET /client/orders', {
    page_number: payload.page_number,
    page_limit: payload.page_limit,
  });

  const attempts = [
    () =>
      axios.get(`${BASE_URL}/client/orders`, {
        headers: getHeaders34(),
        params: payload,
        timeout: 60000,
      }),
    () =>
      axios({
        method: 'GET',
        url: `${BASE_URL}/client/orders`,
        headers: getHeaders34(),
        data: payload,
        timeout: 60000,
      }),
    () =>
      axios.post(`${BASE_URL}/client/orders`, payload, {
        headers: getHeaders34(),
        timeout: 60000,
      }),
  ];

  let lastError = null;
  for (const attempt of attempts) {
    try {
      const response = await attempt();
      if (response?.data) {
        return { raw: response.data, status: response.status };
      }
      lastError = new Error('Empty response from Level Travel');
    } catch (err) {
      lastError = err;
      const code = err.response?.data?.error || err.response?.data?.errors;
      // Do not retry other shapes for definitive client errors
      if (code === 'client_not_found' || (Array.isArray(code) && code.includes('client_not_found'))) {
        break;
      }
    }
  }

  throw lastError || new Error('Failed to fetch client orders from Level Travel');
}

function formatLtClientError(error) {
  const data = error?.response?.data;
  const status = error?.response?.status || error?.status || 500;
  const code =
    data?.error ||
    (Array.isArray(data?.errors) ? data.errors[0] : null) ||
    error?.code ||
    null;

  if (code === 'client_not_found' || error?.code === 'client_not_found') {
    return {
      status: status === 500 ? 404 : status,
      body: {
        success: false,
        error: 'client_not_found',
        errors: ['client_not_found'],
        hint:
          'auth_token is not a valid Level Travel client token. Use order.auth_token from /orders/create (stored as orders.lt_auth_token). Partner API key goes only in Authorization header.',
        origin: data?.origin || 'https://level.travel',
      },
    };
  }

  if (error?.code === 'missing_auth_token' || status === 400) {
    return {
      status: 400,
      body: {
        success: false,
        error: 'missing_auth_token',
        hint:
          'Pass auth_token query/body from the order create response (orders.lt_auth_token).',
      },
    };
  }

  return {
    status,
    body: data || { success: false, error: error.message },
  };
}

function getNewStateFromChanges(changes) {
  if (Array.isArray(changes?.state) && changes.state.length >= 2) {
    return changes.state[1];
  }
  return null;
}

function shouldDownloadDocuments(event, changes, order) {
  if (event === 'documents' || changes?.attachments) return true;

  const newState = getNewStateFromChanges(changes);
  if (
    newState === 'documents_sent' ||
    newState === 'confirmed' ||
    newState === 'flight_confirmed'
  ) {
    return true;
  }

  if (order?.state === 'documents_sent') return true;

  return extractDownloadablesFromOrder(order).length > 0;
}

function buildPackageFromClientOrder(
  ltOrder,
  raw,
  authToken,
  savedDocuments = [],
  existingPkg = null
) {
  const existing =
    existingPkg && typeof existingPkg === 'object'
      ? JSON.parse(JSON.stringify(existingPkg))
      : {};

  const lt = JSON.parse(JSON.stringify(ltOrder));

  // Merge: keep existing DB shape, overwrite with fresh LT client/orders data
  const pkg = {
    ...existing,
    ...lt,
  };

  // Nested tour object — always replace from GET /client/orders/:id
  if (lt.package) {
    pkg.package = lt.package;
  }

  pkg._lt_auth_token = authToken;
  pkg._lt_synced_at = new Date().toISOString();

  if (raw) {
    pkg._lt_client_response = raw;
  }

  const successful = savedDocuments.filter((d) => d.public_url && !d.error);
  if (successful.length) {
    pkg.saved_documents = successful.map((doc) => ({
      id: doc.id,
      title: doc.title,
      url: doc.public_url,
      source_url: doc.source_url,
      file_path: doc.file_path,
    }));
  }

  return pkg;
}

async function loadExistingPackage(orderId) {
  const [rows] = await db.query(
    'SELECT package FROM orders WHERE order_id = ? LIMIT 1',
    [orderId]
  );
  if (!rows[0]?.package) return null;

  try {
    return JSON.parse(rows[0].package);
  } catch {
    return null;
  }
}

async function saveOrderPackageToDb(orderId, pkg, authToken, orderState) {
  const [rows] = await db.query(
    'SELECT id FROM orders WHERE order_id = ? LIMIT 1',
    [orderId]
  );

  if (!rows[0]) return false;

  const state = orderState || pkg.state || null;

  await db.query(
    `UPDATE orders
     SET package = ?, order_state = COALESCE(?, order_state),
         lt_auth_token = COALESCE(lt_auth_token, ?)
     WHERE order_id = ?`,
    [JSON.stringify(pkg), state, authToken, orderId]
  );

  logCallback(LOG, 'DB', 'orders.package updated from client/orders/:id', {
    order_id: orderId,
    order_state: state,
    fields: Object.keys(pkg).length,
    package_id: pkg.package?.id || null,
    attachments: Array.isArray(pkg.attachments) ? pkg.attachments.length : 0,
  });

  return true;
}

/**
 * Fetch order from LT client API, replace orders.package with full response, download PDFs.
 */
async function syncOrderFromClient(orderId, authToken, options = {}) {
  const {
    eventReference = null,
    downloadDocs = true,
    event = null,
    changes = null,
  } = options;

  const { raw, order: ltOrder } = await fetchClientOrderRaw(orderId, authToken);

  let savedDocuments = [];

  const needDocs =
    downloadDocs &&
    (event == null || shouldDownloadDocuments(event, changes, ltOrder));

  if (needDocs) {
    const downloadable = extractDownloadablesFromOrder(ltOrder);
    logCallback(LOG, 'DOCS', 'Downloading attachments from LT order', {
      order_id: orderId,
      count: downloadable.length,
      titles: downloadable.map((d) => d.title),
    });

    if (downloadable.length) {
      savedDocuments = await saveAllDocumentsFromOrder(orderId, ltOrder, eventReference);
      logCallback(LOG, 'DOCS', 'Download complete', {
        order_id: orderId,
        saved: savedDocuments.filter((d) => d.public_url).length,
        errors: savedDocuments.filter((d) => d.error).length,
      });
    }
  }

  const orderState = ltOrder.state || getNewStateFromChanges(changes) || null;
  const existingPkg = await loadExistingPackage(orderId);
  let pkg = buildPackageFromClientOrder(
    ltOrder,
    raw,
    authToken,
    savedDocuments,
    existingPkg
  );

  const { applyLocalDocumentUrlsToPackage, getOrderDocuments } = require('./orderDocuments');
  const documents = await getOrderDocuments(orderId);
  pkg = applyLocalDocumentUrlsToPackage(orderId, pkg, documents);

  const packageUpdated = await saveOrderPackageToDb(orderId, pkg, authToken, orderState);

  notifyHubDocumentsReady(orderId, savedDocuments);

  return {
    success: true,
    order_id: orderId,
    order_state: orderState,
    lt_response: raw,
    package: pkg,
    package_updated: packageUpdated,
    saved_documents: savedDocuments,
    attachments_count: Array.isArray(ltOrder.attachments) ? ltOrder.attachments.length : 0,
  };
}

module.exports = {
  fetchClientOrder,
  fetchClientOrderRaw,
  fetchClientOrdersList,
  formatLtClientError,
  syncOrderFromClient,
  buildPackageFromClientOrder,
  saveOrderPackageToDb,
  loadExistingPackage,
  resolveAuthToken,
  isInternalOrderId,
  shouldDownloadDocuments,
  getNewStateFromChanges,
  parseLtOrderResponse,
  getHeaders34,
  get HEADERS_3_4() {
    return getHeaders34();
  },
  BASE_URL,
};
