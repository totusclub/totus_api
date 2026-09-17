// Диагностика входа через Яндекс ID на сервере: node scripts/check-yandex-env.js
// (или npm run check:yandex-env). Показывает, что видит процесс: какие переменные
// заполнены (без самих значений — секреты не печатаем) и есть ли таблица user_identities.
// Запускать из каталога API — оттуда же, откуда pm2 запускает app.js.
'use strict';

const fs = require('fs');
const path = require('path');

require('dotenv').config();
require('dotenv').config({ path: '.env.local', override: true });

const db = require('../db');
const yandex = require('../lib/yandexAuth');

function mark(ok) {
    return ok ? '✅' : '❌';
}

async function run() {
    console.log('cwd:', process.cwd());
    for (const file of ['.env', '.env.local']) {
        const full = path.join(process.cwd(), file);
        console.log(`${mark(fs.existsSync(full))} ${file} ${fs.existsSync(full) ? 'найден' : 'нет'}`);
    }

    console.log('\nПеременные окружения (значения не печатаются):');
    const status = yandex.configStatus();
    for (const [name, ok] of Object.entries(status)) {
        const len = String(process.env[name] || '').trim().length;
        console.log(`  ${mark(ok)} ${name}${ok ? ` (длина ${len})` : ''}`);
    }

    const cfg = yandex.config();
    console.log('  redirect_uri:', cfg.redirectUri || '(не задан)');
    console.log('  return web / app / desktop:', cfg.returnWeb, '/', cfg.returnApp, '/', cfg.returnDesktop);

    console.log('\nБаза данных:');
    try {
        const [dbRows] = await db.query('SELECT DATABASE() AS db');
        console.log('  база:', dbRows[0] && dbRows[0].db);
        const [tables] = await db.query("SHOW TABLES LIKE 'user_identities'");
        console.log(`  ${mark(tables.length > 0)} таблица user_identities`);
        const [columns] = await db.query("SHOW COLUMNS FROM users LIKE 'avatar_url'");
        console.log(`  ${mark(columns.length > 0)} колонка users.avatar_url`);
        if (!tables.length) console.log('  → нужно: npm run migrate:yandex-auth, затем pm2 restart api');
    } catch (err) {
        console.log('  ❌ БД недоступна:', err.message);
    }

    const missing = yandex.missingConfig();
    console.log('\nИтог:', missing.length ? `не заполнено — ${missing.join(', ')}` : 'переменных хватает');
    await db.end();
}

run().catch((e) => { console.error('❌ check failed:', e.message); process.exit(1); });
