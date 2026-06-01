const db = require('../db');

const PARTNER_API_KEY =
  process.env.PARTNER_API_KEY || '589e52d73074435f9fc8202b7ec80673';

function verifyPartnerApiKey(req, res, next) {
  const key = req.headers['partner-api-key'];
  if (!key || key !== PARTNER_API_KEY) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  next();
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
  await db.query(
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

  if (!Number.isFinite(order_id) || !event || !event_timestamp || !event_reference) {
    const err = new Error(
      'Missing required fields: order_id, event, event_timestamp, event_reference'
    );
    err.status = 400;
    throw err;
  }

  if (await isDuplicateReference(event_reference)) {
    return { success: true, duplicate: true };
  }

  const order = await findOrderByLtId(order_id);
  let newState = null;

  if (order) {
    let pkg = {};
    try {
      pkg = JSON.parse(order.package || '{}');
    } catch {
      pkg = {};
    }

    pkg = applyChangesToPackage(pkg, changes, event);

    if (Array.isArray(changes?.state) && changes.state.length >= 2) {
      newState = changes.state[1];
    } else if (pkg.state) {
      newState = pkg.state;
    }

    await db.query(
      'UPDATE orders SET package = ?, order_state = COALESCE(?, order_state) WHERE order_id = ?',
      [JSON.stringify(pkg), newState, order_id]
    );
  }

  await logEvent({
    order_id,
    reference: event_reference,
    reference_type: 'event',
    event,
    event_timestamp,
    message,
    changes,
    payload: body,
  });

  return {
    success: true,
    order_found: Boolean(order),
    order_state: newState,
  };
}

async function processOrderRefund(body) {
  const { order_id: rawOrderId, timestamp, request_reference, amount } = body;
  const order_id = Number(rawOrderId);

  if (!Number.isFinite(order_id) || !timestamp || !request_reference || amount == null) {
    const err = new Error(
      'Missing required fields: order_id, timestamp, request_reference, amount'
    );
    err.status = 400;
    throw err;
  }

  if (await isDuplicateReference(request_reference)) {
    return { success: true, duplicate: true };
  }

  const order = await findOrderByLtId(order_id);

  if (order) {
    await db.query(
      `UPDATE orders SET refund_amount = ?, refund_at = FROM_UNIXTIME(?) WHERE order_id = ?`,
      [amount, timestamp, order_id]
    );
  }

  await logEvent({
    order_id,
    reference: request_reference,
    reference_type: 'refund',
    event: 'order_refund',
    event_timestamp: timestamp,
    message: `Refund amount: ${amount}`,
    changes: { amount },
    payload: body,
  });

  return {
    success: true,
    order_found: Boolean(order),
    refund_amount: amount,
  };
}

module.exports = {
  verifyPartnerApiKey,
  processOrderNotify,
  processOrderRefund,
};
