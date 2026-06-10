const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const db = require('../db');

const ORDERS_UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'orders');

function sanitizeFilename(name) {
  const base = String(name || 'document.pdf').trim();
  const withExt = base.toLowerCase().endsWith('.pdf') ? base : `${base}.pdf`;
  return withExt
    .replace(/[^\w.\-()а-яА-ЯёЁ\s]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 180);
}

function getNewAttachments(changes) {
  if (!changes?.attachments || !Array.isArray(changes.attachments)) {
    return [];
  }

  const prev = changes.attachments[0];
  const next = changes.attachments[1];

  if (!Array.isArray(next)) return [];

  if (!Array.isArray(prev)) {
    return next.filter((item) => item?.url);
  }

  const prevUrls = new Set(prev.map((item) => item?.url).filter(Boolean));
  return next.filter((item) => item?.url && !prevUrls.has(item.url));
}

async function documentExists(orderId, sourceUrl) {
  const [rows] = await db.query(
    'SELECT id, file_path, public_url, title FROM order_documents WHERE order_id = ? AND source_url = ? LIMIT 1',
    [orderId, sourceUrl]
  );
  return rows[0] || null;
}

async function downloadAndSaveDocument(orderId, attachment, eventReference) {
  const sourceUrl = attachment?.url;
  if (!sourceUrl) return null;

  const existing = await documentExists(orderId, sourceUrl);
  if (existing) {
    return {
      id: existing.id,
      title: existing.title,
      source_url: sourceUrl,
      file_path: existing.file_path,
      public_url: existing.public_url,
      cached: true,
    };
  }

  const orderDir = path.join(ORDERS_UPLOAD_DIR, String(orderId));
  fs.mkdirSync(orderDir, { recursive: true });

  const title = attachment.title || 'document.pdf';
  let filename = sanitizeFilename(title);
  const filePath = path.join(orderDir, filename);

  if (fs.existsSync(filePath)) {
    const stamp = crypto.randomBytes(4).toString('hex');
    const ext = path.extname(filename);
    const stem = path.basename(filename, ext);
    filename = `${stem}_${stamp}${ext}`;
  }

  const absolutePath = path.join(orderDir, filename);
  const response = await axios.get(sourceUrl, {
    responseType: 'arraybuffer',
    timeout: 120000,
    maxRedirects: 5,
  });

  fs.writeFileSync(absolutePath, response.data);

  const relativePath = path.posix.join('uploads', 'orders', String(orderId), filename);
  const publicUrl = `/uploads/orders/${orderId}/${filename}`;

  const [result] = await db.query(
    `INSERT INTO order_documents
      (order_id, title, source_url, file_path, public_url, event_reference)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [orderId, title, sourceUrl, relativePath, publicUrl, eventReference || null]
  );

  return {
    id: result.insertId,
    title,
    source_url: sourceUrl,
    file_path: relativePath,
    public_url: publicUrl,
    cached: false,
  };
}

async function saveAttachmentsForOrder(orderId, changes, event, eventReference) {
  const attachments =
    event === 'documents' ? getNewAttachments(changes) : getNewAttachments(changes);

  if (!attachments.length) {
    return [];
  }

  const saved = [];
  for (const attachment of attachments) {
    try {
      const doc = await downloadAndSaveDocument(orderId, attachment, eventReference);
      if (doc) saved.push(doc);
    } catch (err) {
      console.error(
        `Failed to download document for order ${orderId}:`,
        attachment?.url,
        err.message
      );
      saved.push({
        title: attachment?.title || null,
        source_url: attachment?.url || null,
        error: err.message,
      });
    }
  }

  return saved;
}

function mergeLocalAttachments(pkg, savedDocs) {
  if (!pkg || typeof pkg !== 'object') pkg = {};
  if (!Array.isArray(pkg.attachments)) pkg.attachments = [];

  const successful = savedDocs.filter((doc) => doc.public_url && !doc.error);
  for (const doc of successful) {
    const entry = {
      title: doc.title,
      url: doc.public_url,
      source_url: doc.source_url,
      local_path: doc.file_path,
    };

    const idx = pkg.attachments.findIndex(
      (item) =>
        item?.source_url === doc.source_url ||
        item?.url === doc.source_url ||
        item?.title === doc.title
    );

    if (idx >= 0) {
      pkg.attachments[idx] = { ...pkg.attachments[idx], ...entry };
    } else {
      pkg.attachments.push(entry);
    }
  }

  pkg.saved_documents = successful.map((doc) => ({
    id: doc.id,
    title: doc.title,
    url: doc.public_url,
    source_url: doc.source_url,
    file_path: doc.file_path,
  }));

  return pkg;
}

async function getOrderDocuments(orderId) {
  const [rows] = await db.query(
    `SELECT id, order_id, title, source_url, file_path, public_url, event_reference, created_at
     FROM order_documents
     WHERE order_id = ?
     ORDER BY created_at DESC`,
    [orderId]
  );
  return rows;
}

module.exports = {
  getNewAttachments,
  saveAttachmentsForOrder,
  mergeLocalAttachments,
  getOrderDocuments,
};
