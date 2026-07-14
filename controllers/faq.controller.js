const db = require('../db');

exports.create = async (req, res) => {
    const { answer, question } = req.body;
    if (!question?.trim() || !answer?.trim()) {
        return res.status(400).json({ message: 'Вопрос и ответ обязательны.' });
    }
    try {
        const [result] = await db.query(
            'INSERT INTO faq (answer, question) VALUES (?, ?)',
            [answer.trim(), question.trim()],
        );
        const [rows] = await db.query('SELECT * FROM faq WHERE id = ?', [result.insertId]);
        res.status(201).json({ message: 'FAQ created successfully.', data: rows[0] });
    } catch (err) {
        res.status(500).json({ message: 'FAQ creation failed.', error: err.message });
    }
};

exports.edit = async (req, res) => {
    const { id, answer, question } = req.body;
    if (!id) {
        return res.status(400).json({ message: 'Missing FAQ id.' });
    }
    if (!question?.trim() || !answer?.trim()) {
        return res.status(400).json({ message: 'Вопрос и ответ обязательны.' });
    }
    try {
        const [result] = await db.query(
            'UPDATE faq SET answer = ?, question = ? WHERE id = ?',
            [answer.trim(), question.trim(), id],
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'FAQ not found.' });
        }
        const [rows] = await db.query('SELECT * FROM faq WHERE id = ?', [id]);
        res.status(200).json({ message: 'FAQ updated successfully.', data: rows[0] });
    } catch (err) {
        res.status(500).json({ message: 'FAQ update failed.', error: err.message });
    }
};

exports.getAll = async (req, res) => {
    try {
        const [faq] = await db.query('SELECT id, question, answer, c_date FROM faq ORDER BY id ASC');
        res.status(200).json({ data: faq });
    } catch (err) {
        res.status(500).json({ message: 'Failed to fetch FAQs.', error: err.message });
    }
};

exports.getById = async (req, res) => {
    const { id } = req.params;
    try {
        const [faq] = await db.query('SELECT * FROM faq WHERE id = ?', [id]);
        if (faq.length === 0) {
            return res.status(404).json({ message: 'FAQ not found.' });
        }
        res.status(200).json({ data: faq[0] });
    } catch (err) {
        res.status(500).json({ message: 'Failed to fetch FAQ.', error: err.message });
    }
};

exports.delete = async (req, res) => {
    const { id } = req.params;
    try {
        const [result] = await db.query('DELETE FROM faq WHERE id = ?', [id]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'FAQ not found.' });
        }
        res.status(200).json({ message: 'FAQ deleted successfully.' });
    } catch (err) {
        res.status(500).json({ message: 'FAQ deletion failed.', error: err.message });
    }
};
