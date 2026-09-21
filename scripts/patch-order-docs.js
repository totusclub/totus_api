'use strict';

/**
 * Применяет правки в три существующих файла для защиты документов заказа
 * (SECURITY_AUDIT_2026-09_RU.md, К1 и К4). Отдельный скрипт нужен потому, что
 * app.js и utils/orderEmails.js слишком велики, чтобы передавать их через
 * GitHub-коннектор целиком.
 *
 * Запуск из корня totus_API:
 *   node scripts/patch-order-docs.js          # применить
 *   node scripts/patch-order-docs.js --check  # только проверить, ничего не менять
 *
 * Скрипт идемпотентен: повторный запуск ничего не портит и сообщает «уже применено».
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const checkOnly = process.argv.includes('--check');

let changed = 0;
let already = 0;
let failed = 0;

function read(file) {
    return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

function write(file, content) {
    fs.writeFileSync(path.join(ROOT, file), content, 'utf8');
}

function step(file, doneMarker, apply) {
    let src;
    try {
        src = read(file);
    } catch (err) {
        console.error(`  ОШИБКА  ${file}: файл не найден (${err.code})`);
        failed += 1;
        return;
    }

    if (src.includes(doneMarker)) {
        console.log(`  уже применено  ${file}`);
        already += 1;
        return;
    }

    let next;
    try {
        next = apply(src);
    } catch (err) {
        console.error(`  ОШИБКА  ${file}: ${err.message}`);
        failed += 1;
        return;
    }

    if (checkOnly) {
        console.log(`  будет изменён  ${file}`);
        changed += 1;
        return;
    }

    write(file, next);
    console.log(`  изменён  ${file}`);
    changed += 1;
}

function replaceOnce(src, needle, replacement, what) {
    const count = src.split(needle).length - 1;
    if (count !== 1) {
        throw new Error(`${what}: ожидалось одно совпадение, найдено ${count}`);
    }
    return src.replace(needle, replacement);
}

console.log(checkOnly ? 'Проверка правок (ничего не меняется):' : 'Применение правок:');

// ---------------------------------------------------------------------------
// 1. app.js — подключить оба middleware ДО express.static('/uploads')
// ---------------------------------------------------------------------------
step('app.js', "require('./middleware/orderDocumentsAccess')", (src) => {
    const anchor = "app.use('/uploads', express.static(path.join(__dirname, 'uploads')));";
    const insert =
        "// Документы заказа (SECURITY_AUDIT_2026-09_RU.md, К1): ссылки в ответах клиенту\n" +
        "// подписываются, а сама отдача файлов идёт с проверкой доступа. Оба middleware\n" +
        "// обязаны стоять ДО express.static('/uploads').\n" +
        "app.use(require('./middleware/signOrderDocLinks')());\n" +
        "app.use('/uploads/orders', require('./middleware/orderDocumentsAccess')());\n" +
        anchor;
    return replaceOnce(src, anchor, insert, 'app.js: монтирование статики /uploads');
});

// ---------------------------------------------------------------------------
// 2. utils/levelTravelWebhooks.js — убрать fallback-литерал ключа LT,
//    сравнивать в константное время, не писать длины ключей в лог
// ---------------------------------------------------------------------------
step('utils/levelTravelWebhooks.js', 'function keysMatch(', (src) => {
    let out = src;

    out = replaceOnce(
        out,
        "require('dotenv').config();\nconst db = require('../db');",
        "require('dotenv').config();\nconst crypto = require('crypto');\nconst db = require('../db');",
        'levelTravelWebhooks: подключение crypto',
    );

    // Литерал ключа намеренно не хранится в этом файле — ищем объявление по шаблону.
    const keyDecl = /const PARTNER_API_KEY\s*=\s*\n?\s*process\.env\.PARTNER_API_KEY \|\| '[^']*';/;
    const keyMatches = out.match(new RegExp(keyDecl.source, 'g')) || [];
    if (keyMatches.length !== 1) {
        throw new Error(
            `levelTravelWebhooks: объявление PARTNER_API_KEY с fallback не найдено (совпадений ${keyMatches.length})`,
        );
    }
    out = out.replace(
        keyDecl,
        "// Ключ проверки входящих webhook'ов Level.Travel. Литерал-fallback убран\n" +
        "// (SECURITY_AUDIT_2026-09_RU.md, К4): он лежал в открытом виде в git-истории.\n" +
        "// Без PARTNER_API_KEY в .env callback'и отклоняются — это осознанный fail-closed.\n" +
        "const PARTNER_API_KEY = process.env.PARTNER_API_KEY || '';\n" +
        "\n" +
        "function keysMatch(given, expected) {\n" +
        "  if (!given || !expected) return false;\n" +
        "  const a = Buffer.from(given);\n" +
        "  const b = Buffer.from(expected);\n" +
        "  if (a.length !== b.length) return false;\n" +
        "  return crypto.timingSafeEqual(a, b);\n" +
        "}",
    );

    out = replaceOnce(
        out,
        '  if (!key || key !== expected) {',
        "  if (!expected) {\n" +
        "    logCallbackError(LOG_NOTIFY, 'AUTH', 'PARTNER_API_KEY не задан — callback отклонён', {\n" +
        "      path: req.path,\n" +
        "      order_id: req.body?.order_id,\n" +
        "      event: req.body?.event,\n" +
        "    });\n" +
        "    return res.status(503).json({ success: false, error: 'partner_key_not_configured' });\n" +
        "  }\n" +
        "\n" +
        "  if (!keysMatch(key, expected)) {",
        'levelTravelWebhooks: проверка ключа',
    );

    const lines = out.split('\n').filter(
        (line) => !line.includes('key_length:') && !line.includes('expected_length:'),
    );
    return lines.join('\n');
});

// ---------------------------------------------------------------------------
// 3. utils/orderEmails.js — ссылка на документ в письме тоже подписывается
// ---------------------------------------------------------------------------
step('utils/orderEmails.js', "require('../lib/orderDocLinks')", (src) => {
    let out = src;

    out = replaceOnce(
        out,
        "const { getOrderDocuments } = require('./orderDocuments');",
        "const { getOrderDocuments } = require('./orderDocuments');\n" +
        "const { signDocUrl } = require('../lib/orderDocLinks');",
        'orderEmails: подключение orderDocLinks',
    );

    const oldBuild =
        'function buildPublicDocumentUrl(publicUrl) {\n' +
        '    if (!publicUrl) return null;\n' +
        '    const value = String(publicUrl).trim();\n' +
        '    if (/^https?:\\/\\//i.test(value)) return value;\n' +
        '    return `${API_PUBLIC_URL}${value.startsWith(\'/\') ? value : `/${value}`}`;\n' +
        '}';
    const newBuild =
        'function buildPublicDocumentUrl(publicUrl) {\n' +
        '    if (!publicUrl) return null;\n' +
        '    const value = String(publicUrl).trim();\n' +
        '    if (/^https?:\\/\\//i.test(value)) return value;\n' +
        '    // Ссылка в письме тоже подписывается (К1). Сам файл идёт вложением,\n' +
        '    // поэтому письмо остаётся полезным и после истечения срока ссылки.\n' +
        '    const signed = signDocUrl(value.startsWith(\'/\') ? value : `/${value}`);\n' +
        '    return `${API_PUBLIC_URL}${signed}`;\n' +
        '}';

    return replaceOnce(out, oldBuild, newBuild, 'orderEmails: buildPublicDocumentUrl');
});

console.log(
    `\nИтог: изменено ${changed}, уже применено ${already}, ошибок ${failed}.`,
);

if (failed) {
    console.error(
        'Часть правок не применилась — файлы могли измениться с момента подготовки патча.\n' +
        'Ничего страшного: применённые шаги идемпотентны, оставшиеся нужно внести руками\n' +
        'по docs/ORDER_DOCS_RU.md.',
    );
    process.exit(1);
}

if (!checkOnly && changed) {
    console.log('Дальше: node scripts/check-order-docs.js && pm2 restart …');
}
