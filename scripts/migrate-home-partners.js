/**
 * Create `home_partners` table for partner logos on the home page.
 * Run from kedam_API folder:  node scripts/migrate-home-partners.js
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
    const table = 'home_partners';

    if (await tableExists(table)) {
        console.log('Table `home_partners` already exists — skip.');
        process.exit(0);
    }

    await db.query(`
        CREATE TABLE home_partners (
          id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(255) NOT NULL DEFAULT '',
          image VARCHAR(500) NOT NULL DEFAULT '',
          url VARCHAR(1000) NOT NULL DEFAULT '',
          sort_order INT NOT NULL DEFAULT 0,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_home_partners_sort_order (sort_order)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('Created table `home_partners`.');
    process.exit(0);
}

migrate().catch((err) => {
    console.error('Migration failed:', err.message);
    process.exit(1);
});
