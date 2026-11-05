// Касса Ferma: поставщик агентского чека — юрлицо туроператора КОНКРЕТНОГО заказа Level.Travel.
//   node scripts/check-ferma-order-supplier.js
// Без npm install, без БД и без сети. Реквизиты — из настоящих ответов Level.Travel (packages/actualize,
// package_details) 05.11.2026: 6 туроператоров, 7 пакетов, туры и «только отель».
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const BASE_ENV = {
    FERMA_MODE: 'live', FERMA_BASE_URL: 'https://ferma.ofd.ru', FERMA_INN: '9729424935', FERMA_LOGIN: 'live-login',
    FERMA_PASSWORD: 'live-pass', FERMA_WORKER: '0', FERMA_RECEIPT_TRIGGER: 'payment',
};
function setEnv(over = {}) {
    for (const k of Object.keys(process.env)) if (k.startsWith('FERMA_')) delete process.env[k];
    Object.assign(process.env, BASE_ENV, over);
    for (const [k, v] of Object.entries(over)) if (v === undefined) delete process.env[k];
}
setEnv();

const OS = require(path.join(root, 'lib/ferma/orderSupplier'));
const hooks = require(path.join(root, 'lib/ferma/hooks'));
const { createMemoryStore } = require(path.join(root, 'lib/ferma/store'));
const { createService, TEST_SUPPLIER } = require(path.join(root, 'lib/ferma/service'));
const { createOrderSupplierController } = require(path.join(root, 'controllers/ferma.controller'));

// operator_organization, как его прислал Level.Travel (сырые строки: апострофы, пробелы, скобки в телефонах).
const LT_ORGS = [
    { op: 6, opName: 'Anex', org: { name: "ООО 'Анекс Туризм '", inn: '7743184470', phone: '+7(800) 775-5000' }, name: 'ООО "Анекс Туризм"', phone: '+78007755000' },
    { op: 7, opName: 'Biblio Globus', org: { name: 'ООО "БИБЛИО-ГЛОБУС ТУРОПЕРАТОР"', inn: '7731447686', phone: '+7(495) 109-2500' }, name: 'ООО "БИБЛИО-ГЛОБУС ТУРОПЕРАТОР"', phone: '+74951092500' },
    { op: 8, opName: 'ICS Travel', org: { name: "ООО 'АЙ СИ ЭС ГРУПП'", inn: '9729050180', phone: '+7(495) 748-4847' }, name: 'ООО "АЙ СИ ЭС ГРУПП"', phone: '+74957484847' },
    { op: 94, opName: 'Интурист', org: { name: "ООО 'Интурист'", inn: '7743329937', phone: '+7 (495) 933-55-77' }, name: 'ООО "Интурист"', phone: '+74959335577' },
    { op: 70, opName: 'FUN&SUN (ex. TUI)', org: { name: "ООО 'ТТ -Трэвел'", inn: '7714775020', phone: '+7(499) 116-3860' }, name: 'ООО "ТТ -Трэвел"', phone: '+74991163860' },
    { op: 78, opName: 'Level.Travel', org: { name: 'ООО «ТУРОПЕРАТОР ДИНАМИЧЕСКИЕ ПАКЕТЫ»', inn: '9710160781', phone: '+74951184050' }, name: 'ООО "ТУРОПЕРАТОР ДИНАМИЧЕСКИЕ ПАКЕТЫ"', phone: '+74951184050' },
    // тот же оператор 78, «только отель» — ДРУГОЕ юрлицо
    { op: 78, opName: 'Level.Travel', org: { name: "ООО 'Агентика Тревэл'", inn: '7703403951', phone: '+7(926) 391-2299' }, name: 'ООО "Агентика Тревэл"', phone: '+79263912299' },
];

/** Заказ, как его сохраняет /create-package (ответ LT /orders/create + наши поля покупателя). */
function ltOrder(id, s, { where = 'both', extra = {} } = {}) {
    const op = { id: s.op, name: s.opName, logo: 'https://img.cdn.level.travel/x.png' };
    const o = {
        id, full_price: 150000,
        package: { id: 410570000 + id % 1000, tour_id: `${String(s.op).padStart(3, '0')}-abc`, operator: op,
            hotel: { name: 'Hotel', city: 'Хургада' }, dates_info: { start_date: '2026-11-20', nights_count: 7 } },
        client: { name: 'Иван', email: 'ivan.petrov@mail.ru', phone: '79161234567' },
        _customer_email: 'ivan.petrov@mail.ru', _customer_phone: '79161234567', _customer_name: 'Иван Петров',
        ...extra,
    };
    if (where === 'both' || where === 'top') o.operator_organization = { ...s.org };
    if (where === 'both' || where === 'package') o.package.operator_organization = { ...s.org };
    return o;
}
const PII = ['ivan.petrov', '79161234567', 'Петров'];
const noPii = (x, where) => { const t = JSON.stringify(x); for (const p of PII) assert(!t.includes(p), `${where}: «${p}»`); };

const now = (fn) => fn();
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
            return { Status: 'Success', Data: { StatusCode: 2, StatusName: 'CONFIRMED', ReceiptId: receiptId, Device: { OfdReceiptUrl: `https://check.ofd.ru/rec/${receiptId}` } } };
        },
    };
}
/** Сервер в памяти: заказы, поставщики, журнал блокировок, касса. */
function world() {
    const orders = new Map();
    const store = OS.createMemorySupplierStore();
    const blocked = OS.createMemoryBlockedStore();
    const client = fakeClient();
    const fstore = createMemoryStore();
    const service = createService({ client, store: fstore, sleep: async () => {}, log: () => {} });
    const logs = [];
    const log = (m) => logs.push(m);
    const hook = hooks.createPaymentHook({
        getFerma: () => ({ service }), defer: now, log,
        loadOrder: async (id) => ({ source: 'lt', orderData: orders.get(String(id)) || null, booking: null }),
        resolveOrderSupplier: (id, data) => OS.resolveLtOrderSupplier(id, data, { store, log }),
        blocked, getSuppliers: () => process.env.FERMA_SUPPLIERS,
    });
    /** Как /create-package: записать заказ и сохранить реквизиты. */
    const create = async (id, data) => { orders.set(String(id), data); return OS.captureLtOrderSupplier(id, data, { store, log }); };
    return { orders, store, blocked, client, fstore, logs, hook, create };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('Настоящие ответы Level.Travel: 7 пакетов, 6 туроператоров — реквизиты распознаны, ИНН верные, наименование и телефон приведены', () => {
    LT_ORGS.forEach((s, i) => {
        for (const where of ['both', 'top', 'package']) {
            const snap = OS.buildSnapshot(String(1000 + i), ltOrder(1000 + i, s, { where }), 'lt_order_create');
            assert.strictEqual(snap.status, 'ok', `${s.opName} (${where}): ${snap.problems}`);
            assert.strictEqual(snap.supplier_inn, s.org.inn);
            assert.strictEqual(snap.supplier_name, s.name);
            assert.strictEqual(snap.supplier_phone, s.phone);
            assert.strictEqual(snap.operator_id, String(s.op));
            noPii(snap, s.opName);
        }
    });
});

test('Нет / ошибка в реквизитах — missing / invalid с понятной причиной', () => {
    const s = LT_ORGS[0];
    let snap = OS.buildSnapshot('1', ltOrder(1, s, { where: 'none' }), 'lt_order_create');
    assert.strictEqual(snap.status, 'missing');
    assert.strictEqual(OS.describeSnapshot(snap), 'Заказ 1: туроператор «Anex» (id 6) — Level.Travel не передал реквизиты туроператора (operator_organization). Чек не пробит');
    const bad = (org) => OS.buildSnapshot('2', ltOrder(2, { ...s, org }, { where: 'top' }), 'x');
    assert.deepStrictEqual(bad({ ...s.org, inn: '7743184471' }).problems, ['inn_invalid']);
    assert.deepStrictEqual(bad({ ...s.org, inn: '' }).problems, ['inn_missing']);
    assert.deepStrictEqual(bad({ ...s.org, name: '  ' }).problems, ['name_missing']);
    assert.deepStrictEqual(bad({ ...s.org, phone: null }).problems, ['phone_missing']);
    assert.deepStrictEqual(bad({ ...s.org, phone: '12' }).problems, ['phone_invalid']);
    assert.strictEqual(bad({ ...s.org, inn: '7743184471' }).status, 'invalid');
    assert(/ИНН 7743184471 — ИНН туроператора не проходит проверку контрольных цифр/.test(OS.describeSnapshot(bad({ ...s.org, inn: '7743184471' }))));
    // два разных юрлица в одном заказе — не угадываем
    const o = ltOrder(3, s, { where: 'top' });
    o.package.operator_organization = { ...LT_ORGS[1].org };
    snap = OS.buildSnapshot('3', o, 'x');
    assert.strictEqual(snap.status, 'invalid');
    assert(snap.problems.includes('organization_conflict'));
});

test('Номер туроператора: package.operator → operator → operator_id → префикс tour_id', () => {
    assert.deepStrictEqual(OS.extractOperator({ package: { operator: { id: 6, name: 'Anex' } } }), { id: '6', name: 'Anex' });
    assert.strictEqual(OS.extractOperator({ operator: { id: 33 } }).id, '33');
    assert.strictEqual(OS.extractOperator({ package: { operator_id: 78 } }).id, '78');
    assert.strictEqual(OS.extractOperator({ package: { tour_id: '094-4372f94b' } }).id, '94');
    assert.strictEqual(OS.extractOperator({}).id, null);
});

test('Каждый заказ — свой поставщик: 7 заказов, 7 разных ИНН; оператор 78 — два разных юрлица', async () => {
    const w = world();
    for (let i = 0; i < LT_ORGS.length; i++) await w.create(500 + i, ltOrder(500 + i, LT_ORGS[i]));
    for (let i = 0; i < LT_ORGS.length; i++) {
        const r = await w.hook({ orderId: 500 + i, amount: 150000, via: 'vtb_callback' });
        assert.strictEqual(r.ok, true, `заказ ${500 + i}`);
    }
    const sent = w.client.sent.map((b) => [b.Request.InvoiceId, b.Request.CustomerReceipt.Items[0].PaymentAgentInfo.SupplierInn]);
    assert.deepStrictEqual(sent, LT_ORGS.map((s, i) => [`tc-${500 + i}-pay-1`, s.org.inn]));
    assert.strictEqual(new Set(sent.map((x) => x[1])).size, 7, 'ни одного общего поставщика');
    const item = w.client.sent[0].Request.CustomerReceipt.Items[0].PaymentAgentInfo;
    assert.deepStrictEqual(item, { AgentType: 'AGENT', SupplierInn: '7743184470', SupplierName: 'ООО "Анекс Туризм"', SupplierPhone: '+78007755000' });
    assert(w.logs.some((l) => /payment order=500 .* supplier=7743184470/.test(l)));
});

test('FERMA_SUPPLIERS с ключами lt / lt:<id> НЕ подменяет реквизиты заказа', async () => {
    setEnv({ FERMA_SUPPLIERS: JSON.stringify({ lt: { inn: '7707083893', name: 'ООО "Чужой"', phone: '+74950000001' }, 'lt:6': { inn: '7707083893', name: 'ООО "Чужой"', phone: '+74950000001' } }) });
    const w = world();
    await w.create(600, ltOrder(600, LT_ORGS[0]));
    await w.hook({ orderId: 600, amount: 1000, via: 'check_pay' });
    assert.strictEqual(w.client.sent[0].Request.CustomerReceipt.Items[0].PaymentAgentInfo.SupplierInn, '7743184470');
    // заказ без реквизитов — ключи lt тоже не помогают
    await w.create(601, ltOrder(601, LT_ORGS[0], { where: 'none' }));
    const r = await w.hook({ orderId: 601, amount: 1000, via: 'check_pay' });
    assert.deepStrictEqual(r, { skipped: 'supplier_missing' });
    assert.strictEqual(w.client.sent.length, 1, 'по заказу без реквизитов в Ferma ничего не ушло');
    setEnv();
});

test('Снимок при создании заказа не перезаписывается: вебхук переписал orders.package — чек всё равно по реквизитам продажи', async () => {
    const w = world();
    await w.create(700, ltOrder(700, LT_ORGS[1]));
    // вебхук Level.Travel заменил заказ данными без operator_organization
    const after = ltOrder(700, LT_ORGS[1], { where: 'none' });
    w.orders.set('700', after);
    await OS.captureLtOrderSupplier(700, after, { store: w.store, log: () => {} });
    assert.strictEqual((await w.store.get(700)).supplier_inn, '7731447686', 'первая запись осталась');
    const r = await w.hook({ orderId: 700, amount: 1000, via: 'vtb_callback' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(w.client.sent[0].Request.CustomerReceipt.Items[0].PaymentAgentInfo.SupplierInn, '7731447686');
});

test('Туроператор заказа сменился, а реквизиты — от другого → supplier_mismatch, чек не пробит', async () => {
    const w = world();
    await w.create(710, ltOrder(710, LT_ORGS[0]));
    const changed = ltOrder(710, LT_ORGS[1]); // теперь в заказе оператор 7
    w.orders.set('710', changed);
    const r = await w.hook({ orderId: 710, amount: 1000, via: 'check_pay' });
    assert.deepStrictEqual(r, { skipped: 'supplier_mismatch' });
    assert.strictEqual(w.client.sent.length, 0);
    const b = (await w.blocked.list({})).rows[0];
    assert.strictEqual(b.reason, 'supplier_mismatch');
    assert(/туроператор заказа \(id 7\) не совпадает с сохранёнными реквизитами \(id 6, ИНН 7743184470\)/.test(b.message), b.message);
});

test('Нет реквизитов: оплата → fiscal_blocked; позже реквизиты появились в этом же заказе → чек, блокировка закрыта', async () => {
    const w = world();
    await w.create(720, ltOrder(720, LT_ORGS[2], { where: 'none' }));
    assert.strictEqual((await w.store.get(720)).status, 'missing');
    let r = await w.hook({ orderId: 720, amount: 2500.5, via: 'vtb_callback' });
    assert.deepStrictEqual(r, { skipped: 'supplier_missing' });
    r = await w.hook({ orderId: 720, amount: 2500.5, via: 'check_pay' });
    let b = (await w.blocked.list({})).rows;
    assert.strictEqual(b.length, 1);
    assert.strictEqual(b[0].attempts, 2);
    assert.strictEqual(b[0].amount_kop, 250050);
    assert.strictEqual(b[0].via, 'check_pay');
    noPii(b, 'fiscal_blocked');
    w.orders.set('720', ltOrder(720, LT_ORGS[2]));
    r = await w.hook({ orderId: 720, amount: 2500.5, via: 'check_pay' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(w.client.sent[0].Request.CustomerReceipt.Items[0].PaymentAgentInfo.SupplierInn, '9729050180');
    assert.strictEqual((await w.store.get(720)).status, 'ok', 'снимок обновлён до исправного');
    assert.strictEqual((await w.blocked.list({})).total, 0, 'открытых блокировок нет');
    b = (await w.blocked.list({ open: false })).rows[0];
    assert(b.resolved_at && b.receipt_id === 1);
});

test('Неверный ИНН от Level.Travel → supplier_invalid, чек не пробит', async () => {
    const w = world();
    await w.create(730, ltOrder(730, { ...LT_ORGS[3], org: { ...LT_ORGS[3].org, inn: '7743329938' } }));
    const r = await w.hook({ orderId: 730, amount: 1000, via: 'check_pay' });
    assert.deepStrictEqual(r, { skipped: 'supplier_invalid' });
    assert.strictEqual(w.client.sent.length, 0);
});

test('Заказ до выкладки (снимка нет) — реквизиты из orders.package этого же заказа; хранилище недоступно — тоже, без падения', async () => {
    const w = world();
    w.orders.set('740', ltOrder(740, LT_ORGS[4]));
    const r = await w.hook({ orderId: 740, amount: 1000, via: 'vtb_callback' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual((await w.store.get(740)).origin, 'lt_order_package');
    const broken = { get: async () => { throw new Error('db down'); }, insertIfAbsent: async () => { throw new Error('db down'); }, upgrade: async () => false };
    const logs = [];
    const res = await OS.resolveLtOrderSupplier(741, ltOrder(741, LT_ORGS[5]), { store: broken, log: (m) => logs.push(m) });
    assert.strictEqual(res.supplier.inn, '9710160781');
    assert(/хранилище недоступно/.test(logs.join(' ')) || /не сохранён/.test(logs.join(' ')));
});

test('test-режим без изменений: тестовый поставщик и тестовая почта; о проблеме с реквизитами — предупреждение в логе', async () => {
    setEnv({ FERMA_MODE: 'test', FERMA_BASE_URL: 'https://ferma-test.ofd.ru', FERMA_INN: '3245001416' });
    const w = world();
    await w.create(800, ltOrder(800, LT_ORGS[0]));
    await w.create(801, ltOrder(801, LT_ORGS[0], { where: 'none' }));
    assert.strictEqual((await w.hook({ orderId: 800, amount: 10, via: 'check_pay' })).ok, true);
    assert.strictEqual((await w.hook({ orderId: 801, amount: 10, via: 'check_pay' })).ok, true, 'в test чек на стенд уходит как раньше');
    for (const b of w.client.sent) {
        assert.strictEqual(b.Request.CustomerReceipt.Items[0].PaymentAgentInfo.SupplierInn, TEST_SUPPLIER.inn);
        assert.strictEqual(b.Request.CustomerReceipt.Email, 'test@example.com');
    }
    assert(w.logs.some((l) => /payment order=801 .*в боевом режиме чек не пробился бы: supplier_missing/.test(l)));
    setEnv();
});

test('Arlekino без изменений: поставщик из FERMA_SUPPLIERS.arlekino, order_suppliers не используется', async () => {
    setEnv({ FERMA_SUPPLIERS: JSON.stringify({ arlekino: { inn: '9729424935', name: 'ООО "Продавец размещения"', phone: '+7 495 000-00-02' } }) });
    let called = 0;
    const client = fakeClient();
    const service = createService({ client, store: createMemoryStore(), sleep: async () => {}, log: () => {} });
    const hook = hooks.createPaymentHook({
        getFerma: () => ({ service }), defer: now, log: () => {}, blocked: OS.createMemoryBlockedStore(),
        resolveOrderSupplier: async () => { called++; return { error: 'supplier_missing' }; },
        loadOrder: async () => ({ source: 'arlekino', orderData: {}, booking: { orderId: '900000007', finalPrice: 450, contact: { email: 'a@b.ru' } } }),
    });
    const r = await hook({ orderId: '900000007', amount: 450, via: 'check_pay' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(called, 0);
    assert.strictEqual(client.sent[0].Request.CustomerReceipt.Items[0].PaymentAgentInfo.SupplierInn, '9729424935');
    setEnv();
});

test('Ошибка журнала блокировок не ломает оплату и чек', async () => {
    const w = world();
    const failing = { record: async () => { throw new Error('db down'); }, resolve: async () => { throw new Error('db down'); }, list: async () => ({ rows: [], total: 0 }) };
    const logs = [];
    const hook = hooks.createPaymentHook({
        getFerma: () => ({ service: { issue: async () => ({ ok: true, row: { id: 1, state: 'confirmed', invoice_id: 'tc-1-pay-1' } }) } }),
        defer: now, log: (m) => logs.push(m), blocked: failing,
        loadOrder: async () => ({ source: 'lt', orderData: ltOrder(1, LT_ORGS[0], { where: 'none' }), booking: null }),
        resolveOrderSupplier: (id, d) => OS.resolveLtOrderSupplier(id, d, { store: w.store, log: () => {} }),
    });
    assert.deepStrictEqual(await hook({ orderId: 1, amount: 1, via: 'check_pay' }), { skipped: 'supplier_missing' });
    assert(logs.some((l) => /fiscal_blocked record: db down/.test(l)));
});

test('Админка: /order-suppliers, /orders/:id/supplier, /blocked — статусы и понятные причины', async () => {
    const w = world();
    await w.create(900, ltOrder(900, LT_ORGS[0]));
    await w.create(901, ltOrder(901, LT_ORGS[1], { where: 'none' }));
    await w.hook({ orderId: 901, amount: 1500, via: 'vtb_callback' });
    const c = createOrderSupplierController({
        supplierStore: w.store, blockedStore: w.blocked,
        loadOrder: async (id) => (String(id).startsWith('9000')
            ? { source: 'arlekino', orderData: {}, booking: {} }
            : { source: 'lt', orderData: w.orders.get(String(id)) || null, booking: null }),
        getSuppliers: () => '',
    });
    const call = async (h, req) => {
        const res = { code: 200, body: null, status(c2) { this.code = c2; return this; }, json(b) { this.body = b; return this; } };
        await h({ query: {}, params: {}, ...req }, res);
        return res;
    };
    let res = await call(c.orderSuppliers, { query: { status: 'missing' } });
    assert.strictEqual(res.body.total, 1);
    assert.strictEqual(res.body.items[0].orderId, '901');
    assert(/Level.Travel не передал реквизиты/.test(res.body.items[0].message));
    assert.strictEqual((await call(c.orderSuppliers, { query: { status: 'bad' } })).code, 400);

    res = await call(c.orderSupplier, { params: { orderId: '900' } });
    assert.strictEqual(res.body.canIssue, true);
    assert.deepStrictEqual(res.body.saved.supplier, { inn: '7743184470', name: 'ООО "Анекс Туризм"', phone: '+78007755000' });
    res = await call(c.orderSupplier, { params: { orderId: '901' } });
    assert.strictEqual(res.body.canIssue, false);
    assert.strictEqual(res.body.error, 'supplier_missing');
    assert.strictEqual(res.body.blocked.length, 1);
    assert.strictEqual((await call(c.orderSupplier, { params: { orderId: '999' } })).code, 404);
    assert.strictEqual((await call(c.orderSupplier, { params: { orderId: '1/2' } })).code, 400);
    res = await call(c.orderSupplier, { params: { orderId: '900000007' } });
    assert.strictEqual(res.body.source, 'arlekino');
    assert.strictEqual(res.body.error, 'no_supplier:arlekino');

    res = await call(c.blocked, {});
    assert.strictEqual(res.body.total, 1);
    assert.deepStrictEqual(
        { orderId: res.body.items[0].orderId, reason: res.body.items[0].reason, amount: res.body.items[0].amount, via: res.body.items[0].via },
        { orderId: '901', reason: 'supplier_missing', amount: 1500, via: 'vtb_callback' },
    );
    noPii(res.body, 'ответ /blocked');
    // GET не записывает: заказа без снимка нет в order_suppliers после просмотра
    w.orders.set('950', ltOrder(950, LT_ORGS[3]));
    await call(c.orderSupplier, { params: { orderId: '950' } });
    assert.strictEqual(await w.store.get(950), null, 'просмотр в админке ничего не сохраняет');
});

test('MySQL: таблицы создаются сами; первая запись побеждает (INSERT IGNORE); замена только не-ok снимка', async () => {
    const sqls = [];
    const db = { query: async (sql, params) => { sqls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params }); return /^\s*SELECT COUNT/.test(sql) ? [[{ total: 0 }]] : [/^\s*SELECT/.test(sql) ? [] : { affectedRows: 1 }]; } };
    const st = OS.createMysqlSupplierStore(db);
    const snap = OS.buildSnapshot('1', ltOrder(1, LT_ORGS[0]), 'lt_order_create');
    assert.strictEqual(await st.insertIfAbsent(snap), true);
    await st.upgrade(snap);
    await st.get('1');
    const bl = OS.createMysqlBlockedStore(db);
    await bl.record({ orderId: '1', mode: 'live', source: 'lt', reason: 'supplier_missing', message: 'm', via: 'check_pay', amountKop: 100 });
    await bl.resolve({ orderId: '1', mode: 'live', receiptId: 5 });
    const all = sqls.map((x) => x.sql).join('\n');
    assert(/CREATE TABLE IF NOT EXISTS order_suppliers/.test(all));
    assert(/CREATE TABLE IF NOT EXISTS fiscal_blocked/.test(all));
    assert(/INSERT IGNORE INTO order_suppliers/.test(all));
    assert(/UPDATE order_suppliers SET .* WHERE order_id = \? AND status <> 'ok'/.test(all));
    assert(/ON DUPLICATE KEY UPDATE .*attempts = attempts \+ 1/.test(all));
    assert(/UPDATE fiscal_blocked SET resolved_at = \?, receipt_id = \? WHERE order_id = \? AND kind = \? AND mode = \? AND resolved_at IS NULL/.test(all));
    const ins = sqls.find((x) => /INSERT IGNORE/.test(x.sql));
    noPii(ins.params, 'INSERT order_suppliers');
    assert(ins.params.includes('7743184470'));
});

test('Подключено: /create-package сохраняет реквизиты после записи заказа, не ждёт; маршруты только для staff', () => {
    const app = read('app.js');
    const h = app.slice(app.indexOf("app.post('/create-package'"), app.indexOf("app.post('/validate-tourists'"));
    const call = h.indexOf("require('./lib/ferma/orderSupplier').fireCaptureLtOrderSupplier(order_id, orderData);");
    assert(call > 0, 'вызов в /create-package');
    assert(call > h.lastIndexOf("'INSERT INTO orders (order_id, package, user_id) VALUES (?, ?, ?)'"), 'после записи заказа');
    assert(call < h.indexOf('res.json(response.data)'), 'до ответа');
    assert(!/await\s+require\('\.\/lib\/ferma\/orderSupplier'\)/.test(app), 'бронирование не ждёт');
    assert.strictEqual((app.match(/fireCaptureLtOrderSupplier/g) || []).length, 1);
    const routes = read('routes/ferma.routes.js');
    const staff = routes.indexOf('adminRouter.use(requireStaff)');
    for (const r of ["adminRouter.get('/order-suppliers'", "adminRouter.get('/orders/:orderId/supplier'", "adminRouter.get('/blocked'"]) {
        assert(routes.indexOf(r) > staff, `${r} — после requireStaff`);
    }
    const hooksSrc = read('lib/ferma/hooks.js');
    assert(!/\[`lt:\$\{|'lt'\]/.test(hooksSrc), 'в hooks нет ключей lt / lt:<id> для поставщика');
});

let finished = false;
process.on('exit', (code) => {
    if (!finished && code === 0) { console.log('check-ferma-order-supplier: не все проверки завершились'); process.exitCode = 1; }
});
(async () => {
    let failed = 0;
    for (const t of tests) {
        try {
            await t.fn();
            console.log(`  ✓ ${t.name}`);
        } catch (err) {
            failed++;
            console.log(`  ✗ ${t.name}\n    ${err.stack.split('\n').slice(0, 3).join('\n    ')}`);
        }
    }
    finished = true;
    setEnv();
    console.log(`check-ferma-order-supplier: ${tests.length - failed}/${tests.length}`);
    if (failed) process.exit(1);
})();
