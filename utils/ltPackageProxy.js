'use strict';

/**
 * Шаги бронирования через Level.Travel: таймауты, понятная ошибка и выбранный перелёт.
 *
 * Раньше /packages/actualize и /packages/package_details ходили в LT голым axios без таймаута:
 * завис оператор — запрос висел, пока его не обрывал прокси, а любая ошибка превращалась в
 * 500 «Failed to start search» без причины. Теперь:
 *   - у каждого шага свой таймаут (LT_STEP_TIMEOUT_MS) — меньше 60 с прокси перед API;
 *   - ответ об ошибке сохраняет прежнее поле error (старые клиенты не меняются) и добавляет
 *     code / message / status / lt — сайт показывает понятный текст и отличает «тур продан»
 *     от «LT не ответил»;
 *   - POST /packages/flights?view=pair&flight_pair_id=… — только выбранный перелёт (страница
 *     бронирования берёт из него топливный сбор): вместо 12 МБ списка — один рейс.
 */

const LT_STEP_TIMEOUT_MS = Object.freeze({
    actualize: 45000,
    packageDetails: 30000,
    prebuild: 45000,
    validateTourists: 30000,
});

/** Как axios сообщает о таймауте (ECONNABORTED / ETIMEDOUT / «timeout of … exceeded»). */
function isTimeoutError(error) {
    const code = String(error?.code || '');
    if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') return true;
    return /timeout of \d+ms exceeded/i.test(String(error?.message || ''));
}

/** Сеть до LT недоступна (DNS, соединение сброшено) — ответа нет вовсе. */
function isNetworkError(error) {
    if (error?.response) return false;
    return /^(ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH)$/.test(String(error?.code || ''));
}

function ltMessage(data) {
    if (data == null) return '';
    if (typeof data === 'string') return data.slice(0, 300);
    if (typeof data !== 'object') return String(data);
    const pick = data.message || data.error || (Array.isArray(data.errors) ? data.errors.join(', ') : '');
    if (typeof pick === 'string') return pick.slice(0, 300);
    if (pick && typeof pick === 'object') return ltMessage(pick);
    return '';
}

/**
 * Ответ клиенту при сбое шага LT.
 * error — прежняя строка (обратная совместимость), code — для клиента:
 *   lt_timeout (504) — LT не ответил вовремя; lt_unreachable (502) — нет связи с LT;
 *   lt_error (статус LT) — LT ответил ошибкой; internal (500) — сбой у нас.
 */
function ltStepErrorResponse(error, fallbackError) {
    const fallback = fallbackError || 'Failed to start search';
    if (isTimeoutError(error)) {
        return { status: 504, body: { success: false, error: fallback, code: 'lt_timeout', message: 'Level.Travel не ответил вовремя' } };
    }
    if (isNetworkError(error)) {
        return { status: 502, body: { success: false, error: fallback, code: 'lt_unreachable', message: 'Нет связи с Level.Travel' } };
    }
    const status = Number(error?.response?.status) || 0;
    if (status >= 400) {
        const data = error.response.data;
        const body = { success: false, error: fallback, code: 'lt_error', status, message: ltMessage(data) || `Level.Travel ответил ${status}` };
        if (data && typeof data === 'object' && !Array.isArray(data)) body.lt = data;
        return { status, body };
    }
    return { status: 500, body: { success: false, error: fallback, code: 'internal', message: String(error?.message || 'internal error').slice(0, 300) } };
}

/**
 * ?view=pair&flight_pair_id=… — из полного ответа LT оставить только выбранный перелёт.
 * Форма ответа та же ({ success, flights: [...] }), поэтому старый код поиска рейса по
 * flight_pair_id работает без изменений. Перелёт не найден — flights: [] и found: false.
 */
function pickFlightPair(body, flightPairId) {
    if (!body || typeof body !== 'object') return body;
    const pairId = String(flightPairId == null ? '' : flightPairId);
    const flights = Array.isArray(body.flights) ? body.flights : [];
    const selected = pairId ? flights.find((f) => f && String(f.flight_pair_id) === pairId) : undefined;
    const out = {};
    if ('success' in body) out.success = body.success;
    if (body.error !== undefined) out.error = body.error;
    out.flights = selected ? [selected] : [];
    out.found = Boolean(selected);
    out.total_flights = flights.length;
    out.pair_view = true;
    return out;
}

function firstQueryValue(value) {
    return Array.isArray(value) ? value[0] : value;
}

module.exports = {
    LT_STEP_TIMEOUT_MS,
    isTimeoutError,
    isNetworkError,
    ltStepErrorResponse,
    pickFlightPair,
    firstQueryValue,
};
