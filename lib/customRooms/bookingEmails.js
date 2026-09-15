'use strict';

/**
 * Письма и push по бронированиям без Level.Travel (оператор Arlekino). Бриф §2 (onPaid), §4.
 *  - клиенту: оплачено/проверяем, подтверждено (+ ваучер вложением), отклонено/отменено (+ возврат),
 *    возврат выполнен, ваучер повторно — через utils/yandexCloudEmail.sendEmail (тот же транспорт,
 *    что utils/orderEmails.js), от имени «Arlekino Tour» (отправитель — EMAIL_FROM, как у всех писем);
 *  - сотрудникам: «Новое бронирование Arlekino №…» на BOOKINGS_NOTIFY_EMAIL (env, если задан);
 *  - push/in-app через lib/notifyHub (без ПД: только userId, номер заказа, тексты без имён).
 * Ни одна функция не бросает: возвращает { sent, to?, error?, push?, voucherAttached? }.
 */

const fs = require('fs');
const path = require('path');
const notifyHub = require('../notifyHub');

const LOG = '[custom-rooms:email]';
const SIGNATURE = 'Arlekino Tour';
const SITE_URL = 'https://totus.club';
const MAX_ATTACHMENT_BYTES = 9 * 1024 * 1024;

function escapeHtml(v) { return String(v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function money(v) { return require('./bookings').money(v); }
function dateRu(ymd) {
    if (!ymd) return '';
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd));
    return m ? `${m[3]}.${m[2]}.${m[1]}` : String(ymd);
}
function pluralRu(n, one, few, many) { const a = Math.abs(n) % 100; const b = a % 10; if (a > 10 && a < 20) return many; if (b > 1 && b < 5) return few; if (b === 1) return one; return many; }
function guestsText(b) {
    const parts = [];
    if (b.adults) parts.push(`${b.adults} ${pluralRu(b.adults, 'взрослый', 'взрослых', 'взрослых')}`);
    if (b.kids) parts.push(`${b.kids} ${pluralRu(b.kids, 'ребёнок', 'ребёнка', 'детей')}`);
    return parts.join(', ');
}

function sendMail(options) {
    try {
        const { sendEmail } = require('../../utils/yandexCloudEmail');
        return sendEmail(options);
    } catch (e) { return Promise.reject(e); }
}

function loadShell() {
    try { return require('../../utils/emailTemplates'); } catch (e) { return null; }
}

/** Строки сводки по бронированию (для писем клиенту и сотрудникам). */
function summaryRows(b) {
    const rows = [
        ['Заказ', `№${b.orderId}`],
        ['Отель', [b.hotelName, b.hotelStars ? `${b.hotelStars}★` : null, b.hotelCity].filter(Boolean).join(', ')],
        ['Номер', b.roomName],
        ['Даты', b.checkIn ? `${dateRu(b.checkIn)}${b.checkOut ? ` — ${dateRu(b.checkOut)}` : ''}${b.nights ? ` (${b.nights} ${pluralRu(b.nights, 'ночь', 'ночи', 'ночей')})` : ''}` : null],
        ['Питание', b.mealName || b.meal],
        ['Гости', guestsText(b)],
        ['Туроператор', b.operatorName || 'Arlekino'],
        ['Стоимость', money(b.finalPrice)],
    ];
    if (b.hotelBookingRef) rows.splice(1, 0, ['Номер брони', b.hotelBookingRef]);
    return rows.filter(([, v]) => v);
}

function summaryHtml(b, BRAND) {
    const tr = summaryRows(b).map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;font-size:14px;color:${BRAND.gray};white-space:nowrap;vertical-align:top;">${escapeHtml(k)}</td><td style="padding:4px 0;font-size:14px;color:${BRAND.dark};font-weight:600;">${escapeHtml(v)}</td></tr>`).join('');
    return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 24px;background:${BRAND.bg};border:1px solid ${BRAND.border};border-radius:14px;"><tr><td style="padding:18px 22px;"><table role="presentation" cellspacing="0" cellpadding="0">${tr}</table></td></tr></table>`;
}
function summaryText(b) { return summaryRows(b).map(([k, v]) => `${k}: ${v}`).join('\n'); }

/** Письмо в общем стиле Totus (emailShell), заголовок и подпись — Arlekino Tour. */
function buildEmail({ b, name, title, subject, paragraphs, tone, extraHtml, extraText, buttonLabel, buttonUrl }) {
    const shell = loadShell();
    const BRAND = (shell && shell.BRAND) || { orange: '#FE732E', dark: '#1F1F1F', gray: '#7A7A7A', lightGray: '#B6B6B6', bg: '#F7F7F7', border: '#ECECEC', siteUrl: SITE_URL };
    const toneColor = tone === 'ok' ? '#1f7a3f' : tone === 'bad' ? '#b42318' : BRAND.orange;
    const greet = name ? `<p style="margin:0 0 14px;font-size:18px;line-height:1.5;color:${BRAND.dark};font-weight:600;">Здравствуйте, ${escapeHtml(name)}!</p>` : '';
    const ps = paragraphs.map((p) => `<p style="margin:0 0 16px;font-size:16px;line-height:1.7;color:${BRAND.gray};">${escapeHtml(p)}</p>`).join('');
    const btn = buttonUrl ? `<table role="presentation" cellspacing="0" cellpadding="0" align="center" style="margin:20px auto 0;"><tr><td align="center" style="border-radius:999px;background-color:${BRAND.orange};"><a href="${escapeHtml(buttonUrl)}" target="_blank" style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:999px;">${escapeHtml(buttonLabel || 'Открыть заказ')}</a></td></tr></table>` : '';
    const bodyHtml = `
          <tr>
            <td style="padding:36px 36px 24px;text-align:center;border-bottom:1px solid ${BRAND.border};">
              <p style="margin:0 0 10px;font-size:13px;line-height:1.4;color:${toneColor};font-weight:700;letter-spacing:1px;text-transform:uppercase;">${escapeHtml(SIGNATURE)}</p>
              <h1 style="margin:0;font-size:26px;line-height:1.3;color:${BRAND.dark};font-weight:700;">${escapeHtml(title)}</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:32px 36px 36px;">
              ${greet}
              ${ps}
              ${summaryHtml(b, BRAND)}
              ${extraHtml || ''}
              <p style="margin:16px 0 0;font-size:14px;line-height:1.7;color:${BRAND.lightGray};">С уважением,<br><strong style="color:${BRAND.dark};">${escapeHtml(SIGNATURE)}</strong><br>Вопросы по бронированию — в чате поддержки Totus Club.</p>
              ${btn}
            </td>
          </tr>`;
    const html = shell && shell.emailShell
        ? shell.emailShell({ title, bodyHtml, footerNote: `Письмо отправлено от имени ${SIGNATURE} через сервис Totus Club (noreply@totus.club)` })
        : `<!DOCTYPE html><html lang="ru"><body style="font-family:Arial,sans-serif;"><table role="presentation" width="600" cellspacing="0" cellpadding="0">${bodyHtml}</table></body></html>`;
    const text = `${name ? `Здравствуйте, ${name}!\n\n` : ''}${paragraphs.join('\n\n')}\n\n${summaryText(b)}${extraText ? `\n\n${extraText}` : ''}${buttonUrl ? `\n\n${buttonLabel || 'Открыть заказ'}: ${buttonUrl}` : ''}\n\nС уважением,\n${SIGNATURE}\nВопросы по бронированию — в чате поддержки Totus Club.`;
    return { subject, html, text };
}

function recipientOf(b) {
    const c = b.contact || {};
    if (!c.email) return null;
    return { email: String(c.email).trim(), name: c.name || null };
}

// Страница заказа на сайте зависит от фронта — ведём на сайт (как существующие письма заказов).
function orderUrl() { return SITE_URL; }

function voucherAttachment(b) {
    if (!b.voucherPath) return null;
    try {
        const abs = path.join(__dirname, '..', '..', b.voucherPath);
        if (!fs.existsSync(abs)) return null;
        if (fs.statSync(abs).size > MAX_ATTACHMENT_BYTES) return null;
        return { filename: 'Ваучер.pdf', path: abs, contentType: 'application/pdf' };
    } catch (e) { return null; }
}

async function deliver(b, mail, attachments) {
    const to = recipientOf(b);
    if (!to) { console.log(`${LOG} skip: booking #${b.id} has no customer email`); return { sent: false, reason: 'no_recipient' }; }
    const options = { to: to.email, subject: mail.subject, text: mail.text, html: mail.html };
    if (attachments && attachments.length) options.attachments = attachments;
    try {
        const r = await sendMail(options);
        console.log(`${LOG} sent "${mail.subject}" for order ${b.orderId} (attachments: ${attachments ? attachments.length : 0})`);
        return { sent: true, to: to.email, messageId: (r && r.MessageId) || null };
    } catch (e) {
        console.error(`${LOG} send failed for order ${b.orderId}:`, e.message);
        return { sent: false, error: e.message };
    }
}

/** userId для push: user_id бронирования, иначе users.id по e-mail покупателя (в хаб e-mail не уходит). */
async function userIdOf(b) {
    try {
        return await notifyHub.resolveOrderUserId({ user_id: b.userId, order_id: b.orderId, package: { _customer_email: b.contact && b.contact.email } });
    } catch (e) { return null; }
}

async function push(b, type, title, body, opts = {}) {
    const userId = await userIdOf(b);
    if (!userId) return { skipped: 'no_user' };
    const collapseKey = `order_${b.orderId}_${type}`;
    const r = await notifyHub.notify(
        { userId, type, title, body, data: Object.assign({ orderId: b.orderId, route: opts.route || 'order' }, opts.data || {}), collapseKey },
        { dedupeKey: opts.dedupeKey === null ? null : (opts.dedupeKey || `${collapseKey}:${body}`) },
    );
    return { ok: Boolean(r && r.ok), skipped: r && r.skipped ? r.skipped : undefined };
}

// ---------------------------------------------------------------------------
// События
// ---------------------------------------------------------------------------
/** Оплачено → «Проверяем бронирование»: письмо клиенту + push order_status + письмо сотрудникам. */
async function onPaid(b) {
    const name = b.contact && b.contact.name;
    const mail = buildEmail({
        b, name,
        title: 'Оплата получена — проверяем бронирование',
        subject: `Заказ №${b.orderId}: оплата получена, проверяем бронирование — ${SIGNATURE}`,
        tone: 'ok',
        paragraphs: [
            `Мы получили вашу оплату ${money(b.paidAmount || b.finalPrice)} по заказу №${b.orderId}. Сейчас подтверждаем бронирование у отеля.`,
            'Как только бронирование будет подтверждено, мы пришлём ваучер на этот адрес и в личный кабинет. Обычно это занимает до одного рабочего дня.',
        ],
        buttonLabel: 'Открыть Totus Club', buttonUrl: orderUrl(),
    });
    const email = await deliver(b, mail);
    const pushRes = await push(b, 'order_status', 'Проверяем бронирование', `Заказ №${b.orderId} оплачен. Подтвердим бронирование и пришлём ваучер.`);
    const staff = await notifyStaffNewBooking(b);
    return { sent: email.sent, to: email.to, error: email.error, reason: email.reason, push: pushRes, staff };
}

/** Подтверждено: письмо (+ ваучер вложением, если загружен) + push order_confirmed. */
async function onConfirmed(b) {
    const name = b.contact && b.contact.name;
    const att = voucherAttachment(b);
    const paragraphs = [
        `Отель подтвердил ваше бронирование по заказу №${b.orderId}${b.hotelBookingRef ? ` (номер брони ${b.hotelBookingRef})` : ''}.`,
        att ? 'Ваучер — во вложении к этому письму и в разделе «Документы» вашего заказа. Предъявите его на стойке регистрации.' : (b.voucherUrl ? 'Ваучер доступен в разделе «Документы» вашего заказа.' : 'Ваучер пришлём отдельным письмом.'),
    ];
    if (b.clientMessage) paragraphs.push(b.clientMessage);
    const mail = buildEmail({
        b, name, tone: 'ok',
        title: 'Бронирование подтверждено',
        subject: `Заказ №${b.orderId}: бронирование подтверждено — ${SIGNATURE}`,
        paragraphs,
        extraHtml: b.voucherUrl ? `<p style="margin:0;font-size:15px;line-height:1.6;">&#128196; <a href="${escapeHtml(b.voucherUrl)}" target="_blank" style="color:#FE732E;text-decoration:none;font-weight:600;">Ваучер (PDF)</a></p>` : '',
        extraText: b.voucherUrl ? `Ваучер: ${b.voucherUrl}` : '',
        buttonLabel: 'Открыть Totus Club', buttonUrl: orderUrl(),
    });
    const email = await deliver(b, mail, att ? [att] : null);
    const pushRes = await push(b, 'order_confirmed', 'Бронирование подтверждено', `Заказ №${b.orderId} подтверждён оператором ${b.operatorName || 'Arlekino'}.${b.voucherUrl ? ' Ваучер — в документах заказа.' : ''}`);
    return { sent: email.sent, to: email.to, error: email.error, reason: email.reason, voucherAttached: Boolean(att && email.sent), push: pushRes };
}

/** Отклонено / отменено: письмо с причиной и возвратом + push order_cancelled. */
async function onRejected(b) {
    const bookings = require('./bookings');
    const name = b.contact && b.contact.name;
    const cancelled = b.status === 'cancelled';
    const reason = b.rejectReason ? bookings.REJECT_REASON_LABELS[b.rejectReason] || b.rejectReason : null;
    const refund = b.refundStatus === 'done'
        ? `Возврат ${money(b.refundAmount)} уже выполнен — деньги поступят на счёт, с которого была оплата, в срок, установленный вашим банком.`
        : `Возврат ${money(b.refundAmount)} выполним вручную в течение 1–3 рабочих дней на счёт, с которого была оплата.`;
    const paragraphs = [
        cancelled
            ? `К сожалению, бронирование по заказу №${b.orderId} отменено${reason ? `. Причина: ${reason.toLowerCase()}` : ''}.`
            : `К сожалению, отель не смог подтвердить бронирование по заказу №${b.orderId}${reason ? `. Причина: ${reason.toLowerCase()}` : ''}.`,
    ];
    if (b.rejectMessage) paragraphs.push(b.rejectMessage);
    paragraphs.push(refund, 'Будем рады подобрать другой номер или даты — напишите нам в чат поддержки.');
    const mail = buildEmail({
        b, name, tone: 'bad',
        title: cancelled ? 'Бронирование отменено' : 'Бронирование отклонено',
        subject: `Заказ №${b.orderId}: бронирование ${cancelled ? 'отменено' : 'отклонено'}, возврат ${money(b.refundAmount)} — ${SIGNATURE}`,
        paragraphs,
        buttonLabel: 'Подобрать другой номер', buttonUrl: SITE_URL,
    });
    const email = await deliver(b, mail);
    const pushRes = await push(b, 'order_cancelled', cancelled ? 'Бронирование отменено' : 'Бронирование отклонено',
        `Заказ №${b.orderId}${reason ? `: ${reason.toLowerCase()}` : ''}. ${b.refundStatus === 'done' ? `Возврат ${money(b.refundAmount)} выполнен.` : `Возврат ${money(b.refundAmount)} выполним вручную в течение 1–3 дней.`}`);
    return { sent: email.sent, to: email.to, error: email.error, reason: email.reason, push: pushRes };
}

/** Возврат выполнен: письмо + push order_status. */
async function onRefundDone(b) {
    const name = b.contact && b.contact.name;
    const mail = buildEmail({
        b, name,
        title: 'Возврат выполнен',
        subject: `Заказ №${b.orderId}: возврат ${money(b.refundAmount)} выполнен — ${SIGNATURE}`,
        paragraphs: [
            `Мы вернули ${money(b.refundAmount)} по заказу №${b.orderId} на счёт, с которого была оплата. Зачисление зависит от вашего банка и обычно занимает от нескольких часов до 3 рабочих дней.`,
            'Если деньги не поступят в этот срок — напишите нам в чат поддержки.',
        ],
        buttonLabel: 'Открыть Totus Club', buttonUrl: orderUrl(),
    });
    const email = await deliver(b, mail);
    const pushRes = await push(b, 'order_status', 'Возврат выполнен', `Заказ №${b.orderId}: возврат ${money(b.refundAmount)} выполнен.`);
    return { sent: email.sent, to: email.to, error: email.error, reason: email.reason, push: pushRes };
}

/** Ваучер (повторно / после подтверждения): письмо с вложением + push documents_ready (voucher). */
async function sendVoucher(b) {
    const name = b.contact && b.contact.name;
    const att = voucherAttachment(b);
    if (!att && !b.voucherUrl) return { sent: false, reason: 'no_voucher' };
    const mail = buildEmail({
        b, name, tone: 'ok',
        title: 'Ваучер по бронированию',
        subject: `Заказ №${b.orderId}: ваучер — ${SIGNATURE}`,
        paragraphs: [
            `Направляем ваучер по вашему бронированию №${b.orderId}${b.hotelBookingRef ? ` (номер брони ${b.hotelBookingRef})` : ''}. Предъявите его на стойке регистрации отеля.`,
        ],
        extraHtml: b.voucherUrl ? `<p style="margin:0;font-size:15px;line-height:1.6;">&#128196; <a href="${escapeHtml(b.voucherUrl)}" target="_blank" style="color:#FE732E;text-decoration:none;font-weight:600;">Ваучер (PDF)</a></p>` : '',
        extraText: b.voucherUrl ? `Ваучер: ${b.voucherUrl}` : '',
        buttonLabel: 'Открыть Totus Club', buttonUrl: orderUrl(),
    });
    const email = await deliver(b, mail, att ? [att] : null);
    const pushRes = await push(b, 'documents_ready', 'Документы готовы', `Ваучер по заказу №${b.orderId} доступен в приложении.`, { route: 'documents', data: { kind: 'voucher' }, dedupeKey: null });
    return { sent: email.sent, to: email.to, error: email.error, reason: email.reason, voucherAttached: Boolean(att && email.sent), push: pushRes };
}

/** Сотрудникам: новое оплаченное бронирование (BOOKINGS_NOTIFY_EMAIL, CSV). */
async function notifyStaffNewBooking(b) {
    const to = String(process.env.BOOKINGS_NOTIFY_EMAIL || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!to.length) return { skipped: 'not_configured' };
    const c = b.contact || {};
    const customer = [[c.name, c.surname].filter(Boolean).join(' '), c.phone, c.email].filter(Boolean).join(' · ');
    const lines = [
        `Новое бронирование ${b.operatorName || 'Arlekino'} №${b.orderId} — оплачено ${money(b.paidAmount || b.finalPrice)}${b.paidAt ? ` (${new Date(b.paidAt).toLocaleString('ru-RU')})` : ''}.`,
        'Нужно подтвердить или отклонить в админке: Отели и номера → Бронирования.',
        '',
        summaryText(b),
        `Цена провайдера: ${money(b.providerPrice)}`,
        `Покупатель: ${customer || '—'}`,
        `Туристов: ${Array.isArray(b.tourists) ? b.tourists.length : 0}`,
    ];
    const text = lines.join('\n');
    const html = `<pre style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:14px;line-height:1.6;white-space:pre-wrap;">${escapeHtml(text)}</pre>`;
    try {
        await sendMail({ to, subject: `Новое бронирование ${b.operatorName || 'Arlekino'} №${b.orderId} — ${money(b.paidAmount || b.finalPrice)}`, text, html });
        console.log(`${LOG} staff notified about booking #${b.id}`);
        return { sent: true };
    } catch (e) {
        console.error(`${LOG} staff email failed:`, e.message);
        return { sent: false, error: e.message };
    }
}

module.exports = { SIGNATURE, buildEmail, summaryRows, onPaid, onConfirmed, onRejected, onRefundDone, sendVoucher, notifyStaffNewBooking, voucherAttachment };
