// Миграция наших Room Type: node scripts/run-custom-rooms-migration.js
// Таблицы custom_room_* + 4 колонки в orders (идемпотентно). После неё: pm2 restart api.
// План: claude/CUSTOM_ROOMS_PLAN_RU.md §4.
'use strict';

const db = require('../db');

const DDL = [
  `CREATE TABLE IF NOT EXISTS custom_room_types (
    id INT AUTO_INCREMENT PRIMARY KEY,
    hotel_id INT NOT NULL,
    hotel_name VARCHAR(255) NULL,
    hotel_stars TINYINT NULL,
    hotel_city VARCHAR(128) NULL,
    source_room_id INT NOT NULL,
    source_room_name VARCHAR(255) NULL,
    source_snapshot JSON NULL,
    operator_ids JSON NOT NULL,
    operator_names JSON NULL,
    meal_types JSON NULL,
    name_ru VARCHAR(255) NOT NULL,
    name_en VARCHAR(255) NULL,
    accommodation VARCHAR(64) NULL,
    area DECIMAL(7,1) NULL,
    view VARCHAR(128) NULL,
    description TEXT NULL,
    facilities JSON NULL,
    images JSON NULL,
    rule_type ENUM('percent','absolute') NOT NULL,
    rule_value DECIMAL(12,2) NOT NULL,
    rounding INT NOT NULL DEFAULT 1,
    min_price DECIMAL(12,2) NULL,
    max_price DECIMAL(12,2) NULL,
    min_margin_type ENUM('percent','absolute') NULL,
    min_margin_value DECIMAL(12,2) NULL,
    package_types JSON NULL,
    badge VARCHAR(64) NULL,
    active TINYINT(1) NOT NULL DEFAULT 1,
    sort_order INT NOT NULL DEFAULT 0,
    last_provider_price DECIMAL(12,2) NULL,
    last_final_price DECIMAL(12,2) NULL,
    last_operator VARCHAR(128) NULL,
    last_margin_clamped TINYINT(1) NOT NULL DEFAULT 0,
    last_seen_at DATETIME NULL,
    created_by VARCHAR(128) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_hotel (hotel_id, active),
    KEY idx_source (source_room_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,

  `CREATE TABLE IF NOT EXISTS custom_room_settings (
    \`key\` VARCHAR(64) PRIMARY KEY,
    \`value\` JSON NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,

  `CREATE TABLE IF NOT EXISTS custom_room_price_log (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    room_type_id INT NOT NULL,
    request_id VARCHAR(64) NULL,
    source_offer_id VARCHAR(64) NULL,
    operator_id INT NULL,
    operator_name VARCHAR(128) NULL,
    meal VARCHAR(16) NULL,
    provider_price DECIMAL(12,2) NOT NULL,
    final_price DECIMAL(12,2) NOT NULL,
    rule_snapshot JSON NULL,
    margin_clamped TINYINT(1) NOT NULL DEFAULT 0,
    seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_rt (room_type_id, id),
    KEY idx_rt_op_meal (room_type_id, operator_id, meal, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,

  `CREATE TABLE IF NOT EXISTS custom_room_change_log (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    room_type_id INT NOT NULL,
    staff_id INT NULL,
    staff_name VARCHAR(128) NULL,
    changes JSON NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_rt (room_type_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,

  `CREATE TABLE IF NOT EXISTS custom_room_offer_map (
    virtual_offer_id VARCHAR(64) PRIMARY KEY,
    room_type_id INT NOT NULL,
    request_id VARCHAR(64) NULL,
    source_offer_id VARCHAR(64) NOT NULL,
    operator_id INT NULL,
    meal VARCHAR(16) NULL,
    provider_price DECIMAL(12,2) NOT NULL,
    final_price DECIMAL(12,2) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    KEY idx_expires (expires_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,

  `CREATE TABLE IF NOT EXISTS custom_room_package_map (
    lt_package_id VARCHAR(64) PRIMARY KEY,
    room_type_id INT NOT NULL,
    virtual_offer_id VARCHAR(64) NULL,
    source_offer_id VARCHAR(64) NULL,
    operator_name VARCHAR(128) NULL,
    provider_price DECIMAL(12,2) NOT NULL,
    final_price DECIMAL(12,2) NOT NULL,
    rule_snapshot JSON NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    KEY idx_expires (expires_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,

  `CREATE TABLE IF NOT EXISTS custom_room_searches (
    request_id VARCHAR(64) PRIMARY KEY,
    search_type VARCHAR(16) NOT NULL,
    params JSON NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    KEY idx_expires (expires_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
];

const ORDER_COLUMNS = [
  ['custom_room_type_id', 'INT NULL'],
  ['provider_price', 'DECIMAL(12,2) NULL'],
  ['final_price', 'DECIMAL(12,2) NULL'],
  ['price_rule', 'JSON NULL'],
];

async function run() {
  for (const sql of DDL) {
    const name = /TABLE IF NOT EXISTS (\w+)/.exec(sql)[1];
    await db.query(sql);
    console.log(`✅ ${name}`);
  }
  const [cols] = await db.query('SHOW COLUMNS FROM orders');
  const have = new Set(cols.map((c) => c.Field));
  for (const [col, def] of ORDER_COLUMNS) {
    if (have.has(col)) { console.log(`= orders.${col} exists`); continue; }
    await db.query(`ALTER TABLE orders ADD COLUMN ${col} ${def}`);
    console.log(`✅ orders.${col}`);
  }
  const [idx] = await db.query("SHOW INDEX FROM orders WHERE Key_name = 'idx_custom_room_type'");
  if (!idx.length) { await db.query('ALTER TABLE orders ADD INDEX idx_custom_room_type (custom_room_type_id)'); console.log('✅ orders.idx_custom_room_type'); }
  console.log('Done. Now: pm2 restart api');
  await db.end();
}

run().catch((e) => { console.error('❌ migration failed:', e.message); process.exit(1); });
