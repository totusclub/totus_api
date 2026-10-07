'use strict';

/**
 * POST /packages/flights?view=list — лёгкий ответ для страницы билетов сайта.
 * Без БД и сети: node scripts/check-flights-list-view.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { toFlightsListView, slimFlight, slimFilters } = require('../utils/flightsListView');

let passed = 0;
function check(name, fn) {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
}

// Сегмент по примеру из документации LT (раздел «Получение перелетов по актуализированному пакету»).
const source = (id, kind) => ({ id, kind });
const segment = (code) => ({
    airline: {
        id: 56,
        logo: {
            src: 'https://s3.level.travel/partner_logos/airline/56/x3_56.png',
            srcset: 'https://s3.level.travel/partner_logos/airline/56/x1_56.png 1x, https://s3.level.travel/partner_logos/airline/56/x2_56.png 2x, https://s3.level.travel/partner_logos/airline/56/x3_56.png 3x',
        },
        name: 'Победа',
        warning: true,
    },
    arrival: '2024-06-10T13:00:00.000+03:00',
    business: false,
    class: 'econom',
    departure: '2024-06-10T08:00:00.000+03:00',
    destination: { code, id: 676, name: 'Новый аэропорт Стамбула', timezone: 'Europe/Istanbul', city: { id: 11508, name: 'Стамбул' } },
    origin: { code: 'VKO', id: 9, name: 'Внуково', timezone: 'Europe/Moscow', city: { id: 213, name: 'Москва' } },
    direct: true,
    flight_id: 'RFAgOTkzfERQfFZLT3xJU1R8MTcxNzk5',
    flight_no: 'DP 993',
    fuel_charge: 0,
    blocked: false,
    type: 'regular',
    time: 18000,
    luggage: {
        hand: { count: 1, weight: 5, size: [36, 30, 27], count_source: source(78, 'supplier'), weight_source: source(37, 'standard'), size_source: source(37, 'standard') },
        hold: { count: 0, weight: 0, count_source: source(78, 'supplier'), weight_source: source(37, 'standard') },
    },
    segments: [{ some: 'heavy', nested: { deep: true } }],
});
const flight = (i) => ({ flight_pair_id: `pair-${i}`, fuel_charge: 1200 + i, direction: 'С пересадкой', tour_id: '078-7e12', to: segment('IST'), back: segment('VKO') });
const byTours = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`078-tour-${i}-7e1210891f00c6d2327feda7be49b152`, i]));
const option = (extra) => ({ suitable_flights: 115, min_fuel_charge: 0, min_fuel_charge_by_tours: byTours, disabled: false, selected: false, ...extra });
const ltBody = {
    success: true,
    flights: Array.from({ length: 130 }, (_, i) => flight(i)),
    filters: {
        transitions_count: [option({ number: 0 })],
        forward_airlines: [option({ id: 56, name: 'Победа' })],
        backward_airlines: [option({ id: 56, name: 'Победа' })],
        departure_airports: { cities: ['Москвы'], airports: [option({ id: 9, name: 'Внуково' })] },
        arrival_airports: { cities: ['Стамбула'], airports: [option({ id: 676, name: 'Новый аэропорт Стамбула' })] },
        forward_departure_intervals: [option({ interval: 'morning' })],
        luggage_types: [option({ luggage_type: 'hold' })],
        flight_classes: [option({ flight_class: 'econom' })],
        flight_types: [option({ flight_type: 'regular' })],
        operators: [option({ id: 78, name: 'Level.Travel' })],
        confirmability: [option({ id: 2, name: 'Быстрое подтверждение' })],
        instant_confirm: [option({ id: 1, name: 'Мгновенно', selected: true })],
    },
};

console.log('POST /packages/flights?view=list');

check('все поля, которые читает страница билетов, на месте (рейс, сегменты, багаж, аэропорты)', () => {
    const f = slimFlight(flight(3));
    assert.strictEqual(f.flight_pair_id, 'pair-3');
    assert.strictEqual(f.fuel_charge, 1203);
    assert.strictEqual(f.direction, 'С пересадкой');
    for (const seg of [f.to, f.back]) {
        assert.deepStrictEqual(seg.airline, { id: 56, name: 'Победа', logo: { src: 'https://s3.level.travel/partner_logos/airline/56/x3_56.png' } });
        for (const k of ['arrival', 'departure', 'direct', 'class', 'flight_no', 'blocked', 'type', 'time', 'business', 'flight_id', 'fuel_charge']) {
            assert.ok(k in seg, k);
        }
        assert.deepStrictEqual(seg.origin, { id: 9, code: 'VKO', name: 'Внуково', city: { id: 213, name: 'Москва' } });
        assert.strictEqual(seg.destination.city.name, seg === f.to ? 'Стамбул' : 'Стамбул');
        assert.deepStrictEqual(seg.luggage, { hand: { count: 1, weight: 5 }, hold: { count: 0, weight: 0 } });
    }
});

check('не уходит: srcset, источники багажа, размеры клади, часовые пояса, вложенные segments', () => {
    const json = JSON.stringify(slimFlight(flight(1)));
    for (const s of ['srcset', '_source', '"size"', 'timezone', 'segments', 'warning']) assert.ok(!json.includes(s), s);
});

check('фильтры: все группы и поля опций для подписи/значения/счётчика/цены; без min_fuel_charge_by_tours', () => {
    const f = slimFilters(ltBody.filters);
    assert.deepStrictEqual(Object.keys(f), Object.keys(ltBody.filters));
    assert.deepStrictEqual(f.forward_airlines[0], { id: 56, name: 'Победа', disabled: false, selected: false, suitable_flights: 115, min_fuel_charge: 0 });
    assert.strictEqual(f.luggage_types[0].luggage_type, 'hold');
    assert.strictEqual(f.flight_classes[0].flight_class, 'econom');
    assert.strictEqual(f.flight_types[0].flight_type, 'regular');
    assert.strictEqual(f.forward_departure_intervals[0].interval, 'morning');
    assert.strictEqual(f.transitions_count[0].number, 0);
    assert.deepStrictEqual(f.departure_airports.cities, ['Москвы']);
    assert.strictEqual(f.arrival_airports.airports[0].name, 'Новый аэропорт Стамбула');
    assert.strictEqual(f.instant_confirm[0].selected, true);
    assert.strictEqual(f.confirmability[0].id, 2);
    assert.ok(!JSON.stringify(f).includes('min_fuel_charge_by_tours'));
});

check('ответ: success сохранён, число и порядок рейсов те же; объём заметно меньше', () => {
    const view = toFlightsListView(ltBody);
    assert.strictEqual(view.success, true);
    assert.strictEqual(view.list_view, true);
    assert.deepStrictEqual(view.flights.map((x) => x.flight_pair_id), ltBody.flights.map((x) => x.flight_pair_id));
    const before = JSON.stringify(ltBody).length;
    const after = JSON.stringify(view).length;
    console.log(`       пример LT (130 рейсов): ${Math.round(before / 1024)} КБ → ${Math.round(after / 1024)} КБ (−${Math.round((1 - after / before) * 100)}%)`);
    assert.ok(after < before * 0.6);
});

check('необычные значения не ломают: null, пустой ответ, рейс без сегментов', () => {
    assert.strictEqual(toFlightsListView(null), null);
    assert.deepStrictEqual(toFlightsListView({ success: false, error: 'x' }), { success: false, error: 'x', list_view: true });
    assert.deepStrictEqual(slimFlight({ flight_pair_id: 'a', to: null }), { flight_pair_id: 'a', to: null });
    assert.deepStrictEqual(toFlightsListView({ flights: [], filters: null }).filters, null);
});

check('обработчик: ?view=list — лёгкий ответ, без параметра — прежний; в LT view не уходит', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    const start = src.indexOf("app.post('/packages/flights'");
    const handler = src.slice(start, src.indexOf('\n});', start));
    assert.match(handler, /if \(String\(req\.query\.view \|\| ''\) === 'list'\) \{[\s\S]*toFlightsListView\(response\.data\)[\s\S]*return res\.json\(body\);/);
    assert.match(handler, /res\.json\(response\.data\);/);
    assert.match(handler, /const raw = req\.body/);
    assert.ok(!/req\.query\.view[\s\S]*data\.view/.test(handler));
});

console.log(`\n${passed} passed`);
