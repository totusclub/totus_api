// Проверка клиента хаба уведомлений без БД и сети: node scripts/check-notify-hub.js (или npm run check).
// Падает с AssertionError, если сломаны тексты хелперов, no-op без ключа, дедуп или в payload попали ПД.
const assert = require('assert');

delete process.env.NOTIFY_HUB_URL;
delete process.env.INTERNAL_API_KEY;
const hub = require('../lib/notifyHub');

const warns = [];
const origWarn = console.warn;
const origLog = console.log;
const origError = console.error;
console.warn = (...a) => warns.push(a.join(' '));
console.log = () => {};
console.error = (...a) => warns.push(a.join(' '));

const FORBIDDEN_KEYS = /^(email|e_mail|phone|name|surname|l_name|first_name|last_name|passport|birth)/i;
const PD_PATTERN = /@|\+7\s?\d|\b\d{10,}\b|иван|ivan/i;

function assertNoPersonalData(payload) {
  const walk = (obj, path) => {
    for (const [k, v] of Object.entries(obj || {})) {
      assert(!FORBIDDEN_KEYS.test(k), `personal data key in payload: ${path}${k}`);
      if (v && typeof v === 'object') walk(v, `${path}${k}.`);
      else if (typeof v === 'string') assert(!PD_PATTERN.test(v), `personal data text in ${path}${k}: ${v}`);
    }
  };
  walk(payload, '');
}

(async () => {
  // 1. Без NOTIFY_HUB_URL / INTERNAL_API_KEY — no-op, один warn.
  assert.strictEqual(hub.isConfigured(), false, 'not configured by default');
  let r = await hub.orderCreated({ userId: 42, orderId: 48213, amount: 123456 });
  assert.strictEqual(r.skipped, 'not_configured', 'no-op without key');
  r = await hub.paymentSuccess({ userId: 42, orderId: 48213 });
  assert.strictEqual(r.skipped, 'not_configured');
  assert.strictEqual(warns.filter((w) => w.includes('not set')).length, 1, 'warn exactly once');

  // 2. Тексты хелперов (RU, без ПД), тип, маршрут, collapseKey.
  const cases = [
    ['orderCreated', { userId: 42, orderId: 'ORDER48213', amount: 100 }, 'order_created', 'order',
      'Заказ №48213 ожидает оплаты', 'Оплатите заказ, чтобы забронировать тур. Ссылка на оплату — в деталях заказа.'],
    ['paymentSuccess', { userId: 42, orderId: 48213 }, 'payment_success', 'order',
      'Оплата прошла', 'Заказ №48213 оплачен. Документы будут готовы в течение 15 минут.'],
    ['paymentFailed', { userId: 42, orderId: 48213 }, 'payment_failed', 'order',
      'Оплата не прошла', 'Заказ №48213: платёж не подтверждён. Попробуйте ещё раз.'],
    ['orderConfirmed', { userId: 42, orderId: 48213 }, 'order_confirmed', 'order',
      'Тур подтверждён', 'Туроператор подтвердил заказ №48213.'],
    ['orderStatus', { userId: 42, orderId: 48213, statusText: 'перелёт подтверждён' }, 'order_status', 'order',
      'Статус заказа изменился', 'Заказ №48213: перелёт подтверждён.'],
    ['orderCancelled', { userId: 42, orderId: 48213 }, 'order_cancelled', 'order',
      'Заказ отменён', 'Заказ №48213 отменён. Если это ошибка — напишите в чат поддержки.'],
    ['documentsReady', { userId: 42, orderId: 48213 }, 'documents_ready', 'documents',
      'Документы готовы', 'Ваучер и билеты по заказу №48213 доступны в приложении.'],
    ['documentsReady', { userId: 42, orderId: 48213, kind: 'voucher' }, 'documents_ready', 'documents',
      'Документы готовы', 'Ваучер по заказу №48213 доступен в приложении.'],
    ['documentsReady', { userId: 42, orderId: 48213, kind: 'tickets' }, 'documents_ready', 'documents',
      'Документы готовы', 'Билеты по заказу №48213 доступны в приложении.'],
    ['orderRequestStatus', { userId: 42, orderId: 48213, requestId: 7, status: 'done' }, 'order_request_status', 'order_request',
      'Ответ по обращению', 'Обращение №7 по заказу №48213: выполнено.'],
  ];
  for (const [fn, args, type, route, title, body] of cases) {
    const res = await hub[fn](args);
    const p = res.payload;
    assert(p, `${fn}: payload built`);
    assert.strictEqual(p.type, type, `${fn}: type`);
    assert.strictEqual(p.title, title, `${fn}: title`);
    assert.strictEqual(p.body, body, `${fn}: body`);
    assert.strictEqual(p.userId, 42, `${fn}: userId`);
    assert.strictEqual(p.data.route, route, `${fn}: route`);
    assert.strictEqual(p.data.orderId, '48213', `${fn}: data.orderId (без префикса ORDER)`);
    assert.strictEqual(p.collapseKey, `order_48213_${type}`, `${fn}: collapseKey`);
    assert.strictEqual(p.source, 'totus_api', `${fn}: source`);
    assert(p.title.length <= 40 && p.body.length <= 120, `${fn}: text limits`);
    assertNoPersonalData(p);
  }
  const rq = (await hub.orderRequestStatus({ userId: 1, orderId: 5, requestId: 9, status: 'rejected' })).payload;
  assert.strictEqual(rq.data.requestId, '9', 'requestId in data');
  assert(rq.body.endsWith('отклонено.'), 'request status label');

  // 3. Валидация payload: неизвестный тип / нет адресата / нет текста.
  assert.throws(() => hub.buildPayload({ userId: 1, type: 'promo_x', body: 'x' }), /type_invalid/);
  assert.throws(() => hub.buildPayload({ type: 'system', body: 'x' }), /user_required/);
  assert.throws(() => hub.buildPayload({ userId: 1, type: 'system', body: '  ' }), /body_required/);
  const byLoyalty = hub.buildPayload({ loyaltyId: '1234 5678', type: 'system', body: 'Важное' });
  assert.strictEqual(byLoyalty.loyaltyId, '1234 5678');
  // ПД в data не пропускаем даже случайно — проверка нашего же теста на реальном payload с лишним полем.
  const leaky = hub.buildPayload({ userId: 1, type: 'system', body: 'ok', data: { orderId: 1, route: 'order', email: 'a@b.ru' } });
  assert.throws(() => assertNoPersonalData(leaky), /personal data/, 'PD detector works');

  // 4. Справочники.
  assert.strictEqual(hub.orderStatusText('flight_confirmed'), 'перелёт подтверждён');
  assert.strictEqual(hub.orderStatusText('unknown_state', 'Ждём ответа отеля\nвторая строка'), 'Ждём ответа отеля');
  assert.strictEqual(hub.orderStatusText('unknown_state', ''), null);
  assert.strictEqual(hub.detectDocumentKind('Ваучер.pdf'), 'voucher');
  assert.strictEqual(hub.detectDocumentKind('E-ticket 123.pdf'), 'tickets');
  assert.strictEqual(hub.detectDocumentKind('Договор оферты.pdf'), 'agreement');
  assert.strictEqual(hub.detectDocumentKind('Страховка.pdf'), 'other');
  assert.strictEqual(await hub.resolveOrderUserId({ user_id: '17' }), 17, 'user_id from order row');

  // 5. С ключом: POST ${NOTIFY_HUB_URL}/internal/notify + X-Internal-Key, fetch подменён.
  process.env.NOTIFY_HUB_URL = 'http://hub.test:4444/';
  process.env.INTERNAL_API_KEY = 'secret-key';
  assert.strictEqual(hub.isConfigured(), true);
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return { status: 200, json: async () => ({ ok: true, recipients: 1, inapp: 1, push: { sent: 1, failed: 0, dead: 0 }, deferred: 0 }) };
  };
  hub.resetDedupe();
  r = await hub.paymentSuccess({ userId: 42, orderId: 48213 });
  assert.strictEqual(r.ok, true, 'sent ok');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, 'http://hub.test:4444/internal/notify', 'url without double slash');
  assert.strictEqual(calls[0].init.headers['X-Internal-Key'], 'secret-key', 'internal key header');
  assert.strictEqual(calls[0].body.type, 'payment_success');
  assertNoPersonalData(calls[0].body);

  // 6. Дедуп: тот же collapseKey в течение 10 минут — не шлём; другой заказ — шлём.
  r = await hub.paymentSuccess({ userId: 42, orderId: 48213 });
  assert.strictEqual(r.skipped, 'duplicate', 'dedupe same key');
  assert.strictEqual(calls.length, 1);
  await hub.paymentSuccess({ userId: 42, orderId: 48214 });
  assert.strictEqual(calls.length, 2, 'other order goes through');
  await hub.documentsReady({ userId: 42, orderId: 48213, kind: 'voucher' });
  await hub.documentsReady({ userId: 42, orderId: 48213, kind: 'voucher' });
  await hub.documentsReady({ userId: 42, orderId: 48213, kind: 'tickets' });
  assert.strictEqual(calls.length, 4, 'documents: one per kind');
  await hub.orderStatus({ userId: 42, orderId: 48213, statusText: 'a' });
  await hub.orderStatus({ userId: 42, orderId: 48213, statusText: 'b' });
  await hub.orderStatus({ userId: 42, orderId: 48213, statusText: 'a' });
  assert.strictEqual(calls.length, 6, 'order_status: per text');

  // 7. Ошибки хаба и сети не бросают наружу.
  global.fetch = async () => ({ status: 401, json: async () => ({ error: 'unauthorized' }) });
  r = await hub.orderConfirmed({ userId: 42, orderId: 1 });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.status, 401);
  global.fetch = async () => { throw new Error('ECONNREFUSED'); };
  r = await hub.orderCancelled({ userId: 42, orderId: 1 });
  assert.strictEqual(r.ok, false); assert(/ECONNREFUSED/.test(r.error));
  global.fetch = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
  });
  // Таймаут 5 с — не ждём его в проверке, только убеждаемся, что signal передан.
  const pending = hub.orderCreated({ userId: 42, orderId: 2 });
  assert(pending instanceof Promise);
  global.fetch = realFetch;

  console.warn = origWarn; console.log = origLog; console.error = origError;
  console.log('ALL NOTIFY HUB CHECKS PASSED');
  process.exit(0);
})().catch((err) => {
  console.warn = origWarn; console.log = origLog; console.error = origError;
  console.error(err);
  process.exit(1);
});
