const express = require('express');
const publicRouter = express.Router();
const adminRouter = express.Router();
const controller = require('../controllers/homeContent.controller');
const uploadDestination = require('../middleware/uploadDestination');
const uploadHotel = require('../middleware/uploadHotel');

publicRouter.get('/home/data', controller.getHomeData);

adminRouter.get('/home-sections', controller.getSections);
adminRouter.put('/home-sections', controller.updateSections);
adminRouter.get('/home-hotels', controller.getHotels);
adminRouter.post('/home-hotels', uploadHotel.single('image'), controller.createHotel);
adminRouter.put('/home-hotels/:id', uploadHotel.single('image'), controller.updateHotel);
adminRouter.delete('/home-hotels/:id', controller.deleteHotel);
adminRouter.get('/home-destinations', controller.getDestinations);
adminRouter.post('/home-destinations', uploadDestination.single('image'), controller.createDestination);
adminRouter.put('/home-destinations/:id', uploadDestination.single('image'), controller.updateDestination);
adminRouter.delete('/home-destinations/:id', controller.deleteDestination);

module.exports = { publicRouter, adminRouter };
