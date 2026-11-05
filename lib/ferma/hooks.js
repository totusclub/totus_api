'use strict';
// Чек Ferma по событию заказа.
//
// FERMA_RECEIPT_TRIGGER=payment — ОСНОВНОЙ режим (решение владельца 05.11.2026): чек прихода уходит в OFD
// ТОЛЬКО после того, как банк подтвердил оплату СБП (статус RECONCILED):
//   - utils/vtbCallback.js — callback ВТБ;
//   - app.js POST /check_pay — проверка оплаты тура Level.Travel;
//   - lib/customRooms/internalOrders.js checkPay — проверка оплаты номера Arlekino.
// До подтверждения оплаты (бронирование, ожидание, отказ банка) касса не вызывается.
// Повторные подтверждения того же заказа второй чек не создают: issue идемпотентен по номеру заказа.
// Работает в test (стенд, тестовая почта, тестовый поставщик) и live (боевая касса, почта покупателя).
// Поставщик в live: тур Level.Travel — юрлицо туроператора ЭТОГО заказа (lib/ferma/orderSupplier.js,
// таблица order_suppliers; общего поставщика и FERMA_SUPPLIERS для туров нет); номер Arlekino —
// FERMA_SUPPLIERS.arlekino. Нет реквизитов — чек не пробивается, причина в fiscal_blocked и в логе.
//
// FERMA_RECEIPT_TRIGGER=booking — ВРЕМЕННЫЙ режим проверки: чек при создании бронирования, ещё ДО оплаты.
// Только FERMA_MODE=test; в live не срабатывает никогда (по 54-ФЗ чек выдаётся при расчёте).
//
// Заказ и оплата никогда не ждут кассу и не падают из-за неё: вызов не блокирует ответ, ошибки только в лог.

const R = require('./receipt');
const { loadConfig, configProblems } = require('./config');
const { TEST_SUPPLIER } = require('./service');
const orderSupplier = require('./orderSupplier');

const TRIGGERS = ['off', 'booking', 'payment'];
const PAY_SOURCES = { lt: 'payment_lt', arlekino: 'payment_arlekino' };
const ARLEKINO_TEST_SUPPLIER = { ...TEST_SUPPLIER, name: 'ООО Тестовый продавец размещения' };
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
            supplier: source === 'arlekino' ? ARLEKINO_TEST_SUPPLIER : TEST_SUPPLIER,
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

// ---------------------------------------------------------------------------
// Чек после подтверждения оплаты (FERMA_RECEIPT_TRIGGER=payment)
// ---------------------------------------------------------------------------

/**
 * FERMA_SUPPLIERS — JSON. С 05.11.2026 используется ТОЛЬКО ключ "arlekino" (номера Arlekino — свой продукт,
 * один продавец размещения): { "arlekino": { "inn": "…", "name": "…", "phone": "…" } }.
 * Ключи "lt" / "lt:<id>" больше не читаются: поставщик тура — юрлицо туроператора конкретного заказа.
 * Неверный JSON — как пустой (боевые чеки Arlekino не пробиваются, причина в логе).
 */
function parseSuppliers(raw) {
    if (raw && typeof raw === 'object') return raw;
    const text = String(raw == null ? '' : raw).trim();
    if (!text) return {};
    try {
        const v = JSON.parse(text);
        return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch {
        return { _invalid: true };
    }
}

function validSupplier(s) {
    return Boolean(s && typeof s === 'object' && R.isValidInn(String(s.inn || '').trim())
        && R.sanitizeText(s.name) && R.normalizePhone(s.phone));
}

/** Id туроператора в заказе Level.Travel (бренд, не юрлицо). */
function ltOperatorId(orderData) {
    return orderSupplier.extractOperator(orderData).id;
}

/**
 * Поставщик чека.
 *   test — тестовый (стенд общий), как раньше;
 *   live, тур — только реквизиты этого заказа (ltSupplier из orderSupplier.resolveLtOrderSupplier);
 *   live, Arlekino — FERMA_SUPPLIERS.arlekino.
 * Нет / неверные — { missing, code, message }.
 */
function resolveSupplier({ mode, source, suppliers, ltSupplier }) {
    if (mode === 'test') return { supplier: source === 'arlekino' ? ARLEKINO_TEST_SUPPLIER : TEST_SUPPLIER, key: 'test' };
    if (source === 'arlekino') {
        const map = parseSuppliers(suppliers);
        if (validSupplier(map.arlekino)) {
            const s = map.arlekino;
            return { supplier: { inn: String(s.inn).trim(), name: R.sanitizeText(s.name), phone: String(s.phone) }, key: 'arlekino' };
        }
        const code = `no_supplier:arlekino${map._invalid ? ' (FERMA_SUPPLIERS — неверный JSON)' : ''}`;
        return { missing: 'arlekino', code, message: 'Нет реквизитов продавца размещения Arlekino (FERMA_SUPPLIERS.arlekino). Чек не пробит' };
    }
    if (ltSupplier && ltSupplier.supplier) return { supplier: ltSupplier.supplier, key: 'order' };
    return {
        missing: 'order',
        code: (ltSupplier && ltSupplier.error) || 'supplier_missing',
        message: (ltSupplier && ltSupplier.message) || 'Реквизиты туроператора заказа не определены. Чек не пробит',
    };
}

/** Контакт покупателя для чека (live): почта или телефон из заказа. */
function buyerContact({ source, orderData, booking }) {
    const o = orderData && typeof orderData === 'object' ? orderData : {};
    const c = (source === 'arlekino' && booking && booking.contact) || {};
    const email = [c.email, o._customer_email, o.client && o.client.email].map((x) => String(x || '').trim()).find(Boolean) || null;
    const phone = [c.phone, o._customer_phone, o.client && o.client.phone].map((x) => String(x || '').trim()).find(Boolean) || null;
    return { email, phone };
}

/**
 * Данные для service.issue после подтверждения оплаты.
 * amount — сумма, подтверждённая банком; если её нет — сумма к оплате из заказа.
 */
function paymentReceiptInput({ mode, source, orderId, amount, transactionId, orderData, booking, suppliers, ltSupplier }) {
    const scenario = PAY_SOURCES[source];
    if (!scenario) return { skip: 'unknown_source' };
    const orderRef = String(orderId == null ? '' : orderId).trim();
    if (!/^[A-Za-z0-9_.]{1,40}$/.test(orderRef)) return { skip: 'invalid_order_id' };
    const o = orderData && typeof orderData === 'object' ? orderData : {};
    const amountKop = amountToKop(amount)
        || amountToKop(source === 'arlekino' && booking ? booking.finalPrice : null)
        || amountToKop(o.payment && o.payment.amount)
        || amountToKop(o.full_price) || amountToKop(o.price) || amountToKop(o.total_price) || amountToKop(o.amount);
    if (!amountKop) return { skip: 'no_amount', message: `Заказ ${orderRef}: не удалось определить сумму оплаты. Чек не пробит` };
    const sup = resolveSupplier({ mode, source, suppliers, ltSupplier });
    if (!sup.supplier) return { skip: sup.code, message: sup.message };
    const input = {
        scenario,
        kind: 'income',
        orderRef,
        amountKop,
        label: bookingLabel({ source, orderId: orderRef, orderData, booking }),
        supplier: sup.supplier,
    };
    if (transactionId) input.paymentIdentifier = String(transactionId).slice(0, 64);
    if (mode === 'live') {
        const { email, phone } = buyerContact({ source, orderData, booking });
        if (!email && !phone) return { skip: 'no_buyer_contact', message: `Заказ ${orderRef}: нет почты и телефона покупателя. Чек не пробит` };
        if (email) input.email = email;
        if (phone) input.phone = phone;
    }
    return { input, supplierKey: sup.key };
}

/** Заказ из БД: { source, orderData, booking }. Номера Arlekino — по диапазону номеров и таблице бронирований. */
async function loadPaidOrder(orderId) {
    const db = require('../../db');
    const [rows] = await db.query('SELECT order_id, package FROM orders WHERE order_id = ? LIMIT 1', [String(orderId)]);
    const row = rows[0] || null;
    let orderData = null;
    if (row && row.package) {
        try { orderData = typeof row.package === 'string' ? JSON.parse(row.package) : row.package; } catch { orderData = null; }
    }
    const bookings = require('../customRooms/bookings');
    if (bookings.isInternalOrderId(orderId)) {
        const booking = await bookings.getByOrderId(orderId);
        if (booking) return { source: 'arlekino', orderData, booking };
    }
    return { source: 'lt', orderData, booking: null };
}

/**
 * Хук «банк подтвердил оплату». Возвращает промис, который никогда не отклоняется:
 * { skipped: причина } | { ok, receiptId, state, reused } | { error }.
 * ctx: { orderId, amount?, transactionId?, via: 'vtb_callback' | 'check_pay' }.
 * deps — для проверок: getFerma, getConfig, getTrigger, loadOrder, log, defer, getSuppliers,
 *        resolveOrderSupplier (orderId, orderData) → { supplier } | { error, message }, blocked ({ record, resolve }).
 */
function createPaymentHook(deps = {}) {
    const getFerma = deps.getFerma || (() => require('./index').getFerma());
    const getConfig = deps.getConfig || loadConfig;
    const log = deps.log || ((...a) => console.log(...a));
    const defer = deps.defer || ((fn) => setImmediate(fn));
    const getTrigger = deps.getTrigger || receiptTrigger;
    const loadOrder = deps.loadOrder || loadPaidOrder;
    const getSuppliers = deps.getSuppliers || (() => process.env.FERMA_SUPPLIERS);
    const resolveOrderSupplier = deps.resolveOrderSupplier
        || ((orderId, orderData) => orderSupplier.resolveLtOrderSupplier(orderId, orderData, { store: orderSupplier.getSupplierStore(), log }));
    const getBlocked = deps.blocked ? () => deps.blocked : () => orderSupplier.getBlockedStore();
    // Журнал «оплата есть — чека нет» для админки; его ошибки оплату и чек не трогают.
    const safeBlocked = async (method, args) => {
        try { await getBlocked()[method](args); } catch (err) { log(`[FERMA] fiscal_blocked ${method}: ${err.message}`); }
    };

    return function onPaymentConfirmed(ctx = {}) {
        let cfg;
        try {
            if (getTrigger() !== 'payment') return Promise.resolve({ skipped: 'trigger_off' });
            cfg = getConfig();
        } catch (err) {
            return Promise.resolve({ error: err.message });
        }
        const tag = `[FERMA] payment order=${ctx.orderId} via=${ctx.via || '—'}`;
        if (cfg.mode === 'off') return Promise.resolve({ skipped: 'mode_off' });
        const problems = configProblems(cfg);
        if (problems.length) {
            log(`${tag} пропущен: Ferma не настроена (${problems.join(', ')})`);
            return Promise.resolve({ skipped: 'not_configured' });
        }
        if (ctx.orderId === undefined || ctx.orderId === null || ctx.orderId === '') {
            return Promise.resolve({ skipped: 'no_order_id' });
        }
        return new Promise((resolve) => {
            defer(async () => {
                try {
                    const order = await loadOrder(ctx.orderId);
                    // Тур: поставщик — юрлицо туроператора ЭТОГО заказа (снимок при создании заказа).
                    // В test чек всё равно уходит с тестовым поставщиком; проверка — чтобы увидеть проблему до боя.
                    let ltSupplier = null;
                    if (order.source === 'lt') {
                        ltSupplier = await resolveOrderSupplier(ctx.orderId, order.orderData);
                        if (cfg.mode === 'test' && ltSupplier && ltSupplier.error) {
                            log(`${tag} source=lt в боевом режиме чек не пробился бы: ${ltSupplier.error} — ${ltSupplier.message}`);
                        }
                    }
                    const prepared = paymentReceiptInput({
                        mode: cfg.mode, source: order.source, orderId: ctx.orderId, amount: ctx.amount,
                        transactionId: ctx.transactionId, orderData: order.orderData, booking: order.booking,
                        suppliers: getSuppliers(), ltSupplier,
                    });
                    if (prepared.skip) {
                        log(`${tag} source=${order.source} чек НЕ пробит: ${prepared.skip}${prepared.message ? ` — ${prepared.message}` : ''}`);
                        await safeBlocked('record', {
                            orderId: String(ctx.orderId), mode: cfg.mode, source: order.source, reason: prepared.skip,
                            message: prepared.message || prepared.skip, via: ctx.via || null, amountKop: amountToKop(ctx.amount),
                        });
                        return resolve({ skipped: prepared.skip });
                    }
                    const r = await getFerma().service.issue(prepared.input, { waitMs: WAIT_MS });
                    if (!r.ok) {
                        log(`${tag} source=${order.source} чек не собран: ${(r.errors || []).join(', ')}`);
                        return resolve({ ok: false, errors: r.errors });
                    }
                    const row = r.row || {};
                    if (!r.reused) {
                        const sk = prepared.supplierKey === 'order' ? ` supplier=${prepared.input.supplier.inn}` : '';
                        log(`${tag} source=${order.source} receipt=#${row.id} invoice=${row.invoice_id} state=${row.state}${sk}${row.ofd_receipt_url ? ` url=${row.ofd_receipt_url}` : ''}`);
                    }
                    await safeBlocked('resolve', { orderId: String(ctx.orderId), mode: cfg.mode, receiptId: row.id });
                    resolve({ ok: true, reused: r.reused, receiptId: row.id, state: row.state });
                } catch (err) {
                    log(`${tag} ошибка кассы: ${err.message}`);
                    resolve({ error: err.message });
                }
            });
        });
    };
}

const onPaymentConfirmed = createPaymentHook();

/** Безопасный вызов из обработчиков оплаты: только после подтверждения банком; не ждёт, не бросает. */
function firePaymentReceipt(ctx) {
    try {
        onPaymentConfirmed(ctx).catch(() => {});
    } catch (err) {
        console.error('[FERMA] payment hook failed:', err.message);
    }
}

module.exports = {
    createBookingHook, onBookingCreated, fireBookingReceipt, bookingReceiptInput, bookingLabel, amountToKop,
    receiptTrigger, TRIGGERS, SOURCES,
    createPaymentHook, onPaymentConfirmed, firePaymentReceipt, paymentReceiptInput, resolveSupplier, parseSuppliers,
    ltOperatorId, buyerContact, loadPaidOrder, PAY_SOURCES,
};
