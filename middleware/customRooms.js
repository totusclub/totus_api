'use strict';

/**
 * Middleware наших Room Type (план claude/CUSTOM_ROOMS_PLAN_RU.md §3, §6).
 * Подключается ОДНОЙ строкой в app.js ДО прокси-маршрутов Level.Travel:
 *     app.use(require('./middleware/customRooms'));
 * Сами прокси не меняются: middleware правит запрос до обработчика (tour_id, суммы платежей)
 * и оборачивает res.json, чтобы переписать ответ LT перед отправкой. Любая ошибка нашей
 * логики → в лог, клиент получает оригинальный ответ.
 *
 * Бронирования без Level.Travel (бриф §2): для пакетов из карты custom_room_package_map middleware
 * отвечает САМ (без next()) на prebuild/prebook/flights (снимок пакета) и create-package (заказ у нас);
 * для внутренних заказов (order_id > 900000000) — на check_pay (VTB без LT notify), client/orders/:id,
 * client/orders/:id/sync, level_travel/notify-paid, payment/status. LT для них не вызывается нигде.
 */

const store = require('../lib/customRooms/store');
const diag = require('../lib/customRooms/diag');
const { injectRooms } = require('../lib/customRooms/inject');
const flow = require('../lib/customRooms/packageFlow');
const internal = require('../lib/customRooms/internalOrders');

const SEARCH_TYPE_HOTEL_CODES = String(process.env.CUSTOM_ROOMS_HOTEL_SEARCH_TYPE_CODES || '2').split(',').map((s) => s.trim());

function wrapJson(res, transform) {
    const orig = res.json.bind(res);
    let done = false;
    res.json = function patchedJson(body) {
        if (done) return orig(body);
        done = true;
        // Не трогаем ошибки LT (4xx/5xx)
        if (res.statusCode >= 400) return orig(body);
        Promise.resolve()
            .then(() => transform(body))
            .then((out) => orig(out === undefined ? body : out))
            .catch((e) => { console.error('[custom-rooms] response transform failed:', e && e.message); orig(body); });
        return res;
    };
}

function searchTypeOf(q) {
    const st = String((q && (q.search_type || q.searchType)) || '').toLowerCase();
    if (st === 'hotel' || st === 'package') return st;
    return null;
}

async function handle(req, res, next) {
    const method = req.method;
    const path = req.path || '';
    const q = req.query || {};

    // /start-search: запоминаем тип поиска по request_id (нужен для /hotels-rooms)
    if (method === 'GET' && path === '/start-search') {
        const st = searchTypeOf(q);
        diag.bump('startSearchSeen', { lastStartSearchAt: new Date().toISOString() });
        wrapJson(res, async (body) => {
            const rid = body && (body.request_id || (body.search && body.search.request_id) || body.id);
            if (rid) await store.rememberSearch(rid, st || 'package', { from_city: q.from_city, to_country: q.to_country, start_date: q.start_date, nights: q.nights, adults: q.adults, kids: q.kids });
            else diag.log(`start-search: no request_id in LT response (keys: ${Object.keys(body || {}).join(',')})`);
            return body;
        });
        return next();
    }

    if (method === 'GET' && path === '/hotels-rooms') {
        const requestId = q.request_id;
        const hotelId = q.hotel_id;
        if (!requestId || !hotelId) return next();
        wrapJson(res, async (body) => {
            const search = await store.getSearch(requestId);
            let searchType = search ? search.searchType : null;
            if (!searchType && body && body.search_type !== undefined) {
                searchType = SEARCH_TYPE_HOTEL_CODES.includes(String(body.search_type)) ? 'hotel' : 'package';
            }
            diag.bump('hotelsRoomsSeen', { lastHotelsRoomsAt: new Date().toISOString(), lastHotelsRoomsHotelId: String(hotelId), lastHotelsRoomsSearchType: searchType || null });
            try {
                return await injectRooms(body, { requestId, hotelId, searchType });
            } catch (e) {
                diag.bump('hotelsRoomsErrors');
                diag.error(`hotel ${hotelId}: inject failed`, e);
                throw e;
            }
        });
        return next();
    }

    if (method === 'GET' && path === '/packages/package_details') {
        const offer = await flow.beforePackageDetails(req);
        if (req.customRoomsError === 'offer_expired') {
            return res.status(410).json({ success: false, error: 'offer_expired', message: 'Предложение устарело — обновите список номеров' });
        }
        if (offer) wrapJson(res, (body) => flow.afterPackageDetails(body, offer));
        return next();
    }

    if (method === 'GET' && path === '/packages/actualize') {
        const map = await flow.beforePackageStep(req);
        if (map) wrapJson(res, (body) => flow.afterPackageStep(body, map));
        return next();
    }

    // Бронирование без Level.Travel: для пакета из карты prebuild/prebook/flights отвечаем сами (снимок пакета).
    if (method === 'POST' && (path === '/orders/prebuild' || path === '/packages/prebook' || path === '/packages/flights')) {
        const map = await flow.beforePackageStep(req);
        if (!map) return next();
        const synth = flow.synthesizePackageStep(map);
        if (!synth) return res.status(410).json({ success: false, error: 'offer_expired', message: 'Предложение устарело — выберите номер заново' });
        return res.status(200).json(synth);
    }

    // Бронирование без Level.Travel: заказ у нас (orders + custom_room_bookings), оплата VTB, LT /orders/create не вызывается.
    if (method === 'POST' && path === '/create-package') {
        const map = await flow.beforeCreatePackage(req);
        if (!map) return next();
        return internal.createPackage(req, res, map);
    }

    if (method === 'POST' && path === '/check_pay') {
        if (await internal.checkPay(req, res)) return;
        return next();
    }

    if (method === 'POST' && (path === '/level_travel/notify-paid' || path === '/payment/status')) {
        if (await internal.skipLtNotify(req, res)) return;
        return next();
    }

    {
        const m = /^\/client\/orders\/([^/]+)(\/sync)?$/.exec(path);
        if (m && ((method === 'GET' && !m[2]) || (method === 'POST' && m[2]))) {
            if (await internal.clientOrder(req, res, decodeURIComponent(m[1]), { sync: Boolean(m[2]) })) return;
            if (method === 'POST') return next();
        }
    }

    if ((method === 'POST' && path === '/vtb/create-order') || (method === 'GET' && /^\/orders\/[^/]+\/payment$/.test(path))) {
        if (!req.params || !req.params.order_id) {
            const m = /^\/orders\/([^/]+)\/payment$/.exec(path);
            if (m) req.params = Object.assign({}, req.params || {}, { order_id: decodeURIComponent(m[1]) });
        }
        await flow.beforePayment(req);
        return next();
    }

    if (method === 'GET' && (path === '/orders' || path === '/user/orders' || path === '/client/orders' || /^\/client\/orders\/[^/]+$/.test(path))) {
        wrapJson(res, (body) => flow.afterOrders(body));
        return next();
    }

    return next();
}

const WATCHED = /^\/(start-search|hotels-rooms|packages\/(package_details|actualize|prebook|flights)|orders\/prebuild|create-package|check_pay|level_travel\/notify-paid|payment\/status|vtb\/create-order|orders(\/[^/]+\/payment)?|user\/orders|client\/orders(\/[^/]+(\/sync)?)?)$/;

function customRoomsMiddleware(req, res, next) {
    // счётчик любого запроса — признак, что app.use(require('./middleware/customRooms')) подключён в app.js
    diag.stats.middlewareCalls += 1;
    if (!WATCHED.test(req.path || '')) return next();
    diag.stats.watchedCalls += 1;
    store.isReady().then((ok) => {
        if (!ok) { diag.stats.notReadySkips += 1; return next(); }
        return handle(req, res, next);
    }).catch((e) => { diag.error('middleware failed', e); next(); });
}

// Проверка таблиц после старта + чистка карт раз в час
setTimeout(() => { store.ensureReady().catch(() => {}); }, 3000).unref();
const cleanupTimer = setInterval(() => { store.cleanup(); }, 3600 * 1000);
if (cleanupTimer.unref) cleanupTimer.unref();

module.exports = customRoomsMiddleware;
module.exports.WATCHED = WATCHED;
module.exports.wrapJson = wrapJson;
