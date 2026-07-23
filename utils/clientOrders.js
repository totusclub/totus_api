const db = require('../db');

function parseJson(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function mapLtEventRow(row) {
  const changes = parseJson(row.changes);
  const state =
    Array.isArray(changes?.state) && changes.state.length >= 2
      ? changes.state[1]
      : null;

  let status = null;
  if (row.message) {
    const firstLine = String(row.message)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (firstLine) status = firstLine;
  }
  if (!status && state) status = String(state);
  if (!status && row.event) status = String(row.event);

  return {
    id: row.id,
    order_id: row.order_id != null ? Number(row.order_id) : undefined,
    reference: row.reference,
    type: row.reference_type,
    event: row.event,
    event_timestamp: row.event_timestamp,
    message: row.message,
    changes,
    state,
    status,
    created_at: row.created_at,
  };
}

async function getOrderHistory(orderId) {
  const [rows] = await db.query(
    `SELECT id, order_id, reference, reference_type, event, event_timestamp, message, changes, created_at
     FROM lt_order_events
     WHERE order_id = ?
     ORDER BY created_at ASC`,
    [orderId]
  );

  return rows.map(mapLtEventRow);
}

async function getLatestLtEvent(orderId) {
  const id = Number(orderId);
  if (!Number.isFinite(id)) return null;

  const [rows] = await db.query(
    `SELECT id, order_id, reference, reference_type, event, event_timestamp, message, changes, created_at
     FROM lt_order_events
     WHERE order_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [id]
  );

  return rows[0] ? mapLtEventRow(rows[0]) : null;
}

async function getLatestLtEventsByOrderIds(orderIds) {
  const ids = [...new Set(
    (orderIds || [])
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id))
  )];

  const byOrderId = new Map();
  if (ids.length === 0) return byOrderId;

  const [rows] = await db.query(
    `SELECT e.id, e.order_id, e.reference, e.reference_type, e.event,
            e.event_timestamp, e.message, e.changes, e.created_at
     FROM lt_order_events e
     INNER JOIN (
       SELECT order_id, MAX(id) AS max_id
       FROM lt_order_events
       WHERE order_id IN (?)
       GROUP BY order_id
     ) latest ON latest.max_id = e.id`,
    [ids]
  );

  for (const row of rows) {
    byOrderId.set(Number(row.order_id), mapLtEventRow(row));
  }

  return byOrderId;
}

async function getAllLtCallbackHistory({ order_id, limit = 100, offset = 0 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const safeOffset = Math.max(Number(offset) || 0, 0);

  let sql = `
    SELECT id, order_id, reference, reference_type, event, event_timestamp,
           message, changes, payload, created_at
    FROM lt_order_events
  `;
  const params = [];

  if (order_id != null && Number.isFinite(Number(order_id))) {
    sql += ' WHERE order_id = ?';
    params.push(Number(order_id));
  }

  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(safeLimit, safeOffset);

  const [rows] = await db.query(sql, params);

  let countSql = 'SELECT COUNT(*) AS total FROM lt_order_events';
  const countParams = [];
  if (order_id != null && Number.isFinite(Number(order_id))) {
    countSql += ' WHERE order_id = ?';
    countParams.push(Number(order_id));
  }
  const [[{ total }]] = await db.query(countSql, countParams);

  return {
    total,
    limit: safeLimit,
    offset: safeOffset,
    events: rows.map((row) => ({
      id: row.id,
      order_id: row.order_id,
      reference: row.reference,
      type: row.reference_type,
      event: row.event,
      event_timestamp: row.event_timestamp,
      message: row.message,
      changes: parseJson(row.changes),
      payload: parseJson(row.payload),
      created_at: row.created_at,
    })),
  };
}

module.exports = {
  getOrderHistory,
  getLatestLtEvent,
  getLatestLtEventsByOrderIds,
  getAllLtCallbackHistory,
};
