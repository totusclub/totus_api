const db = require('../db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const {post} = require("axios");
const {generateUniqueLoyaltyId} = require("../utils/loyaltyGenerator");
const { sendEmail } = require('../utils/yandexCloudEmail');
const { verificationCodeTemplate } = require('../utils/emailTemplates');
const { verifyYandexSmartCaptcha } = require('../utils/yandexSmartCaptcha');
const auth = require('../lib/auth');

// Apple App Review demo account — fixed email + code, only this address.
const APPLE_DEMO_EMAIL = 'test@totus.com';
const APPLE_DEMO_CODE = '1111';

const generateCode = () => Math.floor(1000 + Math.random() * 9000).toString();

function normalizeEmail(email = '') {
    return String(email).trim().toLowerCase();
}

function isAppleDemoEmail(email) {
    return normalizeEmail(email) === APPLE_DEMO_EMAIL;
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
    return Array.from({ length: 4 }, () =>
        Math.floor(1000 + Math.random() * 9000)
    ).join(' ');
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

exports.signup = async (req, res) => {
    const { name, l_name, phone } = req.body;
    const email = normalizeEmail(req.body.email);
    const code = resolveVerificationCode(email);

    try {
        if (!(await assertCaptcha(req, res, { skip: isAppleDemoEmail(email) }))) return;

        const codeLoyalty = generateUniqueLoyaltyId();
        const [user] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
        if (user.length) return res.status(400).json({ message: 'Email already exists' });
        await db.query(
            'INSERT INTO users (name, l_name, email, phone, code, loyalty_id) VALUES (?, ?, ?, ?, ?, ?)',
            [name, l_name, email, phone, code, codeLoyalty]
        );
        await sendVerificationEmail(email, code, { name });

        res.status(201).json({ message: 'Пользователь создан. Код подтверждения отправлен на email.',screen:'VERIFICATION' });
    } catch (err) {
        res.status(500).json({ message: 'Signup failed', error: err.message });
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
                    'INSERT INTO users (name, l_name, email, phone, code, loyalty_id) VALUES (?, ?, ?, ?, ?, ?)',
                    ['Apple', 'Reviewer', email, null, APPLE_DEMO_CODE, codeLoyalty]
                );
                const [created] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
                users = created;
            }
        } else {
            if (!code) return res.status(400).json({ message: 'Invalid code' });
            const [matched] = await db.query(
                'SELECT * FROM users WHERE email = ? AND code = ?',
                [email, code]
            );
            users = matched;
        }

        if (users.length === 0) return res.status(400).json({ message: 'Invalid code' });

        await db.query('UPDATE users SET code = NULL WHERE email = ?', [email]);

        res.status(200).json(issueUserTokens(users[0]));
    } catch (err) {
        res.status(500).json({ message: 'Verification failed', error: err.message,auth:false });
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
                'INSERT INTO users (name, l_name, email, phone, code, loyalty_id) VALUES (?, ?, ?, ?, ?, ?)',
                ['Apple', 'Reviewer', email, null, code, codeLoyalty]
            );
            const [created] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
            user = created[0];
        }

        if (!user) return res.status(201).json({ message: 'User not found',screen:'SIGNUP' });

        await db.query('UPDATE users SET code = ? WHERE email = ?', [code, email]);
        await sendVerificationEmail(email, code, { name: user.name });
        res.status(201).json({ message: 'Код подтверждения отправлен на email.',screen:'VERIFICATION' });
    } catch (err) {
        res.status(500).json({ message: 'Signin failed', error: err.message });
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
        res.status(500).json({ message: 'Failed to load profile', error: err.message });
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
        res.status(500).json({ message: 'Refresh failed', error: err.message });
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
        res.status(500).json({ message: 'Sign-in failed', error: err.message });
    }
};

exports.generationLoyalty = async (req, res) => {
    try {
        const code = generateUniqueLoyaltyId();
        res.status(200).json({ message: 'Verification code sent to email.',code:code });
    } catch (err) {
        res.status(500).json({ message: 'Signin failed', error: err.message });
    }
};

const TELEGRAM_GATEWAY_URL = 'https://gatewayapi.telegram.org/';
const TELEGRAM_GATEWAY_TOKEN = process.env.TELEGRAM_GATEWAY_TOKEN || null;
exports.verificationCode = async (req, res) => {
    if (!TELEGRAM_GATEWAY_TOKEN) return res.status(503).json({ message: 'Phone verification is not configured' });
    const { phone } = req.body;
    // const code = generateCode();
    const code = 1111;
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
            code_length: 4,
            code:code,
            ttl: 60, // 60 seconds
            payload: 'verify_user_001',
            // callback_url: 'http://localhost:3001/api/auth/telegram-verification-callback'
        });

        res.status(200).json(sendResult);

    } catch (err) {
        res.status(500).json({ message: 'Signin failed', error: err.message });
    }
};

exports.telegramVerificationCallback = async (req, res) => {
    try {
        console.log('req',req?.body)
        console.log('req.params',req.params)
    } catch (err) {
        res.status(500).json({ message: 'Signin failed', error: err.message });
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
