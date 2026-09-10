// Проверка наших Room Type без БД и сети: node scripts/check-custom-rooms.js
// Правило цены, подмена номеров в выдаче LT, переписывание цен в пакете/заказе, маршруты middleware.
'use strict';
const assert = require('assert');
process.env.DB_HOST = process.env.DB_HOST || 'localhost';
process.env.JWT_SECRET = process.env.JWT_SECRET || 's1';

const { normalizeRule, finalPrice, ruleLabel } = require('../lib/customRooms/pricing');
const inject = require('../lib/customRooms/inject');
const flow = require('../lib/customRooms/packageFlow');
const mw = require('../middleware/customRooms');

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
for (const p2 of ['/start-search', '/hotels-rooms', '/packages/package_details', '/packages/actualize', '/orders/prebuild', '/packages/prebook', '/packages/flights', '/create-package', '/vtb/create-order', '/orders', '/orders/48311/payment', '/user/orders', '/client/orders', '/client/orders/48311']) {
    assert.ok(mw.WATCHED.test(p2), `watched ${p2}`);
}
for (const p2 of ['/grouped-hotels', '/references/hotels', '/api/admin/rooms/room-types', '/orders/documents', '/check_pay']) {
    assert.ok(!mw.WATCHED.test(p2), `not watched ${p2}`);
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
            console.log('ALL CUSTOM ROOMS CHECKS PASSED');
            process.exit(0);
        }, 10);
    }, 10);
}

// Express 5: подмена query через req.url
{
    const req = { url: '/packages/package_details?request_id=abc&tour_id=t7-1-x', query: {} };
    flow.setQueryParam(req, 'tour_id', '9001');
    assert.strictEqual(req.url, '/packages/package_details?request_id=abc&tour_id=9001');
}
