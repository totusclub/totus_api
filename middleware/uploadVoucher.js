// Загрузка ваучера (PDF ≤ 10 МБ) по бронированию наших Room Type → uploads/vouchers
// (отдаётся как /uploads/vouchers/<file>, см. app.js express.static). По образцу uploadRoomImage.js.
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const uploadDir = path.join(__dirname, '..', 'uploads', 'vouchers');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const id = req.params && /^\d+$/.test(String(req.params.id)) ? `b${req.params.id}-` : '';
        cb(null, `voucher-${id}${Date.now()}-${Math.round(Math.random() * 1e9)}.pdf`);
    },
});

const fileFilter = (req, file, cb) => {
    const isPdf = file.mimetype === 'application/pdf' || file.mimetype === 'application/x-pdf' || /\.pdf$/i.test(file.originalname || '');
    if (isPdf) cb(null, true);
    else cb(new Error('Only PDF files are allowed.'));
};

module.exports = multer({ storage, fileFilter, limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
