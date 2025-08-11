
const path = require('path');

exports.uploadImage = (req, res) => {
    const file = req.file;
    if (!file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    const imageUrl = `http://localhost:3001/upload/content/${file.filename}`;

    // CKEditor expects this structure:
    res.status(201).json({
        uploaded: true,
        url: imageUrl
    });
};
