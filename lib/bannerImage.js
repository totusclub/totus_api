'use strict';

/**
 * Баннеры главной: загруженная картинка сразу превращается в WebP и немного ужимается.
 *
 * - Любой JPG / PNG / WEBP → WebP, качество 82 (на глаз без потерь, файл в разы меньше).
 * - Шире BANNER_MAX_WIDTH — уменьшается по ширине (пропорции сохраняются, меньше не растягивается).
 *   Баннер на сайте ~630 px шириной, 1600 px хватает с запасом для экранов Retina.
 * - В БД и на диске остаётся только WebP; исходный файл удаляется.
 * - Если WebP получился не меньше исходника (редко — уже сжатый WebP) или sharp недоступен /
 *   вернул ошибку — остаётся исходный файл, как раньше. Загрузка баннера не ломается никогда.
 *
 * sharp подключается так же, как в lib/imageOptimize.js (optionalDependencies).
 */

const fs = require('fs');
const path = require('path');
const { loadSharp } = require('./imageOptimize');

const BANNER_MAX_WIDTH = 1600;
const BANNER_WEBP_QUALITY = 82;

/**
 * file — объект multer ({ filename, path, size? }). Возвращает новый объект файла
 * (filename / path указывают на итоговый файл) и сведения для лога.
 */
async function bannerToWebp(file, { sharp = loadSharp(), maxWidth = BANNER_MAX_WIDTH, quality = BANNER_WEBP_QUALITY } = {}) {
    if (!file || !file.path) return { file, status: 'skipped' };
    if (!sharp) return { file, status: 'no-sharp' };

    const dir = path.dirname(file.path);
    const base = path.basename(file.filename || file.path, path.extname(file.filename || file.path));
    const targetName = `${base}.webp`;
    const target = path.join(dir, targetName);
    const tmp = path.join(dir, `${base}.${process.pid}.${Date.now()}.tmp.webp`);

    try {
        // Читаем в память (до 15 МБ, лимит uploadBanner): sharp не держит файл открытым и не берёт его из кэша.
        const input = await fs.promises.readFile(file.path);
        const before = input.length;
        const meta = await sharp(input).metadata();
        await sharp(input)
            .rotate()
            .resize({ width: maxWidth, withoutEnlargement: true })
            .webp({ quality, effort: 5 })
            .toFile(tmp);
        const after = (await fs.promises.stat(tmp)).size;

        if (after >= before) {
            await fs.promises.unlink(tmp).catch(() => {});
            return { file, status: 'kept-original', before, after };
        }

        await fs.promises.rename(tmp, target);
        if (path.resolve(target) !== path.resolve(file.path)) {
            await fs.promises.unlink(file.path).catch(() => {});
        }
        const width = meta.width && meta.width > maxWidth ? maxWidth : meta.width;
        return {
            file: { ...file, filename: targetName, path: target, size: after, mimetype: 'image/webp' },
            status: 'converted',
            before,
            after,
            fromWidth: meta.width || null,
            toWidth: width || null,
        };
    } catch (error) {
        await fs.promises.unlink(tmp).catch(() => {});
        return { file, status: 'error', error: error && error.message ? error.message : String(error) };
    }
}

const kb = (n) => `${Math.round((Number(n) || 0) / 1024)}KB`;

function logLine(position, theme, r) {
    if (r.status === 'converted') {
        const size = r.fromWidth && r.toWidth && r.fromWidth !== r.toWidth ? ` ${r.fromWidth}px→${r.toWidth}px` : '';
        return `[BANNERS] webp position=${position} theme=${theme} ${kb(r.before)}→${kb(r.after)}${size}`;
    }
    if (r.status === 'kept-original') return `[BANNERS] webp position=${position} theme=${theme} kept original (${kb(r.before)}, webp ${kb(r.after)})`;
    if (r.status === 'no-sharp') return `[BANNERS] webp position=${position} theme=${theme} skipped: sharp not installed`;
    if (r.status === 'error') return `[BANNERS] webp position=${position} theme=${theme} failed: ${r.error}`;
    return null;
}

module.exports = { bannerToWebp, logLine, BANNER_MAX_WIDTH, BANNER_WEBP_QUALITY };
