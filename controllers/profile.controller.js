'use strict';

/**
 * Профиль пользователя — точечные обновления по токену.
 *
 * Появился для шага «Почти готово» после входа через Яндекс ID: у нового
 * пользователя телефона нет (Яндекс его не отдаёт — право login:default_phone
 * мы не запрашиваем), поэтому он вводит его сам. Шаг не блокирующий.
 *
 * Принимаем только российские номера (+7 / 8) — решение владельца; см. lib/phone.js.
 */

const db = require('../db');
const auth = require('../lib/auth');
const { normalizeRuPhone } = require('../lib/phone');

// PATCH /api/auth/me/phone  { phone }  — strict JWT (user)
exports.updatePhone = async (req, res) => {
    const raw = String(req.body?.phone ?? '').trim();
    if (!raw) return res.status(400).json({ error: 'phone_required' });

    const phone = normalizeRuPhone(raw);
    if (!phone) {
        return res.status(400).json({
            error: 'phone_invalid',
            message: 'Введите российский номер: +7 или 8, 11 цифр',
        });
    }

    try {
        await db.query('UPDATE users SET phone = ? WHERE id = ?', [phone, req.auth.id]);
        const [rows] = await db.query('SELECT * FROM users WHERE id = ? LIMIT 1', [req.auth.id]);
        const user = rows[0];
        if (!user) return res.status(404).json({ message: 'User not found' });

        // Профиль сайт и приложение читают из payload токена, поэтому переиздаём его.
        const accessToken = auth.signUserToken(user);
        const refreshToken = auth.signRefreshToken(user.id, 'user');
        res.json({
            auth: true,
            authToken: accessToken,
            accessToken,
            refreshToken,
            user: auth.publicUser(user),
        });
    } catch (err) {
        console.error('[PROFILE] phone update failed:', err.message);
        res.status(500).json({ message: 'Phone update failed', error: err.message });
    }
};
