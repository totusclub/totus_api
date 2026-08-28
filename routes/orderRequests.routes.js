const express = require('express');
const router = express.Router();
const adminRouter = express.Router();
const controller = require('../controllers/orderRequests.controller');
const { requireUser, requireStaff } = require('../middleware/authJwt');

// Mounted at /api/order-requests (site/app users, Bearer user JWT)
router.post('/', requireUser, controller.createRequest);
router.get('/', requireUser, controller.listMyRequests);

// Mounted at /api/admin/order-requests (CMS staff, Bearer staff JWT with scope: 'staff')
adminRouter.get('/', requireStaff, controller.adminList);
adminRouter.patch('/:id', requireStaff, controller.adminUpdateStatus);

module.exports = { router, adminRouter };
