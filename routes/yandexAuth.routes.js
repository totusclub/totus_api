const express = require('express');
const router = express.Router();
const controller = require('../controllers/yandexAuth.controller');
const { requireAuth } = require('../lib/auth');
const { authLimiter } = require('../lib/security');

// Публичные шаги входа — как signin/verify, под общим rate-limit /api/auth/*.
router.get('/start', authLimiter, controller.start);
router.get('/callback', controller.callback);
router.post('/exchange', authLimiter, controller.exchange);

// Привязка к открытой сессии — сразу strict JWT (правило проекта для новых эндпоинтов).
router.get('/status', requireAuth(['user'], { strict: true }), controller.status);
router.post('/link', authLimiter, requireAuth(['user'], { strict: true }), controller.link);
router.delete('/link', requireAuth(['user'], { strict: true }), controller.unlink);

module.exports = router;
