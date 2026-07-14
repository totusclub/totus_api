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

async function getSectionsRow() {
    const [rows] = await db.query('SELECT * FROM home_sections WHERE id = 1 LIMIT 1');
    if (rows[0]) return rows[0];
    return {
        id: 1,
        recommended_title: 'Начните планирование путешествия здесь',
        destinations_title: 'Популярные направления',
    };
}

function mapHotel(req, row) {
    return {
        id: row.id,
        hotel_id: row.hotel_id,
        name: row.name,
        rate: row.rate,
        city: row.city,
        price: row.price,
        review: row.review,
        image: toAbsoluteImage(req, row.image),
        sort_order: row.sort_order,
    };
}

function mapDestination(req, row) {
    return {
        id: row.id,
        name: row.name,
        image: toAbsoluteImage(req, row.image),
        to_country: row.to_country,
        sort_order: row.sort_order,
    };
}

exports.getHomeData = async (req, res) => {
    try {
        const sections = await getSectionsRow();
        const [hotels] = await db.query(
            'SELECT * FROM home_recommended_hotels ORDER BY sort_order ASC, id ASC',
        );
        const [destinations] = await db.query(
            'SELECT * FROM home_popular_destinations ORDER BY sort_order ASC, id ASC',
        );

        res.json({
            recommendedTitle: sections.recommended_title,
            destinationsTitle: sections.destinations_title,
            recomendHotels: hotels.map((row) => ({
                id: row.hotel_id,
                name: row.name,
                rate: row.rate,
                city: row.city,
                price: row.price,
                review: row.review,
                image: toAbsoluteImage(req, row.image),
            })),
            popularDestinations: destinations.map((row) => ({
                id: row.id,
                name: row.name,
                image: toAbsoluteImage(req, row.image),
                to_country: row.to_country,
            })),
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load home data', message: err.message });
    }
};

exports.getSections = async (req, res) => {
    try {
        const sections = await getSectionsRow();
        res.status(200).json({ data: sections });
    } catch (err) {
        res.status(500).json({ message: 'Не удалось загрузить настройки.', error: err.message });
    }
};

exports.updateSections = async (req, res) => {
    const recommendedTitle =
        typeof req.body?.recommended_title === 'string' && req.body.recommended_title.trim()
            ? req.body.recommended_title.trim()
            : 'Начните планирование путешествия здесь';
    const destinationsTitle =
        typeof req.body?.destinations_title === 'string' && req.body.destinations_title.trim()
            ? req.body.destinations_title.trim()
            : 'Популярные направления';

    try {
        const [existing] = await db.query('SELECT id FROM home_sections WHERE id = 1 LIMIT 1');
        if (existing.length === 0) {
            await db.query(
                'INSERT INTO home_sections (id, recommended_title, destinations_title) VALUES (1, ?, ?)',
                [recommendedTitle, destinationsTitle],
            );
        } else {
            await db.query(
                'UPDATE home_sections SET recommended_title = ?, destinations_title = ? WHERE id = 1',
                [recommendedTitle, destinationsTitle],
            );
        }
        const sections = await getSectionsRow();
        res.status(200).json({ message: 'Настройки сохранены.', data: sections });
    } catch (err) {
        res.status(500).json({ message: 'Не удалось сохранить настройки.', error: err.message });
    }
};

exports.getHotels = async (req, res) => {
    try {
        const [rows] = await db.query(
            'SELECT * FROM home_recommended_hotels ORDER BY sort_order ASC, id ASC',
        );
        res.status(200).json({ data: rows.map((row) => mapHotel(req, row)) });
    } catch (err) {
        res.status(500).json({ message: 'Не удалось загрузить отели.', error: err.message });
    }
};

exports.createHotel = async (req, res) => {
    const hotelId = req.body?.hotel_id;
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const rate = Number(req.body?.rate) || 5;
    const city = typeof req.body?.city === 'string' ? req.body.city.trim() : '';
    const price = Number(req.body?.price) || 0;
    const review = Number(req.body?.review) || 0;
    const sortOrder = Number(req.body?.sort_order) || 0;
    const uploadedImage = req.file ? `/uploads/hotels/${req.file.filename}` : '';
    const imageUrl = typeof req.body?.image_url === 'string' ? req.body.image_url.trim() : '';
    const image = uploadedImage || imageUrl;

    if (!hotelId || !name || !image) {
        return res.status(400).json({ message: 'ID отеля, название и изображение обязательны.' });
    }
    try {
        const [result] = await db.query(
            `INSERT INTO home_recommended_hotels
             (hotel_id, name, rate, city, price, review, image, sort_order)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [Number(hotelId), name, rate, city, price, review, image, sortOrder],
        );
        const [rows] = await db.query('SELECT * FROM home_recommended_hotels WHERE id = ?', [result.insertId]);
        res.status(201).json({ message: 'Отель добавлен.', data: mapHotel(req, rows[0]) });
    } catch (err) {
        res.status(500).json({ message: 'Не удалось добавить отель.', error: err.message });
    }
};

exports.updateHotel = async (req, res) => {
    const { id } = req.params;
    const hotelId = req.body?.hotel_id;
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const rate = Number(req.body?.rate) || 5;
    const city = typeof req.body?.city === 'string' ? req.body.city.trim() : '';
    const price = Number(req.body?.price) || 0;
    const review = Number(req.body?.review) || 0;
    const sortOrder = Number(req.body?.sort_order) || 0;
    const newImage = req.file ? `/uploads/hotels/${req.file.filename}` : null;
    const imageUrl = typeof req.body?.image_url === 'string' ? req.body.image_url.trim() : '';

    if (!name) {
        return res.status(400).json({ message: 'Название обязательно.' });
    }

    try {
        const [existing] = await db.query('SELECT * FROM home_recommended_hotels WHERE id = ? LIMIT 1', [id]);
        if (existing.length === 0) {
            return res.status(404).json({ message: 'Отель не найден.' });
        }

        const oldImage = existing[0].image;
        const image = newImage || imageUrl || oldImage;
        if (!image) {
            return res.status(400).json({ message: 'Изображение обязательно.' });
        }

        await db.query(
            `UPDATE home_recommended_hotels
             SET hotel_id = ?, name = ?, rate = ?, city = ?, price = ?, review = ?, image = ?, sort_order = ?
             WHERE id = ?`,
            [Number(hotelId), name, rate, city, price, review, image, sortOrder, id],
        );

        if (newImage && oldImage && oldImage !== newImage) {
            deleteImageFile(oldImage);
        }

        const [rows] = await db.query('SELECT * FROM home_recommended_hotels WHERE id = ?', [id]);
        res.status(200).json({ message: 'Отель сохранён.', data: mapHotel(req, rows[0]) });
    } catch (err) {
        res.status(500).json({ message: 'Не удалось сохранить отель.', error: err.message });
    }
};

exports.deleteHotel = async (req, res) => {
    const { id } = req.params;
    try {
        const [rows] = await db.query('SELECT * FROM home_recommended_hotels WHERE id = ? LIMIT 1', [id]);
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Отель не найден.' });
        }
        await db.query('DELETE FROM home_recommended_hotels WHERE id = ?', [id]);
        deleteImageFile(rows[0].image);
        res.status(200).json({ message: 'Отель удалён.' });
    } catch (err) {
        res.status(500).json({ message: 'Не удалось удалить отель.', error: err.message });
    }
};

exports.getDestinations = async (req, res) => {
    try {
        const [rows] = await db.query(
            'SELECT * FROM home_popular_destinations ORDER BY sort_order ASC, id ASC',
        );
        res.status(200).json({ data: rows.map((row) => mapDestination(req, row)) });
    } catch (err) {
        res.status(500).json({ message: 'Не удалось загрузить направления.', error: err.message });
    }
};

exports.createDestination = async (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const toCountry = typeof req.body?.to_country === 'string' ? req.body.to_country.trim().toUpperCase() : '';
    const sortOrder = Number(req.body?.sort_order) || 0;
    const uploadedImage = req.file ? `/uploads/destinations/${req.file.filename}` : '';
    const imageUrl = typeof req.body?.image_url === 'string' ? req.body.image_url.trim() : '';
    const image = uploadedImage || imageUrl;

    if (!name || !toCountry || !image) {
        return res.status(400).json({ message: 'Название, страна и изображение обязательны.' });
    }

    try {
        const [result] = await db.query(
            'INSERT INTO home_popular_destinations (name, image, to_country, sort_order) VALUES (?, ?, ?, ?)',
            [name, image, toCountry, sortOrder],
        );
        const [rows] = await db.query('SELECT * FROM home_popular_destinations WHERE id = ?', [result.insertId]);
        res.status(201).json({ message: 'Направление добавлено.', data: mapDestination(req, rows[0]) });
    } catch (err) {
        res.status(500).json({ message: 'Не удалось добавить направление.', error: err.message });
    }
};

exports.updateDestination = async (req, res) => {
    const { id } = req.params;
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const toCountry = typeof req.body?.to_country === 'string' ? req.body.to_country.trim().toUpperCase() : '';
    const sortOrder = Number(req.body?.sort_order) || 0;
    const newImage = req.file ? `/uploads/destinations/${req.file.filename}` : null;
    const imageUrl = typeof req.body?.image_url === 'string' ? req.body.image_url.trim() : '';

    if (!name || !toCountry) {
        return res.status(400).json({ message: 'Название и страна обязательны.' });
    }

    try {
        const [existing] = await db.query('SELECT * FROM home_popular_destinations WHERE id = ? LIMIT 1', [id]);
        if (existing.length === 0) {
            return res.status(404).json({ message: 'Направление не найдено.' });
        }

        const oldImage = existing[0].image;
        const image = newImage || imageUrl || oldImage;

        await db.query(
            'UPDATE home_popular_destinations SET name = ?, image = ?, to_country = ?, sort_order = ? WHERE id = ?',
            [name, image, toCountry, sortOrder, id],
        );

        if (newImage && oldImage && oldImage !== newImage) {
            deleteImageFile(oldImage);
        }

        const [rows] = await db.query('SELECT * FROM home_popular_destinations WHERE id = ?', [id]);
        res.status(200).json({ message: 'Направление сохранено.', data: mapDestination(req, rows[0]) });
    } catch (err) {
        res.status(500).json({ message: 'Не удалось сохранить направление.', error: err.message });
    }
};

exports.deleteDestination = async (req, res) => {
    const { id } = req.params;
    try {
        const [rows] = await db.query('SELECT * FROM home_popular_destinations WHERE id = ? LIMIT 1', [id]);
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Направление не найдено.' });
        }
        await db.query('DELETE FROM home_popular_destinations WHERE id = ?', [id]);
        deleteImageFile(rows[0].image);
        res.status(200).json({ message: 'Направление удалено.' });
    } catch (err) {
        res.status(500).json({ message: 'Не удалось удалить направление.', error: err.message });
    }
};
