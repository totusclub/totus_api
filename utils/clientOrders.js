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

async function getOrderHistory(orderId) {
  const [rows] = await db.query(
    `SELECT id, reference, reference_type, event, event_timestamp, message, changes, created_at
     FROM lt_order_events
     WHERE order_id = ?
     ORDER BY created_at ASC`,
    [orderId]
  );

  return rows.map((row) => ({
    id: row.id,
    reference: row.reference,
    type: row.reference_type,
    event: row.event,
    event_timestamp: row.event_timestamp,
    message: row.message,
    changes: parseJson(row.changes),
    created_at: row.created_at,
  }));
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

module.exports = { getOrderHistory, getAllLtCallbackHistory };
