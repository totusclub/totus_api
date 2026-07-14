const express = require('express');
const publicRouter = express.Router();
const adminRouter = express.Router();
const controller = require('../controllers/homeBanners.controller');
const uploadBanner = require('../middleware/uploadBanner');

publicRouter.get('/home-banners', controller.getAll);

adminRouter.get('/home-banners', controller.getAll);
adminRouter.put('/home-banners/:position', uploadBanner.single('image'), controller.update);

module.exports = { publicRouter, adminRouter };
