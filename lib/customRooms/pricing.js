'use strict';

/**
 * Правило цены наших Room Type (план claude/CUSTOM_ROOMS_PLAN_RU.md §5).
 *
 *   Provider Price (актуальная цена LT в конкретном предложении)
 *     → rule: percent (+1 / −10 %) | absolute (+1000 / −1000 ₽)
 *     → округление (1 / 10 / 100 ₽) → min/max
 *     → минимальная маржа: final ≥ provider − margin (percent | absolute); ниже — поднимаем и ставим marginClamped
 *     → Final Price
 *
 * Чистые функции, без БД — покрыты scripts/check-custom-rooms.js.
 */

const RULE_TYPES = ['percent', 'absolute'];
const ROUNDINGS = [1, 10, 100];

function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

/** Нормализация правила из БД/тела запроса. Возвращает { error } или объект правила. */
function normalizeRule(input, globals) {
    const b = input || {};
    const g = globals || {};
    const ruleType = RULE_TYPES.includes(b.ruleType) ? b.ruleType : RULE_TYPES.includes(b.rule_type) ? b.rule_type : null;
    if (!ruleType) return { error: 'rule_type_invalid' };
    const ruleValue = num(b.ruleValue !== undefined ? b.ruleValue : b.rule_value);
    if (ruleValue === null) return { error: 'rule_value_invalid' };
    if (ruleType === 'percent' && (ruleValue < -90 || ruleValue > 500)) return { error: 'rule_value_out_of_range' };
    if (ruleType === 'absolute' && Math.abs(ruleValue) > 10000000) return { error: 'rule_value_out_of_range' };

    let rounding = num(b.rounding !== undefined ? b.rounding : g.rounding);
    if (!ROUNDINGS.includes(rounding)) rounding = 1;

    const minPrice = num(b.minPrice !== undefined ? b.minPrice : b.min_price);
    const maxPrice = num(b.maxPrice !== undefined ? b.maxPrice : b.max_price);
    if (minPrice !== null && minPrice < 0) return { error: 'min_price_invalid' };
    if (maxPrice !== null && maxPrice <= 0) return { error: 'max_price_invalid' };
    if (minPrice !== null && maxPrice !== null && minPrice > maxPrice) return { error: 'min_max_invalid' };

    // минимальная маржа: своя (на комнате) или глобальная; null — не проверять
    let marginType = b.minMarginType !== undefined ? b.minMarginType : b.min_margin_type;
    let marginValue = num(b.minMarginValue !== undefined ? b.minMarginValue : b.min_margin_value);
    const ownMargin = RULE_TYPES.includes(marginType) && marginValue !== null;
    if (!ownMargin) {
        marginType = RULE_TYPES.includes(g.minMarginType) && num(g.minMarginValue) !== null ? g.minMarginType : null;
        marginValue = marginType ? num(g.minMarginValue) : null;
    }
    if (marginType === 'percent' && (marginValue < -100 || marginValue > 100)) return { error: 'min_margin_invalid' };

    return {
        ruleType,
        ruleValue,
        rounding,
        minPrice: minPrice === null ? null : minPrice,
        maxPrice: maxPrice === null ? null : maxPrice,
        minMarginType: marginType,
        minMarginValue: marginValue,
        ownMargin,
    };
}

function roundTo(value, step) {
    const s = ROUNDINGS.includes(step) ? step : 1;
    return Math.round(value / s) * s;
}

/**
 * finalPrice(provider, rule) → { final, marginClamped, margin, marginPercent, floor }.
 * margin = final − provider (отрицательная — субсидия).
 */
function finalPrice(provider, rule) {
    const p = num(provider);
    if (p === null || p <= 0) return { final: null, marginClamped: false, margin: null, marginPercent: null, floor: null };
    let v = rule.ruleType === 'percent' ? p * (1 + rule.ruleValue / 100) : p + rule.ruleValue;
    v = roundTo(v, rule.rounding);
    if (rule.minPrice !== null && rule.minPrice !== undefined && v < rule.minPrice) v = rule.minPrice;
    if (rule.maxPrice !== null && rule.maxPrice !== undefined && v > rule.maxPrice) v = rule.maxPrice;

    let floor = null;
    let marginClamped = false;
    if (rule.minMarginType) {
        // минимальная маржа: «не ниже провайдера − N» (N ≥ 0 — допустимая субсидия; N < 0 — обязательная наценка)
        floor = rule.minMarginType === 'percent' ? p * (1 - rule.minMarginValue / 100) : p - rule.minMarginValue;
        floor = roundTo(floor, rule.rounding);
        if (v < floor) { v = floor; marginClamped = true; }
    }
    if (v < 1) v = 1;
    const margin = v - p;
    return { final: v, marginClamped, margin, marginPercent: Math.round((margin / p) * 10000) / 100, floor };
}

/** Текст правила для админки/логов: «−10 %», «+1 500 ₽». */
function ruleLabel(rule) {
    const sign = rule.ruleValue > 0 ? '+' : rule.ruleValue < 0 ? '−' : '';
    const abs = Math.abs(rule.ruleValue);
    return rule.ruleType === 'percent' ? `${sign}${abs} %` : `${sign}${String(Math.round(abs)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} ₽`;
}

module.exports = { RULE_TYPES, ROUNDINGS, normalizeRule, finalPrice, roundTo, ruleLabel };
