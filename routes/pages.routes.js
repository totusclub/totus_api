const express = require('express');
const router = express.Router();
const pagesController = require('../controllers/pages.controller');

// CRUD routes
router.get('/slug/:slug', pagesController.getPageBySlug);
router.get('/', pagesController.getAllPages);
router.get('/:id', pagesController.getPageById);
router.post('/save', pagesController.savePage);
router.post('/', pagesController.createPage);
router.put('/', pagesController.updatePage);
router.delete('/:id', pagesController.deletePage);

module.exports = router;
