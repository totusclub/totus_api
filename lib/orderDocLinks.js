'use strict';

/**
 * Подписанные ссылки на документы заказа (SECURITY_AUDIT_2026-09_RU.md, К1).
 *
 * До этого /uploads/orders/<order_id>/<файл>.pdf раздавался express.static без
 * какой-либо проверки: имена предсказуемы, order_id — последовательные номера
 * Level.Travel, то есть ваучеры и авиабилеты чужих заказов перебирались вручную.
 *
 * Теперь ссылка живёт ограниченное время и привязана к паре (order_id, имя файла):
 *   /uploads/orders/331445018/Ваучер.pdf?t=<exp>.<подпись>
 * Подпись — HMAC-SHA256 на JWT_SECRET (новой зависимости не требуется).
 * Альтернативный способ доступа — обычный Bearer-токен, см. middleware/orderDocumentsAccess.js.
 *
 * Токен НЕ содержит персональных данных и НЕ кладётся в базу: подпись
 * добавляется только в исходящий JSON (middleware/signOrderDocLinks.js).
 */

const crypto = require('crypto');

const PREFIX = '/uploads/orders/';
// Ссылку из карточки заказа пользователь может открыть не сразу (и приложение
// кэширует package), поэтому сутки — разумный компромисс. Перебор при этом закрыт.
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

function ttlSeconds() {
    const raw = Number(process.env.ORDER_DOC_LINK_TTL_SECONDS);
    if (Number.isFinite(raw) && raw >= 60 && raw <= 7 * 24 * 60 * 60) return Math.floor(raw);
    return DEFAULT_TTL_SECONDS;
}

function secret() {
    return process.env.JWT_SECRET || '';
}

function base64url(buf) {
    return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Разобрать /uploads/orders/<order_id>/<файл> → { orderId, filename }. */
function parseOrderDocPath(value) {
    if (!value) return null;
    const raw = String(value).trim();
    const pathOnly = raw.split('?')[0].split('#')[0];
    if (!pathOnly.startsWith(PREFIX)) return null;

    const rest = pathOnly.slice(PREFIX.length);
    const slash = rest.indexOf('/');
    if (slash <= 0) return null;

    const orderId = Number(rest.slice(0, slash));
    if (!Number.isFinite(orderId) || orderId <= 0) return null;

    let filename = rest.slice(slash + 1);
    if (!filename || filename.includes('/')) return null;
    try {
        filename = decodeURIComponent(filename);
    } catch {
        return null;
    }
    if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) return null;

    return { orderId, filename };
}

function isOrderDocPath(value) {
    return parseOrderDocPath(value) !== null;
}

function sign(orderId, filename, exp) {
    const h = crypto.createHmac('sha256', secret());
    h.update(`doc:${orderId}:${filename}:${exp}`);
    return base64url(h.digest());
}

/** Токен для пары (order_id, имя файла). Пустая строка, если JWT_SECRET не задан. */
function signDocToken(orderId, filename, nowMs = Date.now()) {
    if (!secret()) return '';
    const exp = Math.floor(nowMs / 1000) + ttlSeconds();
    return `${exp}.${sign(orderId, filename, exp)}`;
}

/** Проверка токена. Возвращает true только при совпадении подписи и живом сроке. */
function verifyDocToken(token, orderId, filename, nowMs = Date.now()) {
    if (!secret() || !token) return false;

    const value = String(token);
    const dot = value.indexOf('.');
    if (dot <= 0) return false;

    const exp = Number(value.slice(0, dot));
    const given = value.slice(dot + 1);
    if (!Number.isFinite(exp) || !given) return false;
    if (exp * 1000 < nowMs) return false;

    const expected = sign(orderId, filename, exp);
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

/** Добавить ?t=… к одной ссылке вида /uploads/orders/… (иначе вернуть как есть). */
function signDocUrl(value) {
    const parsed = parseOrderDocPath(value);
    if (!parsed) return value;

    const raw = String(value);
    const pathOnly = raw.split('?')[0].split('#')[0];
    const token = signDocToken(parsed.orderId, parsed.filename);
    if (!token) return pathOnly;
    return `${pathOnly}?t=${encodeURIComponent(token)}`;
}

/**
 * Рекурсивно подписать все ссылки на документы в структуре, которая уходит клиенту.
 * Применяется только к исходящему JSON — в базе ссылки остаются чистыми.
 */
function signDocUrlsDeep(value) {
    if (typeof value === 'string') return signDocUrl(value);
    if (Array.isArray(value)) return value.map((item) => signDocUrlsDeep(item));
    if (value && typeof value === 'object') {
        const out = {};
        for (const [key, item] of Object.entries(value)) {
            out[key] = signDocUrlsDeep(item);
        }
        return out;
    }
    return value;
}

module.exports = {
    PREFIX,
    ttlSeconds,
    parseOrderDocPath,
    isOrderDocPath,
    signDocToken,
    verifyDocToken,
    signDocUrl,
    signDocUrlsDeep,
};
