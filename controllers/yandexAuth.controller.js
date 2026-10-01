'use strict';

/**
 * Вход через Яндекс ID — контроллер (план claude/YANDEX_AUTH_PLAN_RU.md, §5).
 *
 *   GET  /api/auth/yandex/start     → 302 на oauth.yandex.ru (?force=1 — снова показать экран прав)
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

// Лог о выключенном разделе — не чаще раза в минуту на причину, чтобы не заливать pm2-логи.
const lastWarnAt = new Map();
function warnOnce(reason, message) {
    const now = Date.now();
    if (now - (lastWarnAt.get(reason) || 0) < 60 * 1000) return;
    lastWarnAt.set(reason, now);
    console.warn(message);
}

/** Флаг из query: ?force=1 / yes / true. */
function isTruthy(value) {
    return ['1', 'yes', 'true'].includes(String(value || '').trim().toLowerCase());
}

/**
 * Раздел выключен — в ответе говорим почему:
 *   reason: 'env'    — процесс не видит переменных (имена — в missing, значений нет)
 *   reason: 'schema' — не прогнана миграция (нет таблицы user_identities)
 */
async function ensureEnabled(res) {
    if (!yandex.isConfigured()) {
        const missing = yandex.missingConfig();
        warnOnce('env', `[YANDEX-AUTH] 503 reason=env — процесс не видит переменных: ${missing.join(', ')} (проверьте .env и .env.local в каталоге запуска, затем pm2 restart api --update-env)`);
        res.status(503).json({ error: 'yandex_auth_not_configured', reason: 'env', missing });
        return false;
    }
    if (!(await yandex.hasSchema())) {
        warnOnce('schema', '[YANDEX-AUTH] 503 reason=schema — нет таблицы user_identities: npm run migrate:yandex-auth, затем pm2 restart api');
        res.status(503).json({ error: 'yandex_auth_not_configured', reason: 'schema' });
        return false;
    }
    return true;
}

// GET /api/auth/yandex/start?client=web|app|desktop&return=/lk&force=1
exports.start = async (req, res) => {
    if (!(await ensureEnabled(res))) return;
    try {
        const client = yandex.normalizeClient(req.query.client);
        const returnPath = yandex.safeReturnPath(req.query.return);
        const state = yandex.signState({ client, returnPath });
        // force=1 — повтор после «почта не выдана»: Яндекс снова покажет экран прав.
        res.redirect(302, yandex.authorizeUrl(state, { forceConfirm: isTruthy(req.query.force) }));
    } catch (err) {
        console.error('[YANDEX-AUTH] start failed:', err.message);
        res.status(500).json({ error: 'yandex_start_failed' });
    }
};

// GET /api/auth/yandex/callback?code=…&state=…
exports.callback = async (req, res) => {
    if (!(await ensureEnabled(res))) return;

    const parsed = yandex.inspectState(req.query.state);
    const { client, returnPath } = parsed;
    const fail = (code) => res.redirect(302, yandex.returnUrl(client, { error: code, return: returnPath }));

    // Раньше здесь был голый JSON 400 на api.totus.club — человек оставался на странице API
    // без кнопок. Теперь возвращаем на экран входа с понятной ошибкой и «Попробовать снова».
    if (parsed.status === 'expired') {
        console.warn(`[YANDEX-AUTH] state expired (client=${client}) — страницу Яндекса держали открытой дольше ${yandex.STATE_TTL_SEC / 60} мин`);
        return fail('yandex_state_expired');
    }
    if (parsed.status !== 'ok') {
        console.warn('[YANDEX-AUTH] state invalid — возвращаем на сайт');
        return fail('yandex_state_invalid');
    }

    // Пользователь нажал «Отказать» на странице Яндекса.
    if (req.query.error) {
        const denied = String(req.query.error) === 'access_denied' ? 'yandex_access_denied' : 'yandex_failed';
        return fail(denied);
    }
    if (!req.query.code) return fail('yandex_code_missing');

    try {
        const { accessToken, scope } = await yandex.exchangeCodeForToken(req.query.code);
        const profile = await yandex.fetchProfile(accessToken);

        if (!profile.email) {
            // Видно, что именно выдал Яндекс: есть ли в scope login:email.
            console.warn(`[YANDEX-AUTH] почта не выдана, scope="${scope}" — клиент предложит повтор с force_confirm`);
            return fail('yandex_email_required');
        }

        const { user, isNew } = await yandex.resolveUser(profile);
        const ticket = yandex.createTicket({ userId: user.id, isNew });
        return res.redirect(302, yandex.returnUrl(client, { ticket, return: returnPath }));
    } catch (err) {
        const known = ['yandex_email_required'];
        const code = known.includes(err.message) ? err.message : 'yandex_failed';
        if (!known.includes(err.message)) {
            // Статус от Яндекса помогает отличить неверный secret (400/401) от чужого redirect_uri.
            const status = err.response && err.response.status;
            const detail = err.response && err.response.data ? JSON.stringify(err.response.data).slice(0, 200) : '';
            console.error('[YANDEX-AUTH] callback failed:', err.message, status ? `status=${status}` : '', detail);
        }
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
