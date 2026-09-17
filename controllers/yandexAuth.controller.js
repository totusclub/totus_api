'use strict';

/**
 * Вход через Яндекс ID — контроллер (план claude/YANDEX_AUTH_PLAN_RU.md, §5).
 *
 *   GET  /api/auth/yandex/start     → 302 на oauth.yandex.ru
 *   GET  /api/auth/yandex/callback  → обмен кода на сервере, 302 с одноразовым ticket
 *   POST /api/auth/yandex/exchange  → { ticket } → наши JWT (как /api/auth/verify)
 *   POST /api/auth/yandex/link      → привязать Яндекс к открытой сессии (strict JWT)
 *   DELETE /api/auth/yandex/link    → отвязать (strict JWT)
 */

const db = require('../db');
const auth = require('../lib/auth');
const yandex = require('../lib/yandexAuth');

function issueUserTokens(userRow) {
    const accessToken = auth.signUserToken(userRow);
    const refreshToken = auth.signRefreshToken(userRow.id, 'user');
    return { auth: true, authToken: accessToken, accessToken, refreshToken };
}

async function ensureEnabled(res) {
    if (!yandex.isConfigured()) {
        res.status(503).json({ error: 'yandex_auth_not_configured' });
        return false;
    }
    if (!(await yandex.hasSchema())) {
        res.status(503).json({ error: 'yandex_auth_not_configured' });
        return false;
    }
    return true;
}

// GET /api/auth/yandex/start?client=web|app|desktop&return=/lk
exports.start = async (req, res) => {
    if (!(await ensureEnabled(res))) return;
    try {
        const client = yandex.normalizeClient(req.query.client);
        const returnPath = yandex.safeReturnPath(req.query.return);
        const state = yandex.signState({ client, returnPath });
        res.redirect(302, yandex.authorizeUrl(state));
    } catch (err) {
        console.error('[YANDEX-AUTH] start failed:', err.message);
        res.status(500).json({ error: 'yandex_start_failed' });
    }
};

// GET /api/auth/yandex/callback?code=…&state=…
exports.callback = async (req, res) => {
    if (!(await ensureEnabled(res))) return;

    const parsed = yandex.verifyState(req.query.state);
    if (!parsed) {
        // Без state неизвестно, куда возвращать — отвечаем страницей-заглушкой API.
        return res.status(400).json({ error: 'yandex_state_invalid' });
    }
    const { client, returnPath } = parsed;
    const fail = (code) => res.redirect(302, yandex.returnUrl(client, { error: code, return: returnPath }));

    // Пользователь нажал «Отказать» на странице Яндекса.
    if (req.query.error) {
        const denied = String(req.query.error) === 'access_denied' ? 'yandex_access_denied' : 'yandex_failed';
        return fail(denied);
    }
    if (!req.query.code) return fail('yandex_code_missing');

    try {
        const accessToken = await yandex.exchangeCodeForToken(req.query.code);
        const profile = await yandex.fetchProfile(accessToken);
        const { user, isNew } = await yandex.resolveUser(profile);
        const ticket = yandex.createTicket({ userId: user.id, isNew });
        return res.redirect(302, yandex.returnUrl(client, { ticket, return: returnPath }));
    } catch (err) {
        const known = ['yandex_email_required', 'user_blocked'];
        const code = known.includes(err.message) ? err.message : 'yandex_failed';
        if (!known.includes(err.message)) console.error('[YANDEX-AUTH] callback failed:', err.message);
        return fail(code);
    }
};

// POST /api/auth/yandex/exchange  { ticket }
exports.exchange = async (req, res) => {
    if (!(await ensureEnabled(res))) return;

    const ticket = String(req.body?.ticket || '').trim();
    if (!ticket) return res.status(400).json({ error: 'ticket_required' });

    const value = yandex.consumeTicket(ticket);
    if (!value) return res.status(400).json({ error: 'ticket_invalid' });

    try {
        const [rows] = await db.query('SELECT * FROM users WHERE id = ? LIMIT 1', [value.userId]);
        const user = rows[0];
        if (!user) return res.status(401).json({ error: 'unauthorized' });
        if (Number(user.access) === 1) return res.status(403).json({ error: 'forbidden' });

        res.json({
            ...issueUserTokens(user),
            user: auth.publicUser(user),
            isNew: value.isNew,
            needsPhone: !user.phone,
        });
    } catch (err) {
        console.error('[YANDEX-AUTH] exchange failed:', err.message);
        res.status(500).json({ error: 'yandex_exchange_failed' });
    }
};

// POST /api/auth/yandex/link  { ticket }  — привязка к уже открытой сессии
exports.link = async (req, res) => {
    if (!(await ensureEnabled(res))) return;

    const ticket = String(req.body?.ticket || '').trim();
    if (!ticket) return res.status(400).json({ error: 'ticket_required' });

    const value = yandex.consumeTicket(ticket);
    if (!value) return res.status(400).json({ error: 'ticket_invalid' });

    try {
        // Ticket выдан на аккаунт, найденный по почте Яндекса. Если это уже текущий
        // пользователь — связь создана на callback. Чужой аккаунт не переносим.
        if (Number(value.userId) !== Number(req.auth.id)) {
            return res.status(409).json({ error: 'yandex_already_linked_to_other_user' });
        }
        const [rows] = await db.query(
            "SELECT provider_uid, email FROM user_identities WHERE user_id = ? AND provider = 'yandex' LIMIT 1",
            [req.auth.id],
        );
        res.json({ linked: true, identity: rows[0] || null });
    } catch (err) {
        console.error('[YANDEX-AUTH] link failed:', err.message);
        res.status(500).json({ error: 'yandex_link_failed' });
    }
};

// DELETE /api/auth/yandex/link — отвязать (если есть чем войти иначе)
exports.unlink = async (req, res) => {
    if (!(await ensureEnabled(res))) return;
    try {
        const [users] = await db.query('SELECT email FROM users WHERE id = ? LIMIT 1', [req.auth.id]);
        if (!users.length) return res.status(404).json({ error: 'not_found' });
        // Вход по email-коду доступен всем, у кого есть почта, — иначе отвязка запирает аккаунт.
        if (!users[0].email) return res.status(409).json({ error: 'last_login_method' });

        const [result] = await db.query(
            "DELETE FROM user_identities WHERE user_id = ? AND provider = 'yandex'",
            [req.auth.id],
        );
        res.json({ linked: false, removed: result.affectedRows });
    } catch (err) {
        console.error('[YANDEX-AUTH] unlink failed:', err.message);
        res.status(500).json({ error: 'yandex_unlink_failed' });
    }
};

// GET /api/auth/yandex/status — есть ли привязка у текущего пользователя (strict JWT)
exports.status = async (req, res) => {
    if (!(await ensureEnabled(res))) return;
    try {
        const [rows] = await db.query(
            "SELECT provider_uid, email, created_at FROM user_identities WHERE user_id = ? AND provider = 'yandex' LIMIT 1",
            [req.auth.id],
        );
        res.json({ linked: rows.length > 0, identity: rows[0] || null });
    } catch (err) {
        console.error('[YANDEX-AUTH] status failed:', err.message);
        res.status(500).json({ error: 'yandex_status_failed' });
    }
};
