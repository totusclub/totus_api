/**
 * Create `home_banners` table for the two hero-bottom banners on the home page.
 * Seeds two fixed slots (position 1 and 2).
 * Adds `image_dark` (картинка баннера для тёмной темы сайта), если колонки ещё нет.
 * Повторный запуск безопасен: существующие данные не меняются.
 * Run from kedam_API folder:  node scripts/migrate-home-banners.js
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

async function migrate() {
    const table = 'home_banners';

    if (!(await tableExists(table))) {
        await db.query(`
            CREATE TABLE home_banners (
              id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
              position TINYINT NOT NULL,
              image VARCHAR(500) NOT NULL DEFAULT '',
              image_dark VARCHAR(500) NOT NULL DEFAULT '',
              url VARCHAR(1000) NOT NULL DEFAULT '',
              updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
              UNIQUE KEY uq_home_banners_position (position)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        console.log('Created table `home_banners`.');
    } else {
        console.log('Table `home_banners` already exists — skip create.');
    }

    if (!(await columnExists(table, 'image_dark'))) {
        await db.query("ALTER TABLE home_banners ADD COLUMN image_dark VARCHAR(500) NOT NULL DEFAULT '' AFTER image");
        console.log('Added column `image_dark` (картинка для тёмной темы).');
    } else {
        console.log('Column `image_dark` already exists — skip.');
    }

    for (const position of [1, 2]) {
        const [rows] = await db.query('SELECT id FROM home_banners WHERE position = ? LIMIT 1', [position]);
        if (rows.length === 0) {
            await db.query('INSERT INTO home_banners (position, image, url) VALUES (?, "", "")', [position]);
            console.log(`  seeded banner slot ${position}`);
        } else {
            console.log(`  skip slot ${position} (already exists)`);
        }
    }

    console.log('Done.');
    process.exit(0);
}

migrate().catch((err) => {
    console.error('Migration failed:', err.message);
    process.exit(1);
});
