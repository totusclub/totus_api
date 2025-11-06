const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const filePath = path.join(__dirname, 'loyalty_ids.json');

let generatedIds = new Set();
if (fs.existsSync(filePath)) {
    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        generatedIds = new Set(data);
        console.log(`✅ Loaded ${generatedIds.size} existing loyalty IDs`);
    } catch (err) {
        console.error('⚠️ Error reading loyalty_ids.json:', err);
    }
}

function secureRandomDigit() {
    return String(crypto.randomBytes(1)[0] % 10);
}

function formatGroups(digits, group = 4, sep = ' ') {
    const parts = [];
    for (let i = 0; i < digits.length; i += group) {
        parts.push(digits.slice(i, i + group));
    }
    return parts.join(sep);
}

// --- Main unique ID generator ---
function generateUniqueLoyaltyId(totalLength = 16, sep = ' ') {
    while (true) {
        let digits = '';
        for (let i = 0; i < totalLength; i++) {
            digits += secureRandomDigit();
        }

        const id = formatGroups(digits, 4, sep);

        if (!generatedIds.has(id)) {
            generatedIds.add(id);
            saveIds();
            return id;
        }
    }
}

// --- Save IDs to file ---
function saveIds() {
    try {
        fs.writeFileSync(filePath, JSON.stringify([...generatedIds], null, 2));
    } catch (err) {
        console.error('❌ Failed to save loyalty IDs:', err);
    }
}

// --- Optional helpers ---
function getAllLoyaltyIds() {
    return [...generatedIds];
}

function totalCount() {
    return generatedIds.size;
}

// --- Exports ---
module.exports = {
    generateUniqueLoyaltyId,
    getAllLoyaltyIds,
    totalCount,
};
