'use strict';

/**
 * Сопутствующие меры (план SECURITY_JWT_PLAN_RU.md, п. 2.1):
 * helmet, CORS-whitelist, rate-limit на auth-эндпоинты.
 *
 * CORS_ORIGINS — CSV разрешённых origin'ов (по умолчанию домены totus.club + localhost).
 * Запросы без Origin (приложение, curl, вебхуки LT/ВТБ) разрешены всегда.
 * В AUTH_MODE=log неизвестный origin пропускается с записью в лог,
 * в enforce — блокируется (без CORS-заголовков).
 */

const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { authMode } = require('./auth');

const DEFAULT_ORIGINS = [
    'https://totus.club',
    'https://www.totus.club',
    'https://admin.totus.club',
    'https://calling.totus.club',
    'https://ai.totus.club',
    'http://localhost:3000',
    'http://localhost:3008',
    'http://localhost:3009',
    'http://localhost:3012',
];

function allowedOrigins() {
    const fromEnv = String(process.env.CORS_ORIGINS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    return fromEnv.length ? fromEnv : DEFAULT_ORIGINS;
}

const corsLogState = new Map();
function logUnknownOrigin(origin) {
    const now = Date.now();
    const last = corsLogState.get(origin) || 0;
    if (now - last < 60 * 1000) return;
    corsLogState.set(origin, now);
    console.warn(`[CORS] mode=${authMode()} unknown origin=${origin}`);
}

function corsMiddleware() {
    return cors({
        origin(origin, cb) {
            if (!origin) return cb(null, true); // non-browser
            const list = allowedOrigins();
            if (list.includes('*') || list.includes(origin)) return cb(null, true);
            if (authMode() === 'enforce') return cb(null, false);
            logUnknownOrigin(origin);
            return cb(null, true);
        },
        credentials: false,
    });
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

module.exports = { corsMiddleware, helmetMiddleware, authLimiter, allowedOrigins };
