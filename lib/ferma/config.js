'use strict';
// Настройки онлайн-кассы Ferma (OFD.ru). План — docs/claude/FERMA_INTEGRATION_RU.md,
// тестирование — docs/claude/FERMA_TESTING_RU.md, эндпоинты — docs/FERMA_API.md.
//
// FERMA_MODE:
//   off  (по умолчанию) — касса выключена, эндпоинты отвечают 503, фоновой сверки нет;
//   test — только тестовый стенд ferma-test.ofd.ru; почта покупателя всегда тестовая;
//   live — боевая касса ferma.ofd.ru. Тестовые чеки в live запрещены (FERMA_ALLOW_LIVE_RECEIPTS=1
//          включает их только для одной боевой проверки на 1 ₽ — см. FERMA_TESTING_RU.md, Т15).

const TEST_HOST = 'ferma-test.ofd.ru';
const LIVE_HOST = 'ferma.ofd.ru';

const TAXATION_SYSTEMS = ['Common', 'SimpleIn', 'SimpleInOut', 'Unified', 'UnifiedAgricultural', 'Patent'];
const AGENT_TYPES = ['AGENT', 'COMMISSIONER', 'CONFIDANT'];
const VATS = [
    'VatNo', 'Vat0', 'Vat5', 'Vat7', 'Vat10', 'Vat22',
    'CalculatedVat5105', 'CalculatedVat7107', 'CalculatedVat10110', 'CalculatedVat22122',
];

function env(name, def) {
    const v = process.env[name];
    return v === undefined || v === '' ? def : String(v).trim();
}

function hostOf(url) {
    try { return new URL(url).host.toLowerCase(); } catch { return ''; }
}

/** Читает настройки заново при каждом вызове (тесты меняют process.env на лету). */
function loadConfig() {
    const rawMode = env('FERMA_MODE', 'off').toLowerCase();
    const mode = ['off', 'test', 'live'].includes(rawMode) ? rawMode : 'off';
    const baseUrl = env('FERMA_BASE_URL', `https://${mode === 'live' ? LIVE_HOST : TEST_HOST}`).replace(/\/+$/, '');
    const callbackBase = env('FERMA_CALLBACK_BASE', '').replace(/\/+$/, '');
    const callbackSecret = env('FERMA_CALLBACK_SECRET', '');
    return {
        mode,
        rawMode,
        baseUrl,
        host: hostOf(baseUrl),
        login: env('FERMA_LOGIN', ''),
        password: env('FERMA_PASSWORD', ''),
        inn: env('FERMA_INN', ''),
        taxationSystem: env('FERMA_TAXATION_SYSTEM', 'Common'),
        agentType: env('FERMA_AGENT_TYPE', 'AGENT'),
        vat: env('FERMA_VAT', 'VatNo'),
        billAddress: env('FERMA_BILL_ADDRESS', 'https://totus.club'),
        paymentMethodFlag: env('FERMA_PAYMENT_METHOD_FLAG', ''),
        testEmail: env('FERMA_TEST_EMAIL', 'test@example.com'),
        invoicePrefix: env('FERMA_INVOICE_PREFIX', mode === 'live' ? 'tc' : 'tc-test'),
        callbackSecret,
        callbackUrl: callbackBase && callbackSecret ? `${callbackBase}/api/ferma/callback/${encodeURIComponent(callbackSecret)}` : '',
        timeoutMs: Math.max(Number(env('FERMA_TIMEOUT_MS', 20000)) || 20000, 1000),
        workerEnabled: env('FERMA_WORKER', '1') !== '0',
        workerIntervalMs: Math.max(Number(env('FERMA_WORKER_INTERVAL_MS', 60000)) || 60000, 10000),
        allowLiveReceipts: env('FERMA_ALLOW_LIVE_RECEIPTS', '0') === '1',
    };
}

/** Ошибки настроек, из-за которых к кассе обращаться нельзя. Пустой массив — всё в порядке. */
function configProblems(cfg = loadConfig()) {
    const p = [];
    if (cfg.mode === 'off') return ['mode_off'];
    if (cfg.rawMode !== cfg.mode) p.push('invalid_mode');
    if (!cfg.host) p.push('invalid_base_url');
    // Главная страховка тестового режима: в test запросы уходят только на тестовый стенд.
    if (cfg.mode === 'test' && cfg.host !== TEST_HOST) p.push('test_mode_requires_test_host');
    if (cfg.mode === 'live' && cfg.host !== LIVE_HOST) p.push('live_mode_requires_live_host');
    if (!cfg.login || !cfg.password) p.push('credentials_missing');
    if (!/^\d{10}(\d{2})?$/.test(cfg.inn)) p.push('inn_missing');
    if (!TAXATION_SYSTEMS.includes(cfg.taxationSystem)) p.push('invalid_taxation_system');
    if (!AGENT_TYPES.includes(cfg.agentType)) p.push('invalid_agent_type');
    if (!VATS.includes(cfg.vat)) p.push('invalid_vat');
    return p;
}

/** Можно ли создавать чеки из тестовых эндпоинтов. */
function canIssueTestReceipts(cfg = loadConfig()) {
    if (cfg.mode === 'test') return true;
    return cfg.mode === 'live' && cfg.allowLiveReceipts;
}

/** То, что безопасно показать в админке и логах (без пароля и секрета). */
function publicConfig(cfg = loadConfig()) {
    return {
        mode: cfg.mode,
        host: cfg.host,
        inn: cfg.inn,
        taxationSystem: cfg.taxationSystem,
        agentType: cfg.agentType,
        vat: cfg.vat,
        billAddress: cfg.billAddress,
        paymentMethodFlag: cfg.paymentMethodFlag || null,
        invoicePrefix: cfg.invoicePrefix,
        credentials: Boolean(cfg.login && cfg.password),
        callback: cfg.callbackUrl ? cfg.callbackUrl.replace(/\/callback\/[^/]+$/, '/callback/***') : null,
        testEmail: cfg.mode === 'test' ? cfg.testEmail : null,
        worker: { enabled: cfg.workerEnabled, intervalMs: cfg.workerIntervalMs },
        canIssueTestReceipts: canIssueTestReceipts(cfg),
        problems: configProblems(cfg),
    };
}

module.exports = {
    loadConfig, configProblems, canIssueTestReceipts, publicConfig,
    TEST_HOST, LIVE_HOST, TAXATION_SYSTEMS, AGENT_TYPES, VATS,
};
