const path = require('path');
const fs = require('fs');
const db = require('../db');
const { getPublicApiBase } = require('../utils/publicApiBase');

function toAbsoluteImage(req, image) {
    if (!image) return '';
    if (/^https?:\/\//i.test(image)) return image;
    return `${getPublicApiBase(req)}${image.startsWith('/') ? '' : '/'}${image}`;
}

function deleteImageFile(imagePath) {
    if (!imagePath || /^https?:\/\//i.test(imagePath)) return;
    const fullPath = path.join(__dirname, '..', imagePath);
    if (fs.existsSync(fullPath)) {
        try {
            fs.unlinkSync(fullPath);
        } catch (e) {
            /* ignore */
        }
    }
}

function mapPartner(req, row) {
    return {
        id: row.id,
        name: row.name || '',
        image: toAbsoluteImage(req, row.image),
        url: row.url || '',
        sort_order: row.sort_order ?? 0,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}

exports.getAll = async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM home_partners ORDER BY sort_order ASC, id ASC');
        res.status(200).json({ data: rows.map((row) => mapPartner(req, row)) });
    } catch (err) {
        res.status(500).json({ message: 'Не удалось загрузить партнёров.', error: err.message });
    }
};

exports.create = async (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    const sortOrder = Number.isFinite(Number(req.body?.sort_order)) ? Number(req.body.sort_order) : 0;
    const image = req.file ? `/uploads/partners/${req.file.filename}` : '';

    if (!image) {
        return res.status(400).json({ message: 'Загрузите логотип партнёра.' });
    }

    try {
        const [result] = await db.query(
            'INSERT INTO home_partners (name, image, url, sort_order) VALUES (?, ?, ?, ?)',
            [name, image, url, sortOrder],
        );
        const [rows] = await db.query('SELECT * FROM home_partners WHERE id = ?', [result.insertId]);
        res.status(201).json({ message: 'Партнёр добавлен.', data: mapPartner(req, rows[0]) });
    } catch (err) {
        res.status(500).json({ message: 'Не удалось добавить партнёра.', error: err.message });
    }
};

exports.update = async (req, res) => {
    const { id } = req.params;
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    const sortOrder = Number.isFinite(Number(req.body?.sort_order)) ? Number(req.body.sort_order) : 0;
    const newImage = req.file ? `/uploads/partners/${req.file.filename}` : null;

    try {
        const [rows] = await db.query('SELECT * FROM home_partners WHERE id = ? LIMIT 1', [id]);
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Партнёр не найден.' });
        }

        const oldImage = rows[0].image;
        let query = 'UPDATE home_partners SET name = ?, url = ?, sort_order = ?';
        const params = [name, url, sortOrder];

        if (newImage) {
            query += ', image = ?';
            params.push(newImage);
        }
        query += ' WHERE id = ?';
        params.push(id);

        await db.query(query, params);

        if (newImage && oldImage && oldImage !== newImage) {
            deleteImageFile(oldImage);
        }

        const [updated] = await db.query('SELECT * FROM home_partners WHERE id = ?', [id]);
        res.status(200).json({ message: 'Партнёр сохранён.', data: mapPartner(req, updated[0]) });
    } catch (err) {
        res.status(500).json({ message: 'Не удалось сохранить партнёра.', error: err.message });
    }
};

exports.delete = async (req, res) => {
    const { id } = req.params;
    try {
        const [rows] = await db.query('SELECT * FROM home_partners WHERE id = ? LIMIT 1', [id]);
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Партнёр не найден.' });
        }

        await db.query('DELETE FROM home_partners WHERE id = ?', [id]);
        deleteImageFile(rows[0].image);
        res.status(200).json({ message: 'Партнёр удалён.' });
    } catch (err) {
        res.status(500).json({ message: 'Не удалось удалить партнёра.', error: err.message });
    }
};
