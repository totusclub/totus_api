// Проверка входа через Яндекс ID без БД и сети: node scripts/check-yandex-auth.js
// (входит в npm run check). Проверяет state, ticket'ы, нормализацию client/return,
// запрашиваемые права, повтор с force_confirm, разбор почты из ответа Яндекса
// и адреса возврата — то есть всё, что можно проверить без обращения к Яндексу.
const assert = require('assert');

process.env.JWT_SECRET = 's1';
process.env.JWT_REFRESH_SECRET = 's2';
process.env.YANDEX_OAUTH_CLIENT_ID = 'cid';
process.env.YANDEX_OAUTH_CLIENT_SECRET = 'csecret';
process.env.YANDEX_OAUTH_REDIRECT_URI = 'https://api.totus.club/api/auth/yandex/callback';
process.env.YANDEX_AUTH_RETURN_WEB = 'https://totus.club';
process.env.YANDEX_AUTH_RETURN_APP = 'totus://auth/yandex';

const yandex = require('../lib/yandexAuth');

assert(yandex.isConfigured(), 'configured with env');

// client
assert.strictEqual(yandex.normalizeClient('app'), 'app');
assert.strictEqual(yandex.normalizeClient('APP'), 'app');
assert.strictEqual(yandex.normalizeClient('hack'), 'web', 'unknown client -> web');
assert.strictEqual(yandex.normalizeClient(undefined), 'web');

// return: только относительный путь (open redirect)
assert.strictEqual(yandex.safeReturnPath('/lk'), '/lk');
assert.strictEqual(yandex.safeReturnPath('/orders/123?x=1'), '/orders/123?x=1');
assert.strictEqual(yandex.safeReturnPath('https://evil.tld/x'), '/');
assert.strictEqual(yandex.safeReturnPath('//evil.tld'), '/');
assert.strictEqual(yandex.safeReturnPath('\\\\evil.tld'), '/');
assert.strictEqual(yandex.safeReturnPath(''), '/');

// state
const state = yandex.signState({ client: 'app', returnPath: '/lk' });
const parsed = yandex.verifyState(state);
assert(parsed && parsed.client === 'app' && parsed.returnPath === '/lk', 'state round-trip');
assert.strictEqual(yandex.verifyState('garbage'), null, 'garbage state');
const jwt = require('jsonwebtoken');
const foreign = jwt.sign({ c: 'web', r: '/', typ: 'other' }, 's1', { expiresIn: '10m' });
assert.strictEqual(yandex.verifyState(foreign), null, 'state typ is checked');
const wrongSecret = jwt.sign({ c: 'web', r: '/', typ: 'yx_state' }, 'other', { expiresIn: '10m' });
assert.strictEqual(yandex.verifyState(wrongSecret), null, 'state signature is checked');

// authorize url
const url = yandex.authorizeUrl(state);
assert(url.startsWith('https://oauth.yandex.ru/authorize?'), 'authorize url');
assert(url.includes('response_type=code') && url.includes('client_id=cid'), 'authorize params');
assert(url.includes(encodeURIComponent('login:email')), 'email scope requested');
assert(url.includes(encodeURIComponent('login:info')), 'info scope requested');
assert(!url.includes('csecret'), 'client_secret must never be in the authorize url');
assert(url.includes('force_confirm=no'), 'default: без повторного экрана прав');

// повтор после «почта не выдана»: экран прав показывается снова
const forced = yandex.authorizeUrl(state, { forceConfirm: true });
assert(forced.includes('force_confirm=yes'), 'force_confirm=yes при повторе');
assert(forced.includes(encodeURIComponent('login:email')), 'email scope requested on retry');

// почта из ответа login.yandex.ru/info
assert.strictEqual(yandex.pickEmail({ default_email: 'User@Yandex.RU' }), 'user@yandex.ru', 'default_email');
assert.strictEqual(yandex.pickEmail({ emails: ['  Second@ya.ru '] }), 'second@ya.ru', 'emails[0]');
assert.strictEqual(yandex.pickEmail({ default_email: '', emails: ['', 'third@ya.ru'] }), 'third@ya.ru', 'первый непустой');
assert.strictEqual(yandex.pickEmail({ emails: [] }), '', 'право login:email не выдано');
assert.strictEqual(yandex.pickEmail({}), '', 'пустой профиль');

// ticket: одноразовый
const ticket = yandex.createTicket({ userId: 7, isNew: true });
const value = yandex.consumeTicket(ticket);
assert(value && value.userId === 7 && value.isNew === true, 'ticket payload');
assert.strictEqual(yandex.consumeTicket(ticket), null, 'ticket is one-time');
assert.strictEqual(yandex.consumeTicket('nope'), null, 'unknown ticket');

// возврат
assert.strictEqual(
  yandex.returnUrl('web', { ticket: 'abc', return: '/lk' }),
  'https://totus.club/auth/yandex?ticket=abc&return=%2Flk',
);
assert.strictEqual(
  yandex.returnUrl('app', { ticket: 'abc', return: '/' }),
  'totus://auth/yandex?ticket=abc&return=%2F',
);
assert(yandex.returnUrl('desktop', { error: 'yandex_email_required' }).startsWith('totus://auth/yandex?'), 'desktop deep link');

// аватар
assert.strictEqual(yandex.avatarUrl(null), null);
assert(yandex.avatarUrl('abc').includes('avatars.yandex.net'), 'avatar url');

// выключенный раздел
delete process.env.YANDEX_OAUTH_CLIENT_SECRET;
assert(!yandex.isConfigured(), 'without secret the module is off');

console.log('ALL YANDEX AUTH CHECKS PASSED');
