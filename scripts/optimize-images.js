'use strict';

/**
 * Разово создать WebP-копии уже загруженных картинок (рядом: `<файл>.png.webp`).
 * Запуск на сервере из папки API (нужен пакет sharp):
 *   npm install && node scripts/optimize-images.js           — создать недостающие
 *   node scripts/optimize-images.js --force                   — пересоздать все
 *   node scripts/optimize-images.js --dry                     — только показать, что есть
 * Оригиналы не меняются и не удаляются; ссылки в БД те же. Новые загрузки из админки
 * получают копию автоматически (lib/imageOptimize.js → optimizeUploadedImages).
 */

const fs = require('fs');
const path = require('path');
const { makeWebpSibling, isConvertible, loadSharp } = require('../lib/imageOptimize');

const ROOT = path.join(__dirname, '..');
const DIRS = ['upload/home', 'upload/content', 'uploads/hero', 'uploads/banners', 'uploads/destinations', 'uploads/hotels', 'uploads/partners', 'uploads/popular'];

function walk(dir, out = []) {
    let entries = [];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (e.isFile() && isConvertible(p)) out.push(p);
    }
    return out;
}

const kb = (n) => `${Math.round(n / 1024)} КБ`;

async function main() {
    const force = process.argv.includes('--force');
    const dry = process.argv.includes('--dry');
    const files = DIRS.flatMap((d) => walk(path.join(ROOT, d)));
    console.log(`Картинок PNG/JPEG: ${files.length}`);
    if (dry) {
        for (const f of files) console.log(`  ${path.relative(ROOT, f)}  ${kb(fs.statSync(f).size)}${fs.existsSync(`${f}.webp`) ? '  (webp есть)' : ''}`);
        return;
    }
    if (!loadSharp()) {
        console.error('Пакет sharp не установлен: npm install (он в optionalDependencies). Ничего не сделано.');
        process.exitCode = 1;
        return;
    }
    let before = 0;
    let after = 0;
    const counts = {};
    for (const f of files) {
        const r = await makeWebpSibling(f, { force });
        counts[r.status] = (counts[r.status] || 0) + 1;
        if (r.status === 'created') {
            before += r.before;
            after += r.after;
            console.log(`  ${path.relative(ROOT, f)}: ${kb(r.before)} → ${kb(r.after)}`);
        } else if (r.status === 'error') {
            console.warn(`  ${path.relative(ROOT, f)}: ошибка ${r.error}`);
        }
    }
    console.log(`Итог: ${JSON.stringify(counts)}; новые копии ${kb(before)} → ${kb(after)}`);
}

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
