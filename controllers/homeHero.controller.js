/**
 * Hero-блок главной: заголовок + неограниченный список фоновых изображений.
 *
 * Хранение:
 *   home_hero         — одна строка (id = 1) с заголовком. Колонка image — наследие:
 *                       при первом обращении её значение переносится в home_hero_images.
 *   home_hero_images  — все изображения hero (добавляются, заменяются и удаляются в админке).
 *
 * Публичный GET /api/home-hero при каждом запросе случайно выбирает ОДНО изображение
 * из списка и отдаёт его в поле `image` (формат ответа прежний — сайт менять не нужно).
 * Одно изображение — всегда оно; нет изображений — `image: ''`.
 *
 * `image_mobile` — та же картинка, обрезанная по центру для телефона (`<файл>.m.webp`,
 * lib/heroMobile.js, ~50 КБ вместо ~300 КБ). Создаётся в фоне после загрузки и при первом
 * показе; пока её нет — `''`, и сайт показывает `image`, как раньше.
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('../db');
const { getPublicApiBase } = require('../utils/publicApiBase');
const { createHeroMobileIndex, MOBILE_SUFFIX } = require('../lib/heroMobile');

let heroMobile = createHeroMobileIndex();

const DEFAULT_TITLE = 'Путешествия начинаются здесь';
const UPLOAD_PREFIX = '/uploads/hero/';

function toAbsoluteImage(req, image) {
    if (!image) return '';
    if (/^https?:\/\//i.test(image)) return image;
    return `${getPublicApiBase(req)}${image.startsWith('/') ? '' : '/'}${image}`;
}

function deleteImageFile(imagePath) {
    if (!imagePath || /^https?:\/\//i.test(imagePath)) return;
    const fullPath = path.join(__dirname, '..', imagePath);
    // вместе с оригиналом — его копии: WebP (lib/imageOptimize.js) и мобильная (lib/heroMobile.js)
    for (const file of [fullPath, `${fullPath}.webp`, `${fullPath}${MOBILE_SUFFIX}`]) {
        if (fs.existsSync(file)) {
            try {
                fs.unlinkSync(file);
            } catch (e) {
                /* ignore */
            }
        }
    }
    heroMobile.forget(imagePath);
}

/** Файлы, загруженные multer (single / array / fields), в один список. */
function uploadedFiles(req) {
    if (req.file) return [req.file];
    if (Array.isArray(req.files)) return req.files;
    if (req.files && typeof req.files === 'object') {
        return Object.values(req.files).flat();
    }
    return [];
}

function fileToPath(file) {
    return `${UPLOAD_PREFIX}${file.filename}`;
}

/** Мобильные версии новых картинок — в фоне, ответ админке не ждёт. */
function scheduleMobile(files) {
    for (const file of files) heroMobile.ensure(fileToPath(file)).catch(() => {});
}

/** Если запись в БД не удалась — загруженные файлы не должны остаться мусором на диске. */
function cleanupUploaded(req) {
    for (const file of uploadedFiles(req)) deleteImageFile(fileToPath(file));
}

/** Случайный элемент массива (crypto — равномерно и без «залипания» на одном значении). */
function pickRandom(items) {
    if (!Array.isArray(items) || items.length === 0) return null;
    if (items.length === 1) return items[0];
    return items[crypto.randomInt(items.length)];
}

function mapImage(req, row) {
    return {
        id: row.id,
        image: toAbsoluteImage(req, row.image),
        sort_order: row.sort_order ?? 0,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}

/* ── Таблица изображений ─────────────────────────────────────────────────── */

let ensurePromise = null;

async function createImagesTable() {
    await db.query(`
        CREATE TABLE IF NOT EXISTS home_hero_images (
          id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
          image VARCHAR(500) NOT NULL,
          sort_order INT NOT NULL DEFAULT 0,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          KEY idx_home_hero_images_sort (sort_order, id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Перенос единственного изображения из старой схемы (home_hero.image).
    // Идемпотентно: вставка только если такого пути ещё нет, затем колонка очищается.
    try {
        const [rows] = await db.query('SELECT image FROM home_hero WHERE id = 1 LIMIT 1');
        const legacy = rows[0]?.image;
        if (legacy) {
            await db.query(
                `INSERT INTO home_hero_images (image, sort_order)
                 SELECT ?, 0 FROM DUAL
                 WHERE NOT EXISTS (SELECT 1 FROM home_hero_images WHERE image = ?)`,
                [legacy, legacy],
            );
            await db.query("UPDATE home_hero SET image = '' WHERE id = 1");
        }
    } catch (e) {
        // Таблицы home_hero может не быть (миграция не прогонялась) — переносить нечего.
    }
}

/** Создаёт таблицу при первом обращении (один раз на процесс). */
function ensureImagesTable() {
    if (!ensurePromise) {
        ensurePromise = createImagesTable().catch((err) => {
            ensurePromise = null; // следующая попытка — при следующем запросе
            throw err;
        });
    }
    return ensurePromise;
}

async function listImageRows() {
    await ensureImagesTable();
    const [rows] = await db.query('SELECT * FROM home_hero_images ORDER BY sort_order ASC, id ASC');
    return rows;
}

async function getHeroRow() {
    try {
        const [rows] = await db.query('SELECT * FROM home_hero WHERE id = 1 LIMIT 1');
        if (rows.length > 0) return rows[0];
    } catch (e) {
        /* нет таблицы — заголовок по умолчанию */
    }
    return { id: 1, title: DEFAULT_TITLE, image: '', updated_at: null };
}

async function nextSortOrder() {
    const [rows] = await db.query('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM home_hero_images');
    return Number(rows[0]?.next) || 0;
}

async function insertImages(files) {
    let sortOrder = await nextSortOrder();
    const ids = [];
    for (const file of files) {
        const [result] = await db.query('INSERT INTO home_hero_images (image, sort_order) VALUES (?, ?)', [
            fileToPath(file),
            sortOrder,
        ]);
        ids.push(result.insertId);
        sortOrder += 1;
    }
    return ids;
}

/* ── Публичный API ───────────────────────────────────────────────────────── */

// GET /api/home-hero — заголовок + одно случайное изображение из всех добавленных.
exports.get = async (req, res) => {
    try {
        const [hero, images] = await Promise.all([getHeroRow(), listImageRows()]);
        const picked = pickRandom(images);
        const mobileRel = picked ? await heroMobile.lookup(picked.image) : '';
        // Каждый заход на главную — новый выбор: ответ не кэшируется ни браузером, ни прокси.
        res.set('Cache-Control', 'no-store, max-age=0');
        res.status(200).json({
            data: {
                id: hero.id,
                title: hero.title || DEFAULT_TITLE,
                image: picked ? toAbsoluteImage(req, picked.image) : '',
                image_mobile: mobileRel ? toAbsoluteImage(req, mobileRel) : '',
                image_id: picked ? picked.id : null,
                images_count: images.length,
                updated_at: hero.updated_at,
            },
        });
    } catch (err) {
        res.status(500).json({ message: 'Не удалось загрузить hero-блок.', error: err.message });
    }
};

/* ── Админка ─────────────────────────────────────────────────────────────── */

async function adminPayload(req) {
    const [hero, images] = await Promise.all([getHeroRow(), listImageRows()]);
    const mapped = images.map((row) => mapImage(req, row));
    return {
        id: hero.id,
        title: hero.title || DEFAULT_TITLE,
        // для совместимости со старой админкой — первое изображение списка
        image: mapped[0]?.image || '',
        images: mapped,
        updated_at: hero.updated_at,
    };
}

// GET /api/admin/home-hero — заголовок и все изображения.
exports.getAdmin = async (req, res) => {
    try {
        res.set('Cache-Control', 'no-store');
        res.status(200).json({ data: await adminPayload(req) });
    } catch (err) {
        res.status(500).json({ message: 'Не удалось загрузить hero-блок.', error: err.message });
    }
};

// PUT /api/admin/home-hero — заголовок. Если приложен файл (старая админка) — он ДОБАВЛЯЕТСЯ в список.
exports.update = async (req, res) => {
    const title =
        typeof req.body?.title === 'string' && req.body.title.trim() ? req.body.title.trim() : DEFAULT_TITLE;
    const files = uploadedFiles(req);

    try {
        await ensureImagesTable();
        const [existing] = await db.query('SELECT id FROM home_hero WHERE id = 1 LIMIT 1');
        if (existing.length === 0) {
            await db.query("INSERT INTO home_hero (id, title, image) VALUES (1, ?, '')", [title]);
        } else {
            await db.query('UPDATE home_hero SET title = ? WHERE id = 1', [title]);
        }
        if (files.length) {
            await insertImages(files);
            scheduleMobile(files);
        }

        res.status(200).json({ message: 'Hero-блок сохранён.', data: await adminPayload(req) });
    } catch (err) {
        cleanupUploaded(req);
        res.status(500).json({ message: 'Не удалось сохранить hero-блок.', error: err.message });
    }
};

// GET /api/admin/home-hero/images
exports.listImages = async (req, res) => {
    try {
        const rows = await listImageRows();
        res.set('Cache-Control', 'no-store');
        res.status(200).json({ data: rows.map((row) => mapImage(req, row)) });
    } catch (err) {
        res.status(500).json({ message: 'Не удалось загрузить изображения hero.', error: err.message });
    }
};

// POST /api/admin/home-hero/images — одно (`image`) или несколько (`images`) изображений за раз.
exports.addImages = async (req, res) => {
    const files = uploadedFiles(req);
    if (files.length === 0) {
        return res.status(400).json({ message: 'Загрузите хотя бы одно изображение.' });
    }

    try {
        await ensureImagesTable();
        const ids = await insertImages(files);
        scheduleMobile(files);
        const rows = await listImageRows();
        const all = rows.map((row) => mapImage(req, row));
        res.status(201).json({
            message: files.length === 1 ? 'Изображение добавлено.' : `Добавлено изображений: ${files.length}.`,
            data: all.filter((item) => ids.includes(item.id)),
            images: all,
        });
    } catch (err) {
        cleanupUploaded(req);
        res.status(500).json({ message: 'Не удалось добавить изображения hero.', error: err.message });
    }
};

// PUT /api/admin/home-hero/images/:id — замена файла (и/или порядка).
exports.updateImage = async (req, res) => {
    const id = Number(req.params.id);
    const files = uploadedFiles(req);
    const newImage = files[0] ? fileToPath(files[0]) : null;
    const hasSort = req.body?.sort_order !== undefined && Number.isFinite(Number(req.body.sort_order));

    if (!Number.isInteger(id) || id <= 0) {
        cleanupUploaded(req);
        return res.status(400).json({ message: 'Некорректный id изображения.' });
    }
    if (!newImage && !hasSort) {
        return res.status(400).json({ message: 'Загрузите новое изображение.' });
    }

    try {
        await ensureImagesTable();
        const [rows] = await db.query('SELECT * FROM home_hero_images WHERE id = ? LIMIT 1', [id]);
        if (rows.length === 0) {
            cleanupUploaded(req);
            return res.status(404).json({ message: 'Изображение не найдено.' });
        }

        const sets = [];
        const params = [];
        if (newImage) {
            sets.push('image = ?');
            params.push(newImage);
        }
        if (hasSort) {
            sets.push('sort_order = ?');
            params.push(Math.trunc(Number(req.body.sort_order)));
        }
        params.push(id);
        await db.query(`UPDATE home_hero_images SET ${sets.join(', ')} WHERE id = ?`, params);

        const oldImage = rows[0].image;
        if (newImage && oldImage && oldImage !== newImage) deleteImageFile(oldImage);
        if (newImage) scheduleMobile(files.slice(0, 1));

        const [updated] = await db.query('SELECT * FROM home_hero_images WHERE id = ?', [id]);
        res.status(200).json({ message: 'Изображение заменено.', data: mapImage(req, updated[0]) });
    } catch (err) {
        cleanupUploaded(req);
        res.status(500).json({ message: 'Не удалось заменить изображение hero.', error: err.message });
    }
};

// DELETE /api/admin/home-hero/images/:id
exports.deleteImage = async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ message: 'Некорректный id изображения.' });
    }

    try {
        await ensureImagesTable();
        const [rows] = await db.query('SELECT * FROM home_hero_images WHERE id = ? LIMIT 1', [id]);
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Изображение не найдено.' });
        }
        await db.query('DELETE FROM home_hero_images WHERE id = ?', [id]);
        deleteImageFile(rows[0].image);
        res.status(200).json({ message: 'Изображение удалено.' });
    } catch (err) {
        res.status(500).json({ message: 'Не удалось удалить изображение hero.', error: err.message });
    }
};

// Для скрипта миграции и проверок.
exports.ensureImagesTable = ensureImagesTable;
exports._internal = {
    pickRandom,
    uploadedFiles,
    /** для проверок: подменить состояние мобильных версий */
    setHeroMobile(index) {
        heroMobile = index;
    },
};
