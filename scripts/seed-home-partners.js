/**
 * Seed home page partners from existing SVG icon components in kedam_WEB.
 * Run from kedam_API folder:  node scripts/seed-home-partners.js
 */
require('dotenv').config();
require('dotenv').config({ path: '.env.local', override: true });

const fs = require('fs');
const path = require('path');
const db = require('../db');

const ICONS_DIR = path.join(__dirname, '../../kedam_WEB/src/components/icons/partner');
const UPLOAD_DIR = path.join(__dirname, '../uploads/partners');

const PARTNERS = [
    { slug: 'tezTour', name: 'TEZ TOUR', sort_order: 1 },
    { slug: 'onexTour', name: 'ONEX Tour', sort_order: 2 },
    { slug: 'funAndSun', name: 'FUN&SUN', sort_order: 3 },
    { slug: 'biblioGlobus', name: 'Библио-Глобус', sort_order: 4 },
    { slug: 'pegasTour', name: 'Pegas Touristik', sort_order: 5 },
    { slug: 'coralTravel', name: 'Coral Travel', sort_order: 6 },
];

const JSX_ATTR_MAP = {
    fillRule: 'fill-rule',
    clipRule: 'clip-rule',
    strokeWidth: 'stroke-width',
    strokeLinecap: 'stroke-linecap',
    strokeLinejoin: 'stroke-linejoin',
    strokeMiterlimit: 'stroke-miterlimit',
    strokeDasharray: 'stroke-dasharray',
    strokeDashoffset: 'stroke-dashoffset',
    strokeOpacity: 'stroke-opacity',
    fillOpacity: 'fill-opacity',
    stopColor: 'stop-color',
    stopOpacity: 'stop-opacity',
    clipPath: 'clip-path',
    gradientUnits: 'gradientUnits',
    gradientTransform: 'gradientTransform',
    xlinkHref: 'xlink:href',
};

function sanitizeSvg(svg) {
    let out = svg.replace(/\{\.\.\.props\}/g, '');
    for (const [jsx, svgAttr] of Object.entries(JSX_ATTR_MAP)) {
        out = out.replace(new RegExp(`\\b${jsx}=`, 'g'), `${svgAttr}=`);
    }
    return out.replace(/\s+/g, ' ').trim();
}

function extractSvgFromTsx(filePath) {
    const content = fs.readFileSync(filePath, 'utf8');
    const match = content.match(/<svg[\s\S]*?<\/svg>/);
    if (!match) {
        throw new Error(`SVG not found in ${filePath}`);
    }
    return sanitizeSvg(match[0]);
}

async function seed() {
    if (!fs.existsSync(UPLOAD_DIR)) {
        fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    }

    const [existing] = await db.query('SELECT COUNT(*) AS count FROM home_partners');
    if (existing[0].count > 0) {
        console.log(`home_partners already has ${existing[0].count} rows — skip seeding.`);
        process.exit(0);
    }

    for (const partner of PARTNERS) {
        const tsxPath = path.join(ICONS_DIR, `${partner.slug}.tsx`);
        if (!fs.existsSync(tsxPath)) {
            throw new Error(`Icon file not found: ${tsxPath}`);
        }

        const svg = extractSvgFromTsx(tsxPath);
        const filename = `${partner.slug}.svg`;
        const filePath = path.join(UPLOAD_DIR, filename);
        fs.writeFileSync(filePath, svg, 'utf8');

        const image = `/uploads/partners/${filename}`;
        await db.query(
            'INSERT INTO home_partners (name, image, url, sort_order) VALUES (?, ?, ?, ?)',
            [partner.name, image, '', partner.sort_order],
        );
        console.log(`  added ${partner.name}`);
    }

    console.log('Done.');
    process.exit(0);
}

seed().catch((err) => {
    console.error('Seed failed:', err.message);
    process.exit(1);
});
