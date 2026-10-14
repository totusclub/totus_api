/**
 * Таблица partner_requests — заявки «Стать партнёром» со страницы /partners.
 * API создаёт её само при первом обращении; скрипт — чтобы создать заранее.
 * Run: node scripts/run-partner-requests-migration.js
 */
require('dotenv').config();
const db = require('../db');
const { CREATE_TABLE_SQL } = require('../controllers/partnerRequests.controller');

async function run() {
  await db.query(CREATE_TABLE_SQL);
  console.log('partner_requests is ready');
  process.exit(0);
}

run().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
