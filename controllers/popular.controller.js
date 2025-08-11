const path = require('path');
const fs = require('fs');
const db = require('../db');

// Helper: delete image file
const deleteImageFile = (imagePath) => {
    if (!imagePath) return;
    const fullPath = path.join(__dirname, '..', imagePath);
    if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
    }
};

// CREATE
exports.create = async (req, res) => {
    const { name, url } = req.body;
    const image = req.file ? `/uploads/popular/${req.file.filename}` : null;

    try {
        await db.query('INSERT INTO popular (name, image, url) VALUES (?, ?, ?)', [name, image, url]);
        res.status(201).json({ message: 'Popular item created.', image });
    } catch (err) {
        res.status(500).json({ message: 'Creation failed.', error: err.message });
    }
};

// UPDATE
exports.update = async (req, res) => {
    const { id, name, url } = req.body;
    const newImage = req.file ? `/uploads/popular/${req.file.filename}` : null;

    try {
        // Fetch existing item
        const [rows] = await db.query('SELECT * FROM popular WHERE id = ?', [id]);
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Popular item not found.' });
        }

        const oldImage = rows[0].image;

        // Build query
        let query = 'UPDATE popular SET name = ?, url = ?';
        const params = [name, url];

        if (newImage) {
            query += ', image = ?';
            params.push(newImage);
        }

        query += ' WHERE id = ?';
        params.push(id);

        await db.query(query, params);

        // Delete old image if replaced
        if (newImage && oldImage && oldImage !== newImage) {
            deleteImageFile(oldImage);
        }

        res.status(200).json({ message: 'Popular item updated successfully.' });
    } catch (err) {
        res.status(500).json({ message: 'Update failed.', error: err.message });
    }
};

// GET ALL
exports.getAll = async (req, res) => {
    try {
        const [popular] = await db.query('SELECT * FROM popular');
        res.status(200).json({ data: popular });
    } catch (err) {
        res.status(500).json({ message: 'Fetch failed.', error: err.message });
    }
};

// DELETE
exports.delete = async (req, res) => {
    const { id } = req.params;

    try {
        // Get image path before deleting row
        const [rows] = await db.query('SELECT * FROM popular WHERE id = ?', [id]);
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Popular item not found.' });
        }

        const imagePath = rows[0].image;

        // Delete DB row
        await db.query('DELETE FROM popular WHERE id = ?', [id]);

        // Delete image from filesystem
        deleteImageFile(imagePath);

        res.status(200).json({ message: 'Popular item deleted.' });
    } catch (err) {
        res.status(500).json({ message: 'Deletion failed.', error: err.message });
    }
};

exports.getById = async (req, res) => {
    const { id } = req.params;

    try {
        const [rows] = await db.query('SELECT * FROM popular WHERE id = ?', [id]);

        if (rows.length === 0) {
            return res.status(404).json({ message: 'Popular item not found.' });
        }

        res.status(200).json({ data: rows[0] });
    } catch (err) {
        res.status(500).json({ message: 'Fetch by ID failed.', error: err.message });
    }
};
