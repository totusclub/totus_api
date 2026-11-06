'use strict';

/**
 * Политика платежей (SECURITY_AUDIT_2026-11_RU.md: C2, C3).
 *
 * 1. Сумма платежа — с сервера, не из запроса клиента.
 *    PAYMENT_AMOUNT_SOURCE:
 *      server-first — (по умолчанию) сумма заказа из БД; если её там нет — значение клиента с записью в лог.
 *                     Поведение для всех текущих заказов не меняется, но подмена суммы больше не проходит,
 *                     когда цена заказа известна серверу.
 *      server       — только сумма из БД; нет суммы — платёж не создаётся (400). Включать после того,
 *                     как в логах не осталось строк «[PAYMENT] amount fallback».
 *      client       — как было до аудита (не рекомендуется; оставлено для аварийного отката).
 *
 * 2. Ссылка оплаты от клиента (payUrl) принимается только на хосты платёжных систем
 *    (PAYMENT_PAYURL_HOSTS, по умолчанию *.nspk.ru и *.vtb.ru); иначе игнорируется — ссылку создаёт сервер.
 *
 * 3. Callback банка (/vtb/callback):
 *    VTB_CALLBACK_ALLOWED_IPS — CSV IP или CIDR банка; пусто — любой адрес (как сейчас) с предупреждением в лог.
 *    VTB_CALLBACK_SECRET      — если задан, callback обязан нести его в заголовке X-Callback-Secret или ?secret=.
 *    VTB_CALLBACK_VERIFY=1    — перед тем как считать заказ оплаченным, статус и сумма перепроверяются
 *                               встречным запросом в банк (lib/customRooms/vtbCheck.js). Без флага — как сейчас.
 *
 * 4. Статус оплаты (POST /check_pay), повторный аудит 06.11 §3.5: владелец заказа или сотрудник получают
 *    полный ответ; запрос без токена (страница /pay после возврата из банка может открыться в другом
 *    браузере) — только статус оплаты, без идентификаторов транзакций, ответа Level.Travel и данных
 *    внутреннего бронирования. Чужой заказ с токеном — 403 (AUTH_MODE=enforce).
 */

const crypto = require('crypto');
const { resolveLtOrderPayAmount } = require('../utils/orderPayment');

const toMoney = (v) => {
    if (v == null || v === '') return null;
    if (typeof v === 'object' && v.value != null) return toMoney(v.value);
    const n = Number(String(v).replace(/[^\d.,-]/g, '').replace(',', '.'));
    return Number.isFinite(n) && n > 0 ? n : null;
};

function amountMode() {
    const m = String(process.env.PAYMENT_AMOUNT_SOURCE || 'server-first').toLowerCase();
    return m === 'server' || m === 'client' ? m : 'server-first';
}

function parsePackage(orderRow) {
    try { return JSON.parse((orderRow && orderRow.package) || '{}') || {}; } catch { return {}; }
}

/** Сумма к оплате по данным сервера (строка orders). null — определить нельзя. */
function resolveServerAmount(orderRow) {
    if (!orderRow) return null;
    const pkg = parsePackage(orderRow);
    return toMoney(pkg._pay_amount)
        ?? toMoney(resolveLtOrderPayAmount(pkg))
        ?? toMoney(pkg.full_price) ?? toMoney(pkg.price) ?? toMoney(pkg.total_price) ?? toMoney(pkg.amount);
}

/**
 * Выбор суммы по политике. Возвращает { amount, source: 'server'|'client'|null, mismatch: bool }.
 * amount === null означает «платёж создавать нельзя» (строгий режим без суммы в БД).
 */
function chooseAmount({ serverAmount, clientAmount, orderId, log = console } = {}) {
    const server = toMoney(serverAmount);
    const client = toMoney(clientAmount);
    const mode = amountMode();
    const mismatch = server != null && client != null && Math.abs(server - client) > 0.009;

    if (mode === 'client') {
        if (mismatch) log.warn(`[PAYMENT] amount from client (mode=client) order=${orderId} client=${client} server=${server}`);
        return { amount: client ?? server, source: client != null ? 'client' : (server != null ? 'server' : null), mismatch };
    }
    if (server != null) {
        if (mismatch) log.warn(`[PAYMENT] amount mismatch ignored order=${orderId} client=${client} server=${server} -> server`);
        return { amount: server, source: 'server', mismatch };
    }
    if (mode === 'server') {
        log.warn(`[PAYMENT] amount unknown on server, strict mode -> reject order=${orderId}`);
        return { amount: null, source: null, mismatch: false };
    }
    if (client != null) log.warn(`[PAYMENT] amount fallback to client value order=${orderId} client=${client}`);
    return { amount: client, source: client != null ? 'client' : null, mismatch: false };
}

// ---------------------------------------------------------------------------
// payUrl от клиента
// ---------------------------------------------------------------------------
const DEFAULT_PAYURL_HOSTS = ['*.nspk.ru', 'nspk.ru', '*.vtb.ru', 'vtb.ru'];

function payUrlHosts() {
    const fromEnv = String(process.env.PAYMENT_PAYURL_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    return fromEnv.length ? fromEnv : DEFAULT_PAYURL_HOSTS;
}

function hostMatches(host, pattern) {
    if (pattern.startsWith('*.')) {
        const base = pattern.slice(2);
        return host === base || host.endsWith(`.${base}`);
    }
    return host === pattern;
}

/** Можно ли доверять payUrl из тела запроса: только https и хост платёжной системы. */
function clientPayUrlAllowed(url) {
    if (!url || typeof url !== 'string') return false;
    let u;
    try { u = new URL(url); } catch { return false; }
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    return payUrlHosts().some((p) => hostMatches(host, p));
}

// ---------------------------------------------------------------------------
// Callback банка: источник и секрет
// ---------------------------------------------------------------------------
function ipToInt(ip) {
    const parts = String(ip).split('.');
    if (parts.length !== 4) return null;
    let out = 0;
    for (const p of parts) {
        const n = Number(p);
        if (!Number.isInteger(n) || n < 0 || n > 255) return null;
        out = (out << 8) + n;
    }
    return out >>> 0;
}

function normalizeIp(ip) {
    const s = String(ip || '').trim();
    return s.startsWith('::ffff:') ? s.slice(7) : s;
}

/** ip входит в список (IPv4, IPv4/CIDR, точные IPv6)? */
function ipAllowed(ip, list) {
    const addr = normalizeIp(ip);
    for (const entry of list) {
        if (!entry) continue;
        if (entry === addr) return true;
        const [net, bitsRaw] = entry.split('/');
        if (bitsRaw === undefined) continue;
        const bits = Number(bitsRaw);
        const a = ipToInt(addr);
        const n = ipToInt(net);
        if (a === null || n === null || !Number.isInteger(bits) || bits < 0 || bits > 32) continue;
        const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
        if (((a & mask) >>> 0) === ((n & mask) >>> 0)) return true;
    }
    return false;
}

function callbackAllowedIps() {
    return String(process.env.VTB_CALLBACK_ALLOWED_IPS || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function secretsMatch(given, expected) {
    if (!given || !expected) return false;
    const a = Buffer.from(String(given));
    const b = Buffer.from(String(expected));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

let warnedNoAllowlist = false;

/**
 * Express-middleware для /vtb/callback. Отказ — 403 без обработки тела.
 * Пустой allowlist и пустой секрет — пропуск (поведение как сейчас) с одним предупреждением в лог.
 */
function vtbCallbackGuard(opts = {}) {
    const log = opts.log || console;
    return function vtbCallbackGuardMiddleware(req, res, next) {
        const ips = callbackAllowedIps();
        const secret = String(process.env.VTB_CALLBACK_SECRET || '').trim();

        if (!ips.length && !secret && !warnedNoAllowlist) {
            warnedNoAllowlist = true;
            log.warn('[VTB_CALLBACK] guard: VTB_CALLBACK_ALLOWED_IPS и VTB_CALLBACK_SECRET не заданы — источник callback не проверяется');
        }
        if (ips.length && !ipAllowed(req.ip, ips)) {
            log.warn(`[VTB_CALLBACK] guard: rejected ip=${req.ip}`);
            return res.status(403).json({ success: false, error: 'forbidden' });
        }
        if (secret) {
            const given = req.headers['x-callback-secret'] || (req.query && req.query.secret);
            if (!secretsMatch(given, secret)) {
                log.warn(`[VTB_CALLBACK] guard: bad secret ip=${req.ip}`);
                return res.status(403).json({ success: false, error: 'forbidden' });
            }
        }
        return next();
    };
}

function callbackVerifyEnabled() {
    return process.env.VTB_CALLBACK_VERIFY === '1';
}

/** Совпадает ли сумма callback с ожидаемой (копейки округляем). null у любой из сторон — не проверяем. */
function amountsAgree(expected, actual) {
    const e = toMoney(expected);
    const a = toMoney(actual);
    if (e == null || a == null) return true;
    return Math.abs(e - a) <= 0.009;
}

// Поля /check_pay, которые отдаются без токена. Статус берётся из ответа банка, поэтому
// подделать «оплачено» так нельзя; скрываются transaction_id/transaction_code, notify_* и totus_booking.
const CHECK_PAY_PUBLIC_FIELDS = ['message', 'status', 'paid', 'order_id', 'internal'];

function publicCheckPayView(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
    const out = {};
    for (const key of CHECK_PAY_PUBLIC_FIELDS) {
        if (body[key] !== undefined) out[key] = body[key];
    }
    out.limited = true;
    return out;
}

const checkPayLogState = new Map();
function logPublicCheckPay(req, orderId, log) {
    const key = `${req.ip} ${orderId}`;
    const now = Date.now();
    if (now - (checkPayLogState.get(key) || 0) < 60 * 1000) return;
    checkPayLogState.set(key, now);
    if (checkPayLogState.size > 5000) checkPayLogState.clear();
    log.warn(`[PAYMENT] check_pay without token order=${orderId || '-'} ip=${req.ip} — limited response`);
}

/**
 * Express-middleware для POST /check_pay (ставится после optionalAuth и ДО middleware customRooms,
 * который сам отвечает на /check_pay для внутренних заказов — обёртка res.json действует и там).
 *   deps.db — пул MySQL (query), deps.assertOrderOwner — из lib/auth.
 */
function checkPayAccess(deps, opts = {}) {
    const log = opts.log || console;
    return async function checkPayAccessMiddleware(req, res, next) {
        try {
            const orderId = String((req.body && req.body.orderId) || '').replace(/^ORDER/i, '').trim();
            if (req.auth) {
                if (orderId && req.auth.role !== 'staff') {
                    const [rows] = await deps.db.query('SELECT user_id FROM orders WHERE order_id = ? LIMIT 1', [orderId]);
                    if (rows[0] && !deps.assertOrderOwner(req, res, rows[0].user_id)) return;
                }
                return next();
            }
            const orig = res.json.bind(res);
            res.json = (body) => orig(res.statusCode < 400 ? publicCheckPayView(body) : body);
            logPublicCheckPay(req, orderId, log);
            return next();
        } catch (e) {
            return next(e);
        }
    };
}

module.exports = {
    amountMode,
    resolveServerAmount,
    chooseAmount,
    clientPayUrlAllowed,
    payUrlHosts,
    ipAllowed,
    vtbCallbackGuard,
    callbackVerifyEnabled,
    amountsAgree,
    toMoney,
    publicCheckPayView,
    checkPayAccess,
    CHECK_PAY_PUBLIC_FIELDS,
};
