const express = require('express');
const router = express.Router();
const faqController = require('../controllers/faq.controller');

router.post('/faq', faqController.create);
router.put('/faq', faqController.edit);
router.get('/faq', faqController.getAll);
router.get('/faq/:id', faqController.getById);
router.delete('/faq/:id', faqController.delete);


module.exports = router;
