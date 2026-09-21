'use strict';

/**
 * Сопутствующие меры (SECURITY_JWT_PLAN_RU.md, п. 2.1): helmet, CORS-whitelist,
 * rate-limit на auth-эндпоинты.
 *
 * Сама политика CORS вынесена в lib/corsPolicy.js — там же переменные окружения
 * и пояснения. Коротко:
 *   CORS_MODE=log|enforce  — режим whitelist'а, НЕ зависит от AUTH_MODE;
 *   CORS_ORIGINS           — CSV разрешённых origin'ов;
 *   CORS_MAX_AGE           — кэш preflight в секундах (по умолчанию 600).
 *
 * Запросы без заголовка Origin (мобильное приложение, десктоп, curl, webhook'и
 * Level.Travel и ВТБ) разрешены всегда: CORS — браузерный механизм, он защищает
 * пользователя от чужих сайтов, но не является защитой самого API. Реальная
 * защита — AUTH_MODE=enforce и проверки владельца в lib/auth.js.
 */

const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const policy = require('./corsPolicy');

function corsMiddleware() {
    const handler = cors({
        // Сюда доходят только разрешённые origin'ы (и любые — в режиме log):
        // решение принимается в policy.createGate.
        origin: (origin, cb) => cb(null, true),
        credentials: false,
        maxAge: policy.corsMaxAge(),
        exposedHeaders: policy.EXPOSED_HEADERS,
    });

    return policy.createGate(handler);
}

function helmetMiddleware() {
    // API отдаёт картинки (/uploads, /upload/*) на сайт с другого origin —
    // поэтому CORP cross-origin и без CSP.
    return helmet({
        contentSecurityPolicy: false,
        crossOriginEmbedderPolicy: false,
        crossOriginResourcePolicy: { policy: 'cross-origin' },
    });
}

// 30 попыток за 15 минут с одного IP на signup/signin/verify/refresh/sign-in.
const authLimiter = rateLimit({
    windowMs: Number(process.env.AUTH_RATE_WINDOW_MS || 15 * 60 * 1000),
    limit: Number(process.env.AUTH_RATE_LIMIT || 30),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'too_many_requests' },
});

module.exports = {
    corsMiddleware,
    helmetMiddleware,
    authLimiter,
    allowedOrigins: policy.allowedOrigins,
    corsMode: policy.corsMode,
};
