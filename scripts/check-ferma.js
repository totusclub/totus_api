// Онлайн-касса Ferma: сборка чеков, клиент, сервис, хранилище, контроллер. Без npm install, без БД и без сети:
//   node scripts/check-ferma.js
// Эмулятор Ferma повторяет поведение тестового стенда ferma-test.ofd.ru (проверено 20.10.2026):
// токен UUID, 1019 + ExistingReceiptId при повторе InvoiceId, 1085 при неверном ИНН поставщика,
// 1010 при системе налогообложения не из регистрации, KKT_ERROR при Price × Quantity ≠ Amount,
// 401 / 1001 при чужом токене, 1004 при неизвестном чеке.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

// ---------- окружение ----------
const BASE_ENV = {
    FERMA_MODE: 'test', FERMA_BASE_URL: 'https://ferma-test.ofd.ru', FERMA_LOGIN: 'stand-login', FERMA_PASSWORD: 'stand-secret-pass',
    FERMA_INN: '3245001416', FERMA_TAXATION_SYSTEM: 'Common', FERMA_CALLBACK_BASE: 'https://api.totus.club', FERMA_CALLBACK_SECRET: 'cb-secret-123',
    FERMA_WORKER: '0',
};
function setEnv(over = {}) {
    for (const k of Object.keys(process.env)) if (k.startsWith('FERMA_')) delete process.env[k];
    Object.assign(process.env, BASE_ENV, over);
}
setEnv();

// ---------- поддельная БД (для lib/ferma/index → db.js и MySQL-хранилища) ----------
const dbPath = path.join(root, 'db.js');
function createFakeDb() {
    const rows = [];
    const sqls = [];
    const where = (s, params) => {
        // поддерживаем ровно те формы, что пишет lib/ferma/store.js
        let p = 0;
        const conds = [];
        const w = s.match(/ WHERE (.*?)(?: ORDER BY| LIMIT|$)/);
        if (!w) return { filter: () => true, used: 0 };
        for (const part of w[1].split(' AND ')) {
            const m = part.match(/^(\w+) (=|<=|>=|<) \?$/);
            if (m) { const v = params[p++]; conds.push((r) => cmp(r[m[1]], m[2], v)); continue; }
            if (/^state IN \('draft', 'sent', 'send_failed'\)$/.test(part)) { conds.push((r) => ['draft', 'sent', 'send_failed'].includes(r.state)); continue; }
            throw new Error(`fake db: unsupported condition ${part}`);
        }
        return { filter: (r) => conds.every((c) => c(r)), used: p };
    };
    function cmp(a, op, b) {
        const x = a instanceof Date ? a.getTime() : a;
        const y = b instanceof Date ? b.getTime() : b;
        if (op === '=') return String(x) === String(y);
        if (x == null) return false;
        if (op === '<=') return x <= y;
        if (op === '>=') return x >= y;
        return x < y;
    }
    return {
        rows, sqls,
        async query(sql, params = []) {
            const s = sql.replace(/\s+/g, ' ').trim();
            sqls.push(s);
            if (/^CREATE TABLE IF NOT EXISTS fiscal_receipts/.test(s)) return [{}];
            let m = s.match(/^INSERT INTO fiscal_receipts \((.+)\) VALUES \((.+)\)$/);
            if (m) {
                const cols = m[1].split(', ');
                assert.strictEqual(cols.length, params.length, 'INSERT: число колонок = числу значений');
                const row = { id: rows.length + 1, parent_id: null, receipt_id: null };
                cols.forEach((c, i) => { row[c] = params[i]; });
                if (rows.some((r) => r.invoice_id === row.invoice_id)) { const e = new Error('dup'); e.code = 'ER_DUP_ENTRY'; throw e; }
                rows.push(row);
                return [{ insertId: row.id, affectedRows: 1 }];
            }
            m = s.match(/^UPDATE fiscal_receipts SET (.+) WHERE id = \?$/);
            if (m) {
                const cols = m[1].split(', ').map((c) => c.replace(' = ?', ''));
                const row = rows.find((r) => r.id === params[params.length - 1]);
                if (row) cols.forEach((c, i) => { row[c] = params[i]; });
                return [{ affectedRows: row ? 1 : 0 }];
            }
            if (/^SELECT COUNT\(\*\) AS total FROM fiscal_receipts/.test(s)) {
                const { filter } = where(s, params);
                return [[{ total: rows.filter(filter).length }]];
            }
            if (/^SELECT \* FROM fiscal_receipts/.test(s)) {
                const { filter, used } = where(s, params);
                let out = rows.filter(filter);
                if (/ORDER BY attempt DESC, id DESC/.test(s)) out.sort((a, b) => b.attempt - a.attempt || b.id - a.id);
                if (/ORDER BY id DESC/.test(s)) out.sort((a, b) => b.id - a.id);
                if (/ORDER BY next_check_at, id/.test(s)) out.sort((a, b) => a.next_check_at - b.next_check_at || a.id - b.id);
                const lim = s.match(/LIMIT (\?|\d+)(?: OFFSET \?)?$/);
                if (lim) {
                    const limit = lim[1] === '?' ? params[used] : Number(lim[1]);
                    const offset = / OFFSET \?$/.test(s) ? params[used + 1] : 0;
                    out = out.slice(offset, offset + limit);
                }
                return [out.map((r) => ({ ...r }))];
            }
            throw new Error(`fake db: unexpected sql ${s}`);
        },
    };
}
const fakeDb = createFakeDb();
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };

const { loadConfig, configProblems, publicConfig, canIssueTestReceipts } = require(path.join(root, 'lib/ferma/config'));
const R = require(path.join(root, 'lib/ferma/receipt'));
const { createClient, FermaError } = require(path.join(root, 'lib/ferma/client'));
const { createMemoryStore, createMysqlStore } = require(path.join(root, 'lib/ferma/store'));
const { createService, serializeRow } = require(path.join(root, 'lib/ferma/service'));
const { createFermaController, isFermaIp } = require(path.join(root, 'controllers/ferma.controller'));

// ---------- часы ----------
function createClock(start = Date.parse('2026-10-21T12:00:00Z')) {
    let t = start;
    return { now: () => new Date(t), ms: () => t, advance: (ms) => { t += ms; }, sleep: async (ms) => { t += Math.max(ms, 1); } };
}

// ---------- эмулятор Ferma ----------
function createFermaEmulator(clock, { inn = '3245001416', login = 'stand-login', password = 'stand-secret-pass' } = {}) {
    const receipts = new Map(); // ReceiptId → { invoiceId, request, polls, status, desc }
    const byInvoice = new Map();
    const tokens = new Set();
    const calls = [];
    const faults = []; // очередь: { path, kind: 'network'|'timeout'|'5xx'|'lost'|'reject1085'|'kkt' }
    const emu = { receipts, calls, faults, tokens, foreign: [] };
    const reply = (status, json) => ({ status, text: async () => JSON.stringify(json) });
    const fail = (status, code, message, data) => reply(status, { Status: 'Failed', Error: { Code: code, Message: message }, ...(data ? { Data: data } : {}) });
    const statusData = (rid) => {
        const r = receipts.get(rid);
        const base = { StatusCode: r.status, StatusName: { 0: 'NEW', 1: 'PROCESSED', 2: 'CONFIRMED', 3: 'KKT_ERROR' }[r.status],
            StatusMessage: { 0: 'запрос на чек принят Фермой', 2: 'Чек передан в ОФД', 3: 'Ошибка пробития чека на кассе' }[r.status],
            ReceiptId: rid, InvoiceId: r.invoiceId, ModifiedDateUtc: '2026-10-21T15:00:00', ReceiptDateTimeIso: r.status === 2 ? '2026-10-21T15:00:00+03:00[Europe/Moscow]' : null };
        if (r.status === 3) base.Description = r.desc;
        base.Device = r.status === 2 ? { DeviceId: 9446, RNM: '0000000001015454', FN: '9999078902009656', FDN: String(r.fdn), FPD: String(1000000 + r.fdn), OfdReceiptUrl: `https://check-demo.ofd.ru/rec/9999078902009656/${r.fdn}/${1000000 + r.fdn}` } : null;
        return base;
    };
    let fdn = 146800;
    emu.fetch = async (url, opts = {}) => {
        const u = new URL(url);
        const p = u.pathname;
        const body = opts.body ? JSON.parse(opts.body) : null;
        calls.push({ path: p, body, token: u.searchParams.get('AuthToken') });
        const fi = faults.findIndex((f) => f.path === p);
        const fault = fi >= 0 ? faults.splice(fi, 1)[0] : null;
        if (fault && fault.kind === 'network') throw new TypeError('fetch failed');
        if (fault && fault.kind === 'timeout') { const e = new Error('timeout'); e.name = 'TimeoutError'; throw e; }
        if (fault && fault.kind === '5xx') return fail(500, 3, 'Нет свободных касс');
        if (p === '/api/Authorization/CreateAuthToken') {
            if (body.Login !== login || body.Password !== password) return fail(500, 2, 'Неверный логин, пароль');
            const t = crypto.randomUUID();
            tokens.add(t);
            const exp = new Date(clock.ms() + 21 * 3600e3).toISOString().slice(0, 19);
            return reply(200, { Status: 'Success', Data: { AuthToken: t, ExpirationDateUtc: exp } });
        }
        if (!tokens.has(u.searchParams.get('AuthToken'))) return fail(401, 1001, 'Клиент не авторизован');
        if (p === '/api/kkt/cloud/receipt') {
            const rq = body.Request;
            if (rq.Inn !== inn) return fail(400, 1007, 'Некорректный ИНН');
            if (!['Common', 'SimpleIn', 'SimpleInOut', 'UnifiedAgricultural', 'Patent'].includes(rq.CustomerReceipt.TaxationSystem)) return fail(400, 1010, 'Некорректный тип налогообложения (TaxationSystem)');
            if (byInvoice.has(rq.InvoiceId)) {
                const ex = byInvoice.get(rq.InvoiceId);
                return fail(400, 1019, `Идентификатор счета уже существует (${rq.InvoiceId})`, { InvoiceId: rq.InvoiceId, ExistingReceiptId: ex, ExistingReceiptIds: null });
            }
            for (const [i, it] of rq.CustomerReceipt.Items.entries()) {
                const ai = it.PaymentAgentInfo;
                if (ai && !/^\d{10}$|^\d{12}$/.test(ai.SupplierInn)) {
                    return fail(400, 1085, 'Запрос содержит ошибки', { ValidationErrors: [{ FieldName: `receipt.customerReceipt.receiptItems[${i}].paymentAgentInfo.supplierInn`, Description: 'Неверно указан ИНН' }] });
                }
            }
            if (fault && fault.kind === 'reject1085') return fail(400, 1085, 'Запрос содержит ошибки', { ValidationErrors: [{ FieldName: 'receipt.customerReceipt', Description: 'тест' }] });
            const rid = crypto.randomUUID();
            const it = rq.CustomerReceipt.Items[0];
            const mismatch = Math.round(it.Price * it.Quantity * 100) !== Math.round(it.Amount * 100);
            fdn += 1;
            receipts.set(rid, { invoiceId: rq.InvoiceId, request: body, polls: 0, status: 0, kkt: mismatch || (fault && fault.kind === 'kkt'), desc: 'Сумма не наличных оплат превышает сумму чека', fdn });
            byInvoice.set(rq.InvoiceId, rid);
            if (fault && fault.kind === 'lost') throw new TypeError('fetch failed'); // чек создан, ответ потерян
            return reply(200, { Status: 'Success', Data: { ReceiptId: rid } });
        }
        if (p === '/api/kkt/cloud/status') {
            const rid = body.Request.ReceiptId || byInvoice.get(body.Request.InvoiceId);
            if (!rid || !receipts.has(rid)) return fail(404, 1004, 'Объект не найден');
            const r = receipts.get(rid);
            r.polls += 1;
            if (r.status === 0 && r.polls >= 2) r.status = r.kkt ? 3 : 2;
            const d = statusData(rid);
            if (!body.Request.ReceiptId) delete d.ReceiptId;
            return reply(200, { Status: 'Success', Data: d });
        }
        if (p === '/api/kkt/cloud/list2') {
            const only = body.Request && body.Request.ReceiptId;
            const data = [...receipts.entries()].filter(([rid]) => !only || rid === only).map(([rid, r]) => ({ ReceiptId: rid, InvoiceId: r.invoiceId, StatusCode: r.status, StatusName: 'Чек передан в ОФД', StatusMessage: 'CONFIRMED', Receipt: { cashboxInfoHolder: { totalSum: r.request.Request.CustomerReceipt.Items[0].Amount } } }));
            emu.list2Calls = (emu.list2Calls || 0) + 1;
            return reply(200, { Status: 'Success', Data: only ? data : [...data, ...emu.foreign] });
        }
        if (p === '/api/kkt/cloud/stats/cashboxes/extended') {
            return reply(200, { Status: 'Success', Data: emu.cashboxes || [
                { deviceId: 9446, fn: '9999078902009656', rnm: '0000000001015454', kktModel: 'Эфир Pro ФС', kktState: 'Готова к работе', inn, ffdVersion: '1.2', isAgent: true, isInternet: true, taxModeMask: '110111', agentModeMask: '01111111', paymentPlace: 'ofd.ru/1', tariffEndDate: null, fnVolumePercent: null },
                { deviceId: 6525, kktState: 'Заменен ФН', inn, ffdVersion: '1.2', isAgent: false, isInternet: false },
            ] });
        }
        if (p === '/api/kkt/cloud/stats/receipts/queue/length') return reply(200, { Status: 'Success', Data: { Length: 0, UpdateTime: '2026-10-21T12:00:00Z' } });
        return fail(404, 1004, 'Объект не найден');
    };
    emu.count = (p) => calls.filter((c) => c.path === p).length;
    emu.forget = () => { receipts.clear(); byInvoice.clear(); };
    return emu;
}

function setup({ store = createMemoryStore(), env = {} } = {}) {
    setEnv(env);
    const clock = createClock();
    const emu = createFermaEmulator(clock);
    const logs = [];
    const log = (...a) => logs.push(a.join(' '));
    const client = createClient({ fetch: emu.fetch, now: clock.ms, log });
    const service = createService({ client, store, now: clock.now, sleep: clock.sleep, log });
    return { clock, emu, client, store, service, logs };
}

function res() {
    const r = { statusCode: 200, body: null };
    r.status = (c) => { r.statusCode = c; return r; };
    r.json = (b) => { r.body = b; return r; };
    return r;
}

let passed = 0;
let failed = 0;
async function check(name, fn) {
    try {
        await fn();
        passed += 1;
        console.log(`  ok   ${name}`);
    } catch (e) {
        failed += 1;
        console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n       ') : e}`);
    }
}

const SUP = { inn: '7718221538', name: 'ООО «Тестовый туроператор»', phone: '8 (495) 000-00-00' };
const tourInput = (ref, over = {}) => ({ scenario: 'check', kind: 'income', orderRef: ref, amountKop: 150000, label: `Тур: Турция, 20.11–27.11.2026, заказ ${ref}`, supplier: SUP, ...over });

(async () => {
    console.log('Онлайн-касса Ferma');

    // ---------- настройки ----------
    await check('настройки: по умолчанию off; test только на ferma-test.ofd.ru, live только на ferma.ofd.ru', async () => {
        setEnv({ FERMA_MODE: '' });
        assert.deepStrictEqual(configProblems(loadConfig()), ['mode_off']);
        setEnv({ FERMA_BASE_URL: 'https://ferma.ofd.ru' });
        assert.ok(configProblems(loadConfig()).includes('test_mode_requires_test_host'), 'test + боевой хост запрещён');
        setEnv({ FERMA_MODE: 'live' });
        assert.ok(configProblems(loadConfig()).includes('live_mode_requires_live_host'), 'live + тестовый хост запрещён');
        setEnv({ FERMA_MODE: 'live', FERMA_BASE_URL: '' });
        assert.strictEqual(loadConfig().host, 'ferma.ofd.ru');
        assert.strictEqual(canIssueTestReceipts(loadConfig()), false, 'в live тестовые чеки выключены');
        setEnv({ FERMA_MODE: 'live', FERMA_BASE_URL: '', FERMA_ALLOW_LIVE_RECEIPTS: '1' });
        assert.strictEqual(canIssueTestReceipts(loadConfig()), true);
        setEnv({ FERMA_LOGIN: '' });
        assert.ok(configProblems(loadConfig()).includes('credentials_missing'));
        setEnv();
        assert.deepStrictEqual(configProblems(loadConfig()), []);
        const pub = JSON.stringify(publicConfig(loadConfig()));
        assert.ok(!pub.includes('stand-secret-pass') && !pub.includes('cb-secret-123'), 'пароль и секрет callback не показываются');
        assert.ok(pub.includes('/callback/***'));
    });

    // ---------- сборка чека ----------
    await check('чек тура: Income, агентские данные только в позиции, суммы в рублях, тире и кавычки очищены', async () => {
        const { request, errors, warnings } = R.buildReceipt({
            kind: 'income', inn: '3245001416', invoiceId: 'tc-test-ab1-pay-1', amountKop: 230050,
            label: 'Тур: «Rixos», 20.11–27.11.2026', supplier: SUP, agentType: 'AGENT', taxationSystem: 'Common',
            email: 'Buyer@Example.com', billAddress: 'https://totus.club', callbackUrl: 'https://api.totus.club/api/ferma/callback/x',
        });
        assert.deepStrictEqual(errors, []);
        assert.deepStrictEqual(warnings, []);
        const rq = request.Request;
        const cr = rq.CustomerReceipt;
        const it = cr.Items[0];
        assert.strictEqual(rq.Type, 'Income');
        assert.strictEqual(cr.PaymentAgentInfo, undefined, 'на уровне чека агентских данных нет');
        assert.deepStrictEqual(it.PaymentAgentInfo, { AgentType: 'AGENT', SupplierInn: '7718221538', SupplierName: 'ООО "Тестовый туроператор"', SupplierPhone: '+74950000000' });
        assert.strictEqual(it.Label, 'Тур: "Rixos", 20.11-27.11.2026');
        assert.strictEqual(it.Price, 2300.5);
        assert.strictEqual(it.Amount, 2300.5);
        assert.strictEqual(it.Quantity, 1);
        assert.strictEqual(it.Measure, 'PIECE');
        assert.strictEqual(it.PaymentMethod, 1, 'предоплата 100 %');
        assert.strictEqual(it.PaymentType, 4, 'услуга');
        assert.deepStrictEqual(cr.PaymentItems, [{ PaymentType: 1, Sum: 2300.5 }]);
        assert.strictEqual(cr.Email, 'buyer@example.com');
        assert.strictEqual(cr.IsInternet, true);
        assert.strictEqual(cr.CashlessPayments, undefined, 'без FERMA_PAYMENT_METHOD_FLAG блок не передаётся');
    });

    await check('чек: ошибки данных ловятся до отправки', async () => {
        const base = { kind: 'income', inn: '3245001416', invoiceId: 'tc-test-x-pay-1', amountKop: 100, label: 'x', supplier: SUP, taxationSystem: 'Common', email: 'a@b.ru' };
        const errs = (over) => R.buildReceipt({ ...base, ...over }).errors;
        assert.ok(errs({ inn: '3245001417' }).includes('invalid_inn'));
        assert.ok(errs({ supplier: { ...SUP, inn: '123' } }).includes('invalid_supplier_inn'));
        assert.ok(errs({ supplier: { ...SUP, phone: '12' } }).includes('invalid_supplier_phone'));
        assert.ok(errs({ supplier: { ...SUP, name: ' ' } }).includes('supplier_name_required'));
        assert.ok(errs({ label: ' – ' }).length === 0, 'тире превращается в дефис — не пусто');
        assert.ok(errs({ label: '   ' }).includes('label_required'));
        assert.ok(errs({ amountKop: 0 }).includes('invalid_amount'));
        assert.ok(errs({ amountKop: 1.5 }).includes('invalid_amount'));
        assert.ok(errs({ amountKop: R.MAX_RECEIPT_KOP + 1 }).includes('amount_too_large'));
        assert.ok(errs({ email: '' }).includes('contact_required'));
        assert.ok(errs({ email: 'не почта' }).includes('invalid_email'));
        assert.ok(errs({ vat: 'Vat20' }).includes('invalid_vat'), 'Vat20 после 2026 не используем');
        assert.ok(errs({ taxationSystem: 'ENVD' }).includes('invalid_taxation_system'));
        assert.ok(errs({ invoiceId: 'a b' }).includes('invalid_invoice_id'));
        assert.ok(errs({ kind: 'correction' }).includes('correction_description_required'));
        assert.ok(errs({ kind: 'correction', correction: { description: 'x', receiptDate: '2026-10-20' } }).includes('invalid_correction_date'));
        assert.ok(errs({ kind: 'correction', correction: { type: 'INSTRUCTION', description: 'x', receiptDate: '20.10.26' } }).includes('prescription_number_required'));
        const long = R.buildReceipt({ ...base, label: 'Т'.repeat(200) });
        assert.strictEqual(long.request.Request.CustomerReceipt.Items[0].Label.length, 128);
        assert.deepStrictEqual(long.warnings, ['label_truncated']);
        const own = R.buildReceipt({ ...base, supplier: null }).request.Request.CustomerReceipt.Items[0];
        assert.strictEqual(own.PaymentAgentInfo, undefined, 'своя услуга — без агентских полей');
    });

    await check('деньги и служебные функции: копейки, ИНН, телефон, маскирование', async () => {
        assert.strictEqual(R.toKop('1 500,50'), 150050);
        assert.strictEqual(R.toKop(0.01), 1);
        assert.strictEqual(R.toKop('1.234'), null);
        assert.strictEqual(R.toKop('-5'), null);
        assert.strictEqual(R.rub(150050), 1500.5);
        for (const inn of ['7718221538', '3245001416', '9729424935', '9729298840', '772983990623']) assert.ok(R.isValidInn(inn), inn);
        assert.ok(!R.isValidInn('7718221539') && !R.isValidInn('772983990624'));
        assert.strictEqual(R.normalizePhone('8 (495) 000-00-00'), '+74950000000');
        assert.strictEqual(R.normalizePhone('9001234567'), '+79001234567');
        assert.strictEqual(R.correctionDate(new Date(2026, 9, 5)), '05.10.26');
        const masked = JSON.stringify(R.maskRequest({ Request: { CallbackUrl: 'https://x/api/ferma/callback/sekret', CustomerReceipt: { Email: 'ivan@mail.ru', Phone: '+79001234567' } } }));
        assert.ok(!masked.includes('ivan@') && !masked.includes('1234567') && !masked.includes('sekret'), masked);
    });

    // ---------- клиент ----------
    await check('клиент: токен кешируется, за 5 минут до конца берётся новый, 401 → новый токен и один повтор', async () => {
        const { emu, client, clock } = setup();
        await client.queueLength();
        await client.queueLength();
        assert.strictEqual(emu.count('/api/Authorization/CreateAuthToken'), 1, 'один токен на два запроса');
        clock.advance(21 * 3600e3 - 4 * 60e3);
        await client.queueLength();
        assert.strictEqual(emu.count('/api/Authorization/CreateAuthToken'), 2, 'за 4 минуты до конца — новый токен');
        emu.tokens.clear(); // Ferma «забыла» токен
        await client.queueLength();
        assert.strictEqual(emu.count('/api/Authorization/CreateAuthToken'), 3, '401 → новый токен');
    });

    await check('клиент: сбой сети при создании чека — один повтор тем же телом; статус не повторяется', async () => {
        const { emu, client } = setup();
        await client.getToken();
        emu.faults.push({ path: '/api/kkt/cloud/receipt', kind: 'network' });
        const body = R.buildReceipt({ kind: 'income', inn: '3245001416', invoiceId: 'tc-test-net-pay-1', amountKop: 100, label: 'x', supplier: SUP, taxationSystem: 'Common', email: 'a@b.ru' }).request;
        const r = await client.createReceipt(body);
        assert.ok(r.Data.ReceiptId);
        const sent = emu.calls.filter((c) => c.path === '/api/kkt/cloud/receipt');
        assert.strictEqual(sent.length, 2);
        assert.deepStrictEqual(sent[0].body, sent[1].body);
        emu.faults.push({ path: '/api/kkt/cloud/status', kind: 'timeout' });
        await assert.rejects(() => client.status({ receiptId: r.Data.ReceiptId }), (e) => e instanceof FermaError && e.kind === 'timeout');
    });

    await check('клиент: в логах нет токена, пароля и почты; без настроек — ошибка config без запросов', async () => {
        const { emu, client, logs, service } = setup();
        await service.issue(tourInput('logs1'), { waitMs: 10e3 });
        const text = logs.join('\n');
        const token = emu.calls.find((c) => c.token).token;
        assert.ok(!text.includes(token), 'токен в логе');
        assert.ok(!text.includes('stand-secret-pass') && !text.includes('test@example.com'), 'пароль или почта в логе');
        assert.ok(/\[FERMA\] POST \/api\/kkt\/cloud\/receipt 200/.test(text), 'путь и код в логе есть');
        setEnv({ FERMA_PASSWORD: '' });
        const before = emu.calls.length;
        await assert.rejects(() => client.queueLength(), (e) => e.kind === 'config');
        assert.strictEqual(emu.calls.length, before);
        setEnv();
    });

    // ---------- сервис ----------
    await check('чек тура: draft → sent → confirmed, ФН / ФД / ФП и ссылка на чек; почта в test — всегда тестовая', async () => {
        const { service, emu } = setup();
        const r = await service.issue(tourInput('A1', { email: 'real.client@mail.ru' }), { waitMs: 10e3 });
        assert.ok(r.ok && !r.reused);
        assert.strictEqual(r.row.state, 'confirmed', r.row.error_text);
        assert.strictEqual(r.row.invoice_id, 'tc-test-A1-pay-1');
        assert.ok(r.row.ofd_receipt_url.startsWith('https://check-demo.ofd.ru/rec/'));
        assert.ok(r.row.fn && r.row.fdn && r.row.fpd);
        const sent = emu.calls.find((c) => c.path === '/api/kkt/cloud/receipt').body.Request;
        assert.strictEqual(sent.CustomerReceipt.Email, 'test@example.com', 'на общий стенд не уходит настоящая почта');
        assert.strictEqual(sent.CallbackUrl, 'https://api.totus.club/api/ferma/callback/cb-secret-123');
        const out = JSON.stringify(serializeRow(r.row));
        assert.ok(!out.includes('real.client@mail.ru') && !out.includes('cb-secret-123'), 'в ответе API нет почты и секрета');
    });

    await check('повтор issue по тому же заказу — тот же чек, второй запрос в Ferma не уходит', async () => {
        const { service, emu } = setup();
        const a = await service.issue(tourInput('A2'), { waitMs: 10e3 });
        const b = await service.issue(tourInput('A2', { amountKop: 999 }));
        assert.ok(b.reused);
        assert.strictEqual(b.row.id, a.row.id);
        assert.strictEqual(emu.count('/api/kkt/cloud/receipt'), 1);
    });

    await check('ответ Ferma потерян: send_failed → сверка шлёт тот же InvoiceId → 1019 → тот же чек, второй не создан', async () => {
        const { service, emu, clock } = setup();
        emu.faults.push({ path: '/api/kkt/cloud/receipt', kind: 'lost' }, { path: '/api/kkt/cloud/receipt', kind: 'network' });
        const r = await service.issue(tourInput('A3'));
        assert.strictEqual(r.row.state, 'send_failed');
        assert.strictEqual(emu.receipts.size, 1, 'у Ferma чек уже есть');
        const s0 = await service.reconcile();
        assert.strictEqual(s0.checked, 0, 'до срока повтора не трогаем');
        clock.advance(16e3);
        await service.reconcile();
        let row = await service.waitFinal(r.row.id, 10e3);
        assert.strictEqual(row.state, 'confirmed');
        assert.strictEqual(row.receipt_id, [...emu.receipts.keys()][0], 'ReceiptId из ExistingReceiptId');
        assert.strictEqual(emu.receipts.size, 1, 'второго чека нет');
        row = await service.refresh(row.id);
        assert.strictEqual(row.state, 'confirmed');
    });

    await check('Ferma отклонила (1085): rejected с текстом ошибки; retry — новый InvoiceId (-pay-2) → confirmed', async () => {
        const { service, emu } = setup();
        emu.faults.push({ path: '/api/kkt/cloud/receipt', kind: 'reject1085' });
        const r = await service.issue(tourInput('A4'));
        assert.strictEqual(r.row.state, 'rejected');
        assert.strictEqual(r.row.error_code, 1085);
        assert.ok(/receipt\.customerReceipt — тест/.test(r.row.error_text), r.row.error_text);
        const again = await service.issue(tourInput('A4'));
        assert.ok(!again.reused, 'после rejected issue делает новую попытку');
        assert.strictEqual(again.row.invoice_id, 'tc-test-A4-pay-2');
        assert.strictEqual(again.row.state, 'sent');
    });

    await check('KKT_ERROR: финал kkt_error с причиной; retry с исправленными данными → новый InvoiceId → confirmed', async () => {
        const { service, emu } = setup();
        emu.faults.push({ path: '/api/kkt/cloud/receipt', kind: 'kkt' });
        const r = await service.issue(tourInput('A5'), { waitMs: 10e3 });
        assert.strictEqual(r.row.state, 'kkt_error');
        assert.ok(/Сумма не наличных оплат/.test(r.row.error_text));
        await assert.rejects(() => service.refund(r.row.id), (e) => e.code === 'refund_not_allowed');
        const fixed = await service.retry(r.row.id, { amountKop: 120000 }, { waitMs: 10e3 });
        assert.strictEqual(fixed.row.invoice_id, 'tc-test-A5-pay-2');
        assert.strictEqual(fixed.row.state, 'confirmed');
        assert.strictEqual(Number(fixed.row.amount_kop), 120000);
        await assert.rejects(() => service.retry(fixed.row.id), (e) => e.code === 'retry_not_allowed');
    });

    await check('5xx «нет свободных касс»: send_failed, повтор по расписанию (15 с, 1 мин …) → confirmed', async () => {
        const { service, emu, clock } = setup();
        emu.faults.push({ path: '/api/kkt/cloud/receipt', kind: '5xx' }, { path: '/api/kkt/cloud/receipt', kind: '5xx' });
        const r = await service.issue(tourInput('A6'));
        assert.strictEqual(r.row.state, 'send_failed');
        assert.strictEqual(r.row.error_code, 3);
        clock.advance(16e3);
        let s = await service.reconcile();
        assert.strictEqual(s.send_failed, 1, 'вторая попытка тоже неудачна');
        clock.advance(30e3);
        s = await service.reconcile();
        assert.strictEqual(s.checked, 0, 'после второй неудачи ждём минуту, а не 15 с');
        clock.advance(31e3);
        s = await service.reconcile();
        assert.strictEqual(s.sent, 1, 'третья попытка прошла');
        const row = await service.waitFinal(r.row.id, 10e3);
        assert.strictEqual(row.state, 'confirmed');
        assert.strictEqual(Number(row.send_attempts), 3);
    });

    await check('возврат: частичный, затем остаток; больше остатка — отказ; те же поставщик и способ расчёта', async () => {
        const { service, emu } = setup();
        const inc = await service.issue(tourInput('A7'), { waitMs: 10e3 });
        const r1 = await service.refund(inc.row.id, { amountKop: 100000, waitMs: 10e3 });
        assert.strictEqual(r1.row.state, 'confirmed');
        assert.strictEqual(r1.row.invoice_id, 'tc-test-A7-ret-1');
        assert.strictEqual(r1.row.parent_id, inc.row.id);
        const body = emu.calls.filter((c) => c.path === '/api/kkt/cloud/receipt').pop().body.Request;
        assert.strictEqual(body.Type, 'IncomeReturn');
        assert.strictEqual(body.CustomerReceipt.Items[0].PaymentMethod, 1);
        assert.strictEqual(body.CustomerReceipt.Items[0].PaymentAgentInfo.SupplierInn, SUP.inn);
        assert.ok(body.CustomerReceipt.Items[0].Label.startsWith('Возврат: Тур:'));
        await assert.rejects(() => service.refund(inc.row.id, { amountKop: 60000 }), (e) => e.code === 'refund_exceeds_income' && e.remainingKop === 50000);
        const r2 = await service.refund(inc.row.id, { waitMs: 10e3 });
        assert.strictEqual(Number(r2.row.amount_kop), 50000, 'по умолчанию — остаток');
        assert.strictEqual(r2.row.invoice_id, 'tc-test-A7-ret-2');
        await assert.rejects(() => service.refund(inc.row.id, { amountKop: 1 }), (e) => e.code === 'refund_exceeds_income');
        await assert.rejects(() => service.refund(r1.row.id), (e) => e.code === 'refund_not_allowed', 'возврат к возврату нельзя');
    });

    await check('коррекция: IncomeCorrection, одна позиция, CorrectionInfo', async () => {
        const { service, emu } = setup();
        const r = await service.issue(tourInput('A8', { kind: 'correction', correction: { type: 'SELF', description: 'Чек не сформирован при оплате', receiptDate: '20.10.26' } }), { waitMs: 10e3 });
        assert.strictEqual(r.row.state, 'confirmed');
        assert.strictEqual(r.row.invoice_id, 'tc-test-A8-cor-1');
        const body = emu.calls.find((c) => c.path === '/api/kkt/cloud/receipt').body.Request;
        assert.strictEqual(body.Type, 'IncomeCorrection');
        assert.strictEqual(body.CustomerReceipt.Items.length, 1);
        assert.deepStrictEqual(body.CustomerReceipt.CorrectionInfo, { Type: 'SELF', Description: 'Чек не сформирован при оплате', ReceiptDate: '20.10.26' });
    });

    await check('callback: статус берётся запросом status, поддельное тело не меняет состояние, чужой чек не сопоставлен', async () => {
        const { service, emu } = setup();
        const r = await service.issue(tourInput('A9'), { waitMs: 10e3 });
        const statusBefore = emu.count('/api/kkt/cloud/status');
        const cb = await service.handleCallback({ Status: 'Success', Data: { StatusCode: 3, ReceiptId: r.row.receipt_id } });
        assert.deepStrictEqual([cb.matched, cb.state], [true, 'confirmed']);
        assert.strictEqual(emu.count('/api/kkt/cloud/status'), statusBefore + 1, 'callback → запрос status');
        const byInvoice = await service.handleCallback({ Data: { InvoiceId: r.row.invoice_id } });
        assert.ok(byInvoice.matched, 'по InvoiceId тоже находится');
        assert.strictEqual((await service.handleCallback({ Data: { ReceiptId: 'nope' } })).matched, false);
        assert.strictEqual((await service.handleCallback({})).matched, false);
    });

    await check('процесс упал до отправки: черновик подбирает фоновая сверка через 30 с (память и MySQL)', async () => {
        for (const store of [createMemoryStore(), createMysqlStore(createFakeDb())]) {
            const { service, emu, clock } = setup({ store });
            const id = await store.insert({ mode: 'test', scenario: 'check', kind: 'income', order_ref: 'DR1', invoice_id: 'tc-test-DR1-pay-1', attempt: 1,
                amount_kop: 100, state: 'draft', send_attempts: 0, created_at: clock.now(), next_check_at: new Date(clock.ms() + 30e3),
                request_json: JSON.stringify(R.buildReceipt({ kind: 'income', inn: '3245001416', invoiceId: 'tc-test-DR1-pay-1', amountKop: 100, label: 'x', supplier: null, taxationSystem: 'Common', email: 'test@example.com' }).request) });
            assert.strictEqual((await service.reconcile()).checked, 0);
            clock.advance(31e3);
            await service.reconcile();
            const row = await service.waitFinal(id, 10e3);
            assert.strictEqual(row.state, 'confirmed', store.kind);
            assert.strictEqual(emu.count('/api/kkt/cloud/receipt'), 1);
        }
    });

    await check('статус 1004 (Ferma не знает чек): send_failed → сверка отправляет заново тем же InvoiceId', async () => {
        const { service, emu } = setup();
        const r = await service.issue(tourInput('B1'));
        emu.forget();
        // Ferma «потеряла» чек: и ReceiptId, и InvoiceId неизвестны
        const row = await service.refresh(r.row.id);
        assert.strictEqual(row.state, 'send_failed');
        assert.strictEqual(row.error_code, 1004);
        await service.reconcile();
        const fin = await service.waitFinal(r.row.id, 10e3);
        assert.strictEqual(fin.state, 'confirmed');
        assert.strictEqual(fin.invoice_id, 'tc-test-B1-pay-1');
    });

    await check('сверка с реестром: test — только свои чеки по ReceiptId; live — весь день, свои без записи — fermaOnly', async () => {
        const { service, emu, clock } = setup();
        await service.issue(tourInput('B2'), { waitMs: 10e3 });
        const pending = await service.issue(tourInput('B3'));
        emu.foreign.push({ ReceiptId: 'f1', InvoiceId: 'someone-else-1', StatusCode: 2 }, { ReceiptId: 'f2', InvoiceId: 'tc-test-ghost-pay-1', StatusCode: 2 });
        const d = clock.now();
        const p = (x) => String(x).padStart(2, '0');
        const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
        const rep = await service.registry(day);
        assert.strictEqual(rep.matched, 2, JSON.stringify(rep));
        assert.ok(rep.ok, 'чужие чеки стенда на сверку не влияют');
        assert.ok(emu.calls.filter((c) => c.path === '/api/kkt/cloud/list2').every((c) => c.body.Request.ReceiptId), 'в test реестр за день целиком не запрашивается');
        assert.ok(pending.row.state === 'sent');
        const L = setup({ env: { FERMA_MODE: 'live', FERMA_BASE_URL: '' } });
        await L.service.issue(tourInput('B4', { email: 'owner@totus.club' }), { waitMs: 10e3 });
        L.emu.foreign.push({ ReceiptId: 'f3', InvoiceId: 'someone-else-2', StatusCode: 2 }, { ReceiptId: 'f4', InvoiceId: 'tc-ghost-pay-1', StatusCode: 2 });
        const live = await L.service.registry(day);
        assert.strictEqual(live.matched, 1, JSON.stringify(live));
        assert.deepStrictEqual(live.fermaOnly.map((x) => x.invoiceId), ['tc-ghost-pay-1'], 'в live чек с нашим префиксом без записи у нас — расхождение');
        assert.strictEqual(live.ok, false);
        const liveEmail = L.emu.calls.find((c) => c.path === '/api/kkt/cloud/receipt').body.Request.CustomerReceipt.Email;
        assert.strictEqual(liveEmail, 'owner@totus.club', 'в live — почта из заказа');
        setEnv();
        await assert.rejects(() => service.registry('21.10.2026'), (e) => e.code === 'invalid_date');
    });

    await check('касса: годная касса найдена; в live — несовпадение ИНН и места расчётов — проблемы', async () => {
        const { service, emu } = setup();
        const rep = await service.cashboxReport();
        assert.ok(rep.ok);
        assert.strictEqual(rep.usableCount, 1);
        assert.strictEqual(rep.cashboxes.length, 1, 'в test показываем только готовые кассы стенда');
        setEnv({ FERMA_MODE: 'live', FERMA_BASE_URL: '', FERMA_INN: '9729424935' });
        const live = await service.cashboxReport();
        assert.ok(live.problems.includes('cashbox_inn_mismatch') && live.problems.includes('payment_place_not_totus'), JSON.stringify(live.problems));
        emu.cashboxes = [{ kktState: 'Готова к работе', inn: '9729424935', ffdVersion: '1.2', isAgent: true, isInternet: true, paymentPlace: 'https://totus.club', tariffEndDate: '2026-10-25', fnVolumePercent: 85 }];
        const live2 = await service.cashboxReport();
        assert.ok(live2.ok, JSON.stringify(live2.problems));
        assert.deepStrictEqual(live2.cashboxes[0].warnings, ['tariff_ending', 'fn_almost_full']);
        setEnv();
    });

    await check('самопроверка на эмуляторе стенда: все 15 шагов зелёные', async () => {
        const { service, emu } = setup();
        const rep = await service.selftest({ waitMs: 10e3 });
        const bad = rep.steps.filter((s) => !s.ok);
        assert.strictEqual(rep.steps.length, 15);
        assert.ok(rep.ok, JSON.stringify(bad, null, 1));
        assert.ok(rep.receipts.length >= 4);
        const list2 = emu.calls.filter((c) => c.path === '/api/kkt/cloud/list2');
        assert.ok(list2.length >= 4 && list2.every((c) => c.body.Request.ReceiptId), 'реестр стенда за день целиком не запрашивается');
        const sentEmails = emu.calls.filter((c) => c.path === '/api/kkt/cloud/receipt').map((c) => c.body.Request.CustomerReceipt.Email);
        assert.ok(sentEmails.every((e) => e === 'test@example.com'), 'на стенд уходит только тестовая почта');
    });

    await check('самопроверка в live запрещена; при неверном пароле — останавливается на шаге 1', async () => {
        setEnv({ FERMA_MODE: 'live', FERMA_BASE_URL: '' });
        const { service } = setup({ env: { FERMA_MODE: 'live', FERMA_BASE_URL: '' } });
        await assert.rejects(() => service.selftest(), (e) => e.code === 'selftest_test_only');
        const t = setup({ env: { FERMA_PASSWORD: 'wrong' } });
        const rep = await t.service.selftest();
        assert.strictEqual(rep.ok, false);
        assert.strictEqual(rep.steps.length, 1);
        assert.strictEqual(rep.steps[0].error.code, 2);
    });

    // ---------- MySQL-хранилище (поддельная БД) ----------
    await check('MySQL-хранилище: таблица создаётся сама, полный путь чека и возврата, SQL по колонкам', async () => {
        fakeDb.rows.length = 0;
        const { service } = setup({ store: createMysqlStore(fakeDb) });
        const r = await service.issue(tourInput('M1'), { waitMs: 10e3 });
        assert.strictEqual(r.row.state, 'confirmed', r.row.error_text);
        const ret = await service.refund(r.row.id, { amountKop: 1000, waitMs: 10e3 });
        assert.strictEqual(ret.row.state, 'confirmed');
        assert.ok(fakeDb.sqls.some((s) => /^CREATE TABLE IF NOT EXISTS fiscal_receipts/.test(s)));
        assert.strictEqual(fakeDb.rows.length, 2);
        assert.ok(fakeDb.rows[0].next_check_at === null && fakeDb.rows[0].created_at instanceof Date);
        const store = createMysqlStore(fakeDb);
        const list = await store.list({ mode: 'test', limit: 10 });
        assert.strictEqual(list.total, 2);
        assert.strictEqual(list.rows[0].kind, 'return', 'новые сверху');
    });

    // ---------- контроллер ----------
    function ctrlFor(env = {}) {
        const t = setup({ env });
        const c = createFermaController(() => ({ client: t.client, store: t.store, service: t.service }));
        return { c, ...t };
    }
    const call = async (fn, req) => { const r = res(); await fn({ body: {}, query: {}, params: {}, ...req }, r); return r; };

    await check('эндпоинты: создать тестовый чек (tour / arlekino / own_service / correction), список, карточка, возврат', async () => {
        const { c } = ctrlFor();
        const tour = await call(c.createReceipt, { body: { scenario: 'tour', amount: '1500,00', orderRef: 'C1' } });
        assert.strictEqual(tour.statusCode, 201, JSON.stringify(tour.body));
        assert.strictEqual(tour.body.receipt.state, 'confirmed');
        assert.strictEqual(tour.body.receipt.amount, 1500);
        assert.strictEqual(tour.body.receipt.supplierInn, '7718221538');
        const own = await call(c.createReceipt, { body: { scenario: 'own_service', amount: 1 } });
        assert.strictEqual(own.body.receipt.supplierInn, null);
        assert.strictEqual(own.body.receipt.request.Request.CustomerReceipt.Items[0].PaymentAgentInfo, undefined);
        const arl = await call(c.createReceipt, { body: { scenario: 'arlekino', amount: 1 } });
        assert.strictEqual(arl.body.receipt.request.Request.CustomerReceipt.Items[0].PaymentAgentInfo.SupplierName, 'ООО Тестовый продавец размещения');
        assert.ok(arl.body.receipt.label.startsWith('Проживание:'));
        const cor = await call(c.createReceipt, { body: { scenario: 'correction', amount: 500 } });
        assert.strictEqual(cor.body.receipt.kind, 'correction');
        assert.ok(/^\d{2}\.\d{2}\.\d{2}$/.test(cor.body.receipt.request.Request.CustomerReceipt.CorrectionInfo.ReceiptDate));
        const again = await call(c.createReceipt, { body: { scenario: 'tour', amount: 1500, orderRef: 'C1' } });
        assert.deepStrictEqual([again.statusCode, again.body.reused], [200, true]);
        const list = await call(c.listReceipts, { query: { limit: '2' } });
        assert.strictEqual(list.body.total, 4);
        assert.strictEqual(list.body.data.length, 2);
        const ref = await call(c.refundReceipt, { params: { id: String(tour.body.receipt.id) }, body: { amount: 500 } });
        assert.strictEqual(ref.statusCode, 201, JSON.stringify(ref.body));
        const card = await call(c.getReceipt, { params: { id: String(tour.body.receipt.id) } });
        assert.strictEqual(card.body.returns.length, 1);
        const over = await call(c.refundReceipt, { params: { id: String(tour.body.receipt.id) }, body: { amount: 1001 } });
        assert.deepStrictEqual([over.statusCode, over.body.error, over.body.remaining], [400, 'refund_exceeds_income', 1000]);
        assert.strictEqual((await call(c.getReceipt, { params: { id: '999' } })).statusCode, 404);
    });

    await check('эндпоинты: ошибки ввода 400, предпросмотр без отправки, config без секретов, касса, очередь, токен, сверка, самопроверка', async () => {
        const { c, emu } = ctrlFor();
        assert.strictEqual((await call(c.createReceipt, { body: { amount: 0 } })).body.error, 'invalid_amount');
        assert.strictEqual((await call(c.createReceipt, { body: { amount: '1.234' } })).statusCode, 400);
        assert.strictEqual((await call(c.createReceipt, { body: { amount: 1, scenario: 'x' } })).body.error, 'invalid_scenario');
        const bad = await call(c.createReceipt, { body: { amount: 1, supplier: { inn: '123', name: 'x', phone: '+74950000000' } } });
        assert.deepStrictEqual([bad.statusCode, bad.body.error, bad.body.errors], [400, 'invalid_receipt', ['invalid_supplier_inn']]);
        const before = emu.count('/api/kkt/cloud/receipt');
        const pv = await call(c.preview, { body: { scenario: 'tour', amount: 10 } });
        assert.ok(pv.body.ok && pv.body.request.Request.Type === 'Income');
        assert.strictEqual(emu.count('/api/kkt/cloud/receipt'), before, 'предпросмотр ничего не отправляет');
        const cfg = await call(c.config, {});
        assert.ok(!JSON.stringify(cfg.body).includes('stand-secret-pass'));
        assert.strictEqual((await call(c.cashboxes, {})).body.ok, true);
        assert.strictEqual((await call(c.queue, {})).body.Length, 0);
        assert.ok((await call(c.token, {})).body.expirationUtc);
        const st = await call(c.fermaStatus, { query: {} });
        assert.strictEqual(st.statusCode, 400);
        assert.strictEqual((await call(c.reconcile, {})).body.checked >= 0, true);
        const reg = await call(c.registry, {});
        assert.strictEqual(reg.statusCode, 200, JSON.stringify(reg.body));
        const self = await call(c.selftest, { body: { waitMs: 10000 } });
        assert.strictEqual(self.statusCode, 200, JSON.stringify(self.body.steps.filter((s) => !s.ok)));
    });

    await check('эндпоинты: off → 503; live → тестовые чеки 403; live + разрешение → не больше 1 ₽ и только со своей почтой', async () => {
        let t = ctrlFor({ FERMA_MODE: 'off' });
        let r = await call(t.c.createReceipt, { body: { amount: 1 } });
        assert.deepStrictEqual([r.statusCode, r.body.error], [503, 'ferma_not_configured']);
        assert.strictEqual((await call(t.c.cashboxes, {})).statusCode, 503);
        t = ctrlFor({ FERMA_MODE: 'live', FERMA_BASE_URL: '' });
        r = await call(t.c.createReceipt, { body: { amount: 1 } });
        assert.deepStrictEqual([r.statusCode, r.body.error], [403, 'live_receipts_disabled']);
        r = await call(t.c.selftest, {});
        assert.strictEqual(r.statusCode, 409);
        t = ctrlFor({ FERMA_MODE: 'live', FERMA_BASE_URL: '', FERMA_ALLOW_LIVE_RECEIPTS: '1' });
        r = await call(t.c.createReceipt, { body: { amount: 2, supplier: SUP, email: 'owner@totus.club' } });
        assert.strictEqual(r.body.error, 'live_amount_limit');
        r = await call(t.c.createReceipt, { body: { amount: 1 } });
        assert.strictEqual(r.body.error, 'supplier_required');
        r = await call(t.c.createReceipt, { body: { amount: 1, supplier: SUP } });
        assert.strictEqual(r.body.error, 'contact_required');
        setEnv();
    });

    await check('callback-эндпоинт: неверный секрет 404 без обработки; верный — 200 и запрос status; сети Ferma распознаются', async () => {
        const { c, service, emu } = ctrlFor();
        const r0 = await service.issue(tourInput('D1'), { waitMs: 10e3 });
        const before = emu.count('/api/kkt/cloud/status');
        const wrong = await call(c.callback, { params: { secret: 'nope' }, body: { Data: { ReceiptId: r0.row.receipt_id } }, ip: '94.143.160.10' });
        assert.strictEqual(wrong.statusCode, 404);
        assert.strictEqual(emu.count('/api/kkt/cloud/status'), before);
        const ok = await call(c.callback, { params: { secret: 'cb-secret-123' }, body: { Data: { ReceiptId: r0.row.receipt_id, StatusCode: 2 } }, ip: '::ffff:185.15.172.20' });
        assert.strictEqual(ok.statusCode, 200);
        assert.strictEqual(emu.count('/api/kkt/cloud/status'), before + 1);
        assert.ok(isFermaIp('94.143.161.255') && isFermaIp('::ffff:185.15.172.23'));
        assert.ok(!isFermaIp('185.15.172.24') && !isFermaIp('8.8.8.8') && !isFermaIp('::1'));
    });

    // ---------- подключение ----------
    await check('подключение: админ-роуты под requireStaff (strict), callback публичный, app.js монтирует и запускает сверку', async () => {
        const routes = read('routes/ferma.routes.js');
        assert.ok(/adminRouter\.use\(requireStaff\)/.test(routes), 'все админ-роуты за requireStaff');
        assert.ok(/publicRouter\.post\('\/callback\/:secret'/.test(routes));
        const app = read('app.js');
        assert.ok(/app\.use\('\/api\/ferma', fermaPublicRoutes\)/.test(app));
        assert.ok(/app\.use\('\/api\/admin\/fiscal', fermaAdminRoutes\)/.test(app));
        assert.ok(/require\('\.\/lib\/ferma'\)\.startFermaWorker\(\)/.test(app));
        // 05.11.2026: к оплатам ВТБ касса подключена только через firePaymentReceipt и только при RECONCILED (check-ferma-payment.js).
        assert.ok(/if \(payStatus === 'RECONCILED'\) \{\s*require\('\.\.\/lib\/ferma\/hooks'\)\.firePaymentReceipt\(/.test(read('utils/vtbCallback.js')), 'чек к оплате ВТБ — только после RECONCILED');
        // express в облачной проверке не установлен — роуты считаем по исходнику
        assert.strictEqual((routes.match(/publicRouter\.(get|post|put|patch|delete)\(/g) || []).length, 1, 'публичный — только callback');
        assert.strictEqual((routes.match(/adminRouter\.(get|post|put|patch|delete)\(/g) || []).length, 15);
        const ctrl = createFermaController(() => ({}));
        for (const h of (routes.match(/c\.(\w+)\)/g) || []).map((m) => m.slice(2, -1))) assert.strictEqual(typeof ctrl[h], 'function', `обработчик ${h}`);
        const env = read('.env.example');
        for (const k of ['FERMA_MODE', 'FERMA_LOGIN', 'FERMA_PASSWORD', 'FERMA_INN', 'FERMA_CALLBACK_SECRET']) assert.ok(env.includes(`${k}=`), k);
        assert.ok(!/FERMA_PASSWORD=\S/.test(env), 'в .env.example нет пароля');
    });

    await check('фоновая сверка: при FERMA_MODE=off не запускается', async () => {
        setEnv({ FERMA_MODE: 'off' });
        const { startFermaWorker } = require(path.join(root, 'lib/ferma'));
        const orig = console.log;
        console.log = () => {};
        try { assert.strictEqual(startFermaWorker(), null); } finally { console.log = orig; }
        setEnv();
    });

    console.log(`\n${passed} ok, ${failed} fail`);
    process.exit(failed ? 1 : 0);
})();
