const multer = require('multer');
const path = require('path');

// M4 аудита: расширение — по MIME-типу, а не из имени файла клиента; лимит размера как у остальных загрузок.
const EXT_BY_MIME = { 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const MAX_IMAGE_BYTES = Number(process.env.UPLOAD_MAX_IMAGE_MB || 15) * 1024 * 1024;

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/popular');
    },
    filename: (req, file, cb) => {
        const ext = EXT_BY_MIME[file.mimetype] || path.extname(file.originalname).toLowerCase().replace(/[^.\w]/g, '').slice(0, 6);
        const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9) + ext;
        cb(null, uniqueName);
    }
});

const fileFilter = (req, file, cb) => {
    if (EXT_BY_MIME[file.mimetype]) {
        cb(null, true);
    } else {
        cb(new Error('Only image files are allowed.'));
    }
};

module.exports = multer({ storage, fileFilter, limits: { fileSize: MAX_IMAGE_BYTES } });
