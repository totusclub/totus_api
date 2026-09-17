// Миграция входа через Яндекс ID: node scripts/run-yandex-auth-migration.js
// (или npm run migrate:yandex-auth). Идемпотентно: таблица user_identities и
// колонка users.avatar_url создаются только если их ещё нет.
// После неё: pm2 restart api. План: claude/YANDEX_AUTH_PLAN_RU.md.
'use strict';

const db = require('../db');

const DDL = [
  `CREATE TABLE IF NOT EXISTS user_identities (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    provider VARCHAR(16) NOT NULL,
    provider_uid VARCHAR(64) NOT NULL,
    email VARCHAR(255) NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL,
    UNIQUE KEY uniq_provider_uid (provider, provider_uid),
    KEY idx_user (user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

async function run() {
  for (const sql of DDL) {
    const name = /TABLE IF NOT EXISTS (\w+)/.exec(sql)[1];
    await db.query(sql);
    console.log(`✅ ${name}`);
  }

  const [avatar] = await db.query("SHOW COLUMNS FROM users LIKE 'avatar_url'");
  if (!avatar.length) {
    await db.query('ALTER TABLE users ADD COLUMN avatar_url VARCHAR(255) NULL');
    console.log('✅ users.avatar_url');
  } else {
    console.log('= users.avatar_url уже есть');
  }

  console.log('Done. Now: pm2 restart api');
  await db.end();
}

run().catch((e) => { console.error('❌ migration failed:', e.message); process.exit(1); });
