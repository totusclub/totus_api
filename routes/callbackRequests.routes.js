const express = require('express');
const router = express.Router();
const adminRouter = express.Router();
const controller = require('../controllers/callbackRequests.controller');

router.post('/', controller.create);

adminRouter.get('/callback-requests', controller.getAll);
adminRouter.delete('/callback-requests/:id', controller.delete);

module.exports = { router, adminRouter };
