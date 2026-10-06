'use strict';

/**
 * GET /user/orders?view=list — лёгкий список для экрана «Заказы» приложения.
 * Без БД и сети: node scripts/check-orders-list-view.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { toListItem, slimPackage } = require('../utils/orderListView');

let passed = 0;
function check(name, fn) {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
}

// Пакет LT «как в жизни»: всё, что видит карточка, + тяжёлое, что карточке не нужно.
const heavy = 'x'.repeat(200000);
const ltPackage = {
    id: 331445018,
    state: 'confirmed',
    status_for_client: 'Подтверждён',
    is_paid: true,
    full_price: 154000,
    remaining_amount: 0,
    payment_methods: [{ type: 'sbp', enable: true, title: 'СБП', description: heavy }],
    attachments: [{ title: 'Ваучер.pdf', url: '/uploads/orders/331445018/Ваучер.pdf' }],
    client: { email: 'a@b.c', phone: '+7' },
    agreement_doc: '/uploads/orders/331445018/Договор.pdf',
    _pay_url: 'https://pay',
    package: {
        price: 154000,
        created_at: '2026-09-01T10:00:00Z',
        state: 'approved',
        nights_count: 7,
        dates_info: { start_date: '2026-10-12', end_date: '2026-10-19' },
        hotel: { id: 1, name: 'Rixos', city: 'Анталья', country: 'Турция', stars: 5, description: heavy, images: new Array(200).fill({ url: heavy.slice(0, 100) }) },
        departure: { id: 213, name_ru: 'Москва', name_en: 'Moscow', name: 'Москва', airports: new Array(50).fill({ code: 'SVO' }) },
        tourists: [{ id: 9, name: 'Ivan', surname: 'Petrov', passport: '1234 567890', birthday: '1990-01-01' }, null],
        flights: new Array(4).fill({ segments: new Array(10).fill({ info: heavy.slice(0, 1000) }) }),
        _totus_booking: { internal: true, status: 'confirmed', operator: 'Arlekino', hotelBookingRef: 'R-1' },
    },
};
const row = {
    id: 5,
    order_id: 331445018,
    user_id: 7,
    package: JSON.stringify(ltPackage),
    pay_status: 'RECONCILED',
    order_state: 'confirmed',
    lt_auth_token: 'secret-token',
    c_date: new Date('2026-09-01T10:00:00Z'),
    created_at: new Date('2026-09-01T10:00:00Z'),
};
const lastEvent = { id: 77, order_id: 331445018, event: 'state_change', state: 'approved', status: 'Тур подтверждён', changes: { state: ['a', 'approved'], big: heavy }, message: heavy, created_at: new Date('2026-09-02T10:00:00Z') };

console.log('GET /user/orders?view=list');

check('все поля карточки на месте (hotel, даты, вылет, ночи, цена, туристы, статусы, оплата, бронь)', () => {
    const item = toListItem(row, lastEvent);
    const pkg = item.package.package;
    assert.strictEqual(item.order_id, 331445018);
    assert.strictEqual(item.id, 5);
    assert.strictEqual(item.pay_status, 'RECONCILED');
    assert.strictEqual(item.order_state, 'confirmed');
    assert.strictEqual(item.package.status_for_client, 'Подтверждён');
    assert.strictEqual(item.package.is_paid, true);
    assert.strictEqual(item.package.full_price, 154000);
    assert.strictEqual(item.package.state, 'confirmed');
    assert.deepStrictEqual(item.package.payment_methods, [{ type: 'sbp', enable: true }]);
    assert.deepStrictEqual(pkg.hotel, { id: 1, name: 'Rixos', city: 'Анталья', country: 'Турция', stars: 5 });
    assert.deepStrictEqual(pkg.dates_info, { start_date: '2026-10-12', end_date: '2026-10-19' });
    assert.deepStrictEqual(pkg.departure, { id: 213, name_ru: 'Москва', name_en: 'Moscow', name: 'Москва' });
    assert.strictEqual(pkg.nights_count, 7);
    assert.strictEqual(pkg.price, 154000);
    assert.strictEqual(pkg.created_at, '2026-09-01T10:00:00Z');
    assert.strictEqual(pkg.state, 'approved');
    assert.deepStrictEqual(pkg.tourists, [{ id: 9, name: 'Ivan', surname: 'Petrov' }]);
    assert.deepStrictEqual(pkg._totus_booking, ltPackage.package._totus_booking);
    assert.deepStrictEqual(item.last_lt_event, { id: 77, order_id: 331445018, event: 'state_change', state: 'approved', status: 'Тур подтверждён', created_at: '2026-09-02T10:00:00.000Z' });
    assert.strictEqual(item.list_view, true);
});

check('тяжёлое и лишнее не уходит: описание, фото, перелёты, вложения, контакты, паспорта, токен LT', () => {
    const item = toListItem(row, lastEvent);
    const json = JSON.stringify(item);
    assert.ok(json.length < 3000, `size ${json.length}`);
    assert.ok(JSON.stringify(row).length > 400000, 'исходная строка большая');
    assert.ok(!('lt_auth_token' in item));
    assert.ok(!json.includes('1234 567890') && !json.includes('a@b.c'), 'паспорт и контакты не в списке');
    assert.ok(!('flights' in item.package.package) && !('attachments' in item.package) && !('client' in item.package));
});

check('даты строк — ISO-строки (раньше Date становился {} после подписи ссылок)', () => {
    const item = toListItem(row, null);
    assert.strictEqual(item.created_at, '2026-09-01T10:00:00.000Z');
    assert.strictEqual(item.c_date, '2026-09-01T10:00:00.000Z');
    assert.strictEqual(item.last_lt_event, null);
});

check('битый / пустой пакет, пакет без вложенного package, необычные значения — без исключений', () => {
    assert.deepStrictEqual(toListItem({ order_id: 1, package: '{broken' }, null).package, {});
    assert.deepStrictEqual(toListItem({ order_id: 2, package: null }, null).package, {});
    assert.deepStrictEqual(toListItem({ order_id: 3, package: '[1,2]' }, null).package, {});
    const flat = slimPackage({ price: 10, hotel: 'Строка', tourists: 'x', payment_methods: null, package: [1] });
    assert.deepStrictEqual(flat, { price: 10, hotel: 'Строка', tourists: 'x', payment_methods: null });
});

check('обработчик: ?view=list — лёгкий путь; без view — прежний ответ; время и размер в логе', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    const start = src.indexOf("app.get('/user/orders'");
    const handler = src.slice(start, src.indexOf('\n});', start));
    assert.ok(/const listView = String\(req\.query\.view \|\| ''\) === 'list';/.test(handler));
    assert.ok(/if \(listView\) \{[\s\S]*toListItem\(row, latestByOrderId\.get\(Number\(row\.order_id\)\)\)[\s\S]*return res\.json\(items\);/.test(handler));
    assert.ok(/prepareOrderRowsForClient\(orders\)/.test(handler), 'полный путь не изменился');
    assert.ok(/res\.on\('finish'/.test(handler) && /\[ORDERS\]/.test(handler));
});

console.log(`\n${passed} passed`);
