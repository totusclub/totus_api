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
    // null/''/undefined — «не задано» (NULL из БД раньше превращался в 0 и ронял max_price на max_price_invalid)
    if (v === null || v === undefined || v === '') return null;
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

// ---------------------------------------------------------------------------
// v2: режим цены — fixed (цена Arlekino из админки) | rule (правило от цены LT)
// ---------------------------------------------------------------------------
const PRICING_MODES = ['fixed', 'rule'];
const FIXED_UNITS = ['total', 'per_night'];

function fmtRub(v) { return `${String(Math.round(Math.abs(Number(v) || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} ₽`; }

/**
 * Нормализация режима цены: { mode, fixedPrice, fixedPriceUnit, rule } или { error }.
 * fixed: fixedPrice > 0 обязателен, rule может быть null; rule: rule обязателен.
 */
function normalizePricing(input) {
    const b = input || {};
    const mode = PRICING_MODES.includes(b.mode) ? b.mode : PRICING_MODES.includes(b.pricingMode) ? b.pricingMode : PRICING_MODES.includes(b.pricing_mode) ? b.pricing_mode : null;
    if (!mode) return { error: 'pricing_mode_invalid' };
    const rule = b.rule && !b.rule.error ? b.rule : null;
    const unitRaw = b.fixedPriceUnit !== undefined ? b.fixedPriceUnit : b.fixed_price_unit !== undefined ? b.fixed_price_unit : b.unit;
    const fixedPriceUnit = FIXED_UNITS.includes(unitRaw) ? unitRaw : 'total';
    const fixedPrice = num(b.fixedPrice !== undefined ? b.fixedPrice : b.fixed_price);
    if (mode === 'fixed') {
        if (fixedPrice === null || fixedPrice <= 0) return { error: 'fixed_price_invalid' };
        if (fixedPrice > 100000000) return { error: 'fixed_price_out_of_range' };
        return { mode, fixedPrice, fixedPriceUnit, rule };
    }
    if (!rule) return { error: 'rule_type_invalid' };
    return { mode, fixedPrice: fixedPrice !== null && fixedPrice > 0 ? fixedPrice : null, fixedPriceUnit, rule };
}

/**
 * Цена нашего предложения по шаблону LT.
 * fixed: fixedPrice (per_night → × nights, если ночи известны, иначе как total); rule: finalPrice(provider, rule).
 * → { final, marginClamped, margin, marginPercent, floor, mode }
 */
function computePrice(provider, nights, pricing) {
    const p = num(provider);
    if (!pricing || !pricing.mode) return { final: null, marginClamped: false, margin: null, marginPercent: null, floor: null, mode: null };
    if (pricing.mode === 'fixed') {
        const n = num(nights);
        let v = Number(pricing.fixedPrice);
        if (!Number.isFinite(v) || v <= 0) return { final: null, marginClamped: false, margin: null, marginPercent: null, floor: null, mode: 'fixed' };
        if (pricing.fixedPriceUnit === 'per_night' && n !== null && n > 0) v = v * n;
        v = Math.round(v * 100) / 100;
        const margin = p !== null && p > 0 ? v - p : null;
        return { final: v, marginClamped: false, margin, marginPercent: margin === null ? null : Math.round((margin / p) * 10000) / 100, floor: null, mode: 'fixed' };
    }
    if (!pricing.rule) return { final: null, marginClamped: false, margin: null, marginPercent: null, floor: null, mode: 'rule' };
    return Object.assign(finalPrice(p, pricing.rule), { mode: 'rule' });
}

/** Снимок режима цены для карт/заказов: fixed → { mode, fixedPrice, unit }; rule → { mode:'rule', type, value, … }. */
function pricingSnapshot(pricing) {
    if (!pricing || !pricing.mode) return {};
    if (pricing.mode === 'fixed') return { mode: 'fixed', fixedPrice: pricing.fixedPrice, unit: pricing.fixedPriceUnit || 'total' };
    const r = pricing.rule;
    return r ? { mode: 'rule', type: r.ruleType, value: r.ruleValue, rounding: r.rounding, minPrice: r.minPrice, maxPrice: r.maxPrice, minMarginType: r.minMarginType, minMarginValue: r.minMarginValue } : { mode: 'rule' };
}

/** Текст для админки/логов: «1 ₽ (фикс.)», «1 500 ₽/ночь (фикс.)», «−10 %». */
function pricingLabel(pricing) {
    if (!pricing || !pricing.mode) return null;
    if (pricing.mode === 'fixed') return `${fmtRub(pricing.fixedPrice)}${pricing.fixedPriceUnit === 'per_night' ? '/ночь' : ''} (фикс.)`;
    return pricing.rule ? ruleLabel(pricing.rule) : null;
}

module.exports = { RULE_TYPES, ROUNDINGS, PRICING_MODES, FIXED_UNITS, normalizeRule, finalPrice, roundTo, ruleLabel, normalizePricing, computePrice, pricingSnapshot, pricingLabel };
