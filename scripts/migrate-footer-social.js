/**
 * Create `footer_social_links` table.
 * Run: node scripts/migrate-footer-social.js
 */
require('dotenv').config();
require('dotenv').config({ path: '.env.local', override: true });
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

async function migrate() {
    const table = 'footer_social_links';

    if (await tableExists(table)) {
        console.log('Table `footer_social_links` already exists — skip.');
        process.exit(0);
    }

    await db.query(`
        CREATE TABLE footer_social_links (
          id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
          title VARCHAR(255) NOT NULL DEFAULT '',
          icon VARCHAR(64) NOT NULL DEFAULT '',
          url VARCHAR(1000) NOT NULL DEFAULT '',
          sort_order INT NOT NULL DEFAULT 0,
          is_active TINYINT(1) NOT NULL DEFAULT 1,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_footer_social_sort_order (sort_order)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('Created table `footer_social_links`.');
    process.exit(0);
}

migrate().catch((err) => {
    console.error('Migration failed:', err.message);
    process.exit(1);
});
