'use strict';
// Сборка тела запроса «Receipt» Ferma — чистые функции, без сети и БД.
// Сценарии (FERMA_INTEGRATION_RU.md §3.2): income (А, Б, Г), return (Д), correction (Е).
// Деньги — целые копейки; в рубли переводим только при сборке запроса.
const { TAXATION_SYSTEMS, AGENT_TYPES, VATS } = require('./config');

const KINDS = {
    income: 'Income',
    return: 'IncomeReturn',
    correction: 'IncomeCorrection',
    return_correction: 'IncomeReturnCorrection',
};
const MAX_RECEIPT_KOP = 42949672 * 100; // §3.2.2 документации
const LABEL_MAX = 128;
const SUPPLIER_NAME_MAX = 256;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** ИНН: 10 цифр (организация) или 12 (физлицо, ИП) с контрольными цифрами. */
function isValidInn(value) {
    const s = String(value || '');
    if (!/^\d{10}$|^\d{12}$/.test(s)) return false;
    const d = s.split('').map(Number);
    const check = (coef) => (coef.reduce((sum, c, i) => sum + c * d[i], 0) % 11) % 10;
    if (s.length === 10) return check([2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[9];
    return check([7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[10]
        && check([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[11];
}

/** Телефон в формат +7XXXXXXXXXX (или +<код страны>…). null — не телефон. */
function normalizePhone(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    let digits = raw.replace(/\D/g, '');
    if (digits.length === 11 && digits[0] === '8') digits = `7${digits.slice(1)}`;
    if (digits.length === 10) digits = `7${digits}`;
    if (digits.length < 11 || digits.length > 15) return null;
    return `+${digits}`;
}

/**
 * Текст для кассы: длинные тире → дефис, «ёлочки» и типографские кавычки → ",
 * без управляющих символов и лишних пробелов. На стенде 20.10.2026 касса выбросила «–»
 * («20.11–27.11» → «20.11 27.11») и заменила «» на прямые кавычки.
 */
function sanitizeText(value) {
    return String(value == null ? '' : value)
        .replace(/[‐-―−]/g, '-')
        .replace(/[«»„“”‟″]/g, '"')
        .replace(/[‘’‚‛′]/g, "'")
        .replace(/[\u0000-\u001f\u007f  -​  　﻿]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Рубли из копеек числом с двумя знаками (1500.5 → 1500.5, 1 → 0.01). */
const rub = (kop) => Number((kop / 100).toFixed(2));

/** Рубли (число или строка «1 500,50») → целые копейки; null — не сумма. */
function toKop(value) {
    if (value === null || value === undefined || value === '') return null;
    const s = String(value).replace(/\s/g, '').replace(',', '.');
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
    const [r, f = ''] = s.split('.');
    return Number(r) * 100 + Number((f + '00').slice(0, 2));
}

/** ДД.ММ.ГГ для CorrectionInfo.ReceiptDate. */
function correctionDate(date) {
    const d = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(d.getTime())) return null;
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${String(d.getFullYear()).slice(2)}`;
}

/**
 * Сборка чека.
 * input: {
 *   kind: 'income'|'return'|'correction'|'return_correction',
 *   inn, invoiceId, amountKop, label,
 *   supplier: { inn, name, phone } | null   — null: собственная услуга без агентских полей,
 *   agentType, vat, taxationSystem, billAddress,
 *   paymentMethod = 1 (предоплата 100 %), paymentType = 4 (услуга),
 *   email, phone, callbackUrl, paymentMethodFlag, paymentIdentifier,
 *   correction: { type: 'SELF'|'INSTRUCTION', description, receiptDate: 'ДД.ММ.ГГ', prescriptionNumber }
 * }
 * Возвращает { request, errors: [код], warnings: [код] }. При ошибках request = null.
 */
function buildReceipt(input = {}) {
    const errors = [];
    const warnings = [];
    const type = KINDS[input.kind];
    if (!type) errors.push('invalid_kind');

    if (!isValidInn(input.inn)) errors.push('invalid_inn');

    const invoiceId = String(input.invoiceId || '');
    if (!/^[A-Za-z0-9_.-]{3,64}$/.test(invoiceId)) errors.push('invalid_invoice_id');

    const amountKop = input.amountKop;
    if (!Number.isInteger(amountKop) || amountKop <= 0) errors.push('invalid_amount');
    else if (amountKop > MAX_RECEIPT_KOP) errors.push('amount_too_large');

    let label = sanitizeText(input.label);
    if (!label) errors.push('label_required');
    if (label.length > LABEL_MAX) {
        label = label.slice(0, LABEL_MAX).trim();
        warnings.push('label_truncated');
    }

    const taxationSystem = input.taxationSystem;
    if (!TAXATION_SYSTEMS.includes(taxationSystem)) errors.push('invalid_taxation_system');
    const vat = input.vat || 'VatNo';
    if (!VATS.includes(vat)) errors.push('invalid_vat');

    const paymentMethod = input.paymentMethod == null ? 1 : Number(input.paymentMethod);
    if (![1, 2, 3, 4, 5, 6, 7].includes(paymentMethod)) errors.push('invalid_payment_method');
    const paymentType = input.paymentType == null ? 4 : Number(input.paymentType);
    if (!Number.isInteger(paymentType) || paymentType < 1 || paymentType > 33) errors.push('invalid_payment_type');

    const email = String(input.email || '').trim().toLowerCase();
    const phone = normalizePhone(input.phone);
    if (email && !EMAIL_RE.test(email)) errors.push('invalid_email');
    if (input.phone && !phone) errors.push('invalid_phone');
    // Без контакта Ferma подставит почту организации — покупатель чек не получит.
    if (!email && !phone) errors.push('contact_required');

    let agentInfo = null;
    if (input.supplier) {
        const s = input.supplier;
        const agentType = input.agentType || 'AGENT';
        if (!AGENT_TYPES.includes(agentType)) errors.push('invalid_agent_type');
        if (!isValidInn(s.inn)) errors.push('invalid_supplier_inn');
        const name = sanitizeText(s.name);
        if (!name) errors.push('supplier_name_required');
        if (name.length > SUPPLIER_NAME_MAX) errors.push('supplier_name_too_long');
        const sPhone = normalizePhone(s.phone);
        if (!sPhone) errors.push('invalid_supplier_phone');
        // Таблица 3.7: для AGENT / COMMISSIONER / CONFIDANT — только данные поставщика.
        agentInfo = { AgentType: agentType, SupplierInn: String(s.inn), SupplierName: name, SupplierPhone: sPhone };
    }

    let correctionInfo = null;
    if (input.kind === 'correction' || input.kind === 'return_correction') {
        const c = input.correction || {};
        const cType = c.type || 'SELF';
        if (!['SELF', 'INSTRUCTION'].includes(cType)) errors.push('invalid_correction_type');
        const description = sanitizeText(c.description);
        if (!description) errors.push('correction_description_required');
        if (!/^\d{2}\.\d{2}\.\d{2}$/.test(String(c.receiptDate || ''))) errors.push('invalid_correction_date');
        correctionInfo = { Type: cType, Description: description, ReceiptDate: c.receiptDate };
        if (cType === 'INSTRUCTION') {
            const num = sanitizeText(c.prescriptionNumber);
            if (!num || num.length > 32) errors.push('prescription_number_required');
            correctionInfo.ReceiptId = num;
        }
    }

    if (errors.length) return { request: null, errors, warnings };

    const amount = rub(amountKop);
    const item = {
        Label: label,
        Price: amount,
        Quantity: 1,
        Amount: amount,
        Vat: vat,
        Measure: 'PIECE',
        PaymentMethod: paymentMethod,
        PaymentType: paymentType,
    };
    // Стенд 20.10.2026: агентские данные только в позиции — работает (вопрос Ф14).
    if (agentInfo) item.PaymentAgentInfo = agentInfo;

    const customerReceipt = {
        TaxationSystem: taxationSystem,
        IsInternet: true,
        BillAddress: sanitizeText(input.billAddress) || undefined,
        PaymentType: paymentType,
        Items: [item],
        PaymentItems: [{ PaymentType: 1, Sum: amount }], // безналичными
    };
    if (email) customerReceipt.Email = email;
    if (phone) customerReceipt.Phone = phone;
    if (input.paymentMethodFlag) {
        customerReceipt.CashlessPayments = [{
            PaymentSum: amount,
            PaymentMethodFlag: String(input.paymentMethodFlag),
            PaymentIdentifiers: sanitizeText(input.paymentIdentifier) || invoiceId,
        }];
    }
    if (correctionInfo) customerReceipt.CorrectionInfo = correctionInfo;
    if (customerReceipt.BillAddress === undefined) delete customerReceipt.BillAddress;

    const request = { Inn: String(input.inn), Type: type, InvoiceId: invoiceId, CustomerReceipt: customerReceipt };
    if (input.callbackUrl) request.CallbackUrl = input.callbackUrl;
    return { request: { Request: request }, errors, warnings };
}

/** Копия запроса для хранения и показа: без e-mail и телефона покупателя. */
function maskRequest(body) {
    if (!body || !body.Request) return body;
    const copy = JSON.parse(JSON.stringify(body));
    const cr = copy.Request.CustomerReceipt || {};
    if (cr.Email) cr.Email = maskEmail(cr.Email);
    if (cr.Phone) cr.Phone = cr.Phone.replace(/\d(?=\d{2})/g, '*');
    if (copy.Request.CallbackUrl) copy.Request.CallbackUrl = copy.Request.CallbackUrl.replace(/\/callback\/[^/]+$/, '/callback/***');
    return copy;
}

function maskEmail(email) {
    const [user, domain] = String(email).split('@');
    if (!domain) return '***';
    return `${user.slice(0, 1)}***@${domain}`;
}

module.exports = {
    buildReceipt, maskRequest, maskEmail, isValidInn, normalizePhone, sanitizeText, toKop, rub, correctionDate,
    KINDS, MAX_RECEIPT_KOP, LABEL_MAX,
};
