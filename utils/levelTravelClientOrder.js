require('dotenv').config();
const axios = require('axios');
const db = require('../db');
const {
  saveAllDocumentsFromOrder,
  extractDownloadablesFromOrder,
} = require('./orderDocuments');
const { logCallback, logCallbackError } = require('./callbackLogger');

const LOG = 'LT_CLIENT';
const BASE_URL = 'https://api.level.travel';
const LT_API_TOKEN =
  process.env.LT_API_TOKEN || process.env.LT_PARTNER_API_KEY || '6a6ca82f341fea2a9d19b0d581c448e7';

const HEADERS_3_4 = {
  Accept: 'application/vnd.leveltravel.v3.4',
  Authorization: `Token token="${LT_API_TOKEN}"`,
  'Content-Type': 'application/json',
};

function resolveAuthToken(orderRow, overrideToken) {
  const explicit = String(overrideToken || '').trim();
  if (explicit) return explicit;

  const envToken = String(process.env.LT_CLIENT_AUTH_TOKEN || '').trim();
  if (envToken) return envToken;

  const rowToken = String(orderRow?.lt_auth_token || '').trim();
  if (rowToken) return rowToken;

  if (!orderRow?.package) return null;

  try {
    const pkg = JSON.parse(orderRow.package);
    return (
      pkg._lt_auth_token ||
      pkg.auth_token ||
      pkg.client?.auth_token ||
      null
    );
  } catch {
    return null;
  }
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
    () => axios.post(url, payload, { headers: HEADERS_3_4, timeout: 60000 }),
    () =>
      axios({
        method: 'GET',
        url,
        headers: HEADERS_3_4,
        data: payload,
        timeout: 60000,
      }),
    () =>
      axios.get(url, {
        headers: HEADERS_3_4,
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
  syncOrderFromClient,
  buildPackageFromClientOrder,
  saveOrderPackageToDb,
  loadExistingPackage,
  resolveAuthToken,
  shouldDownloadDocuments,
  getNewStateFromChanges,
  parseLtOrderResponse,
  HEADERS_3_4,
  BASE_URL,
};
