const db = require('../db');

function normalizePhone(raw) {
    const digits = String(raw || '').replace(/\D/g, '');
    if (!digits) return null;
    if (digits.length === 11 && digits.startsWith('8')) {
        return '7' + digits.slice(1);
    }
    if (digits.length === 10) {
        return '7' + digits;
    }
    if (digits.length === 11 && digits.startsWith('7')) {
        return digits;
    }
    return null;
}

function formatPhoneDisplay(digits) {
    if (!digits || digits.length !== 11) return digits;
    return `+7 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7, 9)}-${digits.slice(9, 11)}`;
}

exports.create = async (req, res) => {
    const phone = normalizePhone(req.body?.phone);
    if (!phone) {
        return res.status(400).json({ message: 'Введите корректный российский номер телефона.' });
    }

    try {
        const [result] = await db.query(
            'INSERT INTO callback_requests (phone) VALUES (?)',
            [phone],
        );
        res.status(201).json({
            message: 'Запрос отправлен.',
            id: result.insertId,
        });
    } catch (err) {
        res.status(500).json({ message: 'Не удалось сохранить запрос.', error: err.message });
    }
};

exports.getAll = async (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    try {
        const [rows] = await db.query(
            'SELECT id, phone, created_at FROM callback_requests ORDER BY created_at DESC LIMIT ? OFFSET ?',
            [limit, offset],
        );
        const data = rows.map((row) => ({
            ...row,
            phone_display: formatPhoneDisplay(row.phone),
        }));

        res.status(200).json({ data });
    } catch (err) {
        res.status(500).json({ message: 'Не удалось загрузить заявки.', error: err.message });
    }
};

exports.delete = async (req, res) => {
    const { id } = req.params;
    try {
        const [result] = await db.query('DELETE FROM callback_requests WHERE id = ?', [id]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Заявка не найдена.' });
        }
        res.status(200).json({ message: 'Заявка удалена.' });
    } catch (err) {
        res.status(500).json({ message: 'Не удалось удалить заявку.', error: err.message });
    }
};
