const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');

router.post('/signup', authController.signup);
router.post('/verify', authController.verifyCode);
router.post('/signin', authController.signin);
router.post('/generation-loyalty', authController.generationLoyalty);

router.post('/verification-code', authController.verificationCode);
router.post('/telegram-verification-callback', authController.telegramVerificationCallback);


module.exports = router;
