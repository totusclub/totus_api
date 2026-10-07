'use strict';

/**
 * Лёгкий ответ POST /packages/flights?view=list — для страницы билетов сайта.
 *
 * Level.Travel отдаёт по каждому рейсу много полей, которые страница не показывает:
 * srcset логотипа, «источники» данных багажа (count_source/weight_source/size_source),
 * размеры клади, часовые пояса, id городов/аэропортов, а в каждой опции фильтра — карту
 * min_fuel_charge_by_tours по всем турам. Здесь оставляем только то, что читают
 * TicketItem, TicketModalContent, SelectedTour, packagePrice и FiltersPackage/CheckboxGroup.
 *
 * Скалярные поля рейса и сегмента (даты, время, класс, номер рейса, тип, признаки) остаются все —
 * они дешёвые; режутся только вложенные объекты/массивы. Порядок рейсов и их число не меняются.
 * Без ?view=list ответ прежний (приложение, бронирование, оформление заказа).
 */

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function pick(obj, keys) {
    const out = {};
    if (!isPlainObject(obj)) return out;
    for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) out[key] = obj[key];
    }
    return out;
}

/** Только примитивы (строки, числа, булевы, null) — без вложенных объектов и массивов. */
function scalars(obj) {
    const out = {};
    if (!isPlainObject(obj)) return out;
    for (const [key, value] of Object.entries(obj)) {
        if (value === null || typeof value !== 'object') out[key] = value;
    }
    return out;
}

function slimAirline(airline) {
    if (!isPlainObject(airline)) return airline;
    const out = pick(airline, ['id', 'name']);
    if (isPlainObject(airline.logo)) out.logo = pick(airline.logo, ['src']);
    return out;
}

function slimPlace(place) {
    if (!isPlainObject(place)) return place;
    const out = pick(place, ['id', 'code', 'name']);
    if (isPlainObject(place.city)) out.city = pick(place.city, ['id', 'name']);
    return out;
}

function slimLuggage(luggage) {
    if (!isPlainObject(luggage)) return luggage;
    const out = {};
    for (const kind of ['hand', 'hold']) {
        if (isPlainObject(luggage[kind])) out[kind] = pick(luggage[kind], ['count', 'weight']);
    }
    return out;
}

function slimSegment(segment) {
    if (!isPlainObject(segment)) return segment;
    const out = scalars(segment);
    if ('airline' in segment) out.airline = slimAirline(segment.airline);
    if ('origin' in segment) out.origin = slimPlace(segment.origin);
    if ('destination' in segment) out.destination = slimPlace(segment.destination);
    if ('luggage' in segment) out.luggage = slimLuggage(segment.luggage);
    return out;
}

function slimFlight(flight) {
    if (!isPlainObject(flight)) return flight;
    const out = scalars(flight);
    if ('to' in flight) out.to = slimSegment(flight.to);
    if ('back' in flight) out.back = slimSegment(flight.back);
    return out;
}

// Поля опции фильтра, которые читает CheckboxGroup / FiltersPackage (подпись, значение, счётчик, цена).
const FILTER_OPTION_KEYS = [
    'id', 'name', 'disabled', 'selected',
    'suitable_flights', 'min_fuel_charge',
    'luggage_type', 'flight_class', 'flight_type', 'interval', 'number',
];

function slimOption(option) {
    return isPlainObject(option) ? pick(option, FILTER_OPTION_KEYS) : option;
}

function slimFilterValue(value) {
    if (Array.isArray(value)) return value.map(slimOption);
    if (isPlainObject(value)) {
        // departure_airports / arrival_airports: { cities: [...], airports: [...] }
        const out = {};
        for (const [key, inner] of Object.entries(value)) {
            out[key] = Array.isArray(inner) ? inner.map(slimOption) : inner;
        }
        return out;
    }
    return value;
}

function slimFilters(filters) {
    if (!isPlainObject(filters)) return filters;
    const out = {};
    for (const [key, value] of Object.entries(filters)) out[key] = slimFilterValue(value);
    return out;
}

/** Ответ LT → лёгкий ответ. Неизвестные верхнеуровневые поля (success и др.) сохраняются как есть. */
function toFlightsListView(body) {
    if (!isPlainObject(body)) return body;
    const out = { ...body };
    if (Array.isArray(body.flights)) out.flights = body.flights.map(slimFlight);
    if ('filters' in body) out.filters = slimFilters(body.filters);
    out.list_view = true;
    return out;
}

module.exports = { toFlightsListView, slimFlight, slimFilters, FILTER_OPTION_KEYS };
