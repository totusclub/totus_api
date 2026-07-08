// backend/routes/content.route.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { uploadImage } = require('../controllers/content.controller');

const MAX_IMAGE_MB = Number(process.env.UPLOAD_MAX_IMAGE_MB || 15);
const MAX_IMAGE_BYTES = MAX_IMAGE_MB * 1024 * 1024;

// Ensure upload directory exists
const uploadDir = path.join(__dirname, '..', 'upload', 'content');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const safeOriginal = String(file.originalname || 'image')
            .normalize('NFKD')
            .replace(/[^\w.\-]+/g, '_')
            .replace(/_+/g, '_')
            .slice(0, 80);
        const uniqueName = `${Date.now()}-${safeOriginal || 'image'}`;
        cb(null, uniqueName);
    },
});

const fileFilter = (req, file, cb) => {
    if (/^image\/(jpeg|jpg|png|gif|webp|svg\+xml|bmp)$/i.test(file.mimetype || '')) {
        cb(null, true);
        return;
    }
    cb(new Error('ONLY_IMAGE_ALLOWED'));
};

const upload = multer({
    storage,
    limits: { fileSize: MAX_IMAGE_BYTES },
    fileFilter,
});

function handleUpload(fieldName) {
    return (req, res, next) => {
        upload.single(fieldName)(req, res, (err) => {
            if (!err) return next();

            if (err instanceof multer.MulterError) {
                if (err.code === 'LIMIT_FILE_SIZE') {
                    return res.status(413).json({
                        error: `Image is too large. Maximum size is ${MAX_IMAGE_MB} MB.`,
                    });
                }
                return res.status(400).json({ error: err.message });
            }

            if (err.message === 'ONLY_IMAGE_ALLOWED') {
                return res.status(400).json({ error: 'Only image files are allowed.' });
            }

            console.error('Image upload failed:', err);
            return res.status(500).json({ error: 'Image upload failed.' });
        });
    };
}

// Route for CKEditor / admin editor upload
router.post('/upload', handleUpload('upload'), uploadImage);
router.post('/upload-image', handleUpload('file'), uploadImage);

module.exports = router;
