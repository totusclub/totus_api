const fs = require('fs');
const path = require('path');
const axios = require('axios');
const db = require('../db');

const ORDERS_UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'orders');

function normalizeDownloadUrl(url) {
  if (!url) return null;
  let value = String(url).trim();
  if (value.startsWith('//')) value = `https:${value}`;
  if (!/^https?:\/\//i.test(value)) {
    value = `https://${value.replace(/^\/+/, '')}`;
  }
  return value;
}

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

function getDocumentKey(title, url) {
  const sourceUrl = normalizeDownloadUrl(url) || '';
  const attachmentMatch = sourceUrl.match(/\/attachment\/(\d+)/);
  if (attachmentMatch) {
    return `attachment:${attachmentMatch[1]}`;
  }
  if (sourceUrl.includes('/agreement.pdf') || sourceUrl.includes('agreement_code=')) {
    return 'agreement_doc';
  }
  if (sourceUrl.includes('license_agreement.pdf')) {
    return 'agreement_license';
  }
  return `title:${sanitizeFilename(title).toLowerCase()}`;
}

async function documentExistsByUrl(orderId, sourceUrl) {
  const [rows] = await db.query(
    'SELECT id, file_path, public_url, title, source_url FROM order_documents WHERE order_id = ? AND source_url = ? LIMIT 1',
    [orderId, sourceUrl]
  );
  return rows[0] || null;
}

async function documentExistsByTitle(orderId, title) {
  const normalizedTitle = String(title || '').trim();
  if (!normalizedTitle) return null;

  const [rows] = await db.query(
    `SELECT id, file_path, public_url, title, source_url
     FROM order_documents
     WHERE order_id = ? AND title = ?
     ORDER BY id ASC
     LIMIT 1`,
    [orderId, normalizedTitle]
  );
  return rows[0] || null;
}

async function findExistingDocument(orderId, attachment) {
  const sourceUrl = normalizeDownloadUrl(attachment?.url);
  const title = attachment?.title || 'document.pdf';

  if (sourceUrl) {
    const byUrl = await documentExistsByUrl(orderId, sourceUrl);
    if (byUrl) return byUrl;
  }

  const byTitle = await documentExistsByTitle(orderId, title);
  if (byTitle) return byTitle;

  return null;
}

async function countOrderDocuments(orderId) {
  const [rows] = await db.query(
    'SELECT COUNT(*) AS cnt FROM order_documents WHERE order_id = ?',
    [orderId]
  );
  return Number(rows[0]?.cnt || 0);
}

async function filterNewDownloadables(orderId, items) {
  const seenKeys = new Set();
  const filtered = [];

  for (const item of items) {
    const key = getDocumentKey(item.title, item.url);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    const existing = await findExistingDocument(orderId, item);
    if (existing) continue;

    filtered.push(item);
  }

  return filtered;
}

async function downloadAndSaveDocument(orderId, attachment, eventReference) {
  const sourceUrl = normalizeDownloadUrl(attachment?.url);
  if (!sourceUrl) return null;

  const title = attachment.title || 'document.pdf';
  const existing = await findExistingDocument(orderId, attachment);
  if (existing) {
    return {
      id: existing.id,
      title: existing.title,
      source_url: existing.source_url,
      file_path: existing.file_path,
      public_url: existing.public_url,
      cached: true,
      skipped_duplicate: true,
    };
  }

  const orderDir = path.join(ORDERS_UPLOAD_DIR, String(orderId));
  fs.mkdirSync(orderDir, { recursive: true });

  let filename = sanitizeFilename(title);
  const filePath = path.join(orderDir, filename);

  if (fs.existsSync(filePath)) {
    const onDisk = await documentExistsByTitle(orderId, title);
    if (onDisk) {
      return {
        id: onDisk.id,
        title: onDisk.title,
        source_url: onDisk.source_url,
        file_path: onDisk.file_path,
        public_url: onDisk.public_url,
        cached: true,
        skipped_duplicate: true,
      };
    }

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
      cached: true,
      skipped_duplicate: true,
    };
  }

  const absolutePath = path.join(orderDir, filename);
  const response = await axios.get(sourceUrl, {
    responseType: 'arraybuffer',
    timeout: 120000,
    maxRedirects: 10,
    headers: {
      Accept: 'application/pdf,application/octet-stream,*/*',
      'User-Agent': 'Mozilla/5.0 (compatible; TotusAPI/1.0)',
      Referer: 'https://level.travel/',
    },
    validateStatus: (status) => status >= 200 && status < 400,
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

function extractDownloadablesFromOrder(order) {
  const items = [];

  if (Array.isArray(order?.attachments)) {
    for (const attachment of order.attachments) {
      const url = normalizeDownloadUrl(attachment?.url);
      if (url && !url.startsWith('/uploads/')) {
        items.push({ title: attachment.title || 'document.pdf', url });
      }
    }
  }

  if (order?.agreement_doc) {
    items.push({
      title: 'Договор оферты.pdf',
      url: normalizeDownloadUrl(order.agreement_doc),
    });
  }

  if (order?.agreement_license) {
    items.push({
      title: 'Лицензионный договор.pdf',
      url: normalizeDownloadUrl(order.agreement_license),
    });
  }

  const seen = new Set();
  return items.filter((item) => {
    const key = getDocumentKey(item.title, item.url);
    if (!item.url || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function saveAllDocumentsFromOrder(orderId, order, eventReference) {
  const attachments = await filterNewDownloadables(
    orderId,
    extractDownloadablesFromOrder(order)
  );
  if (!attachments.length) return [];

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

async function saveAttachmentsForOrder(orderId, changes, event, eventReference) {
  const attachments = getNewAttachments(changes);

  if (!attachments.length) {
    return [];
  }

  const toDownload = await filterNewDownloadables(
    orderId,
    attachments.map((a) => ({
      title: a.title || 'document.pdf',
      url: a.url,
    }))
  );

  if (!toDownload.length) {
    return [];
  }

  const saved = [];
  for (const attachment of toDownload) {
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

function isLocalDocumentUrl(url) {
  if (!url) return false;
  return String(url).trim().startsWith('/uploads/');
}

function isExternalDocumentUrl(url) {
  if (!url || isLocalDocumentUrl(url)) return false;
  const value = String(url).trim().toLowerCase();
  return /^https?:\/\//i.test(value) || value.includes('level.travel');
}

function buildDocumentLookup(documents) {
  const bySourceUrl = new Map();
  const byKey = new Map();
  const byTitle = new Map();

  for (const doc of documents) {
    const source = normalizeDownloadUrl(doc.source_url);
    if (source) bySourceUrl.set(source, doc);

    const key = getDocumentKey(doc.title, doc.source_url);
    if (!byKey.has(key)) byKey.set(key, doc);

    const title = String(doc.title || '').trim().toLowerCase();
    if (title && !byTitle.has(title)) byTitle.set(title, doc);
  }

  return { bySourceUrl, byKey, byTitle };
}

function resolveLocalDocument(docUrl, title, lookup) {
  if (isLocalDocumentUrl(docUrl)) {
    return {
      public_url: String(docUrl).trim(),
      source_url: null,
      id: null,
      file_path: null,
    };
  }

  const normalized = normalizeDownloadUrl(docUrl);
  if (normalized && lookup.bySourceUrl.has(normalized)) {
    const doc = lookup.bySourceUrl.get(normalized);
    return doc;
  }

  const key = getDocumentKey(title, docUrl);
  if (lookup.byKey.has(key)) {
    return lookup.byKey.get(key);
  }

  const titleKey = String(title || '').trim().toLowerCase();
  if (titleKey && lookup.byTitle.has(titleKey)) {
    return lookup.byTitle.get(titleKey);
  }

  return null;
}

function applyLocalDocumentUrlsToPackage(orderId, pkg, documents) {
  if (!pkg || typeof pkg !== 'object') return pkg;

  const out = JSON.parse(JSON.stringify(pkg));
  const lookup = buildDocumentLookup(documents || []);

  function rewriteRootField(fieldName, title) {
    const current = out[fieldName];
    if (!current) return;

    const resolved = resolveLocalDocument(current, title, lookup);
    if (resolved?.public_url) {
      out[fieldName] = resolved.public_url;
      return;
    }

    if (isExternalDocumentUrl(current)) {
      delete out[fieldName];
    }
  }

  rewriteRootField('agreement_doc', 'Договор оферты.pdf');
  rewriteRootField('agreement_license', 'Лицензионный договор.pdf');
  // Legacy titles used in older rows
  if (isExternalDocumentUrl(out.agreement_doc)) {
    rewriteRootField('agreement_doc', 'agreement_doc.pdf');
  }
  if (isExternalDocumentUrl(out.agreement_license)) {
    rewriteRootField('agreement_license', 'agreement_license.pdf');
  }

  if (Array.isArray(out.attachments)) {
    const nextAttachments = [];
    for (const item of out.attachments) {
      if (!item || typeof item !== 'object') continue;

      const resolved = resolveLocalDocument(item.url, item.title, lookup);
      if (resolved?.public_url) {
        nextAttachments.push({
          ...item,
          url: resolved.public_url,
          local_path: resolved.file_path || item.local_path || null,
        });
      }
    }
    out.attachments = nextAttachments;
  } else if (documents?.length) {
    out.attachments = documents.map((doc) => ({
      title: doc.title,
      url: doc.public_url,
      local_path: doc.file_path,
    }));
  }

  if (documents?.length) {
    out.saved_documents = documents.map((doc) => ({
      id: doc.id,
      title: doc.title,
      url: doc.public_url,
      file_path: doc.file_path,
    }));
  } else if (Array.isArray(out.saved_documents)) {
    out.saved_documents = out.saved_documents
      .filter((doc) => doc?.url && isLocalDocumentUrl(doc.url))
      .map((doc) => ({
        id: doc.id,
        title: doc.title,
        url: doc.url,
        file_path: doc.file_path || doc.local_path || null,
      }));
  }

  return out;
}

async function sanitizeOrderPackageForClient(orderId, pkg) {
  const documents = await getOrderDocuments(orderId);
  return applyLocalDocumentUrlsToPackage(orderId, pkg, documents);
}

async function sanitizeLtApiPayloadForClient(orderId, payload) {
  if (!payload || typeof payload !== 'object') return payload;

  const out = JSON.parse(JSON.stringify(payload));

  async function sanitizeOrderObject(orderObj) {
    const oid = Number(orderObj?.id || orderId);
    if (!Number.isFinite(oid)) return orderObj;
    const documents = await getOrderDocuments(oid);
    return applyLocalDocumentUrlsToPackage(oid, orderObj, documents);
  }

  if (out.order) {
    out.order = await sanitizeOrderObject(out.order);
  }

  if (Array.isArray(out.orders)) {
    out.orders = await Promise.all(out.orders.map((item) => sanitizeOrderObject(item)));
  }

  if (out.package && typeof out.package === 'object') {
    out.package = await sanitizeOrderObject({ id: orderId, ...out.package });
  }

  return out;
}

async function prepareOrderRowForClient(orderRow) {
  if (!orderRow) return orderRow;

  const orderId = Number(orderRow.order_id);
  let parsedPackage = {};
  try {
    parsedPackage = JSON.parse(orderRow.package || '{}');
  } catch {
    parsedPackage = {};
  }

  const sanitizedPackage = Number.isFinite(orderId)
    ? await sanitizeOrderPackageForClient(orderId, parsedPackage)
    : parsedPackage;

  return {
    ...orderRow,
    package: sanitizedPackage,
  };
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

    const key = getDocumentKey(doc.title, doc.source_url);
    if (key === 'agreement_doc') {
      pkg.agreement_doc = doc.public_url;
    } else if (key === 'agreement_license') {
      pkg.agreement_license = doc.public_url;
    }
  }

  pkg.saved_documents = successful.map((doc) => ({
    id: doc.id,
    title: doc.title,
    url: doc.public_url,
    source_url: doc.source_url,
    file_path: doc.file_path,
  }));

  return applyLocalDocumentUrlsToPackage(null, pkg, successful);
}

async function persistCreatedOrderDocuments(orderId, orderData, eventReference = 'order_create') {
  if (!orderId || !orderData || typeof orderData !== 'object') {
    return { saved: [], orderData };
  }

  const saved = await saveAllDocumentsFromOrder(orderId, orderData, eventReference);
  const successful = saved.filter((doc) => doc.public_url && !doc.error);

  if (!successful.length) {
    return { saved, orderData };
  }

  const updated = mergeLocalAttachments(
    typeof orderData === 'object' ? { ...orderData } : {},
    successful
  );

  await db.query('UPDATE orders SET package = ? WHERE order_id = ?', [
    JSON.stringify(updated),
    orderId,
  ]);

  return { saved, orderData: updated };
}

/**
 * Documents of many orders in ONE query (GET /user/orders used to run one query per order).
 * Map order_id → rows in the same order as getOrderDocuments (created_at DESC).
 */
async function getOrderDocumentsByOrderIds(orderIds) {
  const ids = [...new Set(
    (orderIds || []).map((id) => Number(id)).filter((id) => Number.isFinite(id))
  )];
  const byOrderId = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return byOrderId;

  const [rows] = await db.query(
    `SELECT id, order_id, title, source_url, file_path, public_url, event_reference, created_at
     FROM order_documents
     WHERE order_id IN (?)
     ORDER BY created_at DESC`,
    [ids]
  );
  for (const row of rows) {
    const list = byOrderId.get(Number(row.order_id));
    if (list) list.push(row);
  }
  return byOrderId;
}

function parseOrderPackage(orderRow) {
  try {
    return JSON.parse(orderRow.package || '{}');
  } catch {
    return {};
  }
}

/**
 * Same result as Promise.all(rows.map(prepareOrderRowForClient)), but documents for all
 * orders are read with one query instead of one per order.
 */
async function prepareOrderRowsForClient(orderRows) {
  const rows = Array.isArray(orderRows) ? orderRows : [];
  const documentsByOrderId = await getOrderDocumentsByOrderIds(
    rows.filter(Boolean).map((row) => row.order_id)
  );

  return rows.map((orderRow) => {
    if (!orderRow) return orderRow;
    const orderId = Number(orderRow.order_id);
    const parsedPackage = parseOrderPackage(orderRow);
    const sanitizedPackage = Number.isFinite(orderId)
      ? applyLocalDocumentUrlsToPackage(orderId, parsedPackage, documentsByOrderId.get(orderId) || [])
      : parsedPackage;
    return {
      ...orderRow,
      package: sanitizedPackage,
    };
  });
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
  getDocumentKey,
  extractDownloadablesFromOrder,
  saveAttachmentsForOrder,
  saveAllDocumentsFromOrder,
  persistCreatedOrderDocuments,
  mergeLocalAttachments,
  getOrderDocuments,
  getOrderDocumentsByOrderIds,
  countOrderDocuments,
  findExistingDocument,
  filterNewDownloadables,
  applyLocalDocumentUrlsToPackage,
  sanitizeOrderPackageForClient,
  sanitizeLtApiPayloadForClient,
  prepareOrderRowForClient,
  prepareOrderRowsForClient,
};
