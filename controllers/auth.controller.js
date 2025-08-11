const db = require('../db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const {post} = require("axios");

const generateCode = () => Math.floor(1000 + Math.random() * 9000).toString();

const transporter = nodemailer.createTransport({
    host: 'smtp.yandex.com',
    port: 465, // or use 587 with secure: false
    secure: true, // true for 465, false for 587
    auth: {
        user: process.env.EMAIL_USER, // e.g. yourname@yandex.com
        pass: process.env.EMAIL_PASS, // app password
    },
});
exports.signup = async (req, res) => {
    const { name, l_name, email, phone } = req.body;
    const code = generateCode();

    try {
        const [user] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
        if (user.length) return res.status(400).json({ message: 'Email already exists' });
        await db.query(
            'INSERT INTO users (name, l_name, email, phone, code) VALUES (?, ?, ?, ?, ?)',
            [name, l_name, email, phone, code]
        );
        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: email,
            subject: 'Your verification code',
            text: `Your code is ${code}`,
        });

        res.status(201).json({ message: 'User created. Verification code sent to email.',screen:'VERIFICATION' });
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
        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: email,
            subject: 'Your verification code',
            text: `Your code is ${code}`,
        });
        res.status(201).json({ message: 'Verification code sent to email.',screen:'VERIFICATION' });
    } catch (err) {
        res.status(500).json({ message: 'Signin failed', error: err.message });
    }
};

const TELEGRAM_GATEWAY_URL = 'https://gatewayapi.telegram.org/';
const TELEGRAM_GATEWAY_TOKEN = 'AAGBIQAAULKEuFRsUuz4HRKyFDIPW20wYKw2A8YwISEVGA'; // replace this
exports.verificationCode = async (req, res) => {
    const { phone } = req.body;
    const code = generateCode();
    try {
        const checkResult = await gatewayPost('checkSendAbility', {
            phone_number: phone,
        });
        console.log('checkResult',checkResult)
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
