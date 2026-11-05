const path = require('path');
const fs = require('fs');
const db = require('../db');
const { getPublicApiBase } = require('../utils/publicApiBase');

/**
 * Два баннера под поиском на главной (position 1 и 2), у каждого — свои ссылка и картинки:
 * `image` — для светлой темы сайта, `image_dark` — для тёмной. Хранятся независимо.
 * Нет картинки для тёмной темы — сайт показывает светлую; нет ни одной — стандартную
 * картинку сайта (totus_WEB, home.module.css).
 */

function toAbsoluteImage(req, image) {
    if (!image) return '';
    if (/^https?:\/\//i.test(image)) return image;
    return `${getPublicApiBase(req)}${image.startsWith('/') ? '' : '/'}${image}`;
}

function deleteImageFile(imagePath) {
    if (!imagePath || /^https?:\/\//i.test(imagePath)) return;
    const fullPath = path.join(__dirname, '..', imagePath);
    // Вместе с файлом — его WebP-копия (lib/imageOptimize.js), если есть.
    for (const file of [fullPath, `${fullPath}.webp`]) {
        if (fs.existsSync(file)) {
            try {
                fs.unlinkSync(file);
            } catch (e) {
                /* ignore */
            }
        }
    }
}

function mapBanner(req, row) {
    return {
        id: row.id,
        position: row.position,
        image: toAbsoluteImage(req, row.image),
        image_dark: toAbsoluteImage(req, row.image_dark),
        url: row.url || '',
        updated_at: row.updated_at,
    };
}

/** Файл из multer: fields (`image`, `image_dark`) или старый single (`image`). */
function uploaded(req, field) {
    const fromFields = req.files && Array.isArray(req.files[field]) ? req.files[field][0] : null;
    if (fromFields) return fromFields;
    if (field === 'image' && req.file) return req.file;
    return null;
}

function flag(value) {
    return value === '1' || value === 'true' || value === true;
}

function cleanupUploads(req) {
    for (const field of ['image', 'image_dark']) {
        const file = uploaded(req, field);
        if (file) deleteImageFile(`/uploads/banners/${file.filename}`);
    }
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
        cleanupUploads(req);
        return res.status(400).json({ message: 'Недопустимый слот баннера (доступны 1 и 2).' });
    }

    const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    const lightFile = uploaded(req, 'image');
    const darkFile = uploaded(req, 'image_dark');
    const newImage = lightFile ? `/uploads/banners/${lightFile.filename}` : null;
    const newImageDark = darkFile ? `/uploads/banners/${darkFile.filename}` : null;
    // «Убрать картинку»: светлая → стандартная картинка сайта, тёмная → светлая.
    const removeImage = !newImage && flag(req.body?.remove_image);
    const removeImageDark = !newImageDark && flag(req.body?.remove_image_dark);
    const touchesDark = Boolean(newImageDark) || removeImageDark;
    let written = false; // новые файлы уже записаны в БД — при ошибке их не удаляем

    try {
        const [rows] = await db.query('SELECT * FROM home_banners WHERE position = ? LIMIT 1', [position]);
        if (rows.length === 0) {
            if (touchesDark) {
                await db.query(
                    'INSERT INTO home_banners (position, image, image_dark, url) VALUES (?, ?, ?, ?)',
                    [position, newImage || '', newImageDark || '', url],
                );
            } else {
                await db.query(
                    'INSERT INTO home_banners (position, image, url) VALUES (?, ?, ?)',
                    [position, newImage || '', url],
                );
            }
            written = true;
            const [created] = await db.query('SELECT * FROM home_banners WHERE position = ? LIMIT 1', [position]);
            return res.status(201).json({ message: 'Баннер сохранён.', data: mapBanner(req, created[0]) });
        }

        const oldImage = rows[0].image;
        const oldImageDark = rows[0].image_dark;
        let query = 'UPDATE home_banners SET url = ?';
        const params = [url];

        if (newImage || removeImage) {
            query += ', image = ?';
            params.push(newImage || '');
        }
        // Колонку image_dark трогаем, только когда меняется тёмная картинка: до миграции
        // (scripts/migrate-home-banners.js) ссылка и светлая картинка сохраняются как раньше.
        if (touchesDark) {
            query += ', image_dark = ?';
            params.push(newImageDark || '');
        }
        query += ' WHERE position = ?';
        params.push(position);

        await db.query(query, params);
        written = true;

        if ((newImage || removeImage) && oldImage && oldImage !== newImage) {
            deleteImageFile(oldImage);
        }
        if (touchesDark && oldImageDark && oldImageDark !== newImageDark) {
            deleteImageFile(oldImageDark);
        }

        const [updated] = await db.query('SELECT * FROM home_banners WHERE position = ? LIMIT 1', [position]);
        res.status(200).json({ message: 'Баннер сохранён.', data: mapBanner(req, updated[0]) });
    } catch (err) {
        if (!written) cleanupUploads(req);
        if (err && err.code === 'ER_BAD_FIELD_ERROR' && /image_dark/.test(String(err.message))) {
            return res.status(500).json({
                message: 'Картинки для тёмной темы ещё не включены на сервере: нужна миграция node scripts/migrate-home-banners.js.',
                error: err.message,
            });
        }
        res.status(500).json({ message: 'Не удалось сохранить баннер.', error: err.message });
    }
};
