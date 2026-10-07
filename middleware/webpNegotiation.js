'use strict';

/**
 * Если браузер принимает WebP и рядом с картинкой есть `<файл>.webp` (lib/imageOptimize.js) —
 * отдаём её вместо PNG/JPEG по тому же адресу. Ссылки в БД, на сайте и в приложении не меняются.
 * Пример: /upload/home/egypt.png (383 КБ) → egypt.png.webp (~30 КБ).
 *
 * Ставится перед express.static той же папки. Документы заказов (/orders/) не трогаем.
 */

const fs = require('fs');
const path = require('path');
const { isOrderDocPath } = require('../lib/staticCache');

const SOURCE_EXT = /\.(png|jpe?g)$/i;
const EXISTS_TTL_MS = 60 * 1000;

function webpNegotiation(rootDir, { statSync = fs.statSync, now = () => Date.now() } = {}) {
    const root = path.resolve(rootDir);
    const cache = new Map(); // abs webp path → { ok, at }

    function webpExists(abs) {
        const hit = cache.get(abs);
        const t = now();
        if (hit && t - hit.at < EXISTS_TTL_MS) return hit.ok;
        let ok = false;
        try {
            ok = statSync(abs).isFile();
        } catch {
            ok = false;
        }
        if (cache.size > 5000) cache.clear();
        cache.set(abs, { ok, at: t });
        return ok;
    }

    return function webpNegotiationMiddleware(req, res, next) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        const rawPath = String(req.path || '');
        if (!SOURCE_EXT.test(rawPath) || isOrderDocPath(rawPath)) return next();

        let rel;
        try {
            rel = decodeURIComponent(rawPath);
        } catch {
            return next();
        }
        if (rel.includes('\0')) return next();
        const abs = path.resolve(root, `.${path.posix.normalize(`/${rel}`)}`);
        if (!abs.startsWith(root + path.sep)) return next();

        if (!webpExists(`${abs}.webp`)) return next();

        // Ответ по этому адресу зависит от Accept — кешам нужен Vary.
        res.vary('Accept');
        const accept = String(req.headers.accept || '');
        if (!/image\/webp/i.test(accept)) return next();

        const q = req.url.indexOf('?');
        req.url = q === -1 ? `${req.url}.webp` : `${req.url.slice(0, q)}.webp${req.url.slice(q)}`;
        return next();
    };
}

module.exports = { webpNegotiation };
