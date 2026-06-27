/**
 * Safe upgrade for existing `pages` table.
 * Run from kedam_API folder:  node scripts/migrate-pages.js
 */
require('dotenv').config();
const db = require('../db');

const COLUMNS = [
    ['seo_keywords', "VARCHAR(500) NOT NULL DEFAULT ''"],
    ['section', "VARCHAR(50) NOT NULL DEFAULT 'company'"],
    ['breadcrumb_label', "VARCHAR(255) NOT NULL DEFAULT ''"],
    ['mobile_header_title', "VARCHAR(255) NOT NULL DEFAULT ''"],
    ['created_at', 'TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP'],
    ['updated_at', 'TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'],
];

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
    const table = 'pages';

    if (!(await tableExists(table))) {
        console.log('Table `pages` not found — creating fresh table...');
        await db.query(`
            CREATE TABLE pages (
              id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
              name VARCHAR(255) NOT NULL,
              slug VARCHAR(255) NOT NULL,
              seo_title VARCHAR(255) DEFAULT '',
              seo_desc TEXT,
              seo_keywords VARCHAR(500) DEFAULT '',
              section VARCHAR(50) DEFAULT 'company',
              breadcrumb_label VARCHAR(255) DEFAULT '',
              mobile_header_title VARCHAR(255) DEFAULT '',
              content LONGTEXT,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
              UNIQUE KEY uq_pages_slug (slug)
            )
        `);
        console.log('Created table `pages`.');
        process.exit(0);
    }

    console.log('Table `pages` exists — adding missing columns...');

    for (const [name, definition] of COLUMNS) {
        if (await columnExists(table, name)) {
            console.log(`  skip  ${name} (already exists)`);
            continue;
        }
        await db.query(`ALTER TABLE pages ADD COLUMN ${name} ${definition}`);
        console.log(`  added ${name}`);
    }

    if (!(await indexExists(table, 'uq_pages_slug'))) {
        try {
            await db.query('ALTER TABLE pages ADD UNIQUE KEY uq_pages_slug (slug)');
            console.log('  added unique index uq_pages_slug');
        } catch (err) {
            console.warn('  could not add unique index on slug:', err.message);
            console.warn('  (duplicate slugs in table — clean data first)');
        }
    } else {
        console.log('  skip  uq_pages_slug (already exists)');
    }

    console.log('Done.');
    process.exit(0);
}

migrate().catch((err) => {
    console.error('Migration failed:', err.message);
    process.exit(1);
});
