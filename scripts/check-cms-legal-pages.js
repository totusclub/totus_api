/**
 * Юридические документы в CMS (03.10.2026).
 * Поломка: новые документы (согласие на обработку персональных данных, согласие на рекламу, рекомендательные
 * технологии, реквизиты) нельзя было сохранить в админке — API отвечал 403
 * «This page cannot be edited via CMS», а публичный /api/pages/slug/:slug — 404.
 * Проверка грузит настоящий controllers/pages.controller.js с поддельной БД.
 */
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const dbPath = path.join(root, 'db.js');
const rows = new Map();
let nextId = 1;
require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
        async query(sql, params = []) {
            if (/^SELECT id FROM pages WHERE slug/.test(sql) || /^SELECT \* FROM pages WHERE slug/.test(sql)) {
                const r = [...rows.values()].find((x) => x.slug === params[0]);
                return [r ? [r] : []];
            }
            if (/^SELECT \* FROM pages WHERE id/.test(sql)) {
                const r = rows.get(Number(params[0]));
                return [r ? [r] : []];
            }
            if (/^INSERT INTO pages/.test(sql)) {
                const cols = sql.match(/\(([^)]+)\)/)[1].split(',').map((s) => s.trim());
                const r = { id: nextId++ };
                cols.forEach((c, i) => { r[c] = params[i]; });
                rows.set(r.id, r);
                return [{ insertId: r.id }];
            }
            if (/^UPDATE pages SET/.test(sql)) {
                const cols = [...sql.matchAll(/(\w+) = \?/g)].map((m) => m[1]).filter((c) => c !== 'id');
                const id = params[params.length - 1];
                const r = rows.get(Number(id));
                cols.forEach((c, i) => { r[c] = params[i]; });
                return [{}];
            }
            if (/^SELECT \* FROM pages ORDER BY/.test(sql)) return [[...rows.values()]];
            throw new Error('unexpected sql: ' + sql);
        },
    },
};

const { ALLOWED_CMS_PAGE_SLUGS, LEGAL_CMS_PAGE_SLUGS, isAllowedCmsPageSlug } = require(path.join(root, 'config/cmsPages'));
const ctrl = require(path.join(root, 'controllers/pages.controller'));

function res() {
    const r = { statusCode: 200, body: null };
    r.status = (c) => { r.statusCode = c; return r; };
    r.json = (b) => { r.body = b; return r; };
    return r;
}

let passed = 0;
async function check(name, fn) {
    await fn();
    passed += 1;
    console.log('ok', passed, name);
}

(async () => {
    const NEW = ['consent', 'ads-consent', 'recommendations', 'requisites'];
    const OLD = ['about-us', 'help-faq', 'partners', 'advertise', 'airlines', 'low-fare-tips',
        'badges-certificates', 'security', 'cookie-settings', 'privacy-policy', 'terms'];
    // Пачка 2 (туры и размещение): slug → полное название документа
    const PACK2 = {
        'tour-offer': 'Оферта о заключении договора о реализации туристского продукта',
        'hotel-booking': 'Условия бронирования размещения',
        'cancellation': 'Изменение, отмена и возврат',
        'tourist-memo': 'Памятка туристу',
        'payment': 'Оплата и возврат денег',
    };
    const PACK2_SLUGS = Object.keys(PACK2);
    // Редакция от 30.10.2026: отдельные согласия и приложения к договору
    const PACK3 = {
        'personalization-consent': 'Согласие на обработку персональных данных для персональных рекомендаций',
        'marketing-data-consent': 'Согласие на обработку персональных данных для направления рекламы',
        'booking-application': 'Форма заявки на бронирование туристского продукта',
        'operator-information': 'Форма информации о туроператоре',
    };
    const PACK3_SLUGS = Object.keys(PACK3);

    await check('новые юридические страницы разрешены', () => {
        NEW.forEach((s) => assert.ok(isAllowedCmsPageSlug(s), s));
    });
    await check('страницы пачки 2 (туры и размещение) разрешены', () => {
        PACK2_SLUGS.forEach((s) => assert.ok(isAllowedCmsPageSlug(s), s));
        PACK2_SLUGS.forEach((s) => assert.ok(LEGAL_CMS_PAGE_SLUGS.includes(s), s));
    });
    await check('прежние 11 страниц по-прежнему разрешены', () => {
        OLD.forEach((s) => assert.ok(isAllowedCmsPageSlug(s), s));
        assert.strictEqual(ALLOWED_CMS_PAGE_SLUGS.size, OLD.length + NEW.length + PACK2_SLUGS.length + PACK3_SLUGS.length);
    });
    await check('посторонний slug запрещён', () => {
        ['admin', 'unknown-page', 'tour-offer-old', '', ' '].forEach((s) => assert.ok(!isAllowedCmsPageSlug(s), JSON.stringify(s)));
    });
    await check('документы редакции 30.10.2026 разрешены и в списке', () => {
        PACK3_SLUGS.forEach((s) => assert.ok(isAllowedCmsPageSlug(s), s));
        PACK3_SLUGS.forEach((s) => assert.ok(LEGAL_CMS_PAGE_SLUGS.includes(s), s));
    });
    await check('список юридических документов — 16, все разрешены, без повторов', () => {
        assert.strictEqual(LEGAL_CMS_PAGE_SLUGS.length, 16);
        assert.strictEqual(new Set(LEGAL_CMS_PAGE_SLUGS).size, 16);
        LEGAL_CMS_PAGE_SLUGS.forEach((s) => assert.ok(isAllowedCmsPageSlug(s), s));
    });
    for (const slug of NEW) {
        await check(`админка сохраняет «${slug}» (201), повторно — обновляет`, async () => {
            const r1 = res();
            await ctrl.savePage({ body: { slug, name: 'Документ', section: 'legal', content: '<p>v1</p>' } }, r1);
            assert.strictEqual(r1.statusCode, 201, JSON.stringify(r1.body));
            const r2 = res();
            await ctrl.savePage({ body: { slug, name: 'Документ', section: 'legal', content: '<p>v2</p>' } }, r2);
            assert.strictEqual(r2.statusCode, 200);
            assert.strictEqual(r2.body.content, '<p>v2</p>');
        });
        await check(`публичный /api/pages/slug/${slug} отдаёт текст`, async () => {
            const r = res();
            await ctrl.getPageBySlug({ params: { slug } }, r);
            assert.strictEqual(r.statusCode, 200);
            assert.strictEqual(r.body.content, '<p>v2</p>');
            assert.strictEqual(r.body.section, 'legal');
        });
    }
    for (const slug of [...PACK2_SLUGS, ...PACK3_SLUGS]) {
        const name = PACK2[slug] || PACK3[slug];
        await check(`админка сохраняет «${name}» (${slug}), публичный API отдаёт текст`, async () => {
            const r1 = res();
            await ctrl.savePage({ body: { slug, name, section: 'legal', content: '<p>v1</p>' } }, r1);
            assert.strictEqual(r1.statusCode, 201, JSON.stringify(r1.body));
            const r2 = res();
            await ctrl.savePage({ body: { slug, name, section: 'legal', content: '<p>v2</p>' } }, r2);
            assert.strictEqual(r2.statusCode, 200);
            const r3 = res();
            await ctrl.getPageBySlug({ params: { slug } }, r3);
            assert.strictEqual(r3.statusCode, 200);
            assert.strictEqual(r3.body.content, '<p>v2</p>');
            assert.strictEqual(r3.body.name, name);
            assert.strictEqual(r3.body.section, 'legal');
        });
    }
    await check('посторонний slug: сохранение 403, чтение 404', async () => {
        const r1 = res();
        await ctrl.savePage({ body: { slug: 'unknown-page', name: 'x', content: 'x' } }, r1);
        assert.strictEqual(r1.statusCode, 403);
        const r2 = res();
        await ctrl.getPageBySlug({ params: { slug: 'unknown-page' } }, r2);
        assert.strictEqual(r2.statusCode, 404);
    });
    console.log(`check-cms-legal-pages: ${passed} passed`);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
