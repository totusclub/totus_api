const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');
const profileController = require('../controllers/profile.controller');
const { requireAuth } = require('../lib/auth');
const { authLimiter } = require('../lib/security');

router.post('/signup', authLimiter, authController.signup);
router.post('/verify', authLimiter, authController.verifyCode);
router.post('/signin', authLimiter, authController.signin);
router.post('/generation-loyalty', authController.generationLoyalty);

// Волна 1 (SECURITY_JWT_PLAN_RU.md): профиль по токену, refresh, вход агента.
router.get('/me', requireAuth(['user', 'agent'], { strict: true }), authController.me);
// Телефон профиля — пользователь сам указывает или меняет номер (strict JWT).
router.patch('/me/phone', authLimiter, requireAuth(['user'], { strict: true }), profileController.updatePhone);
router.post('/refresh', authLimiter, authController.refresh);
router.post('/agent/sign-in', authLimiter, authController.agentSignIn);

router.post('/verification-code', authLimiter, authController.verificationCode);
router.post('/telegram-verification-callback', authController.telegramVerificationCallback);


module.exports = router;
