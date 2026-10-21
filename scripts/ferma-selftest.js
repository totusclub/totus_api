// Самопроверка кассы Ferma на тестовом стенде — те же 15 шагов, что POST /api/admin/fiscal/selftest.
//   FERMA_MODE=test FERMA_LOGIN=… FERMA_PASSWORD=… FERMA_INN=3245001416 npm run ferma:selftest
//   npm run ferma:selftest -- --db     — писать чеки в таблицу fiscal_receipts (по умолчанию — только в память)
// Работает только в FERMA_MODE=test: на боевую кассу самопроверка не ходит.
try { require('dotenv').config(); require('dotenv').config({ path: '.env.local', override: true }); } catch { /* без dotenv — из окружения */ }

const { createClient } = require('../lib/ferma/client');
const { createMemoryStore, createMysqlStore } = require('../lib/ferma/store');
const { createService } = require('../lib/ferma/service');
const { publicConfig } = require('../lib/ferma/config');

(async () => {
    const useDb = process.argv.includes('--db');
    const cfg = publicConfig();
    console.log(`Ferma selftest: mode=${cfg.mode} host=${cfg.host} inn=${cfg.inn || '—'} store=${useDb ? 'mysql' : 'memory'}`);
    if (cfg.problems.length) {
        console.error(`Настройки: ${cfg.problems.join(', ')} — см. .env.example (раздел Ferma)`);
        process.exit(2);
    }
    const quiet = process.argv.includes('--verbose') ? console.log : () => {};
    const client = createClient({ log: quiet });
    const store = useDb ? createMysqlStore(require('../db')) : createMemoryStore();
    const service = createService({ client, store, log: quiet });
    let report;
    try {
        report = await service.selftest();
    } catch (err) {
        console.error(`Ошибка: ${err.code || ''} ${err.message}`);
        process.exit(2);
    }
    for (const s of report.steps) {
        const d = s.ok ? s.detail : s.error;
        const info = d && (d.ofdReceiptUrl || d.description || d.message || d.fermaCode || '');
        console.log(`${s.ok ? 'ok  ' : 'FAIL'} ${s.step} (${s.ms} мс)${info ? ` — ${info}` : ''}`);
        if (!s.ok) console.log(`     ${JSON.stringify(s.error)}`);
    }
    console.log(`\n${report.ok ? 'ВСЁ РАБОТАЕТ' : 'ЕСТЬ ПРОБЛЕМЫ'}: ${report.steps.filter((s) => s.ok).length}/${report.steps.length}, ${report.ms} мс, метка ${report.ref}`);
    process.exit(report.ok ? 0 : 1);
})();
