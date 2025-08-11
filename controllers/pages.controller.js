const db = require('../db');

// Get all pages
exports.getAllPages = async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM pages');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// Get a single page by ID
exports.getPageById = async (req, res) => {
    const { id } = req.params;
    try {
        const [rows] = await db.query('SELECT * FROM pages WHERE id = ?', [id]);
        if (rows.length === 0) return res.status(404).json({ error: 'Page not found' });
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// Create a new page
exports.createPage = async (req, res) => {
    const { name, slug, seo_title, seo_desc, content } = req.body;
    try {
        const [result] = await db.query(
            'INSERT INTO pages (name, slug, seo_title, seo_desc, content) VALUES (?, ?, ?, ?, ?)',
            [name, slug, seo_title, seo_desc, content]
        );
        res.status(201).json({ id: result.insertId, name, slug, seo_title, seo_desc, content });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// Update an existing page
exports.updatePage = async (req, res) => {
    const {id, name, slug, seo_title, seo_desc, content } = req.body;
    try {
        const [result] = await db.query(
            'UPDATE pages SET name = ?, slug = ?, seo_title = ?, seo_desc = ?, content = ? WHERE id = ?',
            [name, slug, seo_title, seo_desc, content, id]
        );
        res.json({ message: 'Page updated' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// Delete a page
exports.deletePage = async (req, res) => {
    const { id } = req.params;
    try {
        await db.query('DELETE FROM pages WHERE id = ?', [id]);
        res.json({ message: 'Page deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};
