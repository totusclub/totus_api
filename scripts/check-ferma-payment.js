// Касса Ferma: чек в OFD — только после подтверждения оплаты банком (FERMA_RECEIPT_TRIGGER=payment, решение владельца 05.11.2026).
//   node scripts/check-ferma-payment.js
// Без npm install, без БД и без сети: заказ, банк и Ferma подменены.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const BASE_ENV = {
    FERMA_MODE: 'test', FERMA_BASE_URL: 'https://ferma-test.ofd.ru', FERMA_LOGIN: 'stand-login', FERMA_PASSWORD: 'stand-secret-pass',
    FERMA_INN: '3245001416', FERMA_WORKER: '0', FERMA_RECEIPT_TRIGGER: 'payment',
};
const LIVE_ENV = { FERMA_MODE: 'live', FERMA_BASE_URL: 'https://ferma.ofd.ru', FERMA_INN: '9729424935', FERMA_LOGIN: 'live-login', FERMA_PASSWORD: 'live-pass' };
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
const OS = require(path.join(root, 'lib/ferma/orderSupplier'));

// Поставщик тура — из заказа (order_suppliers в памяти), журнал «чек не пробит» — в памяти. БД не трогаем.
function memSupplierDeps() {
    const store = OS.createMemorySupplierStore();
    const blocked = OS.createMemoryBlockedStore();
    return {
        store, blocked,
        resolveOrderSupplier: (orderId, orderData) => OS.resolveLtOrderSupplier(orderId, orderData, { store, log: () => {} }),
    };
}
const H = (deps = {}) => {
    const m = memSupplierDeps();
    return hooks.createPaymentHook({ resolveOrderSupplier: m.resolveOrderSupplier, blocked: m.blocked, ...deps });
};

// Настоящие ИНН с верными контрольными цифрами (ООО «ТОТУСКЛАБ» и пример туроператора для проверки формата).
const OP_SUPPLIER = { inn: '7707083893', name: 'ООО "Туроператор Пример"', phone: '8 (495) 000-00-01' };
const ANEX = { inn: '7743184470', name: 'ООО "Анекс Туризм"', phone: '+78007755000' };
const LT_ORDER_NO_ORG = (() => {
    const o = JSON.parse(JSON.stringify({ id: 123456790, full_price: 99000, operator: { id: 33, name: 'Coral Travel' },
        client: { email: 'ivan.petrov@mail.ru' }, _customer_email: 'ivan.petrov@mail.ru' }));
    return o;
})();
const ARL_SUPPLIER = { inn: '9729424935', name: 'ООО "Продавец размещения"', phone: '+7 495 000-00-02' };

const LT_ORDER = {
    id: 123456789,
    full_price: 152340,
    operator: { id: 6, name: 'Anex' },
    operator_organization: { name: "ООО 'Анекс Туризм '", inn: '7743184470', phone: '+7(800) 775-5000' },
    package: {
        hotel: { name: 'Rixos Sungate', city: { name_ru: 'Кемер' } },
        dates_info: { start_date: '2026-11-20', nights_count: 7 },
        operator: { id: 6, name: 'Anex' },
        operator_organization: { name: "ООО 'Анекс Туризм '", inn: '7743184470', phone: '+7(800) 775-5000' },
    },
    client: { name: 'Иван', email: 'ivan.petrov@mail.ru', phone: '79161234567' },
    _customer_email: 'ivan.petrov@mail.ru', _customer_phone: '79161234567',
};
const ARL_BOOKING = {
    id: 7, orderId: '900000007', hotelName: 'Delphin Imperial', roomName: 'Family Suite', checkIn: '2026-12-01', checkOut: '2026-12-04',
    finalPrice: 45000, contact: { email: 'anna@yandex.ru', phone: '79035551122', name: 'Анна' },
};

const now = (fn) => fn();
function stubFerma({ fail } = {}) {
    const calls = [];
    return {
        calls,
        getFerma: () => ({
            service: {
                async issue(input, opts) {
                    calls.push({ input, opts });
                    if (fail) throw new Error(fail);
                    return { ok: true, reused: false, row: { id: 1, invoice_id: `tc-${input.orderRef}-pay-1`, state: 'confirmed' } };
                },
            },
        }),
    };
}
const ltOrder = (o = LT_ORDER) => async () => ({ source: 'lt', orderData: o, booking: null });
const arlOrder = async () => ({ source: 'arlekino', orderData: { id: 900000007 }, booking: ARL_BOOKING });

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
                Device: { RNM: '1', FN: '2', FDN: '3', FPD: '4', OfdReceiptUrl: `https://check.ofd.ru/rec/${receiptId}` } } };
        },
    };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('Триггер не payment (off / booking / не задан) — касса и заказ не трогаются', async () => {
    for (const trig of [undefined, 'off', 'booking']) {
        setEnv({ FERMA_RECEIPT_TRIGGER: trig });
        const f = stubFerma();
        let loaded = 0;
        const r = await H({ getFerma: f.getFerma, defer: now, log: () => {}, loadOrder: async () => { loaded++; return {}; } })({ orderId: 1, amount: 1, via: 'vtb_callback' });
        assert.deepStrictEqual(r, { skipped: 'trigger_off' }, `trigger=${trig}`);
        assert.strictEqual(f.calls.length + loaded, 0);
    }
    setEnv();
});

test('FERMA_MODE=off или касса не настроена — пропуск, оплата не страдает', async () => {
    setEnv({ FERMA_MODE: 'off' });
    let r = await H({ getFerma: stubFerma().getFerma, defer: now, log: () => {} })({ orderId: 1 });
    assert.deepStrictEqual(r, { skipped: 'mode_off' });
    setEnv({ FERMA_LOGIN: undefined });
    r = await H({ getFerma: stubFerma().getFerma, defer: now, log: () => {} })({ orderId: 1 });
    assert.deepStrictEqual(r, { skipped: 'not_configured' });
    setEnv();
});

test('test: тур оплачен — чек в фоне, сумма из банка, тестовый поставщик, без контактов покупателя', async () => {
    const f = stubFerma();
    const deferred = [];
    const logs = [];
    const p = H({ getFerma: f.getFerma, defer: (fn) => deferred.push(fn), log: (m) => logs.push(m), loadOrder: ltOrder() })(
        { orderId: 123456789, amount: 152000.5, transactionId: 'A123', via: 'vtb_callback' });
    assert.strictEqual(f.calls.length, 0, 'ответ банку не ждёт кассу');
    await deferred[0]();
    const r = await p;
    assert.strictEqual(r.ok, true);
    const { input, opts } = f.calls[0];
    assert.deepStrictEqual(
        { scenario: input.scenario, kind: input.kind, orderRef: input.orderRef, amountKop: input.amountKop, supplier: input.supplier, paymentIdentifier: input.paymentIdentifier },
        { scenario: 'payment_lt', kind: 'income', orderRef: '123456789', amountKop: 15200050, supplier: TEST_SUPPLIER, paymentIdentifier: 'A123' },
    );
    assert.strictEqual(input.label, 'Тур: Rixos Sungate, Кемер, 20.11.2026, 7 ночей, заказ 123456789');
    assert(!('email' in input) && !('phone' in input), 'в test контакты покупателя не передаются');
    assert.strictEqual(opts.waitMs, 20000);
    assert(/\[FERMA\] payment order=123456789 via=vtb_callback source=lt receipt=#1/.test(logs[0]), logs[0]);
    assert(!/ivan|7916/.test(logs.join(' ')), 'в логе нет контактов покупателя');
});

test('Сумма: банк не прислал — берётся сумма заказа (тур — full_price, Arlekino — finalPrice)', async () => {
    let i = hooks.paymentReceiptInput({ mode: 'test', source: 'lt', orderId: 5, amount: null, orderData: LT_ORDER }).input;
    assert.strictEqual(i.amountKop, 15234000);
    i = hooks.paymentReceiptInput({ mode: 'test', source: 'arlekino', orderId: '900000007', amount: undefined, orderData: {}, booking: ARL_BOOKING }).input;
    assert.strictEqual(i.amountKop, 4500000);
    assert.strictEqual(hooks.paymentReceiptInput({ mode: 'test', source: 'lt', orderId: 5, amount: null, orderData: {} }).skip, 'no_amount');
    assert.strictEqual(hooks.paymentReceiptInput({ mode: 'test', source: 'lt', orderId: 'ORDER-1/2', amount: 1 }).skip, 'invalid_order_id');
});

test('live: в заказе нет реквизитов туроператора — чек НЕ пробивается, причина в логе и в fiscal_blocked', async () => {
    setEnv({ ...LIVE_ENV, FERMA_SUPPLIERS: JSON.stringify({ lt: OP_SUPPLIER, 'lt:33': OP_SUPPLIER }) });
    const f = stubFerma();
    const logs = [];
    const m = memSupplierDeps();
    const r = await hooks.createPaymentHook({ getFerma: f.getFerma, defer: now, log: (x) => logs.push(x), loadOrder: ltOrder(LT_ORDER_NO_ORG),
        resolveOrderSupplier: m.resolveOrderSupplier, blocked: m.blocked })({ orderId: 123456790, amount: 99000, via: 'check_pay' });
    assert.deepStrictEqual(r, { skipped: 'supplier_missing' });
    assert.strictEqual(f.calls.length, 0, 'FERMA_SUPPLIERS lt / lt:33 не подставляются');
    assert(/чек НЕ пробит: supplier_missing — Заказ 123456790: туроператор «Coral Travel» \(id 33\) — Level.Travel не передал реквизиты/.test(logs[0]), logs[0]);
    const b = (await m.blocked.list({})).rows;
    assert.strictEqual(b.length, 1);
    assert.strictEqual(b[0].reason, 'supplier_missing');
    assert.strictEqual(b[0].amount_kop, 9900000);
    assert(!/ivan|7916/.test(JSON.stringify(b)), 'в журнале нет контактов покупателя');
    setEnv();
});

test('live: туроператор — из реквизитов ЭТОГО заказа (FERMA_SUPPLIERS lt игнорируется), почта и телефон покупателя', async () => {
    setEnv({ ...LIVE_ENV });
    const f = stubFerma();
    const suppliers = JSON.stringify({ lt: OP_SUPPLIER, 'lt:6': OP_SUPPLIER, arlekino: ARL_SUPPLIER });
    const m = memSupplierDeps();
    await hooks.createPaymentHook({ getFerma: f.getFerma, defer: now, log: () => {}, loadOrder: ltOrder(), getSuppliers: () => suppliers,
        resolveOrderSupplier: m.resolveOrderSupplier, blocked: m.blocked })({ orderId: 123456789, amount: 152340, via: 'check_pay' });
    const { input } = f.calls[0];
    assert.deepStrictEqual(input.supplier, ANEX, 'реквизиты Anex из заказа, не из FERMA_SUPPLIERS');
    assert.strictEqual(input.email, 'ivan.petrov@mail.ru');
    assert.strictEqual(input.phone, '79161234567');
    // Arlekino — по-прежнему ключ arlekino, контакт из бронирования
    const g = stubFerma();
    await H({ getFerma: g.getFerma, defer: now, log: () => {}, loadOrder: arlOrder, getSuppliers: () => suppliers })(
        { orderId: '900000007', amount: 45000, via: 'vtb_callback' });
    assert.strictEqual(g.calls[0].input.scenario, 'payment_arlekino');
    assert.strictEqual(g.calls[0].input.supplier.inn, ARL_SUPPLIER.inn);
    assert.strictEqual(g.calls[0].input.email, 'anna@yandex.ru');
    assert.strictEqual(g.calls[0].input.label, 'Проживание: Delphin Imperial, Family Suite, 01.12.2026-04.12.2026, заказ 900000007');
    setEnv();
});

test('live: общего поставщика для туров нет; Arlekino — неверный JSON / нет ключа — не пробивается', () => {
    const lt = (ltSupplier) => hooks.paymentReceiptInput({ mode: 'live', source: 'lt', orderId: 1, amount: 10, orderData: LT_ORDER,
        suppliers: JSON.stringify({ lt: OP_SUPPLIER, 'lt:6': OP_SUPPLIER }), ltSupplier });
    assert.strictEqual(lt(null).skip, 'supplier_missing', 'без реквизитов заказа ключи lt не помогают');
    assert.strictEqual(lt({ error: 'supplier_invalid', message: 'x' }).skip, 'supplier_invalid');
    assert.strictEqual(lt({ supplier: ANEX }).input.supplier.inn, ANEX.inn);
    let r = hooks.paymentReceiptInput({ mode: 'live', source: 'arlekino', orderId: '900000007', amount: 10, booking: ARL_BOOKING, suppliers: '{oops' });
    assert.strictEqual(r.skip, 'no_supplier:arlekino (FERMA_SUPPLIERS — неверный JSON)');
    r = hooks.paymentReceiptInput({ mode: 'live', source: 'arlekino', orderId: '900000007', amount: 10, booking: ARL_BOOKING, suppliers: JSON.stringify({ lt: OP_SUPPLIER }) });
    assert.strictEqual(r.skip, 'no_supplier:arlekino');
    assert.strictEqual(hooks.ltOperatorId({ package: { operator_id: 78 } }), '78');
    assert.strictEqual(hooks.ltOperatorId({}), null);
});

test('live: без почты и телефона покупателя — не пробивается (иначе чек ушёл бы на почту организации)', () => {
    const r = hooks.paymentReceiptInput({ mode: 'live', source: 'lt', orderId: 1, amount: 10, orderData: { operator: { id: 33 } }, ltSupplier: { supplier: ANEX } });
    assert.strictEqual(r.skip, 'no_buyer_contact');
});

test('Ошибки заказа и кассы — промис не отклоняется, только лог; firePaymentReceipt не бросает', async () => {
    const logs = [];
    let r = await H({ getFerma: stubFerma().getFerma, defer: now, log: (m) => logs.push(m), loadOrder: async () => { throw new Error('db down'); } })({ orderId: 1, via: 'check_pay' });
    assert.deepStrictEqual(r, { error: 'db down' });
    r = await H({ getFerma: stubFerma({ fail: 'Ferma недоступна' }).getFerma, defer: now, log: (m) => logs.push(m), loadOrder: ltOrder() })({ orderId: 1, amount: 1 });
    assert.deepStrictEqual(r, { error: 'Ferma недоступна' });
    assert(/ошибка кассы: Ferma недоступна/.test(logs.join('\n')));
    r = await H({ getFerma: stubFerma().getFerma, defer: now, log: () => {} })({});
    assert.deepStrictEqual(r, { skipped: 'no_order_id' });
    setEnv({ FERMA_RECEIPT_TRIGGER: 'off' });
    hooks.firePaymentReceipt(undefined);
    hooks.firePaymentReceipt({ orderId: { bad: true } });
    setEnv();
});

test('С настоящим сервисом (test): callback ВТБ и check_pay подряд — один чек, в Ferma тестовая почта', async () => {
    const client = fakeClient();
    const store = createMemoryStore();
    const service = createService({ client, store, sleep: async () => {}, log: () => {} });
    const hook = H({ getFerma: () => ({ service }), defer: now, log: () => {}, loadOrder: ltOrder() });
    const r1 = await hook({ orderId: 123456789, amount: 152340, via: 'vtb_callback' });
    const r2 = await hook({ orderId: 123456789, amount: 152340, via: 'check_pay' });
    assert.strictEqual(r1.state, 'confirmed');
    assert.strictEqual(r2.reused, true);
    assert.strictEqual(store.rows.length, 1);
    assert.strictEqual(client.sent.length, 1);
    const body = client.sent[0].Request;
    assert.strictEqual(body.InvoiceId, 'tc-test-123456789-pay-1');
    assert.strictEqual(body.CustomerReceipt.Email, 'test@example.com');
    assert(!JSON.stringify(client.sent).includes('ivan.petrov'), 'настоящая почта на общий стенд не уходит');
});

test('С настоящим сервисом (live): боевой чек — почта покупателя, туроператор, префикс tc', async () => {
    setEnv({ ...LIVE_ENV });
    const client = fakeClient();
    const store = createMemoryStore();
    const service = createService({ client, store, sleep: async () => {}, log: () => {} });
    const hook = H({ getFerma: () => ({ service }), defer: now, log: () => {}, loadOrder: ltOrder(), getSuppliers: () => JSON.stringify({ 'lt:6': OP_SUPPLIER }) });
    const r = await hook({ orderId: 123456789, amount: 152340, via: 'vtb_callback' });
    assert.strictEqual(r.ok, true);
    const body = client.sent[0].Request;
    assert.strictEqual(body.Inn, '9729424935');
    assert.strictEqual(body.InvoiceId, 'tc-123456789-pay-1');
    assert.strictEqual(body.CustomerReceipt.Email, 'ivan.petrov@mail.ru');
    assert.strictEqual(body.CustomerReceipt.Items[0].PaymentAgentInfo.SupplierInn, ANEX.inn);
    assert.strictEqual(body.CustomerReceipt.Items[0].PaymentAgentInfo.SupplierName, ANEX.name);
    assert.strictEqual(body.CustomerReceipt.Items[0].PaymentAgentInfo.SupplierPhone, ANEX.phone);
    assert.strictEqual(body.CustomerReceipt.Items[0].Amount, 152340);
    setEnv();
});

test('/config: триггер payment; поставщик тура — из заказа; ключи lt помечены как неиспользуемые; без ИНН и телефонов', () => {
    setEnv({ ...LIVE_ENV, FERMA_SUPPLIERS: JSON.stringify({ 'lt:33': OP_SUPPLIER, lt: OP_SUPPLIER, arlekino: ARL_SUPPLIER }) });
    const pc = publicConfig(loadConfig());
    assert.strictEqual(pc.receiptTrigger, 'payment');
    assert.strictEqual(pc.receiptOnPayment, true);
    assert.strictEqual(pc.ltSupplierSource, 'order');
    assert.deepStrictEqual(pc.suppliersConfigured, ['arlekino']);
    assert.deepStrictEqual(pc.suppliersIgnored, ['lt:33', 'lt']);
    assert(!JSON.stringify(pc).includes(OP_SUPPLIER.inn) && !JSON.stringify(pc).includes('000-00'), 'значения поставщиков не показываются');
    setEnv({ FERMA_MODE: 'off' });
    assert.strictEqual(publicConfig(loadConfig()).receiptOnPayment, false);
    setEnv();
});

// ---------- callback ВТБ по-настоящему (подменены БД, LT, письма, касса) ----------
function loadVtbCallback(dbOrder) {
    const fired = [];
    const ltCalls = [];
    const stubs = {
        '../db': { query: async (sql) => (/^SELECT/.test(sql) ? [[dbOrder]] : [{ affectedRows: 1 }]) },
        axios: { post: async (url) => { ltCalls.push(url); return { status: 200, data: { ok: true } }; } },
        './callbackLogger': { logCallback: () => {}, logCallbackError: () => {} },
        '../lib/env': { requireEnv: () => 'lt-token' },
        '../lib/customRooms/vtbCheck': { canonicalPayStatus: (v) => String(v || '').toUpperCase() },
        '../lib/ferma/hooks': { firePaymentReceipt: (ctx) => fired.push(ctx) },
        '../lib/customRooms/bookings': { isInternalOrder: async () => false, onPaid: async () => null, onPaymentFailed: async () => null },
        './orderEmails': { sendOrderPaidPendingEmail: async () => null },
    };
    const file = path.join(root, 'utils/vtbCallback.js');
    delete require.cache[file];
    const orig = Module._load;
    Module._load = function (request, parent, isMain) {
        if (parent && parent.filename === file && Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
        return orig.call(this, request, parent, isMain);
    };
    try {
        const mod = require(file);
        return { mod, fired, ltCalls, restore: () => { Module._load = orig; } };
    } catch (e) {
        Module._load = orig;
        throw e;
    }
}
const payload = (status) => ({ type: 'PAYMENT', object: { paymentId: 'P1', orderId: 'ORDER123456789', status: { value: status }, amount: { value: '152340.00' }, sbpParams: { qrcId: 'Q1' } } });

test('Callback ВТБ: RECONCILED → чек; отказ банка, ожидание, возврат — касса не вызывается', async () => {
    const v = loadVtbCallback({ order_id: '123456789', pay_status: 'PENDING', transaction_code: 'Q0' });
    try {
        await v.mod.processVtbCallback(payload('RECONCILED'));
        assert.deepStrictEqual(v.fired, [{ orderId: '123456789', amount: 152340, transactionId: 'P1', via: 'vtb_callback' }]);
        for (const st of ['REJECTED', 'PENDING', 'EXPIRED']) await v.mod.processVtbCallback(payload(st));
        await v.mod.processVtbCallback({ type: 'REFUND', object: { paymentId: 'P1', orderId: 'ORDER123456789', status: { value: 'REFUNDED' }, amount: { value: '100' } } });
        assert.strictEqual(v.fired.length, 1, 'кроме подтверждённой оплаты — ни одного вызова кассы');
    } finally { v.restore(); }
});

test('Callback ВТБ: повтор RECONCILED (дубль) — снова вызов, но сервис вернёт тот же чек', async () => {
    const v = loadVtbCallback({ order_id: '123456789', pay_status: 'RECONCILED', transaction_code: 'Q1' });
    try {
        const r = await v.mod.processVtbCallback(payload('RECONCILED'));
        assert.strictEqual(r.duplicate, true);
        assert.strictEqual(v.fired.length, 1, 'дубль тоже доходит до кассы — пропущенный чек догоняется, второй не создаётся');
    } finally { v.restore(); }
});

test('Подключено: /check_pay (тур) и checkPay Arlekino — только при paid; бронирование чек после оплаты не вызывает', () => {
    const app = read('app.js');
    const cp = app.indexOf("app.post('/check_pay'");
    const cpEnd = app.indexOf('VTB check_pay error', cp);
    const h = app.slice(cp, cpEnd);
    assert(/if \(paid\) \{\s*require\('\.\/lib\/ferma\/hooks'\)\.firePaymentReceipt\(\{ orderId: resolved_order_id, amount, transactionId: transaction_id, via: 'check_pay' \}\);\s*\}/.test(h), '/check_pay: вызов при paid');
    assert(h.indexOf('firePaymentReceipt') > h.indexOf('UPDATE orders SET pay_status'), 'после записи статуса оплаты');
    assert(h.indexOf('firePaymentReceipt') > h.indexOf('checkSbpPayment(qrcId'), 'после проверки в банке');
    assert(!/await\s+require\('\.\/lib\/ferma\/hooks'\)/.test(app), 'оплату кассой не задерживаем');
    const cpkg = app.slice(app.indexOf("app.post('/create-package'"), app.indexOf("app.post('/validate-tourists'"));
    assert(!/firePaymentReceipt/.test(cpkg), 'при бронировании чек после оплаты не вызывается');
    const io = read('lib/customRooms/internalOrders.js');
    assert(/if \(info\.paid\) require\('\.\.\/ferma\/hooks'\)\.firePaymentReceipt\(\{ orderId, amount: info\.amount, transactionId: info\.transactionId, via: 'check_pay' \}\);/.test(io));
    assert(io.indexOf('firePaymentReceipt') > io.indexOf('checkSbpPayment(qrcId, orderId)'), 'Arlekino: после проверки в банке');
    const createPkg = io.slice(io.indexOf('async function createPackage'), io.indexOf('async function resolveInternalOrder'));
    assert(!/firePaymentReceipt/.test(createPkg));
    const vtb = read('utils/vtbCallback.js');
    assert.strictEqual((vtb.match(/firePaymentReceipt/g) || []).length, 1);
    const refund = vtb.slice(vtb.indexOf("if (type === 'REFUND')"));
    assert(!/firePaymentReceipt/.test(refund), 'возврат не пробивает чек прихода');
});

let finished = false;
process.on('exit', (code) => {
    if (!finished && code === 0) { console.log('check-ferma-payment: не все проверки завершились (зависший промис)'); process.exitCode = 1; }
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
    console.log(`check-ferma-payment: ${tests.length - failed}/${tests.length}`);
    if (failed) process.exit(1);
})();
