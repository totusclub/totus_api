'use strict';

/**
 * Политика CORS без зависимостей от express — чтобы её можно было прогнать
 * проверками (scripts/check-cors.js) без установки пакетов и без запуска сервера.
 * Подключается из lib/security.js.
 *
 * Разбор от 21.09.2026, пп. 1–5:
 *   1) whitelist больше не зависит от AUTH_MODE — у него своя переменная CORS_MODE;
 *   2) в списке есть Origin: null (Electron грузит окно из file://) и dev-порт десктопа;
 *   3) в режиме enforce неизвестный origin получает 403, а не «ответ без заголовков»;
 *   4) exposedHeaders — клиент может прочитать имя файла и заголовки rate-limit;
 *   5) maxAge — браузер кэширует preflight и не шлёт его на каждый запрос.
 */

// Electron грузит окно из file://, и Chromium шлёт в таких запросах Origin: null.
// Без этого значения десктоп перестанет работать, как только CORS_MODE=enforce.
// Когда десктоп переведут на собственный протокол (app://) — строку можно убрать.
const FILE_ORIGIN = 'null';

const DEFAULT_ORIGINS = [
    'https://totus.club',
    'https://www.totus.club',
    'https://admin.totus.club',
    'https://calling.totus.club',
    'https://ai.totus.club',
    FILE_ORIGIN,
    'http://localhost:3000',   // totus_WEB
    'http://localhost:3008',
    'http://localhost:3009',
    'http://localhost:3012',
    'http://localhost:5173',   // totus_desktop в dev (Vite)
];

// Заголовки, которые клиентскому JS разрешено читать из ответа.
// Content-Disposition — имя файла при скачивании документа заказа;
// RateLimit* и Retry-After — чтобы фронт мог показать «попробуйте через N минут».
const EXPOSED_HEADERS = [
    'Content-Disposition',
    'RateLimit',
    'RateLimit-Policy',
    'RateLimit-Reset',
    'Retry-After',
];

const DEFAULT_MAX_AGE = 600;
const MAX_LOG_KEYS = 500;
const LOG_EVERY_MS = 60 * 1000;

function corsMode() {
    return String(process.env.CORS_MODE || '').toLowerCase() === 'enforce' ? 'enforce' : 'log';
}

function corsMaxAge() {
    // Пустая переменная в .env — это «не задано», а не «ноль секунд»:
    // Number('') даёт 0 и молча отключил бы кэш preflight.
    const value = String(process.env.CORS_MAX_AGE || '').trim();
    if (!value) return DEFAULT_MAX_AGE;

    const raw = Number(value);
    if (Number.isFinite(raw) && raw >= 0 && raw <= 86400) return Math.floor(raw);
    return DEFAULT_MAX_AGE;
}

function allowedOrigins() {
    const fromEnv = String(process.env.CORS_ORIGINS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    return fromEnv.length ? fromEnv : DEFAULT_ORIGINS;
}

/** Запрос без Origin — не из браузера, CORS к нему неприменим. */
function isOriginAllowed(origin) {
    if (!origin) return true;
    const list = allowedOrigins();
    if (list.includes('*')) return true;
    return list.includes(origin);
}

/**
 * Что делать с запросом: 'pass' — пропустить и поставить заголовки,
 * 'log' — пропустить, но записать в лог, 'block' — 403 до маршрутов.
 */
function decide(origin) {
    if (isOriginAllowed(origin)) return 'pass';
    return corsMode() === 'enforce' ? 'block' : 'log';
}

const logState = new Map();

function logUnknownOrigin(origin, mode, now = Date.now()) {
    const last = logState.get(origin) || 0;
    if (now - last < LOG_EVERY_MS) return false;

    if (logState.size >= MAX_LOG_KEYS) logState.clear();
    logState.set(origin, now);
    console.warn(`[CORS] mode=${mode} unknown origin=${origin}`);
    return true;
}

/**
 * Гейт CORS. Принимает готовый обработчик (у нас — middleware пакета cors),
 * чтобы логику можно было проверить подстановкой заглушки.
 */
function createGate(handler) {
    return function corsGate(req, res, next) {
        const origin = req && req.headers ? req.headers.origin : undefined;
        const verdict = decide(origin);

        if (verdict !== 'pass') {
            logUnknownOrigin(origin, corsMode());

            if (verdict === 'block') {
                // Важно: именно ответ, а не «просто не ставить заголовки».
                // Иначе обработчик выполнится и побочное действие произойдёт,
                // а браузер лишь спрячет ответ от страницы.
                return res.status(403).json({ error: 'cors_forbidden' });
            }
        }

        return handler(req, res, next);
    };
}

module.exports = {
    FILE_ORIGIN,
    DEFAULT_ORIGINS,
    EXPOSED_HEADERS,
    DEFAULT_MAX_AGE,
    MAX_LOG_KEYS,
    LOG_EVERY_MS,
    corsMode,
    corsMaxAge,
    allowedOrigins,
    isOriginAllowed,
    decide,
    createGate,
    logUnknownOrigin,
    _logState: logState,
};
