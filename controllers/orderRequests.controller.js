const db = require('../db');

const REQUEST_TYPES = ['cancel', 'message'];
const STATUSES = ['new', 'in_progress', 'done', 'rejected'];
const MESSAGE_MAX_LENGTH = 2000;

// POST /api/order-requests (user)
exports.createRequest = async (req, res) => {
    const userId = Number(req.authUser.id);
    const orderId = String(req.body?.order_id ?? '').trim();
    const type = req.body?.type;
    let message = req.body?.message == null ? null : String(req.body.message).trim();

    if (!orderId) {
        return res.status(400).json({ error: 'order_id_required' });
    }
    if (!REQUEST_TYPES.includes(type)) {
        return res.status(400).json({ error: 'invalid_type' });
    }
    if (type === 'message' && !message) {
        return res.status(400).json({ error: 'message_required' });
    }
    if (message && message.length > MESSAGE_MAX_LENGTH) {
        return res.status(400).json({ error: 'message_too_long' });
    }
    if (!message) message = null;

    try {
        const [orders] = await db.query(
            'SELECT id FROM orders WHERE order_id = ? AND user_id = ? LIMIT 1',
            [orderId, userId],
        );
        if (orders.length === 0) {
            return res.status(404).json({ error: 'order_not_found' });
        }

        if (type === 'cancel') {
            const [existing] = await db.query(
                "SELECT id FROM order_requests WHERE order_id = ? AND type = 'cancel' AND status IN ('new','in_progress') LIMIT 1",
                [orderId],
            );
            if (existing.length > 0) {
                return res.status(409).json({ error: 'cancel_request_exists' });
            }
        }

        const [result] = await db.query(
            'INSERT INTO order_requests (order_id, user_id, type, message) VALUES (?, ?, ?, ?)',
            [orderId, userId, type, message],
        );
        res.status(201).json({ ok: true, id: result.insertId });
    } catch (err) {
        console.error('Error creating order request:', err.message);
        res.status(500).json({ error: 'failed_to_create_request' });
    }
};

// GET /api/order-requests?order_id= (user)
exports.listMyRequests = async (req, res) => {
    const userId = Number(req.authUser.id);
    const orderId = req.query.order_id ? String(req.query.order_id).trim() : null;

    try {
        const params = [userId];
        let sql = 'SELECT id, order_id, type, message, status, created_at FROM order_requests WHERE user_id = ?';
        if (orderId) {
            sql += ' AND order_id = ?';
            params.push(orderId);
        }
        sql += ' ORDER BY created_at DESC, id DESC';

        const [rows] = await db.query(sql, params);
        res.status(200).json({ data: rows });
    } catch (err) {
        console.error('Error listing order requests:', err.message);
        res.status(500).json({ error: 'failed_to_list_requests' });
    }
};

// GET /api/admin/order-requests?status=&limit=&offset= (staff)
exports.adminList = async (req, res) => {
    const status = req.query.status ? String(req.query.status) : null;
    if (status && !STATUSES.includes(status)) {
        return res.status(400).json({ error: 'invalid_status' });
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    try {
        const params = [];
        let where = '';
        if (status) {
            where = ' WHERE r.status = ?';
            params.push(status);
        }

        const [rows] = await db.query(
            `SELECT r.id, r.order_id, r.user_id, r.type, r.message, r.status, r.created_at, r.updated_at,
                    u.name AS user_name, u.l_name AS user_l_name, u.email AS user_email, u.phone AS user_phone
             FROM order_requests r
             LEFT JOIN users u ON u.id = r.user_id
             ${where}
             ORDER BY r.created_at DESC, r.id DESC
             LIMIT ? OFFSET ?`,
            [...params, limit, offset],
        );
        const [[{ total }]] = await db.query(
            `SELECT COUNT(*) AS total FROM order_requests r${where}`,
            params,
        );

        res.status(200).json({ data: rows, total });
    } catch (err) {
        console.error('Error listing order requests (admin):', err.message);
        res.status(500).json({ error: 'failed_to_list_requests' });
    }
};

// PATCH /api/admin/order-requests/:id { status } (staff)
exports.adminUpdateStatus = async (req, res) => {
    const id = Number(req.params.id);
    const status = req.body?.status;

    if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'invalid_id' });
    }
    if (!STATUSES.includes(status)) {
        return res.status(400).json({ error: 'invalid_status' });
    }

    try {
        const [result] = await db.query(
            'UPDATE order_requests SET status = ? WHERE id = ?',
            [status, id],
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'request_not_found' });
        }
        res.status(200).json({ ok: true });
    } catch (err) {
        console.error('Error updating order request status:', err.message);
        res.status(500).json({ error: 'failed_to_update_request' });
    }
};
