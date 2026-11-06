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

// H9 аудита: общий лимит запросов с одного IP на весь API (прокси Level.Travel, платежи, формы) —
// защита от исчерпания квот партнёрских API и платных вызовов. Per-process, в памяти.
//   API_RATE_LIMIT      — запросов за окно с одного IP (по умолчанию 600; 0 — лимитер выключен)
//   API_RATE_WINDOW_MS  — окно (по умолчанию 60 000)
//   API_RATE_MODE       — log (по умолчанию: превышение только пишется в лог) | enforce (429)
//   API_RATE_SKIP_PATHS — CSV префиксов путей без лимита (по умолчанию callback'и банка/LT/Ferma и статика)
const DEFAULT_RATE_SKIP = ['/vtb/callback', '/tours/level_travel/', '/api/ferma/callback', '/uploads', '/upload/'];

function rateSkipPaths() {
    const fromEnv = String(process.env.API_RATE_SKIP_PATHS || '').split(',').map((s) => s.trim()).filter(Boolean);
    return fromEnv.length ? fromEnv : DEFAULT_RATE_SKIP;
}

const rateLogState = new Map();
function logRateExceeded(req) {
    const key = `${req.ip} ${req.method} ${req.path}`;
    const now = Date.now();
    const last = rateLogState.get(key) || 0;
    if (now - last < 60 * 1000) return;
    rateLogState.set(key, now);
    if (rateLogState.size > 5000) rateLogState.clear();
    console.warn(`[RATE] mode=${process.env.API_RATE_MODE === 'enforce' ? 'enforce' : 'log'} exceeded ip=${req.ip} ${req.method} ${req.originalUrl || req.path}`);
}

function apiLimiter() {
    const limit = Number(process.env.API_RATE_LIMIT ?? 600);
    if (!Number.isFinite(limit) || limit <= 0) return (req, res, next) => next();
    const skip = rateSkipPaths();
    return rateLimit({
        windowMs: Number(process.env.API_RATE_WINDOW_MS || 60 * 1000),
        limit,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        skip: (req) => skip.some((prefix) => String(req.path || '').startsWith(prefix)),
        handler: (req, res, next, options) => {
            logRateExceeded(req);
            if (process.env.API_RATE_MODE === 'enforce') {
                return res.status(options.statusCode || 429).json({ error: 'too_many_requests' });
            }
            return next();
        },
    });
}

module.exports = { corsMiddleware, helmetMiddleware, authLimiter, apiLimiter, allowedOrigins, rateSkipPaths };
