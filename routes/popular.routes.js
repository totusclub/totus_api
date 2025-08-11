const express = require('express');
const router = express.Router();
const popularController = require('../controllers/popular.controller');
const upload = require('../middleware/upload');

router.post('/popular', upload.single('image'), popularController.create);
router.put('/popular', upload.single('image'), popularController.update);
router.get('/popular', popularController.getAll);
router.delete('/popular/:id', popularController.delete);
router.get('/popular/:id', popularController.getById);

module.exports = router;
