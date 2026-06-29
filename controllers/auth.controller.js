const db = require('../db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const {post} = require("axios");
const {generateUniqueLoyaltyId} = require("../utils/loyaltyGenerator");
const { sendEmail } = require('../utils/yandexCloudEmail');
const { verificationCodeTemplate } = require('../utils/emailTemplates');

const generateCode = () => Math.floor(1000 + Math.random() * 9000).toString();

async function sendVerificationEmail(email, code, { name } = {}) {
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
exports.signup = async (req, res) => {
    const { name, l_name, email, phone } = req.body;
    const code = generateCode();

    try {
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
    const { email, code } = req.body;
    try {
        const [users] = await db.query('SELECT * FROM users WHERE email = ? AND code = ?', [email, code]);

        if (users.length === 0) return res.status(400).json({ message: 'Invalid code' });

        await db.query('UPDATE users SET code = NULL WHERE email = ?', [email]);

        const token = jwt.sign(users[0], process.env.JWT_SECRET, { expiresIn: '30d' })
        res.status(200).json({ auth: true, authToken: token });
    } catch (err) {
        res.status(500).json({ message: 'Verification failed', error: err.message,auth:false });
    }
};

exports.signin = async (req, res) => {
    const { email } = req.body;
    const code = generateCode();
    try {
        const [users] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
        const user = users[0];
        if (!user) return res.status(201).json({ message: 'User not found',screen:'SIGNUP' });

        await db.query('UPDATE users SET code = ? WHERE email = ?', [code, email]);
        await sendVerificationEmail(email, code, { name: user.name });
        res.status(201).json({ message: 'Код подтверждения отправлен на email.',screen:'VERIFICATION' });
    } catch (err) {
        res.status(500).json({ message: 'Signin failed', error: err.message });
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
const TELEGRAM_GATEWAY_TOKEN = 'AAGBIQAAULKEuFRsUuz4HRKyFDIPW20wYKw2A8YwISEVGA'; // replace this
exports.verificationCode = async (req, res) => {
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
