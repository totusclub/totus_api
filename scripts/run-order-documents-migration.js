/**
 * Create order_documents table for saved Level Travel PDFs.
 * Run: node scripts/run-order-documents-migration.js
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
  if (await tableExists('order_documents')) {
    console.log('order_documents already exists');
    process.exit(0);
    return;
  }

  await db.query(`
    CREATE TABLE order_documents (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      order_id INT NOT NULL,
      title VARCHAR(512) NULL,
      source_url TEXT NOT NULL,
      file_path VARCHAR(512) NOT NULL,
      public_url VARCHAR(512) NOT NULL,
      event_reference CHAR(36) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_order_documents_order_id (order_id),
      KEY idx_order_documents_created_at (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  console.log('Created order_documents');
  process.exit(0);
}

run().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
