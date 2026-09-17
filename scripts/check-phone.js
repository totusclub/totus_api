// Проверка российской валидации телефона без БД и сети: node scripts/check-phone.js
const assert = require('assert');
const { normalizeRuPhone, isRuPhone } = require('../lib/phone');

// Принимаем и приводим к +7XXXXXXXXXX
assert.strictEqual(normalizeRuPhone('+7 (999) 123-45-67'), '+79991234567');
assert.strictEqual(normalizeRuPhone('8 999 123 45 67'), '+79991234567');
assert.strictEqual(normalizeRuPhone('89991234567'), '+79991234567');
assert.strictEqual(normalizeRuPhone('9991234567'), '+79991234567');
assert.strictEqual(normalizeRuPhone('+7 495 123-45-67'), '+74951234567');
assert.strictEqual(normalizeRuPhone('8-800-555-35-35'), '+78005553535');
assert.strictEqual(normalizeRuPhone(' 7 999 123 45 67 '), '+79991234567');

// Не российские и битые
assert.strictEqual(normalizeRuPhone('+7 701 123 45 67'), null, 'Казахстан 7xx');
assert.strictEqual(normalizeRuPhone('+7 600 123 45 67'), null, 'Казахстан 6xx');
assert.strictEqual(normalizeRuPhone('+1 202 555 0143'), null, 'США');
assert.strictEqual(normalizeRuPhone('+44 20 7946 0958'), null, 'Великобритания');
assert.strictEqual(normalizeRuPhone('+380 44 123 4567'), null, 'Украина');
assert.strictEqual(normalizeRuPhone('999123456'), null, 'короткий');
assert.strictEqual(normalizeRuPhone('799912345678'), null, 'длинный');
assert.strictEqual(normalizeRuPhone(''), null);
assert.strictEqual(normalizeRuPhone(null), null);
assert.strictEqual(normalizeRuPhone('не номер'), null);

assert.strictEqual(isRuPhone('+79991234567'), true);
assert.strictEqual(isRuPhone('+12025550143'), false);

console.log('ALL PHONE CHECKS PASSED');
