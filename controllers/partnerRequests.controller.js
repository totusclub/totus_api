// Заявки «Стать партнёром» со страницы totus.club/partners.
// Публичный POST без входа; список и смена статуса — в админке (staff).
const db = require('../db');

const KINDS = ['operator', 'hotel', 'ads', 'other'];
const STATUSES = ['new', 'in_progress', 'done', 'rejected'];
const LIMITS = { company: 200, name: 120, email: 200, phone: 32, message: 2000, note: 2000 };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Таблица создаётся сама при первом обращении (как home_hero_images), ручная миграция не нужна.
// То же самое — scripts/run-partner-requests-migration.js.
const CREATE_TABLE_SQL = `
    CREATE TABLE IF NOT EXISTS partner_requests (
      id INT AUTO_INCREMENT PRIMARY KEY,
      company VARCHAR(200) NOT NULL,
      name VARCHAR(120) NOT NULL,
      email VARCHAR(200) NOT NULL,
      phone VARCHAR(32) NULL,
      kind ENUM('operator','hotel','ads','other') NOT NULL DEFAULT 'other',
      message TEXT NULL,
      status ENUM('new','in_progress','done','rejected') NOT NULL DEFAULT 'new',
      note TEXT NULL,
      source VARCHAR(32) NOT NULL DEFAULT 'web',
      ip VARCHAR(64) NULL,
      user_agent VARCHAR(255) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_status (status),
      INDEX idx_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

let tableReady = null;
function ensureTable() {
    if (!tableReady) {
        tableReady = db.query(CREATE_TABLE_SQL).catch((err) => {
            tableReady = null; // повторим при следующем запросе
            throw err;
        });
    }
    return tableReady;
}

const str = (v) => (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim();

/** Проверка полей формы. Возвращает { value } или { error } (код ошибки snake_case). */
function validatePartnerRequest(body = {}) {
    const company = str(body.company);
    const name = str(body.name);
    const email = str(body.email).toLowerCase();
    const phoneRaw = str(body.phone);
    const kind = str(body.kind) || 'other';
    const message = body.message == null ? '' : String(body.message).trim();

    if (company.length < 2) return { error: 'company_required' };
    if (company.length > LIMITS.company) return { error: 'company_too_long' };
    if (name.length < 2) return { error: 'name_required' };
    if (name.length > LIMITS.name) return { error: 'name_too_long' };
    if (!email) return { error: 'email_required' };
    if (email.length > LIMITS.email || !EMAIL_RE.test(email)) return { error: 'invalid_email' };
    let phone = null;
    if (phoneRaw) {
        const digits = phoneRaw.replace(/\D/g, '');
        if (digits.length < 10 || digits.length > 15 || phoneRaw.length > LIMITS.phone) return { error: 'invalid_phone' };
        phone = phoneRaw.trim().startsWith('+') ? `+${digits}` : digits;
    }
    if (!KINDS.includes(kind)) return { error: 'invalid_kind' };
    if (message.length > LIMITS.message) return { error: 'message_too_long' };

    return { value: { company, name, email, phone, kind, message: message || null } };
}

const ERROR_TEXT = {
    company_required: 'Укажите название компании',
    company_too_long: 'Слишком длинное название компании',
    name_required: 'Укажите ваше имя',
    name_too_long: 'Слишком длинное имя',
    email_required: 'Укажите электронную почту',
    invalid_email: 'Проверьте адрес электронной почты',
    invalid_phone: 'Проверьте номер телефона',
    invalid_kind: 'Выберите, кто вы',
    message_too_long: 'Сообщение длиннее 2000 символов',
};

// POST /api/partner-requests (публично, с ограничением частоты)
exports.create = async (req, res) => {
    const body = req.body || {};
    // Ловушка для ботов: скрытое поле website на сайте всегда пустое.
    if (str(body.website)) {
        return res.status(201).json({ ok: true });
    }
    const { value, error } = validatePartnerRequest(body);
    if (error) {
        return res.status(400).json({ error, message: ERROR_TEXT[error] || 'Проверьте поля формы' });
    }
    try {
        await ensureTable();
        const [result] = await db.query(
            `INSERT INTO partner_requests (company, name, email, phone, kind, message, source, ip, user_agent)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                value.company, value.name, value.email, value.phone, value.kind, value.message,
                'web',
                String(req.ip || '').slice(0, 64) || null,
                String(req.get?.('user-agent') || '').slice(0, 255) || null,
            ],
        );
        console.log(`[PARTNER_REQUESTS] new #${result.insertId} kind=${value.kind}`);
        res.status(201).json({ ok: true, id: result.insertId });
    } catch (err) {
        console.error('[PARTNER_REQUESTS] create failed:', err.message);
        res.status(500).json({ error: 'failed_to_create_request', message: 'Не удалось отправить заявку, попробуйте позже' });
    }
};

// GET /api/admin/partner-requests?status=&q=&limit=&offset= (staff)
exports.adminList = async (req, res) => {
    const status = req.query.status ? String(req.query.status) : null;
    if (status && !STATUSES.includes(status)) {
        return res.status(400).json({ error: 'invalid_status' });
    }
    const q = str(req.query.q).slice(0, 100);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    try {
        await ensureTable();
        const where = [];
        const params = [];
        if (status) {
            where.push('status = ?');
            params.push(status);
        }
        if (q) {
            where.push('(company LIKE ? OR name LIKE ? OR email LIKE ? OR phone LIKE ?)');
            const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
            params.push(like, like, like, like);
        }
        const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';

        const [rows] = await db.query(
            `SELECT id, company, name, email, phone, kind, message, status, note, source, created_at, updated_at
             FROM partner_requests${whereSql}
             ORDER BY created_at DESC, id DESC
             LIMIT ? OFFSET ?`,
            [...params, limit, offset],
        );
        const [[{ total }]] = await db.query(`SELECT COUNT(*) AS total FROM partner_requests${whereSql}`, params);
        const [counts] = await db.query('SELECT status, COUNT(*) AS cnt FROM partner_requests GROUP BY status');
        const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
        for (const r of counts) byStatus[r.status] = Number(r.cnt) || 0;

        res.status(200).json({ data: rows, total: Number(total) || 0, counts: byStatus });
    } catch (err) {
        console.error('[PARTNER_REQUESTS] list failed:', err.message);
        res.status(500).json({ error: 'failed_to_list_requests' });
    }
};

// PATCH /api/admin/partner-requests/:id { status?, note? } (staff)
exports.adminUpdate = async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'invalid_id' });
    }
    const body = req.body || {};
    const sets = [];
    const params = [];
    if (body.status !== undefined) {
        if (!STATUSES.includes(body.status)) return res.status(400).json({ error: 'invalid_status' });
        sets.push('status = ?');
        params.push(body.status);
    }
    if (body.note !== undefined) {
        const note = body.note == null ? '' : String(body.note).trim();
        if (note.length > LIMITS.note) return res.status(400).json({ error: 'note_too_long' });
        sets.push('note = ?');
        params.push(note || null);
    }
    if (!sets.length) {
        return res.status(400).json({ error: 'nothing_to_update' });
    }
    try {
        await ensureTable();
        const [result] = await db.query(`UPDATE partner_requests SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'request_not_found' });
        }
        res.status(200).json({ ok: true });
    } catch (err) {
        console.error('[PARTNER_REQUESTS] update failed:', err.message);
        res.status(500).json({ error: 'failed_to_update_request' });
    }
};

// DELETE /api/admin/partner-requests/:id (staff)
exports.adminDelete = async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'invalid_id' });
    }
    try {
        await ensureTable();
        const [result] = await db.query('DELETE FROM partner_requests WHERE id = ?', [id]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'request_not_found' });
        }
        res.status(200).json({ ok: true });
    } catch (err) {
        console.error('[PARTNER_REQUESTS] delete failed:', err.message);
        res.status(500).json({ error: 'failed_to_delete_request' });
    }
};

exports.KINDS = KINDS;
exports.STATUSES = STATUSES;
exports.CREATE_TABLE_SQL = CREATE_TABLE_SQL;
exports.validatePartnerRequest = validatePartnerRequest;
