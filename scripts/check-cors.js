'use strict';

/**
 * Проверка политики CORS — без БД, сети и запуска сервера.
 * Запуск: node scripts/check-cors.js
 */

const assert = require('assert');
const policy = require('../lib/corsPolicy');

let passed = 0;
function check(name, fn) {
    const savedMode = process.env.CORS_MODE;
    const savedOrigins = process.env.CORS_ORIGINS;
    const savedMaxAge = process.env.CORS_MAX_AGE;
    try {
        fn();
    } finally {
        restore('CORS_MODE', savedMode);
        restore('CORS_ORIGINS', savedOrigins);
        restore('CORS_MAX_AGE', savedMaxAge);
    }
    passed += 1;
    console.log(`  ok  ${name}`);
}

function restore(key, value) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
}

// Заглушки вместо express: считаем, чем закончился запрос.
function fakeReq(origin, method = 'GET') {
    return { method, headers: origin === undefined ? {} : { origin } };
}

function fakeRes() {
    const res = { statusCode: null, body: null };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = body; return res; };
    return res;
}

function run(origin, method) {
    const calls = { handler: 0, next: 0 };
    const gate = policy.createGate((req, res, next) => { calls.handler += 1; next(); });
    const res = fakeRes();
    gate(fakeReq(origin, method), res, () => { calls.next += 1; });
    return { res, calls };
}

console.log('CORS: список origin\'ов');

check('свои домены разрешены', () => {
    for (const origin of ['https://totus.club', 'https://www.totus.club', 'https://admin.totus.club', 'https://calling.totus.club']) {
        assert.strictEqual(policy.isOriginAllowed(origin), true, origin);
    }
});

check('десктоп из file:// (Origin: null) разрешён', () => {
    assert.strictEqual(policy.isOriginAllowed('null'), true);
    assert.ok(policy.DEFAULT_ORIGINS.includes('null'));
});

check('dev-порт десктопа 5173 разрешён', () => {
    assert.strictEqual(policy.isOriginAllowed('http://localhost:5173'), true);
});

check('запрос без Origin разрешён всегда (приложение, curl, webhook)', () => {
    assert.strictEqual(policy.isOriginAllowed(undefined), true);
    assert.strictEqual(policy.isOriginAllowed(''), true);
});

check('чужие и похожие домены не разрешены', () => {
    for (const origin of [
        'https://evil.example',
        'https://totus.club.evil.example',
        'https://totus.club/',
        'http://totus.club',
        'https://sub.totus.club',
    ]) {
        assert.strictEqual(policy.isOriginAllowed(origin), false, origin);
    }
});

check('CORS_ORIGINS перекрывает список по умолчанию', () => {
    process.env.CORS_ORIGINS = 'https://a.example, https://b.example';
    assert.deepStrictEqual(policy.allowedOrigins(), ['https://a.example', 'https://b.example']);
    assert.strictEqual(policy.isOriginAllowed('https://a.example'), true);
    assert.strictEqual(policy.isOriginAllowed('https://totus.club'), false);
});

check('звёздочка в списке открывает всё (осознанная опция)', () => {
    process.env.CORS_ORIGINS = '*';
    assert.strictEqual(policy.isOriginAllowed('https://evil.example'), true);
});

console.log('CORS: режим не зависит от AUTH_MODE');

check('по умолчанию режим log', () => {
    delete process.env.CORS_MODE;
    assert.strictEqual(policy.corsMode(), 'log');
});

check('AUTH_MODE на режим CORS больше не влияет', () => {
    const savedAuth = process.env.AUTH_MODE;
    process.env.AUTH_MODE = 'enforce';
    delete process.env.CORS_MODE;
    assert.strictEqual(policy.corsMode(), 'log');
    process.env.CORS_MODE = 'enforce';
    assert.strictEqual(policy.corsMode(), 'enforce');
    restore('AUTH_MODE', savedAuth);
});

check('решение по origin в обоих режимах', () => {
    process.env.CORS_MODE = 'log';
    assert.strictEqual(policy.decide('https://totus.club'), 'pass');
    assert.strictEqual(policy.decide('https://evil.example'), 'log');
    assert.strictEqual(policy.decide(undefined), 'pass');

    process.env.CORS_MODE = 'enforce';
    assert.strictEqual(policy.decide('https://totus.club'), 'pass');
    assert.strictEqual(policy.decide('null'), 'pass');
    assert.strictEqual(policy.decide('https://evil.example'), 'block');
    assert.strictEqual(policy.decide(undefined), 'pass');
});

console.log('CORS: поведение гейта');

check('свой origin проходит дальше', () => {
    process.env.CORS_MODE = 'enforce';
    const { res, calls } = run('https://totus.club');
    assert.strictEqual(calls.handler, 1);
    assert.strictEqual(calls.next, 1);
    assert.strictEqual(res.statusCode, null);
});

check('чужой origin в enforce получает 403 и НЕ доходит до обработчика', () => {
    process.env.CORS_MODE = 'enforce';
    const { res, calls } = run('https://evil.example');
    assert.strictEqual(res.statusCode, 403);
    assert.deepStrictEqual(res.body, { error: 'cors_forbidden' });
    assert.strictEqual(calls.handler, 0, 'обработчик не должен вызываться');
    assert.strictEqual(calls.next, 0, 'запрос не должен идти дальше по стеку');
});

check('preflight от чужого origin в enforce тоже 403', () => {
    process.env.CORS_MODE = 'enforce';
    const { res, calls } = run('https://evil.example', 'OPTIONS');
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(calls.handler, 0);
});

check('в режиме log чужой origin проходит (прежнее поведение)', () => {
    process.env.CORS_MODE = 'log';
    const { res, calls } = run('https://evil.example');
    assert.strictEqual(res.statusCode, null);
    assert.strictEqual(calls.handler, 1);
});

check('POST от чужого origin в enforce не выполняется', () => {
    process.env.CORS_MODE = 'enforce';
    const { res, calls } = run('https://evil.example', 'POST');
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(calls.handler, 0);
});

console.log('CORS: preflight и заголовки');

check('maxAge по умолчанию 600 и настраивается', () => {
    delete process.env.CORS_MAX_AGE;
    assert.strictEqual(policy.corsMaxAge(), 600);
    process.env.CORS_MAX_AGE = '3600';
    assert.strictEqual(policy.corsMaxAge(), 3600);
});

check('мусор и выход за границы в CORS_MAX_AGE игнорируются', () => {
    for (const value of ['abc', '-5', '999999', '']) {
        process.env.CORS_MAX_AGE = value;
        assert.strictEqual(policy.corsMaxAge(), 600, value);
    }
});

check('клиенту открыты имя файла и заголовки rate-limit', () => {
    assert.ok(policy.EXPOSED_HEADERS.includes('Content-Disposition'));
    assert.ok(policy.EXPOSED_HEADERS.includes('RateLimit'));
    assert.ok(policy.EXPOSED_HEADERS.includes('Retry-After'));
});

console.log('CORS: лог неизвестных origin\'ов');

check('лог троттлится и не растёт без предела', () => {
    const saved = console.warn;
    let lines = 0;
    console.warn = () => { lines += 1; };
    try {
        policy._logState.clear();
        const now = Date.now();
        assert.strictEqual(policy.logUnknownOrigin('https://evil.example', 'log', now), true);
        assert.strictEqual(policy.logUnknownOrigin('https://evil.example', 'log', now + 1000), false);
        assert.strictEqual(policy.logUnknownOrigin('https://evil.example', 'log', now + 61000), true);
        assert.strictEqual(lines, 2);

        // перебор чужих origin'ов не раздувает память
        for (let i = 0; i < policy.MAX_LOG_KEYS + 50; i += 1) {
            policy.logUnknownOrigin(`https://spam-${i}.example`, 'log', now);
        }
        assert.ok(policy._logState.size <= policy.MAX_LOG_KEYS, `размер ${policy._logState.size}`);
    } finally {
        console.warn = saved;
        policy._logState.clear();
    }
});

console.log(`\nALL CORS CHECKS PASSED (${passed})`);
