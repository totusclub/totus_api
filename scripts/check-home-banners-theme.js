// Баннеры главной: картинки для светлой и тёмной темы у каждого из двух баннеров.
// Без БД и без npm install — подменённые db и publicApiBase.
// Запуск: node scripts/check-home-banners-theme.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const root = path.resolve(__dirname, '..');
// Контроллер запускается из временной копии: файлы «загрузок» пишутся во временную папку,
// а не в настоящий uploads/banners.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'home-banners-'));
fs.mkdirSync(path.join(tmpRoot, 'controllers'));
fs.copyFileSync(path.join(root, 'controllers', 'homeBanners.controller.js'), path.join(tmpRoot, 'controllers', 'homeBanners.controller.js'));
// Конвертация в WebP (lib/bannerImage.js) — настоящая; «загрузки» в тесте не картинки, поэтому остаются как есть.
fs.mkdirSync(path.join(tmpRoot, 'lib'));
for (const name of ['bannerImage.js', 'imageOptimize.js']) fs.copyFileSync(path.join(root, 'lib', name), path.join(tmpRoot, 'lib', name));
let passed = 0;
let failed = 0;

async function check(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ok   ${name}`);
    } catch (e) {
        failed++;
        console.log(`  FAIL ${name}\n       ${e && e.message ? e.message : e}`);
    }
}

/* ── подменённая таблица home_banners ─────────────────────────────────── */
function makeDb({ hasDarkColumn = true } = {}) {
    const rows = [
        { id: 1, position: 1, image: '/uploads/banners/light1.png', url: 'https://totus.club/apps', updated_at: 't' },
        { id: 2, position: 2, image: '', url: '', updated_at: 't' },
    ];
    if (hasDarkColumn) rows.forEach((r) => { r.image_dark = ''; });
    const log = [];
    return {
        rows,
        log,
        async query(sql, params = []) {
            log.push({ sql, params });
            if (!hasDarkColumn && /image_dark/.test(sql)) {
                const err = new Error("Unknown column 'image_dark' in 'field list'");
                err.code = 'ER_BAD_FIELD_ERROR';
                throw err;
            }
            if (/^SELECT \* FROM home_banners ORDER BY/.test(sql)) return [rows.map((r) => ({ ...r }))];
            if (/^SELECT \* FROM home_banners WHERE position = \?/.test(sql)) {
                return [rows.filter((r) => r.position === params[0]).map((r) => ({ ...r }))];
            }
            if (/^UPDATE home_banners SET /.test(sql)) {
                const set = sql.slice('UPDATE home_banners SET '.length, sql.indexOf(' WHERE')).split(', ');
                const row = rows.find((r) => r.position === params[params.length - 1]);
                set.forEach((part, i) => { row[part.split(' = ')[0]] = params[i]; });
                return [{ affectedRows: 1 }];
            }
            if (/^INSERT INTO home_banners/.test(sql)) {
                const cols = sql.match(/\(([^)]+)\) VALUES/)[1].split(', ');
                const row = { id: rows.length + 1, updated_at: 't' };
                cols.forEach((c, i) => { row[c] = params[i]; });
                if (hasDarkColumn && row.image_dark === undefined) row.image_dark = '';
                rows.push(row);
                return [{ insertId: row.id }];
            }
            throw new Error(`unexpected sql: ${sql}`);
        },
    };
}

function loadController(db) {
    const ctrlPath = path.join(tmpRoot, 'controllers', 'homeBanners.controller.js');
    const stubs = {
        [path.join(tmpRoot, 'db')]: db,
        [path.join(tmpRoot, 'utils', 'publicApiBase')]: { getPublicApiBase: () => 'https://api.totus.club' },
    };
    const realLoad = Module._load;
    Module._load = function (request, parent, isMain) {
        if (parent && parent.filename === ctrlPath) {
            const abs = path.resolve(path.dirname(parent.filename), request);
            if (stubs[abs]) return stubs[abs];
        }
        return realLoad.call(this, request, parent, isMain);
    };
    delete require.cache[ctrlPath];
    try {
        return require(ctrlPath);
    } finally {
        Module._load = realLoad;
    }
}

function fakeRes() {
    const res = { statusCode: 200, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    return res;
}

// Файлы «загружаются» во временную uploads/banners — проверяем, что старые удаляются.
const uploadsDir = path.join(tmpRoot, 'uploads', 'banners');
function fakeUpload(name) {
    fs.mkdirSync(uploadsDir, { recursive: true });
    fs.writeFileSync(path.join(uploadsDir, name), 'x');
    return { filename: name, path: path.join(uploadsDir, name) };
}
const upload = fakeUpload;
const exists = (name) => fs.existsSync(path.join(uploadsDir, name));

(async () => {
    console.log('Баннеры главной: светлая и тёмная тема');
    const routes = fs.readFileSync(path.join(root, 'routes', 'homeBanners.routes.js'), 'utf8');
    const migration = fs.readFileSync(path.join(root, 'scripts', 'migrate-home-banners.js'), 'utf8');

    await check('маршрут PUT принимает image и image_dark, GET как раньше', () => {
        assert.match(routes, /uploadBanner\.fields\(\[\s*\{ name: 'image', maxCount: 1 \},\s*\{ name: 'image_dark', maxCount: 1 \},\s*\]\)/);
        assert.match(routes, /publicRouter\.get\('\/home-banners', controller\.getAll\);/);
    });

    await check('миграция: колонка image_dark добавляется, если её нет; данные не трогаются', () => {
        assert.match(migration, /ALTER TABLE home_banners ADD COLUMN image_dark VARCHAR\(500\) NOT NULL DEFAULT '' AFTER image/);
        assert.match(migration, /columnExists\(table, 'image_dark'\)/);
        assert.ok(!/DROP|DELETE|TRUNCATE/.test(migration));
    });

    await check('GET: у каждого баннера image и image_dark (абсолютные ссылки или пусто)', async () => {
        const db = makeDb();
        db.rows[1].image_dark = '/uploads/banners/dark2.png';
        const c = loadController(db);
        const res = fakeRes();
        await c.getAll({}, res);
        assert.strictEqual(res.statusCode, 200);
        const [b1, b2] = res.body.data;
        assert.strictEqual(b1.image, 'https://api.totus.club/uploads/banners/light1.png');
        assert.strictEqual(b1.image_dark, '');
        assert.strictEqual(b2.image, '');
        assert.strictEqual(b2.image_dark, 'https://api.totus.club/uploads/banners/dark2.png');
        assert.strictEqual(b1.url, 'https://totus.club/apps');
    });

    await check('GET до миграции (нет колонки): image_dark пустая, ничего не падает', async () => {
        const c = loadController(makeDb({ hasDarkColumn: false }));
        const res = fakeRes();
        await c.getAll({}, res);
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.data[0].image_dark, '');
    });

    await check('PUT без файлов (только ссылка) — как раньше, image_dark не трогается', async () => {
        const db = makeDb({ hasDarkColumn: false });
        const c = loadController(db);
        const res = fakeRes();
        await c.update({ params: { position: '1' }, body: { url: 'https://x.ru' } }, res);
        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
        assert.strictEqual(db.rows[0].url, 'https://x.ru');
        assert.strictEqual(db.rows[0].image, '/uploads/banners/light1.png');
    });

    await check('PUT только светлая картинка — до миграции работает (старая админка, req.file)', async () => {
        const db = makeDb({ hasDarkColumn: false });
        const c = loadController(db);
        const res = fakeRes();
        await c.update({ params: { position: '2' }, body: { url: '' }, file: upload('new-light2.png') }, res);
        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
        assert.strictEqual(db.rows[1].image, '/uploads/banners/new-light2.png');
    });

    await check('PUT тёмная картинка баннера 2 — баннер 1 не меняется (настройки независимы)', async () => {
        const db = makeDb();
        const before = { ...db.rows[0] };
        const c = loadController(db);
        const res = fakeRes();
        await c.update({ params: { position: '2' }, body: { url: '' }, files: { image_dark: [upload('dark2.png')] } }, res);
        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
        assert.strictEqual(db.rows[1].image_dark, '/uploads/banners/dark2.png');
        assert.strictEqual(db.rows[1].image, '');
        assert.deepStrictEqual(db.rows[0], before);
        assert.strictEqual(res.body.data.image_dark, 'https://api.totus.club/uploads/banners/dark2.png');
    });

    await check('PUT обе картинки сразу; замена удаляет старые файлы (и их WebP-копии)', async () => {
        const db = makeDb();
        upload('light1.png');
        upload('light1.png.webp');
        db.rows[0].image_dark = '/uploads/banners/old-dark1.png';
        upload('old-dark1.png');
        const c = loadController(db);
        const res = fakeRes();
        await c.update({
            params: { position: '1' },
            body: { url: 'https://totus.club/apps' },
            files: { image: [upload('l1.png')], image_dark: [upload('d1.png')] },
        }, res);
        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
        assert.strictEqual(db.rows[0].image, '/uploads/banners/l1.png');
        assert.strictEqual(db.rows[0].image_dark, '/uploads/banners/d1.png');
        assert.ok(!exists('light1.png') && !exists('light1.png.webp') && !exists('old-dark1.png'), 'старые файлы удалены');
        assert.ok(exists('l1.png') && exists('d1.png'), 'новые на месте');
    });

    await check('«Убрать» тёмную картинку: image_dark пустая, файл удалён, светлая на месте', async () => {
        const db = makeDb();
        db.rows[0].image_dark = '/uploads/banners/d-remove.png';
        upload('d-remove.png');
        const c = loadController(db);
        const res = fakeRes();
        await c.update({ params: { position: '1' }, body: { url: '', remove_image_dark: '1' } }, res);
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(db.rows[0].image_dark, '');
        assert.strictEqual(db.rows[0].image, '/uploads/banners/light1.png');
        assert.ok(!exists('d-remove.png'));
    });

    await check('«Убрать» светлую картинку: image пустая (на сайте — стандартная картинка)', async () => {
        const db = makeDb();
        const c = loadController(db);
        const res = fakeRes();
        await c.update({ params: { position: '1' }, body: { url: '', remove_image: '1' } }, res);
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(db.rows[0].image, '');
    });

    await check('новый файл важнее «убрать» в том же запросе', async () => {
        const db = makeDb();
        const c = loadController(db);
        const res = fakeRes();
        await c.update({ params: { position: '1' }, body: { url: '', remove_image_dark: '1' }, files: { image_dark: [upload('d-keep.png')] } }, res);
        assert.strictEqual(db.rows[0].image_dark, '/uploads/banners/d-keep.png');
    });

    await check('тёмная картинка до миграции: понятная ошибка, загруженный файл удалён, данные целы', async () => {
        const db = makeDb({ hasDarkColumn: false });
        const c = loadController(db);
        const res = fakeRes();
        await c.update({ params: { position: '1' }, body: { url: 'https://new' }, files: { image_dark: [upload('orphan.png')] } }, res);
        assert.strictEqual(res.statusCode, 500);
        assert.match(res.body.message, /migrate-home-banners/);
        assert.ok(!exists('orphan.png'));
        assert.strictEqual(db.rows[0].url, 'https://totus.club/apps');
    });

    await check('слот 3 — 400, загруженные файлы удаляются', async () => {
        const c = loadController(makeDb());
        const res = fakeRes();
        await c.update({ params: { position: '3' }, body: {}, files: { image: [upload('bad.png')] } }, res);
        assert.strictEqual(res.statusCode, 400);
        assert.ok(!exists('bad.png'));
    });

    await check('нет строки баннера — создаётся с обеими картинками', async () => {
        const db = makeDb();
        db.rows.splice(1, 1);
        const c = loadController(db);
        const res = fakeRes();
        await c.update({ params: { position: '2' }, body: { url: 'u' }, files: { image: [upload('n2.png')], image_dark: [upload('n2d.png')] } }, res);
        assert.strictEqual(res.statusCode, 201);
        assert.strictEqual(res.body.data.image, 'https://api.totus.club/uploads/banners/n2.png');
        assert.strictEqual(res.body.data.image_dark, 'https://api.totus.club/uploads/banners/n2d.png');
    });

    fs.rmSync(tmpRoot, { recursive: true, force: true });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
