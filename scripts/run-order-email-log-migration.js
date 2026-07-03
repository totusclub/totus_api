/**
 * Create order_email_log table used as an atomic dedup lock for order emails.
 * The unique key (order_id, email_type) guarantees each email type is sent
 * at most once per order, even under concurrent Level Travel callbacks.
 * Run: node scripts/run-order-email-log-migration.js
 */
require('dotenv').config();
const db = require('../db');

async function tableExists(table) {
  const [rows] = await db.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [table]
  );
  return rows[0].cnt > 0;
}

async function run() {
  if (await tableExists('order_email_log')) {
    console.log('order_email_log already exists');
    process.exit(0);
    return;
  }

  await db.query(`
    CREATE TABLE order_email_log (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      order_id INT NOT NULL,
      email_type VARCHAR(64) NOT NULL,
      recipient VARCHAR(255) NULL,
      message_id VARCHAR(255) NULL,
      claimed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      sent_at DATETIME NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_order_email_type (order_id, email_type),
      KEY idx_order_email_log_order_id (order_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  console.log('Created order_email_log');
  process.exit(0);
}

run().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
