'use strict';

/**
 * Разбор логов [AUTH] перед включением AUTH_MODE=enforce
 * (SECURITY_AUDIT_2026-09_RU.md, К2).
 *
 * В режиме log каждый запрос без валидного токена пишет строку вида:
 *   [AUTH] mode=log reason=missing GET /user/orders auth=- origin=https://totus.club ip=1.2.3.4 ua="..." count=5
 *
 * Скрипт сводит такие строки в картину «какие маршруты и кто именно ходит без
 * токена», чтобы включение enforce не сломало живых пользователей.
 *
 * Запуск на сервере:
 *   pm2 logs totus-api --lines 200000 --nostream | node scripts/analyze-auth-log.js
 *   node scripts/analyze-auth-log.js ~/.pm2/logs/totus-api-out.log ~/.pm2/logs/totus-api-error.log
 *
 * Полезные ключи:
 *   --top=15        сколько строк показывать в каждом разделе (по умолчанию 20)
 *   --json          машинный вывод вместо таблиц
 *   --min=5         не показывать маршруты реже N запросов
 *
 * Ничего никуда не отправляет и не меняет: только читает и печатает.
 */

const fs = require('fs');
const readline = require('readline');

const args = process.argv.slice(2);
const files = args.filter((a) => !a.startsWith('--'));
const asJson = args.includes('--json');
const topN = Number((args.find((a) => a.startsWith('--top=')) || '').split('=')[1]) || 20;
const minCount = Number((args.find((a) => a.startsWith('--min=')) || '').split('=')[1]) || 1;

// [AUTH] mode=… reason=… METHOD /path auth=… origin=… ip=… ua="…" count=…
const LINE = /\[AUTH\]\s+mode=(\S+)\s+reason=(\S+)\s+([A-Z]+)\s+(\S+)\s+auth=(\S+)\s+origin=(\S+)\s+ip=(\S+)\s+ua="([^"]*)"\s+count=(\d+)/;

const routes = new Map();   // "reason METHOD /path" -> { reason, method, path, count, origins, uas, ips, auths }
let totalLines = 0;
let matched = 0;

function bump(map, key) {
    if (!key) return;
    map.set(key, (map.get(key) || 0) + 1);
}

function topOf(map, n = 3) {
    return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

function shortUa(ua) {
    const value = String(ua || '-');
    if (/okhttp|CFNetwork|Darwin|totus/i.test(value)) return 'мобильное приложение';
    if (/Electron/i.test(value)) return 'десктоп';
    if (/Mozilla|Chrome|Safari|Firefox|YaBrowser/i.test(value)) return 'браузер';
    if (/curl|wget|python|go-http|axios|node-fetch/i.test(value)) return 'скрипт/бот';
    if (value === '-' || value === '') return 'без User-Agent';
    return value.slice(0, 40);
}

function addLine(line) {
    totalLines += 1;
    const m = line.match(LINE);
    if (!m) return;
    matched += 1;

    const [, , reason, method, path, auth, origin, ip, ua, count] = m;
    const key = `${reason} ${method} ${path}`;
    let row = routes.get(key);
    if (!row) {
        row = {
            reason,
            method,
            path,
            count: 0,
            origins: new Map(),
            uas: new Map(),
            ips: new Map(),
            auths: new Map(),
        };
        routes.set(key, row);
    }

    // count= в логе — накопительный счётчик по ключу, поэтому берём максимум,
    // а не сумму: иначе троттлинг логов раздувает цифры.
    row.count = Math.max(row.count, Number(count) || 1);
    bump(row.origins, origin);
    bump(row.uas, shortUa(ua));
    bump(row.ips, ip);
    bump(row.auths, auth);
}

function report() {
    const rows = [...routes.values()].filter((r) => r.count >= minCount);
    const byCount = [...rows].sort((a, b) => b.count - a.count);

    const missing = byCount.filter((r) => r.reason === 'missing');
    const invalid = byCount.filter((r) => r.reason === 'invalid');
    const forbidden = byCount.filter((r) => r.reason === 'forbidden');
    const ownerMismatch = byCount.filter((r) => r.reason === 'owner_mismatch');

    if (asJson) {
        console.log(JSON.stringify({
            total_lines: totalLines,
            auth_lines: matched,
            routes: rows.map((r) => ({
                reason: r.reason,
                method: r.method,
                path: r.path,
                count: r.count,
                origins: topOf(r.origins, 5),
                clients: topOf(r.uas, 5),
                unique_ips: r.ips.size,
            })),
        }, null, 2));
        return;
    }

    console.log('='.repeat(78));
    console.log('Разбор логов [AUTH]');
    console.log('='.repeat(78));
    console.log(`Всего строк прочитано: ${totalLines}`);
    console.log(`Из них строк [AUTH]:   ${matched}`);
    console.log(`Уникальных маршрутов:  ${rows.length}`);

    if (!matched) {
        console.log('\nСтрок [AUTH] не найдено. Возможные причины:');
        console.log('  — логи за другой период или другой файл;');
        console.log('  — AUTH_MODE уже enforce (тогда вместо логов отдаются 401/403);');
        console.log('  — сервис перезапускался и старые логи ротировались.');
        return;
    }

    section('БЕЗ ТОКЕНА ВООБЩЕ (reason=missing)', missing,
        'Это и сломается при enforce в первую очередь.');
    section('БИТЫЙ ИЛИ ПРОСРОЧЕННЫЙ ТОКЕН (reason=invalid)', invalid,
        'Обычно старые клиенты или истёкшие сессии — после enforce получат 401.');
    section('НЕ ТА РОЛЬ (reason=forbidden)', forbidden,
        'Пользователь лезет в staff-маршрут либо наоборот.');
    section('ЧУЖОЙ ВЛАДЕЛЕЦ (reason=owner_mismatch)', ownerMismatch,
        'Запрошен чужой user_id/order_id. Разбираться по каждому случаю.');

    // Путь обрезаем до первого «переменного» сегмента (числовой id или имя файла),
    // чтобы в списке был префикс маршрута, а не конкретный заказ.
    const routePrefix = (path) => {
        const parts = String(path).split('/');
        const out = [];
        for (const part of parts) {
            if (part === '') continue;
            if (/^\d+$/.test(part) || part.includes('.')) break;
            out.push(part);
        }
        return `/${out.join('/')}`;
    };

    const risky = [...new Set(missing.slice(0, topN).map((r) => routePrefix(r.path)))]
        .filter((p) => p !== '/');

    if (risky.length) {
        console.log('\n' + '-'.repeat(78));
        console.log('ЗАГОТОВКА ДЛЯ ПОСТЕПЕННОГО ВКЛЮЧЕНИЯ');
        console.log('-'.repeat(78));
        console.log('Эти маршруты можно оставить в режиме наблюдения, включив enforce для всего');
        console.log('остального. По мере починки клиентов вычёркивайте их из списка:\n');
        console.log(`AUTH_LOG_ONLY_PATHS=${risky.join(',')}`);
    }

    console.log('\n' + '-'.repeat(78));
    console.log('Проверьте глазами: если среди источников только «скрипт/бот» и незнакомые');
    console.log('origin — это чужой трафик, его можно смело закрывать. Если там браузер или');
    console.log('мобильное приложение — сначала чиним клиента, потом включаем enforce.');
}

function section(title, rows, hint) {
    console.log('\n' + '-'.repeat(78));
    console.log(title);
    console.log('-'.repeat(78));
    if (!rows.length) {
        console.log('  пусто — хорошо');
        return;
    }
    console.log(hint + '\n');

    for (const row of rows.slice(0, topN)) {
        console.log(`  ${String(row.count).padStart(7)}  ${row.method} ${row.path}`);
        const origins = topOf(row.origins, 3).map(([o, c]) => `${o} (${c})`).join(', ');
        const clients = topOf(row.uas, 3).map(([u, c]) => `${u} (${c})`).join(', ');
        console.log(`           откуда: ${origins || '-'}`);
        console.log(`           клиенты: ${clients || '-'}; уникальных IP: ${row.ips.size}`);
    }

    if (rows.length > topN) {
        console.log(`\n  …и ещё ${rows.length - topN} маршрутов (покажет --top=${rows.length})`);
    }
}

async function readStream(stream) {
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) addLine(line);
}

async function main() {
    if (files.length) {
        for (const file of files) {
            if (!fs.existsSync(file)) {
                console.error(`Файл не найден: ${file}`);
                process.exitCode = 1;
                return;
            }
            await readStream(fs.createReadStream(file, { encoding: 'utf8' }));
        }
    } else {
        if (process.stdin.isTTY) {
            console.error('Нечего читать. Передайте файл логов или перенаправьте вывод pm2:');
            console.error('  pm2 logs totus-api --lines 200000 --nostream | node scripts/analyze-auth-log.js');
            process.exitCode = 1;
            return;
        }
        await readStream(process.stdin);
    }
    report();
}

main().catch((err) => {
    console.error('Ошибка разбора:', err.message);
    process.exitCode = 1;
});
