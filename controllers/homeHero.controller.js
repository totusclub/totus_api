const path = require('path');
const fs = require('fs');
const db = require('../db');
const { getPublicApiBase } = require('../utils/publicApiBase');

const DEFAULT_TITLE = 'Путешествия начинаются здесь';

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

function mapHero(req, row) {
    return {
        id: row.id,
        title: row.title || DEFAULT_TITLE,
        image: toAbsoluteImage(req, row.image),
        updated_at: row.updated_at,
    };
}

async function getHeroRow() {
    const [rows] = await db.query('SELECT * FROM home_hero WHERE id = 1 LIMIT 1');
    if (rows.length > 0) return rows[0];
    return { id: 1, title: DEFAULT_TITLE, image: '', updated_at: null };
}

exports.get = async (req, res) => {
    try {
        const row = await getHeroRow();
        res.status(200).json({ data: mapHero(req, row) });
    } catch (err) {
        res.status(500).json({ message: 'Не удалось загрузить hero-блок.', error: err.message });
    }
};

exports.update = async (req, res) => {
    const title =
        typeof req.body?.title === 'string' && req.body.title.trim()
            ? req.body.title.trim()
            : DEFAULT_TITLE;
    const newImage = req.file ? `/uploads/hero/${req.file.filename}` : null;

    try {
        const [existing] = await db.query('SELECT * FROM home_hero WHERE id = 1 LIMIT 1');

        if (existing.length === 0) {
            await db.query('INSERT INTO home_hero (id, title, image) VALUES (1, ?, ?)', [
                title,
                newImage || '',
            ]);
        } else {
            const oldImage = existing[0].image;
            let query = 'UPDATE home_hero SET title = ?';
            const params = [title];

            if (newImage) {
                query += ', image = ?';
                params.push(newImage);
            }
            query += ' WHERE id = 1';

            await db.query(query, params);

            if (newImage && oldImage && oldImage !== newImage) {
                deleteImageFile(oldImage);
            }
        }

        const [updated] = await db.query('SELECT * FROM home_hero WHERE id = 1 LIMIT 1');
        res.status(200).json({ message: 'Hero-блок сохранён.', data: mapHero(req, updated[0]) });
    } catch (err) {
        res.status(500).json({ message: 'Не удалось сохранить hero-блок.', error: err.message });
    }
};
