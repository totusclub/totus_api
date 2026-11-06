const db = require('../db');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const {post} = require("axios");
const {generateUniqueLoyaltyId} = require("../utils/loyaltyGenerator");
const { sendEmail } = require('../utils/yandexCloudEmail');
const { verificationCodeTemplate } = require('../utils/emailTemplates');
const { verifyYandexSmartCaptcha } = require('../utils/yandexSmartCaptcha');
const auth = require('../lib/auth');

// Apple App Review demo account — fixed email + code, only this address.
// APPLE_DEMO_ENABLED=0 выключает демо-вход после прохождения ревью (M1 аудита). По умолчанию включён.
const APPLE_DEMO_EMAIL = 'test@totus.com';
const APPLE_DEMO_CODE = '1111';
const APPLE_DEMO_ENABLED = process.env.APPLE_DEMO_ENABLED !== '0';

// Код входа (C5 аудита): длина настраивается (по умолчанию 4 — как было, без слома полей ввода),
// генерация криптостойкая. TTL и лимит попыток применяются, только если в таблице users есть
// колонки code_expires_at / code_attempts (scripts/migrate-login-code-security.js); без них —
// поведение как раньше. Значения берутся из окружения.
const LOGIN_CODE_LENGTH = Math.min(8, Math.max(4, Number(process.env.LOGIN_CODE_LENGTH) || 4));
const LOGIN_CODE_TTL_SECONDS = Math.max(60, Number(process.env.LOGIN_CODE_TTL_SECONDS) || 600);
const LOGIN_CODE_MAX_ATTEMPTS = Math.max(3, Number(process.env.LOGIN_CODE_MAX_ATTEMPTS) || 5);

// Новый пользователь сразу получает Calling (чат и звонок в поддержку) и AI (Мила):
// users.access = 0 — «Доступ» в Calling Admin; 1 — «Заблок.»; NULL calling_api_v2
// (GET /api/users/by-id) считает заблокированным, поэтому значение пишем явно.
// Только для обычных пользователей: вход в панель оператора дополнительно требует role = 'agent'.
// Приложение и сайт читают флаг из calling_api_v2 — их менять не нужно (решение владельца 03.11.2026).
const NEW_USER_ACCESS = 0;

// Криптостойкий код фиксированной длины (без ведущего нуля — как в прежней логике 1000–9999).
const generateCode = () => {
    const min = 10 ** (LOGIN_CODE_LENGTH - 1);
    const max = 10 ** LOGIN_CODE_LENGTH;
    return String(crypto.randomInt(min, max));
};

function normalizeEmail(email = '') {
    return String(email).trim().toLowerCase();
}

function isAppleDemoEmail(email) {
    return APPLE_DEMO_ENABLED && normalizeEmail(email) === APPLE_DEMO_EMAIL;
}

// Есть ли в users колонки для срока жизни кода и счётчика попыток (читается один раз на процесс).
let codeColumnsCache = null;
async function getCodeColumns() {
    if (codeColumnsCache) return codeColumnsCache;
    const cols = { code_expires_at: false, code_attempts: false };
    try {
        const [rows] = await db.query(
            `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
               AND COLUMN_NAME IN ('code_expires_at', 'code_attempts')`,
        );
        for (const c of rows) cols[c.COLUMN_NAME] = true;
        codeColumnsCache = cols;
    } catch (e) {
        console.warn('[AUTH] cannot read users code columns:', e.message);
        return { code_expires_at: false, code_attempts: false };
    }
    return codeColumnsCache;
}

// Проставить срок жизни кода и обнулить счётчик попыток после выдачи нового кода (если колонки есть).
async function setCodeMeta(email) {
    const cols = await getCodeColumns();
    const sets = [];
    const params = [];
    if (cols.code_expires_at) { sets.push('code_expires_at = DATE_ADD(NOW(), INTERVAL ? SECOND)'); params.push(LOGIN_CODE_TTL_SECONDS); }
    if (cols.code_attempts) sets.push('code_attempts = 0');
    if (!sets.length) return;
    params.push(email);
    await db.query(`UPDATE users SET ${sets.join(', ')} WHERE email = ?`, params)
        .catch((e) => console.warn('[AUTH] setCodeMeta failed:', e.message));
}

function resolveVerificationCode(email) {
    return isAppleDemoEmail(email) ? APPLE_DEMO_CODE : generateCode();
}

async function sendVerificationEmail(email, code, { name } = {}) {
    // Demo account: do not send a real email; reviewers use the fixed code.
    if (isAppleDemoEmail(email)) return;

    const verificationEmail = verificationCodeTemplate(code, { name });
    await sendEmail({
        to: email,
        subject: verificationEmail.subject,
        text: verificationEmail.text,
        html: verificationEmail.html,
    });
}

function generateUserCode() {
    return Array.from({ length: 4 }, () => String(crypto.randomInt(1000, 10000))).join(' ');
}

function getSmartCaptchaToken(body = {}) {
    return (
        body['smart-token'] ||
        body.smartToken ||
        body.smart_token ||
        body.captchaToken ||
        ''
    );
}

async function assertCaptcha(req, res, { skip = false } = {}) {
    if (skip) return true;

    const result = await verifyYandexSmartCaptcha(req, getSmartCaptchaToken(req.body));
    if (!result.ok) {
        res.status(400).json({
            message: result.message || 'Captcha validation failed',
            error: 'captcha_failed',
        });
        return false;
    }
    return true;
}

// Ответ с токенами для сайта/приложения. `authToken` — историческое имя,
// его читают текущие версии сайта и приложения; accessToken/refreshToken — новые.
function issueUserTokens(userRow) {
    const accessToken = auth.signUserToken(userRow);
    const refreshToken = auth.signRefreshToken(userRow.id, 'user');
    return { auth: true, authToken: accessToken, accessToken, refreshToken };
}

// Необязательные поля регистрации. Приложение (уже установленные версии) шлёт
// только имя и email — без фамилии и телефона, а колонки users.l_name / users.phone
// в базе могут быть NOT NULL. Чтобы регистрация не падала с 500, пустое значение
// пишем как NULL, если колонка это допускает, иначе — как пустую строку.
// Схема читается из INFORMATION_SCHEMA один раз на процесс.
let usersNullableCache = null;
async function getUsersNullable() {
    if (usersNullableCache) return usersNullableCache;
    const nullable = { l_name: true, phone: true };
    try {
        const [cols] = await db.query(
            `SELECT COLUMN_NAME, IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
               AND COLUMN_NAME IN ('l_name', 'phone')`,
        );
        for (const c of cols) nullable[c.COLUMN_NAME] = c.IS_NULLABLE === 'YES';
        usersNullableCache = nullable;
    } catch (e) {
        console.warn('[SIGNUP] cannot read users schema:', e.message);
        // консервативно: считаем, что NULL нельзя
        return { l_name: false, phone: false };
    }
    return usersNullableCache;
}

function optionalField(value, allowNull) {
    const str = value === undefined || value === null ? '' : String(value).trim();
    if (str) return str;
    return allowNull ? null : '';
}

exports.signup = async (req, res) => {
    const email = normalizeEmail(req.body.email);
    const code = resolveVerificationCode(email);
    let createdUserId = null;

    try {
        if (!(await assertCaptcha(req, res, { skip: isAppleDemoEmail(email) }))) return;

        const name = String(req.body.name ?? '').trim();
        if (!email || !name) {
            return res.status(400).json({ message: 'Укажите имя и email' });
        }
        const nullable = await getUsersNullable();
        const lName = optionalField(req.body.l_name, nullable.l_name);
        const phone = optionalField(req.body.phone, nullable.phone);

        const codeLoyalty = generateUniqueLoyaltyId();
        const [user] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
        if (user.length) return res.status(400).json({ message: 'Email already exists' });
        const [ins] = await db.query(
            'INSERT INTO users (name, l_name, email, phone, code, loyalty_id, access) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [name, lName, email, phone, code, codeLoyalty, NEW_USER_ACCESS]
        );
        createdUserId = ins?.insertId ?? null;
        await setCodeMeta(email);

        try {
            await sendVerificationEmail(email, code, { name });
        } catch (mailErr) {
            // Письмо не ушло — не оставляем «висящего» пользователя, иначе повторная
            // попытка упрётся в «Email already exists».
            console.error('[SIGNUP] verification email failed:', mailErr.message);
            if (createdUserId) {
                await db.query('DELETE FROM users WHERE id = ? AND email = ?', [createdUserId, email]).catch(() => {});
            }
            return res.status(502).json({
                message: 'Не удалось отправить код на почту. Попробуйте ещё раз через минуту.',
                error: 'email_send_failed',
            });
        }

        res.status(201).json({ message: 'Пользователь создан. Код подтверждения отправлен на email.',screen:'VERIFICATION' });
    } catch (err) {
        console.error('[SIGNUP] failed:', err.code || '', err.message);
        res.status(500).json({ message: 'Signup failed' });
    }
};



exports.verifyCode = async (req, res) => {
    const email = normalizeEmail(req.body.email);
    const code = String(req.body.code ?? '').trim();
    try {
        let users;

        if (isAppleDemoEmail(email) && code === APPLE_DEMO_CODE) {
            const [demoUsers] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
            users = demoUsers;
            if (users.length === 0) {
                const codeLoyalty = generateUniqueLoyaltyId();
                await db.query(
                    'INSERT INTO users (name, l_name, email, phone, code, loyalty_id, access) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    ['Apple', 'Reviewer', email, null, APPLE_DEMO_CODE, codeLoyalty, NEW_USER_ACCESS]
                );
                const [created] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
                users = created;
            }
        } else {
            if (!code) return res.status(400).json({ message: 'Invalid code' });
            const cols = await getCodeColumns();
            const [rows] = await db.query('SELECT * FROM users WHERE email = ? LIMIT 1', [email]);
            const candidate = rows[0];
            if (!candidate) return res.status(400).json({ message: 'Invalid code' });

            // Лимит попыток: защита от перебора (если колонка есть).
            if (cols.code_attempts && Number(candidate.code_attempts || 0) >= LOGIN_CODE_MAX_ATTEMPTS) {
                return res.status(429).json({ message: 'Слишком много попыток. Запросите новый код.', error: 'too_many_attempts' });
            }
            // Срок жизни кода (если колонка есть).
            const expired = cols.code_expires_at && candidate.code_expires_at
                && new Date(candidate.code_expires_at).getTime() < Date.now();
            const codeOk = candidate.code != null && String(candidate.code) === code && !expired;
            if (!codeOk) {
                if (cols.code_attempts) {
                    await db.query('UPDATE users SET code_attempts = COALESCE(code_attempts, 0) + 1 WHERE email = ?', [email]).catch(() => {});
                }
                return res.status(400).json({ message: 'Invalid code' });
            }
            users = [candidate];
        }

        if (users.length === 0) return res.status(400).json({ message: 'Invalid code' });

        // Код одноразовый: гасим его и сбрасываем счётчик попыток (колонка — если есть).
        const cols2 = await getCodeColumns();
        await db.query(
            `UPDATE users SET code = NULL${cols2.code_attempts ? ', code_attempts = 0' : ''} WHERE email = ?`,
            [email],
        );

        res.status(200).json(issueUserTokens(users[0]));
    } catch (err) {
        console.error('[AUTH] Verification failed:', err.message);
        res.status(500).json({ message: 'Verification failed',auth:false });
    }
};

exports.signin = async (req, res) => {
    const email = normalizeEmail(req.body.email);
    const code = resolveVerificationCode(email);
    try {
        if (!(await assertCaptcha(req, res, { skip: isAppleDemoEmail(email) }))) return;

        const [users] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
        let user = users[0];

        // Ensure Apple demo account always exists and can sign in.
        if (!user && isAppleDemoEmail(email)) {
            const codeLoyalty = generateUniqueLoyaltyId();
            await db.query(
                'INSERT INTO users (name, l_name, email, phone, code, loyalty_id, access) VALUES (?, ?, ?, ?, ?, ?, ?)',
                ['Apple', 'Reviewer', email, null, code, codeLoyalty, NEW_USER_ACCESS]
            );
            const [created] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
            user = created[0];
        }

        if (!user) return res.status(201).json({ message: 'User not found',screen:'SIGNUP' });

        await db.query('UPDATE users SET code = ? WHERE email = ?', [code, email]);
        await setCodeMeta(email);
        await sendVerificationEmail(email, code, { name: user.name });
        res.status(201).json({ message: 'Код подтверждения отправлен на email.',screen:'VERIFICATION' });
    } catch (err) {
        console.error('[AUTH] Signin failed:', err.message);
        res.status(500).json({ message: 'Signin failed' });
    }
};

// GET /api/auth/me — профиль по токену (сайт/приложение перестают читать его из payload).
exports.me = async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM users WHERE id = ? LIMIT 1', [req.auth.id]);
        const user = rows[0];
        if (!user) return res.status(404).json({ message: 'User not found' });
        res.json({ user: { ...auth.publicUser(user), role: auth.roleOf(req.auth.payload) } });
    } catch (err) {
        console.error('[AUTH] Failed to load profile:', err.message);
        res.status(500).json({ message: 'Failed to load profile' });
    }
};

// POST /api/auth/refresh  { refreshToken }  (также принимает { accessToken, refreshToken } — формат приложения)
exports.refresh = async (req, res) => {
    const refreshToken = String(req.body?.refreshToken || req.body?.refresh_token || req.body?.token || '').trim();
    if (!refreshToken) return res.status(400).json({ message: 'Missing refreshToken' });
    if (!process.env.JWT_REFRESH_SECRET) return res.status(503).json({ error: 'auth_not_configured' });

    try {
        const payload = auth.verifyRefreshToken(refreshToken);
        if (!payload || (payload.scope !== 'user' && payload.scope !== 'agent')) {
            return res.status(401).json({ error: 'unauthorized' });
        }
        const [rows] = await db.query('SELECT * FROM users WHERE id = ? LIMIT 1', [payload.id]);
        const user = rows[0];
        if (!user) return res.status(401).json({ error: 'unauthorized' });
        if (Number(user.access) === 1 && payload.scope === 'agent') {
            return res.status(403).json({ error: 'forbidden' });
        }

        if (payload.scope === 'agent') {
            return res.json({
                accessToken: auth.signAgentToken(user),
                refreshToken: auth.signRefreshToken(user.id, 'agent'),
            });
        }
        res.json(issueUserTokens(user));
    } catch (err) {
        console.error('[AUTH] Refresh failed:', err.message);
        res.status(500).json({ message: 'Refresh failed' });
    }
};

// POST /api/auth/agent/sign-in  { email, password }
// Агенты — строки users с role='agent'. Пароли переводятся на bcrypt лениво:
// если в БД не bcrypt-хэш, сравниваем как есть и при успехе перехэшируем.
function looksLikeBcrypt(value) {
    return typeof value === 'string' && /^\$2[aby]\$\d{2}\$/.test(value);
}

exports.agentSignIn = async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password ?? '');
    if (!email || !password) return res.status(400).json({ message: 'Email and password are required' });

    try {
        const [rows] = await db.query('SELECT * FROM users WHERE email = ? LIMIT 1', [email]);
        const user = rows[0];
        const invalid = () => res.status(401).json({ message: 'Invalid email or password' });

        if (!user || String(user.role || '').toLowerCase() !== 'agent' || !user.password) return invalid();

        let ok = false;
        if (looksLikeBcrypt(user.password)) {
            ok = await bcrypt.compare(password, user.password);
        } else if (user.password === password) {
            ok = true;
            try {
                const hash = await bcrypt.hash(password, 10);
                await db.query('UPDATE users SET password = ? WHERE id = ?', [hash, user.id]);
            } catch (rehashErr) {
                console.warn('[AUTH] agent password rehash failed:', rehashErr.message);
            }
        }
        if (!ok) return invalid();

        // users.access: 0/NULL — разрешён, 1 — заблокирован (как в calling_api_v2 login)
        if (Number(user.access) === 1) return res.status(403).json({ message: 'Access denied' });

        res.json({
            accessToken: auth.signAgentToken(user),
            refreshToken: auth.signRefreshToken(user.id, 'agent'),
            user: { ...auth.publicUser(user), role: 'agent' },
        });
    } catch (err) {
        console.error('[AUTH] Sign-in failed:', err.message);
        res.status(500).json({ message: 'Sign-in failed' });
    }
};

exports.generationLoyalty = async (req, res) => {
    try {
        const code = generateUniqueLoyaltyId();
        res.status(200).json({ message: 'Verification code sent to email.',code:code });
    } catch (err) {
        console.error('[AUTH] Signin failed:', err.message);
        res.status(500).json({ message: 'Signin failed' });
    }
};

const TELEGRAM_GATEWAY_URL = 'https://gatewayapi.telegram.org/';
const TELEGRAM_GATEWAY_TOKEN = process.env.TELEGRAM_GATEWAY_TOKEN || null;
exports.verificationCode = async (req, res) => {
    if (!TELEGRAM_GATEWAY_TOKEN) return res.status(503).json({ message: 'Phone verification is not configured' });
    const { phone } = req.body;
    // M2 аудита: раньше код был зашит (1111). Теперь — криптостойкий, как для email.
    const code = generateCode();
    try {
        const checkResult = await gatewayPost('checkSendAbility', {
            phone_number: phone,
        });
        if (!checkResult || !checkResult?.result?.request_id) {
            console.log('User not eligible or failed to check send ability.');
            res.status(200).json(checkResult);
            return;
        }
        const sendResult = await gatewayPost('sendVerificationMessage', {
            phone_number: phone,
            request_id: checkResult?.result.request_id,
            code_length: LOGIN_CODE_LENGTH,
            code:code,
            ttl: 60, // 60 seconds
            payload: 'verify_user_001',
            // callback_url: 'http://localhost:3001/api/auth/telegram-verification-callback'
        });

        res.status(200).json(sendResult);

    } catch (err) {
        console.error('[AUTH] Signin failed:', err.message);
        res.status(500).json({ message: 'Signin failed' });
    }
};

exports.telegramVerificationCallback = async (req, res) => {
    try {
        // M6 аудита: тело callback (телефон, код) в лог не пишем; раньше ответ не отправлялся вовсе.
        res.status(200).json({ ok: true });
    } catch (err) {
        console.error('[AUTH] Signin failed:', err.message);
        res.status(500).json({ message: 'Signin failed' });
    }
};



async function gatewayPost(endpoint, data) {
    try {
        const response = await post(
            `${TELEGRAM_GATEWAY_URL}${endpoint}`,
            data,
            {
                headers: {
                    Authorization: `Bearer ${TELEGRAM_GATEWAY_TOKEN}`,
                    'Content-Type': 'application/json',
                },
            }
        );
        return response.data;
    } catch (error) {
        console.error('Telegram Gateway API Error:', error.response?.data || error.message);
        return null;
    }
}
