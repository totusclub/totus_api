/**
 * Загрузка юридических документов в CMS (редакция 30.10.2026): scripts/apply-legal-pages.js.
 * Поддельная БД: проверяем план, запись, бэкап прежних текстов и повторный запуск.
 */
const path = require('path');
const assert = require('assert');
const fs = require('fs');

const root = path.join(__dirname, '..');
const { loadPages, applyPages } = require(path.join(root, 'scripts/apply-legal-pages.js'));
const { LEGAL_CMS_PAGE_SLUGS } = require(path.join(root, 'config/cmsPages'));

function fakeDb(initial) {
    const rows = new Map(initial.map((r, i) => [i + 1, { id: i + 1, ...r }]));
    let nextId = initial.length + 1;
    const writes = [];
    return {
        rows, writes,
        async query(sql, params = []) {
            if (/^SELECT \* FROM pages WHERE slug/.test(sql)) {
                const r = [...rows.values()].find((x) => x.slug === params[0]);
                return [r ? [r] : []];
            }
            if (/^INSERT INTO pages/.test(sql)) {
                writes.push('insert');
                const cols = sql.match(/\(([^)]+)\)/)[1].split(',').map((s) => s.trim());
                const r = { id: nextId++ };
                cols.forEach((c, i) => { r[c] = params[i]; });
                rows.set(r.id, r);
                return [{ insertId: r.id }];
            }
            if (/^UPDATE pages SET name = \?, content = \? WHERE id = \?/.test(sql)) {
                writes.push('update');
                const r = rows.get(Number(params[2]));
                r.name = params[0]; r.content = params[1];
                return [{}];
            }
            throw new Error('unexpected sql: ' + sql);
        },
    };
}

let passed = 0;
async function check(name, fn) { await fn(); passed += 1; console.log('ok', passed, name); }

(async () => {
    const { pages, edition } = loadPages();
    const NEW = ['personalization-consent', 'marketing-data-consent', 'booking-application', 'operator-information'];

    await check('16 документов, все из списка, редакция 30.10.2026', () => {
        assert.strictEqual(edition, '30.10.2026');
        assert.deepStrictEqual(pages.map((p) => p.slug).sort(), [...LEGAL_CMS_PAGE_SLUGS].sort());
    });
    await check('в текстах нет заглушек, прежнего имени ассистента, личного ИНН, сокращений', () => {
        for (const p of pages) {
            for (const bad of ['[[', '⟦', 'legal-ph', '____', '.docx', 'Мила', 'Эдуард', '772983990623', 'ПДн', 'ГИС ', 'АРЛЕКИНОТУР', 'Арлекинотур', 'Скоро']) {
                assert.ok(!p.content.includes(bad), `${p.slug}: «${bad}»`);
            }
            assert.ok(/^<p><em>Редакция от 30\.10\.2026<\/em><\/p>/.test(p.content), p.slug);
        }
    });
    await check('ссылки только на страницы из списка и внешние https', () => {
        const allowed = new Set(LEGAL_CMS_PAGE_SLUGS);
        for (const p of pages) {
            for (const m of p.content.matchAll(/href="([^"]+)"/g)) {
                const href = m[1];
                if (href.startsWith('https://')) continue;
                assert.ok(href.startsWith('/') && allowed.has(href.slice(1)), `${p.slug}: ${href}`);
            }
        }
    });
    await check('новые страницы имеют все поля для CMS', () => {
        for (const s of NEW) {
            const p = pages.find((x) => x.slug === s);
            ['name', 'seo_title', 'seo_desc', 'breadcrumb_label', 'mobile_header_title'].forEach((f) => assert.ok(p[f], `${s}.${f}`));
            assert.strictEqual(p.section, 'legal');
        }
    });

    const existing = LEGAL_CMS_PAGE_SLUGS.filter((s) => !NEW.includes(s))
        .map((slug) => ({ slug, name: 'Старое имя', content: '<p>старый текст</p>', seo_title: `SEO ${slug}`, section: 'legal' }));
    const db = fakeDb(existing);

    await check('проверка без --apply ничего не пишет; план: 12 обновить, 4 создать', async () => {
        const { plan, backup } = await applyPages(db, pages, { apply: false });
        assert.strictEqual(db.writes.length, 0);
        assert.strictEqual(plan.filter((p) => p.action === 'update').length, 12);
        assert.strictEqual(plan.filter((p) => p.action === 'create').length, 4);
        assert.strictEqual(backup.length, 12);
        assert.ok(backup.every((b) => b.content === '<p>старый текст</p>'));
    });
    await check('--apply записывает тексты, SEO существующих страниц не трогает', async () => {
        await applyPages(db, pages, { apply: true });
        for (const p of pages) {
            const row = [...db.rows.values()].find((r) => r.slug === p.slug);
            assert.ok(row, p.slug);
            assert.strictEqual(row.content, p.content);
            assert.strictEqual(row.name, p.name);
        }
        assert.strictEqual([...db.rows.values()].find((r) => r.slug === 'terms').seo_title, 'SEO terms');
        assert.strictEqual([...db.rows.values()].find((r) => r.slug === 'booking-application').mobile_header_title, 'Форма заявки на бронирование');
    });
    await check('повторный запуск — всё совпадает, записей нет', async () => {
        const before = db.writes.length;
        const { plan } = await applyPages(db, pages, { apply: true });
        assert.ok(plan.every((p) => p.action === 'same'));
        assert.strictEqual(db.writes.length, before);
    });
    await check('файлы в content/legal совпадают с pages.json', () => {
        const files = fs.readdirSync(path.join(root, 'content/legal')).filter((f) => f.endsWith('.html')).sort();
        assert.deepStrictEqual(files, pages.map((p) => p.file).sort());
    });
    console.log(`check-legal-apply: ${passed} passed`);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
