// Проверка наших Room Type без БД и сети: node scripts/check-custom-rooms.js
// Правило цены, подмена номеров в выдаче LT, переписывание цен в пакете/заказе, маршруты middleware,
// бронирования без Level.Travel (totus_booking, статусные переходы на фейковой БД, синтез prebook).
'use strict';
const assert = require('assert');
process.env.DB_HOST = process.env.DB_HOST || 'localhost';
process.env.JWT_SECRET = process.env.JWT_SECRET || 's1';

// --- фейковая БД для bookings (одна строка custom_room_bookings + события; orders — игнорируем) ---
const fakeDb = { row: null, events: [], orders: [] };
function splitTop(s) { const out = []; let d = 0, cur = ''; for (const ch of s) { if (ch === '(') d++; if (ch === ')') d--; if (ch === ',' && d === 0) { out.push(cur); cur = ''; } else cur += ch; } if (cur.trim()) out.push(cur); return out; }
function fakeQuery(sql, args = []) {
    const q = String(sql).replace(/\s+/g, ' ').trim();
    let ai = 0; const next = () => args[ai++];
    if (/^INSERT INTO custom_room_bookings/i.test(q)) {
        const cols = /\(([^)]+)\) VALUES/i.exec(q)[1].split(',').map((c) => c.trim());
        const row = { id: 12, created_at: new Date(), updated_at: new Date(), payment_status: 'pending', status: 'pending_payment' };
        for (const c of cols) { if (ai < args.length) row[c] = next(); } // литералы 'pending'/'pending_payment' — по умолчанию
        fakeDb.row = row; return Promise.resolve([{ insertId: 12 }]);
    }
    if (/^UPDATE custom_room_bookings SET/i.test(q)) {
        const m = /SET (.*?) WHERE (.*)$/i.exec(q);
        const sets = splitTop(m[1]);
        const patch = {};
        for (const s of sets) { const [col, expr] = s.split('=').map((x) => x.trim()); patch[col] = expr === '?' ? next() : expr === 'NOW()' ? new Date() : expr === 'NULL' ? null : expr.replace(/^'|'$/g, ''); }
        const where = m[2]; const rest = args.slice(ai);
        let ok = true;
        if (/status = \?/.test(where) && /AND status = \?/.test(where)) ok = fakeDb.row.status === rest[rest.length - 1];
        if (/AND status = 'pending_payment'/.test(where)) ok = fakeDb.row.status === 'pending_payment';
        if (/AND status = 'pending_confirmation'/.test(where)) ok = fakeDb.row.status === 'pending_confirmation';
        if (/AND refund_status = 'pending'/.test(where)) ok = fakeDb.row.refund_status === 'pending';
        if (ok) Object.assign(fakeDb.row, patch);
        return Promise.resolve([{ affectedRows: ok ? 1 : 0 }]);
    }
    if (/^SELECT \* FROM custom_room_bookings WHERE (id|order_id) = \?/i.test(q)) {
        const v = String(args[0]); const r = fakeDb.row;
        return Promise.resolve([r && (String(r.id) === v || String(r.order_id) === v) ? [{ ...r }] : []]);
    }
    if (/^SELECT \* FROM custom_room_bookings WHERE order_id IN/i.test(q)) {
        const r = fakeDb.row; return Promise.resolve([r && args[0].map(String).includes(String(r.order_id)) ? [{ ...r }] : []]);
    }
    if (/^INSERT INTO custom_room_booking_events/i.test(q)) { fakeDb.events.push({ type: args[1], staff: args[3], payload: JSON.parse(args[4]) }); return Promise.resolve([{ insertId: fakeDb.events.length }]); }
    if (/^SELECT \* FROM custom_room_booking_events/i.test(q)) return Promise.resolve([fakeDb.events.map((e, i) => ({ id: i + 1, booking_id: 12, type: e.type, staff_name: e.staff, payload: JSON.stringify(e.payload), created_at: new Date() }))]);
    if (/^INSERT INTO orders/i.test(q)) { fakeDb.orders.push({ order_id: args[0], package: args[1] }); return Promise.resolve([{ insertId: 1 }]); }
    if (/^UPDATE orders|^DELETE FROM order_documents|^INSERT INTO order_documents/i.test(q)) return Promise.resolve([{ affectedRows: 1 }]);
    if (/FROM custom_room_offer_map|FROM custom_room_searches|FROM orders|FROM custom_room_types/i.test(q)) return Promise.resolve([[]]);
    return Promise.reject(new Error(`fake db: unsupported query ${q.slice(0, 60)}`));
}
const dbMod = require('../db');
dbMod.query = fakeQuery;

const { normalizeRule, finalPrice, ruleLabel } = require('../lib/customRooms/pricing');
const inject = require('../lib/customRooms/inject');
const flow = require('../lib/customRooms/packageFlow');
const mw = require('../middleware/customRooms');
const bookings = require('../lib/customRooms/bookings');
const bookingEmails = require('../lib/customRooms/bookingEmails');
const internal = require('../lib/customRooms/internalOrders');
const vtbCheck = require('../lib/customRooms/vtbCheck');

// --- правило цены ------------------------------------------------------------
const g = { minMarginType: 'percent', minMarginValue: 15, rounding: 1 };
let r = normalizeRule({ ruleType: 'percent', ruleValue: -10 }, g);
assert.strictEqual(r.error, undefined);
assert.strictEqual(r.minMarginType, 'percent'); assert.strictEqual(r.minMarginValue, 15); assert.strictEqual(r.ownMargin, false);
let p = finalPrice(96500, r);
assert.strictEqual(p.final, 86850, '−10 % от 96 500');
assert.strictEqual(p.margin, -9650); assert.strictEqual(p.marginClamped, false);

r = normalizeRule({ rule_type: 'absolute', rule_value: 1500, rounding: 100 }, g);
assert.strictEqual(finalPrice(96500, r).final, 98000, '+1 500 с округлением до 100');

r = normalizeRule({ ruleType: 'percent', ruleValue: -30 }, g);
p = finalPrice(100000, r);
assert.strictEqual(p.marginClamped, true, 'скидка 30 % ниже мин. маржи 15 %');
assert.strictEqual(p.final, 85000);

r = normalizeRule({ ruleType: 'percent', ruleValue: -30, minMarginType: 'absolute', minMarginValue: 50000 }, g);
p = finalPrice(100000, r);
assert.strictEqual(p.marginClamped, false, 'своя маржа в рублях допускает');
assert.strictEqual(p.final, 70000);

r = normalizeRule({ ruleType: 'percent', ruleValue: 5, minPrice: 120000 }, g);
assert.strictEqual(finalPrice(100000, r).final, 120000, 'min_price');
r = normalizeRule({ ruleType: 'percent', ruleValue: 5, maxPrice: 101000 }, g);
assert.strictEqual(finalPrice(100000, r).final, 101000, 'max_price');
r = normalizeRule({ ruleType: 'percent', ruleValue: 0 }, { minMarginType: 'absolute', minMarginValue: -2000 });
p = finalPrice(100000, r);
assert.strictEqual(p.final, 102000, 'отрицательная субсидия = обязательная наценка');
assert.deepStrictEqual(normalizeRule({ ruleType: 'foo', ruleValue: 1 }, {}), { error: 'rule_type_invalid' });
assert.deepStrictEqual(normalizeRule({ ruleType: 'percent', ruleValue: 'x' }, {}), { error: 'rule_value_invalid' });
assert.deepStrictEqual(normalizeRule({ ruleType: 'percent', ruleValue: 1, minPrice: 10, maxPrice: 5 }, {}), { error: 'min_max_invalid' });
assert.strictEqual(finalPrice(null, r).final, null);
assert.strictEqual(ruleLabel(normalizeRule({ ruleType: 'percent', ruleValue: -10 }, {})), '−10 %');
assert.strictEqual(ruleLabel(normalizeRule({ ruleType: 'absolute', ruleValue: 1500 }, {})), '+1 500 ₽');

// --- подмена в выдаче (без БД: pickSourceOffers / buildVirtualRoom / makeVirtualOffer) ---
const ltRoom = {
    ID: 'r1', min_price: 96500, bonus_count: 0, cashback_identifier: null,
    meal_types: [{ id: 'AI', min_price: 96500, description: 'Всё включено' }, { id: 'UAI', min_price: 112300, description: 'Ультра' }],
    room: { id: 501, name_ru: 'Deluxe Room Sea View', name_en: 'Deluxe', accommodation: '2+1', area: 38, description: 'x', view: 'sea', facilities: [{ id: 1, name: 'Wi-Fi', group_identifier: null }], images: [{ x900: 'https://lt/1.jpg' }] },
    offers: {
        AI: [{ id: '9001', price: 96500, nights_count: 7, price_per_night: 13786, operator_id: 12, operator_name: 'Arlekino', extras: { cheap: true } }, { id: '9002', price: 98900, nights_count: 7, operator_id: 33, operator_name: 'Coral Travel' }],
        UAI: [{ id: '9003', price: 112300, nights_count: 7, operator_id: 12, operator_name: 'Arlekino' }],
    },
    lt_extras: {},
};
const rt = { id: 7, sourceRoomId: 501, operatorIds: [12], mealTypes: null, sortOrder: 0, badge: 'Totus', packageTypes: ['hotel'], rule: normalizeRule({ ruleType: 'percent', ruleValue: -10 }, {}), content: { nameRu: 'Deluxe Sea View', images: [{ source: 'upload', url: '/uploads/rooms/a.jpg' }], facilities: ['Балкон'] } };
const picked = inject.pickSourceOffers(ltRoom, rt);
assert.strictEqual(picked.length, 2, 'только Arlekino: AI и UAI');
const v = inject.makeVirtualOffer(picked[0].offer, rt, 'AI', 1, finalPrice(96500, rt.rule));
assert.ok(inject.isVirtualOfferId(v.id), 'виртуальный id');
assert.strictEqual(v.price, 86850); assert.strictEqual(v.operator_name, 'Arlekino'); assert.strictEqual(v.price_per_night, 12407); assert.strictEqual(v.extras.cheap, false);
assert.strictEqual(v.lt_extras.totus.sourceOfferId, '9001');
assert.strictEqual(inject.isVirtualOfferId('9001'), false);
const vroom = inject.buildVirtualRoom(ltRoom, rt, 'Totus');
assert.strictEqual(vroom.ID, 'totus-7'); assert.strictEqual(vroom.room.name_ru, 'Deluxe Sea View'); assert.strictEqual(vroom.room.images[0].x900, '/uploads/rooms/a.jpg');
assert.strictEqual(vroom.room.facilities[0].name, 'Балкон'); assert.strictEqual(vroom.room.id, 10000007);
vroom.offers = { AI: [v] }; vroom.meal_types = [{ id: 'AI', min_price: 0 }];
inject.recomputeRoomMins(vroom);
assert.strictEqual(vroom.min_price, 86850); assert.strictEqual(vroom.meal_types[0].min_price, 86850);
const rtMeals = { ...rt, mealTypes: ['UAI'] };
assert.strictEqual(inject.pickSourceOffers(ltRoom, rtMeals).length, 1, 'ограничение по питанию');

// --- переписывание цен пакета/заказа --------------------------------------------
const pkg = { success: true, package: { id: 555, price: 96500, fuel_charge: 1200, hotel: { price: 96500, name: 'Rixos' }, extras: [{ price: 3000 }] }, full_price: 96500 };
const rw = flow.rewritePrices(pkg, 96500, 86850);
assert.strictEqual(rw.package.price, 86850); assert.strictEqual(rw.full_price, 86850); assert.strictEqual(rw.package.hotel.price, 86850);
assert.strictEqual(rw.package.extras[0].price, 3000, 'другие суммы не трогаем'); assert.strictEqual(rw.package.fuel_charge, 1200);
assert.strictEqual(pkg.package.price, 96500, 'исходный объект не мутируется');
assert.strictEqual(flow.extractProviderPrice(pkg), 96500);
assert.strictEqual(flow.extractPackageId(pkg), '555');
assert.strictEqual(flow.extractProviderPrice({ order: { package: { price: '99000' } } }), 99000);
assert.strictEqual(flow.packageIdFromReq({ query: { package_id: 5 }, body: {} }), '5');
assert.strictEqual(flow.packageIdFromReq({ query: {}, body: { package: { id: 6 } } }), '6');
assert.strictEqual(flow.orderIdFromReq({ params: {}, query: {}, body: { orderId: 'ORDER48311' } }), '48311');
const strPrices = flow.rewritePrices({ order: { full_price: '96500', remaining_amount: 96500, total: 1 } }, 96500, 86850);
assert.strictEqual(strPrices.order.full_price, '86850'); assert.strictEqual(strPrices.order.remaining_amount, 86850); assert.strictEqual(strPrices.order.total, 1);

// --- middleware: наблюдаемые пути ----------------------------------------------
for (const p2 of ['/start-search', '/hotels-rooms', '/packages/package_details', '/packages/actualize', '/orders/prebuild', '/packages/prebook', '/packages/flights', '/create-package', '/vtb/create-order', '/orders', '/orders/48311/payment', '/user/orders', '/client/orders', '/client/orders/48311',
    '/check_pay', '/client/orders/900000012/sync', '/level_travel/notify-paid', '/payment/status']) {
    assert.ok(mw.WATCHED.test(p2), `watched ${p2}`);
}
for (const p2 of ['/grouped-hotels', '/references/hotels', '/api/admin/rooms/room-types', '/orders/documents', '/vtb/callback', '/tours/level_travel/notify']) {
    assert.ok(!mw.WATCHED.test(p2), `not watched ${p2}`);
}

// --- бронирования без Level.Travel ---------------------------------------------------
assert.strictEqual(bookings.orderIdOf(12), '900000012');
assert.ok(bookings.isInternalOrderId('900000012') && bookings.isInternalOrderId('ORDER900000012'));
assert.ok(!bookings.isInternalOrderId('48311') && !bookings.isInternalOrderId('900000000') && !bookings.isInternalOrderId('abc'));
assert.strictEqual(bookings.money(86850), '86 850 ₽');
assert.strictEqual(bookings.money(1234567.4), '1 234 567 ₽');
assert.deepStrictEqual(bookings.extractContact({ client: { name: 'Иван', surname: 'Петров', email: 'i@x.ru', phone: '+7 (900) 111-22-33' } }), { name: 'Иван', surname: 'Петров', email: 'i@x.ru', phone: '79001112233' });
assert.strictEqual(bookings.extractContact({ email: 'a@b.c' }).phone, null);

// снимок пакета → поля бронирования (даты LT в обоих форматах, ночи → check_out)
const snapshot = { success: true, package: { id: 555, price: 86850, hotel: { id: 123, name: 'Rixos Premium', stars: 5, city: { name_ru: 'Белек' }, country: { name_ru: 'Турция' } }, dates_info: { start_date: '12.10.2026', nights_count: 7 }, adults_count: 2, kids_count: 0, meal: { id: 'AI', name_ru: 'Всё включено' }, operator: { id: 12, name: 'Arlekino' } }, totus_room: { roomTypeId: 7, providerPrice: 96500, finalPrice: 86850 } };
const map = { ltPackageId: '555', roomTypeId: 7, virtualOfferId: 't7-1-abc', sourceOfferId: '9001', operatorName: 'Arlekino', providerPrice: 96500, finalPrice: 86850, rule: { type: 'percent', value: -10 }, hotelId: 123, meal: 'AI', snapshot };
const fields = bookings.extractBookingFields({ snapshot, map, rt, payload: { tourists: [{ name: 'A' }, { name: 'B' }] } });
assert.strictEqual(fields.checkIn, '2026-10-12'); assert.strictEqual(fields.checkOut, '2026-10-19'); assert.strictEqual(fields.nights, 7);
assert.strictEqual(fields.adults, 2); assert.strictEqual(fields.kids, 0); assert.strictEqual(fields.hotelName, 'Rixos Premium'); assert.strictEqual(fields.hotelCity, 'Белек'); assert.strictEqual(fields.hotelCountry, 'Турция');
assert.strictEqual(fields.meal, 'AI'); assert.strictEqual(fields.mealName, 'Всё включено'); assert.strictEqual(fields.operatorName, 'Arlekino'); assert.strictEqual(fields.operatorId, 12); assert.strictEqual(fields.roomName, 'Deluxe Sea View');
const f2 = bookings.extractBookingFields({ snapshot: { package: { start_date: '2026-10-12', nights_count: 3 } }, map: { meal: 'HB' }, rt: null, payload: { tourists: [{ name: 'A' }, { name: 'B', age: 5 }] } });
assert.strictEqual(f2.checkOut, '2026-10-15'); assert.strictEqual(f2.adults, 1); assert.strictEqual(f2.mealName, 'Завтрак и ужин'); assert.strictEqual(f2.operatorName, 'Arlekino');

// синтез ответа prebuild/prebook/flights из снимка (LT не вызывается)
const synth = flow.synthesizePackageStep(map);
assert.strictEqual(synth.success, true); assert.strictEqual(synth.package.price, 86850); assert.strictEqual(synth.package.id, 555);
assert.deepStrictEqual(synth.totus_booking, { internal: true, operator: 'Arlekino' }); assert.strictEqual(synth.totus_room.finalPrice, 86850); assert.strictEqual(synth.totus_room.priceChanged, null);
assert.strictEqual(flow.synthesizePackageStep({ ...map, snapshot: null }), null, 'без снимка → offer_expired');
assert.strictEqual(vtbCheck.resolveVtbPayStatus({ state: 'ACWP' }), 'RECONCILED');
assert.strictEqual(vtbCheck.resolveVtbPayStatus({ data: { status: { value: 'RECONCILED' } } }), 'RECONCILED');
assert.strictEqual(vtbCheck.resolveVtbPayStatus({ status: { value: 'IN_PROGRESS' } }), 'IN_PROGRESS');
assert.strictEqual(vtbCheck.resolveVtbPayStatus({}), 'PENDING');

// serialize → totus_booking (§3)
const rowBase = { id: 12, order_id: '900000012', user_id: 5, room_type_id: 7, hotel_id: 123, hotel_name: 'Rixos Premium', hotel_stars: 5, hotel_city: 'Белек', room_name: 'Deluxe Sea View', operator_name: 'Arlekino', meal: 'AI', meal_name: 'Всё включено', check_in: '2026-10-12', check_out: '2026-10-19', nights: 7, adults: 2, kids: 0, contact_json: '{"name":"Иван","surname":"Петров","email":"i@x.ru","phone":"79001112233"}', provider_price: '96500.00', final_price: '86850.00', price_rule: '{"type":"percent","value":-10}', payment_status: 'paid', paid_at: '2026-09-10T14:20:00Z', paid_amount: '86850.00', status: 'pending_confirmation', created_at: '2026-09-10T14:00:00Z' };
let tb = bookings.serialize(bookings.fromRow(rowBase));
assert.strictEqual(tb.internal, true); assert.strictEqual(tb.bookingId, 12); assert.strictEqual(tb.orderId, '900000012'); assert.strictEqual(tb.operator, 'Arlekino');
assert.strictEqual(tb.statusLabel, 'Проверяем бронирование'); assert.strictEqual(tb.statusText, 'Оплачено 86 850 ₽. Подтвердим бронирование и пришлём ваучер.');
assert.strictEqual(tb.paidAmount, 86850); assert.strictEqual(tb.paidAt, '2026-09-10T14:20:00.000Z'); assert.strictEqual(tb.refund, null); assert.strictEqual(tb.voucher, null);
assert.deepStrictEqual(tb.hotel, { id: 123, name: 'Rixos Premium', stars: 5, city: 'Белек' }); assert.strictEqual(tb.room, 'Deluxe Sea View'); assert.strictEqual(tb.mealName, 'Всё включено');
assert.strictEqual(tb.checkIn, '2026-10-12'); assert.strictEqual(tb.nights, 7); assert.strictEqual(tb.providerPrice, 96500); assert.strictEqual(tb.finalPrice, 86850);
assert.deepStrictEqual(tb.priceRule, { type: 'percent', value: -10, label: '−10 %' });
assert.ok(!('customer' in tb) && !('contact' in tb), 'в totus_booking нет ПД');
const adm = bookings.serializeAdmin(bookings.fromRow(rowBase));
assert.deepStrictEqual(adm.customer, { name: 'Иван Петров', phone: '79001112233', email: 'i@x.ru' });
tb = bookings.serialize(bookings.fromRow({ ...rowBase, status: 'rejected', payment_status: 'refund_pending', reject_reason: 'no_availability', refund_amount: '86850.00', refund_method: 'manual', refund_status: 'pending' }));
assert.strictEqual(tb.statusLabel, 'Бронирование отклонено'); assert.strictEqual(tb.rejectReasonLabel, 'Нет мест на эти даты');
assert.strictEqual(tb.statusText, 'Бронирование отклонено: Нет мест на эти даты. Возврат 86 850 ₽ выполним вручную в течение 1–3 дней.');
assert.deepStrictEqual(tb.refund, { amount: 86850, method: 'manual', status: 'pending', at: null });
tb = bookings.serialize(bookings.fromRow({ ...rowBase, status: 'confirmed', hotel_booking_ref: 'HTL-7781', voucher_url: 'https://api.totus.club/uploads/vouchers/v.pdf', voucher_sent_at: '2026-09-11T10:00:00Z' }));
assert.strictEqual(tb.statusLabel, 'Бронирование подтверждено'); assert.strictEqual(tb.hotelBookingRef, 'HTL-7781');
assert.deepStrictEqual(tb.voucher, { url: 'https://api.totus.club/uploads/vouchers/v.pdf', title: 'Ваучер', sentAt: '2026-09-11T10:00:00.000Z' });
assert.strictEqual(tb.statusText, 'Номер брони HTL-7781. Ваучер — в документах заказа.');

// письма: чистая сборка (без отправки), подпись Arlekino Tour, без «15 минут»
{
    const b = bookings.fromRow(rowBase);
    const mail = bookingEmails.buildEmail({ b, name: 'Иван', title: 'Тест', subject: 'S', paragraphs: ['Абзац'], buttonLabel: 'Кнопка', buttonUrl: 'https://totus.club' });
    assert.ok(mail.html.includes('Arlekino Tour') && mail.text.includes('Arlekino Tour'));
    assert.ok(mail.text.includes('Отель: Rixos Premium, 5★, Белек') && mail.text.includes('Даты: 12.10.2026 — 19.10.2026 (7 ночей)') && mail.text.includes('Гости: 2 взрослых'));
    assert.ok(!mail.text.includes('15 минут'));
    assert.strictEqual(bookingEmails.summaryRows(b).find(([k]) => k === 'Стоимость')[1], '86 850 ₽');
}

// статусные переходы на фейковой БД (уведомления выключены)
async function bookingChecks() {
    fakeDb.row = null; fakeDb.events = []; fakeDb.orders = [];
    const created = await bookings.create({ map, rt: { ...rt, hotelId: 123, hotelName: 'Rixos Premium', hotelStars: 5, hotelCity: 'Белек', sourceRoomName: 'Deluxe Room Sea View', operatorIds: [12], operatorNames: ['Arlekino'] }, payload: { client: { name: 'Иван', surname: 'Петров', email: 'i@x.ru', phone: '+79001112233' }, tourists: [{ name: 'A' }, { name: 'B' }] }, userId: 5 });
    const b0 = created.booking;
    assert.strictEqual(b0.orderId, '900000012'); assert.strictEqual(b0.status, 'pending_payment'); assert.strictEqual(b0.finalPrice, 86850); assert.strictEqual(b0.checkIn, '2026-10-12');
    assert.strictEqual(fakeDb.orders.length, 1, 'строка orders создана');
    const od = JSON.parse(fakeDb.orders[0].package);
    assert.strictEqual(od.id, 900000012); assert.strictEqual(od.full_price, 86850); assert.strictEqual(od.remaining_amount, 86850); assert.strictEqual(od.package.price, 86850);
    assert.strictEqual(od._customer_email, 'i@x.ru'); assert.strictEqual(od._customer_phone, '79001112233'); assert.deepStrictEqual(od._totus_booking, { internal: true, operator: 'Arlekino', bookingId: 12 });
    assert.strictEqual(created.orderData.state, 'pending_payment');
    assert.deepStrictEqual(fakeDb.events.map((e) => e.type), ['created']);
    assert.strictEqual(await bookings.isInternalOrder('900000012'), true);
    assert.strictEqual(await bookings.isInternalOrder('48311'), false);
    assert.strictEqual((await bookings.getByOrderIds(['48311', '900000012'])).size, 1);

    // до оплаты подтверждать нельзя
    let r = await bookings.confirm(12, { notify: false }, { id: 1, name: 'Admin' });
    assert.strictEqual(r.error, 'invalid_status'); assert.strictEqual(r.status, 'pending_payment');
    // оплата (идемпотентно)
    let b = await bookings.onPaid('ORDER900000012', 86850, { notify: false, source: 'check_pay' });
    assert.strictEqual(b.status, 'pending_confirmation'); assert.strictEqual(b.paymentStatus, 'paid'); assert.strictEqual(b.paidAmount, 86850); assert.ok(b.paidAt);
    b = await bookings.onPaid('900000012', 86850, { notify: false });
    assert.strictEqual(fakeDb.events.filter((e) => e.type === 'paid').length, 1, 'повторный onPaid не дублирует');
    assert.strictEqual(await bookings.onPaid('48311', 1), null);
    // refund-done без возврата — 409
    r = await bookings.refundDone(12, {}, { id: 1, name: 'Admin' });
    assert.strictEqual(r.error, 'invalid_status');
    // отклонить с неверной причиной
    r = await bookings.reject(12, { reason: 'nope', notify: false }, { id: 1, name: 'Admin' });
    assert.strictEqual(r.error, 'reason_invalid');
    r = await bookings.reject(12, { reason: 'other', refundAmount: 999999, notify: false }, { id: 1, name: 'Admin' });
    assert.strictEqual(r.error, 'refund_amount_invalid');
    // подтвердить
    r = await bookings.confirm(12, { hotelBookingRef: 'HTL-7781', clientMessage: 'Ждём вас', notify: false }, { id: 1, name: 'Admin' });
    assert.ok(!r.error, r.error); b = r.booking;
    assert.strictEqual(b.status, 'confirmed'); assert.strictEqual(b.hotelBookingRef, 'HTL-7781'); assert.strictEqual(b.confirmedBy, 'Admin'); assert.ok(b.confirmedAt);
    r = await bookings.confirm(12, { notify: false }, { id: 1, name: 'Admin' });
    assert.strictEqual(r.error, 'invalid_status', 'повторное подтверждение — 409');
    r = await bookings.reject(12, { reason: 'other', notify: false }, { id: 1, name: 'Admin' });
    assert.strictEqual(r.error, 'invalid_status', 'reject только из pending_confirmation');
    // ваучер
    r = await bookings.attachVoucher(12, { filename: 'voucher-b12-1.pdf', size: 1000 }, { id: 1, name: 'Admin' });
    assert.ok(!r.error); assert.strictEqual(r.booking.voucherPath, 'uploads/vouchers/voucher-b12-1.pdf'); assert.ok(r.booking.voucherUrl.endsWith('/uploads/vouchers/voucher-b12-1.pdf'));
    assert.strictEqual(bookings.serialize(r.booking).voucher.title, 'Ваучер');
    // отмена подтверждённого с частичным возвратом, «возврат уже выполнен»
    r = await bookings.cancel(12, { reason: 'price_changed', message: 'Извините', refundAmount: 50000, refundDone: true, notify: false }, { id: 2, name: 'Manager' });
    assert.ok(!r.error, r.error); b = r.booking;
    assert.strictEqual(b.status, 'cancelled'); assert.strictEqual(b.paymentStatus, 'partially_refunded'); assert.strictEqual(b.refundStatus, 'done'); assert.strictEqual(b.refundAmount, 50000); assert.strictEqual(b.refundBy, 'Manager'); assert.strictEqual(b.rejectReason, 'price_changed');
    assert.strictEqual(bookings.serialize(b).statusText, 'Бронирование отменено: Цена изменилась. Возврат 50 000 ₽ выполнен.');
    // второй сценарий: отклонение с ожидающим возвратом → refund-done
    fakeDb.row.status = 'pending_confirmation'; fakeDb.row.payment_status = 'paid'; fakeDb.row.refund_status = null; fakeDb.row.refund_amount = null;
    r = await bookings.reject(12, { reason: 'no_availability', notify: false }, { id: 1, name: 'Admin' });
    assert.ok(!r.error); b = r.booking;
    assert.strictEqual(b.status, 'rejected'); assert.strictEqual(b.paymentStatus, 'refund_pending'); assert.strictEqual(b.refundStatus, 'pending'); assert.strictEqual(b.refundAmount, 86850); assert.strictEqual(b.refundMethod, 'manual');
    r = await bookings.refundDone(12, { notify: false }, { id: 1, name: 'Admin' });
    assert.ok(!r.error); b = r.booking;
    assert.strictEqual(b.refundStatus, 'done'); assert.strictEqual(b.paymentStatus, 'refunded'); assert.ok(b.refundAt);
    r = await bookings.refundDone(12, { notify: false }, { id: 1, name: 'Admin' });
    assert.strictEqual(r.error, 'invalid_status', 'повторный refund-done — 409');
    r = await bookings.comment(12, 'Позвонили клиенту', { id: 1, name: 'Admin' });
    assert.strictEqual(r.booking.staffComment, 'Позвонили клиенту');
    const types = (await bookings.listEvents(12)).map((e) => e.type);
    for (const t of ['created', 'paid', 'confirmed', 'voucher_uploaded', 'cancelled', 'refund_done', 'rejected', 'comment']) assert.ok(types.includes(t), `событие ${t}`);
    // afterOrders: внутренний заказ получает totus_booking + order_state
    const orderRow = { order_id: '900000012', custom_room_type_id: 7, provider_price: 96500, final_price: 86850, package: { full_price: 96500 } };
    const dbQ = dbMod.query;
    dbMod.query = (sql, args) => (/custom_room_type_id IS NOT NULL/.test(sql) ? Promise.resolve([[orderRow]]) : dbQ(sql, args));
    const list = await flow.afterOrders([orderRow, { order_id: '48311', package: { full_price: 100 } }]);
    dbMod.query = dbQ;
    assert.strictEqual(list[0].totus_booking.internal, true); assert.strictEqual(list[0].totus_booking.orderId, '900000012'); assert.strictEqual(list[0].order_state, 'rejected'); assert.strictEqual(list[0].package.full_price, 86850);
    assert.strictEqual(list[1].totus_booking, undefined);
    // internalOrders: не наш заказ → middleware зовёт next()
    assert.strictEqual(await internal.resolveInternalOrder({ orderId: 'ORDER48311' }), null);
    assert.strictEqual(await internal.skipLtNotify({ body: { order_id: '48311' }, path: '/payment/status' }, {}), false);
    assert.strictEqual(await internal.clientOrder({}, {}, '48311', {}), false);
    const sent = [];
    const res = { status(c) { this.code = c; return this; }, json(b) { sent.push([this.code, b]); this.headersSent = true; return this; } };
    assert.strictEqual(await internal.skipLtNotify({ body: { order_id: 'ORDER900000012' }, path: '/level_travel/notify-paid' }, res), true);
    assert.deepStrictEqual(sent[0], [200, { success: true, skipped: 'internal_order', order_id: '900000012' }]);
}
// wrapJson: ошибка трансформации → оригинальный ответ; 4xx не трогаем
{
    const sent = [];
    const res = { statusCode: 200, json: (b) => { sent.push(b); return res; } };
    mw.wrapJson(res, async () => { throw new Error('boom'); });
    res.json({ a: 1 });
    setTimeout(() => {
        assert.deepStrictEqual(sent, [{ a: 1 }], 'при ошибке отдаём оригинал');
        const sent2 = [];
        const res2 = { statusCode: 500, json: (b) => { sent2.push(b); return res2; } };
        mw.wrapJson(res2, async () => ({ b: 2 }));
        res2.json({ err: 1 });
        setTimeout(() => {
            assert.deepStrictEqual(sent2, [{ err: 1 }], '4xx/5xx не трансформируем');
            bookingChecks().then(() => {
                console.log('ALL CUSTOM ROOMS CHECKS PASSED');
                process.exit(0);
            }).catch((e) => { console.error(e); process.exit(1); });
        }, 10);
    }, 10);
}

// Express 5: подмена query через req.url
{
    const req = { url: '/packages/package_details?request_id=abc&tour_id=t7-1-x', query: {} };
    flow.setQueryParam(req, 'tour_id', '9001');
    assert.strictEqual(req.url, '/packages/package_details?request_id=abc&tour_id=9001');
}
