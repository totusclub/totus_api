const fs = require('fs');
const path = require('path');
const db = require('../db');
const { sendEmail } = require('./yandexCloudEmail');
const { extractOrderDetails } = require('./vtbPaymentPurpose');
const { getOrderDocuments } = require('./orderDocuments');
const {
    orderCreatedTemplate,
    orderPaidPendingTemplate,
    orderConfirmedTemplate,
    orderDocumentsTemplate,
    orderCancelledTemplate,
} = require('./orderEmailTemplates');
const { logCallback, logCallbackError } = require('./callbackLogger');

const LOG = 'ORDER_EMAIL';
const API_PUBLIC_URL = (process.env.API_PUBLIC_URL || 'https://api.totus.club').replace(/\/$/, '');
const MAX_ATTACHMENT_BYTES = 9 * 1024 * 1024;

function parsePackage(orderRow) {
    try {
        return JSON.parse(orderRow?.package || '{}');
    } catch {
        return {};
    }
}

function normalizeState(state) {
    return String(state || '').trim().toLowerCase();
}

function isCancelledState(state) {
    const value = normalizeState(state);
    return value.includes('cancel') || value === 'rejected' || value === 'refused';
}

function isConfirmedState(state) {
    const value = normalizeState(state);
    return value === 'confirmed' || value === 'flight_confirmed';
}

function isDocumentsState(state) {
    return normalizeState(state) === 'documents_sent';
}

async function resolveOrderRecipient(orderRow, pkg) {
    if (orderRow?.user_id) {
        const [users] = await db.query(
            'SELECT email, name FROM users WHERE id = ? LIMIT 1',
            [orderRow.user_id]
        );
        if (users[0]?.email) {
            return {
                email: users[0].email,
                name: users[0].name || null,
            };
        }
    }

    if (pkg?._customer_email) {
        return {
            email: pkg._customer_email,
            name: pkg._customer_name || null,
        };
    }

    const client = pkg?.client || pkg?.package?.client;
    if (client?.email) {
        const name = [client.name, client.surname].filter(Boolean).join(' ').trim();
        return { email: client.email, name: name || null };
    }

    const tourists = pkg?.tourists || pkg?.package?.tourists;
    if (Array.isArray(tourists)) {
        const tourist = tourists.find((item) => item?.email);
        if (tourist?.email) {
            const name = [tourist.name, tourist.surname].filter(Boolean).join(' ').trim();
            return { email: tourist.email, name: name || null };
        }
    }

    return null;
}

function buildPublicDocumentUrl(publicUrl) {
    if (!publicUrl) return null;
    const value = String(publicUrl).trim();
    if (/^https?:\/\//i.test(value)) return value;
    return `${API_PUBLIC_URL}${value.startsWith('/') ? value : `/${value}`}`;
}

async function loadDocumentAttachments(orderId) {
    const documents = await getOrderDocuments(orderId);
    const attachments = [];
    let totalSize = 0;

    for (const doc of documents) {
        const relativePath = doc.file_path || doc.public_url?.replace(/^\//, '');
        if (!relativePath) continue;

        const absolutePath = path.join(__dirname, '..', relativePath);
        if (!fs.existsSync(absolutePath)) continue;

        const stat = fs.statSync(absolutePath);
        if (totalSize + stat.size > MAX_ATTACHMENT_BYTES) continue;

        attachments.push({
            filename: doc.title || path.basename(absolutePath),
            path: absolutePath,
            contentType: 'application/pdf',
        });
        totalSize += stat.size;
    }

    return attachments;
}

async function buildDocumentLinks(orderId, savedDocuments = []) {
    const fromSaved = (savedDocuments || [])
        .filter((doc) => doc.public_url && !doc.error)
        .map((doc) => ({
            title: doc.title || 'Документ',
            url: buildPublicDocumentUrl(doc.public_url),
        }));

    if (fromSaved.length) return fromSaved;

    const documents = await getOrderDocuments(orderId);
    return documents.map((doc) => ({
        title: doc.title || 'Документ',
        url: buildPublicDocumentUrl(doc.public_url),
    }));
}

async function wasEmailSent(orderId, emailType) {
    const [rows] = await db.query('SELECT package FROM orders WHERE order_id = ? LIMIT 1', [orderId]);
    if (!rows[0]?.package) return false;

    try {
        const pkg = JSON.parse(rows[0].package);
        return Boolean(pkg?._emails_sent?.[emailType]);
    } catch {
        return false;
    }
}

async function markEmailSent(orderId, emailType) {
    const [rows] = await db.query('SELECT package FROM orders WHERE order_id = ? LIMIT 1', [orderId]);
    if (!rows[0]) return;

    let pkg = {};
    try {
        pkg = JSON.parse(rows[0].package || '{}');
    } catch {
        pkg = {};
    }

    if (!pkg._emails_sent || typeof pkg._emails_sent !== 'object') {
        pkg._emails_sent = {};
    }

    pkg._emails_sent[emailType] = new Date().toISOString();

    await db.query('UPDATE orders SET package = ? WHERE order_id = ?', [
        JSON.stringify(pkg),
        orderId,
    ]);
}

async function sendTypedOrderEmail(orderId, orderRow, emailType, buildTemplate, options = {}) {
    if (await wasEmailSent(orderId, emailType)) {
        logCallback(LOG, 'SKIP', 'Order email already sent', { order_id: orderId, type: emailType });
        return { skipped: true, reason: 'already_sent' };
    }

    const pkg = parsePackage(orderRow);
    const recipient = await resolveOrderRecipient(orderRow, pkg);
    if (!recipient?.email) {
        logCallbackError(LOG, 'SKIP', 'Recipient email not found', { order_id: orderId, type: emailType });
        return { skipped: true, reason: 'no_recipient' };
    }

    const details = extractOrderDetails(pkg);
    const template = buildTemplate({
        name: recipient.name,
        orderId,
        details,
        ...options,
    });

    const mailOptions = {
        to: recipient.email,
        subject: template.subject,
        text: template.text,
        html: template.html,
    };

    if (emailType === 'documents') {
        mailOptions.attachments = await loadDocumentAttachments(orderId);
    }

    const result = await sendEmail(mailOptions);
    await markEmailSent(orderId, emailType);

    logCallback(LOG, 'SENT', 'Order email sent', {
        order_id: orderId,
        type: emailType,
        to: recipient.email,
        message_id: result.MessageId,
        attachments: mailOptions.attachments?.length || 0,
    });

    return {
        sent: true,
        type: emailType,
        to: recipient.email,
        messageId: result.MessageId,
    };
}

async function sendOrderCreatedEmail(orderId, orderRow, { payUrl, amount, paymentMinutes = 15 } = {}) {
    const emailType = payUrl ? 'created_payment' : 'created';
    return sendTypedOrderEmail(orderId, orderRow, emailType, orderCreatedTemplate, {
        payUrl,
        amount,
        paymentMinutes,
    });
}

async function sendOrderPaidPendingEmail(orderId, orderRow, { amount } = {}) {
    return sendTypedOrderEmail(orderId, orderRow, 'paid_pending', orderPaidPendingTemplate, {
        amount,
    });
}

async function sendOrderConfirmedEmail(orderId, orderRow) {
    return sendTypedOrderEmail(orderId, orderRow, 'confirmed', orderConfirmedTemplate);
}

async function sendOrderDocumentsEmail(orderId, orderRow, savedDocuments = []) {
    const documents = await buildDocumentLinks(orderId, savedDocuments);
    if (!documents.length) {
        logCallback(LOG, 'SKIP', 'No documents to send', { order_id: orderId });
        return { skipped: true, reason: 'no_documents' };
    }

    return sendTypedOrderEmail(orderId, orderRow, 'documents', orderDocumentsTemplate, {
        documents,
    });
}

async function sendOrderCancelledEmail(orderId, orderRow, reason = null) {
    return sendTypedOrderEmail(orderId, orderRow, 'cancelled', orderCancelledTemplate, {
        reason,
    });
}

async function notifyOrderStatusEmail(orderId, orderRow, { newState, event, message, savedDocuments } = {}) {
    const state = normalizeState(newState);
    const results = [];

    if (isCancelledState(state) || normalizeState(event).includes('cancel')) {
        results.push(
            await sendOrderCancelledEmail(orderId, orderRow, message || null)
        );
        return results;
    }

    if (isConfirmedState(state)) {
        results.push(await sendOrderConfirmedEmail(orderId, orderRow));
    }

    const hasNewDocuments = (savedDocuments || []).some(
        (doc) => doc.public_url && !doc.error && !doc.cached
    );

    if (isDocumentsState(state) || (event === 'documents' && hasNewDocuments)) {
        results.push(await sendOrderDocumentsEmail(orderId, orderRow, savedDocuments));
    }

    return results.filter(Boolean);
}

module.exports = {
    resolveOrderRecipient,
    sendOrderCreatedEmail,
    sendOrderPaidPendingEmail,
    sendOrderConfirmedEmail,
    sendOrderDocumentsEmail,
    sendOrderCancelledEmail,
    notifyOrderStatusEmail,
};
