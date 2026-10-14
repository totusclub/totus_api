const express = require('express');
const { requireAuth } = require('../lib/auth');
const controller = require('../controllers/consents.controller');

const router = express.Router();

// Всегда с проверкой токена (strict), независимо от AUTH_MODE.
router.post('/', requireAuth(['user'], { strict: true }), controller.create);

module.exports = router;
