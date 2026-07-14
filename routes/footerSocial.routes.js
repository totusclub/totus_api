const express = require('express');
const publicRouter = express.Router();
const adminRouter = express.Router();
const controller = require('../controllers/footerSocial.controller');

publicRouter.get('/footer-social', controller.getPublic);
adminRouter.get('/footer-social', controller.getAll);
adminRouter.get('/footer-social/icons', controller.getAllowedIcons);
adminRouter.post('/footer-social', controller.create);
adminRouter.put('/footer-social/:id', controller.update);
adminRouter.delete('/footer-social/:id', controller.remove);

module.exports = { publicRouter, adminRouter };
