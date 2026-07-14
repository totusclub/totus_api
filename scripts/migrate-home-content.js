/**
 * Create home content tables for recommended hotels and popular destinations.
 * Run from kedam_API folder:  node scripts/migrate-home-content.js
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
    if (!(await tableExists('home_sections'))) {
        await db.query(`
            CREATE TABLE home_sections (
              id TINYINT NOT NULL PRIMARY KEY,
              recommended_title VARCHAR(255) NOT NULL DEFAULT 'Начните планирование путешествия здесь',
              destinations_title VARCHAR(255) NOT NULL DEFAULT 'Популярные направления',
              updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        console.log('Created table `home_sections`.');
    }

    if (!(await tableExists('home_recommended_hotels'))) {
        await db.query(`
            CREATE TABLE home_recommended_hotels (
              id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
              hotel_id BIGINT NOT NULL,
              name VARCHAR(255) NOT NULL,
              rate TINYINT NOT NULL DEFAULT 5,
              city VARCHAR(255) NOT NULL DEFAULT '',
              price INT NOT NULL DEFAULT 0,
              review INT NOT NULL DEFAULT 0,
              image VARCHAR(500) NOT NULL DEFAULT '',
              sort_order INT NOT NULL DEFAULT 0,
              created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
              updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
              INDEX idx_home_recommended_hotels_sort (sort_order)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        console.log('Created table `home_recommended_hotels`.');
    }

    if (!(await tableExists('home_popular_destinations'))) {
        await db.query(`
            CREATE TABLE home_popular_destinations (
              id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
              name VARCHAR(255) NOT NULL,
              image VARCHAR(500) NOT NULL DEFAULT '',
              to_country VARCHAR(10) NOT NULL DEFAULT '',
              sort_order INT NOT NULL DEFAULT 0,
              created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
              updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
              INDEX idx_home_popular_destinations_sort (sort_order)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        console.log('Created table `home_popular_destinations`.');
    }

    const [sections] = await db.query('SELECT id FROM home_sections WHERE id = 1 LIMIT 1');
    if (sections.length === 0) {
        await db.query('INSERT INTO home_sections (id) VALUES (1)');
        console.log('  seeded home_sections row');
    }

    console.log('Done.');
    process.exit(0);
}

migrate().catch((err) => {
    console.error('Migration failed:', err.message);
    process.exit(1);
});
