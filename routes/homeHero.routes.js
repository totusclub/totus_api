const express = require('express');
const publicRouter = express.Router();
const adminRouter = express.Router();
const controller = require('../controllers/homeHero.controller');
const uploadHero = require('../middleware/uploadHero');

publicRouter.get('/home-hero', controller.get);

adminRouter.get('/home-hero', controller.get);
adminRouter.put('/home-hero', uploadHero.single('image'), controller.update);

module.exports = { publicRouter, adminRouter };
