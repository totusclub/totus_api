const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');

router.post('/signup', authController.signup);
router.post('/verify', authController.verifyCode);
router.post('/signin', authController.signin);

module.exports = router;
