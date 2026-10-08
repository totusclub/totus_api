'use strict';

/**
 * Мобильная версия hero (lib/heroMobile.js): node scripts/check-hero-mobile.js
 * Без сети и БД. Если sharp установлен — настоящая обрезка картинки; иначе — подставной sharp.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    heroMobileRel,
    mobileCropBox,
    makeHeroMobile,
    createHeroMobileIndex,
    loadSharp,
    MOBILE_ASPECT,
} = require('../lib/heroMobile');
const { cacheControlFor, IMMUTABLE } = require('../lib/staticCache');

let passed = 0;
async function check(name, fn) {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
}

const quietLog = { log() {}, warn() {} };

(async () => {
    console.log('Hero: мобильная версия картинки');

    await check('имя версии: <файл>.m.webp рядом, только для /uploads/hero/', () => {
        assert.strictEqual(heroMobileRel('/uploads/hero/1791384594380-322827423.webp'), '/uploads/hero/1791384594380-322827423.webp.m.webp');
        assert.strictEqual(heroMobileRel('/uploads/hero/1.png'), '/uploads/hero/1.png.m.webp');
        assert.strictEqual(heroMobileRel('https://cdn.example.com/uploads/hero/1.png'), '');
        assert.strictEqual(heroMobileRel('/uploads/banners/1.png'), '');
        assert.strictEqual(heroMobileRel('/uploads/hero/../orders/1.pdf'), '');
        assert.strictEqual(heroMobileRel('/uploads/hero/1.png.m.webp'), '');
        assert.strictEqual(heroMobileRel(''), '');
        assert.strictEqual(heroMobileRel(null), '');
    });

    await check('обрезка: центр, пропорция 1,15 : 1 во всю высоту; высота не больше 1000; узкая — целиком', () => {
        assert.strictEqual(MOBILE_ASPECT, 1.15);
        assert.deepStrictEqual(mobileCropBox(2011, 782), { left: 556, top: 0, width: 899, height: 782, outHeight: 782 });
        assert.deepStrictEqual(mobileCropBox(4000, 2000), { left: 850, top: 0, width: 2300, height: 2000, outHeight: 1000 });
        assert.deepStrictEqual(mobileCropBox(600, 900), { left: 0, top: 0, width: 600, height: 900, outHeight: 900 });
        // экран 600×528 (самый широкий из «мобильных») закрывается без растяжения: 1,15 ≥ 600/528
        assert.ok(MOBILE_ASPECT >= 600 / 528);
    });

    await check('кеш: .m.webp — уникальное имя, год immutable', () => {
        assert.strictEqual(cacheControlFor('/hero/1791384594380-322827423.webp.m.webp'), IMMUTABLE);
        assert.strictEqual(cacheControlFor('/hero/1791384594380-322827423.png.m.webp'), IMMUTABLE);
        assert.notStrictEqual(cacheControlFor('/hero/hero.m.webp'), IMMUTABLE);
    });

    await check('создание файла: рядом с оригиналом, меньше его; повторно — exists; без sharp — no-sharp', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heromob-'));
        const sharp = loadSharp();
        const src = path.join(dir, '1791384594380-322827423.webp');
        if (sharp) {
            // шумная картинка 2011×782 — как настоящий hero по размеру
            const raw = Buffer.alloc(2011 * 782 * 3);
            for (let i = 0; i < raw.length; i += 1) raw[i] = (i * 7919 + ((i / 3) | 0) * 104729) % 251;
            await sharp(raw, { raw: { width: 2011, height: 782, channels: 3 } }).webp({ quality: 95 }).toFile(src);
            const r = await makeHeroMobile(src, { sharp });
            assert.strictEqual(r.status, 'created', JSON.stringify(r));
            const meta = await sharp(`${src}.m.webp`).metadata();
            assert.strictEqual(meta.width, 899);
            assert.strictEqual(meta.height, 782);
            assert.strictEqual(meta.format, 'webp');
            assert.ok(r.after < r.before, 'мобильная версия меньше оригинала');
            console.log(`       (sharp: ${Math.round(r.before / 1024)} → ${Math.round(r.after / 1024)} КБ)`);
        } else {
            fs.writeFileSync(src, Buffer.alloc(5000));
            const calls = [];
            const fake = () => {
                const chain = {
                    metadata: async () => ({ width: 2011, height: 782 }),
                    rotate: () => chain,
                    extract: (b) => (calls.push(['extract', b]), chain),
                    resize: (o) => (calls.push(['resize', o]), chain),
                    webp: (o) => (calls.push(['webp', o]), chain),
                    toFile: async (out) => fs.writeFileSync(out, Buffer.alloc(900)),
                };
                return chain;
            };
            const r = await makeHeroMobile(src, { sharp: fake });
            assert.strictEqual(r.status, 'created');
            assert.deepStrictEqual(calls[0], ['extract', { left: 556, top: 0, width: 899, height: 782 }]);
            assert.deepStrictEqual(calls[1], ['resize', { height: 782, withoutEnlargement: true }]);
            assert.deepStrictEqual(calls[2], ['webp', { quality: 75 }]);
        }
        assert.ok(fs.existsSync(src), 'оригинал на месте');
        assert.strictEqual((await makeHeroMobile(src, { sharp: sharp || (() => ({})) })).status, 'exists');
        assert.strictEqual((await makeHeroMobile(src, { sharp: null })).status, 'no-sharp');
        assert.strictEqual((await makeHeroMobile(path.join(dir, 'missing.webp'), { sharp: sharp || (() => ({})) })).status, 'error');
        assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), [], 'временных файлов не осталось');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    await check('версия больше оригинала — не сохраняется (сайт берёт оригинал)', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heromob-'));
        const src = path.join(dir, 'tiny.webp');
        fs.writeFileSync(src, Buffer.alloc(100));
        const fake = () => {
            const chain = {
                metadata: async () => ({ width: 300, height: 200 }),
                rotate: () => chain,
                extract: () => chain,
                resize: () => chain,
                webp: () => chain,
                toFile: async (out) => fs.writeFileSync(out, Buffer.alloc(500)),
            };
            return chain;
        };
        assert.strictEqual((await makeHeroMobile(src, { sharp: fake })).status, 'larger');
        assert.ok(!fs.existsSync(`${src}.m.webp`));
        fs.rmSync(dir, { recursive: true, force: true });
    });

    await check('ответ API: есть версия — путь; нет — пусто сразу, создание в фоне, следующий заход получает', async () => {
        const files = new Set(['/uploads/hero/a.webp', '/uploads/hero/b.webp', '/uploads/hero/ready.webp', '/uploads/hero/ready.webp.m.webp']);
        const relOf = (abs) => abs.slice(path.join(__dirname, '..').length).split(path.sep).join('/');
        const stat = async (abs) => {
            if (!files.has(relOf(abs))) throw new Error('ENOENT');
            return { isFile: () => true };
        };
        let release;
        const generated = [];
        const generate = (abs) =>
            new Promise((resolve) => {
                generated.push(relOf(abs));
                release = () => {
                    files.add(`${relOf(abs)}.m.webp`);
                    resolve({ status: 'created', before: 300000, after: 50000 });
                };
            });
        let t = 0;
        const index = createHeroMobileIndex({ stat, generate, now: () => t, log: quietLog });

        assert.strictEqual(await index.lookup('/uploads/hero/ready.webp'), '/uploads/hero/ready.webp.m.webp');

        // версии нет: ответ не ждёт создания (≤ 30 мс), создание одно на несколько запросов
        const started = Date.now();
        assert.strictEqual(await index.lookup('/uploads/hero/a.webp', 20), '');
        assert.strictEqual(await index.lookup('/uploads/hero/a.webp', 20), '');
        assert.ok(Date.now() - started < 500, 'запрос не держится до конца создания');
        assert.deepStrictEqual(generated, ['/uploads/hero/a.webp']);
        release();
        await new Promise((r) => setImmediate(r));
        assert.strictEqual(await index.lookup('/uploads/hero/a.webp'), '/uploads/hero/a.webp.m.webp');

        // нет оригинала на диске — ничего не создаём
        assert.strictEqual(await index.lookup('/uploads/hero/gone.webp'), '');
        assert.deepStrictEqual(generated, ['/uploads/hero/a.webp']);

        // внешняя ссылка — без проверки диска
        assert.strictEqual(await index.lookup('https://cdn.example.com/x.webp'), '');

        // удаление картинки — состояние забыто
        files.delete('/uploads/hero/a.webp.m.webp');
        index.forget('/uploads/hero/a.webp');
        t += 1;
        const again = index.lookup('/uploads/hero/a.webp', 20);
        assert.strictEqual(await again, '');
        assert.deepStrictEqual(generated, ['/uploads/hero/a.webp', '/uploads/hero/a.webp']);
        release();

        // ошибка создания — пусто, процесс не падает
        const broken = createHeroMobileIndex({
            stat,
            generate: async () => ({ status: 'error', error: 'bad image' }),
            log: quietLog,
        });
        assert.strictEqual(await broken.lookup('/uploads/hero/b.webp', 200), '');
    });

    console.log(`\n${passed} passed`);
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
