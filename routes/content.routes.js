// backend/routes/content.route.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { uploadImage } = require('../controllers/content.controller');

// Ensure upload directory exists
const uploadDir = path.join(__dirname, '..', 'upload', 'content');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Multer setup
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const uniqueName = `${Date.now()}-${file.originalname}`;
        cb(null, uniqueName);
    },
});

const upload = multer({ storage });

// Route for CKEditor / admin editor upload
router.post('/upload', upload.single('upload'), uploadImage);
router.post('/upload-image', upload.single('file'), uploadImage);

module.exports = router;
