'use strict';

/**
 * Короткий публичный кеш для справочников и контента главной (GET без авторизации).
 * Было: заголовка нет → каждый заход на главную заново тянул баннеры, партнёров, FAQ,
 * соцсети, блоки главной и список городов вылета.
 *
 * Правки в админке видны максимум через max-age (60 с). /api/home-hero здесь нет:
 * он намеренно `no-store` (смена картинки на каждый заход, scripts/check-home-hero.js).
 */

const RULES = [
    { re: /^\/references\/departures\/?$/, value: 'public, max-age=300, stale-while-revalidate=3600' },
    { re: /^\/(api\/)?home\/data\/?$/, value: 'public, max-age=60, stale-while-revalidate=300' },
    { re: /^\/api\/home-(banners|partners)\/?$/, value: 'public, max-age=60, stale-while-revalidate=300' },
    { re: /^\/api\/faq\/?$/, value: 'public, max-age=60, stale-while-revalidate=300' },
    { re: /^\/api\/footer-social\/?$/, value: 'public, max-age=60, stale-while-revalidate=300' },
];

function publicCacheFor(method, urlPath, hasAuth) {
    if (method !== 'GET' && method !== 'HEAD') return null;
    if (hasAuth) return null;
    const p = String(urlPath || '');
    const rule = RULES.find((r) => r.re.test(p));
    return rule ? rule.value : null;
}

/** Ставит заголовок до обработчика; обработчик может переопределить. Ошибки (4xx/5xx) не кешируем. */
function publicCache() {
    return function publicCacheMiddleware(req, res, next) {
        const value = publicCacheFor(req.method, req.path, Boolean(req.headers.authorization));
        if (!value) return next();
        res.setHeader('Cache-Control', value);
        const origWriteHead = res.writeHead;
        res.writeHead = function writeHeadNoCacheOnError(statusCode, ...rest) {
            if (statusCode >= 400 && res.getHeader('Cache-Control') === value) {
                res.setHeader('Cache-Control', 'no-store');
            }
            return origWriteHead.call(this, statusCode, ...rest);
        };
        return next();
    };
}

module.exports = { publicCache, publicCacheFor, RULES };
