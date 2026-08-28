/**
 * Create order_requests table for user order change requests (cancel / message).
 * Run: node scripts/run-order-requests-migration.js
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
  if (await tableExists('order_requests')) {
    console.log('order_requests already exists');
    process.exit(0);
    return;
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS order_requests (
      id INT AUTO_INCREMENT PRIMARY KEY,
      order_id VARCHAR(64) NOT NULL,
      user_id INT NOT NULL,
      type ENUM('cancel','message') NOT NULL,
      message TEXT NULL,
      status ENUM('new','in_progress','done','rejected') NOT NULL DEFAULT 'new',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_order (order_id),
      INDEX idx_status (status),
      INDEX idx_user (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  console.log('Created order_requests');
  process.exit(0);
}

run().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
