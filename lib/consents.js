'use strict';

/**
 * Журнал согласий (152-ФЗ ст. 9, 38-ФЗ ст. 18, ЗоЗПП ст. 16).
 *
 * Кто, когда, в какой форме, на какую редакцию документа и с какого IP дал
 * (или не дал) согласие. Версии документов — только с сервера: клиент
 * присылает лишь «галочки» { pd: true, ads: false, ... }.
 *
 * Режим наблюдения: если обязательного согласия в запросе нет, запрос НЕ
 * отклоняется (старые версии приложений), а в лог пишется [CONSENTS] missing.
 */

const db = require('../db');

// Редакция документов на totus.club (дата «Редакция от …»). Меняется вместе с текстом документа.
const DOC_VERSION = process.env.CONSENTS_DOC_VERSION || '2026-10-01';

const TYPES = {
    pd: { doc: '/consent', title: 'Согласие на обработку персональных данных' },
    ads: { doc: '/ads-consent', title: 'Согласие на получение рекламы' },
    tour_offer: { doc: '/tour-offer', title: 'Оферта о заключении договора о реализации туристского продукта' },
    hotel_terms: { doc: '/hotel-booking', title: 'Условия бронирования размещения' },
};

// Формы и обязательные согласия в каждой. booking — тур ИЛИ отель (одно из двух).
const FORMS = {
    callback: { required: [['pd']] },
    signup: { required: [['pd']] },
    signup_yandex: { required: [['pd']] },
    booking: { required: [['pd'], ['tour_offer', 'hotel_terms']] },
    partner: { required: [['pd']] },
    account: { required: [] },
};

const SOURCES = ['web', 'app'];

const CREATE_TABLE_SQL = `
    CREATE TABLE IF NOT EXISTS consent_log (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NULL,
      email VARCHAR(200) NULL,
      phone VARCHAR(32) NULL,
      consent_type VARCHAR(32) NOT NULL,
      granted TINYINT(1) NOT NULL,
      doc_url VARCHAR(255) NOT NULL,
      doc_version VARCHAR(32) NOT NULL,
      form VARCHAR(32) NOT NULL,
      ref_id VARCHAR(64) NULL,
      source VARCHAR(16) NOT NULL DEFAULT 'web',
      ip VARCHAR(64) NULL,
      user_agent VARCHAR(255) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_user (user_id),
      INDEX idx_email (email),
      INDEX idx_type_created (consent_type, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

let tableReady = null;
function ensureTable() {
    if (!tableReady) {
        tableReady = db.query(CREATE_TABLE_SQL).catch((err) => {
            tableReady = null;
            throw err;
        });
    }
    return tableReady;
}

/** { pd: true, ads: 'false', x: 1 } → { pd: true, ads: false } — только известные типы и булевы значения. */
function normalizeConsents(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const type of Object.keys(TYPES)) {
        const v = raw[type];
        if (v === true || v === 'true' || v === 1 || v === '1') out[type] = true;
        else if (v === false || v === 'false' || v === 0 || v === '0') out[type] = false;
    }
    return out;
}

/** Каких обязательных согласий не хватает: ['pd', 'tour_offer|hotel_terms']. */
function missingRequired(form, consents) {
    const def = FORMS[form];
    if (!def) return [];
    return def.required
        .filter((group) => !group.some((type) => consents[type] === true))
        .map((group) => group.join('|'));
}

const clip = (v, n) => {
    const s = v == null ? '' : String(v).trim();
    return s ? s.slice(0, n) : null;
};

/**
 * Записать согласия одной формы. Возвращает { written, missing }.
 * subject: { userId, email, phone }, meta: { refId, source, ip, userAgent }.
 */
async function recordConsents(form, rawConsents, subject = {}, meta = {}) {
    const consents = normalizeConsents(rawConsents);
    const missing = missingRequired(form, consents);
    if (missing.length) {
        console.warn(
            `[CONSENTS] missing form=${form} types=${missing.join(',')} source=${meta.source || 'web'} ` +
            `user=${subject.userId || '-'} ip=${meta.ip || '-'}`,
        );
    }
    const types = Object.keys(consents);
    if (!types.length) return { written: 0, missing };

    await ensureTable();
    const source = SOURCES.includes(meta.source) ? meta.source : 'web';
    const userId = Number.isFinite(Number(subject.userId)) && Number(subject.userId) > 0 ? Number(subject.userId) : null;
    const rows = types.map((type) => [
        userId,
        clip(subject.email, 200) && clip(subject.email, 200).toLowerCase(),
        clip(subject.phone, 32),
        type,
        consents[type] ? 1 : 0,
        TYPES[type].doc,
        DOC_VERSION,
        form,
        clip(meta.refId, 64),
        source,
        clip(meta.ip, 64),
        clip(meta.userAgent, 255),
    ]);
    await db.query(
        `INSERT INTO consent_log
            (user_id, email, phone, consent_type, granted, doc_url, doc_version, form, ref_id, source, ip, user_agent)
         VALUES ?`,
        [rows],
    );
    return { written: rows.length, missing };
}

module.exports = {
    DOC_VERSION,
    TYPES,
    FORMS,
    CREATE_TABLE_SQL,
    ensureTable,
    normalizeConsents,
    missingRequired,
    recordConsents,
};
