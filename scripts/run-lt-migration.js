/**
 * One-time migration for Level Travel webhook tables/columns.
 * Run: node scripts/run-lt-migration.js
 */
require('dotenv').config();
const db = require('../db');

const statements = [
  `ALTER TABLE orders ADD COLUMN order_state VARCHAR(64) NULL AFTER pay_status`,
  `ALTER TABLE orders ADD COLUMN refund_amount INT NULL AFTER order_state`,
  `ALTER TABLE orders ADD COLUMN refund_at DATETIME NULL AFTER refund_amount`,
  `CREATE TABLE IF NOT EXISTS lt_order_events (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    order_id INT NOT NULL,
    reference CHAR(36) NOT NULL,
    reference_type ENUM('event', 'refund') NOT NULL DEFAULT 'event',
    event VARCHAR(64) NULL,
    event_timestamp BIGINT NULL,
    message TEXT NULL,
    changes JSON NULL,
    payload JSON NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_lt_reference (reference),
    KEY idx_lt_order_id (order_id),
    KEY idx_lt_created_at (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

async function columnExists(table, column) {
  const [rows] = await db.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  return rows[0].cnt > 0;
}

async function tableExists(table) {
  const [rows] = await db.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [table]
  );
  return rows[0].cnt > 0;
}

async function run() {
  if (!(await columnExists('orders', 'order_state'))) {
    await db.query(statements[0]);
    console.log('Added orders.order_state');
  } else {
    console.log('orders.order_state already exists');
  }

  if (!(await columnExists('orders', 'refund_amount'))) {
    await db.query(statements[1]);
    console.log('Added orders.refund_amount');
  } else {
    console.log('orders.refund_amount already exists');
  }

  if (!(await columnExists('orders', 'refund_at'))) {
    await db.query(statements[2]);
    console.log('Added orders.refund_at');
  } else {
    console.log('orders.refund_at already exists');
  }

  if (!(await tableExists('lt_order_events'))) {
    await db.query(statements[3]);
    console.log('Created lt_order_events');
  } else {
    console.log('lt_order_events already exists');
  }

  console.log('Migration complete.');
  process.exit(0);
}

run().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
