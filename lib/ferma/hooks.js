'use strict';
// Чек Ferma по событию заказа. ВРЕМЕННЫЙ этап для проверки на тестовом стенде:
// FERMA_RECEIPT_TRIGGER=booking — чек прихода пробивается сразу при создании бронирования
// (POST /create-package: тур Level.Travel и номер Arlekino), ещё ДО оплаты.
// Работает ТОЛЬКО при FERMA_MODE=test: на стенд, с тестовой почтой и тестовым поставщиком.
// В боевом режиме чек при бронировании не пробивается никогда — по 54-ФЗ чек выдаётся при расчёте.
// Следующий шаг — FERMA_RECEIPT_TRIGGER=payment: чек после подтверждения оплаты ВТБ (отдельный PR).
//
// Бронирование никогда не ждёт кассу и не падает из-за неё: вызов не блокирует ответ, ошибки только в лог.

const R = require('./receipt');
const { loadConfig, configProblems } = require('./config');
const { TEST_SUPPLIER } = require('./service');

const TRIGGERS = ['off', 'booking'];
const SOURCES = { lt: 'booking_lt', arlekino: 'booking_arlekino' };
const WAIT_MS = 20000;

function receiptTrigger() {
    return loadConfig().receiptTrigger;
}

/** Сумма заказа (число / строка в рублях) → копейки; null — не сумма. */
function amountToKop(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'object') return amountToKop(value.value != null ? value.value : value.amount);
    const n = Number(String(value).replace(/\s/g, '').replace(',', '.'));
    if (!Number.isFinite(n) || n <= 0) return null;
    return R.toKop(n.toFixed(2));
}

function nightsRu(n) {
    const v = Number(n);
    if (!Number.isInteger(v) || v <= 0) return '';
    const m10 = v % 10;
    const m100 = v % 100;
    if (m10 === 1 && m100 !== 11) return `${v} ночь`;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return `${v} ночи`;
    return `${v} ночей`;
}

function ddmm(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
    return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
}

/**
 * Название позиции без персональных данных: что куплено и номер заказа.
 * LT: «Тур: <отель>, <город / страна>, <дата вылета>, <ночи>, заказ N».
 * Arlekino: «Проживание: <отель>, <номер>, <заезд>-<выезд>, заказ N».
 */
function bookingLabel({ source, orderId, orderData, booking }) {
    const pkg = (orderData && orderData.package && typeof orderData.package === 'object') ? orderData.package : {};
    const hotel = pkg.hotel || (orderData && orderData.hotel) || {};
    if (source === 'arlekino') {
        const b = booking || {};
        const parts = [b.hotelName || hotel.name, b.roomName, [ddmm(b.checkIn), ddmm(b.checkOut)].filter(Boolean).join('-')]
            .map((x) => R.sanitizeText(x)).filter(Boolean);
        return `Проживание: ${parts.length ? `${parts.join(', ')}, ` : ''}заказ ${orderId}`;
    }
    const place = hotel.city && typeof hotel.city === 'object' ? hotel.city.name_ru || hotel.city.name : hotel.city;
    const country = hotel.country && typeof hotel.country === 'object' ? hotel.country.name_ru || hotel.country.name : hotel.country;
    const dates = pkg.dates_info || (orderData && orderData.dates_info) || {};
    const start = ddmm(dates.start_date || dates.date || pkg.start_date || pkg.date);
    const nights = nightsRu(dates.nights_count || dates.nights || pkg.nights_count || pkg.nights);
    const parts = [hotel.name || (orderData && orderData.hotel_name), place || country, start, nights]
        .map((x) => R.sanitizeText(x)).filter(Boolean);
    return `Тур: ${parts.length ? `${parts.join(', ')}, ` : ''}заказ ${orderId}`;
}

/**
 * Данные для service.issue по созданному заказу. Контакты покупателя сюда не попадают:
 * в тестовом режиме чек всегда уходит на FERMA_TEST_EMAIL.
 * Поставщик — тестовый: настоящие ИНН / наименование / телефон туроператора — вопрос Ф3.
 */
function bookingReceiptInput({ source, orderId, amount, orderData, booking }) {
    const scenario = SOURCES[source];
    if (!scenario) return { skip: 'unknown_source' };
    const orderRef = String(orderId == null ? '' : orderId).trim();
    if (!/^[A-Za-z0-9_.]{1,40}$/.test(orderRef)) return { skip: 'invalid_order_id' };
    const amountKop = amountToKop(amount);
    if (!amountKop) return { skip: 'no_amount' };
    return {
        input: {
            scenario,
            kind: 'income',
            orderRef,
            amountKop,
            label: bookingLabel({ source, orderId: orderRef, orderData, booking }),
            supplier: source === 'arlekino' ? { ...TEST_SUPPLIER, name: 'ООО Тестовый продавец размещения' } : TEST_SUPPLIER,
        },
    };
}

/**
 * Хук «бронирование создано». Возвращает промис, который никогда не отклоняется:
 * { skipped: причина } | { ok, receiptId, state } | { error }.
 * deps — для проверок: getFerma, getConfig, log, defer.
 */
function createBookingHook(deps = {}) {
    const getFerma = deps.getFerma || (() => require('./index').getFerma());
    const getConfig = deps.getConfig || loadConfig;
    const log = deps.log || ((...a) => console.log(...a));
    const defer = deps.defer || ((fn) => setImmediate(fn));
    const getTrigger = deps.getTrigger || receiptTrigger;

    return function onBookingCreated(ctx = {}) {
        let cfg;
        let trigger;
        try {
            trigger = getTrigger();
            if (trigger !== 'booking') return Promise.resolve({ skipped: 'trigger_off' });
            cfg = getConfig();
        } catch (err) {
            return Promise.resolve({ error: err.message });
        }
        const tag = `[FERMA] booking order=${ctx.orderId} source=${ctx.source}`;
        if (cfg.mode !== 'test') {
            log(`${tag} пропущен: чек при бронировании — только в FERMA_MODE=test (сейчас ${cfg.mode})`);
            return Promise.resolve({ skipped: 'not_test_mode' });
        }
        const problems = configProblems(cfg);
        if (problems.length) {
            log(`${tag} пропущен: Ferma не настроена (${problems.join(', ')})`);
            return Promise.resolve({ skipped: 'not_configured' });
        }
        let prepared;
        try {
            prepared = bookingReceiptInput(ctx);
        } catch (err) {
            prepared = { skip: `build_failed: ${err.message}` };
        }
        if (prepared.skip) {
            log(`${tag} пропущен: ${prepared.skip}`);
            return Promise.resolve({ skipped: prepared.skip });
        }
        return new Promise((resolve) => {
            defer(async () => {
                try {
                    const r = await getFerma().service.issue(prepared.input, { waitMs: WAIT_MS });
                    if (!r.ok) {
                        log(`${tag} чек не собран: ${(r.errors || []).join(', ')}`);
                        return resolve({ ok: false, errors: r.errors });
                    }
                    const row = r.row || {};
                    log(`${tag} receipt=#${row.id} invoice=${row.invoice_id} state=${row.state}${r.reused ? ' (уже был)' : ''}${row.ofd_receipt_url ? ` url=${row.ofd_receipt_url}` : ''}`);
                    resolve({ ok: true, reused: r.reused, receiptId: row.id, state: row.state });
                } catch (err) {
                    log(`${tag} ошибка кассы: ${err.message}`);
                    resolve({ error: err.message });
                }
            });
        });
    };
}

const onBookingCreated = createBookingHook();

/** Безопасный вызов из обработчиков бронирования: не ждёт, не бросает. */
function fireBookingReceipt(ctx) {
    try {
        onBookingCreated(ctx).catch(() => {});
    } catch (err) {
        console.error('[FERMA] booking hook failed:', err.message);
    }
}

module.exports = {
    createBookingHook, onBookingCreated, fireBookingReceipt, bookingReceiptInput, bookingLabel, amountToKop,
    receiptTrigger, TRIGGERS, SOURCES,
};
