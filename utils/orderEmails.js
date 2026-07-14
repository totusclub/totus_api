const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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
const orderEmailLocks = new Map();

async function withOrderEmailLock(orderId, fn) {
    const key = String(orderId);
    const previous = orderEmailLocks.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
        release = resolve;
    });
    orderEmailLocks.set(
        key,
        previous.then(() => current)
    );

    await previous;
    try {
        return await fn();
    } finally {
        release();
        if (orderEmailLocks.get(key) === current) {
            orderEmailLocks.delete(key);
        }
    }
}

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

function normalizeDocumentTitle(title) {
    return String(title || 'document.pdf').trim().toLowerCase();
}

function dedupeDocumentsByName(docs) {
    const seen = new Set();
    const unique = [];

    for (const doc of docs) {
        const nameKey = normalizeDocumentTitle(doc.title);
        if (seen.has(nameKey)) continue;
        seen.add(nameKey);
        unique.push(doc);
    }

    return unique;
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
    const documents = dedupeDocumentsByName(await getOrderDocuments(orderId));
    const attachments = [];
    const seenNames = new Set();
    let totalSize = 0;

    for (const doc of documents) {
        const nameKey = normalizeDocumentTitle(doc.title);
        if (seenNames.has(nameKey)) continue;

        const relativePath = doc.file_path || doc.public_url?.replace(/^\//, '');
        if (!relativePath) continue;

        const absolutePath = path.join(__dirname, '..', relativePath);
        if (!fs.existsSync(absolutePath)) continue;

        const stat = fs.statSync(absolutePath);
        if (totalSize + stat.size > MAX_ATTACHMENT_BYTES) continue;

        seenNames.add(nameKey);
        attachments.push({
            filename: doc.title || path.basename(absolutePath),
            path: absolutePath,
            contentType: 'application/pdf',
        });
        totalSize += stat.size;
    }

    return attachments;
}

function buildDocumentEmailDedupeKey(doc) {
    const name = normalizeDocumentTitle(doc?.title);
    const raw = `doc:${name}`;
    if (raw.length <= 64) return raw;
    const hash = crypto.createHash('sha256').update(name).digest('hex').slice(0, 32);
    return `doc:${hash}`;
}

function loadSingleDocumentAttachment(doc) {
    const relativePath = doc.file_path || doc.public_url?.replace(/^\//, '');
    if (!relativePath) return [];

    const absolutePath = path.join(__dirname, '..', relativePath);
    if (!fs.existsSync(absolutePath)) return [];

    const stat = fs.statSync(absolutePath);
    if (stat.size > MAX_ATTACHMENT_BYTES) return [];

    return [{
        filename: doc.title || path.basename(absolutePath),
        path: absolutePath,
        contentType: 'application/pdf',
    }];
}

function isNewlySavedDocument(doc) {
    return Boolean(
        doc?.public_url &&
        !doc.error &&
        !doc.cached &&
        !doc.skipped_duplicate
    );
}

function buildDocumentLink(doc) {
    return {
        title: doc.title || 'Документ',
        url: buildPublicDocumentUrl(doc.public_url),
    };
}

const ONE_TIME_EMAIL_TYPES = new Set([
    'created',
    'created_payment',
    'paid_pending',
    'confirmed',
    'cancelled',
]);
async function buildDocumentLinks(orderId) {
    return dedupeDocumentsByName(await getOrderDocuments(orderId))
        .filter((doc) => Boolean(doc.public_url))
        .map((doc) => buildDocumentLink(doc));
}

async function wasEmailSentInPackage(orderId, emailType) {
    // Legacy flag kept for orders emailed before the order_email_log table existed.
    const [rows] = await db.query(
        'SELECT package FROM orders WHERE order_id = ? LIMIT 1',
        [orderId]
    );
    if (!rows[0]?.package) return false;

    try {
        const pkg = JSON.parse(rows[0].package);
        return Boolean(pkg?._emails_sent?.[emailType]);
    } catch {
        return false;
    }
}

async function ensureEmailLogTable() {
    await db.query(`
        CREATE TABLE IF NOT EXISTS order_email_log (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            order_id INT NOT NULL,
            email_type VARCHAR(64) NOT NULL,
            recipient VARCHAR(255) NULL,
            message_id VARCHAR(255) NULL,
            claimed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            sent_at DATETIME NULL,
            PRIMARY KEY (id),
            UNIQUE KEY uniq_order_email_type (order_id, email_type),
            KEY idx_order_email_log_order_id (order_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
}

async function claimEmailSend(orderId, dedupeKey) {
    if (ONE_TIME_EMAIL_TYPES.has(dedupeKey) && await wasEmailSentInPackage(orderId, dedupeKey)) {
        return false;
    }

    // Unique key (order_id, email_type) dedupes per callback/document while
    // still allowing multiple confirmed/document emails for the same order.
    const insert = () =>
        db.query('INSERT INTO order_email_log (order_id, email_type) VALUES (?, ?)', [
            orderId,
            dedupeKey,
        ]);

    try {
        await insert();
        return true;
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') return false;
        if (err.code === 'ER_NO_SUCH_TABLE') {
            await ensureEmailLogTable();
            try {
                await insert();
                return true;
            } catch (retryErr) {
                if (retryErr.code === 'ER_DUP_ENTRY') return false;
                throw retryErr;
            }
        }
        throw err;
    }
}

async function releaseEmailClaim(orderId, dedupeKey) {
    await db.query(
        'DELETE FROM order_email_log WHERE order_id = ? AND email_type = ? AND sent_at IS NULL',
        [orderId, dedupeKey]
    );
}

async function markEmailSendComplete(orderId, dedupeKey, recipient, messageId) {
    await db.query(
        'UPDATE order_email_log SET recipient = ?, message_id = ?, sent_at = NOW() WHERE order_id = ? AND email_type = ?',
        [recipient || null, messageId || null, orderId, dedupeKey]
    );
}

async function sendTypedOrderEmail(orderId, orderRow, emailType, buildTemplate, options = {}) {
    const dedupeKey = options.dedupeKey || emailType;
    if (!(await claimEmailSend(orderId, dedupeKey))) {
        logCallback(LOG, 'SKIP', 'Order email already sent', { order_id: orderId, type: dedupeKey });
        return { skipped: true, reason: 'already_sent' };
    }

    const pkg = parsePackage(orderRow);
    const recipient = await resolveOrderRecipient(orderRow, pkg);
    if (!recipient?.email) {
        await releaseEmailClaim(orderId, dedupeKey);
        logCallbackError(LOG, 'SKIP', 'Recipient email not found', { order_id: orderId, type: dedupeKey });
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

    if (options.attachments?.length) {
        mailOptions.attachments = options.attachments;
    } else if (options.attachAllDocuments) {
        mailOptions.attachments = await loadDocumentAttachments(orderId);
    }

    try {
        const result = await sendEmail(mailOptions);
        await markEmailSendComplete(orderId, dedupeKey, recipient.email, result.MessageId);

        logCallback(LOG, 'SENT', 'Order email sent', {
            order_id: orderId,
            type: dedupeKey,
            to: recipient.email,
            message_id: result.MessageId,
            attachments: mailOptions.attachments?.length || 0,
        });

        return {
            sent: true,
            type: dedupeKey,
            to: recipient.email,
            messageId: result.MessageId,
        };
    } catch (err) {
        await releaseEmailClaim(orderId, dedupeKey);
        throw err;
    }
}

async function sendOrderCreatedEmail(orderId, orderRow, { payUrl, amount, paymentMinutes = 30 } = {}) {
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
    // One confirmation email per order, even if LT sends multiple confirmed callbacks.
    return sendTypedOrderEmail(orderId, orderRow, 'confirmed', orderConfirmedTemplate, {
        dedupeKey: 'confirmed',
    });
}

async function sendSingleDocumentEmail(orderId, orderRow, doc) {
    if (!doc?.public_url) {
        logCallback(LOG, 'SKIP', 'Document email needs saved file', { order_id: orderId });
        return { skipped: true, reason: 'no_document' };
    }

    const dedupeKey = buildDocumentEmailDedupeKey(doc);
    const documents = [buildDocumentLink(doc)];

    // One email per document; skip if this document name was already emailed for the order.
    return sendTypedOrderEmail(orderId, orderRow, 'documents', orderDocumentsTemplate, {
        dedupeKey,
        documents,
        attachments: loadSingleDocumentAttachment(doc),
    });
}

async function sendOrderDocumentsEmail(orderId, orderRow) {
    const documents = await buildDocumentLinks(orderId);
    if (!documents.length) {
        logCallback(LOG, 'SKIP', 'No documents to send', { order_id: orderId });
        return { skipped: true, reason: 'no_documents' };
    }

    // One email per order with all unique PDFs attached (deduped by document name).
    return sendTypedOrderEmail(orderId, orderRow, 'documents', orderDocumentsTemplate, {
        dedupeKey: 'documents',
        documents,
        attachAllDocuments: true,
    });
}

async function sendOrderCancelledEmail(orderId, orderRow, reason = null) {
    return sendTypedOrderEmail(orderId, orderRow, 'cancelled', orderCancelledTemplate, {
        reason,
    });
}

async function collectDocumentsToEmail(orderId, savedDocuments, includeAllOrderDocs) {
    const docs = dedupeDocumentsByName(
        (savedDocuments || []).filter(isNewlySavedDocument)
    );

    if (!includeAllOrderDocs) return docs;

    const seen = new Set(docs.map((doc) => normalizeDocumentTitle(doc.title)));
    for (const doc of dedupeDocumentsByName(await getOrderDocuments(orderId))) {
        const nameKey = normalizeDocumentTitle(doc.title);
        if (!doc.public_url || seen.has(nameKey)) continue;
        seen.add(nameKey);
        docs.push(doc);
    }

    return docs;
}

async function notifyOrderStatusEmail(
    orderId,
    orderRow,
    { newState, event, message, savedDocuments, eventReference } = {}
) {
    return withOrderEmailLock(orderId, async () => {
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

        const docsToEmail = await collectDocumentsToEmail(
            orderId,
            savedDocuments,
            isDocumentsState(state)
        );

        for (const doc of docsToEmail) {
            results.push(await sendSingleDocumentEmail(orderId, orderRow, doc));
        }

        return results.filter(Boolean);
    });
}

module.exports = {
    resolveOrderRecipient,
    sendOrderCreatedEmail,
    sendOrderPaidPendingEmail,
    sendOrderConfirmedEmail,
    sendSingleDocumentEmail,
    sendOrderDocumentsEmail,
    sendOrderCancelledEmail,
    notifyOrderStatusEmail,
};
