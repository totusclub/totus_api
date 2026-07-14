const mysql = require('mysql2/promise');
require('dotenv').config();
require('dotenv').config({ path: '.env.local', override: true });

const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
});

module.exports = db;
