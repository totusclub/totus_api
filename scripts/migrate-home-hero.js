/**
 * Create `home_hero` table for the hero block on the home page.
 * Run from kedam_API folder:  node scripts/migrate-home-hero.js
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
    const table = 'home_hero';

    if (!(await tableExists(table))) {
        await db.query(`
            CREATE TABLE home_hero (
              id TINYINT NOT NULL PRIMARY KEY,
              title VARCHAR(255) NOT NULL DEFAULT 'Путешествия начинаются здесь',
              image VARCHAR(500) NOT NULL DEFAULT '',
              updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        console.log('Created table `home_hero`.');
    } else {
        console.log('Table `home_hero` already exists — skip create.');
    }

    const [rows] = await db.query('SELECT id FROM home_hero WHERE id = 1 LIMIT 1');
    if (rows.length === 0) {
        await db.query(
            'INSERT INTO home_hero (id, title, image) VALUES (1, ?, ?)',
            ['Путешествия начинаются здесь', ''],
        );
        console.log('  seeded default hero row');
    } else {
        console.log('  skip hero row (already exists)');
    }

    console.log('Done.');
    process.exit(0);
}

migrate().catch((err) => {
    console.error('Migration failed:', err.message);
    process.exit(1);
});
