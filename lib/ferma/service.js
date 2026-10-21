'use strict';
// Логика чеков Ferma: создать → отправить → узнать результат; повтор, возврат, коррекция,
// callback, фоновая сверка, сверка с реестром Ferma, проверка кассы и самопроверка на стенде.
//
// Состояния строки fiscal_receipts:
//   draft       — записана, ещё не отправлена;
//   sent        — Ferma приняла (StatusCode 0/1), ждём финал;
//   confirmed   — StatusCode 2, чек передан в ОФД (финал);
//   kkt_error   — StatusCode 3, касса отказала (финал; исправить и retry → новый InvoiceId);
//   rejected    — Ferma отклонила запрос (400: ошибка данных; финал; retry после исправления);
//   send_failed — сеть / 5xx / касса недоступна: повторим тот же InvoiceId (второй чек не создастся).
const { loadConfig, configProblems, canIssueTestReceipts } = require('./config');
const { FermaError } = require('./client');
const R = require('./receipt');

const KIND_SHORT = { income: 'pay', return: 'ret', correction: 'cor', return_correction: 'rcor' };
const FINAL = ['confirmed', 'kkt_error', 'rejected'];
const SEND_BACKOFF_MS = [15e3, 60e3, 5 * 60e3, 15 * 60e3, 30 * 60e3, 60 * 60e3];
const TEST_SUPPLIER = { inn: '7718221538', name: 'ООО Тестовый туроператор', phone: '+74950000000' };
const LIVE_TEST_MAX_KOP = 100; // боевая проверка — не больше 1 ₽ (FERMA_TESTING_RU.md, Т15)

class FiscalError extends Error {
    constructor(code, message, extra = {}) {
        super(message || code);
        this.name = 'FiscalError';
        this.code = code;
        Object.assign(this, extra);
    }
}

function isRetryable(err) {
    if (!(err instanceof FermaError)) return false;
    if (['network', 'timeout', 'parse'].includes(err.kind)) return true;
    if (err.httpStatus === 401 || (err.httpStatus && err.httpStatus >= 500)) return true;
    if (err.code === 1020) return true;                         // лимит обращений
    if (err.code >= 1070 && err.code <= 1079) return true;      // состояние кассы (ФН, регистрация, оплата)
    return false;
}

function errorText(err) {
    const v = err instanceof FermaError ? err.validationErrors : [];
    const tail = v.length ? `: ${v.map((x) => `${x.FieldName} — ${x.Description}`).join('; ')}` : '';
    return `${err.message}${tail}`.slice(0, 1000);
}

function parseJson(s) {
    if (!s) return null;
    if (typeof s === 'object') return s;
    try { return JSON.parse(s); } catch { return null; }
}

/** Строка для ответа API: без e-mail и телефона покупателя, без секрета callback. */
function serializeRow(row) {
    if (!row) return null;
    const input = parseJson(row.input_json) || {};
    if (input.email) input.email = R.maskEmail(input.email);
    if (input.phone) input.phone = '***';
    return {
        id: row.id,
        mode: row.mode,
        scenario: row.scenario,
        kind: row.kind,
        orderRef: row.order_ref,
        parentId: row.parent_id || null,
        invoiceId: row.invoice_id,
        attempt: row.attempt,
        receiptId: row.receipt_id || null,
        amount: R.rub(Number(row.amount_kop)),
        amountKop: Number(row.amount_kop),
        label: row.label,
        supplierInn: row.supplier_inn || null,
        state: row.state,
        final: FINAL.includes(row.state),
        status: row.status_code == null ? null : { code: row.status_code, name: row.status_name, message: row.status_message, description: row.description },
        error: row.error_code != null || row.error_text ? { code: row.error_code, text: row.error_text } : null,
        fiscal: row.fn ? { rnm: row.rnm, fn: row.fn, fdn: row.fdn, fpd: row.fpd, receiptDate: row.receipt_date } : null,
        ofdReceiptUrl: row.ofd_receipt_url || null,
        sendAttempts: row.send_attempts,
        nextCheckAt: row.next_check_at || null,
        lastCheckedAt: row.last_checked_at || null,
        callbackAt: row.callback_at || null,
        createdAt: row.created_at,
        input,
        request: R.maskRequest(parseJson(row.request_json)),
    };
}

function createService({ client, store, getConfig = loadConfig, now = () => new Date(), sleep, log = (...a) => console.log(...a) }) {
    const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const nowMs = () => now().getTime();
    const at = (ms) => new Date(nowMs() + ms);

    function configOrThrow() {
        const cfg = getConfig();
        const problems = configProblems(cfg);
        if (problems.length) throw new FiscalError('ferma_not_configured', `Ferma не настроена: ${problems.join(', ')}`, { problems });
        return cfg;
    }

    function nextCheckDelay(row) {
        const age = nowMs() - new Date(row.created_at).getTime();
        if (age < 60e3) return 3e3;
        if (age < 10 * 60e3) return 30e3;
        if (age < 60 * 60e3) return 2 * 60e3;
        return 10 * 60e3;
    }

    async function send(row) {
        const request = parseJson(row.request_json);
        const attempts = (Number(row.send_attempts) || 0) + 1;
        try {
            const json = await client.createReceipt(request);
            const data = json.Data || (Array.isArray(json.DataList) ? json.DataList[0] : null) || {};
            await store.update(row.id, {
                state: 'sent', receipt_id: data.ReceiptId || null, status_code: 0, status_name: 'NEW',
                error_code: null, error_text: null, send_attempts: attempts, next_check_at: at(2e3),
            });
            log(`[FERMA] receipt sent ${row.invoice_id} → ${data.ReceiptId}`);
        } catch (err) {
            if (err instanceof FermaError && err.code === 1019) {
                // Тот же InvoiceId уже есть у Ferma: второй чек не создан, берём существующий (стенд 20.10.2026).
                const existing = err.data && err.data.ExistingReceiptId;
                await store.update(row.id, {
                    state: 'sent', receipt_id: existing || row.receipt_id || null, error_code: null, error_text: null,
                    send_attempts: attempts, next_check_at: at(0),
                });
                log(`[FERMA] receipt ${row.invoice_id} already exists → ${existing}`);
            } else if (isRetryable(err)) {
                const delay = SEND_BACKOFF_MS[Math.min(attempts - 1, SEND_BACKOFF_MS.length - 1)];
                await store.update(row.id, {
                    state: 'send_failed', error_code: err.code, error_text: errorText(err),
                    send_attempts: attempts, next_check_at: at(delay),
                });
                log(`[FERMA] receipt ${row.invoice_id} send failed (${err.kind}/${err.code || err.httpStatus}), retry in ${delay / 1000}s`);
            } else {
                await store.update(row.id, {
                    state: 'rejected', error_code: err instanceof FermaError ? err.code : null, error_text: errorText(err),
                    send_attempts: attempts, next_check_at: null,
                });
                log(`[FERMA] receipt ${row.invoice_id} rejected: ${err.code || ''} ${err.message}`);
            }
        }
        return store.get(row.id);
    }

    function applyStatus(row, d) {
        const fields = { last_checked_at: now(), status_code: d.StatusCode, status_name: d.StatusName || null,
            status_message: d.StatusMessage ? String(d.StatusMessage).slice(0, 500) : null,
            description: d.Description ? String(d.Description).slice(0, 500) : null };
        if (d.ReceiptId && !row.receipt_id) fields.receipt_id = d.ReceiptId;
        if (d.StatusCode === 2) {
            const dev = d.Device || {};
            Object.assign(fields, {
                state: 'confirmed', next_check_at: null, error_code: null, error_text: null,
                rnm: dev.RNM || null, fn: dev.FN || null, fdn: dev.FDN != null ? String(dev.FDN) : null,
                fpd: dev.FPD != null ? String(dev.FPD) : null, ofd_receipt_url: dev.OfdReceiptUrl || null,
                receipt_date: d.ReceiptDateTimeIso || d.ReceiptDateUtc || null,
            });
        } else if (d.StatusCode === 3) {
            Object.assign(fields, { state: 'kkt_error', next_check_at: null, error_text: [d.StatusMessage, d.Description].filter(Boolean).join(': ').slice(0, 1000) });
        } else {
            const ageH = (nowMs() - new Date(row.created_at).getTime()) / 3600e3;
            Object.assign(fields, { state: 'sent', next_check_at: at(nextCheckDelay(row)),
                error_text: ageH > 24 ? 'Чек больше суток в статусе NEW/PROCESSED — проверьте кассы и тариф в ЛКК OFD.ru' : null });
        }
        return fields;
    }

    /** Узнать статус у Ferma (не из callback). send_failed / draft — отправить заново тем же InvoiceId. */
    async function refresh(rowOrId) {
        const row = typeof rowOrId === 'object' ? rowOrId : await store.get(rowOrId);
        if (!row) throw new FiscalError('receipt_not_found', 'Чек не найден');
        if (row.state === 'draft' || row.state === 'send_failed') return send(row);
        if (row.state === 'rejected') return row;
        let json;
        try {
            json = await client.status(row.receipt_id ? { receiptId: row.receipt_id } : { invoiceId: row.invoice_id });
        } catch (err) {
            if (err instanceof FermaError && err.code === 1004) {
                // Документ не найден: запрос до Ferma не дошёл — отправить заново (§3.4 документации).
                await store.update(row.id, { state: 'send_failed', error_code: 1004, error_text: 'Ferma не нашла чек — будет отправлен заново', next_check_at: at(0), last_checked_at: now() });
            } else {
                await store.update(row.id, { error_code: err.code || null, error_text: errorText(err), next_check_at: at(60e3), last_checked_at: now() });
            }
            return store.get(row.id);
        }
        const d = json.Data || (Array.isArray(json.DataList) ? json.DataList[0] : null) || {};
        await store.update(row.id, applyStatus(row, d));
        return store.get(row.id);
    }

    async function waitFinal(id, ms) {
        const deadline = nowMs() + Math.min(Math.max(Number(ms) || 0, 0), 60e3);
        let row = await store.get(id);
        while (row && !FINAL.includes(row.state) && nowMs() < deadline) {
            await wait(Math.min(1500, Math.max(deadline - nowMs(), 0)));
            row = await refresh(row);
        }
        return row;
    }

    /**
     * Создать и отправить чек.
     * input: { scenario, kind, orderRef, amountKop, label, supplier|null, paymentMethod, paymentType,
     *          email, phone, correction, parentId, paymentIdentifier }
     * opts:  { reuseExisting = true, attempt, waitMs = 0 }
     * Идемпотентно по (orderRef, kind): пока последняя попытка не kkt_error / rejected, вернётся она же.
     */
    async function issue(input, { reuseExisting = true, attempt, waitMs = 0 } = {}) {
        const cfg = configOrThrow();
        const kind = input.kind;
        if (!KIND_SHORT[kind]) throw new FiscalError('invalid_kind', 'Неизвестный тип чека');
        const orderRef = String(input.orderRef || '');
        if (!/^[A-Za-z0-9_.]{1,40}$/.test(orderRef)) throw new FiscalError('invalid_order_ref', 'orderRef: 1–40 символов [A-Za-z0-9_.]');

        const latest = await store.latestFor(orderRef, kind, cfg.mode);
        if (reuseExisting && latest && !['kkt_error', 'rejected'].includes(latest.state)) {
            const row = waitMs ? await waitFinal(latest.id, waitMs) : latest;
            return { ok: true, reused: true, row, warnings: [] };
        }
        const n = attempt || ((latest && Number(latest.attempt)) || 0) + 1;
        const invoiceId = `${cfg.invoicePrefix}-${orderRef}-${KIND_SHORT[kind]}-${n}`;

        // В тестовом режиме — только тестовая почта: стенд общий, его реестр видят все.
        const email = cfg.mode === 'test' ? cfg.testEmail : input.email;
        const phone = cfg.mode === 'test' ? null : input.phone;

        const built = R.buildReceipt({
            kind, inn: cfg.inn, invoiceId, amountKop: input.amountKop, label: input.label,
            supplier: input.supplier || null, agentType: cfg.agentType, vat: input.vat || cfg.vat,
            taxationSystem: cfg.taxationSystem, billAddress: cfg.billAddress,
            paymentMethod: input.paymentMethod, paymentType: input.paymentType,
            email, phone, callbackUrl: cfg.callbackUrl, paymentMethodFlag: cfg.paymentMethodFlag,
            paymentIdentifier: input.paymentIdentifier, correction: input.correction,
        });
        if (built.errors.length) return { ok: false, errors: built.errors, warnings: built.warnings };

        const storedInput = {
            scenario: input.scenario, kind, orderRef, amountKop: input.amountKop, label: input.label,
            supplier: input.supplier || null, paymentMethod: input.paymentMethod, paymentType: input.paymentType,
            vat: input.vat, correction: input.correction || null, parentId: input.parentId || null,
            paymentIdentifier: input.paymentIdentifier || null, email: input.email || null, phone: input.phone || null,
        };
        let id;
        try {
            id = await store.insert({
                mode: cfg.mode, scenario: String(input.scenario || 'manual').slice(0, 32), kind, order_ref: orderRef,
                parent_id: input.parentId || null, invoice_id: invoiceId, attempt: n, amount_kop: input.amountKop,
                label: built.request.Request.CustomerReceipt.Items[0].Label,
                supplier_inn: input.supplier ? String(input.supplier.inn) : null,
                // next_check_at: если процесс упадёт до отправки, фоновая сверка подберёт черновик через 30 с.
                state: 'draft', send_attempts: 0, created_at: now(), next_check_at: at(30e3),
                input_json: JSON.stringify(storedInput), request_json: JSON.stringify(built.request),
            });
        } catch (err) {
            if (err && err.code === 'ER_DUP_ENTRY') {
                const row = await store.findByInvoice(invoiceId);
                return { ok: true, reused: true, row, warnings: built.warnings };
            }
            throw err;
        }
        let row = await send(await store.get(id));
        if (waitMs && row.state === 'sent') row = await waitFinal(id, waitMs);
        return { ok: true, reused: false, row, warnings: built.warnings };
    }

    /** Новая попытка после kkt_error / rejected / send_failed: новый InvoiceId, можно поправить данные. */
    async function retry(id, overrides = {}, { waitMs = 0 } = {}) {
        const row = await store.get(id);
        if (!row) throw new FiscalError('receipt_not_found', 'Чек не найден');
        if (!['kkt_error', 'rejected', 'send_failed'].includes(row.state)) {
            throw new FiscalError('retry_not_allowed', `Повтор возможен только для kkt_error / rejected / send_failed (сейчас ${row.state})`);
        }
        const base = parseJson(row.input_json) || {};
        const input = { ...base };
        for (const k of ['amountKop', 'label', 'supplier', 'paymentMethod', 'paymentType', 'vat', 'correction', 'email', 'phone']) {
            if (overrides[k] !== undefined) input[k] = overrides[k];
        }
        return issue(input, { reuseExisting: false, waitMs });
    }

    /** Чек возврата к подтверждённому приходу: те же поставщик и признак способа расчёта. */
    async function refund(id, { amountKop, waitMs = 0 } = {}) {
        const parent = await store.get(id);
        if (!parent) throw new FiscalError('receipt_not_found', 'Чек не найден');
        if (parent.kind !== 'income') throw new FiscalError('refund_not_allowed', 'Возврат возможен только к чеку прихода');
        if (parent.state !== 'confirmed') throw new FiscalError('refund_not_allowed', 'Чек прихода ещё не подтверждён (не CONFIRMED)');
        const done = (await store.children(parent.id))
            .filter((c) => c.kind === 'return' && ['draft', 'sent', 'send_failed', 'confirmed'].includes(c.state))
            .reduce((s, c) => s + Number(c.amount_kop), 0);
        const remaining = Number(parent.amount_kop) - done;
        const amount = amountKop == null ? remaining : amountKop;
        if (!Number.isInteger(amount) || amount <= 0) throw new FiscalError('invalid_amount', 'Сумма возврата должна быть больше 0');
        if (amount > remaining) throw new FiscalError('refund_exceeds_income', `Можно вернуть не больше ${R.rub(remaining)} ₽`, { remainingKop: remaining });
        const base = parseJson(parent.input_json) || {};
        return issue({
            ...base, kind: 'return', amountKop: amount, parentId: parent.id,
            label: `Возврат: ${String(base.label || parent.label).replace(/^Возврат:\s*/i, '')}`,
        }, { reuseExisting: false, waitMs });
    }

    /** Callback Ferma — только сигнал: статус берём запросом status, телу callback не доверяем (подписи нет). */
    async function handleCallback(body = {}) {
        const d = (body && body.Data) || {};
        let row = null;
        if (d.ReceiptId) row = await store.findByReceiptId(String(d.ReceiptId));
        if (!row && d.InvoiceId) row = await store.findByInvoice(String(d.InvoiceId));
        if (!row) return { matched: false };
        await store.update(row.id, { callback_at: now() });
        const fresh = await refresh({ ...row, state: row.state === 'confirmed' ? 'sent' : row.state });
        if (d.StatusCode != null && fresh.status_code != null && Number(d.StatusCode) !== Number(fresh.status_code)) {
            log(`[FERMA] callback ${row.invoice_id}: в теле StatusCode=${d.StatusCode}, у Ferma ${fresh.status_code} — тело проигнорировано`);
        }
        return { matched: true, id: row.id, state: fresh.state };
    }

    let reconciling = false;
    /** Фоновая сверка: незавершённые и неотправленные чеки, срок проверки которых наступил. */
    async function reconcile({ limit = 50 } = {}) {
        const cfg = configOrThrow();
        if (reconciling) return { skipped: true };
        reconciling = true;
        const summary = { checked: 0, confirmed: 0, kkt_error: 0, rejected: 0, sent: 0, send_failed: 0, errors: 0 };
        try {
            const rows = await store.pending(cfg.mode, now(), limit);
            for (const row of rows) {
                summary.checked += 1;
                try {
                    const r = await refresh(row);
                    summary[r.state] = (summary[r.state] || 0) + 1;
                } catch (err) {
                    summary.errors += 1;
                    log(`[FERMA] reconcile ${row.invoice_id} failed: ${err.message}`);
                }
            }
        } finally {
            reconciling = false;
        }
        return summary;
    }

    /** Сверка с реестром Ferma (list2) за день: наши чеки по префиксу InvoiceId. date — 'ГГГГ-ММ-ДД'. */
    async function registry(date) {
        const cfg = configOrThrow();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw new FiscalError('invalid_date', 'date: ГГГГ-ММ-ДД');
        const prefix = `${cfg.invoicePrefix}-`;
        const from = new Date(`${date}T00:00:00`);
        const to = new Date(from.getTime() + 24 * 3600e3);
        const ours = await store.createdBetween(cfg.mode, from, to);
        const range = { StartDateLocal: `${date}T00:00:00`, EndDateLocal: `${date}T23:59:59` };
        let ferma = [];
        if (cfg.mode === 'test') {
            // Общий стенд: реестр за день — тысячи чужих чеков. Сверяем только свои, каждый по ReceiptId.
            for (const r of ours.filter((x) => x.receipt_id)) {
                const json = await client.list2({ ...range, ReceiptId: r.receipt_id });
                ferma.push(...(json.Data || []));
            }
        } else {
            const json = await client.list2(range);
            ferma = json.Data || [];
        }
        ferma = ferma.filter((r) => String(r.InvoiceId || '').startsWith(prefix));
        const byInvoice = new Map(ours.map((r) => [r.invoice_id, r]));
        const fermaIds = new Set(ferma.map((r) => r.InvoiceId));
        const mapState = (code) => ({ 0: 'sent', 1: 'sent', 2: 'confirmed', 3: 'kkt_error' }[code] || 'unknown');
        const report = { date, prefix, fermaCount: ferma.length, storeCount: ours.length, matched: 0, fermaOnly: [], storeOnly: [], stateMismatch: [] };
        for (const f of ferma) {
            const r = byInvoice.get(f.InvoiceId);
            if (!r) { report.fermaOnly.push({ invoiceId: f.InvoiceId, receiptId: f.ReceiptId, statusCode: f.StatusCode, sum: f.Receipt && f.Receipt.cashboxInfoHolder ? f.Receipt.cashboxInfoHolder.totalSum : null }); continue; }
            const expected = mapState(f.StatusCode);
            if (expected !== r.state) report.stateMismatch.push({ id: r.id, invoiceId: r.invoice_id, store: r.state, ferma: f.StatusCode });
            else report.matched += 1;
        }
        for (const r of ours) {
            if (['sent', 'confirmed'].includes(r.state) && !fermaIds.has(r.invoice_id)) report.storeOnly.push({ id: r.id, invoiceId: r.invoice_id, state: r.state });
        }
        report.ok = !report.fermaOnly.length && !report.storeOnly.length && !report.stateMismatch.length;
        return report;
    }

    /** Состояние касс + проверка параметров регистрации (поля ответа сверх документации — стенд 20.10.2026). */
    async function cashboxReport() {
        const cfg = configOrThrow();
        const json = await client.cashboxes({});
        const all = Array.isArray(json.Data) ? json.Data : [];
        const soon = (dateStr, days) => {
            if (!dateStr) return false;
            const t = Date.parse(dateStr);
            return Number.isFinite(t) && t - nowMs() < days * 24 * 3600e3;
        };
        const cashboxes = all.map((k) => {
            const ready = k.kktState === 'Готова к работе' || k.kktState === 'Заканчивается срок обслуживания';
            const checks = {
                ready,
                ffd12: k.ffdVersion === '1.2',
                agent: k.isAgent === true,
                internet: k.isInternet === true,
                innMatches: k.inn ? String(k.inn) === cfg.inn : null,
                paymentPlaceTotus: k.paymentPlace ? /totus\.club/i.test(k.paymentPlace) : null,
            };
            const warnings = [];
            if (k.kktState === 'Заканчивается срок обслуживания' || soon(k.tariffEndDate, 14)) warnings.push('tariff_ending');
            if (Number(k.fnVolumePercent) >= 80) warnings.push('fn_almost_full');
            if (soon(k.projectedFnReplaceDate, 30) || soon(k.projectedFnFilledDate, 30)) warnings.push('fn_replace_soon');
            return {
                deviceId: k.deviceId, rnm: k.rnm, zn: k.zn, fn: k.fn, model: k.kktModel, state: k.kktState,
                tariffType: k.tariffType, tariffEndDate: k.tariffEndDate, tariffChecksLeft: k.tariffChecksCnt,
                fnVolumePercent: k.fnVolumePercent, projectedFnReplaceDate: k.projectedFnReplaceDate,
                inn: k.inn, ffdVersion: k.ffdVersion, taxModeMask: k.taxModeMask, agentModeMask: k.agentModeMask,
                paymentPlace: k.paymentPlace, checks, warnings,
            };
        });
        const usable = cashboxes.filter((k) => k.checks.ready && k.checks.ffd12 && k.checks.agent && k.checks.internet);
        const problems = [];
        if (!cashboxes.some((k) => k.checks.ready)) problems.push('no_ready_cashbox');
        if (!usable.length) problems.push('no_cashbox_for_agent_internet_ffd12');
        if (cfg.mode === 'live') {
            if (usable.some((k) => k.checks.innMatches === false)) problems.push('cashbox_inn_mismatch');
            if (usable.some((k) => k.checks.paymentPlaceTotus === false)) problems.push('payment_place_not_totus');
        }
        return { ok: !problems.length, mode: cfg.mode, problems, readyCount: cashboxes.filter((k) => k.checks.ready).length, usableCount: usable.length, cashboxes: cfg.mode === 'test' ? cashboxes.filter((k) => k.checks.ready) : cashboxes };
    }

    /** Самопроверка на тестовом стенде: все функции по очереди, отчёт по шагам. Только FERMA_MODE=test. */
    async function selftest({ waitMs = 20e3 } = {}) {
        const cfg = configOrThrow();
        if (cfg.mode !== 'test') throw new FiscalError('selftest_test_only', 'Самопроверка — только в FERMA_MODE=test');
        const started = nowMs();
        const steps = [];
        const ids = [];
        const ref = `st${nowMs().toString(36)}`;
        const step = async (name, fn) => {
            const t0 = nowMs();
            try {
                const detail = await fn();
                steps.push({ step: name, ok: true, ms: nowMs() - t0, detail });
                return detail;
            } catch (err) {
                steps.push({ step: name, ok: false, ms: nowMs() - t0, error: err instanceof FermaError ? err.toJSON() : { message: err.message, code: err.code } });
                return null;
            }
        };
        const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
        const confirmed = (r, what) => {
            expect(r && r.ok, `${what}: ${r && r.errors ? r.errors.join(', ') : 'нет результата'}`);
            if (r.row && r.row.id) ids.push(r.row.id);
            expect(r.row.state === 'confirmed', `${what}: состояние ${r.row.state} (${r.row.error_text || r.row.status_message || ''})`);
            return { id: r.row.id, invoiceId: r.row.invoice_id, receiptId: r.row.receipt_id, ofdReceiptUrl: r.row.ofd_receipt_url, fdn: r.row.fdn };
        };

        const tokenOk = await step('1. Токен', async () => {
            client.resetToken();
            const t = await client.getToken();
            return { expirationUtc: t.expirationUtc };
        });
        if (!tokenOk) return { ok: false, ref, steps, receipts: ids, ms: nowMs() - started };

        await step('2. Касса: готова, ФФД 1.2, агент, интернет', async () => {
            const r = await cashboxReport();
            expect(r.ok, `проблемы: ${r.problems.join(', ')}`);
            return { readyCount: r.readyCount, usableCount: r.usableCount, problems: r.problems };
        });
        await step('3. Очередь', async () => ({ length: (await client.queueLength()).Data.Length }));

        const tour = await step('4. Тур: приход, предоплата 100 %, агентский → CONFIRMED', async () => confirmed(
            await issue({ scenario: 'selftest', kind: 'income', orderRef: `${ref}a`, amountKop: 150000,
                label: `Тур: самопроверка, 20.11–27.11.2026, заказ ${ref}a`, supplier: TEST_SUPPLIER }, { waitMs }), 'тур'));

        await step('5. Повтор того же чека: issue возвращает тот же, Ferma отвечает 1019', async () => {
            expect(tour, 'нет чека из шага 4');
            const again = await issue({ scenario: 'selftest', kind: 'income', orderRef: `${ref}a`, amountKop: 150000,
                label: 'не важно', supplier: TEST_SUPPLIER });
            expect(again.reused && again.row.id === tour.id, 'issue создал новую строку вместо повтора');
            const row = await store.get(tour.id);
            let code = null; let existing = null;
            try { await client.createReceipt(parseJson(row.request_json)); } catch (err) { code = err.code; existing = err.data && err.data.ExistingReceiptId; }
            expect(code === 1019, `ожидали 1019, получили ${code}`);
            expect(existing === tour.receiptId, 'ExistingReceiptId не совпал с ReceiptId первого чека');
            return { reused: true, fermaCode: code };
        });

        await step('6. Статус по InvoiceId = статус по ReceiptId', async () => {
            expect(tour, 'нет чека из шага 4');
            const a = (await client.status({ invoiceId: tour.invoiceId })).Data;
            const b = (await client.status({ receiptId: tour.receiptId })).Data;
            expect(a.StatusCode === 2 && b.StatusCode === 2, `коды ${a.StatusCode} / ${b.StatusCode}`);
            expect(a.Device.FDN === b.Device.FDN, 'разные номера ФД');
            return { fdn: a.Device.FDN };
        });

        await step('7. Собственная услуга (без агентских полей) → CONFIRMED', async () => confirmed(
            await issue({ scenario: 'selftest', kind: 'income', orderRef: `${ref}b`, amountKop: 100,
                label: `Проживание: самопроверка, заказ ${ref}b`, supplier: null }, { waitMs }), 'своя услуга'));

        await step('8. Частичный возврат к туру → CONFIRMED; больше остатка — отказ', async () => {
            expect(tour, 'нет чека из шага 4');
            const r = confirmed(await refund(tour.id, { amountKop: 100000, waitMs }), 'возврат');
            let code = null;
            try { await refund(tour.id, { amountKop: 60000 }); } catch (err) { code = err.code; }
            expect(code === 'refund_exceeds_income', `ожидали refund_exceeds_income, получили ${code}`);
            return { ...r, overLimit: code };
        });

        await step('9. Чек коррекции прихода → CONFIRMED', async () => confirmed(
            await issue({ scenario: 'selftest', kind: 'correction', orderRef: `${ref}c`, amountKop: 50000,
                label: `Тур: коррекция, заказ ${ref}c`, supplier: TEST_SUPPLIER,
                correction: { type: 'SELF', description: `Чек не сформирован при оплате заказа ${ref}c`, receiptDate: R.correctionDate(new Date(nowMs() - 24 * 3600e3)) } }, { waitMs }), 'коррекция'));

        await step('10. Неверный ИНН поставщика: наша проверка не пускает, Ferma отвечает 1085', async () => {
            const local = await issue({ scenario: 'selftest', kind: 'income', orderRef: `${ref}d`, amountKop: 100,
                label: 'Тур: неверный ИНН', supplier: { ...TEST_SUPPLIER, inn: '123' } });
            expect(!local.ok && local.errors.includes('invalid_supplier_inn'), 'локальная проверка пропустила неверный ИНН');
            const raw = R.buildReceipt({ kind: 'income', inn: cfg.inn, invoiceId: `${cfg.invoicePrefix}-${ref}d-raw-1`, amountKop: 100,
                label: 'Тур: неверный ИНН', supplier: TEST_SUPPLIER, agentType: cfg.agentType, taxationSystem: cfg.taxationSystem, email: cfg.testEmail }).request;
            raw.Request.CustomerReceipt.Items[0].PaymentAgentInfo.SupplierInn = '123';
            let code = null;
            try { await client.createReceipt(raw); } catch (err) { code = err.code; }
            expect(code === 1085, `ожидали 1085, получили ${code}`);
            return { local: local.errors, fermaCode: code };
        });

        await step('11. Ошибка кассы (сумма позиции не сходится) → KKT_ERROR', async () => {
            const raw = R.buildReceipt({ kind: 'income', inn: cfg.inn, invoiceId: `${cfg.invoicePrefix}-${ref}e-raw-1`, amountKop: 10000,
                label: 'Сумма позиции не сходится', supplier: null, taxationSystem: cfg.taxationSystem, email: cfg.testEmail }).request;
            const it = raw.Request.CustomerReceipt.Items[0];
            it.Quantity = 2; it.Amount = 150; delete raw.Request.CustomerReceipt.PaymentItems;
            const rid = (await client.createReceipt(raw)).Data.ReceiptId;
            let d = null;
            for (let i = 0; i < 12; i += 1) {
                d = (await client.status({ receiptId: rid })).Data;
                if (d.StatusCode === 2 || d.StatusCode === 3) break;
                await wait(1500);
            }
            expect(d && d.StatusCode === 3, `ожидали 3, получили ${d && d.StatusCode}`);
            return { statusCode: d.StatusCode, description: d.Description };
        });

        await step('12. Испорченный токен: клиент сам берёт новый и повторяет', async () => {
            client.invalidateTokenForTest();
            const q = await client.queueLength();
            expect(q.Status === 'Success', 'запрос не прошёл');
            return { refreshed: true };
        });

        await step('13. Поддельный callback (StatusCode 3) не меняет статус', async () => {
            expect(tour, 'нет чека из шага 4');
            const r = await handleCallback({ Status: 'Success', Data: { StatusCode: 3, StatusName: 'KKT_ERROR', ReceiptId: tour.receiptId } });
            expect(r.matched && r.state === 'confirmed', `состояние после callback: ${r.state}`);
            const unknown = await handleCallback({ Data: { ReceiptId: '00000000-0000-0000-0000-000000000000' } });
            expect(unknown.matched === false, 'чужой ReceiptId сопоставлен');
            return { state: r.state };
        });

        await step('14. Фоновая сверка: незавершённых чеков нет', async () => {
            const s = await reconcile();
            const left = (await Promise.all(ids.map((id) => store.get(id)))).filter((r) => r && !FINAL.includes(r.state));
            expect(!left.length, `незавершённые: ${left.map((r) => r.invoice_id).join(', ')}`);
            return s;
        });

        await step('15. Реестр Ferma (list2) содержит наши чеки', async () => {
            // На общем стенде реестр за день — тысячи чужих чеков; ищем каждый свой по ReceiptId (стенд 21.10.2026).
            const d = now();
            const p = (x) => String(x).padStart(2, '0');
            const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
            const rows = (await Promise.all(ids.map((id) => store.get(id)))).filter(Boolean);
            const missing = [];
            for (const r of rows) {
                const json = await client.list2({ ReceiptId: r.receipt_id, StartDateLocal: `${day}T00:00:00`, EndDateLocal: `${day}T23:59:59` });
                if (!(json.Data || []).some((x) => x.InvoiceId === r.invoice_id)) missing.push(r.invoice_id);
            }
            expect(!missing.length, `нет в реестре: ${missing.join(', ')} (если тест шёл около полуночи по Москве — повторите)`);
            return { found: rows.length };
        });

        return { ok: steps.every((s) => s.ok), ref, steps, receipts: ids, ms: nowMs() - started };
    }

    return {
        issue, send, refresh, waitFinal, retry, refund, handleCallback, reconcile, registry, cashboxReport, selftest,
        canIssueTestReceipts: () => canIssueTestReceipts(getConfig()),
        config: () => getConfig(),
    };
}

module.exports = { createService, serializeRow, FiscalError, isRetryable, KIND_SHORT, FINAL, TEST_SUPPLIER, LIVE_TEST_MAX_KOP };
