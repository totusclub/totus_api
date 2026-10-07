'use strict';

/**
 * Cache-Control для статики API (картинки главной, отелей, баннеров, партнёров, CMS).
 *
 * Было: express.static без опций → `public, max-age=0` — браузер перепроверял каждую картинку
 * при каждом заходе (WEB_PERF_AUDIT_2026-10-07_RU.md, п. 4).
 *
 * Правила:
 *  - /uploads/orders/… — документы заказа: всегда `private, no-store` (даже если запрос дошёл
 *    до express.static в аварийном режиме ORDER_DOCS_ACCESS=log или с неразобранным путём);
 *  - уникальное имя от multer (`<Date.now()>-<random>.<ext>`, а также его `.webp`-копия) —
 *    файл никогда не перезаписывается: `public, max-age=31536000, immutable`;
 *  - постоянные имена (upload/home/egypt.png, partners/tezTour.svg…) могут замениться на месте:
 *    сутки + неделя stale-while-revalidate, ETag/Last-Modified остаются для перепроверки.
 */

const PRIVATE = 'private, no-store';
const IMMUTABLE = 'public, max-age=31536000, immutable';
const FIXED_NAME = 'public, max-age=86400, stale-while-revalidate=604800';

// 1783950462399-145913179.jpg, 1791305414070-756639211.webp, …png.webp
const UNIQUE_NAME = /^\d{12,}-\d+\.[a-z0-9]+(\.webp)?$/i;

function isOrderDocPath(urlPath) {
    return /(^|\/)orders(\/|$)/i.test(String(urlPath || ''));
}

/** urlPath — путь внутри смонтированной папки или полный (/uploads/hero/x.webp). */
function cacheControlFor(urlPath) {
    const p = String(urlPath || '');
    if (isOrderDocPath(p)) return PRIVATE;
    const name = p.split('/').pop() || '';
    return UNIQUE_NAME.test(name) ? IMMUTABLE : FIXED_NAME;
}

/** Опции для express.static: Cache-Control по имени файла (путь — абсолютный путь на диске). */
function staticOptions(rootDir) {
    return {
        setHeaders(res, filePath) {
            const rel = String(filePath || '').startsWith(rootDir)
                ? filePath.slice(rootDir.length)
                : filePath;
            res.setHeader('Cache-Control', cacheControlFor(String(rel).split('\\').join('/')));
        },
    };
}

module.exports = { cacheControlFor, staticOptions, isOrderDocPath, PRIVATE, IMMUTABLE, FIXED_NAME };
