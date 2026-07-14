const express = require('express');
const publicRouter = express.Router();
const adminRouter = express.Router();
const controller = require('../controllers/homePartners.controller');
const uploadPartner = require('../middleware/uploadPartner');

publicRouter.get('/home-partners', controller.getAll);

adminRouter.get('/home-partners', controller.getAll);
adminRouter.post('/home-partners', uploadPartner.single('image'), controller.create);
adminRouter.put('/home-partners/:id', uploadPartner.single('image'), controller.update);
adminRouter.delete('/home-partners/:id', controller.delete);

module.exports = { publicRouter, adminRouter };
