'use strict';

/**
 * gzip/deflate (и brotli в compression ≥ 1.8) для ответов API. Пакет `compression` в dependencies;
 * если на сервере ещё не выполнен `npm install` — пропускаем, API работает как раньше (без сжатия),
 * в лог одна строка.
 */

function optionalCompression({ load = () => require('compression'), log = console } = {}) {
    let compression;
    try {
        compression = load();
    } catch {
        log.warn('[PERF] compression не установлен — ответы API без сжатия (npm install)');
        return function noCompression(req, res, next) {
            next();
        };
    }
    // threshold 1 КБ: мелкие ответы сжимать невыгодно.
    return compression({ threshold: 1024 });
}

module.exports = { optionalCompression };
