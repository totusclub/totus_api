const express = require('express');
const router = express.Router();
const emailController = require('../controllers/email.controller');
const { requireAuth } = require('../lib/auth');

// Тестовые письма — только staff (были публичными).
router.use(requireAuth(['staff']));

router.get('/test/templates', emailController.listTestTemplates);
router.post('/test', emailController.sendTestEmail);
router.post('/test/send', emailController.sendTestTemplate);
router.post('/test/all', emailController.sendAllTestTemplates);

module.exports = router;
