'use strict';

/**
 * Поиск через Level.Travel (/start-search, /search-status, /grouped-hotels): таймауты и понятная ошибка.
 * План claude/HOTEL_SEARCH_PROGRESSIVE_PLAN_RU.md, этап «сервер» (02.11.2026).
 *
 * Раньше три поисковых прокси ходили в LT голым axios без таймаута: завис LT — запрос висел, пока его
 * не обрывал прокси перед API; ошибка /start-search и /search-status превращалась в 500 без причины.
 * Теперь:
 *   - у каждого запроса свой таймаут (LT_SEARCH_TIMEOUT_MS). Сайт и приложение опрашивают статус
 *     каждые 2–6 с: один зависший ответ не должен держать опрос дольше 10 с;
 *   - ответ об ошибке сохраняет прежнее поле error (старые клиенты не меняются) и добавляет
 *     code / message / status / lt — как у шагов бронирования (utils/ltPackageProxy.js);
 *   - /grouped-hotels при ошибке LT отдаёт тело LT как раньше (sendLtAxiosError); новое только
 *     для таймаута: 504 с code lt_timeout (раньше тот же 504 отдавал nginx через 60 с).
 */

const { ltStepErrorResponse } = require('./ltPackageProxy');

const LT_SEARCH_TIMEOUT_MS = Object.freeze({
    enqueue: 15000,
    status: 10000,
    grouped: 20000,
});

/**
 * Ответ об ошибке /start-search и /search-status: { status, body } с прежним полем error.
 *
 * HTTP-статус для старых клиентов не меняется: раньше любая ошибка была 500, а зависший LT давал 504
 * от nginx через 60 с. Поэтому: таймаут — 504 (теперь через 10–15 с), всё остальное — 500, как было.
 * Настоящий статус LT — в body.status, причина — в body.code / body.message / body.lt.
 * Приложение (isStaleSearchRequestError) считает 500 «request_id устарел» и перезапускает поиск —
 * это поведение сохраняется.
 */
function searchErrorResponse(error, fallbackError) {
    const { status, body } = ltStepErrorResponse(error, fallbackError);
    if (status === 504) return { status, body };
    return { status: 500, body };
}

/** Короткая строка для лога: что за поиск, сколько ждали. */
function searchLogLine(kind, query, startedAt, extra = '') {
    const q = query || {};
    const ms = Date.now() - startedAt;
    const parts = [`[SEARCH] ${kind}`, `ms=${ms}`];
    if (q.request_id) parts.push(`rid=${String(q.request_id).slice(0, 40)}`);
    if (q.search_type) parts.push(`type=${q.search_type}`);
    if (q.to_country) parts.push(`to=${q.to_country}`);
    if (extra) parts.push(extra);
    return parts.join(' ');
}

module.exports = {
    LT_SEARCH_TIMEOUT_MS,
    searchErrorResponse,
    searchLogLine,
};
