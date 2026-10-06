'use strict';

/**
 * GET /user/orders: документы всех заказов одним запросом вместо запроса на каждый заказ,
 * ответ клиенту — тот же самый. Без БД и без сети.
 * Запуск: node scripts/check-user-orders-batch.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

// Фейковая БД: order_documents в памяти, считаем запросы.
const documents = [
    { id: 1, order_id: 101, title: 'Ваучер.pdf', source_url: 'https://level.travel/orders/101/attachment/5', file_path: 'uploads/orders/101/Ваучер.pdf', public_url: '/uploads/orders/101/Ваучер.pdf', event_reference: 'e1', created_at: new Date('2026-09-01T10:00:00Z') },
    { id: 2, order_id: 101, title: 'Договор оферты.pdf', source_url: 'https://level.travel/agreement.pdf?agreement_code=1', file_path: 'uploads/orders/101/Договор_оферты.pdf', public_url: '/uploads/orders/101/Договор_оферты.pdf', event_reference: 'order_create', created_at: new Date('2026-08-30T10:00:00Z') },
    { id: 3, order_id: 102, title: 'Билеты.pdf', source_url: 'https://level.travel/orders/102/attachment/9', file_path: 'uploads/orders/102/Билеты.pdf', public_url: '/uploads/orders/102/Билеты.pdf', event_reference: 'e2', created_at: new Date('2026-09-02T10:00:00Z') },
];
let queries = [];
const fakeDb = {
    async query(sql, args) {
        queries.push(sql);
        if (/FROM order_documents\s+WHERE order_id IN \(\?\)/.test(sql)) {
            const ids = args[0];
            return [documents.filter((d) => ids.includes(d.order_id)).sort((a, b) => b.created_at - a.created_at)];
        }
        if (/FROM order_documents\s+WHERE order_id = \?/.test(sql)) {
            return [documents.filter((d) => d.order_id === args[0]).sort((a, b) => b.created_at - a.created_at)];
        }
        throw new Error(`unexpected query: ${sql}`);
    },
};
const dbPath = require.resolve(path.join(__dirname, '..', 'db'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };

const { prepareOrderRowForClient, prepareOrderRowsForClient, getOrderDocumentsByOrderIds } = require('../utils/orderDocuments');

let passed = 0;
async function check(name, fn) {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
}

const pkg101 = {
    hotel: { name: 'Rixos', city: 'Анталья' },
    agreement_doc: 'https://level.travel/agreement.pdf?agreement_code=1',
    agreement_license: 'https://level.travel/license_agreement.pdf',
    attachments: [
        { title: 'Ваучер.pdf', url: 'https://level.travel/orders/101/attachment/5' },
        { title: 'Неизвестный.pdf', url: 'https://level.travel/orders/101/attachment/77' },
    ],
};
const rows = [
    { id: 1, order_id: 101, user_id: 7, package: JSON.stringify(pkg101), pay_status: 'RECONCILED' },
    { id: 2, order_id: 102, user_id: 7, package: JSON.stringify({ hotel: { name: 'Delphin' } }), pay_status: null },
    { id: 3, order_id: 103, user_id: 7, package: '{broken json', pay_status: null },
    { id: 4, order_id: 'x', user_id: 7, package: JSON.stringify({ a: 1 }), pay_status: null },
];

(async () => {
    console.log('GET /user/orders: документы одним запросом');

    await check('ответ совпадает с прежним (заказ за заказом) для всех видов строк', async () => {
        queries = [];
        const before = await Promise.all(rows.map((row) => prepareOrderRowForClient(row)));
        const beforeQueries = queries.length;
        queries = [];
        const after = await prepareOrderRowsForClient(rows);
        assert.deepStrictEqual(after, before);
        assert.strictEqual(beforeQueries, 3, 'раньше — запрос на каждый заказ с числовым id');
        assert.strictEqual(queries.length, 1, 'теперь — один запрос');
    });

    await check('ссылки на документы — локальные, внешние без локальной копии убраны (как раньше)', async () => {
        const [first] = await prepareOrderRowsForClient([rows[0]]);
        assert.strictEqual(first.package.agreement_doc, '/uploads/orders/101/Договор_оферты.pdf');
        assert.strictEqual(first.package.agreement_license, undefined);
        assert.deepStrictEqual(first.package.attachments.map((a) => a.url), ['/uploads/orders/101/Ваучер.pdf']);
        assert.strictEqual(first.package.saved_documents.length, 2);
    });

    await check('нет заказов → ни одного запроса к order_documents', async () => {
        queries = [];
        assert.deepStrictEqual(await prepareOrderRowsForClient([]), []);
        assert.strictEqual(queries.length, 0);
        const map = await getOrderDocumentsByOrderIds([undefined, 'abc']);
        assert.strictEqual(map.size, 0);
    });

    await check('обработчик /user/orders использует пакетную версию, ответ того же вида', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
        const start = src.indexOf("app.get('/user/orders'");
        const handler = src.slice(start, src.indexOf('\n});', start));
        assert.ok(/prepareOrderRowsForClient\(orders\)/.test(handler));
        assert.ok(!/orders\.map\(\(order\) => prepareOrderRowForClient/.test(handler), 'без запроса на каждый заказ');
        assert.ok(/last_lt_event: latestByOrderId\.get\(Number\(order\.order_id\)\) \|\| null/.test(handler));
        assert.ok(/SELECT \* FROM orders WHERE user_id = \?/.test(handler), 'набор полей заказа не меняется');
    });

    console.log(`\n${passed} passed`);
})().catch((e) => {
    console.error('FAIL', e && e.message ? e.message : e);
    process.exit(1);
});
