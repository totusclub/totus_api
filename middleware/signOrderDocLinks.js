'use strict';

/**
 * Подпись ссылок на документы заказа в исходящем JSON (SECURITY_AUDIT_2026-09_RU.md, К1).
 *
 * Ставится один раз, до маршрутов:
 *   app.use(require('./middleware/signOrderDocLinks')());
 *
 * Оборачивает res.json и дописывает ?t=… ко всем ссылкам вида
 * /uploads/orders/<order_id>/<файл>, которые уходят клиенту — в package заказа,
 * в attachments, saved_documents, agreement_doc и в ответе /orders/documents.
 * Благодаря этому сайт и приложение продолжают открывать документы как раньше
 * (обычной ссылкой), а перебор чужих заказов закрыт.
 *
 * В базу подпись не попадает: меняется только тело ответа.
 */

const { signDocUrlsDeep } = require('../lib/orderDocLinks');

function createSignOrderDocLinks() {
    return function signOrderDocLinks(req, res, next) {
        const originalJson = res.json.bind(res);
        res.json = function signedJson(body) {
            try {
                return originalJson(signDocUrlsDeep(body));
            } catch (err) {
                console.error('[ORDER-DOCS] sign links failed:', err.message);
                return originalJson(body);
            }
        };
        next();
    };
}

module.exports = createSignOrderDocLinks;
module.exports.createSignOrderDocLinks = createSignOrderDocLinks;
