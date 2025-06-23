const db = require('../db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');

const generateCode = () => Math.floor(1000 + Math.random() * 9000).toString();

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
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

        res.status(201).json({ message: 'User created. Verification code sent to email.' });
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

        const token = jwt.sign(users[0], process.env.JWT_SECRET, { expiresIn: '1h' })
        res.status(200).json({ message: 'Email verified successfully', user: users[0] ,authToken: token });
    } catch (err) {
        res.status(500).json({ message: 'Verification failed', error: err.message });
    }
};

exports.signin = async (req, res) => {
    const { email } = req.body;
    const code = generateCode();
    try {
        const [users] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
        const user = users[0];
        if (!user) return res.status(404).json({ message: 'User not found' });

        await db.query('UPDATE users SET code = ? WHERE email = ?', [code, email]);
        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: email,
            subject: 'Your verification code',
            text: `Your code is ${code}`,
        });
        res.status(201).json({ message: 'Verification code sent to email.' });
    } catch (err) {
        res.status(500).json({ message: 'Signin failed', error: err.message });
    }
};
