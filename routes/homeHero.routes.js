const express = require('express');
const publicRouter = express.Router();
const adminRouter = express.Router();
const controller = require('../controllers/homeHero.controller');
const uploadHero = require('../middleware/uploadHero');

/** Сколько изображений можно загрузить одним запросом (всего в списке — без ограничения). */
const MAX_FILES_PER_REQUEST = 20;

/**
 * Ошибки загрузки (не тот тип файла, слишком большой файл) — понятным JSON 400,
 * а не стандартной HTML-страницей 500 от Express.
 */
function withUpload(middleware) {
    return (req, res, next) => {
        middleware(req, res, (err) => {
            if (!err) return next();
            let message = err.message || 'Не удалось загрузить файл.';
            if (err.code === 'LIMIT_FILE_SIZE') message = 'Файл слишком большой (максимум 15 МБ).';
            if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
                message = `За один раз можно загрузить не больше ${MAX_FILES_PER_REQUEST} изображений.`;
            }
            if (message === 'Only image files are allowed.') message = 'Можно загружать только JPG, PNG или WEBP.';
            return res.status(400).json({ message });
        });
    };
}

const singleImage = withUpload(uploadHero.single('image'));
const manyImages = withUpload(
    uploadHero.fields([
        { name: 'image', maxCount: 1 },
        { name: 'images', maxCount: MAX_FILES_PER_REQUEST },
    ]),
);

// Сайт: заголовок + одно случайное изображение из списка.
publicRouter.get('/home-hero', controller.get);

// Админка.
adminRouter.get('/home-hero', controller.getAdmin);
adminRouter.put('/home-hero', singleImage, controller.update);
adminRouter.get('/home-hero/images', controller.listImages);
adminRouter.post('/home-hero/images', manyImages, controller.addImages);
adminRouter.put('/home-hero/images/:id', singleImage, controller.updateImage);
adminRouter.delete('/home-hero/images/:id', controller.deleteImage);

module.exports = { publicRouter, adminRouter };
