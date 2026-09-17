// Миграция справочника операторов: node scripts/run-operators-migration.js
// Таблица custom_room_operators + колонка custom_room_types.operator_ref_id — идемпотентно.
// Первый запуск заводит оператора по умолчанию из имён, которые уже стоят у Room Type
// (обычно один — «Arlekino», operator_id 990000), и привязывает к нему существующие Room Type:
// до этого operator_id у каждого Room Type был свой (990000 + id), из-за чего в фильтре
// «Туроператор» на витрине они выглядели как разные операторы.
// После неё: pm2 restart api. План: claude/OPERATORS_PLAN_RU.md.
'use strict';

const db = require('../db');

const OPERATOR_ID_BASE = 990000;

const DDL = [
  `CREATE TABLE IF NOT EXISTS custom_room_operators (
    id INT AUTO_INCREMENT PRIMARY KEY,
    operator_id INT NOT NULL,
    name VARCHAR(128) NOT NULL,
    active TINYINT(1) NOT NULL DEFAULT 1,
    sort_order INT NOT NULL DEFAULT 0,
    email_from_name VARCHAR(128) NULL,
    notify_emails VARCHAR(512) NULL,
    created_by VARCHAR(128) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_operator_id (operator_id),
    KEY idx_active (active, sort_order)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

// Мягкая колонка: без неё модуль custom rooms работает как раньше (см. lib/customRooms/store.js).
const ROOM_TYPE_COLUMNS = [
  ['operator_ref_id', 'INT NULL'],
];

async function addColumns(table, columns) {
  const [rows] = await db.query(`SHOW COLUMNS FROM ${table}`);
  const have = new Set(rows.map((c) => c.Field));
  const added = [];
  for (const [col, def] of columns) {
    if (have.has(col)) { console.log(`= ${table}.${col}`); continue; }
    await db.query(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    console.log(`✅ ${table}.${col}`);
    added.push(col);
  }
  return added;
}

/** Следующий свободный operator_id из пула 990000+. */
async function nextOperatorId() {
  const [rows] = await db.query('SELECT MAX(operator_id) AS m FROM custom_room_operators');
  const max = Number(rows[0] && rows[0].m) || 0;
  return max >= OPERATOR_ID_BASE ? max + 1 : OPERATOR_ID_BASE;
}

/**
 * Заводит операторов по именам, которые уже стоят у Room Type, и привязывает строки.
 * Первому (по числу Room Type) достаётся operator_id 990000 — именно это значение
 * сейчас показывают WEB и APP, схлопывая наши синтетические id, поэтому витрина не меняется.
 */
async function seedFromRoomTypes() {
  const [names] = await db.query(
    `SELECT COALESCE(NULLIF(TRIM(operator_name), ''), 'Arlekino') AS name, COUNT(*) AS cnt
       FROM custom_room_types
      GROUP BY name
      ORDER BY cnt DESC, name`,
  );
  if (!names.length) {
    console.log('= custom_room_types пуста — операторы не заводились');
    return;
  }
  let order = 0;
  for (const row of names) {
    const name = String(row.name).slice(0, 128);
    const [exists] = await db.query('SELECT id, operator_id FROM custom_room_operators WHERE name = ? LIMIT 1', [name]);
    let operator = exists[0] || null;
    if (!operator) {
      const operatorId = await nextOperatorId();
      const [ins] = await db.query(
        'INSERT INTO custom_room_operators (operator_id, name, active, sort_order, created_by) VALUES (?, ?, 1, ?, ?)',
        [operatorId, name, order, 'migration'],
      );
      operator = { id: ins.insertId, operator_id: operatorId };
      console.log(`✅ оператор «${name}» → operator_id ${operatorId} (Room Type: ${row.cnt})`);
    } else {
      console.log(`= оператор «${name}» уже есть (operator_id ${operator.operator_id})`);
    }
    const [upd] = await db.query(
      `UPDATE custom_room_types SET operator_ref_id = ?
        WHERE operator_ref_id IS NULL
          AND COALESCE(NULLIF(TRIM(operator_name), ''), 'Arlekino') = ?`,
      [operator.id, name],
    );
    if (upd.affectedRows) console.log(`✅ привязано Room Type: ${upd.affectedRows} → «${name}»`);
    order += 1;
  }
}

async function run() {
  for (const sql of DDL) {
    const name = /TABLE IF NOT EXISTS (\w+)/.exec(sql)[1];
    await db.query(sql);
    console.log(`✅ ${name}`);
  }
  const added = await addColumns('custom_room_types', ROOM_TYPE_COLUMNS);
  const [idx] = await db.query("SHOW INDEX FROM custom_room_types WHERE Key_name = 'idx_operator_ref'");
  if (!idx.length) {
    await db.query('ALTER TABLE custom_room_types ADD INDEX idx_operator_ref (operator_ref_id)');
    console.log('✅ custom_room_types.idx_operator_ref');
  }
  // Заполняем только на первом прогоне: если колонка уже была, привязки менять нельзя.
  if (added.includes('operator_ref_id')) await seedFromRoomTypes();
  else console.log('= operator_ref_id уже была — привязки не трогаем');
  console.log('Done. Now: pm2 restart api');
  await db.end();
}

run().catch((e) => { console.error('❌ migration failed:', e.message); process.exit(1); });
