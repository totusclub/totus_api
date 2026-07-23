require('dotenv').config();
const db = require('../db');
const {
  resolveAuthToken,
  syncOrderFromClient,
  getNewStateFromChanges,
  shouldDownloadDocuments,
} = require('./levelTravelClientOrder');
const { logCallback, logCallbackError, logCallbackBanner } = require('./callbackLogger');

const LOG_NOTIFY = 'LT_NOTIFY';
const LOG_REFUND = 'LT_REFUND';

const PARTNER_API_KEY =
  process.env.PARTNER_API_KEY || '589e52d73074435f9fc8202b7ec80673';

function verifyPartnerApiKey(req, res, next) {
  const key = String(req.headers['partner-api-key'] || '').trim();
  const expected = String(PARTNER_API_KEY || '').trim();

  if (!key || key !== expected) {
    logCallbackBanner(LOG_NOTIFY, '❌ CALLBACK REJECTED — bad/missing Partner-Api-Key', {
      path: req.originalUrl || req.path,
      method: req.method,
      ip: req.ip,
      has_key: Boolean(key),
      key_length: key.length,
      expected_length: expected.length,
      order_id: req.body?.order_id,
      event: req.body?.event,
    });
    logCallbackError(LOG_NOTIFY, 'AUTH', 'Rejected — invalid Partner-Api-Key (nothing saved)', {
      path: req.path,
      has_key: Boolean(key),
      key_length: key.length,
      expected_length: expected.length,
      order_id: req.body?.order_id,
      event: req.body?.event,
    });
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  next();
}

function logLtRequest(channel) {
  return (req, res, next) => {
    const summary = {
      ip: req.ip,
      method: req.method,
      path: req.originalUrl || req.path,
      has_partner_key: Boolean(req.headers['partner-api-key']),
      order_id: req.body?.order_id,
      event: req.body?.event,
      event_reference: req.body?.event_reference || req.body?.request_reference,
      message:
        typeof req.body?.message === 'string'
          ? req.body.message.slice(0, 120)
          : req.body?.message,
      state_change: req.body?.changes?.state || null,
      body_keys: req.body && typeof req.body === 'object' ? Object.keys(req.body) : [],
    };

    logCallbackBanner(
      channel,
      '🔔 LEVEL TRAVEL CALLBACK HIT — incoming request',
      summary,
    );
    logCallback(channel, 'HTTP_IN', 'Raw request received', summary);
    next();
  };
}

async function isDuplicateReference(reference) {
  const [rows] = await db.query(
    'SELECT id FROM lt_order_events WHERE reference = ? LIMIT 1',
    [reference]
  );
  return rows.length > 0;
}

async function logEvent({
  order_id,
  reference,
  reference_type,
  event,
  event_timestamp,
  message,
  changes,
  payload,
}) {
  const [result] = await db.query(
    `INSERT INTO lt_order_events
      (order_id, reference, reference_type, event, event_timestamp, message, changes, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      order_id,
      reference,
      reference_type,
      event || null,
      event_timestamp ?? null,
      message || null,
      changes != null ? JSON.stringify(changes) : null,
      JSON.stringify(payload),
    ]
  );
  return result.insertId;
}

function applyChangesToPackage(pkg, changes, event) {
  if (!pkg || typeof pkg !== 'object') {
    pkg = {};
  }

  if (Array.isArray(changes)) {
    if (event === 'order_extra_create' && changes[1]) {
      if (!Array.isArray(pkg.order_extras)) {
        pkg.order_extras = [];
      }
      pkg.order_extras.push(changes[1]);
    }
    return pkg;
  }

  if (!changes || typeof changes !== 'object') {
    return pkg;
  }

  if (Array.isArray(changes.state) && changes.state.length >= 2) {
    pkg.state = changes.state[1];
    // Drop stale LT client labels — full sync will refill them from LT.
    delete pkg.status_for_client;
    delete pkg.header_for_client;
    delete pkg.description_for_client;
  }

  // Keep client-facing status in sync with callback text when LT sends it.
  // (notify payload often has `message` on the body, applied by caller.)
  if (typeof changes.status_for_client === 'string' && changes.status_for_client.trim()) {
    pkg.status_for_client = changes.status_for_client.trim();
  } else if (
    Array.isArray(changes.status_for_client) &&
    changes.status_for_client.length >= 2 &&
    changes.status_for_client[1]
  ) {
    pkg.status_for_client = String(changes.status_for_client[1]);
  }

  if (Array.isArray(changes.attachments) && changes.attachments.length >= 2) {
    pkg.attachments = changes.attachments[1];
  }

  if (Array.isArray(changes.package_id) && changes.package_id.length >= 2) {
    if (pkg.package && typeof pkg.package === 'object') {
      pkg.package.id = changes.package_id[1];
    }
  }

  if (event === 'flights' && changes.id != null && Array.isArray(pkg.flights)) {
    const flightId = changes.id;
    const idx = pkg.flights.findIndex((f) => f && f.id === flightId);
    if (idx >= 0) {
      const flight = { ...pkg.flights[idx] };
      for (const [key, val] of Object.entries(changes)) {
        if (key === 'id') continue;
        if (Array.isArray(val) && val.length >= 2) {
          flight[key] = val[1];
        }
      }
      pkg.flights[idx] = flight;
    }
  }

  const touristFields = [
    'name',
    'surname',
    'gender',
    'passport_prefix',
    'passport_number',
  ];
  const touristChange = touristFields.some((f) => Array.isArray(changes[f]));
  if (touristChange) {
    pkg._last_tourist_update = {};
    for (const f of touristFields) {
      if (Array.isArray(changes[f])) {
        pkg._last_tourist_update[f] = changes[f];
      }
    }
  }

  return pkg;
}

async function findOrderByLtId(orderId) {
  const [rows] = await db.query('SELECT * FROM orders WHERE order_id = ? LIMIT 1', [
    orderId,
  ]);
  return rows[0] || null;
}

async function updateOrderFromNotify(
  orderId,
  orderRow,
  eventReference,
  event,
  changes,
  message
) {
  const {
    saveAttachmentsForOrder,
    saveAllDocumentsFromOrder,
    mergeLocalAttachments,
    extractDownloadablesFromOrder,
    countOrderDocuments,
  } = require('./orderDocuments');

  let pkg = {};
  try {
    pkg = JSON.parse(orderRow.package || '{}');
  } catch {
    pkg = {};
  }

  let savedDocuments = [];
  let fetchError = null;

  // LT "documents" event includes PDF URLs in changes.attachments — no client auth needed
  if (event === 'documents' || changes?.attachments) {
    const fromCallback = await saveAttachmentsForOrder(
      orderId,
      changes,
      event,
      eventReference
    );
    savedDocuments.push(...fromCallback);

    if (fromCallback.length) {
      pkg = mergeLocalAttachments(pkg, fromCallback);
      logCallback(LOG_NOTIFY, 'DOCS', 'Saved PDFs from callback attachments', {
        order_id: orderId,
        saved: fromCallback.filter((d) => d.public_url && !d.error).length,
        errors: fromCallback.filter((d) => d.error).length,
      });
    }
  }

  pkg = applyChangesToPackage(pkg, changes, event);
  const newState = getNewStateFromChanges(changes) || pkg.state || null;
  if (newState) pkg.state = newState;

  if (typeof message === 'string' && message.trim()) {
    const firstLine = message
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (firstLine) {
      pkg.status_for_client = firstLine;
    }
  } else if (newState === 'canceled' || newState === 'cancelled' || newState === 'annulled') {
    if (!pkg.status_for_client || /подтверж/i.test(String(pkg.status_for_client))) {
      pkg.status_for_client =
        newState === 'annulled' ? 'Заказ аннулирован' : 'Заказ отменён';
    }
  }

  const needDocs = shouldDownloadDocuments(event, changes, pkg);
  const authToken = resolveAuthToken(orderRow);
  const isSingleDocEvent = event === 'documents';
  const existingDocCount = needDocs ? await countOrderDocuments(orderId) : 0;

  // Individual "documents" events already saved their file from the callback;
  // for documents_sent (and other states) always bulk-download so the full set
  // is on disk before the documents email. Duplicates are skipped downstream.
  const downloadDocs = needDocs && !isSingleDocEvent;

  logCallback(LOG_NOTIFY, 'DOCS', 'Download plan', {
    order_id: orderId,
    event,
    need_docs: needDocs,
    download_docs: downloadDocs,
    existing_doc_count: existingDocCount,
  });

  // Fetch GET /client/orders/:id and save full order into orders.package
  if (authToken) {
    try {
      const syncResult = await syncOrderFromClient(orderId, authToken, {
        eventReference,
        downloadDocs,
        event,
        changes,
      });
      return {
        order_state: syncResult.order_state || newState,
        saved_documents: [
          ...savedDocuments,
          ...(syncResult.saved_documents || []),
        ],
        lt_fetched: true,
        package_updated: syncResult.package_updated,
        fetch_error: null,
        attachments_count: syncResult.attachments_count,
      };
    } catch (err) {
      fetchError = err.response?.data || err.message;
      logCallbackError(LOG_NOTIFY, 'SYNC', 'LT client fetch failed — trying package URLs', {
        order_id: orderId,
        error: fetchError,
      });
    }
  }

  if (needDocs) {
    // No auth or LT fetch failed — download from URLs in package / callback
    const savedOk = () =>
      savedDocuments.filter((d) => d.public_url && !d.error).length;

    const inPackage = extractDownloadablesFromOrder(pkg);
    if (inPackage.length && savedOk() === 0) {
      const fromPackage = await saveAllDocumentsFromOrder(
        orderId,
        pkg,
        eventReference
      );
      savedDocuments.push(...fromPackage);
      if (fromPackage.length) {
        pkg = mergeLocalAttachments(pkg, fromPackage);
        logCallback(LOG_NOTIFY, 'DOCS', 'Saved PDFs from package URLs', {
          order_id: orderId,
          saved: fromPackage.filter((d) => d.public_url && !d.error).length,
          errors: fromPackage.filter((d) => d.error).length,
        });
      }
    }

    if (savedOk() === 0 && !authToken) {
      fetchError = 'no_auth_token';
      logCallbackError(
        LOG_NOTIFY,
        'SYNC',
        'Cannot fetch attachments — missing auth_token',
        {
          order_id: orderId,
          event,
          new_state: newState,
          hint: 'Pass auth_token in create-package or set LT_CLIENT_AUTH_TOKEN in .env',
        }
      );
    }
  }

  const { applyLocalDocumentUrlsToPackage, getOrderDocuments } = require('./orderDocuments');
  const documents = await getOrderDocuments(orderId);
  pkg = applyLocalDocumentUrlsToPackage(orderId, pkg, documents);

  await db.query(
    'UPDATE orders SET package = ?, order_state = COALESCE(?, order_state) WHERE order_id = ?',
    [JSON.stringify(pkg), newState, orderId]
  );

  return {
    order_state: newState,
    saved_documents: savedDocuments,
    lt_fetched: false,
    fetch_error: fetchError,
    docs_attempted: needDocs,
  };
}

function isDocumentsSentEvent(changes) {
  const newState = getNewStateFromChanges(changes);
  return newState === 'documents_sent';
}

async function countOrderDocuments(orderId) {
  const { countOrderDocuments: countDocs } = require('./orderDocuments');
  return countDocs(orderId);
}

async function processOrderNotify(body) {
  const {
    order_id: rawOrderId,
    event,
    event_timestamp,
    event_reference,
    message,
    changes,
  } = body;

  const order_id = Number(rawOrderId);

  logCallback(LOG_NOTIFY, 'IN', 'Level Travel notify received', {
    order_id: rawOrderId,
    event,
    event_reference,
    message,
    has_changes: Boolean(changes),
    state_change: changes?.state,
  });

  if (!Number.isFinite(order_id) || !event || !event_timestamp || !event_reference) {
    logCallbackError(LOG_NOTIFY, 'ERROR', 'Invalid payload — missing required fields', body);
    const err = new Error(
      'Missing required fields: order_id, event, event_timestamp, event_reference'
    );
    err.status = 400;
    throw err;
  }

  const isDuplicate = await isDuplicateReference(event_reference);
  const docsSent = isDocumentsSentEvent(changes);
  let retryDocsOnly = false;

  if (isDuplicate) {
    if (!docsSent) {
      logCallback(LOG_NOTIFY, 'SKIP', 'Duplicate event — already processed', {
        order_id,
        event_reference,
      });
      return { success: true, duplicate: true };
    }

    const docCount = await countOrderDocuments(order_id);
    retryDocsOnly = true;
    logCallback(LOG_NOTIFY, 'RETRY', 'Duplicate documents_sent — refresh package only', {
      order_id,
      event_reference,
      existing_docs: docCount,
    });
  }

  const order = await findOrderByLtId(order_id);
  let newState = null;
  let savedDocuments = [];
  let orderUpdateError = null;
  let orderUpdate = null;

  if (order) {
    try {
      orderUpdate = await updateOrderFromNotify(
        order_id,
        order,
        event_reference,
        event,
        changes,
        message
      );
      newState = orderUpdate.order_state;
      savedDocuments = orderUpdate.saved_documents || [];
      logCallback(LOG_NOTIFY, 'DB', 'Order updated', {
        order_id,
        order_state: newState,
        event,
        ...orderUpdate,
      });

      try {
        const { notifyOrderStatusEmail } = require('./orderEmails');
        let orderForEmail = await findOrderByLtId(order_id);

        if (orderForEmail && isDocumentsSentEvent(changes)) {
          const {
            saveAllDocumentsFromOrder,
            mergeLocalAttachments,
            getOrderDocuments,
            applyLocalDocumentUrlsToPackage,
          } = require('./orderDocuments');

          let refreshedPkg = {};
          try {
            refreshedPkg = JSON.parse(orderForEmail.package || '{}');
          } catch {
            refreshedPkg = {};
          }

          const extraSaved = await saveAllDocumentsFromOrder(
            order_id,
            refreshedPkg,
            event_reference
          );
          if (extraSaved.length) {
            savedDocuments = [...savedDocuments, ...extraSaved];
            refreshedPkg = mergeLocalAttachments(refreshedPkg, extraSaved);
            const documents = await getOrderDocuments(order_id);
            refreshedPkg = applyLocalDocumentUrlsToPackage(order_id, refreshedPkg, documents);
            await db.query('UPDATE orders SET package = ? WHERE order_id = ?', [
              JSON.stringify(refreshedPkg),
              order_id,
            ]);
            orderForEmail = await findOrderByLtId(order_id);
          }
        }

        if (orderForEmail) {
          await notifyOrderStatusEmail(order_id, orderForEmail, {
            newState,
            event,
            message,
            savedDocuments,
            eventReference: event_reference,
          });
        }
      } catch (emailErr) {
        logCallbackError(LOG_NOTIFY, 'EMAIL', 'Order status email failed', {
          order_id,
          error: emailErr.message,
        });
      }
    } catch (err) {
      orderUpdateError = err.message;
      logCallbackError(LOG_NOTIFY, 'DB', 'Order update failed — will still save event', {
        order_id,
        error: err.message,
      });
    }
  } else {
    logCallback(LOG_NOTIFY, 'DB', 'Order NOT found — saving event only', { order_id });
  }

  let eventLogId = null;
  if (!retryDocsOnly) {
    try {
      eventLogId = await logEvent({
        order_id,
        reference: event_reference,
        reference_type: 'event',
        event,
        event_timestamp,
        message,
        changes,
        payload: body,
      });
      logCallback(LOG_NOTIFY, 'SAVED', 'Event saved to lt_order_events', {
        id: eventLogId,
        order_id,
        event,
        event_reference,
      });
    } catch (err) {
      logCallbackError(LOG_NOTIFY, 'ERROR', 'FAILED to save lt_order_events', {
        order_id,
        event_reference,
        error: err.message,
      });
      const dbErr = new Error(`Failed to save callback: ${err.message}`);
      dbErr.status = 500;
      throw dbErr;
    }
  }

  const result = {
    success: true,
    duplicate: isDuplicate,
    docs_retry: retryDocsOnly,
    order_found: Boolean(order),
    order_state: newState,
    saved_documents: savedDocuments,
    order_update: orderUpdate,
    event_log_id: eventLogId,
    order_update_error: orderUpdateError,
  };
  logCallbackBanner(LOG_NOTIFY, '✅ LT NOTIFY PROCESSED', {
    success: result.success,
    order_id,
    event,
    order_state: result.order_state,
    duplicate: result.duplicate,
    order_found: result.order_found,
    event_log_id: result.event_log_id,
  });
  logCallback(LOG_NOTIFY, 'OUT', 'Notify processed', result);
  return result;
}

async function processOrderRefund(body) {
  const { order_id: rawOrderId, timestamp, request_reference, amount } = body;
  const order_id = Number(rawOrderId);

  logCallback(LOG_REFUND, 'IN', 'Level Travel refund received', {
    order_id: rawOrderId,
    request_reference,
    amount,
    timestamp,
  });

  if (!Number.isFinite(order_id) || !timestamp || !request_reference || amount == null) {
    logCallbackError(LOG_REFUND, 'ERROR', 'Invalid payload — missing required fields', body);
    const err = new Error(
      'Missing required fields: order_id, timestamp, request_reference, amount'
    );
    err.status = 400;
    throw err;
  }

  if (await isDuplicateReference(request_reference)) {
    logCallback(LOG_REFUND, 'SKIP', 'Duplicate refund — already processed', {
      order_id,
      request_reference,
    });
    return { success: true, duplicate: true };
  }

  const order = await findOrderByLtId(order_id);

  if (order) {
    await db.query(
      `UPDATE orders SET refund_amount = ?, refund_at = FROM_UNIXTIME(?) WHERE order_id = ?`,
      [amount, timestamp, order_id]
    );
    logCallback(LOG_REFUND, 'DB', 'Order refund updated', { order_id, refund_amount: amount });
  } else {
    logCallback(LOG_REFUND, 'DB', 'Order NOT found — refund logged only', { order_id });
  }

  let eventLogId = null;
  try {
    eventLogId = await logEvent({
      order_id,
      reference: request_reference,
      reference_type: 'refund',
      event: 'order_refund',
      event_timestamp: timestamp,
      message: `Refund amount: ${amount}`,
      changes: { amount },
      payload: body,
    });
    logCallback(LOG_REFUND, 'SAVED', 'Refund saved to lt_order_events', {
      id: eventLogId,
      order_id,
      request_reference,
    });
  } catch (err) {
    logCallbackError(LOG_REFUND, 'ERROR', 'FAILED to save lt_order_events', {
      order_id,
      request_reference,
      error: err.message,
    });
    const dbErr = new Error(`Failed to save refund callback: ${err.message}`);
    dbErr.status = 500;
    throw dbErr;
  }

  const result = {
    success: true,
    order_found: Boolean(order),
    refund_amount: amount,
    event_log_id: eventLogId,
  };
  logCallbackBanner(LOG_REFUND, '✅ LT REFUND PROCESSED', {
    success: result.success,
    order_id,
    amount: result.refund_amount ?? amount,
    duplicate: result.duplicate,
    order_found: result.order_found,
    event_log_id: result.event_log_id,
  });
  logCallback(LOG_REFUND, 'OUT', 'Refund processed', result);
  return result;
}

module.exports = {
  verifyPartnerApiKey,
  logLtRequest,
  processOrderNotify,
  processOrderRefund,
};
