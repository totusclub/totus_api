'use strict';

/**
 * Вход через Яндекс ID (план claude/YANDEX_AUTH_PLAN_RU.md).
 *
 * Ядро модуля: конфигурация, подписанный state, одноразовые ticket'ы,
 * обращения к oauth.yandex.ru / login.yandex.ru и связывание аккаунта.
 *
 * Сам обмен кода на токен делает только сервер: YANDEX_OAUTH_CLIENT_SECRET
 * не покидает totus_API, клиент получает наши обычные JWT (issueUserTokens),
 * поэтому интерсепторы и refresh на сайте/в приложении не меняются.
 *
 * Модуль выключен, пока нет переменных окружения или таблицы user_identities:
 * маршруты отвечают 503 { error: 'yandex_auth_not_configured', reason }, остальной вход
 * (signup/signin/verify/refresh) работает как раньше.
 *
 * Важно про users.access: это НЕ бан, а флаг видимости Totus AI и звонков
 * в приложении (0 — показывать, иначе скрыть). Обычный вход по коду из письма
 * его не проверяет — значит, и вход через Яндекс не должен.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const db = require('../db');
const { generateUniqueLoyaltyId } = require('../utils/loyaltyGenerator');

const AUTHORIZE_URL = 'https://oauth.yandex.ru/authorize';
const TOKEN_URL = 'https://oauth.yandex.ru/token';
const INFO_URL = 'https://login.yandex.ru/info';

const SCOPES = 'login:info login:email login:avatar';
// state живёт, пока человек стоит на странице Яндекса (выбор аккаунта, вход, экран прав).
// 10 минут оказалось мало: страницу оставляют открытой и нажимают «Войти как…» позже —
// раньше это давало голый JSON yandex_state_invalid. Код Яндекса после согласия
// выдаётся отдельно и живёт свои 10 минут — на него TTL state не влияет.
const STATE_TTL_SEC = 60 * 60;
const TICKET_TTL_MS = 120 * 1000;   // одноразовый ticket на обмен в клиенте
const HTTP_TIMEOUT_MS = 10 * 1000;

const CLIENTS = ['web', 'app', 'desktop'];

/** Переменные срезаются: лишние пробелы и \r из CRLF-файла — частая причина «не видит .env». */
function envValue(name) {
    return String(process.env[name] || '').trim();
}

function config() {
    return {
        clientId: envValue('YANDEX_OAUTH_CLIENT_ID'),
        clientSecret: envValue('YANDEX_OAUTH_CLIENT_SECRET'),
        redirectUri: envValue('YANDEX_OAUTH_REDIRECT_URI'),
        returnWeb: envValue('YANDEX_AUTH_RETURN_WEB') || 'https://totus.club',
        returnApp: envValue('YANDEX_AUTH_RETURN_APP') || 'totus://auth/yandex',
        returnDesktop: envValue('YANDEX_AUTH_RETURN_DESKTOP') || envValue('YANDEX_AUTH_RETURN_APP') || 'totus://auth/yandex',
    };
}

/** Что именно заполнено — без значений (годится для логов и ответа 503). */
function configStatus() {
    const c = config();
    return {
        YANDEX_OAUTH_CLIENT_ID: Boolean(c.clientId),
        YANDEX_OAUTH_CLIENT_SECRET: Boolean(c.clientSecret),
        YANDEX_OAUTH_REDIRECT_URI: Boolean(c.redirectUri),
        JWT_SECRET: Boolean(process.env.JWT_SECRET),
        JWT_REFRESH_SECRET: Boolean(process.env.JWT_REFRESH_SECRET),
    };
}

/** Имена переменных, которых не хватает процессу. */
function missingConfig() {
    const status = configStatus();
    return Object.keys(status).filter((key) => !status[key]);
}

/** Раздел включён, только если заданы client_id/secret/redirect_uri и есть чем подписывать наши токены. */
function isConfigured() {
    return missingConfig().length === 0;
}

// ---------------------------------------------------------------------------
// Схема БД: модуль сам себя выключает, пока не прогнали миграцию
// ---------------------------------------------------------------------------

let schemaReady = null;

async function hasSchema() {
    if (schemaReady !== null) return schemaReady;
    try {
        const [rows] = await db.query("SHOW TABLES LIKE 'user_identities'");
        schemaReady = rows.length > 0;
    } catch (err) {
        console.warn('[YANDEX-AUTH] schema check failed:', err.message);
        schemaReady = false;
    }
    if (!schemaReady) {
        console.warn('[YANDEX-AUTH] таблицы user_identities нет — раздел выключен (npm run migrate:yandex-auth, затем pm2 restart api)');
    }
    return schemaReady;
}

function resetSchemaCache() {
    schemaReady = null;
}

// ---------------------------------------------------------------------------
// state: подписанный JWT_SECRET, 60 минут
// ---------------------------------------------------------------------------

function normalizeClient(value) {
    const client = String(value || 'web').trim().toLowerCase();
    return CLIENTS.includes(client) ? client : 'web';
}

/**
 * return принимаем только относительным путём: «/lk», «/orders/123».
 * Абсолютные адреса и «//host» отбрасываем — защита от open redirect.
 */
function safeReturnPath(value) {
    const raw = String(value || '').trim();
    if (!raw.startsWith('/') || raw.startsWith('//')) return '/';
    if (raw.includes('\\')) return '/';
    return raw.slice(0, 512);
}

function signState({ client, returnPath }) {
    return jwt.sign(
        { c: client, r: returnPath, n: crypto.randomBytes(8).toString('hex'), typ: 'yx_state' },
        process.env.JWT_SECRET,
        { expiresIn: STATE_TTL_SEC },
    );
}

function verifyState(token) {
    const result = inspectState(token);
    return result.status === 'ok' ? { client: result.client, returnPath: result.returnPath } : null;
}

/**
 * Разбор state для callback: { status: 'ok' | 'expired' | 'invalid', client, returnPath }.
 *
 * 'expired' — подпись наша, но срок вышел (страницу Яндекса держали открытой слишком долго).
 * Подпись при этом проверена, поэтому client/return можно доверять и вернуть человека
 * туда, откуда он начинал, с понятной ошибкой. 'invalid' — не наш state: возвращаем на сайт.
 */
function inspectState(token) {
    const raw = String(token || '');
    const fromPayload = (payload, status) => {
        if (!payload || payload.typ !== 'yx_state') return { status: 'invalid', client: 'web', returnPath: '/' };
        return { status, client: normalizeClient(payload.c), returnPath: safeReturnPath(payload.r) };
    };
    try {
        return fromPayload(jwt.verify(raw, process.env.JWT_SECRET), 'ok');
    } catch (err) {
        if (err && err.name === 'TokenExpiredError') {
            try {
                return fromPayload(jwt.verify(raw, process.env.JWT_SECRET, { ignoreExpiration: true }), 'expired');
            } catch (inner) {
                // подпись не сошлась — не наш state
            }
        }
        return { status: 'invalid', client: 'web', returnPath: '/' };
    }
}

/**
 * Ссылка на страницу Яндекса.
 *
 * forceConfirm — повторный заход после «почта не выдана»: с force_confirm=yes
 * Яндекс снова показывает экран прав, даже если доступ уже подтверждался,
 * и пользователь может добавить галочку на почту. Без этого повтор бессмыслен:
 * Яндекс молча вернёт тот же набор прав.
 */
function authorizeUrl(state, options = {}) {
    const c = config();
    const params = new URLSearchParams({
        response_type: 'code',
        client_id: c.clientId,
        redirect_uri: c.redirectUri,
        scope: SCOPES,
        state,
        force_confirm: options.forceConfirm ? 'yes' : 'no',
    });
    return `${AUTHORIZE_URL}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// ticket: одноразовая строка в памяти процесса, 120 секунд
// ---------------------------------------------------------------------------

const tickets = new Map(); // ticket -> { userId, isNew, expiresAt }

function sweepTickets(now = Date.now()) {
    for (const [key, value] of tickets) {
        if (value.expiresAt <= now) tickets.delete(key);
    }
}

function createTicket({ userId, isNew }) {
    sweepTickets();
    const ticket = crypto.randomBytes(32).toString('hex');
    tickets.set(ticket, { userId, isNew: Boolean(isNew), expiresAt: Date.now() + TICKET_TTL_MS });
    return ticket;
}

/** Забирает ticket: второй раз тот же ticket уже не сработает. */
function consumeTicket(ticket) {
    const key = String(ticket || '');
    const value = tickets.get(key);
    if (!value) return null;
    tickets.delete(key);
    if (value.expiresAt <= Date.now()) return null;
    return value;
}

// ---------------------------------------------------------------------------
// Яндекс: обмен кода и профиль
// ---------------------------------------------------------------------------

/** Возвращает { accessToken, scope }: scope — реально выданные права, по ним видно, есть ли login:email. */
async function exchangeCodeForToken(code) {
    const c = config();
    const body = new URLSearchParams({ grant_type: 'authorization_code', code: String(code || '') });
    const basic = Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64');
    const { data } = await axios.post(TOKEN_URL, body.toString(), {
        timeout: HTTP_TIMEOUT_MS,
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${basic}`,
        },
    });
    const accessToken = data && data.access_token;
    if (!accessToken) throw new Error('yandex_token_missing');
    return { accessToken, scope: String((data && data.scope) || '') };
}

/**
 * Почта из ответа login.yandex.ru/info: основной адрес default_email, иначе первый
 * непустой из emails (приходит только с правом login:email; без него оба поля пустые).
 */
function pickEmail(data) {
    const primary = normalizeEmail(data && data.default_email);
    if (primary) return primary;
    const list = Array.isArray(data && data.emails) ? data.emails : [];
    for (const item of list) {
        const email = normalizeEmail(item);
        if (email) return email;
    }
    return '';
}

async function fetchProfile(accessToken) {
    const { data } = await axios.get(INFO_URL, {
        timeout: HTTP_TIMEOUT_MS,
        params: { format: 'json' },
        headers: { Authorization: `OAuth ${accessToken}` },
    });
    if (!data || !data.id) throw new Error('yandex_profile_missing');
    return {
        uid: String(data.id),
        email: pickEmail(data),
        firstName: String(data.first_name || '').trim() || null,
        lastName: String(data.last_name || '').trim() || null,
        login: String(data.login || '').trim() || null,
        avatarId: data.is_avatar_empty ? null : (data.default_avatar_id || null),
    };
}

function avatarUrl(avatarId) {
    return avatarId ? `https://avatars.yandex.net/get-yapic/${avatarId}/islands-200` : null;
}

// ---------------------------------------------------------------------------
// Связывание аккаунта
// ---------------------------------------------------------------------------

function normalizeEmail(email = '') {
    return String(email == null ? '' : email).trim().toLowerCase();
}

async function findUserById(id) {
    const [rows] = await db.query('SELECT * FROM users WHERE id = ? LIMIT 1', [id]);
    return rows[0] || null;
}

async function findIdentity(uid) {
    const [rows] = await db.query(
        "SELECT * FROM user_identities WHERE provider = 'yandex' AND provider_uid = ? LIMIT 1",
        [String(uid)],
    );
    return rows[0] || null;
}

async function linkIdentity(userId, profile) {
    await db.query(
        `INSERT INTO user_identities (user_id, provider, provider_uid, email)
         VALUES (?, 'yandex', ?, ?)
         ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), email = VALUES(email), updated_at = NOW()`,
        [userId, profile.uid, profile.email || null],
    );
}

/** Дозаполняем только пустые поля: то, что пользователь уже вписал, не перетираем. */
async function fillMissingProfile(user, profile) {
    const updates = [];
    const params = [];
    if (!user.name && profile.firstName) { updates.push('name = ?'); params.push(profile.firstName); }
    if (!user.l_name && profile.lastName) { updates.push('l_name = ?'); params.push(profile.lastName); }
    if (!user.avatar_url && profile.avatarId) { updates.push('avatar_url = ?'); params.push(avatarUrl(profile.avatarId)); }
    if (!updates.length) return user;
    params.push(user.id);
    try {
        await db.query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);
    } catch (err) {
        // avatar_url мог не появиться (миграцию прогнали частично) — вход это не ломает
        console.warn('[YANDEX-AUTH] profile update skipped:', err.message);
        return user;
    }
    return (await findUserById(user.id)) || user;
}

/**
 * Возвращает { user, isNew } или бросает Error('yandex_email_required'),
 * если Яндекс не отдал почту — связать аккаунт не с чем.
 *
 * users.access здесь не проверяется намеренно: это флаг видимости Totus AI
 * и звонков в приложении, а не бан; вход по коду из письма его тоже не смотрит.
 */
async function resolveUser(profile) {
    const identity = await findIdentity(profile.uid);
    if (identity) {
        const user = await findUserById(identity.user_id);
        if (user) {
            if (profile.email && normalizeEmail(identity.email) !== profile.email) {
                await db.query('UPDATE user_identities SET email = ?, updated_at = NOW() WHERE id = ?', [profile.email, identity.id]);
            }
            return { user: await fillMissingProfile(user, profile), isNew: false };
        }
        // Пользователя удалили, а связь осталась — чистим и идём дальше по email.
        await db.query('DELETE FROM user_identities WHERE id = ?', [identity.id]);
    }

    if (!profile.email) throw new Error('yandex_email_required');

    const [byEmail] = await db.query('SELECT * FROM users WHERE email = ? LIMIT 1', [profile.email]);
    if (byEmail.length) {
        const user = byEmail[0];
        await linkIdentity(user.id, profile);
        return { user: await fillMissingProfile(user, profile), isNew: false };
    }

    const loyaltyId = generateUniqueLoyaltyId();
    const [ins] = await db.query(
        'INSERT INTO users (name, l_name, email, phone, code, loyalty_id) VALUES (?, ?, ?, NULL, NULL, ?)',
        [profile.firstName, profile.lastName, profile.email, loyaltyId],
    );
    const created = await findUserById(ins.insertId);
    await linkIdentity(created.id, profile);
    return { user: await fillMissingProfile(created, profile), isNew: true };
}

// ---------------------------------------------------------------------------
// Куда возвращаем пользователя после callback
// ---------------------------------------------------------------------------

function appendQuery(url, params) {
    const query = new URLSearchParams(params).toString();
    return url.includes('?') ? `${url}&${query}` : `${url}?${query}`;
}

function returnUrl(client, params) {
    const c = config();
    if (client === 'app') return appendQuery(c.returnApp, params);
    if (client === 'desktop') return appendQuery(c.returnDesktop, params);
    return appendQuery(`${String(c.returnWeb).replace(/\/+$/, '')}/auth/yandex`, params);
}

module.exports = {
    AUTHORIZE_URL,
    TOKEN_URL,
    INFO_URL,
    SCOPES,
    TICKET_TTL_MS,
    config,
    configStatus,
    missingConfig,
    isConfigured,
    hasSchema,
    resetSchemaCache,
    normalizeClient,
    safeReturnPath,
    signState,
    verifyState,
    inspectState,
    STATE_TTL_SEC,
    authorizeUrl,
    createTicket,
    consumeTicket,
    exchangeCodeForToken,
    fetchProfile,
    pickEmail,
    avatarUrl,
    normalizeEmail,
    resolveUser,
    linkIdentity,
    findIdentity,
    returnUrl,
};
