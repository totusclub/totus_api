'use strict';

/**
 * Проверка: баннеры из админки сохраняются в WebP со сжатием (lib/bannerImage.js + контроллер).
 * Запуск: node scripts/check-home-banners-webp.js (нужен sharp — он уже в optionalDependencies).
 * БД не трогает: контроллер копируется во временную папку, db и publicApiBase подменяются.
 */

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const root = path.resolve(__dirname, '..');
let sharp;
try {
    sharp = require('sharp');
} catch {
    console.log('sharp не установлен — проверка пропущена (без sharp баннеры сохраняются как раньше).');
    process.exit(0);
}
const { bannerToWebp, BANNER_MAX_WIDTH, BANNER_WEBP_QUALITY } = require(path.join(root, 'lib/bannerImage'));

let passed = 0;
let failed = 0;
async function check(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ok   ${name}`);
    } catch (e) {
        failed++;
        console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n       ') : e}`);
    }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'banners-webp-'));
const uploads = path.join(tmpRoot, 'uploads', 'banners');
fs.mkdirSync(uploads, { recursive: true });

/** Картинка, похожая на фото: градиент + шум, чтобы сжатие было честным. */
async function makeImage(name, width, height, format) {
    const channels = 3;
    const buf = Buffer.alloc(width * height * channels);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * channels;
            const n = (x * 7 + y * 13) % 23;
            buf[i] = (x * 255) / width + n;
            buf[i + 1] = (y * 255) / height + n;
            buf[i + 2] = 128 + ((x + y) % 64) - n;
        }
    }
    const file = path.join(uploads, name);
    let img = sharp(buf, { raw: { width, height, channels } });
    if (format === 'png') img = img.png();
    if (format === 'jpeg') img = img.jpeg({ quality: 95 });
    if (format === 'webp') img = img.webp({ quality: 100 });
    await img.toFile(file);
    return { filename: name, path: file, size: fs.statSync(file).size };
}

(async () => {
    console.log(`Баннеры: WebP, ширина до ${BANNER_MAX_WIDTH}px, качество ${BANNER_WEBP_QUALITY}`);

    await check('PNG 2400px → WebP 1600px, меньше по размеру, исходник удалён', async () => {
        const f = await makeImage('1-png.png', 2400, 900, 'png');
        const r = await bannerToWebp(f, { sharp });
        assert.equal(r.status, 'converted');
        assert.equal(r.file.filename, '1-png.webp');
        assert.ok(!fs.existsSync(f.path), 'исходный PNG удалён');
        const meta = await sharp(fs.readFileSync(r.file.path)).metadata();
        assert.equal(meta.format, 'webp');
        assert.equal(meta.width, 1600);
        assert.equal(meta.height, 600, 'пропорции сохранены');
        assert.ok(r.after < r.before, `${r.after} < ${r.before}`);
    });

    await check('JPG 1200px → WebP той же ширины (маленькие не растягиваются)', async () => {
        const f = await makeImage('2-jpg.jpg', 1200, 450, 'jpeg');
        const r = await bannerToWebp(f, { sharp });
        assert.equal(r.status, 'converted');
        const meta = await sharp(fs.readFileSync(r.file.path)).metadata();
        assert.equal(meta.format, 'webp');
        assert.equal(meta.width, 1200);
        assert.ok(r.after < r.before);
        assert.ok(!fs.existsSync(f.path));
    });

    await check('тяжёлый WebP пережимается в тот же файл .webp', async () => {
        const f = await makeImage('3-heavy.webp', 2000, 750, 'webp');
        const r = await bannerToWebp(f, { sharp });
        assert.equal(r.status, 'converted');
        assert.equal(r.file.path, f.path);
        assert.ok(fs.statSync(f.path).size < f.size);
        assert.equal((await sharp(fs.readFileSync(f.path)).metadata()).width, 1600);
    });

    await check('уже лёгкий WebP не трогается (не раздувается)', async () => {
        const name = '4-small.webp';
        const file = path.join(uploads, name);
        await sharp({ create: { width: 600, height: 240, channels: 3, background: '#ff7a00' } }).webp({ quality: 40 }).toFile(file);
        const before = fs.readFileSync(file);
        const r = await bannerToWebp({ filename: name, path: file }, { sharp });
        assert.equal(r.status, 'kept-original');
        assert.deepEqual(fs.readFileSync(file), before);
        assert.equal(fs.readdirSync(uploads).filter((n) => n.includes('.tmp')).length, 0, 'временных файлов не осталось');
    });

    await check('без sharp и при битом файле — исходник остаётся, ошибки нет', async () => {
        const f = await makeImage('5-nosharp.png', 300, 100, 'png');
        const r1 = await bannerToWebp(f, { sharp: null });
        assert.equal(r1.status, 'no-sharp');
        assert.equal(r1.file, f);
        assert.ok(fs.existsSync(f.path));
        const broken = path.join(uploads, '6-broken.png');
        fs.writeFileSync(broken, 'not an image');
        const r2 = await bannerToWebp({ filename: '6-broken.png', path: broken }, { sharp });
        assert.equal(r2.status, 'error');
        assert.ok(fs.existsSync(broken));
        assert.equal(fs.readdirSync(uploads).filter((n) => n.includes('.tmp')).length, 0);
    });

    // Контроллер целиком: копия во временной папке, db и publicApiBase подменены.
    const app = path.join(tmpRoot, 'app');
    for (const rel of ['controllers/homeBanners.controller.js', 'lib/bannerImage.js', 'lib/imageOptimize.js']) {
        fs.mkdirSync(path.dirname(path.join(app, rel)), { recursive: true });
        fs.copyFileSync(path.join(root, rel), path.join(app, rel));
    }
    fs.mkdirSync(path.join(app, 'uploads', 'banners'), { recursive: true });
    const queries = [];
    const row = { id: 1, position: 1, image: '', image_dark: '', url: '', updated_at: null };
    const db = {
        async query(sql, params = []) {
            queries.push({ sql, params });
            if (/^SELECT/i.test(sql)) return [[{ ...row }]];
            if (/^UPDATE/i.test(sql)) {
                const m = sql.match(/SET (.*) WHERE/i);
                const cols = m ? m[1].split(',').map((s) => s.trim().split(/\s*=/)[0]) : [];
                cols.forEach((c, i) => (row[c] = params[i]));
            }
            return [{ affectedRows: 1 }];
        },
    };
    const origLoad = Module._load;
    Module._load = function (request, parent, isMain) {
        if (parent && parent.filename && parent.filename.startsWith(app)) {
            if (request === '../db') return db;
            if (request === '../utils/publicApiBase') return { getPublicApiBase: () => 'https://api.example' };
            if (request === 'sharp') return sharp;
        }
        return origLoad.apply(this, arguments);
    };
    const controller = require(path.join(app, 'controllers/homeBanners.controller.js'));
    const call = (req) =>
        new Promise((resolve) => {
            const res = {
                statusCode: 200,
                status(c) {
                    this.statusCode = c;
                    return this;
                },
                json(body) {
                    resolve({ status: this.statusCode, body });
                },
            };
            controller.update(req, res);
        });
    const appUploads = path.join(app, 'uploads', 'banners');
    async function upload(name, w, h, fmt) {
        const f = await makeImage(name, w, h, fmt);
        const dest = path.join(appUploads, name);
        fs.renameSync(f.path, dest);
        return { fieldname: 'x', filename: name, path: dest, size: fs.statSync(dest).size, mimetype: `image/${fmt}` };
    }

    await check('контроллер: светлая PNG и тёмная JPG сохраняются в БД как .webp', async () => {
        const light = await upload('10-light.png', 2400, 900, 'png');
        const dark = await upload('11-dark.jpg', 1800, 675, 'jpeg');
        const req = { params: { position: '1' }, body: { url: '/x' }, files: { image: [light], image_dark: [dark] } };
        const out = await call(req);
        assert.equal(out.status, 200, JSON.stringify(out.body));
        assert.equal(out.body.data.image, 'https://api.example/uploads/banners/10-light.webp');
        assert.equal(out.body.data.image_dark, 'https://api.example/uploads/banners/11-dark.webp');
        assert.deepEqual(fs.readdirSync(appUploads).sort(), ['10-light.webp', '11-dark.webp']);
        assert.equal(req.files.image[0].filename, '10-light.webp', 'req.files указывает на WebP (фоновая копия imageOptimize не нужна)');
    });

    await check('контроллер: неверный слот — загруженные файлы удаляются', async () => {
        const f = await upload('12-bad.png', 400, 150, 'png');
        const out = await call({ params: { position: '3' }, body: {}, files: { image: [f] } });
        assert.equal(out.status, 400);
        assert.ok(!fs.existsSync(f.path));
    });

    Module._load = origLoad;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
