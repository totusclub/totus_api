'use strict';

/**
 * Мобильная версия картинки hero главной: `<файл>.m.webp` рядом с оригиналом.
 *
 * На телефоне блок hero 320–600 × 528 px, фон `cover` по центру — видна только центральная
 * полоса картинки (у 2011×782 — около трети ширины). Оригинал весит до 300 КБ и на мобильном
 * PageSpeed делит канал со всей страницей (LCP 5,1 с, PAGESPEED_MOBILE_2026-10-08_RU.md).
 * Мобильная версия — тот же кадр, обрезанный по центру до пропорции 1,15 : 1 (хватает до
 * ширины экрана 600 px без растягивания), высота не больше 1000 px, WebP q75: ~50 КБ.
 *
 * Создаётся в фоне: после загрузки в админке и при первом показе картинки на сайте
 * (для уже загруженных hero ничего запускать не нужно). Пока её нет — сайт показывает
 * оригинал, как раньше. sharp необязателен: без него мобильных версий просто нет.
 */

const fs = require('fs');
const path = require('path');

const MOBILE_SUFFIX = '.m.webp';
const MOBILE_ASPECT = 1.15; // ширина : высота (600 / 528 ≈ 1,14)
const MOBILE_MAX_HEIGHT = 1000;
const MOBILE_QUALITY = 75;
const EXISTS_TTL_MS = 60 * 1000;

const API_ROOT = path.join(__dirname, '..');
const HERO_PREFIX = '/uploads/hero/';

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

/** '/uploads/hero/123-456.webp' → '/uploads/hero/123-456.webp.m.webp' ('' — не hero / внешняя ссылка). */
function heroMobileRel(imageRel) {
    const p = String(imageRel || '');
    if (!p.startsWith(HERO_PREFIX) || /^https?:\/\//i.test(p) || p.includes('..') || p.includes('\0')) return '';
    if (p.endsWith(MOBILE_SUFFIX)) return '';
    return `${p}${MOBILE_SUFFIX}`;
}

function absFromRel(rel) {
    return path.join(API_ROOT, rel);
}

/** Центральная полоса пропорции MOBILE_ASPECT во всю высоту; узкая картинка — целиком. */
function mobileCropBox(width, height) {
    const w = Math.max(1, Math.round(Number(width) || 0));
    const h = Math.max(1, Math.round(Number(height) || 0));
    const cropWidth = Math.min(w, Math.round(h * MOBILE_ASPECT));
    return {
        left: Math.floor((w - cropWidth) / 2),
        top: 0,
        width: cropWidth,
        height: h,
        outHeight: Math.min(h, MOBILE_MAX_HEIGHT),
    };
}

/**
 * Создать `<файл>.m.webp`. Возвращает { status: 'created'|'exists'|'larger'|'no-sharp'|'error', ... }.
 * Сохраняется, только если меньше оригинала; запись через временный файл (сайт не увидит половину).
 */
async function makeHeroMobile(sourceAbs, { sharp = loadSharp(), force = false } = {}) {
    if (!sharp) return { status: 'no-sharp' };
    const target = `${sourceAbs}${MOBILE_SUFFIX}`;
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    try {
        const src = await fs.promises.stat(sourceAbs);
        if (!force) {
            const existing = await fs.promises.stat(target).catch(() => null);
            if (existing && existing.mtimeMs >= src.mtimeMs) return { status: 'exists' };
        }
        const meta = await sharp(sourceAbs).metadata();
        // EXIF-поворот 90°/270° (orientation 5–8) меняет местами ширину и высоту
        const rotated = Number(meta.orientation) >= 5;
        const width = rotated ? meta.height : meta.width;
        const height = rotated ? meta.width : meta.height;
        const box = mobileCropBox(width, height);
        await sharp(sourceAbs)
            .rotate()
            .extract({ left: box.left, top: box.top, width: box.width, height: box.height })
            .resize({ height: box.outHeight, withoutEnlargement: true })
            .webp({ quality: MOBILE_QUALITY })
            .toFile(tmp);
        const out = await fs.promises.stat(tmp);
        if (out.size >= src.size) {
            await fs.promises.unlink(tmp).catch(() => {});
            return { status: 'larger', before: src.size, after: out.size };
        }
        await fs.promises.rename(tmp, target);
        return { status: 'created', before: src.size, after: out.size, width: box.width, height: box.outHeight };
    } catch (error) {
        await fs.promises.unlink(tmp).catch(() => {});
        return { status: 'error', error: error && error.message ? error.message : String(error) };
    }
}

/**
 * Состояние «есть ли мобильная версия» для GET /api/home-hero: без ожидания диска в запросе
 * (кеш на минуту), отсутствующая версия создаётся в фоне — следующий заход её получит.
 */
function createHeroMobileIndex({
    stat = (p) => fs.promises.stat(p),
    generate = (abs) => makeHeroMobile(abs),
    now = () => Date.now(),
    log = console,
} = {}) {
    const known = new Map(); // mobile rel → { ok, at }
    const inFlight = new Map(); // mobile rel → Promise

    function remember(rel, ok) {
        if (known.size > 2000) known.clear();
        known.set(rel, { ok, at: now() });
    }

    /** Проверить диск и при необходимости создать версию. Promise<boolean> — версия есть. */
    function ensure(imageRel) {
        const rel = heroMobileRel(imageRel);
        if (!rel) return Promise.resolve(false);
        if (inFlight.has(rel)) return inFlight.get(rel);
        const job = (async () => {
            const mobileAbs = absFromRel(rel);
            const exists = await stat(mobileAbs).then((s) => s.isFile(), () => false);
            if (exists) {
                remember(rel, true);
                return true;
            }
            const sourceAbs = absFromRel(String(imageRel));
            const sourceExists = await stat(sourceAbs).then((s) => s.isFile(), () => false);
            if (!sourceExists) {
                remember(rel, false);
                return false;
            }
            const result = await generate(sourceAbs);
            const ok = Boolean(result && (result.status === 'created' || result.status === 'exists'));
            if (result && result.status === 'error') log.warn('[HERO] mobile failed', path.basename(sourceAbs), result.error);
            if (result && result.status === 'created') {
                log.log(`[HERO] mobile ${path.basename(sourceAbs)} ${Math.round(result.before / 1024)} → ${Math.round(result.after / 1024)} КБ`);
            }
            remember(rel, ok);
            return ok;
        })()
            .catch((e) => {
                log.warn('[HERO] mobile failed', e && e.message);
                remember(rel, false);
                return false;
            })
            .finally(() => inFlight.delete(rel));
        inFlight.set(rel, job);
        return job;
    }

    /**
     * Для ответа API: путь мобильной версии или ''. Неизвестное состояние ждём не дольше waitMs
     * (проверка диска — миллисекунды; создание версии идёт дальше в фоне и запрос не держит).
     */
    async function lookup(imageRel, waitMs = 30) {
        const rel = heroMobileRel(imageRel);
        if (!rel) return '';
        const hit = known.get(rel);
        if (hit && now() - hit.at < EXISTS_TTL_MS) return hit.ok ? rel : '';
        let timer;
        const ok = await Promise.race([
            ensure(imageRel),
            new Promise((resolve) => {
                timer = setTimeout(() => resolve(Boolean(hit && hit.ok)), waitMs);
            }),
        ]);
        clearTimeout(timer);
        return ok ? rel : '';
    }

    function forget(imageRel) {
        const rel = heroMobileRel(imageRel);
        if (rel) known.delete(rel);
    }

    return { ensure, lookup, forget };
}

module.exports = {
    MOBILE_SUFFIX,
    MOBILE_ASPECT,
    MOBILE_MAX_HEIGHT,
    MOBILE_QUALITY,
    heroMobileRel,
    mobileCropBox,
    makeHeroMobile,
    createHeroMobileIndex,
    loadSharp,
};
