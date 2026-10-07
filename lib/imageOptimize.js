'use strict';

/**
 * WebP-копии загруженных картинок: `<файл>.png` → `<файл>.png.webp` рядом.
 * Отдаёт их middleware/webpNegotiation.js браузерам, которые принимают image/webp;
 * ссылки в БД и в приложении не меняются, оригинал остаётся на месте.
 *
 * sharp подключается лениво: если пакет не установлен (optionalDependencies) — копии просто
 * не создаются, API работает как раньше.
 */

const fs = require('fs');
const path = require('path');

const SOURCE_EXT = new Set(['.png', '.jpg', '.jpeg']);
const MAX_WIDTH = 2560; // hero во всю ширину экрана; больше браузеру не нужно
const QUALITY = 80;

let sharpLoaded;
function loadSharp() {
    if (sharpLoaded !== undefined) return sharpLoaded;
    try {
        sharpLoaded = require('sharp');
    } catch {
        sharpLoaded = null;
    }
    return sharpLoaded;
}

function webpPathFor(filePath) {
    return `${filePath}.webp`;
}

function isConvertible(filePath) {
    return SOURCE_EXT.has(path.extname(String(filePath || '')).toLowerCase());
}

/**
 * Создать WebP-копию. Возвращает { status: 'created'|'exists'|'skipped'|'larger'|'no-sharp'|'error', ... }.
 * Копия сохраняется, только если она меньше оригинала.
 */
async function makeWebpSibling(filePath, { sharp = loadSharp(), force = false } = {}) {
    if (!isConvertible(filePath)) return { status: 'skipped' };
    if (!sharp) return { status: 'no-sharp' };
    const target = webpPathFor(filePath);
    const tmp = `${target}.${process.pid}.tmp`;
    try {
        const src = await fs.promises.stat(filePath);
        if (!force) {
            const existing = await fs.promises.stat(target).catch(() => null);
            if (existing && existing.mtimeMs >= src.mtimeMs) return { status: 'exists' };
        }
        await sharp(filePath)
            .rotate()
            .resize({ width: MAX_WIDTH, withoutEnlargement: true })
            .webp({ quality: QUALITY })
            .toFile(tmp);
        const out = await fs.promises.stat(tmp);
        if (out.size >= src.size) {
            await fs.promises.unlink(tmp).catch(() => {});
            return { status: 'larger', before: src.size, after: out.size };
        }
        await fs.promises.rename(tmp, target);
        return { status: 'created', before: src.size, after: out.size };
    } catch (error) {
        await fs.promises.unlink(tmp).catch(() => {});
        return { status: 'error', error: error && error.message ? error.message : String(error) };
    }
}

/** Файлы, которые multer положил в req (single / array / fields). */
function uploadedFilePaths(req) {
    const out = [];
    const add = (f) => {
        if (f && typeof f.path === 'string') out.push(f.path);
    };
    if (req && req.file) add(req.file);
    const files = req && req.files;
    if (Array.isArray(files)) files.forEach(add);
    else if (files && typeof files === 'object') Object.values(files).forEach((v) => (Array.isArray(v) ? v.forEach(add) : add(v)));
    return out;
}

/**
 * Middleware: после ответа на загрузку из админки — WebP-копии загруженных картинок в фоне.
 * Ответ админке не задерживается; ошибки только в лог.
 */
function optimizeUploadedImages({ convert = makeWebpSibling, log = console } = {}) {
    return function optimizeUploadedImagesMiddleware(req, res, next) {
        if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
            res.on('finish', () => {
                if (res.statusCode >= 400) return;
                const paths = uploadedFilePaths(req).filter(isConvertible);
                for (const p of paths) {
                    Promise.resolve(convert(p))
                        .then((r) => {
                            if (r && r.status === 'error') log.warn('[IMAGES] webp failed', path.basename(p), r.error);
                        })
                        .catch((e) => log.warn('[IMAGES] webp failed', path.basename(p), e && e.message));
                }
            });
        }
        next();
    };
}

module.exports = { makeWebpSibling, webpPathFor, isConvertible, uploadedFilePaths, optimizeUploadedImages, loadSharp, MAX_WIDTH, QUALITY };
