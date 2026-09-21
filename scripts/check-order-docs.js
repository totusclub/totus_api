'use strict';

/**
 * Проверка логики подписанных ссылок на документы заказа — без БД и без сети.
 * Запуск: node scripts/check-order-docs.js
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-check-only';

const assert = require('assert');
const {
    parseOrderDocPath,
    isOrderDocPath,
    signDocToken,
    verifyDocToken,
    signDocUrl,
    signDocUrlsDeep,
} = require('../lib/orderDocLinks');

let passed = 0;
function check(name, fn) {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
}

console.log('order documents: разбор пути');

check('обычная ссылка разбирается', () => {
    assert.deepStrictEqual(parseOrderDocPath('/uploads/orders/331445018/Ваучер.pdf'), {
        orderId: 331445018,
        filename: 'Ваучер.pdf',
    });
});

check('кириллица в percent-encoding разбирается', () => {
    assert.deepStrictEqual(
        parseOrderDocPath('/uploads/orders/331445018/%D0%92%D0%B0%D1%83%D1%87%D0%B5%D1%80.pdf'),
        { orderId: 331445018, filename: 'Ваучер.pdf' },
    );
});

check('query и hash отбрасываются', () => {
    assert.strictEqual(parseOrderDocPath('/uploads/orders/12/a.pdf?t=1.abc#x').filename, 'a.pdf');
});

check('посторонние пути не проходят', () => {
    assert.strictEqual(parseOrderDocPath('/uploads/banners/1.png'), null);
    assert.strictEqual(parseOrderDocPath('/uploads/orders/12'), null);
    assert.strictEqual(parseOrderDocPath('/uploads/orders//a.pdf'), null);
    assert.strictEqual(parseOrderDocPath('/uploads/orders/abc/a.pdf'), null);
    assert.strictEqual(parseOrderDocPath(''), null);
    assert.strictEqual(parseOrderDocPath(null), null);
});

check('обход каталога не проходит', () => {
    assert.strictEqual(parseOrderDocPath('/uploads/orders/12/../../.env'), null);
    assert.strictEqual(parseOrderDocPath('/uploads/orders/12/%2e%2e%2f.env'), null);
    assert.strictEqual(parseOrderDocPath('/uploads/orders/12/sub/a.pdf'), null);
    assert.strictEqual(isOrderDocPath('/uploads/orders/12/a.pdf'), true);
});

console.log('order documents: подпись');

check('свой токен проходит проверку', () => {
    const token = signDocToken(331445018, 'Ваучер.pdf');
    assert.strictEqual(verifyDocToken(token, 331445018, 'Ваучер.pdf'), true);
});

check('чужой заказ не проходит', () => {
    const token = signDocToken(331445018, 'Ваучер.pdf');
    assert.strictEqual(verifyDocToken(token, 332169267, 'Ваучер.pdf'), false);
});

check('другой файл того же заказа не проходит', () => {
    const token = signDocToken(331445018, 'Ваучер.pdf');
    assert.strictEqual(verifyDocToken(token, 331445018, 'Авиабилет.pdf'), false);
});

check('истёкший токен не проходит', () => {
    const past = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const token = signDocToken(331445018, 'Ваучер.pdf', past);
    assert.strictEqual(verifyDocToken(token, 331445018, 'Ваучер.pdf'), false);
});

check('подделанная подпись и мусор не проходят', () => {
    const token = signDocToken(331445018, 'Ваучер.pdf');
    const [exp, sig] = token.split('.');
    const broken = `${exp}.${sig.slice(0, -1)}${sig.slice(-1) === 'A' ? 'B' : 'A'}`;
    assert.strictEqual(verifyDocToken(broken, 331445018, 'Ваучер.pdf'), false);
    assert.strictEqual(verifyDocToken(`${Number(exp) + 99999}.${sig}`, 331445018, 'Ваучер.pdf'), false);
    assert.strictEqual(verifyDocToken('', 331445018, 'Ваучер.pdf'), false);
    assert.strictEqual(verifyDocToken('abc', 331445018, 'Ваучер.pdf'), false);
    assert.strictEqual(verifyDocToken('1.2.3', 331445018, 'Ваучер.pdf'), false);
});

check('без JWT_SECRET ссылка не подписывается и не открывается', () => {
    const saved = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;
    assert.strictEqual(signDocToken(1, 'a.pdf'), '');
    assert.strictEqual(verifyDocToken('1.abc', 1, 'a.pdf'), false);
    process.env.JWT_SECRET = saved;
});

console.log('order documents: подстановка в ответ клиенту');

check('ссылка на документ получает токен', () => {
    const signed = signDocUrl('/uploads/orders/331445018/Ваучер.pdf');
    assert.ok(signed.startsWith('/uploads/orders/331445018/Ваучер.pdf?t='));
    const token = decodeURIComponent(signed.split('?t=')[1]);
    assert.strictEqual(verifyDocToken(token, 331445018, 'Ваучер.pdf'), true);
});

check('посторонние значения не меняются', () => {
    assert.strictEqual(signDocUrl('/uploads/banners/1.png'), '/uploads/banners/1.png');
    assert.strictEqual(signDocUrl('https://level.travel/x.pdf'), 'https://level.travel/x.pdf');
    assert.strictEqual(signDocUrl(''), '');
});

check('старый токен в ссылке заменяется на свежий, а не дописывается', () => {
    const once = signDocUrl('/uploads/orders/12/a.pdf');
    const twice = signDocUrl(once);
    assert.strictEqual(twice.split('?t=').length, 2);
});

check('обход структуры подписывает вложенные ссылки', () => {
    const pkg = {
        agreement_doc: '/uploads/orders/12/agreement_doc.pdf',
        state: 'documents_sent',
        attachments: [
            { title: 'Ваучер', url: '/uploads/orders/12/Ваучер.pdf' },
            { title: 'Внешний', url: 'https://level.travel/a.pdf' },
        ],
        nested: { deep: [{ url: '/uploads/orders/12/Виза.pdf' }] },
        count: 3,
        flag: true,
        nothing: null,
    };
    const out = signDocUrlsDeep(pkg);

    assert.ok(out.agreement_doc.includes('?t='));
    assert.ok(out.attachments[0].url.includes('?t='));
    assert.strictEqual(out.attachments[1].url, 'https://level.travel/a.pdf');
    assert.ok(out.nested.deep[0].url.includes('?t='));
    assert.strictEqual(out.state, 'documents_sent');
    assert.strictEqual(out.count, 3);
    assert.strictEqual(out.flag, true);
    assert.strictEqual(out.nothing, null);
    // исходная структура не изменена
    assert.strictEqual(pkg.agreement_doc, '/uploads/orders/12/agreement_doc.pdf');
});

console.log(`\nALL ORDER DOCS CHECKS PASSED (${passed})`);
