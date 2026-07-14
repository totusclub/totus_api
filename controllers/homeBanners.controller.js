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

function mapBanner(req, row) {
    return {
        id: row.id,
        position: row.position,
        image: toAbsoluteImage(req, row.image),
        url: row.url || '',
        updated_at: row.updated_at,
    };
}

exports.getAll = async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM home_banners ORDER BY position ASC');
        res.status(200).json({ data: rows.map((row) => mapBanner(req, row)) });
    } catch (err) {
        res.status(500).json({ message: 'Не удалось загрузить баннеры.', error: err.message });
    }
};

exports.update = async (req, res) => {
    const position = parseInt(req.params.position, 10);
    if (position !== 1 && position !== 2) {
        return res.status(400).json({ message: 'Недопустимый слот баннера (доступны 1 и 2).' });
    }

    const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    const newImage = req.file ? `/uploads/banners/${req.file.filename}` : null;

    try {
        const [rows] = await db.query('SELECT * FROM home_banners WHERE position = ? LIMIT 1', [position]);
        if (rows.length === 0) {
            await db.query(
                'INSERT INTO home_banners (position, image, url) VALUES (?, ?, ?)',
                [position, newImage || '', url],
            );
            const [created] = await db.query('SELECT * FROM home_banners WHERE position = ? LIMIT 1', [position]);
            return res.status(201).json({ message: 'Баннер сохранён.', data: mapBanner(req, created[0]) });
        }

        const oldImage = rows[0].image;
        let query = 'UPDATE home_banners SET url = ?';
        const params = [url];

        if (newImage) {
            query += ', image = ?';
            params.push(newImage);
        }
        query += ' WHERE position = ?';
        params.push(position);

        await db.query(query, params);

        if (newImage && oldImage && oldImage !== newImage) {
            deleteImageFile(oldImage);
        }

        const [updated] = await db.query('SELECT * FROM home_banners WHERE position = ? LIMIT 1', [position]);
        res.status(200).json({ message: 'Баннер сохранён.', data: mapBanner(req, updated[0]) });
    } catch (err) {
        res.status(500).json({ message: 'Не удалось сохранить баннер.', error: err.message });
    }
};
