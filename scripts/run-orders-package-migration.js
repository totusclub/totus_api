/**
 * Expand orders.package from TEXT to LONGTEXT.
 * Run: node scripts/run-orders-package-migration.js
 */
require('dotenv').config();
const db = require('../db');

async function run() {
  const [cols] = await db.query(
    `SELECT COLUMN_TYPE FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'package'`
  );
  const type = (cols[0]?.COLUMN_TYPE || '').toLowerCase();
  if (type === 'longtext') {
    console.log('orders.package is already LONGTEXT');
    process.exit(0);
    return;
  }
  await db.query('ALTER TABLE orders MODIFY COLUMN package LONGTEXT NULL');
  console.log(`orders.package migrated: ${type || 'unknown'} -> LONGTEXT`);
  process.exit(0);
}

run().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
