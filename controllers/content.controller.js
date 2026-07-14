const path = require('path');
const { getPublicApiBase } = require('../utils/publicApiBase');

exports.uploadImage = (req, res) => {
    const file = req.file;
    if (!file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    const imageUrl = `${getPublicApiBase(req)}/upload/content/${file.filename}`;

    res.status(201).json({
        uploaded: true,
        url: imageUrl,
    });
};
