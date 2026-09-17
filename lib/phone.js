'use strict';

/**
 * Российские номера телефона — одна проверка на весь API.
 *
 * Решение владельца (17.09.2026): принимаем только РФ — +7 или 8.
 * Храним в каноническом виде +7XXXXXXXXXX.
 *
 * Код страны 7 делён с Казахстаном, поэтому смотрим на первую цифру кода зоны:
 * РФ — 3xx, 4xx, 8xx (городские и служебные) и 9xx (мобильные);
 * 6xx и 7xx — Казахстан, не принимаем.
 */

const RU_ZONE = /^[3489]/;

/**
 * Возвращает номер в виде +7XXXXXXXXXX или null, если это не российский номер.
 * Принимает любой ввод пользователя: +7 (999) 123-45-67, 8 999 1234567, 9991234567.
 */
function normalizeRuPhone(value) {
    let digits = String(value == null ? '' : value).replace(/\D/g, '');

    if (digits.length === 11 && (digits[0] === '8' || digits[0] === '7')) {
        digits = `7${digits.slice(1)}`;
    } else if (digits.length === 10) {
        digits = `7${digits}`;
    } else {
        return null;
    }

    const zone = digits.slice(1);
    if (zone.length !== 10 || !RU_ZONE.test(zone)) return null;
    return `+${digits}`;
}

function isRuPhone(value) {
    return normalizeRuPhone(value) !== null;
}

module.exports = { normalizeRuPhone, isRuPhone };
