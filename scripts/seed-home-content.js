/**
 * Seed home recommended hotels and popular destinations with default content.
 * Run from kedam_API folder:  node scripts/seed-home-content.js
 */
require('dotenv').config();
require('dotenv').config({ path: '.env.local', override: true });
const db = require('../db');

const HOTELS = [
    {
        hotel_id: 9149847,
        name: 'Swissotel Sharm El Sheikh Managed By Rixos',
        rate: 5,
        city: 'Наама Бэй, Шарм-эль-Шейх',
        image: 'https://img.cdn.level.travel/hotels/9149847/def8891aa911a636e350e8438d9437ba_webp_x620.webp',
        sort_order: 1,
    },
    {
        hotel_id: 9085039,
        name: 'Cosmos Collection Altay Resort',
        rate: 5,
        city: 'Урлу-Аспак, Майминский район',
        image: 'https://img.cdn.level.travel/hotels/9085039/f58b3c014000931c90910baa6298598d_webp_x620.webp',
        sort_order: 2,
    },
    {
        hotel_id: 9022465,
        name: 'Rixos Premium Seagate',
        rate: 5,
        city: 'Шарм-эль-Шейх',
        image: 'https://img.cdn.level.travel/hotels/9022465/2bc6112958c15dd0d888b039bf10c3ee_webp_x620.webp',
        sort_order: 3,
    },
];

const DESTINATIONS = [
    { name: 'Египет', image: 'https://api.totus.club/upload/home/egypt.png', to_country: 'EG', sort_order: 1 },
    { name: 'Турция', image: 'https://api.totus.club/upload/home/turky.png', to_country: 'TR', sort_order: 2 },
    { name: 'Россия', image: 'https://api.totus.club/upload/home/russon.png', to_country: 'RU', sort_order: 3 },
    { name: 'Мальдивы', image: 'https://api.totus.club/upload/home/maldiv.png', to_country: 'MV', sort_order: 4 },
    { name: 'ОАЭ', image: 'https://api.totus.club/upload/home/oae.png', to_country: 'AE', sort_order: 5 },
    { name: 'Индонезия', image: 'https://api.totus.club/upload/home/indonezia.png', to_country: 'ID', sort_order: 6 },
];

async function seed() {
    const [hotelCount] = await db.query('SELECT COUNT(*) AS count FROM home_recommended_hotels');
    if (hotelCount[0].count === 0) {
        for (const hotel of HOTELS) {
            await db.query(
                `INSERT INTO home_recommended_hotels
                 (hotel_id, name, rate, city, price, review, image, sort_order)
                 VALUES (?, ?, ?, ?, 0, 0, ?, ?)`,
                [hotel.hotel_id, hotel.name, hotel.rate, hotel.city, hotel.image, hotel.sort_order],
            );
            console.log(`  added hotel ${hotel.name}`);
        }
    } else {
        console.log('  skip hotels (already seeded)');
    }

    const [destCount] = await db.query('SELECT COUNT(*) AS count FROM home_popular_destinations');
    if (destCount[0].count === 0) {
        for (const dest of DESTINATIONS) {
            await db.query(
                'INSERT INTO home_popular_destinations (name, image, to_country, sort_order) VALUES (?, ?, ?, ?)',
                [dest.name, dest.image, dest.to_country, dest.sort_order],
            );
            console.log(`  added destination ${dest.name}`);
        }
    } else {
        console.log('  skip destinations (already seeded)');
    }

    console.log('Done.');
    process.exit(0);
}

seed().catch((err) => {
    console.error('Seed failed:', err.message);
    process.exit(1);
});
