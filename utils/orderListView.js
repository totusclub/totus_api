'use strict';

/**
 * Лёгкий список заказов для экрана «Заказы» в приложении: GET /user/orders?view=list.
 *
 * Полный ответ /user/orders отдаёт по каждому заказу весь пакет Level.Travel (описание отеля,
 * перелёты, вложения, история…) — у пользователя с десятком заказов это мегабайты JSON, которые
 * сервер копирует несколько раз (документы, подпись ссылок, custom rooms), а клиент качает и
 * разбирает дольше минуты. Карточке списка нужно ~20 полей — их и отдаём.
 * Подробности заказа приложение по-прежнему берёт из GET /orders?order_id (полный пакет).
 *
 * Без параметра view ответ /user/orders прежний (сайт, desktop, старые версии приложения).
 * Поля — по коду карточек totus_APP (OrderListItem, ordersUtils, totusBooking) и totus_WEB
 * (profile/orderItem, OrderSbpPayButton, orderDisplay, orderPayment, packagePrice):
 *   pkg = package.package || package; lt = package;
 *   hotel.{name,city,country}, dates_info, departure.{name_ru,name_en,name}, nights_count,
 *   price / full_price, created_at, state, tourists[].{name,surname}, status_for_client,
 *   is_paid, payment_methods[].{type,enable}, totus_booking / _totus_booking, last_lt_event.{status,state,event}.
 */

const PACKAGE_KEYS = [
    'id', 'order_id', 'state', 'status', 'status_for_client', 'is_paid',
    'full_price', 'remaining_amount', 'price', 'currency',
    // сайт: сумма СБП в карточке (orderPayment.getOrderPayAmount) и назначение платежа
    'net_price', 'fuel_charge', 'predicted_surcharge', '_pay_amount', 'description_for_client',
    'created_at', 'createdAt', 'c_date', 'nights_count', 'nights', 'dates_info',
    'pansion_description', 'room_type',
    'totus_booking', '_totus_booking',
];
const ROW_SKIP = new Set(['package', 'lt_auth_token']);

function pick(obj, keys) {
    const out = {};
    for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) out[key] = obj[key];
    }
    return out;
}

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
}

function slimHotel(hotel) {
    if (!isPlainObject(hotel)) return hotel;
    return pick(hotel, ['id', 'name', 'city', 'country', 'stars']);
}

function slimDeparture(departure) {
    if (!isPlainObject(departure)) return departure;
    return pick(departure, ['id', 'name', 'name_ru', 'name_en']);
}

function slimTourists(tourists) {
    if (!Array.isArray(tourists)) return tourists;
    return tourists
        .filter((t) => isPlainObject(t))
        .map((t) => pick(t, ['id', 'name', 'surname']));
}

function slimPaymentMethods(methods) {
    if (!Array.isArray(methods)) return methods;
    return methods
        .filter((m) => isPlainObject(m))
        .map((m) => pick(m, ['type', 'enable']));
}

/** Пакет заказа → только поля карточки; вложенный package.package — так же, один уровень. */
function slimPackage(pkg, depth = 0) {
    if (!isPlainObject(pkg)) return pkg;
    const out = pick(pkg, PACKAGE_KEYS);
    if ('hotel' in pkg) out.hotel = slimHotel(pkg.hotel);
    if ('departure' in pkg) out.departure = slimDeparture(pkg.departure);
    if ('tourists' in pkg) out.tourists = slimTourists(pkg.tourists);
    if ('payment_methods' in pkg) out.payment_methods = slimPaymentMethods(pkg.payment_methods);
    if (depth === 0 && isPlainObject(pkg.package)) out.package = slimPackage(pkg.package, 1);
    return out;
}

function parsePackage(value) {
    if (isPlainObject(value)) return value;
    if (typeof value !== 'string' || !value) return {};
    try {
        const parsed = JSON.parse(value);
        return isPlainObject(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

/** Date → ISO-строка (иначе подпись ссылок превращает Date в {}). */
function plainValue(v) {
    return v instanceof Date ? (Number.isFinite(v.getTime()) ? v.toISOString() : null) : v;
}

function slimLastEvent(event) {
    if (!event) return null;
    return {
        id: event.id,
        order_id: event.order_id,
        event: event.event,
        state: event.state,
        status: event.status,
        created_at: plainValue(event.created_at),
    };
}

/** Строка orders (+ последнее событие LT) → элемент лёгкого списка. */
function toListItem(row, lastEvent) {
    const out = {};
    for (const [key, value] of Object.entries(row || {})) {
        if (ROW_SKIP.has(key)) continue;
        out[key] = plainValue(value);
    }
    out.package = slimPackage(parsePackage(row && row.package));
    out.last_lt_event = slimLastEvent(lastEvent);
    out.list_view = true;
    return out;
}

module.exports = { toListItem, slimPackage, PACKAGE_KEYS };
