/**
 * Add lt_auth_token column to orders for Level Travel client API.
 * Run: node scripts/run-lt-auth-token-migration.js
 */
require('dotenv').config();
const db = require('../db');

async function columnExists(table, column) {
  const [rows] = await db.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  return rows[0].cnt > 0;
}

async function run() {
  if (await columnExists('orders', 'lt_auth_token')) {
    console.log('orders.lt_auth_token already exists');
    process.exit(0);
    return;
  }

  await db.query(`
    ALTER TABLE orders
    ADD COLUMN lt_auth_token VARCHAR(255) NULL AFTER user_id,
    ADD KEY idx_orders_lt_auth_token (lt_auth_token)
  `);

  console.log('Added orders.lt_auth_token');
  process.exit(0);
}

run().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
