'use strict';

/**
 * Индексы для «Мои заказы» (GET /user/orders) — запускает владелец один раз на сервере:
 *   node scripts/add-orders-indexes.js          — только показать, каких индексов нет
 *   node scripts/add-orders-indexes.js --apply  — создать недостающие
 *
 * Запросы экрана заказов ищут по этим колонкам; без индекса MySQL читает таблицу целиком:
 *   orders.user_id             — SELECT * FROM orders WHERE user_id = ?
 *   order_documents.order_id   — документы заказов (WHERE order_id IN (...))
 *   lt_order_events.order_id   — последнее событие Level.Travel по заказу
 * Существующий индекс с этой колонкой первой считается подходящим — второй не создаётся.
 * Данные не меняются. На больших таблицах CREATE INDEX может занять время — лучше ночью.
 */

const db = require('../db');

const WANTED = [
    { table: 'orders', column: 'user_id', name: 'idx_orders_user_id' },
    { table: 'order_documents', column: 'order_id', name: 'idx_order_documents_order_id' },
    { table: 'lt_order_events', column: 'order_id', name: 'idx_lt_order_events_order_id' },
];

async function hasLeadingIndex(table, column) {
    const [rows] = await db.query(`SHOW INDEX FROM \`${table}\``);
    return rows.some((r) => Number(r.Seq_in_index) === 1 && String(r.Column_name) === column);
}

(async () => {
    const apply = process.argv.includes('--apply');
    let missing = 0;
    for (const w of WANTED) {
        let ok;
        try {
            ok = await hasLeadingIndex(w.table, w.column);
        } catch (e) {
            console.log(`  ?   ${w.table}.${w.column}: ${e.message}`);
            continue;
        }
        if (ok) {
            console.log(`  ok  ${w.table}.${w.column} — индекс есть`);
            continue;
        }
        missing += 1;
        if (!apply) {
            console.log(`  --  ${w.table}.${w.column} — индекса нет (запустите с --apply)`);
            continue;
        }
        await db.query(`CREATE INDEX \`${w.name}\` ON \`${w.table}\` (\`${w.column}\`)`);
        console.log(`  +   ${w.table}.${w.column} — создан ${w.name}`);
    }
    if (!apply && missing) console.log(`\nНе хватает индексов: ${missing}.`);
    process.exit(0);
})().catch((e) => {
    console.error('Ошибка:', e.message);
    process.exit(1);
});
