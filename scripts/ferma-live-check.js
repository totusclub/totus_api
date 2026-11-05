// Проверка боевой кассы Ferma ПЕРЕД переключением FERMA_MODE=test → live. Чеков НЕ создаёт.
//   node scripts/ferma-live-check.js
//
// Берёт логин, пароль и ИНН из .env сервера (те же переменные, что у API) и только в этом процессе
// включает режим live — работающий API (pm2) не трогает и .env не меняет.
// Запросы к ferma.ofd.ru — только чтение:
//   1) токен (проверка боевого логина и пароля);
//   2) кассы: «Готова к работе», ФФД 1.2, признак агента, «только интернет», ИНН 9729424935, место расчётов totus.club,
//      тариф и фискальный накопитель;
//   3) очередь чеков.
// Пароль, токен и секрет callback не печатаются. Порядок переключения — docs/FERMA_API.md, раздел 8.
try { require('dotenv').config(); require('dotenv').config({ path: '.env.local', override: true }); } catch { /* без dotenv — из окружения */ }

const TOTUS_INN = '9729424935';

const modeInEnv = String(process.env.FERMA_MODE || 'off').trim().toLowerCase();
const baseUrlInEnv = String(process.env.FERMA_BASE_URL || '').trim();
// Только для этого процесса: проверяем боевую кассу, даже если в .env пока test.
process.env.FERMA_MODE = 'live';
if (baseUrlInEnv && !/^https:\/\/ferma\.ofd\.ru\/?$/i.test(baseUrlInEnv)) delete process.env.FERMA_BASE_URL;

const { createClient } = require('../lib/ferma/client');
const { createMemoryStore } = require('../lib/ferma/store');
const { createService } = require('../lib/ferma/service');
const { publicConfig } = require('../lib/ferma/config');

const notes = [];
let failed = false;
const ok = (msg) => console.log(`ok   ${msg}`);
const fail = (msg) => { failed = true; console.log(`FAIL ${msg}`); };
const warn = (msg) => { notes.push(msg); console.log(`warn ${msg}`); };
const yes = (v) => (v === true ? 'да' : v === false ? 'НЕТ' : '—');

(async () => {
    console.log('Ferma: проверка боевой кассы (чеки не создаются)');
    console.log(`Сейчас в .env: FERMA_MODE=${modeInEnv}${baseUrlInEnv ? `, FERMA_BASE_URL=${baseUrlInEnv}` : ''}\n`);

    // 1. Настройки
    const cfg = publicConfig();
    console.log(`1. Настройки: host=${cfg.host} inn=${cfg.inn || '—'} налогообложение=${cfg.taxationSystem} агент=${cfg.agentType} НДС=${cfg.vat} место расчётов=${cfg.billAddress}`);
    if (cfg.problems.length) {
        fail(`настройки: ${cfg.problems.join(', ')} — см. .env.example (раздел Ferma)`);
        console.log('\nДальше не проверяю: исправьте .env и запустите снова.');
        process.exit(2);
    }
    ok('логин и пароль заданы, параметры в допустимых значениях');
    if (cfg.inn !== TOTUS_INN) fail(`FERMA_INN=${cfg.inn}, а у ООО «ТОТУСКЛАБ» ${TOTUS_INN} (3245001416 — ИНН тестового стенда)`);
    else ok(`FERMA_INN=${TOTUS_INN} (ООО «ТОТУСКЛАБ»)`);
    if (baseUrlInEnv && !/^https:\/\/ferma\.ofd\.ru\/?$/i.test(baseUrlInEnv)) {
        warn(`FERMA_BASE_URL=${baseUrlInEnv} — для live удалите строку из .env или поставьте https://ferma.ofd.ru (иначе API в live не запустит кассу)`);
    }
    if (String(process.env.FERMA_ALLOW_LIVE_RECEIPTS || '0') === '1') {
        warn('FERMA_ALLOW_LIVE_RECEIPTS=1 — разрешены тестовые чеки на боевой кассе; оставьте 0, пока не нужна проверка на 1 ₽');
    }
    if (!cfg.callback) warn('FERMA_CALLBACK_BASE / FERMA_CALLBACK_SECRET не заданы — callback не придёт, статус будет узнавать фоновая сверка (так тоже работает)');

    const client = createClient({ log: process.argv.includes('--verbose') ? console.log : () => {} });
    const service = createService({ client, store: createMemoryStore(), log: () => {} });

    // 2. Токен
    try {
        const t = await client.getToken({ force: true });
        ok(`2. Токен получен — боевой логин и пароль подходят (действует до ${t.expirationUtc || '—'} UTC)`);
    } catch (err) {
        fail(`2. Токен: ${err.code != null ? `код ${err.code}, ` : ''}HTTP ${err.httpStatus ?? '—'} — ${err.message}`);
        if (err.code === 2 || err.httpStatus === 500) console.log('     Код 2 / HTTP 500 — неверный логин или пароль: сверьте с ЛКК OFD.ru → Ferma.');
        console.log('\nДальше не проверяю: без токена касса недоступна.');
        process.exit(1);
    }

    // 3. Кассы
    let report;
    try {
        report = await service.cashboxReport();
    } catch (err) {
        fail(`3. Кассы: ${err.code != null ? `код ${err.code}, ` : ''}${err.message}`);
        process.exit(1);
    }
    console.log(`\n3. Кассы ТОТУСКЛАБ: всего ${report.cashboxes.length}, готовы ${report.readyCount}, подходят для наших чеков ${report.usableCount}`);
    for (const k of report.cashboxes) {
        const c = k.checks;
        console.log(`   РНМ ${k.rnm || '—'} · ${k.state || '—'} · ${k.model || ''}`);
        console.log(`     ФФД 1.2: ${yes(c.ffd12)} · агент: ${yes(c.agent)} · только интернет: ${yes(c.internet)} · ИНН ${k.inn || '—'} (совпадает: ${yes(c.innMatches)})`);
        console.log(`     место расчётов: ${k.paymentPlace || '—'} (totus.club: ${yes(c.paymentPlaceTotus)})`);
        console.log(`     тариф: ${k.tariffType || '—'} до ${k.tariffEndDate || '—'}${k.tariffChecksLeft != null ? `, чеков осталось ${k.tariffChecksLeft}` : ''} · ФН заполнен ${k.fnVolumePercent ?? '—'} %, замена ${k.projectedFnReplaceDate || '—'}`);
        console.log(`     маски: налогообложение ${k.taxModeMask ?? '—'}, агент ${k.agentModeMask ?? '—'}`);
        for (const w of k.warnings) warn(`касса ${k.rnm}: ${{ tariff_ending: 'тариф заканчивается (меньше 14 дней)', fn_almost_full: 'ФН заполнен на 80 % и больше', fn_replace_soon: 'ФН менять в ближайшие 30 дней' }[w] || w}`);
    }
    if (report.ok) ok('есть готовая касса: ФФД 1.2, агент, интернет, ИНН и место расчётов совпадают');
    else {
        const text = {
            no_ready_cashbox: 'ни одна касса не «Готова к работе» (регистрация в ФНС не завершена, ФН, тариф?)',
            no_cashbox_for_agent_internet_ffd12: 'нет кассы с ФФД 1.2 + признаком агента + «только интернет» — агентский чек не пробьётся (ошибка 1029); исправляется только перерегистрацией',
            cashbox_inn_mismatch: `ИНН кассы не совпадает с FERMA_INN=${cfg.inn}`,
            payment_place_not_totus: 'место расчётов кассы — не totus.club',
        };
        const notReady = report.problems.includes('no_ready_cashbox');
        // Касса не готова — сначала это; про признаки регистрации говорить, только когда готовая касса есть.
        for (const p of report.problems) if (!(notReady && p === 'no_cashbox_for_agent_internet_ffd12')) fail(text[p] || p);
    }
    console.log(`   Система налогообложения в .env: ${cfg.taxationSystem}. Есть ли она в маске кассы — сверьте с карточкой регистрации в ЛКК (маску Ferma не расшифровывает).`);

    // 4. Очередь
    try {
        const q = await client.queueLength();
        const len = q && q.Data ? (q.Data.Length ?? q.Data.length ?? '—') : '—';
        ok(`4. Очередь чеков: ${len}`);
    } catch (err) {
        warn(`4. Очередь: ${err.message}`);
    }

    console.log('');
    if (failed) {
        console.log('НЕЛЬЗЯ ПЕРЕКЛЮЧАТЬ на live: исправьте пункты FAIL и запустите проверку снова.');
        process.exit(1);
    }
    console.log(`МОЖНО ПЕРЕКЛЮЧАТЬ: боевая касса отвечает и готова${notes.length ? ` (предупреждений: ${notes.length})` : ''}.`);
    console.log('Дальше: в .env FERMA_MODE=live → pm2 restart api → pm2 logs api --lines 50 --nostream | grep FERMA');
    process.exit(0);
})();
