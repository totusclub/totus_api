'use strict';
// Точка входа модуля кассы Ferma: общий клиент, хранилище MySQL, сервис и фоновая сверка.
// Отправка чеков при успешной оплате (VTB) пока НЕ подключена — подключим отдельным PR,
// когда будут готовы оплата и данные поставщиков (FERMA_INTEGRATION_RU.md §5.3).
const { createClient } = require('./client');
const { createMysqlStore } = require('./store');
const { createService } = require('./service');
const { loadConfig, configProblems, publicConfig } = require('./config');

let instance = null;
function getFerma() {
    if (!instance) {
        const db = require('../../db');
        const client = createClient();
        const store = createMysqlStore(db);
        instance = { client, store, service: createService({ client, store }) };
    }
    return instance;
}

let timer = null;
/** Фоновая сверка раз в FERMA_WORKER_INTERVAL_MS (по умолчанию 60 с). Ничего не делает при FERMA_MODE=off. */
function startFermaWorker() {
    const cfg = loadConfig();
    if (cfg.mode === 'off') {
        console.log('[FERMA] mode=off — касса выключена');
        return null;
    }
    const problems = configProblems(cfg);
    console.log(`[FERMA] mode=${cfg.mode} host=${cfg.host} inn=${cfg.inn || '—'} worker=${cfg.workerEnabled ? `${cfg.workerIntervalMs / 1000}s` : 'off'}${problems.length ? ` problems=${problems.join(',')}` : ''}`);
    if (!cfg.workerEnabled || problems.length || timer) return timer;
    timer = setInterval(() => {
        getFerma().service.reconcile().then((s) => {
            if (s && s.checked) console.log(`[FERMA] reconcile ${JSON.stringify(s)}`);
        }).catch((err) => console.error('[FERMA] reconcile failed:', err.message));
    }, cfg.workerIntervalMs);
    if (timer.unref) timer.unref();
    return timer;
}

module.exports = { getFerma, startFermaWorker, publicConfig };
