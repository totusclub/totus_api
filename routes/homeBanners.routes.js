const express = require('express');
const publicRouter = express.Router();
const adminRouter = express.Router();
const controller = require('../controllers/homeBanners.controller');
const uploadBanner = require('../middleware/uploadBanner');

publicRouter.get('/home-banners', controller.getAll);

adminRouter.get('/home-banners', controller.getAll);
// image — картинка для светлой темы, image_dark — для тёмной (каждая необязательна).
adminRouter.put(
    '/home-banners/:position',
    uploadBanner.fields([
        { name: 'image', maxCount: 1 },
        { name: 'image_dark', maxCount: 1 },
    ]),
    controller.update,
);

module.exports = { publicRouter, adminRouter };
