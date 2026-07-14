/**
 * Create or upgrade `callback_requests` table for home page "Перезвоните мне" form.
 * Run from kedam_API folder:  node scripts/migrate-callback-requests.js
 */
require('dotenv').config();
const db = require('../db');

async function tableExists(table) {
    const [rows] = await db.query(
        `SELECT 1 FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
         LIMIT 1`,
        [table],
    );
    return rows.length > 0;
}

async function columnExists(table, column) {
    const [rows] = await db.query(
        `SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?
         LIMIT 1`,
        [table, column],
    );
    return rows.length > 0;
}

async function indexExists(table, indexName) {
    const [rows] = await db.query(
        `SELECT 1 FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?
         LIMIT 1`,
        [table, indexName],
    );
    return rows.length > 0;
}

async function migrate() {
    const table = 'callback_requests';

    if (!(await tableExists(table))) {
        await db.query(`
            CREATE TABLE callback_requests (
              id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
              phone VARCHAR(20) NOT NULL,
              created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
              INDEX idx_callback_requests_created_at (created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        console.log('Created table `callback_requests`.');
        process.exit(0);
    }

    console.log('Table `callback_requests` exists — removing legacy status columns...');

    if (await indexExists(table, 'idx_callback_requests_status')) {
        await db.query('ALTER TABLE callback_requests DROP INDEX idx_callback_requests_status');
        console.log('  dropped index idx_callback_requests_status');
    }

    if (await columnExists(table, 'processed_at')) {
        await db.query('ALTER TABLE callback_requests DROP COLUMN processed_at');
        console.log('  dropped column processed_at');
    }

    if (await columnExists(table, 'status')) {
        await db.query('ALTER TABLE callback_requests DROP COLUMN status');
        console.log('  dropped column status');
    }

    if (!(await indexExists(table, 'idx_callback_requests_created_at'))) {
        await db.query('ALTER TABLE callback_requests ADD INDEX idx_callback_requests_created_at (created_at)');
        console.log('  added index idx_callback_requests_created_at');
    }

    console.log('Done.');
    process.exit(0);
}

migrate().catch((err) => {
    console.error('Migration failed:', err.message);
    process.exit(1);
});
