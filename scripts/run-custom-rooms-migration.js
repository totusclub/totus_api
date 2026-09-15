// Миграция наших Room Type: node scripts/run-custom-rooms-migration.js
// Таблицы custom_room_* + 4 колонки в orders + бронирования без Level.Travel
// (custom_room_bookings, custom_room_booking_events, 3 колонки в custom_room_package_map)
// + v2 «связь по номеру и фиксированная цена» (5 колонок в custom_room_types, rule_type/rule_value → NULL допустим,
//   operator_ids → NULL допустим; pricing_mode старых строк: rule, если правило есть, иначе fixed) — идемпотентно.
// После неё: pm2 restart api. План: claude/CUSTOM_ROOMS_PLAN_RU.md §4, бриф бронирований §1, бриф v2 §1.
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
    operator_ids JSON NULL,
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
    rule_type ENUM('percent','absolute') NULL,
    rule_value DECIMAL(12,2) NULL,
    rounding INT NOT NULL DEFAULT 1,
    min_price DECIMAL(12,2) NULL,
    max_price DECIMAL(12,2) NULL,
    min_margin_type ENUM('percent','absolute') NULL,
    min_margin_value DECIMAL(12,2) NULL,
    package_types JSON NULL,
    pricing_mode ENUM('fixed','rule') NOT NULL DEFAULT 'fixed',
    fixed_price DECIMAL(12,2) NULL,
    fixed_price_unit ENUM('total','per_night') NOT NULL DEFAULT 'total',
    operator_name VARCHAR(128) NOT NULL DEFAULT 'Arlekino',
    operator_id INT NULL,
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

  // Бронирования наших Room Type без Level.Travel (order_id = 900000000 + id)
  `CREATE TABLE IF NOT EXISTS custom_room_bookings (
    id INT AUTO_INCREMENT PRIMARY KEY,
    order_id VARCHAR(32) NOT NULL,
    user_id INT NULL,
    room_type_id INT NOT NULL,
    hotel_id INT NULL,
    hotel_name VARCHAR(255) NULL,
    hotel_stars TINYINT NULL,
    hotel_city VARCHAR(128) NULL,
    hotel_country VARCHAR(128) NULL,
    room_name VARCHAR(255) NULL,
    source_room_name VARCHAR(255) NULL,
    source_offer_id VARCHAR(64) NULL,
    lt_package_id VARCHAR(64) NULL,
    operator_id INT NULL,
    operator_name VARCHAR(128) NULL,
    meal VARCHAR(16) NULL,
    meal_name VARCHAR(64) NULL,
    check_in DATE NULL,
    check_out DATE NULL,
    nights INT NULL,
    adults INT NULL,
    kids INT NULL,
    tourists_json JSON NULL,
    contact_json JSON NULL,
    package_snapshot JSON NULL,
    provider_price DECIMAL(12,2) NULL,
    final_price DECIMAL(12,2) NULL,
    price_rule JSON NULL,
    payment_status ENUM('pending','paid','failed','refund_pending','refunded','partially_refunded') NOT NULL DEFAULT 'pending',
    paid_at DATETIME NULL,
    paid_amount DECIMAL(12,2) NULL,
    status ENUM('pending_payment','pending_confirmation','confirmed','rejected','cancelled') NOT NULL DEFAULT 'pending_payment',
    confirmed_at DATETIME NULL,
    confirmed_by VARCHAR(128) NULL,
    hotel_booking_ref VARCHAR(128) NULL,
    voucher_path VARCHAR(512) NULL,
    voucher_url VARCHAR(512) NULL,
    voucher_sent_at DATETIME NULL,
    rejected_at DATETIME NULL,
    rejected_by VARCHAR(128) NULL,
    reject_reason ENUM('no_availability','price_changed','data_error','other') NULL,
    reject_message TEXT NULL,
    refund_amount DECIMAL(12,2) NULL,
    refund_method ENUM('manual') NULL,
    refund_status ENUM('pending','done') NULL,
    refund_at DATETIME NULL,
    refund_by VARCHAR(128) NULL,
    client_message TEXT NULL,
    staff_comment TEXT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_order (order_id),
    KEY idx_status (status, id),
    KEY idx_user (user_id),
    KEY idx_rt (room_type_id),
    KEY idx_hotel (hotel_id),
    KEY idx_refund (refund_status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,

  `CREATE TABLE IF NOT EXISTS custom_room_booking_events (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    booking_id INT NOT NULL,
    type VARCHAR(32) NOT NULL,
    staff_id INT NULL,
    staff_name VARCHAR(128) NULL,
    payload JSON NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_booking (booking_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
];

const ORDER_COLUMNS = [
  ['custom_room_type_id', 'INT NULL'],
  ['provider_price', 'DECIMAL(12,2) NULL'],
  ['final_price', 'DECIMAL(12,2) NULL'],
  ['price_rule', 'JSON NULL'],
];

// custom_room_package_map: снимок пакета (ответ package_details/actualize с нашими ценами) — из него
// собирается заказ без Level.Travel; hotel_id и meal — для карточки бронирования.
const PACKAGE_MAP_COLUMNS = [
  ['hotel_id', 'INT NULL'],
  ['meal', 'VARCHAR(16) NULL'],
  ['package_snapshot', 'JSON NULL'],
];

// v2 (бриф BRIEF_ROOM_LINK_V2 §1): режим цены и оператор «Arlekino» в custom_room_types
const ROOM_TYPE_COLUMNS = [
  ['pricing_mode', "ENUM('fixed','rule') NOT NULL DEFAULT 'fixed'"],
  ['fixed_price', 'DECIMAL(12,2) NULL'],
  ['fixed_price_unit', "ENUM('total','per_night') NOT NULL DEFAULT 'total'"],
  ['operator_name', "VARCHAR(128) NOT NULL DEFAULT 'Arlekino'"],
  ['operator_id', 'INT NULL'],
];

async function addColumns(table, columns) {
  const [cols] = await db.query(`SHOW COLUMNS FROM ${table}`);
  const have = new Set(cols.map((c) => c.Field));
  const added = [];
  for (const [col, def] of columns) {
    if (have.has(col)) { console.log(`= ${table}.${col} exists`); continue; }
    await db.query(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    console.log(`✅ ${table}.${col}`);
    added.push(col);
  }
  return added;
}

/** v2: NOT NULL → NULL для rule_type/rule_value/operator_ids (при fixed правило и операторы не нужны). Идемпотентно. */
async function relaxRoomTypeColumns() {
  const [cols] = await db.query('SHOW COLUMNS FROM custom_room_types');
  const byName = new Map(cols.map((c) => [c.Field, c]));
  const want = [
    ['rule_type', "ENUM('percent','absolute') NULL"],
    ['rule_value', 'DECIMAL(12,2) NULL'],
    ['operator_ids', 'JSON NULL'],
  ];
  for (const [col, def] of want) {
    const c = byName.get(col);
    if (!c) continue;
    if (String(c.Null).toUpperCase() === 'YES') { console.log(`= custom_room_types.${col} nullable`); continue; }
    await db.query(`ALTER TABLE custom_room_types MODIFY COLUMN ${col} ${def}`);
    console.log(`✅ custom_room_types.${col} → NULL allowed`);
  }
}

async function run() {
  for (const sql of DDL) {
    const name = /TABLE IF NOT EXISTS (\w+)/.exec(sql)[1];
    await db.query(sql);
    console.log(`✅ ${name}`);
  }
  await addColumns('orders', ORDER_COLUMNS);
  await addColumns('custom_room_package_map', PACKAGE_MAP_COLUMNS);
  // v2: связь по номеру + фиксированная цена
  const addedRt = await addColumns('custom_room_types', ROOM_TYPE_COLUMNS);
  await relaxRoomTypeColumns();
  if (addedRt.includes('pricing_mode')) {
    // существующие Room Type: с правилом → rule (работают как раньше), без правила → fixed
    const [r1] = await db.query("UPDATE custom_room_types SET pricing_mode = 'rule' WHERE rule_type IS NOT NULL");
    const [r2] = await db.query("UPDATE custom_room_types SET pricing_mode = 'fixed' WHERE rule_type IS NULL");
    console.log(`✅ custom_room_types.pricing_mode backfilled: rule=${r1.affectedRows}, fixed=${r2.affectedRows}`);
    // v2: показывать при любом типе поиска (пустые package_types); ограничение можно вернуть в админке
    const [r3] = await db.query("UPDATE custom_room_types SET package_types = '[]' WHERE package_types IS NULL OR JSON_LENGTH(package_types) > 0");
    console.log(`✅ custom_room_types.package_types → любой тип поиска (${r3.affectedRows})`);
    // v2: показывать при любом типе поиска (hotelOnly=false по умолчанию; включается в настройках админки)
    await db.query("INSERT INTO custom_room_settings (`key`, `value`) VALUES ('hotelOnly', 'false') ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)");
    console.log('✅ custom_room_settings.hotelOnly = false');
  }
  const [idx] = await db.query("SHOW INDEX FROM orders WHERE Key_name = 'idx_custom_room_type'");
  if (!idx.length) { await db.query('ALTER TABLE orders ADD INDEX idx_custom_room_type (custom_room_type_id)'); console.log('✅ orders.idx_custom_room_type'); }
  console.log('Done. Now: pm2 restart api');
  await db.end();
}

run().catch((e) => { console.error('❌ migration failed:', e.message); process.exit(1); });
