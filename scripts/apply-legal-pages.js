/**
 * Загрузка юридических документов ООО «ТОТУСКЛАБ» в CMS (таблица pages) из content/legal.
 *
 *   node scripts/apply-legal-pages.js            — только показать, что изменится (ничего не пишет)
 *   node scripts/apply-legal-pages.js --apply    — записать (npm run legal:apply)
 *
 * Существующая страница: обновляются только name и content, SEO и хлебные крошки
 * из админки сохраняются. Новая страница создаётся с полями из pages.json.
 * Перед записью прежние тексты сохраняются в backups/legal-pages-<время>.json.
 * Повторный запуск безопасен: совпадающие тексты пропускаются.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const CONTENT_DIR = path.join(ROOT, 'content', 'legal');
const { isAllowedCmsPageSlug, LEGAL_CMS_PAGE_SLUGS } = require('../config/cmsPages');

const NEW_PAGE_FIELDS = ['name', 'slug', 'seo_title', 'seo_desc', 'seo_keywords', 'section', 'breadcrumb_label', 'mobile_header_title', 'content'];

function sha(text) {
    return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex').slice(0, 12);
}

/** Читает pages.json и тексты; проверяет, что всё на месте и без заглушек. */
function loadPages(dir = CONTENT_DIR) {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'pages.json'), 'utf8'));
    const pages = manifest.pages.map((p) => {
        if (!isAllowedCmsPageSlug(p.slug)) throw new Error(`slug не разрешён в config/cmsPages.js: ${p.slug}`);
        const content = fs.readFileSync(path.join(dir, p.file), 'utf8');
        if (!content.trim()) throw new Error(`пустой текст: ${p.file}`);
        const bad = ['[[', '⟦', 'legal-ph', '____', '.docx', 'Эдуард', 'ПДн'].find((s) => content.includes(s));
        if (bad) throw new Error(`в ${p.file} осталось «${bad}»`);
        return { ...p, content };
    });
    const slugs = pages.map((p) => p.slug);
    const missing = LEGAL_CMS_PAGE_SLUGS.filter((s) => !slugs.includes(s));
    if (missing.length) throw new Error(`нет текстов для: ${missing.join(', ')}`);
    return { edition: manifest.edition, pages };
}

/** Сравнивает с базой и (при apply) записывает. Возвращает план и бэкап. */
async function applyPages(db, pages, { apply = false } = {}) {
    const plan = [];
    const backup = [];
    for (const page of pages) {
        const [rows] = await db.query('SELECT * FROM pages WHERE slug = ? LIMIT 1', [page.slug]);
        const row = rows[0];
        if (!row) {
            plan.push({ slug: page.slug, action: 'create', sha: sha(page.content) });
            if (apply) {
                const values = NEW_PAGE_FIELDS.map((f) => (f === 'section' ? page.section || 'legal' : page[f] ?? ''));
                await db.query(
                    `INSERT INTO pages (${NEW_PAGE_FIELDS.join(', ')}) VALUES (${NEW_PAGE_FIELDS.map(() => '?').join(', ')})`,
                    values,
                );
            }
            continue;
        }
        if (row.content === page.content && row.name === page.name) {
            plan.push({ slug: page.slug, action: 'same', sha: sha(page.content) });
            continue;
        }
        backup.push({ id: row.id, slug: row.slug, name: row.name, content: row.content, updated_at: row.updated_at });
        plan.push({ slug: page.slug, action: 'update', from: sha(row.content), sha: sha(page.content) });
        if (apply) {
            await db.query('UPDATE pages SET name = ?, content = ? WHERE id = ?', [page.name, page.content, row.id]);
        }
    }
    return { plan, backup };
}

async function main() {
    require('dotenv').config({ path: path.join(ROOT, '.env') });
    require('dotenv').config({ path: path.join(ROOT, '.env.local'), override: true });
    const apply = process.argv.includes('--apply');
    const { edition, pages } = loadPages();
    const db = require('../db');
    // сначала план без записи — бэкап собирается до любых изменений
    const { plan, backup } = await applyPages(db, pages, { apply: false });
    console.log(`[LEGAL] Редакция ${edition}: ${pages.length} документов`);
    plan.forEach((p) => console.log(`[LEGAL] ${p.action.padEnd(6)} ${p.slug}${p.from ? ` ${p.from} → ${p.sha}` : ` ${p.sha}`}`));
    const changes = plan.filter((p) => p.action !== 'same').length;
    if (!apply) {
        console.log(`[LEGAL] Изменений: ${changes}. Это проверка — чтобы записать, запустите: npm run legal:apply`);
        process.exit(0);
    }
    if (backup.length) {
        const dir = path.join(ROOT, 'backups');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `legal-pages-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
        fs.writeFileSync(file, JSON.stringify(backup, null, 1));
        console.log(`[LEGAL] Прежние тексты сохранены: ${path.relative(ROOT, file)}`);
    }
    await applyPages(db, pages, { apply: true });
    const { plan: after } = await applyPages(db, pages, { apply: false });
    const left = after.filter((p) => p.action !== 'same');
    if (left.length) {
        console.error('[LEGAL] После записи не совпадают:', left.map((p) => p.slug).join(', '));
        process.exit(1);
    }
    console.log(`[LEGAL] Готово: записано ${changes}, все ${pages.length} совпадают с content/legal`);
    process.exit(0);
}

module.exports = { loadPages, applyPages, sha };

if (require.main === module) {
    main().catch((err) => {
        console.error('[LEGAL] Ошибка:', err.message);
        process.exit(1);
    });
}
