/**
 * Таблица consent_log — журнал согласий (кто, когда, форма, редакция документа, IP).
 * API создаёт её само при первой записи; скрипт — чтобы создать заранее.
 * Run: npm run migrate:consents
 */
require('dotenv').config();
const db = require('../db');
const { CREATE_TABLE_SQL } = require('../lib/consents');

async function run() {
  await db.query(CREATE_TABLE_SQL);
  console.log('consent_log is ready');
  process.exit(0);
}

run().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
