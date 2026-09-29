/**
 * Создаёт таблицу `home_hero_images` (все изображения hero-блока главной)
 * и переносит в неё изображение из старой схемы (`home_hero.image`).
 *
 * Запускать не обязательно: API делает то же самое при первом обращении к hero.
 * Скрипт нужен, чтобы подготовить базу заранее.
 *
 * Run from totus_API folder:  node scripts/migrate-home-hero-images.js
 */
require('dotenv').config();
require('dotenv').config({ path: '.env.local', override: true });
const db = require('../db');
const { ensureImagesTable } = require('../controllers/homeHero.controller');

async function migrate() {
    await ensureImagesTable();
    const [rows] = await db.query('SELECT COUNT(*) AS n FROM home_hero_images');
    console.log(`Table \`home_hero_images\` ready, images: ${rows[0].n}.`);
    console.log('Done.');
    process.exit(0);
}

migrate().catch((err) => {
    console.error('Migration failed:', err.message);
    process.exit(1);
});
