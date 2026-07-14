const db = require('../db');

const ALLOWED_ICONS = new Set([
    'vk',
    'rutube',
    'aiStar',
    'vc',
    'instagram',
    'fb',
    'x',
    'youtube',
]);

function mapRow(row) {
    return {
        id: row.id,
        title: row.title || '',
        icon: row.icon || '',
        url: row.url || '',
        sort_order: row.sort_order ?? 0,
        is_active: Boolean(row.is_active),
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}

function normalizeIcon(icon) {
    const value = typeof icon === 'string' ? icon.trim() : '';
    if (!ALLOWED_ICONS.has(value)) {
        return null;
    }
    return value;
}

exports.getPublic = async (req, res) => {
    try {
        const [rows] = await db.query(
            'SELECT * FROM footer_social_links WHERE is_active = 1 ORDER BY sort_order ASC, id ASC',
        );
        res.status(200).json({ data: rows.map(mapRow) });
    } catch (err) {
        res.status(500).json({ message: 'Не удалось загрузить соцсети.', error: err.message });
    }
};

exports.getAll = async (req, res) => {
    try {
        const [rows] = await db.query(
            'SELECT * FROM footer_social_links ORDER BY sort_order ASC, id ASC',
        );
        res.status(200).json({ data: rows.map(mapRow) });
    } catch (err) {
        res.status(500).json({ message: 'Не удалось загрузить соцсети.', error: err.message });
    }
};

exports.create = async (req, res) => {
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    const icon = normalizeIcon(req.body?.icon);
    const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    const sortOrder = Number(req.body?.sort_order) || 0;
    const isActive = req.body?.is_active === false || req.body?.is_active === '0' ? 0 : 1;

    if (!icon) {
        return res.status(400).json({ message: 'Выберите иконку соцсети.' });
    }

    try {
        const [result] = await db.query(
            'INSERT INTO footer_social_links (title, icon, url, sort_order, is_active) VALUES (?, ?, ?, ?, ?)',
            [title, icon, url, sortOrder, isActive],
        );
        const [rows] = await db.query('SELECT * FROM footer_social_links WHERE id = ?', [result.insertId]);
        res.status(201).json({ message: 'Соцсеть добавлена.', data: mapRow(rows[0]) });
    } catch (err) {
        res.status(500).json({ message: 'Не удалось добавить соцсеть.', error: err.message });
    }
};

exports.update = async (req, res) => {
    const { id } = req.params;
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    const icon = normalizeIcon(req.body?.icon);
    const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    const sortOrder = Number(req.body?.sort_order) || 0;
    const isActive = req.body?.is_active === false || req.body?.is_active === '0' ? 0 : 1;

    if (!icon) {
        return res.status(400).json({ message: 'Выберите иконку соцсети.' });
    }

    try {
        const [result] = await db.query(
            'UPDATE footer_social_links SET title = ?, icon = ?, url = ?, sort_order = ?, is_active = ? WHERE id = ?',
            [title, icon, url, sortOrder, isActive, id],
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Запись не найдена.' });
        }
        const [rows] = await db.query('SELECT * FROM footer_social_links WHERE id = ?', [id]);
        res.status(200).json({ message: 'Соцсеть сохранена.', data: mapRow(rows[0]) });
    } catch (err) {
        res.status(500).json({ message: 'Не удалось сохранить соцсеть.', error: err.message });
    }
};

exports.remove = async (req, res) => {
    const { id } = req.params;
    try {
        const [result] = await db.query('DELETE FROM footer_social_links WHERE id = ?', [id]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Запись не найдена.' });
        }
        res.status(200).json({ message: 'Соцсеть удалена.' });
    } catch (err) {
        res.status(500).json({ message: 'Не удалось удалить соцсеть.', error: err.message });
    }
};

exports.getAllowedIcons = async (req, res) => {
    res.status(200).json({ data: Array.from(ALLOWED_ICONS) });
};
