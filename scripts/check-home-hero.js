// Проверка hero-блока главной без БД и сети: node scripts/check-home-hero.js
//
// Контроллер работает с поддельной БД в памяти (подменяется модуль ../db),
// проверяются: перенос старого изображения, случайный выбор, добавление,
// замена, удаление и обработка ошибок.
const assert = require('assert');
const path = require('path');
const fs = require('fs');

/* ── Поддельная БД ───────────────────────────────────────────────────────── */

const state = {
    hero: { id: 1, title: 'Путешествия начинаются здесь', image: '/uploads/hero/legacy.jpg', updated_at: null },
    images: [],
    nextId: 1,
    failNextInsert: false,
};

function norm(sql) {
    return sql.replace(/\s+/g, ' ').trim();
}

const fakeDb = {
    async query(rawSql, params = []) {
        const sql = norm(rawSql);
        if (sql.startsWith('CREATE TABLE IF NOT EXISTS home_hero_images')) return [{}];
        if (sql === 'SELECT image FROM home_hero WHERE id = 1 LIMIT 1') {
            return [state.hero ? [{ image: state.hero.image }] : []];
        }
        if (sql.startsWith('INSERT INTO home_hero_images (image, sort_order) SELECT')) {
            const [image] = params;
            if (!state.images.some((r) => r.image === image)) {
                state.images.push({ id: state.nextId++, image, sort_order: 0 });
            }
            return [{}];
        }
        if (sql === "UPDATE home_hero SET image = '' WHERE id = 1") {
            if (state.hero) state.hero.image = '';
            return [{}];
        }
        if (sql === 'SELECT * FROM home_hero_images ORDER BY sort_order ASC, id ASC') {
            const rows = [...state.images].sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
            return [rows.map((r) => ({ ...r }))];
        }
        if (sql === 'SELECT * FROM home_hero WHERE id = 1 LIMIT 1') return [state.hero ? [{ ...state.hero }] : []];
        if (sql === 'SELECT id FROM home_hero WHERE id = 1 LIMIT 1') return [state.hero ? [{ id: 1 }] : []];
        if (sql.startsWith('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next')) {
            const max = state.images.reduce((m, r) => Math.max(m, r.sort_order), -1);
            return [[{ next: max + 1 }]];
        }
        if (sql === 'INSERT INTO home_hero_images (image, sort_order) VALUES (?, ?)') {
            if (state.failNextInsert) {
                state.failNextInsert = false;
                throw new Error('db down');
            }
            const row = { id: state.nextId++, image: params[0], sort_order: params[1] };
            state.images.push(row);
            return [{ insertId: row.id }];
        }
        if (sql === "INSERT INTO home_hero (id, title, image) VALUES (1, ?, '')") {
            state.hero = { id: 1, title: params[0], image: '', updated_at: null };
            return [{}];
        }
        if (sql === 'UPDATE home_hero SET title = ? WHERE id = 1') {
            state.hero.title = params[0];
            return [{}];
        }
        if (sql.startsWith('SELECT * FROM home_hero_images WHERE id = ?')) {
            return [state.images.filter((r) => r.id === Number(params[0])).map((r) => ({ ...r }))];
        }
        if (sql.startsWith('UPDATE home_hero_images SET ')) {
            const id = params[params.length - 1];
            const row = state.images.find((r) => r.id === id);
            const sets = sql.slice('UPDATE home_hero_images SET '.length, sql.indexOf(' WHERE')).split(', ');
            sets.forEach((set, i) => {
                const col = set.split(' = ')[0];
                row[col] = params[i];
            });
            return [{}];
        }
        if (sql === 'DELETE FROM home_hero_images WHERE id = ?') {
            state.images = state.images.filter((r) => r.id !== params[0]);
            return [{}];
        }
        throw new Error(`fake db: unexpected SQL: ${sql}`);
    },
};

require.cache[require.resolve('../db')] = { id: 'db', filename: 'db', loaded: true, exports: fakeDb };

// Удаление файлов — только запись в журнал, реальная ФС не трогается.
const deleted = [];
const origExists = fs.existsSync;
const origUnlink = fs.unlinkSync;
const uploadsRoot = path.join(__dirname, '..', 'uploads', 'hero');
fs.existsSync = (p) => (String(p).startsWith(uploadsRoot) ? true : origExists(p));
fs.unlinkSync = (p) => {
    if (String(p).startsWith(uploadsRoot)) {
        deleted.push(path.basename(String(p)));
        return;
    }
    return origUnlink(p);
};

const controller = require('../controllers/homeHero.controller');
const { pickRandom } = controller._internal;

/* ── Поддельные req/res ────────────────────────────────────────────────── */

function makeReq({ body = {}, params = {}, file, files } = {}) {
    return {
        body,
        params,
        file,
        files,
        protocol: 'https',
        get: (h) => (h.toLowerCase() === 'host' ? 'api.totus.club' : undefined),
    };
}

function makeRes() {
    const res = { statusCode: 200, headers: {}, body: undefined };
    res.status = (c) => ((res.statusCode = c), res);
    res.json = (b) => ((res.body = b), res);
    res.set = (k, v) => ((res.headers[k.toLowerCase()] = v), res);
    return res;
}

async function call(handler, reqInit) {
    const res = makeRes();
    await handler(makeReq(reqInit), res);
    return res;
}

const f = (name) => ({ filename: name });
const BASE = 'https://api.totus.club';

(async () => {
    process.env.API_PUBLIC_URL = BASE;

    // pickRandom
    assert.strictEqual(pickRandom([]), null);
    assert.strictEqual(pickRandom(null), null);
    assert.strictEqual(pickRandom(['a']), 'a');
    const seen = new Set();
    for (let i = 0; i < 300; i += 1) seen.add(pickRandom(['a', 'b', 'c']));
    assert.deepStrictEqual([...seen].sort(), ['a', 'b', 'c'], 'все варианты выпадают');

    // 1. Первое обращение переносит старое изображение home_hero.image в список
    let res = await call(controller.get);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.data.image, `${BASE}/uploads/hero/legacy.jpg`, 'одно изображение — всегда оно');
    assert.strictEqual(res.body.data.images_count, 1);
    assert.strictEqual(state.hero.image, '', 'старая колонка очищена');
    assert.match(res.headers['cache-control'], /no-store/, 'ответ не кэшируется');

    // 2. Добавление нескольких изображений за раз
    res = await call(controller.addImages, { files: { images: [f('a.jpg'), f('b.jpg'), f('c.webp')] } });
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.body.data.length, 3);
    assert.strictEqual(res.body.images.length, 4);
    assert.deepStrictEqual(
        res.body.images.map((i) => i.sort_order),
        [0, 1, 2, 3],
        'новые изображения — в конец списка',
    );

    // одно изображение полем image
    res = await call(controller.addImages, { files: { image: [f('d.png')] } });
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.body.images.length, 5);

    // без файла — 400
    res = await call(controller.addImages, {});
    assert.strictEqual(res.statusCode, 400);

    // 3. Случайный выбор: за много заходов выпадают все изображения
    const picked = new Set();
    for (let i = 0; i < 400; i += 1) {
        const r = await call(controller.get);
        picked.add(r.body.data.image);
        assert.strictEqual(r.body.data.images_count, 5);
    }
    assert.strictEqual(picked.size, 5, 'каждое из 5 изображений показывается');

    // 4. Админка видит все изображения
    res = await call(controller.getAdmin);
    assert.strictEqual(res.body.data.images.length, 5);
    assert.strictEqual(res.body.data.image, res.body.data.images[0].image);
    assert.ok(res.body.data.images.every((i) => i.image.startsWith(`${BASE}/uploads/hero/`)));

    // 5. Замена изображения: новый файл, старый удалён с диска
    const target = state.images.find((r) => r.image.endsWith('b.jpg'));
    res = await call(controller.updateImage, { params: { id: String(target.id) }, file: f('b2.jpg') });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.data.image, `${BASE}/uploads/hero/b2.jpg`);
    assert.ok(deleted.includes('b.jpg'), 'старый файл удалён');
    assert.strictEqual(state.images.length, 5, 'количество не изменилось');

    // замена несуществующего — 404, загруженный файл удалён
    res = await call(controller.updateImage, { params: { id: '999' }, file: f('orphan.jpg') });
    assert.strictEqual(res.statusCode, 404);
    assert.ok(deleted.includes('orphan.jpg'));

    // без файла — 400; кривой id — 400
    res = await call(controller.updateImage, { params: { id: String(target.id) } });
    assert.strictEqual(res.statusCode, 400);
    res = await call(controller.updateImage, { params: { id: 'abc' }, file: f('x.jpg') });
    assert.strictEqual(res.statusCode, 400);

    // 6. Удаление
    const toDelete = state.images.find((r) => r.image.endsWith('c.webp'));
    res = await call(controller.deleteImage, { params: { id: String(toDelete.id) } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(state.images.length, 4);
    assert.ok(deleted.includes('c.webp'));
    res = await call(controller.deleteImage, { params: { id: String(toDelete.id) } });
    assert.strictEqual(res.statusCode, 404);

    // 7. Заголовок: PUT /home-hero без файла меняет только заголовок
    res = await call(controller.update, { body: { title: 'Новый заголовок' } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.data.title, 'Новый заголовок');
    assert.strictEqual(res.body.data.images.length, 4);
    // старая админка присылает файл вместе с заголовком — изображение добавляется
    res = await call(controller.update, { body: { title: 'Новый заголовок' }, file: f('old-admin.jpg') });
    assert.strictEqual(res.body.data.images.length, 5);
    // пустой заголовок — значение по умолчанию
    res = await call(controller.update, { body: { title: '   ' } });
    assert.strictEqual(res.body.data.title, 'Путешествия начинаются здесь');

    // 8. Ошибка БД при добавлении — загруженные файлы не остаются на диске
    state.failNextInsert = true;
    res = await call(controller.addImages, { files: { images: [f('fail.jpg')] } });
    assert.strictEqual(res.statusCode, 500);
    assert.ok(deleted.includes('fail.jpg'));

    // 9. Удалили всё — сайт получает пустое изображение (без заглушки)
    for (const row of [...state.images]) {
        await call(controller.deleteImage, { params: { id: String(row.id) } });
    }
    res = await call(controller.get);
    assert.strictEqual(res.body.data.image, '');
    assert.strictEqual(res.body.data.images_count, 0);

    // 10. Одно изображение — всегда оно
    await call(controller.addImages, { files: { image: [f('only.jpg')] } });
    for (let i = 0; i < 20; i += 1) {
        const r = await call(controller.get);
        assert.strictEqual(r.body.data.image, `${BASE}/uploads/hero/only.jpg`);
    }

    fs.existsSync = origExists;
    fs.unlinkSync = origUnlink;
    console.log('ALL HOME HERO CHECKS PASSED');
    process.exit(0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
