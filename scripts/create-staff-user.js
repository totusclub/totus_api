/**
 * Create or update a CMS staff user for /api/admin/auth/sign-in.
 * Run: node scripts/create-staff-user.js <email> <password> [name] [lastname] [role]
 * role defaults to 'admin'. The password is bcrypt-hashed; it is never logged.
 */
require('dotenv').config();
const bcrypt = require('bcrypt');
const db = require('../db');

// Columns match what controllers/authController.js reads:
// email, password (bcrypt hash), name, lastname, role, refresh_token.
async function ensureStaffTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS staff (
      id INT AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(255) NOT NULL UNIQUE,
      password VARCHAR(255) NOT NULL,
      name VARCHAR(255) NULL,
      lastname VARCHAR(255) NULL,
      role VARCHAR(64) NOT NULL DEFAULT 'admin',
      refresh_token TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

async function run() {
  const args = process.argv.slice(2);
  const email = String(args[0] || '').trim().toLowerCase();
  const password = args[1];
  const name = args[2] || null;
  const lastname = args[3] || null;
  const roleProvided = args.length >= 5 && args[4];
  const role = roleProvided ? String(args[4]) : 'admin';

  if (!email || !password) {
    console.error('Usage: node scripts/create-staff-user.js <email> <password> [name] [lastname] [role]');
    process.exit(1);
    return;
  }

  await ensureStaffTable();

  const hash = await bcrypt.hash(password, 10);
  const [rows] = await db.query('SELECT id FROM staff WHERE email = ? LIMIT 1', [email]);

  if (rows.length > 0) {
    // Existing user: reset the password; touch name/lastname/role only when passed.
    await db.query(
      `UPDATE staff
       SET password = ?,
           name = COALESCE(?, name),
           lastname = COALESCE(?, lastname),
           role = COALESCE(?, role)
       WHERE email = ?`,
      [hash, name, lastname, roleProvided ? role : null, email]
    );
    console.log(`Staff user ${email} updated`);
  } else {
    await db.query(
      'INSERT INTO staff (email, password, name, lastname, role) VALUES (?, ?, ?, ?, ?)',
      [email, hash, name, lastname, role]
    );
    console.log(`Staff user ${email} created`);
  }

  process.exit(0);
}

run().catch((err) => {
  console.error('Failed to create staff user:', err.message);
  process.exit(1);
});
