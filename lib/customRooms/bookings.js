'use strict';

/**
 * Бронирования наших Room Type БЕЗ Level.Travel (оператор Arlekino) — модель и сервис.
 * Бриф: /home/claude/rooms/BRIEF_BOOKINGS_CODE.md §1–§4, docs/CUSTOM_ROOMS_API.md §6.
 *
 * Жизненный цикл: create (pending_payment) → onPaid (pending_confirmation) → confirm | reject
 *   → confirmed → cancel; reject/cancel → refund_pending → refundDone (refunded | partially_refunded).
 * order_id = 900000000 + id — числовой, не пересекается с номерами заказов LT. Строка в `orders`
 * создаётся здесь же (package JSON в формате LT-заказа, lt_auth_token = NULL), поэтому существующие
 * GET /orders, /user/orders, /orders/:id/payment, /orders/documents работают без изменений.
 * Письма и push — bookingEmails.js (fire-and-forget, ошибки только в лог).
 */

const fs = require('fs');
const path = require('path');
const db = require('../../db');
const store = require('./store');

const ORDER_ID_BASE = 900000000;
const API_PUBLIC_URL = (process.env.API_PUBLIC_URL || 'https://api.totus.club').replace(/\/$/, '');
const DEFAULT_OPERATOR = 'Arlekino';

const STATUS_LABELS = {
    pending_payment: 'Ожидает оплаты',
    pending_confirmation: 'Проверяем бронирование',
    confirmed: 'Бронирование подтверждено',
    rejected: 'Бронирование отклонено',
    cancelled: 'Бронирование отменено',
};
const REJECT_REASONS = ['no_availability', 'price_changed', 'data_error', 'other'];
const REJECT_REASON_LABELS = {
    no_availability: 'Нет мест на эти даты',
    price_changed: 'Цена изменилась',
    data_error: 'Ошибка в данных',
    other: 'Другое',
};
const MEAL_NAMES = {
    RO: 'Без питания', OB: 'Без питания', BB: 'Завтрак', HB: 'Завтрак и ужин', FB: 'Полный пансион',
    AI: 'Всё включено', UAI: 'Ультра всё включено', 'HB+': 'Полупансион плюс', 'FB+': 'Полный пансион плюс',
};
const EVENT_TYPES = ['created', 'paid', 'payment_failed', 'confirmed', 'rejected', 'cancelled', 'refund_done', 'voucher_uploaded', 'voucher_sent', 'comment', 'notified'];

// ---------------------------------------------------------------------------
// Утилиты
// ---------------------------------------------------------------------------
function first(...vals) { for (const v of vals) if (v !== null && v !== undefined && v !== '') return v; return null; }
function num(v) { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function int(v) { const n = num(v); return n === null ? null : Math.round(n); }
function str(v, max) { if (v === null || v === undefined) return null; const s = String(v).trim(); return s ? s.slice(0, max || 255) : null; }
function iso(d) { return d ? new Date(d).toISOString() : null; }
function dateOnly(d) {
    if (!d) return null;
    if (d instanceof Date) return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
    const s = String(d).trim();
    let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = /^(\d{2})\.(\d{2})\.(\d{4})/.exec(s);
    if (m) return `${m[3]}-${m[2]}-${m[1]}`;
    return null;
}
function addDays(ymd, days) {
    if (!ymd || !Number.isFinite(days)) return null;
    const d = new Date(`${ymd}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return null;
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}
/** «86 850 ₽» (обычный пробел, как в макетах). */
function money(v) {
    const n = num(v);
    if (n === null) return '';
    return `${String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} ₽`;
}
function cleanOrderId(v) { return v === null || v === undefined ? null : String(v).trim().replace(/^ORDER/i, ''); }
function isInternalOrderId(orderId) { const n = Number(cleanOrderId(orderId)); return Number.isInteger(n) && n > ORDER_ID_BASE; }
function orderIdOf(bookingId) { return String(ORDER_ID_BASE + Number(bookingId)); }
function staffOf(staff) { return { id: staff && staff.id ? Number(staff.id) : null, name: staff && staff.name ? String(staff.name).slice(0, 128) : null }; }

// ---------------------------------------------------------------------------
// Строка → объект
// ---------------------------------------------------------------------------
function fromRow(r) {
    if (!r) return null;
    return {
        id: Number(r.id),
        orderId: String(r.order_id),
        userId: r.user_id === null || r.user_id === undefined ? null : Number(r.user_id),
        roomTypeId: Number(r.room_type_id),
        hotelId: r.hotel_id === null || r.hotel_id === undefined ? null : Number(r.hotel_id),
        hotelName: r.hotel_name || null, hotelStars: r.hotel_stars === null || r.hotel_stars === undefined ? null : Number(r.hotel_stars),
        hotelCity: r.hotel_city || null, hotelCountry: r.hotel_country || null,
        roomName: r.room_name || null, sourceRoomName: r.source_room_name || null, sourceOfferId: r.source_offer_id || null, ltPackageId: r.lt_package_id || null,
        operatorId: r.operator_id === null || r.operator_id === undefined ? null : Number(r.operator_id), operatorName: r.operator_name || null,
        meal: r.meal || null, mealName: r.meal_name || null,
        checkIn: dateOnly(r.check_in), checkOut: dateOnly(r.check_out), nights: int(r.nights), adults: int(r.adults), kids: int(r.kids),
        tourists: store.parseJson(r.tourists_json, []), contact: store.parseJson(r.contact_json, {}) || {}, snapshot: store.parseJson(r.package_snapshot),
        providerPrice: num(r.provider_price), finalPrice: num(r.final_price), priceRule: store.parseJson(r.price_rule, {}) || {},
        paymentStatus: r.payment_status || 'pending', paidAt: iso(r.paid_at), paidAmount: num(r.paid_amount),
        status: r.status || 'pending_payment',
        confirmedAt: iso(r.confirmed_at), confirmedBy: r.confirmed_by || null, hotelBookingRef: r.hotel_booking_ref || null,
        voucherPath: r.voucher_path || null, voucherUrl: r.voucher_url || null, voucherSentAt: iso(r.voucher_sent_at),
        rejectedAt: iso(r.rejected_at), rejectedBy: r.rejected_by || null, rejectReason: r.reject_reason || null, rejectMessage: r.reject_message || null,
        refundAmount: num(r.refund_amount), refundMethod: r.refund_method || null, refundStatus: r.refund_status || null, refundAt: iso(r.refund_at), refundBy: r.refund_by || null,
        clientMessage: r.client_message || null, staffComment: r.staff_comment || null,
        createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
    };
}

function ruleLabelOf(rule) {
    if (!rule || !rule.type) return null;
    const v = Number(rule.value);
    if (!Number.isFinite(v)) return null;
    const sign = v < 0 ? '−' : '+';
    if (rule.type === 'percent') return `${sign}${Math.abs(v)} %`;
    return `${sign}${money(Math.abs(v))}`;
}

function refundLine(b) {
    if (!b.refundStatus) return '';
    const amt = money(b.refundAmount);
    if (b.refundStatus === 'done') return `Возврат ${amt} выполнен.`;
    return `Возврат ${amt} выполним вручную в течение 1–3 дней.`;
}

function statusText(b) {
    switch (b.status) {
        case 'pending_payment':
            return 'Оплатите заказ — после оплаты мы проверим бронирование и пришлём ваучер.';
        case 'pending_confirmation':
            return `Оплачено ${money(b.paidAmount || b.finalPrice)}. Подтвердим бронирование и пришлём ваучер.`;
        case 'confirmed':
            return [b.hotelBookingRef ? `Номер брони ${b.hotelBookingRef}.` : 'Бронирование подтверждено оператором.', b.voucherUrl ? 'Ваучер — в документах заказа.' : 'Ваучер пришлём отдельно.'].join(' ');
        case 'rejected':
            return [`Бронирование отклонено${b.rejectReason ? `: ${REJECT_REASON_LABELS[b.rejectReason] || b.rejectReason}` : ''}.`, refundLine(b)].filter(Boolean).join(' ');
        case 'cancelled':
            return [`Бронирование отменено${b.rejectReason ? `: ${REJECT_REASON_LABELS[b.rejectReason] || b.rejectReason}` : ''}.`, refundLine(b)].filter(Boolean).join(' ');
        default:
            return '';
    }
}

/** Единый объект totus_booking (§3) — для клиентов и админки. Без ПД. */
function serialize(b) {
    if (!b) return null;
    const rule = b.priceRule || {};
    return {
        internal: true,
        bookingId: b.id,
        orderId: b.orderId,
        operator: b.operatorName || DEFAULT_OPERATOR,
        status: b.status,
        statusLabel: STATUS_LABELS[b.status] || b.status,
        statusText: statusText(b),
        paymentStatus: b.paymentStatus,
        paidAt: b.paidAt,
        paidAmount: b.paidAmount,
        hotelBookingRef: b.hotelBookingRef,
        confirmedAt: b.confirmedAt,
        clientMessage: b.clientMessage,
        rejectedAt: b.rejectedAt,
        rejectReason: b.rejectReason,
        rejectReasonLabel: b.rejectReason ? REJECT_REASON_LABELS[b.rejectReason] || null : null,
        rejectMessage: b.rejectMessage,
        refund: b.refundStatus ? { amount: b.refundAmount, method: b.refundMethod || 'manual', status: b.refundStatus, at: b.refundAt } : null,
        voucher: b.voucherUrl ? { url: b.voucherUrl, title: 'Ваучер', sentAt: b.voucherSentAt } : null,
        hotel: { id: b.hotelId, name: b.hotelName, stars: b.hotelStars, city: b.hotelCity },
        room: b.roomName,
        meal: b.meal,
        mealName: b.mealName,
        checkIn: b.checkIn, checkOut: b.checkOut, nights: b.nights, adults: b.adults, kids: b.kids,
        providerPrice: b.providerPrice,
        finalPrice: b.finalPrice,
        priceRule: rule.type ? { type: rule.type, value: num(rule.value), label: ruleLabelOf(rule) } : null,
    };
}

/** Для админки: + покупатель, комментарий, даты. */
function serializeAdmin(b) {
    if (!b) return null;
    const c = b.contact || {};
    return Object.assign(serialize(b), {
        customer: { name: [c.name, c.surname].filter(Boolean).join(' ').trim() || null, phone: c.phone || null, email: c.email || null },
        createdAt: b.createdAt,
        updatedAt: b.updatedAt,
        staffComment: b.staffComment,
        confirmedBy: b.confirmedBy, rejectedBy: b.rejectedBy, refundBy: b.refundBy,
        roomTypeId: b.roomTypeId,
        sourceRoomName: b.sourceRoomName,
        hotelCountry: b.hotelCountry,
        touristsCount: Array.isArray(b.tourists) ? b.tourists.length : 0,
    });
}

// ---------------------------------------------------------------------------
// Чтение
// ---------------------------------------------------------------------------
async function getById(id) {
    const n = int(id);
    if (!n) return null;
    const [rows] = await db.query('SELECT * FROM custom_room_bookings WHERE id = ? LIMIT 1', [n]);
    return rows.length ? fromRow(rows[0]) : null;
}

async function getByOrderId(orderId) {
    const oid = cleanOrderId(orderId);
    if (!oid || !isInternalOrderId(oid)) return null;
    try {
        const [rows] = await db.query('SELECT * FROM custom_room_bookings WHERE order_id = ? LIMIT 1', [oid]);
        return rows.length ? fromRow(rows[0]) : null;
    } catch (e) { return null; }
}

/** Map order_id → booking (только внутренние id; без таблицы — пустая Map). */
async function getByOrderIds(orderIds) {
    const ids = [...new Set((orderIds || []).map(cleanOrderId).filter((x) => x && isInternalOrderId(x)))];
    if (!ids.length) return new Map();
    try {
        const [rows] = await db.query('SELECT * FROM custom_room_bookings WHERE order_id IN (?)', [ids]);
        return new Map(rows.map((r) => [String(r.order_id), fromRow(r)]));
    } catch (e) { return new Map(); }
}

/** Внутренний ли заказ (наше бронирование без LT). Никогда не бросает. */
async function isInternalOrder(orderId) {
    if (!isInternalOrderId(orderId)) return false;
    return Boolean(await getByOrderId(orderId));
}

async function addEvent(bookingId, type, staff, payload) {
    try {
        const s = staffOf(staff);
        await db.query('INSERT INTO custom_room_booking_events (booking_id, type, staff_id, staff_name, payload) VALUES (?, ?, ?, ?, ?)',
            [Number(bookingId), EVENT_TYPES.includes(type) ? type : 'comment', s.id, s.name, JSON.stringify(payload || {})]);
    } catch (e) { console.warn('[custom-rooms] booking event failed:', e.message); }
}

async function listEvents(bookingId, limit = 100) {
    const [rows] = await db.query('SELECT * FROM custom_room_booking_events WHERE booking_id = ? ORDER BY id ASC LIMIT ?', [Number(bookingId), Math.min(Number(limit) || 100, 500)]);
    return rows.map((r) => ({ id: Number(r.id), type: r.type, staffId: r.staff_id === null ? null : Number(r.staff_id), staffName: r.staff_name || null, payload: store.parseJson(r.payload, {}), createdAt: iso(r.created_at) }));
}

// ---------------------------------------------------------------------------
// Создание (create-package без LT)
// ---------------------------------------------------------------------------
function pickName(v) {
    if (!v) return null;
    if (typeof v === 'string') return v;
    return v.name_ru || v.name || v.title || null;
}

/** Поля бронирования из снимка пакета (ответ package_details с нашими ценами) + карта + Room Type. */
function extractBookingFields({ snapshot, map, rt, payload, search }) {
    const pkg = (snapshot && snapshot.package && typeof snapshot.package === 'object') ? snapshot.package : (snapshot || {});
    const hotel = pkg.hotel && typeof pkg.hotel === 'object' ? pkg.hotel : {};
    const di = pkg.dates_info && typeof pkg.dates_info === 'object' ? pkg.dates_info : {};
    const tourists = Array.isArray(payload && payload.tourists) ? payload.tourists : [];
    const sp = (search && search.params) || {};

    const checkIn = dateOnly(pkg.start_date || di.start_date || di.check_in || pkg.hotel_start_date || pkg.check_in || sp.start_date);
    const nights = int(di.nights_count || pkg.nights_count || di.nights || pkg.nights || di.hotel_nights || sp.nights);
    const checkOut = dateOnly(pkg.end_date || di.end_date || di.check_out || pkg.check_out) || (checkIn && nights ? addDays(checkIn, nights) : null);
    const kidsFromTourists = tourists.filter((t) => t && (t.is_child || t.child || (t.age !== undefined && Number(t.age) < 18))).length;
    const adults = int(first(pkg.adults_count, di.adults, pkg.adults, sp.adults)) || (tourists.length ? tourists.length - kidsFromTourists : null);
    const kids = int(first(pkg.kids_count, di.kids, pkg.kids, sp.kids));

    const meal = str(map.meal || (pkg.meal && (pkg.meal.id || pkg.meal.code)) || (typeof pkg.meal === 'string' ? pkg.meal : null) || (pkg.pansion && pkg.pansion.id) || pkg.pansion_id, 16);
    const mealName = str((pkg.meal && typeof pkg.meal === 'object' && (pkg.meal.name_ru || pkg.meal.name)) || pkg.pansion_name || pkg.meal_name || (meal ? MEAL_NAMES[meal.toUpperCase()] : null), 64);
    const operatorObj = pkg.operator && typeof pkg.operator === 'object' ? pkg.operator : null;
    const operatorName = str(map.operatorName || (operatorObj && (operatorObj.name || operatorObj.name_ru)) || pkg.operator_name || (rt && rt.last && rt.last.operator) || DEFAULT_OPERATOR, 128);
    const operatorId = int((operatorObj && operatorObj.id) || pkg.operator_id) || (rt && Array.isArray(rt.operatorIds) && rt.operatorIds.length === 1 ? Number(rt.operatorIds[0]) : null);

    return {
        hotelId: int(hotel.id) || map.hotelId || (rt && rt.hotelId) || null,
        hotelName: str(pickName(hotel) || (rt && rt.hotelName), 255),
        hotelStars: int(hotel.stars) || (rt && rt.hotelStars) || null,
        hotelCity: str(pickName(hotel.city) || hotel.city_name || (rt && rt.hotelCity), 128),
        hotelCountry: str(pickName(hotel.country) || hotel.country_name || pickName(pkg.country), 128),
        roomName: str((rt && rt.content && rt.content.nameRu) || pickName(pkg.room), 255),
        sourceRoomName: str((rt && rt.sourceRoomName) || null, 255),
        operatorId, operatorName, meal, mealName, checkIn, checkOut, nights, adults, kids,
    };
}

/** Контакт покупателя — как в app.js /create-package (email + телефон обязательны). */
function extractContact(payload) {
    const p = payload || {};
    const c = p.client || {};
    const email = str(c.email || p.email, 255);
    const phone = String(c.phone || p.phone || '').replace(/\D/g, '') || null;
    const name = str(c.name || (p.name ? String(p.name).split(' ')[0] : null), 128);
    const surname = str(c.surname || (p.name ? String(p.name).split(' ').slice(1).join(' ') : null), 128);
    return { name, surname, email, phone };
}

/**
 * Создать бронирование + строку orders. Возвращает { booking, orderData }.
 * input: { map, rt, payload (тело create-package), userId }
 */
async function create({ map, rt, payload, userId }) {
    const snapshot = map.snapshot;
    if (!snapshot) { const e = new Error('offer_expired'); e.code = 'offer_expired'; throw e; }
    const contact = extractContact(payload);
    if (!contact.email || !contact.phone) { const e = new Error('Buyer email and phone are required'); e.code = 'contact_required'; throw e; }

    let search = null;
    try {
        if (map.virtualOfferId) {
            const offer = await store.getOffer(map.virtualOfferId);
            if (offer && offer.requestId) search = await store.getSearch(offer.requestId);
        }
    } catch (e) { /* необязательно */ }

    const f = extractBookingFields({ snapshot, map, rt, payload, search });
    const tourists = Array.isArray(payload && payload.tourists) ? payload.tourists : [];
    const rule = Object.assign({}, map.rule || {}, { operator: f.operatorName });
    const placeholder = `tmp-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

    const [ins] = await db.query(
        `INSERT INTO custom_room_bookings (order_id, user_id, room_type_id, hotel_id, hotel_name, hotel_stars, hotel_city, hotel_country, room_name, source_room_name, source_offer_id, lt_package_id,
            operator_id, operator_name, meal, meal_name, check_in, check_out, nights, adults, kids, tourists_json, contact_json, package_snapshot, provider_price, final_price, price_rule, payment_status, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending_payment')`,
        [placeholder, userId === null || userId === undefined || userId === '' ? null : Number(userId), map.roomTypeId, f.hotelId, f.hotelName, f.hotelStars, f.hotelCity, f.hotelCountry, f.roomName, f.sourceRoomName,
            map.sourceOfferId ? String(map.sourceOfferId).slice(0, 64) : null, String(map.ltPackageId).slice(0, 64),
            f.operatorId, f.operatorName, f.meal, f.mealName, f.checkIn, f.checkOut, f.nights, f.adults, f.kids,
            JSON.stringify(tourists), JSON.stringify(contact), JSON.stringify(snapshot), map.providerPrice, map.finalPrice, JSON.stringify(rule)],
    );
    const id = ins.insertId;
    const orderId = orderIdOf(id);
    await db.query('UPDATE custom_room_bookings SET order_id = ? WHERE id = ?', [orderId, id]);

    // orders: package JSON в формате LT-заказа (цены наши), lt_auth_token = NULL
    const final = map.finalPrice;
    const pkg = snapshot.package && typeof snapshot.package === 'object' ? snapshot.package : {};
    const customerName = [contact.name, contact.surname].filter(Boolean).join(' ').trim() || null;
    const orderData = {
        id: Number(orderId),
        state: 'pending_payment',
        full_price: final, price: final, remaining_amount: final, _pay_amount: final,
        package: Object.assign({}, pkg, { price: final }),
        tourists,
        client: { name: contact.name || 'Покупатель', surname: contact.surname || '', email: contact.email, phone: contact.phone },
        _customer_email: contact.email, _customer_phone: contact.phone, _customer_name: customerName,
        _totus_room: { roomTypeId: map.roomTypeId, providerPrice: map.providerPrice, finalPrice: final, operator: f.operatorName },
        _totus_booking: { internal: true, operator: f.operatorName, bookingId: id },
        created_at: new Date().toISOString(),
    };
    const uid = userId === null || userId === undefined || userId === '' ? null : Number(userId);
    try {
        try {
            await db.query(
                'INSERT INTO orders (order_id, package, user_id, lt_auth_token, custom_room_type_id, provider_price, final_price, price_rule, order_state) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)',
                [orderId, JSON.stringify(orderData), uid, map.roomTypeId, map.providerPrice, final, JSON.stringify(rule), 'pending_payment'],
            );
        } catch (dbErr) {
            await db.query(
                'INSERT INTO orders (order_id, package, user_id, custom_room_type_id, provider_price, final_price, price_rule, order_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                [orderId, JSON.stringify(orderData), uid, map.roomTypeId, map.providerPrice, final, JSON.stringify(rule), 'pending_payment'],
            );
        }
    } catch (e) {
        await db.query('DELETE FROM custom_room_bookings WHERE id = ?', [id]).catch(() => {});
        throw e;
    }
    await addEvent(id, 'created', null, { orderId, finalPrice: final, providerPrice: map.providerPrice, operator: f.operatorName, packageId: map.ltPackageId, userId: uid });
    console.log(`[custom-rooms] booking #${id} created: order ${orderId}, room type ${map.roomTypeId}, ${f.operatorName}, final ${final}`);
    const booking = await getById(id);
    return { booking, orderData };
}

// ---------------------------------------------------------------------------
// Оплата
// ---------------------------------------------------------------------------
/** Первая успешная оплата: pending_payment → pending_confirmation, письма/push. Идемпотентно. */
async function onPaid(orderId, amount, opts = {}) {
    const b = await getByOrderId(orderId);
    if (!b) return null;
    if (b.status !== 'pending_payment') return b;
    const paid = num(amount) || b.finalPrice;
    const [r] = await db.query(
        "UPDATE custom_room_bookings SET payment_status = 'paid', paid_at = NOW(), paid_amount = ?, status = 'pending_confirmation' WHERE id = ? AND status = 'pending_payment'",
        [paid, b.id],
    );
    if (!r.affectedRows) return getById(b.id);
    await db.query("UPDATE orders SET order_state = 'pending_confirmation' WHERE order_id = ?", [b.orderId]).catch((e) => console.warn('[custom-rooms] orders.order_state failed:', e.message));
    await addEvent(b.id, 'paid', null, { amount: paid, source: opts.source || null });
    const fresh = await getById(b.id);
    console.log(`[custom-rooms] booking #${b.id} paid ${paid} (order ${b.orderId}) — awaiting confirmation`);
    if (opts.notify !== false) {
        const emails = require('./bookingEmails');
        emails.onPaid(fresh).then((res) => addEvent(b.id, 'notified', null, { kind: 'paid', ...res })).catch((e) => console.error('[custom-rooms] paid notify failed:', e.message));
    }
    return fresh;
}

/** Отклонённый/просроченный платёж (VTB callback) — только событие; статус не меняем (клиент может оплатить снова). */
async function onPaymentFailed(orderId, payStatus) {
    const b = await getByOrderId(orderId);
    if (!b || b.status !== 'pending_payment') return null;
    await addEvent(b.id, 'payment_failed', null, { payStatus: payStatus || null });
    return b;
}

// ---------------------------------------------------------------------------
// Действия сотрудника
// ---------------------------------------------------------------------------
function conflict(b, allowed) {
    return { error: 'invalid_status', status: b.status, allowed };
}

async function confirm(id, opts = {}, staff) {
    const b = await getById(id);
    if (!b) return { error: 'not_found' };
    if (b.status !== 'pending_confirmation') return conflict(b, ['pending_confirmation']);
    const s = staffOf(staff);
    const ref = str(opts.hotelBookingRef, 128);
    const msg = opts.clientMessage === undefined || opts.clientMessage === null ? null : String(opts.clientMessage).slice(0, 4000) || null;
    await db.query(
        "UPDATE custom_room_bookings SET status = 'confirmed', confirmed_at = NOW(), confirmed_by = ?, hotel_booking_ref = ?, client_message = ? WHERE id = ? AND status = 'pending_confirmation'",
        [s.name, ref, msg, b.id],
    );
    await db.query("UPDATE orders SET order_state = 'confirmed' WHERE order_id = ?", [b.orderId]).catch(() => {});
    const notify = opts.notify !== false;
    await addEvent(b.id, 'confirmed', s, { hotelBookingRef: ref, clientMessage: Boolean(msg), notify, voucher: Boolean(b.voucherPath) });
    const fresh = await getById(b.id);
    if (notify) {
        const emails = require('./bookingEmails');
        emails.onConfirmed(fresh).then(async (res) => {
            await addEvent(b.id, 'notified', s, { kind: 'confirmed', ...res });
            if (res && res.sent && res.voucherAttached) {
                await db.query('UPDATE custom_room_bookings SET voucher_sent_at = NOW() WHERE id = ?', [b.id]);
                await addEvent(b.id, 'voucher_sent', s, { with: 'confirmation' });
            }
        }).catch((e) => console.error('[custom-rooms] confirm notify failed:', e.message));
    }
    return { booking: fresh };
}

async function rejectOrCancel(id, opts, staff, nextStatus) {
    const b = await getById(id);
    if (!b) return { error: 'not_found' };
    const allowed = nextStatus === 'rejected' ? ['pending_confirmation'] : ['confirmed'];
    if (!allowed.includes(b.status)) return conflict(b, allowed);
    const reason = REJECT_REASONS.includes(opts.reason) ? opts.reason : null;
    if (!reason) return { error: 'reason_invalid' };
    const message = opts.message === undefined || opts.message === null ? null : String(opts.message).slice(0, 4000) || null;
    const paid = b.paidAmount || b.finalPrice || 0;
    const refundAmount = opts.refundAmount === undefined || opts.refundAmount === null || opts.refundAmount === '' ? paid : num(opts.refundAmount);
    if (refundAmount === null || refundAmount < 0 || refundAmount > paid + 0.01) return { error: 'refund_amount_invalid', max: paid };
    const refundDone = opts.refundDone === true;
    const s = staffOf(staff);
    const paymentStatus = refundDone ? (refundAmount >= paid - 0.01 ? 'refunded' : 'partially_refunded') : 'refund_pending';
    await db.query(
        `UPDATE custom_room_bookings SET status = ?, rejected_at = NOW(), rejected_by = ?, reject_reason = ?, reject_message = ?, payment_status = ?,
            refund_amount = ?, refund_method = 'manual', refund_status = ?, refund_at = ${refundDone ? 'NOW()' : 'NULL'}, refund_by = ? WHERE id = ? AND status = ?`,
        [nextStatus, s.name, reason, message, paymentStatus, refundAmount, refundDone ? 'done' : 'pending', refundDone ? s.name : null, b.id, b.status],
    );
    await db.query(`UPDATE orders SET order_state = ?${refundDone ? ', refund_amount = ?, refund_at = NOW()' : ''} WHERE order_id = ?`, refundDone ? [nextStatus, refundAmount, b.orderId] : [nextStatus, b.orderId]).catch(() => {});
    const notify = opts.notify !== false;
    await addEvent(b.id, nextStatus, s, { reason, message: Boolean(message), refundAmount, refundDone, notify });
    if (refundDone) await addEvent(b.id, 'refund_done', s, { amount: refundAmount, with: nextStatus });
    const fresh = await getById(b.id);
    if (notify) {
        const emails = require('./bookingEmails');
        emails.onRejected(fresh).then((res) => addEvent(b.id, 'notified', s, { kind: nextStatus, ...res })).catch((e) => console.error('[custom-rooms] reject notify failed:', e.message));
    }
    return { booking: fresh };
}

const reject = (id, opts, staff) => rejectOrCancel(id, opts || {}, staff, 'rejected');
const cancel = (id, opts, staff) => rejectOrCancel(id, opts || {}, staff, 'cancelled');

async function refundDone(id, opts = {}, staff) {
    const b = await getById(id);
    if (!b) return { error: 'not_found' };
    if (b.refundStatus !== 'pending') return { error: 'invalid_status', status: b.status, refundStatus: b.refundStatus };
    const paid = b.paidAmount || b.finalPrice || 0;
    const amount = opts.amount === undefined || opts.amount === null || opts.amount === '' ? (b.refundAmount || paid) : num(opts.amount);
    if (amount === null || amount <= 0 || amount > paid + 0.01) return { error: 'refund_amount_invalid', max: paid };
    const s = staffOf(staff);
    const paymentStatus = amount >= paid - 0.01 ? 'refunded' : 'partially_refunded';
    await db.query("UPDATE custom_room_bookings SET refund_amount = ?, refund_status = 'done', refund_at = NOW(), refund_by = ?, payment_status = ? WHERE id = ? AND refund_status = 'pending'", [amount, s.name, paymentStatus, b.id]);
    await db.query('UPDATE orders SET refund_amount = ?, refund_at = NOW() WHERE order_id = ?', [amount, b.orderId]).catch(() => {});
    await addEvent(b.id, 'refund_done', s, { amount, paymentStatus });
    const fresh = await getById(b.id);
    if (opts.notify !== false) {
        const emails = require('./bookingEmails');
        emails.onRefundDone(fresh).then((res) => addEvent(b.id, 'notified', s, { kind: 'refund_done', ...res })).catch((e) => console.error('[custom-rooms] refund notify failed:', e.message));
    }
    return { booking: fresh };
}

/** REFUND-callback банка по внутреннему заказу — только отметить возврат выполненным. */
async function onBankRefund(orderId, amount) {
    const b = await getByOrderId(orderId);
    if (!b) return null;
    const paid = b.paidAmount || b.finalPrice || 0;
    const amt = num(amount) || b.refundAmount || paid;
    const paymentStatus = amt >= paid - 0.01 ? 'refunded' : 'partially_refunded';
    await db.query("UPDATE custom_room_bookings SET refund_amount = ?, refund_method = 'manual', refund_status = 'done', refund_at = NOW(), payment_status = ? WHERE id = ?", [amt, paymentStatus, b.id]);
    await addEvent(b.id, 'refund_done', null, { amount: amt, source: 'vtb_callback' });
    return getById(b.id);
}

async function comment(id, text, staff) {
    const b = await getById(id);
    if (!b) return { error: 'not_found' };
    const t = text === undefined || text === null ? null : String(text).slice(0, 4000);
    await db.query('UPDATE custom_room_bookings SET staff_comment = ? WHERE id = ?', [t || null, b.id]);
    await addEvent(b.id, 'comment', staffOf(staff), { text: t });
    return { booking: await getById(b.id) };
}

// ---------------------------------------------------------------------------
// Ваучер
// ---------------------------------------------------------------------------
function voucherEventRef(bookingId) { return `totus_voucher_${bookingId}`; }

/** Сохранить загруженный PDF (multer file) как ваучер + запись в order_documents. */
async function attachVoucher(id, file, staff) {
    const b = await getById(id);
    if (!b) return { error: 'not_found' };
    if (!file || !file.filename) return { error: 'file_required' };
    if (['pending_payment'].includes(b.status)) return conflict(b, ['pending_confirmation', 'confirmed']);
    const relPath = path.posix.join('uploads', 'vouchers', file.filename);
    const publicPath = `/uploads/vouchers/${file.filename}`;
    const url = `${API_PUBLIC_URL}${publicPath}`;
    // старый файл — удалить (best effort)
    if (b.voucherPath && b.voucherPath !== relPath) {
        try { const old = path.join(__dirname, '..', '..', b.voucherPath); if (fs.existsSync(old)) fs.unlinkSync(old); } catch (e) { /* ignore */ }
    }
    await db.query('UPDATE custom_room_bookings SET voucher_path = ?, voucher_url = ?, voucher_sent_at = NULL WHERE id = ?', [relPath, url, b.id]);
    try {
        await db.query('DELETE FROM order_documents WHERE order_id = ? AND event_reference = ?', [b.orderId, voucherEventRef(b.id)]);
        await db.query('INSERT INTO order_documents (order_id, title, source_url, file_path, public_url, event_reference) VALUES (?, ?, ?, ?, ?, ?)',
            [b.orderId, 'Ваучер', url, relPath, publicPath, voucherEventRef(b.id)]);
    } catch (e) { console.warn('[custom-rooms] order_documents voucher failed:', e.message); }
    await addEvent(b.id, 'voucher_uploaded', staffOf(staff), { file: file.filename, size: file.size || null });
    return { booking: await getById(b.id) };
}

async function resendVoucher(id, staff) {
    const b = await getById(id);
    if (!b) return { error: 'not_found' };
    if (!b.voucherPath) return { error: 'voucher_required' };
    if (b.status !== 'confirmed') return conflict(b, ['confirmed']);
    const s = staffOf(staff);
    const emails = require('./bookingEmails');
    const res = await emails.sendVoucher(b);
    if (res && res.sent) {
        await db.query('UPDATE custom_room_bookings SET voucher_sent_at = NOW() WHERE id = ?', [b.id]);
        await addEvent(b.id, 'voucher_sent', s, { resend: true });
    }
    await addEvent(b.id, 'notified', s, { kind: 'voucher', ...res });
    return { booking: await getById(b.id), result: res };
}

// ---------------------------------------------------------------------------
// Список и сводка (админка)
// ---------------------------------------------------------------------------
function listWhere(f) {
    const where = [];
    const args = [];
    switch (String(f.status || 'all')) {
        case 'pending': where.push("b.status = 'pending_confirmation'"); break;
        case 'confirmed': where.push("b.status = 'confirmed'"); break;
        case 'rejected': where.push("b.status IN ('rejected', 'cancelled')"); break;
        case 'refund': where.push("b.refund_status = 'pending'"); break;
        case 'unpaid': where.push("b.status = 'pending_payment'"); break;
        case 'all': default: break;
    }
    if (f.hotel_id) { where.push('b.hotel_id = ?'); args.push(Number(f.hotel_id)); }
    if (f.operator) { where.push('b.operator_name LIKE ?'); args.push(`%${String(f.operator).slice(0, 64)}%`); }
    if (f.room_type_id) { where.push('b.room_type_id = ?'); args.push(Number(f.room_type_id)); }
    if (f.user_id) { where.push('b.user_id = ?'); args.push(Number(f.user_id)); }
    if (f.q) {
        const q = `%${String(f.q).trim().slice(0, 64)}%`;
        where.push('(b.order_id LIKE ? OR b.hotel_name LIKE ? OR b.room_name LIKE ? OR b.hotel_booking_ref LIKE ? OR b.contact_json LIKE ?)');
        args.push(q, q, q, q, q);
    }
    if (f.from) { where.push('b.created_at >= ?'); args.push(new Date(f.from)); }
    if (f.to) { where.push('b.created_at <= ?'); args.push(new Date(f.to)); }
    return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
}

async function list(filters = {}) {
    const { sql, args } = listWhere(filters);
    const limit = Math.min(Math.max(Number(filters.limit) || 50, 1), 200);
    const page = Math.max(Number(filters.page) || 1, 1);
    const [[cnt]] = await db.query(`SELECT COUNT(*) AS total FROM custom_room_bookings b ${sql}`, args);
    const [rows] = await db.query(`SELECT b.* FROM custom_room_bookings b ${sql} ORDER BY b.id DESC LIMIT ? OFFSET ?`, [...args, limit, (page - 1) * limit]);
    return { items: rows.map((r) => serializeAdmin(fromRow(r))), total: Number(cnt.total || 0), page, limit };
}

async function summary() {
    const [[r]] = await db.query(`SELECT
        SUM(status = 'pending_confirmation') AS pending,
        SUM(status = 'confirmed' AND confirmed_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)) AS confirmed30d,
        SUM(status IN ('rejected', 'cancelled')) AS rejected,
        SUM(refund_status = 'pending') AS refundPending,
        COALESCE(SUM(CASE WHEN refund_status = 'pending' THEN refund_amount ELSE 0 END), 0) AS refundPendingAmount
      FROM custom_room_bookings`);
    return { pending: Number(r.pending || 0), confirmed30d: Number(r.confirmed30d || 0), rejected: Number(r.rejected || 0), refundPending: Number(r.refundPending || 0), refundPendingAmount: Number(r.refundPendingAmount || 0) };
}

/** Карточка для админки: бронирование + Room Type + события + платёж заказа. */
async function details(id) {
    const b = await getById(id);
    if (!b) return null;
    const rt = await store.getRoomType(b.roomTypeId).catch(() => null);
    const events = await listEvents(b.id);
    let order = { orderId: b.orderId, payStatus: null, transactionCode: null, payUrl: null, payAmount: null, orderState: null };
    try {
        const [rows] = await db.query('SELECT pay_status, transaction_code, order_state, package FROM orders WHERE order_id = ? LIMIT 1', [b.orderId]);
        if (rows.length) {
            const pkg = store.parseJson(rows[0].package, {}) || {};
            order = { orderId: b.orderId, payStatus: rows[0].pay_status || null, transactionCode: rows[0].transaction_code || null, orderState: rows[0].order_state || null, payUrl: pkg._pay_url || null, payAmount: num(pkg._pay_amount) };
        }
    } catch (e) { /* ignore */ }
    const snap = b.snapshot && b.snapshot.package && typeof b.snapshot.package === 'object' ? b.snapshot.package : (b.snapshot || {});
    return {
        booking: Object.assign(serializeAdmin(b), { tourists: b.tourists, contact: b.contact, hotelSnapshot: snap.hotel || null, roomSnapshot: snap.room || null, packageId: b.ltPackageId, sourceOfferId: b.sourceOfferId }),
        roomType: rt ? { id: rt.id, name: rt.content && rt.content.nameRu, sourceRoomName: rt.sourceRoomName, hotelName: rt.hotelName, active: rt.active } : { id: b.roomTypeId, name: b.roomName, sourceRoomName: b.sourceRoomName },
        events,
        order,
    };
}

module.exports = {
    ORDER_ID_BASE, STATUS_LABELS, REJECT_REASONS, REJECT_REASON_LABELS, MEAL_NAMES, EVENT_TYPES, DEFAULT_OPERATOR,
    money, isInternalOrderId, orderIdOf, cleanOrderId, fromRow, serialize, serializeAdmin, statusText,
    extractBookingFields, extractContact,
    getById, getByOrderId, getByOrderIds, isInternalOrder, addEvent, listEvents,
    create, onPaid, onPaymentFailed, confirm, reject, cancel, refundDone, onBankRefund, comment,
    attachVoucher, resendVoucher, voucherEventRef, list, summary, details,
};
