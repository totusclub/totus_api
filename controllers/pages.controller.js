const db = require('../db');

const PAGE_FIELDS = [
    'name',
    'slug',
    'seo_title',
    'seo_desc',
    'seo_keywords',
    'section',
    'breadcrumb_label',
    'mobile_header_title',
    'content',
];

function mapPageRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        name: row.name || '',
        slug: row.slug || '',
        seo_title: row.seo_title || '',
        seo_desc: row.seo_desc || '',
        seo_keywords: row.seo_keywords || '',
        section: row.section || 'company',
        breadcrumb_label: row.breadcrumb_label || '',
        mobile_header_title: row.mobile_header_title || '',
        content: row.content || '',
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}

// Get all pages
exports.getAllPages = async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM pages ORDER BY name ASC');
        res.json(rows.map(mapPageRow));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// Get a single page by numeric ID
exports.getPageById = async (req, res) => {
    const { id } = req.params;
    if (!/^\d+$/.test(String(id))) {
        return res.status(400).json({ error: 'Invalid page id' });
    }
    try {
        const [rows] = await db.query('SELECT * FROM pages WHERE id = ?', [id]);
        if (rows.length === 0) return res.status(404).json({ error: 'Page not found' });
        res.json(mapPageRow(rows[0]));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// Get a single page by slug (public + admin)
exports.getPageBySlug = async (req, res) => {
    const { slug } = req.params;
    try {
        const [rows] = await db.query('SELECT * FROM pages WHERE slug = ? LIMIT 1', [slug]);
        if (rows.length === 0) return res.status(404).json({ error: 'Page not found' });
        res.json(mapPageRow(rows[0]));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// Create a new page
exports.createPage = async (req, res) => {
    const body = req.body || {};
    const values = PAGE_FIELDS.map((field) => body[field] ?? (field === 'section' ? 'company' : ''));
    try {
        const [result] = await db.query(
            `INSERT INTO pages (${PAGE_FIELDS.join(', ')}) VALUES (${PAGE_FIELDS.map(() => '?').join(', ')})`,
            values
        );
        const [rows] = await db.query('SELECT * FROM pages WHERE id = ?', [result.insertId]);
        res.status(201).json(mapPageRow(rows[0]));
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'Page with this slug already exists' });
        }
        res.status(500).json({ error: err.message });
    }
};

// Update an existing page by id in body
exports.updatePage = async (req, res) => {
    const body = req.body || {};
    const { id } = body;
    if (!id) return res.status(400).json({ error: 'Missing page id' });

    const values = PAGE_FIELDS.map((field) => body[field] ?? (field === 'section' ? 'company' : ''));
    values.push(id);

    try {
        await db.query(
            `UPDATE pages SET ${PAGE_FIELDS.map((field) => `${field} = ?`).join(', ')} WHERE id = ?`,
            values
        );
        const [rows] = await db.query('SELECT * FROM pages WHERE id = ?', [id]);
        if (!rows[0]) return res.status(404).json({ error: 'Page not found' });
        res.json(mapPageRow(rows[0]));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// Create or update by slug (admin-friendly save)
exports.savePage = async (req, res) => {
    const body = req.body || {};
    const slug = String(body.slug || '').trim();
    if (!slug) return res.status(400).json({ error: 'Missing slug' });

    const values = PAGE_FIELDS.map((field) => {
        if (field === 'slug') return slug;
        return body[field] ?? (field === 'section' ? 'company' : '');
    });

    try {
        const [existing] = await db.query('SELECT id FROM pages WHERE slug = ? LIMIT 1', [slug]);
        if (existing[0]?.id) {
            values.push(existing[0].id);
            await db.query(
                `UPDATE pages SET ${PAGE_FIELDS.map((field) => `${field} = ?`).join(', ')} WHERE id = ?`,
                values
            );
            const [rows] = await db.query('SELECT * FROM pages WHERE id = ?', [existing[0].id]);
            return res.json(mapPageRow(rows[0]));
        }

        const [result] = await db.query(
            `INSERT INTO pages (${PAGE_FIELDS.join(', ')}) VALUES (${PAGE_FIELDS.map(() => '?').join(', ')})`,
            values
        );
        const [rows] = await db.query('SELECT * FROM pages WHERE id = ?', [result.insertId]);
        return res.status(201).json(mapPageRow(rows[0]));
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
