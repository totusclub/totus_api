'use strict';

/**
 * Диагностика наших Room Type без доступа к логам сервера: счётчики в памяти процесса
 * (сколько запросов прошло через middleware, сколько /hotels-rooms обработано и с вставкой)
 * и кольцевой буфер последних строк `[custom-rooms] …`. Отдаётся в GET /api/admin/rooms/diagnostics.
 * Ничего не пишет в БД; при pm2 restart обнуляется (startedAt показывает, с какого момента считаем).
 */

const MAX_EVENTS = 40;

const stats = {
    startedAt: new Date().toISOString(),
    middlewareCalls: 0,        // любой запрос, дошедший до middleware (признак, что app.use подключён)
    watchedCalls: 0,           // запросы по наблюдаемым путям
    notReadySkips: 0,          // наблюдаемые запросы, пропущенные из-за DISABLED
    startSearchSeen: 0,
    hotelsRoomsSeen: 0,        // GET /hotels-rooms с request_id и hotel_id
    hotelsRoomsInjected: 0,    // ответов, в которые вставлена хотя бы одна наша комната
    hotelsRoomsErrors: 0,      // ошибок трансформации (клиент получил оригинал LT)
    lastStartSearchAt: null,
    lastHotelsRoomsAt: null,
    lastHotelsRoomsHotelId: null,
    lastHotelsRoomsSearchType: null,
    lastInjectAt: null,
    lastError: null,
};

const events = [];

function ts() { return new Date().toISOString(); }

/** console.log + запись в буфер. */
function log(line) {
    const msg = `[custom-rooms] ${line}`;
    console.log(msg);
    events.push({ at: ts(), line: msg });
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}

function error(line, e) {
    const msg = `[custom-rooms] ${line}${e && e.message ? `: ${e.message}` : ''}`;
    console.error(msg);
    stats.lastError = { at: ts(), message: msg };
    events.push({ at: ts(), line: msg, error: true });
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}

function bump(key, extra) {
    if (typeof stats[key] === 'number') stats[key] += 1;
    if (extra) Object.assign(stats, extra);
}

function snapshot() {
    return { ...stats, events: events.slice() };
}

module.exports = { stats, log, error, bump, snapshot, MAX_EVENTS };
