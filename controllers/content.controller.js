const path = require('path');

function getPublicApiBase(req) {
    return (
        process.env.API_PUBLIC_URL ||
        process.env.PUBLIC_API_URL ||
        `${req.protocol}://${req.get('host')}`
    );
}

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
