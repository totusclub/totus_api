'use strict';

/**
 * Защищённая отдача документов заказа (SECURITY_AUDIT_2026-09_RU.md, К1).
 *
 * Монтируется ПЕРЕД express.static('/uploads'):
 *   app.use('/uploads/orders', require('./middleware/orderDocumentsAccess')());
 *
 * Доступ даётся одним из двух способов:
 *   1) подписанная ссылка  — ?t=… (её подмешивает middleware/signOrderDocLinks.js);
 *   2) Bearer-токен        — staff видит любой заказ, user — только свой (orders.user_id).
 *
 * ORDER_DOCS_ACCESS:
 *   strict — (по умолчанию) чужой/анонимный запрос получает 401/403;
 *   log    — только пишем в лог и пропускаем дальше в статику. Режим нужен
 *            исключительно как аварийный откат, если что-то сломается на проде.
 */

const fs = require('fs');
const path = require('path');
const db = require('../db');
const { extractBearerToken, verifyAccessToken, roleOf } = require('../lib/auth');
const { parseOrderDocPath, verifyDocToken } = require('../lib/orderDocLinks');

const ORDERS_DIR = path.join(__dirname, '..', 'uploads', 'orders');

function accessMode() {
    return String(process.env.ORDER_DOCS_ACCESS || 'strict').toLowerCase() === 'log' ? 'log' : 'strict';
}

function logDeny(req, reason, who) {
    const url = String(req.originalUrl || '').split('?')[0];
    console.warn(
        `[ORDER-DOCS] mode=${accessMode()} deny reason=${reason} ${req.method} ${url} ` +
        `auth=${who || '-'} ip=${req.ip}`,
    );
}

async function orderUserId(orderId) {
    const [rows] = await db.query('SELECT user_id FROM orders WHERE order_id = ? LIMIT 1', [orderId]);
    if (!rows.length) return undefined; // заказа нет
    return rows[0].user_id === null || rows[0].user_id === undefined ? null : Number(rows[0].user_id);
}

async function documentExists(orderId, publicUrl) {
    const [rows] = await db.query(
        'SELECT id FROM order_documents WHERE order_id = ? AND public_url = ? LIMIT 1',
        [orderId, publicUrl],
    );
    return rows.length > 0;
}

function sendFile(res, absolutePath, filename) {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    // Имя может быть кириллическим — только filename* по RFC 5987.
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(filename)}`);
    return res.sendFile(absolutePath);
}

function createOrderDocumentsAccess() {
    return async function orderDocumentsAccess(req, res, next) {
        // req.path здесь — «/<order_id>/<файл>», полный вид ссылки восстанавливаем сами.
        const parsed = parseOrderDocPath(`/uploads/orders${req.path}`);
        if (!parsed) return next();

        const { orderId, filename } = parsed;
        const publicUrl = `/uploads/orders/${orderId}/${filename}`;
        const softFail = (reason, who) => {
            logDeny(req, reason, who);
            if (accessMode() === 'log') return next();
            const code = reason === 'forbidden' ? 403 : 401;
            return res.status(code).json({ error: reason === 'forbidden' ? 'forbidden' : 'unauthorized' });
        };

        try {
            // 1. Подписанная ссылка.
            if (req.query && req.query.t && verifyDocToken(req.query.t, orderId, filename)) {
                return await serve(req, res, next, orderId, filename, publicUrl);
            }

            // 2. Bearer.
            const token = extractBearerToken(req);
            const payload = token ? verifyAccessToken(token) : null;
            if (!payload) {
                return softFail(token ? 'invalid' : 'missing');
            }

            const role = roleOf(payload);
            const who = `${role}#${payload.id}`;
            if (role !== 'staff') {
                const ownerId = await orderUserId(orderId);
                if (ownerId === undefined) return res.status(404).json({ error: 'not_found' });
                // Заказы без user_id (гостевые/старые) по Bearer не отдаём — только по подписанной ссылке.
                if (ownerId === null || String(ownerId) !== String(payload.id)) {
                    return softFail('forbidden', who);
                }
            }

            return await serve(req, res, next, orderId, filename, publicUrl);
        } catch (err) {
            console.error('[ORDER-DOCS] error:', err.message);
            return res.status(500).json({ error: 'internal_error' });
        }
    };
}

async function serve(req, res, next, orderId, filename, publicUrl) {
    // Документ должен быть зарегистрирован в order_documents — это же отсекает
    // попытки вытащить посторонний файл из каталога заказа.
    if (!(await documentExists(orderId, publicUrl))) {
        return res.status(404).json({ error: 'not_found' });
    }

    const absolutePath = path.join(ORDERS_DIR, String(orderId), path.basename(filename));
    const expectedDir = path.join(ORDERS_DIR, String(orderId));
    if (!absolutePath.startsWith(expectedDir + path.sep)) {
        return res.status(400).json({ error: 'bad_path' });
    }
    if (!fs.existsSync(absolutePath)) {
        return res.status(404).json({ error: 'not_found' });
    }

    return sendFile(res, absolutePath, filename);
}

module.exports = createOrderDocumentsAccess;
module.exports.createOrderDocumentsAccess = createOrderDocumentsAccess;
module.exports.accessMode = accessMode;
