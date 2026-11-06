'use strict';
/**
 * Миграция (C5 аудита): срок жизни кода входа и счётчик попыток.
 *   users.code_expires_at DATETIME NULL        — после этого момента код не принимается
 *   users.code_attempts   INT NOT NULL DEFAULT 0 — неверных попыток с момента выдачи кода
 * Без этих колонок контроллер работает как раньше (проверка только по совпадению кода).
 * Идемпотентна: существующие колонки не трогает, данные не меняет. Запуск: node scripts/migrate-login-code-security.js
 */
require('dotenv').config();
require('dotenv').config({ path: '.env.local', override: true });
const db = require('../db');

async function columnExists(table, column) {
    const [rows] = await db.query(
        `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
        [table, column],
    );
    return rows.length > 0;
}

(async () => {
    try {
        if (!(await columnExists('users', 'code_expires_at'))) {
            await db.query('ALTER TABLE users ADD COLUMN code_expires_at DATETIME NULL AFTER code');
            console.log('users.code_expires_at: добавлена');
        } else console.log('users.code_expires_at: уже есть');
        if (!(await columnExists('users', 'code_attempts'))) {
            await db.query('ALTER TABLE users ADD COLUMN code_attempts INT NOT NULL DEFAULT 0 AFTER code_expires_at');
            console.log('users.code_attempts: добавлена');
        } else console.log('users.code_attempts: уже есть');
        console.log('Готово. Перезапустите api (pm2 restart api), чтобы контроллер увидел колонки.');
        process.exit(0);
    } catch (e) {
        console.error('Миграция не выполнена:', e.message);
        process.exit(1);
    }
})();
