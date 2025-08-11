const express = require('express');
const authController = require('../controllers/authController');

const router = express.Router();

router.post('/sign-in', authController.signInTeacher);
router.post('/refresh', authController.refreshToken);
router.post('/init', authController.userInit);
router.get('/users', authController.users);
router.get('/orders', authController.orders);
router.get('/orders/:id', authController.ordersById);
router.get('/orders/user/:id', authController.ordersByUsers);
router.get('/overview', authController.overview);

module.exports = router;
