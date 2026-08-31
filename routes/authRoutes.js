const express = require('express');
const authController = require('../controllers/authController');
const { requireAuth } = require('../lib/auth');
const { authLimiter } = require('../lib/security');

const router = express.Router();

// Публичные: вход и refresh
router.post('/sign-in', authLimiter, authController.signInTeacher);
router.post('/refresh', authLimiter, authController.refreshToken);

// Только staff (AUTH_MODE=log → пропуск с логом, enforce → 401/403)
const staffOnly = requireAuth(['staff']);
router.post('/init', authController.userInit);
router.get('/users', staffOnly, authController.users);
router.get('/orders', staffOnly, authController.orders);
router.get('/orders/:id', staffOnly, authController.ordersById);
router.get('/orders/user/:id', staffOnly, authController.ordersByUsers);
router.get('/overview', staffOnly, authController.overview);

module.exports = router;
