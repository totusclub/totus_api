// Касса Ferma: чек при создании бронирования (временно, FERMA_RECEIPT_TRIGGER=booking, только FERMA_MODE=test).
//   node scripts/check-ferma-booking.js
// Без npm install, без БД и без сети: сервис — с хранилищем в памяти и поддельным клиентом Ferma.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const BASE_ENV = {
    FERMA_MODE: 'test', FERMA_BASE_URL: 'https://ferma-test.ofd.ru', FERMA_LOGIN: 'stand-login', FERMA_PASSWORD: 'stand-secret-pass',
    FERMA_INN: '3245001416', FERMA_WORKER: '0', FERMA_RECEIPT_TRIGGER: 'booking',
};
function setEnv(over = {}) {
    for (const k of Object.keys(process.env)) if (k.startsWith('FERMA_')) delete process.env[k];
    Object.assign(process.env, BASE_ENV, over);
    for (const [k, v] of Object.entries(over)) if (v === undefined) delete process.env[k];
}
setEnv();

const { loadConfig, publicConfig } = require(path.join(root, 'lib/ferma/config'));
const hooks = require(path.join(root, 'lib/ferma/hooks'));
const { createMemoryStore } = require(path.join(root, 'lib/ferma/store'));
const { createService, TEST_SUPPLIER } = require(path.join(root, 'lib/ferma/service'));

// Типичный заказ LT после /orders/create (поля, которые читает app.js / vtbPaymentPurpose) — с персональными данными.
const LT_ORDER = {
    id: 123456789,
    full_price: 152340,
    package: {
        hotel: { name: 'Rixos Sungate', city: { name_ru: 'Кемер' }, country: { name_ru: 'Турция' } },
        dates_info: { start_date: '2026-11-20', nights_count: 7 },
    },
    tourists: [{ first_name: 'IVAN', last_name: 'PETROV', email: 'ivan.petrov@mail.ru' }],
    client: { name: 'Иван', surname: 'Петров', email: 'ivan.petrov@mail.ru', phone: '79161234567' },
    _customer_email: 'ivan.petrov@mail.ru', _customer_phone: '79161234567', _customer_name: 'Иван Петров',
};
const ARL_BOOKING = {
    id: 7, orderId: '900000007', hotelName: 'Delphin Imperial', roomName: 'Family Suite', checkIn: '2026-12-01', checkOut: '2026-12-04',
    operatorName: 'Arlekino', contact: { email: 'anna@yandex.ru', phone: '79035551122', name: 'Анна' },
};
const ARL_ORDER = { id: 900000007, client: { name: 'Анна', email: 'anna@yandex.ru', phone: '79035551122' }, _customer_email: 'anna@yandex.ru' };
const PERSONAL = ['ivan.petrov@mail.ru', '79161234567', 'Петров', 'PETROV', 'anna@yandex.ru', '79035551122', 'Анна'];

function noPersonal(obj, where) {
    const s = JSON.stringify(obj);
    for (const p of PERSONAL) assert(!s.includes(p), `${where}: персональные данные «${p}» попали в чек`);
}

// Сервис-заглушка: запоминает вызовы issue.
function stubFerma({ fail } = {}) {
    const calls = [];
    return {
        calls,
        getFerma: () => ({
            service: {
                async issue(input, opts) {
                    calls.push({ input, opts });
                    if (fail) throw new Error(fail);
                    return { ok: true, reused: false, row: { id: 1, invoice_id: `tc-test-${input.orderRef}-pay-1`, state: 'confirmed', ofd_receipt_url: 'https://check-demo.ofd.ru/rec/1' } };
                },
            },
        }),
    };
}
const now = (fn) => fn();

// Поддельный клиент Ferma: чек сразу CONFIRMED, повтор InvoiceId не создаёт второй.
function fakeClient() {
    const sent = [];
    let n = 0;
    const byInvoice = new Map();
    return {
        sent,
        async createReceipt(body) {
            sent.push(body);
            const inv = body.Request.InvoiceId;
            if (!byInvoice.has(inv)) byInvoice.set(inv, `r-${++n}`);
            return { Status: 'Success', Data: { ReceiptId: byInvoice.get(inv) } };
        },
        async status({ receiptId }) {
            return { Status: 'Success', Data: { StatusCode: 2, StatusName: 'CONFIRMED', ReceiptId: receiptId,
                Device: { RNM: '1', FN: '2', FDN: '3', FPD: '4', OfdReceiptUrl: `https://check-demo.ofd.ru/rec/${receiptId}` } } };
        },
    };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('amountToKop: числа, строки, объект { value }, мусор', () => {
    assert.strictEqual(hooks.amountToKop(152340), 15234000);
    assert.strictEqual(hooks.amountToKop('1500.5'), 150050);
    assert.strictEqual(hooks.amountToKop('1 500,50'), 150050);
    assert.strictEqual(hooks.amountToKop({ value: 990, code: 'RUB' }), 99000);
    assert.strictEqual(hooks.amountToKop(1500.004), 150000);
    for (const bad of [null, undefined, '', 0, -5, 'abc', {}]) assert.strictEqual(hooks.amountToKop(bad), null, `не сумма: ${JSON.stringify(bad)}`);
});

test('Название позиции LT: отель, город, дата, ночи, заказ — без персональных данных', () => {
    const label = hooks.bookingLabel({ source: 'lt', orderId: '123456789', orderData: LT_ORDER });
    assert.strictEqual(label, 'Тур: Rixos Sungate, Кемер, 20.11.2026, 7 ночей, заказ 123456789');
    assert.strictEqual(hooks.bookingLabel({ source: 'lt', orderId: '5', orderData: {} }), 'Тур: заказ 5');
});

test('Название позиции Arlekino: отель, номер, даты', () => {
    const label = hooks.bookingLabel({ source: 'arlekino', orderId: '900000007', orderData: ARL_ORDER, booking: ARL_BOOKING });
    assert.strictEqual(label, 'Проживание: Delphin Imperial, Family Suite, 01.12.2026-04.12.2026, заказ 900000007');
});

test('Вход сервиса: приход, orderRef = номер заказа, тестовый поставщик, без контактов покупателя', () => {
    const { input } = hooks.bookingReceiptInput({ source: 'lt', orderId: 123456789, amount: 152340, orderData: LT_ORDER });
    assert.deepStrictEqual(
        { scenario: input.scenario, kind: input.kind, orderRef: input.orderRef, amountKop: input.amountKop, supplier: input.supplier },
        { scenario: 'booking_lt', kind: 'income', orderRef: '123456789', amountKop: 15234000, supplier: TEST_SUPPLIER },
    );
    assert(!('email' in input) && !('phone' in input), 'email / phone покупателя не передаются');
    noPersonal(input, 'LT');
    const arl = hooks.bookingReceiptInput({ source: 'arlekino', orderId: '900000007', amount: 45000, orderData: ARL_ORDER, booking: ARL_BOOKING }).input;
    assert.strictEqual(arl.scenario, 'booking_arlekino');
    assert.strictEqual(arl.supplier.name, 'ООО Тестовый продавец размещения');
    noPersonal(arl, 'Arlekino');
    assert.strictEqual(hooks.bookingReceiptInput({ source: 'lt', orderId: 1, amount: null }).skip, 'no_amount');
    assert.strictEqual(hooks.bookingReceiptInput({ source: 'lt', orderId: 'ORDER-1/2', amount: 1 }).skip, 'invalid_order_id');
    assert.strictEqual(hooks.bookingReceiptInput({ source: 'other', orderId: 1, amount: 1 }).skip, 'unknown_source');
});

test('FERMA_RECEIPT_TRIGGER не задан / off — касса не вызывается', async () => {
    for (const trig of [undefined, 'off', 'payment', 'BOOKINGS']) {
        setEnv({ FERMA_RECEIPT_TRIGGER: trig });
        const f = stubFerma();
        const r = await hooks.createBookingHook({ getFerma: f.getFerma, defer: now, log: () => {} })({ source: 'lt', orderId: 1, amount: 100 });
        assert.deepStrictEqual(r, { skipped: 'trigger_off' }, `trigger=${trig}`);
        assert.strictEqual(f.calls.length, 0);
    }
    setEnv();
});

test('FERMA_MODE=live или off + booking — чек при бронировании не пробивается', async () => {
    for (const mode of ['live', 'off']) {
        setEnv({ FERMA_MODE: mode, FERMA_BASE_URL: mode === 'live' ? 'https://ferma.ofd.ru' : undefined, FERMA_ALLOW_LIVE_RECEIPTS: '1' });
        const f = stubFerma();
        const logs = [];
        const r = await hooks.createBookingHook({ getFerma: f.getFerma, defer: now, log: (m) => logs.push(m) })({ source: 'lt', orderId: 1, amount: 1 });
        assert.deepStrictEqual(r, { skipped: 'not_test_mode' }, mode);
        assert.strictEqual(f.calls.length, 0, `${mode}: касса не вызвана`);
        assert(/только в FERMA_MODE=test/.test(logs[0]));
    }
    setEnv();
});

test('Ferma не настроена (нет логина) — пропуск, бронирование не страдает', async () => {
    setEnv({ FERMA_LOGIN: undefined });
    const f = stubFerma();
    const r = await hooks.createBookingHook({ getFerma: f.getFerma, defer: now, log: () => {} })({ source: 'lt', orderId: 1, amount: 1 });
    assert.deepStrictEqual(r, { skipped: 'not_configured' });
    assert.strictEqual(f.calls.length, 0);
    setEnv();
});

test('test + booking: issue вызывается в фоне, ответ бронирования не ждёт', async () => {
    const f = stubFerma();
    const deferred = [];
    const logs = [];
    const p = hooks.createBookingHook({ getFerma: f.getFerma, defer: (fn) => deferred.push(fn), log: (m) => logs.push(m) })(
        { source: 'lt', orderId: 123456789, amount: 152340, orderData: LT_ORDER });
    assert.strictEqual(f.calls.length, 0, 'до следующего тика касса не вызывается — ответ клиенту уходит сразу');
    assert.strictEqual(deferred.length, 1);
    await deferred[0]();
    const r = await p;
    assert.strictEqual(r.ok, true);
    assert.strictEqual(f.calls.length, 1);
    assert.strictEqual(f.calls[0].opts.waitMs, 20000);
    assert(/\[FERMA\] booking order=123456789 source=lt receipt=#1 invoice=tc-test-123456789-pay-1 state=confirmed/.test(logs[0]), logs[0]);
    noPersonal(logs, 'лог');
});

test('Ошибка кассы — промис не отклоняется, только лог', async () => {
    const f = stubFerma({ fail: 'Ferma недоступна' });
    const logs = [];
    const r = await hooks.createBookingHook({ getFerma: f.getFerma, defer: now, log: (m) => logs.push(m) })({ source: 'lt', orderId: 2, amount: 10 });
    assert.deepStrictEqual(r, { error: 'Ferma недоступна' });
    assert(/ошибка кассы: Ferma недоступна/.test(logs[0]));
    const g = { getFerma: () => { throw new Error('db down'); } };
    const r2 = await hooks.createBookingHook({ ...g, defer: now, log: () => {} })({ source: 'lt', orderId: 3, amount: 10 });
    assert.deepStrictEqual(r2, { error: 'db down' });
});

test('fireBookingReceipt не бросает даже при сломанном входе', () => {
    setEnv({ FERMA_RECEIPT_TRIGGER: 'off' });
    hooks.fireBookingReceipt(undefined);
    hooks.fireBookingReceipt({ source: 'lt', orderId: { bad: true }, amount: 'x' });
    setEnv();
});

test('С настоящим сервисом: в Ferma — тестовая почта, повтор заказа не создаёт второй чек', async () => {
    const client = fakeClient();
    const store = createMemoryStore();
    const service = createService({ client, store, sleep: async () => {}, log: () => {} });
    const hook = hooks.createBookingHook({ getFerma: () => ({ service }), defer: now, log: () => {} });
    const ctx = { source: 'lt', orderId: 123456789, amount: 152340, orderData: LT_ORDER };
    const r1 = await hook(ctx);
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r1.state, 'confirmed');
    const r2 = await hook(ctx);
    assert.strictEqual(r2.reused, true, 'тот же заказ → тот же чек');
    assert.strictEqual(store.rows.length, 1);
    assert.strictEqual(client.sent.length, 1, 'в Ferma ушёл один запрос');
    const body = client.sent[0].Request;
    assert.strictEqual(body.InvoiceId, 'tc-test-123456789-pay-1');
    assert.strictEqual(body.CustomerReceipt.Email, 'test@example.com');
    assert.strictEqual(body.CustomerReceipt.Phone, undefined);
    assert.strictEqual(body.CustomerReceipt.Items[0].Amount, 152340);
    assert.strictEqual(body.CustomerReceipt.Items[0].PaymentAgentInfo.SupplierInn, TEST_SUPPLIER.inn);
    noPersonal(client.sent, 'тело в Ferma');
    noPersonal(store.rows, 'fiscal_receipts');
});

test('/config показывает триггер: receiptOnBooking только при test', () => {
    setEnv();
    assert.strictEqual(publicConfig(loadConfig()).receiptTrigger, 'booking');
    assert.strictEqual(publicConfig(loadConfig()).receiptOnBooking, true);
    setEnv({ FERMA_MODE: 'live', FERMA_BASE_URL: 'https://ferma.ofd.ru' });
    assert.strictEqual(publicConfig(loadConfig()).receiptOnBooking, false);
    setEnv({ FERMA_RECEIPT_TRIGGER: undefined });
    assert.strictEqual(publicConfig(loadConfig()).receiptTrigger, 'off');
    setEnv();
});

test('Подключено в /create-package LT: после записи заказа, без await, до ответа', () => {
    const app = read('app.js');
    const start = app.indexOf("app.post('/create-package'");
    const end = app.indexOf("app.post('/validate-tourists'");
    assert(start > 0 && end > start);
    const h = app.slice(start, end);
    const call = h.indexOf("require('./lib/ferma/hooks').fireBookingReceipt({ source: 'lt', orderId: order_id, amount: paymentAmount, orderData })");
    assert(call > 0, 'вызов хука в /create-package');
    assert(call > h.indexOf('INSERT INTO orders'), 'после записи заказа');
    assert(call > h.indexOf('const paymentAmount'), 'после расчёта суммы');
    assert(call < h.indexOf('res.json(response.data)'), 'до ответа');
    assert(!/await\s+require\('\.\/lib\/ferma\/hooks'\)/.test(h), 'не ждём кассу');
    assert.strictEqual((app.match(/fireBookingReceipt/g) || []).length, 1, 'в app.js — один вызов чека при бронировании');
});

test('Подключено в бронировании Arlekino: после создания заказа, без await', () => {
    const src = read('lib/customRooms/internalOrders.js');
    const call = src.indexOf("require('../ferma/hooks').fireBookingReceipt({ source: 'arlekino', orderId, amount, orderData, booking })");
    assert(call > 0);
    assert(call > src.indexOf('await bookings.create('), 'после создания заказа');
    assert(call < src.indexOf('return res.json({'), 'до ответа');
    assert(!/await\s+require\('\.\.\/ferma\/hooks'\)/.test(src));
});

// 05.11.2026: оплата ВТБ / check_pay вызывают только чек после оплаты (firePaymentReceipt), не чек при бронировании.
test('Оплата ВТБ / check_pay: только чек после оплаты, без чека при бронировании', () => {
    for (const f of ['utils/vtbCallback.js', 'lib/customRooms/bookings.js']) {
        if (!fs.existsSync(path.join(root, f))) continue;
        assert(!/fireBookingReceipt/.test(read(f)), `${f} не вызывает чек при бронировании`);
    }
    const app = read('app.js');
    const cp = app.indexOf("app.post('/check_pay'");
    if (cp > 0) {
        const next = app.indexOf('app.', cp + 20);
        const h = app.slice(cp, next > cp ? next : cp + 4000);
        assert(!/fireBookingReceipt/.test(h), '/check_pay не вызывает чек при бронировании');
    }
});

let finished = false;
process.on('exit', (code) => {
    if (!finished && code === 0) { console.log('check-ferma-booking: не все проверки завершились (зависший промис)'); process.exitCode = 1; }
});
(async () => {
    let failed = 0;
    for (const t of tests) {
        try {
            await t.fn();
            console.log(`  ✓ ${t.name}`);
        } catch (err) {
            failed++;
            console.log(`  ✗ ${t.name}\n    ${err.message}`);
        }
    }
    finished = true;
    setEnv();
    console.log(`check-ferma-booking: ${tests.length - failed}/${tests.length}`);
    if (failed) process.exit(1);
})();
