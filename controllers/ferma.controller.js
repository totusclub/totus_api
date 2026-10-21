// Онлайн-касса Ferma: тестовые эндпоинты админки (/api/admin/fiscal, только staff) и callback Ferma.
// Описание — docs/FERMA_API.md. Реальные оплаты сюда не подключены.
const crypto = require('crypto');
const { FermaError } = require('../lib/ferma/client');
const { serializeRow, FiscalError, TEST_SUPPLIER, LIVE_TEST_MAX_KOP, FINAL } = require('../lib/ferma/service');
const { publicConfig, canIssueTestReceipts, configProblems } = require('../lib/ferma/config');
const R = require('../lib/ferma/receipt');

// Адреса, с которых Ferma шлёт callback (документация §3.9).
const FERMA_CALLBACK_NETS = ['94.143.160.0/24', '94.143.161.0/24', '185.15.172.16/29'];

function ipv4ToInt(ip) {
    const m = String(ip || '').replace(/^::ffff:/, '').match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (!m) return null;
    return m.slice(1).reduce((n, o) => ((n << 8) | Number(o)) >>> 0, 0);
}
function isFermaIp(ip) {
    const n = ipv4ToInt(ip);
    if (n == null) return false;
    return FERMA_CALLBACK_NETS.some((cidr) => {
        const [base, bits] = cidr.split('/');
        const mask = bits === '0' ? 0 : (~0 << (32 - Number(bits))) >>> 0;
        return (n & mask) === (ipv4ToInt(base) & mask);
    });
}

function safeEqual(a, b) {
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
}

const STATUS_BY_CODE = {
    ferma_not_configured: 503, receipt_not_found: 404, retry_not_allowed: 409, refund_not_allowed: 409,
    selftest_test_only: 409, live_receipts_disabled: 403, refund_exceeds_income: 400,
};

function sendError(res, err) {
    if (err instanceof FiscalError) {
        const status = STATUS_BY_CODE[err.code] || 400;
        return res.status(status).json({ error: err.code, message: err.message, problems: err.problems, remaining: err.remainingKop != null ? R.rub(err.remainingKop) : undefined });
    }
    if (err instanceof FermaError) {
        if (err.kind === 'config') return res.status(503).json({ error: 'ferma_not_configured', message: err.message, problems: err.data && err.data.problems });
        return res.status(502).json({ error: 'ferma_error', ferma: err.toJSON() });
    }
    console.error('[FERMA] unexpected error:', err);
    return res.status(500).json({ error: 'internal_error', message: 'Внутренняя ошибка' });
}

const clampWait = (v, def) => Math.min(Math.max(Number(v == null ? def : v) || 0, 0), 60000);

function yesterdayDdMmYy(now) {
    return R.correctionDate(new Date(now.getTime() - 24 * 3600e3));
}

function parseSupplier(s) {
    if (!s || typeof s !== 'object') return undefined;
    return { inn: String(s.inn || '').trim(), name: String(s.name || ''), phone: String(s.phone || '') };
}

/**
 * Тело запроса тестового чека → input сервиса. Бросает FiscalError при неверных полях.
 * scenario: tour (агентский, поставщик — туроператор) | arlekino (агентский, поставщик — продавец размещения)
 *           | own_service (без агентских полей) | correction (чек коррекции прихода)
 */
function resolveTestInput(body = {}, cfg, now) {
    const scenario = String(body.scenario || 'tour');
    if (!['tour', 'arlekino', 'own_service', 'correction'].includes(scenario)) {
        throw new FiscalError('invalid_scenario', 'scenario: tour | arlekino | own_service | correction');
    }
    const amountKop = R.toKop(body.amount);
    if (amountKop == null || amountKop <= 0) throw new FiscalError('invalid_amount', 'amount: сумма в рублях больше 0, не больше двух знаков после запятой');
    const live = cfg.mode === 'live';
    if (live && amountKop > LIVE_TEST_MAX_KOP) {
        throw new FiscalError('live_amount_limit', `В боевом режиме тестовый чек — не больше ${R.rub(LIVE_TEST_MAX_KOP)} ₽`);
    }
    const orderRef = body.orderRef ? String(body.orderRef) : `t${now.getTime().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
    let supplier = parseSupplier(body.supplier);
    if (scenario === 'own_service') supplier = null;
    if (supplier === undefined) {
        if (live) throw new FiscalError('supplier_required', 'В боевом режиме укажите supplier { inn, name, phone }');
        supplier = scenario === 'arlekino' ? { ...TEST_SUPPLIER, name: 'ООО Тестовый продавец размещения' } : TEST_SUPPLIER;
    }
    const defaultLabel = {
        tour: `Тур: тестовый, заказ ${orderRef}`,
        arlekino: `Проживание: тестовый номер, заказ ${orderRef}`,
        own_service: `Услуга: тестовая, заказ ${orderRef}`,
        correction: `Тур: коррекция, заказ ${orderRef}`,
    }[scenario];
    const input = {
        scenario: `test_${scenario}`,
        kind: scenario === 'correction' ? 'correction' : 'income',
        orderRef,
        amountKop,
        label: body.label ? String(body.label) : defaultLabel,
        supplier,
        paymentMethod: body.paymentMethod == null ? undefined : Number(body.paymentMethod),
        vat: body.vat ? String(body.vat) : undefined,
    };
    if (scenario === 'correction') {
        const c = body.correction || {};
        input.correction = {
            type: c.type || 'SELF',
            description: c.description || `Чек не сформирован при оплате заказа ${orderRef}`,
            receiptDate: c.receiptDate || yesterdayDdMmYy(now),
            prescriptionNumber: c.prescriptionNumber,
        };
    }
    if (live) {
        if (!body.email && !body.phone) throw new FiscalError('contact_required', 'В боевом режиме укажите email (свой) — на него придёт чек');
        input.email = body.email;
        input.phone = body.phone;
    }
    return input;
}

function createFermaController(getDeps) {
    const deps = () => getDeps();
    const cfgNow = () => deps().service.config();
    const guardIssue = () => {
        const cfg = cfgNow();
        const problems = configProblems(cfg);
        if (problems.length) throw new FiscalError('ferma_not_configured', `Ferma не настроена: ${problems.join(', ')}`, { problems });
        if (!canIssueTestReceipts(cfg)) {
            throw new FiscalError('live_receipts_disabled', 'Боевой режим: тестовые чеки выключены (FERMA_ALLOW_LIVE_RECEIPTS=1 — только для проверки на 1 ₽)');
        }
        return cfg;
    };
    const handle = (fn) => async (req, res) => {
        try { await fn(req, res); } catch (err) { sendError(res, err); }
    };

    return {
        // GET /api/admin/fiscal/config
        config: handle(async (req, res) => {
            const { client } = deps();
            res.json({ ...publicConfig(cfgNow()), token: client.tokenInfo() });
        }),

        // POST /api/admin/fiscal/token — проверить логин и пароль
        token: handle(async (req, res) => {
            const { client } = deps();
            const t = await client.getToken({ force: true });
            res.json({ ok: true, expirationUtc: t.expirationUtc });
        }),

        // GET /api/admin/fiscal/cashboxes — кассы, ФН, тариф, параметры регистрации
        cashboxes: handle(async (req, res) => {
            res.json(await deps().service.cashboxReport());
        }),

        // GET /api/admin/fiscal/queue
        queue: handle(async (req, res) => {
            const json = await deps().client.queueLength();
            res.json(json.Data || {});
        }),

        // GET /api/admin/fiscal/ferma-status?receiptId=|invoiceId= — статус любого чека прямо у Ferma
        fermaStatus: handle(async (req, res) => {
            const receiptId = req.query.receiptId ? String(req.query.receiptId) : null;
            const invoiceId = req.query.invoiceId ? String(req.query.invoiceId) : null;
            if (!receiptId && !invoiceId) return res.status(400).json({ error: 'receipt_or_invoice_required' });
            const json = await deps().client.status({ receiptId, invoiceId });
            res.json(json.Data || json.DataList || {});
        }),

        // POST /api/admin/fiscal/preview — собрать чек без отправки
        preview: handle(async (req, res) => {
            const cfg = cfgNow();
            const now = new Date();
            const input = resolveTestInput(req.body || {}, cfg, now);
            const built = R.buildReceipt({
                kind: input.kind, inn: cfg.inn, invoiceId: `${cfg.invoicePrefix}-${input.orderRef}-preview`,
                amountKop: input.amountKop, label: input.label, supplier: input.supplier, agentType: cfg.agentType,
                vat: input.vat || cfg.vat, taxationSystem: cfg.taxationSystem, billAddress: cfg.billAddress,
                paymentMethod: input.paymentMethod, email: cfg.mode === 'test' ? cfg.testEmail : input.email,
                phone: cfg.mode === 'test' ? null : input.phone, callbackUrl: cfg.callbackUrl,
                paymentMethodFlag: cfg.paymentMethodFlag, correction: input.correction,
            });
            res.status(built.errors.length ? 400 : 200).json({
                ok: !built.errors.length, errors: built.errors, warnings: built.warnings, request: R.maskRequest(built.request),
            });
        }),

        // POST /api/admin/fiscal/receipts — создать и отправить тестовый чек
        createReceipt: handle(async (req, res) => {
            const cfg = guardIssue();
            const input = resolveTestInput(req.body || {}, cfg, new Date());
            const r = await deps().service.issue(input, { waitMs: clampWait(req.body && req.body.waitMs, 15000) });
            if (!r.ok) return res.status(400).json({ error: 'invalid_receipt', errors: r.errors, warnings: r.warnings });
            res.status(r.reused ? 200 : 201).json({ ok: true, reused: r.reused, warnings: r.warnings, receipt: serializeRow(r.row) });
        }),

        // GET /api/admin/fiscal/receipts?state=&scenario=&orderRef=&limit=&offset=
        listReceipts: handle(async (req, res) => {
            const cfg = cfgNow();
            const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
            const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
            const { rows, total } = await deps().store.list({
                mode: req.query.mode ? String(req.query.mode) : cfg.mode,
                state: req.query.state ? String(req.query.state) : undefined,
                scenario: req.query.scenario ? String(req.query.scenario) : undefined,
                orderRef: req.query.orderRef ? String(req.query.orderRef) : undefined,
                limit, offset,
            });
            res.json({ total, data: rows.map(serializeRow) });
        }),

        // GET /api/admin/fiscal/receipts/:id?refresh=1
        getReceipt: handle(async (req, res) => {
            const { store, service } = deps();
            let row = await store.get(Number(req.params.id));
            if (!row) return res.status(404).json({ error: 'receipt_not_found' });
            if (req.query.refresh === '1' && !FINAL.includes(row.state)) row = await service.refresh(row);
            res.json({ receipt: serializeRow(row), returns: (await store.children(row.id)).map(serializeRow) });
        }),

        // POST /api/admin/fiscal/receipts/:id/refresh — спросить статус у Ferma
        refreshReceipt: handle(async (req, res) => {
            const row = await deps().service.refresh(Number(req.params.id));
            res.json({ receipt: serializeRow(row) });
        }),

        // POST /api/admin/fiscal/receipts/:id/retry { amount?, label?, supplier?, paymentMethod?, waitMs? }
        retryReceipt: handle(async (req, res) => {
            guardIssue();
            const b = req.body || {};
            const overrides = {};
            if (b.amount !== undefined) {
                const kop = R.toKop(b.amount);
                if (kop == null || kop <= 0) throw new FiscalError('invalid_amount', 'amount: сумма в рублях');
                overrides.amountKop = kop;
            }
            if (b.label !== undefined) overrides.label = String(b.label);
            if (b.supplier !== undefined) overrides.supplier = b.supplier === null ? null : parseSupplier(b.supplier);
            if (b.paymentMethod !== undefined) overrides.paymentMethod = Number(b.paymentMethod);
            const r = await deps().service.retry(Number(req.params.id), overrides, { waitMs: clampWait(b.waitMs, 15000) });
            if (!r.ok) return res.status(400).json({ error: 'invalid_receipt', errors: r.errors, warnings: r.warnings });
            res.status(201).json({ ok: true, warnings: r.warnings, receipt: serializeRow(r.row) });
        }),

        // POST /api/admin/fiscal/receipts/:id/refund { amount? (по умолчанию — остаток), waitMs? }
        refundReceipt: handle(async (req, res) => {
            const cfg = guardIssue();
            const b = req.body || {};
            let amountKop;
            if (b.amount !== undefined && b.amount !== null && b.amount !== '') {
                amountKop = R.toKop(b.amount);
                if (amountKop == null || amountKop <= 0) throw new FiscalError('invalid_amount', 'amount: сумма в рублях');
            }
            if (cfg.mode === 'live' && amountKop != null && amountKop > LIVE_TEST_MAX_KOP) {
                throw new FiscalError('live_amount_limit', `В боевом режиме — не больше ${R.rub(LIVE_TEST_MAX_KOP)} ₽`);
            }
            const r = await deps().service.refund(Number(req.params.id), { amountKop, waitMs: clampWait(b.waitMs, 15000) });
            if (!r.ok) return res.status(400).json({ error: 'invalid_receipt', errors: r.errors, warnings: r.warnings });
            res.status(201).json({ ok: true, warnings: r.warnings, receipt: serializeRow(r.row) });
        }),

        // POST /api/admin/fiscal/reconcile — фоновая сверка прямо сейчас
        reconcile: handle(async (req, res) => {
            res.json(await deps().service.reconcile({ limit: Math.min(Number(req.body && req.body.limit) || 50, 200) }));
        }),

        // GET /api/admin/fiscal/registry?date=ГГГГ-ММ-ДД — сверка с реестром Ferma
        registry: handle(async (req, res) => {
            const d = new Date();
            const p = (x) => String(x).padStart(2, '0');
            const date = req.query.date ? String(req.query.date) : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
            res.json(await deps().service.registry(date));
        }),

        // POST /api/admin/fiscal/selftest { waitMs? } — все функции на тестовом стенде, отчёт по шагам
        selftest: handle(async (req, res) => {
            const report = await deps().service.selftest({ waitMs: clampWait(req.body && req.body.waitMs, 20000) });
            console.log(`[FERMA] selftest ${report.ok ? 'OK' : 'FAILED'} ${report.steps.filter((s) => s.ok).length}/${report.steps.length} ${report.ms}ms`);
            res.status(report.ok ? 200 : 500).json(report);
        }),

        // POST /api/ferma/callback/:secret — публично, для Ferma
        callback: async (req, res) => {
            const cfg = cfgNow();
            if (cfg.mode === 'off' || !cfg.callbackSecret || !safeEqual(req.params.secret || '', cfg.callbackSecret)) {
                return res.status(404).json({ error: 'not_found' });
            }
            const ip = req.ip;
            const fromFerma = isFermaIp(ip);
            // Отвечаем сразу (тайм-аут Ferma — 10 с, повторов нет), статус узнаём сами.
            res.status(200).json({ ok: true });
            const d = (req.body && req.body.Data) || {};
            console.log(`[FERMA] callback receipt=${d.ReceiptId || '—'} invoice=${d.InvoiceId || '—'} code=${d.StatusCode} ip=${ip}${fromFerma ? '' : ' (не из сетей Ferma)'}`);
            try {
                const r = await deps().service.handleCallback(req.body || {});
                if (!r.matched) console.log('[FERMA] callback: чек не найден у нас — пропущен');
            } catch (err) {
                console.error('[FERMA] callback handling failed:', err.message);
            }
        },
    };
}

module.exports = { createFermaController, resolveTestInput, isFermaIp, FERMA_CALLBACK_NETS };
