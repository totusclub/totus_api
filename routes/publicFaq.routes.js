const express = require('express');
const router = express.Router();
const faqController = require('../controllers/faq.controller');

router.get('/faq', faqController.getAll);

module.exports = router;
