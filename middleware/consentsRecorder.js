'use strict';

/**
 * Пишет согласия из req.body.consents в журнал consent_log ПОСЛЕ успешного
 * ответа существующих форм — сами обработчики форм не меняются.
 *
 * Ставится в app.js сразу после express.json(). Запись — после 'finish', в фоне:
 * ошибка журнала не ломает ответ пользователю, только пишется в лог.
 *
 * Успех у форм разный: totus_API местами отвечает 200 с { error } (Level.Travel),
 * поэтому у каждой формы своя проверка.
 */

const { recordConsents } = require('../lib/consents');

const ROUTES = [
    {
        path: '/api/callback-requests',
        form: 'callback',
        ok: (status) => status < 400,
        ref: (body) => body && (body.id || body.data?.id),
    },
    {
        path: '/api/auth/signup',
        form: 'signup',
        // Успешная регистрация всегда отдаёт screen (экран ввода кода).
        ok: (status, body) => status < 400 && Boolean(body && body.screen),
        ref: () => null,
    },
    {
        path: '/create-package',
        form: 'booking',
        ok: (status, body) => status < 400 && Boolean(body) && body.success !== false && !body.error,
        ref: (body) => body && (body.order?.id || body.order_id),
    },
    {
        path: '/api/partner-requests',
        form: 'partner',
        // Ловушка для ботов отвечает 201 без id — такие запросы не пишем.
        ok: (status, body) => status < 400 && Boolean(body && body.id),
        ref: (body) => body && body.id,
    },
];

const normPath = (p) => (p.length > 1 ? p.replace(/\/+$/, '') : p);

function findRoute(req) {
    if (req.method !== 'POST') return null;
    const p = normPath(req.path || '');
    return ROUTES.find((r) => r.path === p) || null;
}

/** Сайт шлёт Origin, мобильное приложение — нет. */
function sourceOf(req) {
    return req.headers && req.headers.origin ? 'web' : 'app';
}

function subjectOf(req, body, form) {
    const b = req.body || {};
    const client = b.client || {};
    const user = (body && body.user) || {};
    return {
        userId: (req.auth && req.auth.role !== 'staff' && req.auth.id) || user.id || (form === 'booking' ? b.user_id : null),
        email: client.email || b.email || user.email || null,
        phone: client.phone || b.phone || user.phone || null,
    };
}

module.exports = function consentsRecorder() {
    return function consentsRecorderMiddleware(req, res, next) {
        const route = findRoute(req);
        if (!route) return next();

        const consents = req.body && req.body.consents;
        let captured;
        const originalJson = res.json.bind(res);
        res.json = (body) => {
            captured = body;
            return originalJson(body);
        };

        res.on('finish', () => {
            if (!route.ok(res.statusCode, captured)) return;
            recordConsents(route.form, consents, subjectOf(req, captured, route.form), {
                refId: route.ref(captured),
                source: sourceOf(req),
                ip: req.ip,
                userAgent: req.get ? req.get('user-agent') : req.headers['user-agent'],
            }).catch((err) => {
                console.error(`[CONSENTS] write failed form=${route.form}:`, err.message);
            });
        });

        return next();
    };
};

module.exports.ROUTES = ROUTES;
module.exports.findRoute = findRoute;
