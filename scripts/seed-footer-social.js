/**
 * Seed footer social links from existing footer mock icons.
 * Run: node scripts/seed-footer-social.js
 */
require('dotenv').config();
require('dotenv').config({ path: '.env.local', override: true });
const db = require('../db');

const SEED = [
    { title: 'VK', icon: 'vk', url: '', sort_order: 1 },
    { title: 'Rutube', icon: 'rutube', url: '', sort_order: 2 },
    { title: 'AI Star', icon: 'aiStar', url: '', sort_order: 3 },
    { title: 'VC', icon: 'vc', url: '', sort_order: 4 },
];

async function seed() {
    const [rows] = await db.query('SELECT COUNT(*) AS cnt FROM footer_social_links');
    if (rows[0].cnt > 0) {
        console.log('footer_social_links already has data — skip.');
        process.exit(0);
    }

    for (const item of SEED) {
        await db.query(
            'INSERT INTO footer_social_links (title, icon, url, sort_order, is_active) VALUES (?, ?, ?, ?, 1)',
            [item.title, item.icon, item.url, item.sort_order],
        );
        console.log(`  added ${item.title} (${item.icon})`);
    }
    console.log('Done.');
    process.exit(0);
}

seed().catch((err) => {
    console.error('Seed failed:', err.message);
    process.exit(1);
});
