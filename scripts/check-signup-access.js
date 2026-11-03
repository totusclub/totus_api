// Регистрация: новый пользователь сразу получает Calling и AI (users.access = 0 — «Доступ»).
// Запуск: node scripts/check-signup-access.js (без базы, почты и капчи — всё подменено).
// Решение владельца 03.11.2026: только API, приложение и сайт не меняются — они читают
// флаг из calling_api_v2 GET /api/users/by-id, где NULL и 1 = «Заблок.», 0 = «Доступ».
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const root = path.resolve(__dirname, '..');
const controllerPath = path.join(root, 'controllers', 'auth.controller.js');

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}\n       ${e && e.message ? e.message : e}`);
  }
}

// ---------- подмены: база, почта, капча, токены ----------
const queries = [];
let usersByEmail = {};
const fakeDb = {
  async query(sql, params = []) {
    queries.push({ sql, params });
    if (/INFORMATION_SCHEMA/.test(sql)) {
      return [[{ COLUMN_NAME: 'l_name', IS_NULLABLE: 'YES' }, { COLUMN_NAME: 'phone', IS_NULLABLE: 'YES' }]];
    }
    if (/^SELECT \* FROM users WHERE email = \?$/.test(sql.trim())) {
      const u = usersByEmail[params[0]];
      return [u ? [u] : []];
    }
    if (/^INSERT INTO users/.test(sql)) {
      const cols = sql.match(/\(([^)]*)\)/)[1].split(',').map((c) => c.trim());
      const row = { id: 100 + queries.length };
      cols.forEach((c, i) => { row[c] = params[i]; });
      usersByEmail[row.email] = row;
      return [{ insertId: row.id }];
    }
    return [{}];
  },
};
const stubs = {
  '../db': fakeDb,
  bcryptjs: { compare: async () => false, hash: async (s) => s },
  jsonwebtoken: {},
  axios: { post: async () => ({ data: {} }) },
  '../utils/loyaltyGenerator': { generateUniqueLoyaltyId: () => '1234 5678 9012 3456' },
  '../utils/yandexCloudEmail': { sendEmail: async () => {} },
  '../utils/emailTemplates': { verificationCodeTemplate: () => ({ subject: 's', text: 't', html: 'h' }) },
  '../utils/yandexSmartCaptcha': { verifyYandexSmartCaptcha: async () => ({ ok: true }) },
  '../lib/auth': {
    signUserToken: (u) => `access-${u.id}`,
    signRefreshToken: (id) => `refresh-${id}`,
    publicUser: (u) => u,
    roleOf: () => 'user',
  },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent && parent.filename === controllerPath && Object.prototype.hasOwnProperty.call(stubs, request)) {
    return stubs[request];
  }
  return origLoad.call(this, request, parent, isMain);
};
const controller = require(controllerPath);
Module._load = origLoad;

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function lastInsert() {
  const q = [...queries].reverse().find((x) => /^INSERT INTO users/.test(x.sql));
  assert.ok(q, 'INSERT INTO users не выполнен');
  const cols = q.sql.match(/\(([^)]*)\)/)[1].split(',').map((c) => c.trim());
  return { cols, params: q.params };
}

(async () => {
  console.log('Регистрация: Calling и AI сразу');

  await check('регистрация пишет access = 0 («Доступ»), ответ как раньше: 201, screen VERIFICATION', async () => {
    queries.length = 0;
    usersByEmail = {};
    const res = fakeRes();
    await controller.signup({ body: { email: 'New.User@Example.com ', name: 'Анна' }, headers: {} }, res);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.screen, 'VERIFICATION');
    const { cols, params } = lastInsert();
    assert.equal(params[cols.indexOf('access')], 0);
    assert.equal(params[cols.indexOf('email')], 'new.user@example.com');
    assert.equal(cols.length, params.length, 'число колонок = числу значений');
  });

  await check('почта уже есть — 400, ничего не вставляется (как раньше)', async () => {
    queries.length = 0;
    usersByEmail = { 'old@example.com': { id: 1, email: 'old@example.com', access: 1 } };
    const res = fakeRes();
    await controller.signup({ body: { email: 'old@example.com', name: 'Олег' }, headers: {} }, res);
    assert.equal(res.statusCode, 400);
    assert.ok(!queries.some((q) => /^INSERT INTO users|^UPDATE users SET access/.test(q.sql)), 'существующему пользователю access не меняется');
  });

  await check('вход существующего пользователя access не трогает (заблокированный остаётся заблокированным)', async () => {
    queries.length = 0;
    usersByEmail = { 'blocked@example.com': { id: 2, email: 'blocked@example.com', name: 'Б', access: 1 } };
    const res = fakeRes();
    await controller.signin({ body: { email: 'blocked@example.com' }, headers: {} }, res);
    assert.equal(res.statusCode, 201);
    assert.ok(!queries.some((q) => /access/.test(q.sql)), 'в запросах входа нет access');
  });

  await check('демо-аккаунт Apple (вход и код) создаётся с access = 0', async () => {
    queries.length = 0;
    usersByEmail = {};
    await controller.signin({ body: { email: 'test@totus.com' }, headers: {} }, fakeRes());
    let ins = lastInsert();
    assert.equal(ins.params[ins.cols.indexOf('access')], 0);
    queries.length = 0;
    usersByEmail = {};
    await controller.verifyCode({ body: { email: 'test@totus.com', code: '1111' }, headers: {} }, fakeRes());
    ins = lastInsert();
    assert.equal(ins.params[ins.cols.indexOf('access')], 0);
  });

  await check('каждый INSERT INTO users в контроллере пишет access', () => {
    const src = fs.readFileSync(controllerPath, 'utf8');
    const inserts = src.match(/INSERT INTO users \([^)]*\)/g) || [];
    assert.equal(inserts.length, 3);
    for (const i of inserts) assert.match(i, /, access\)$/);
    assert.match(src, /const NEW_USER_ACCESS = 0;/);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
