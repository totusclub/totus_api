'use strict';

// POST /api/consents — согласия вошедшего пользователя, данные при отдельном шаге
// (новый пользователь Яндекс ID на экране «Почти готово»). Только с JWT.
const { recordConsents, normalizeConsents } = require('../lib/consents');

const ALLOWED_FORMS = ['signup_yandex', 'account'];

exports.create = async (req, res) => {
    const body = req.body || {};
    const form = ALLOWED_FORMS.includes(body.form) ? body.form : 'account';
    const consents = normalizeConsents(body.consents);
    if (!Object.keys(consents).length) {
        return res.status(400).json({ error: 'consents_required', message: 'Нет согласий для записи' });
    }
    const payload = (req.auth && req.auth.payload) || {};
    try {
        const { written } = await recordConsents(
            form,
            consents,
            { userId: req.auth && req.auth.id, email: payload.email, phone: payload.phone },
            {
                source: req.headers.origin ? 'web' : 'app',
                ip: req.ip,
                userAgent: req.get ? req.get('user-agent') : req.headers['user-agent'],
            },
        );
        return res.status(201).json({ ok: true, written });
    } catch (err) {
        console.error('[CONSENTS] create failed:', err.message);
        return res.status(500).json({ error: 'failed_to_save_consents', message: 'Не удалось сохранить согласие' });
    }
};

exports.ALLOWED_FORMS = ALLOWED_FORMS;
