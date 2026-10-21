'use strict';
// HTTP-клиент Ferma. Без зависимостей: глобальный fetch (Node 18+), как lib/notifyHub.js.
//
// Особенности API (проверено на ferma-test.ofd.ru 20.10.2026):
//  - токен передаётся в строке запроса ?AuthToken= — в логи пишем только путь, без query;
//  - AuthToken — UUID (не 32 hex, как в документации), формат не проверяем;
//  - ошибки приходят как HTTP 4xx/5xx с JSON { Status: 'Failed', Error: { Code, Message }, Data };
//  - 401 / код 1001 — токен недействителен: берём новый и повторяем один раз.
const { loadConfig, configProblems } = require('./config');

class FermaError extends Error {
    constructor(message, { code = null, httpStatus = null, data = null, kind = 'api' } = {}) {
        super(message);
        this.name = 'FermaError';
        this.code = code;               // Error.Code Ferma (1019, 1085, …) или null
        this.httpStatus = httpStatus;   // HTTP-статус ответа или null (сеть)
        this.data = data;               // Data из ответа (ValidationErrors, ExistingReceiptId…)
        this.kind = kind;               // 'api' | 'network' | 'timeout' | 'config' | 'parse'
    }
    get validationErrors() {
        return (this.data && Array.isArray(this.data.ValidationErrors)) ? this.data.ValidationErrors : [];
    }
    toJSON() {
        return {
            kind: this.kind, code: this.code, httpStatus: this.httpStatus, message: this.message,
            validationErrors: this.validationErrors.map((v) => ({ field: v.FieldName, description: v.Description })),
        };
    }
}

const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

function createClient(opts = {}) {
    const getConfig = opts.getConfig || loadConfig;
    const doFetch = opts.fetch || ((...a) => globalThis.fetch(...a));
    const now = opts.now || (() => Date.now());
    const log = opts.log || ((...a) => console.log(...a));
    let token = null; // { value, expiresAt, key }

    function cfgOrThrow() {
        const cfg = getConfig();
        const problems = configProblems(cfg);
        if (problems.length) {
            throw new FermaError(`Ferma не настроена: ${problems.join(', ')}`, { kind: 'config', data: { problems } });
        }
        return cfg;
    }

    async function rawRequest(cfg, method, path, { body, query } = {}, authToken) {
        const qs = new URLSearchParams();
        if (authToken) qs.set('AuthToken', authToken);
        for (const [k, v] of Object.entries(query || {})) {
            if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
        }
        const url = `${cfg.baseUrl}${path}${qs.toString() ? `?${qs}` : ''}`;
        const started = now();
        let res;
        try {
            res = await doFetch(url, {
                method,
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: AbortSignal.timeout(cfg.timeoutMs),
            });
        } catch (err) {
            const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
            log(`[FERMA] ${method} ${path} ${timeout ? 'timeout' : 'network error'} ${now() - started}ms`);
            throw new FermaError(timeout ? `Ferma не ответила за ${cfg.timeoutMs} мс` : `Сеть: ${err && err.message}`,
                { kind: timeout ? 'timeout' : 'network' });
        }
        const text = await res.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* ниже */ }
        log(`[FERMA] ${method} ${path} ${res.status} ${now() - started}ms`);
        if (!json) {
            throw new FermaError(`Ferma: ответ не JSON (HTTP ${res.status})`, { kind: 'parse', httpStatus: res.status });
        }
        if (res.status !== 200 || json.Status !== 'Success') {
            const e = json.Error || {};
            throw new FermaError(e.Message || `Ferma: HTTP ${res.status}`, {
                code: e.Code != null ? Number(e.Code) : null, httpStatus: res.status, data: json.Data || null,
            });
        }
        return json;
    }

    async function getToken({ force = false } = {}) {
        const cfg = cfgOrThrow();
        const key = `${cfg.host}|${cfg.login}`;
        if (!force && token && token.key === key && now() < token.expiresAt - TOKEN_REFRESH_MARGIN_MS) {
            return token;
        }
        const json = await rawRequest(cfg, 'POST', '/api/Authorization/CreateAuthToken',
            { body: { Login: cfg.login, Password: cfg.password } });
        const d = json.Data || {};
        if (!d.AuthToken) throw new FermaError('Ferma: в ответе нет AuthToken', { kind: 'parse' });
        // ExpirationDateUtc без зоны — это UTC+0 (документация, сноска 2).
        const exp = Date.parse(String(d.ExpirationDateUtc || '').replace(/Z?$/, 'Z'));
        token = { value: String(d.AuthToken), expiresAt: Number.isFinite(exp) ? exp : now() + 60 * 60 * 1000, key, expirationUtc: d.ExpirationDateUtc || null };
        return token;
    }

    const isAuthError = (err) => err instanceof FermaError && (err.httpStatus === 401 || err.code === 1001 || err.code === 4);

    /** Запрос с токеном; при 401 / 1001 — новый токен и один повтор. retryNetwork — ещё один повтор при сбое сети. */
    async function call(method, path, { body, query, retryNetwork = false } = {}) {
        const cfg = cfgOrThrow();
        let attempt = 0;
        let authRetried = false;
        for (;;) {
            const t = await getToken();
            try {
                return await rawRequest(cfg, method, path, { body, query }, t.value);
            } catch (err) {
                if (isAuthError(err) && !authRetried) {
                    authRetried = true;
                    token = null;
                    continue;
                }
                if (retryNetwork && attempt === 0 && err instanceof FermaError && (err.kind === 'network' || err.kind === 'timeout' || (err.httpStatus >= 500 && err.code == null))) {
                    attempt += 1;
                    continue;
                }
                throw err;
            }
        }
    }

    return {
        getToken,
        resetToken() { token = null; },
        /** Для самопроверки: подменить токен недействительным, чтобы проверить автообновление. */
        invalidateTokenForTest() { if (token) token = { ...token, value: '00000000-0000-0000-0000-000000000000' }; },
        tokenInfo() { return token ? { expirationUtc: token.expirationUtc, expiresAt: token.expiresAt } : null; },
        /** Создание чека. Повтор при сбое сети безопасен: тот же InvoiceId второй чек не создаст. */
        createReceipt: (request) => call('POST', '/api/kkt/cloud/receipt', { body: request, retryNetwork: true }),
        status: ({ receiptId, invoiceId }) => call('POST', '/api/kkt/cloud/status',
            { body: { Request: receiptId ? { ReceiptId: receiptId } : { InvoiceId: invoiceId } } }),
        list: (request) => call('POST', '/api/kkt/cloud/list', { body: { Request: request } }),
        list2: (request) => call('POST', '/api/kkt/cloud/list2', { body: { Request: request } }),
        receiptsExtended: (query) => call('GET', '/api/kkt/cloud/stats/receipts/extended', { query }),
        cashboxes: (query) => call('GET', '/api/kkt/cloud/stats/cashboxes/extended', { query }),
        queueLength: () => call('GET', '/api/kkt/cloud/stats/receipts/queue/length'),
        fnAggregates: (query) => call('GET', '/api/kkt/cloud/stats/fn/aggregates', { query }),
    };
}

module.exports = { createClient, FermaError, TOKEN_REFRESH_MARGIN_MS };
