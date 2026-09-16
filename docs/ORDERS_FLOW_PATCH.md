# Патч `app.js` — auth_token / forbidden / CORS для заказов (v3, 15.09.2026; п. 7 — лог prebook, 16.09.2026)

`app.js` (60 КБ) через GitHub-коннектор не проходит — владелец применяет диффы ниже **вручную** (IDE/сервер). Все правки точечные; проверка после применения: `node --check app.js && npm run check` (`scripts/check-custom-rooms*.js`), затем `pm2 restart api`.

Номера строк — по `app.js` **без** двух строк подключения Room Type (`docs/CUSTOM_ROOMS_APP_JS_PATCH.md`). Если они уже добавлены (на `main` — добавлены), то строки после `app.use(express.json())` сдвинуты на **+1**, после блока `/api/admin` — на **+2**. Ориентируйтесь на контекст «было», а не на номер.

Что уже сделано в коде репозитория (ветка `claude/custom-rooms-fix`) и **не требует правок app.js**:

- `utils/levelTravelClientOrder.js` → `resolveAuthToken(orderRow, override, opts)`: для внутренних заказов (`order_id >= 900000000`, бронирования Arlekino) env-fallback `LT_CLIENT_AUTH_TOKEN` **не применяется** (возвращает `null`); новый параметр `opts.allowEnv === false` отключает env-fallback для любого заказа (используется в п. 1). Экспорт `isInternalOrderId`.
- `middleware/customRooms.js` перехватывает `GET /orders?order_id=<внутренний>` и отвечает из БД (`lib/customRooms/internalOrders.js` → `orderSnapshot`): `{ order_id, package, pay_status, transaction_code, order_state, user_id, lt_auth_token: null, last_lt_event: null, internal: true, payment, totus_room, totus_booking }`; в Level.Travel не ходит; допускает `user` **и** `staff`. До обработчика app.js такие запросы не доходят.

---

## 1. `GET /orders` — LT-ветка: `lt_auth_token` заказа (без env) + `user_id` в ответе

Зачем: админка (`lt-orders`) ищет по номеру заказа и берёт токен **только этого заказа** из `GET /orders?order_id` — без чужих токенов и без N×`/user/orders`. Сейчас в LT-ветке ответа нет ни `lt_auth_token`, ни `user_id`; а `resolveAuthToken` при отсутствии токена у заказа подставляет общий `LT_CLIENT_AUTH_TOKEN` — его наружу отдавать нельзя.

**Строка ≈ 1044** (`app.get('/orders', …)`, блок `// 1) LT client/orders with auth_token`):

```js
// было
            const authToken = resolveAuthToken(orderRow, req.query.auth_token);
// стало (для запроса к LT env-fallback остаётся — как раньше)
            const authToken = resolveAuthToken(orderRow, req.query.auth_token);
            // токен, который можно отдать клиенту: только токен самого заказа (query / orders.lt_auth_token / package), без env
            const orderAuthToken = resolveAuthToken(orderRow, req.query.auth_token, { allowEnv: false });
```

**Строки ≈ 1079–1086** (`const clientOrder = { … }` в той же ветке):

```js
// было
            const clientOrder = {
                order_id: orderId,
                package: packagePayload,
                pay_status: orderRow?.pay_status || null,
                transaction_code: orderRow?.transaction_code || null,
                order_state: orderRow?.order_state || null,
                last_lt_event: lastLtEvent,
            };
// стало
            const clientOrder = {
                order_id: orderId,
                package: packagePayload,
                pay_status: orderRow?.pay_status || null,
                transaction_code: orderRow?.transaction_code || null,
                order_state: orderRow?.order_state || null,
                user_id: orderRow?.user_id ?? null,
                lt_auth_token: orderAuthToken || null,
                last_lt_event: lastLtEvent,
            };
```

DB-ветка (строки ≈ 1099–1103, `prepareOrderRowForClient(orderRow)`) уже отдаёт все колонки строки, включая `user_id` и `lt_auth_token` — не трогаем.

## 2. `requireAuth(['user'])` → `requireAuth(['user', 'staff'])` на маршрутах заказов

Зачем: `satisfies(role, ['user'])` в `lib/auth.js` пропускает `user`/`agent`, но **не** `staff` → админка со staff-JWT получает `403 forbidden` на `/orders`. `/create-package` **не трогаем** (заказ создаёт только пользователь).

| Строка ≈ | было | стало |
|---|---|---|
| 852 | `app.get('/client/orders', requireAuth(['user']), async (req, res) => {` | `app.get('/client/orders', requireAuth(['user', 'staff']), async (req, res) => {` |
| 902 | `app.get('/client/orders/:order_id', requireAuth(['user']), async (req, res) => {` | `app.get('/client/orders/:order_id', requireAuth(['user', 'staff']), async (req, res) => {` |
| 978 | `app.post('/client/orders/:order_id/sync', requireAuth(['user']), async (req, res) => {` | `app.post('/client/orders/:order_id/sync', requireAuth(['user', 'staff']), async (req, res) => {` |
| 1015 | `app.get('/orders', requireAuth(['user']), async (req, res) => {` | `app.get('/orders', requireAuth(['user', 'staff']), async (req, res) => {` |
| 1110 | `app.get('/orders/:order_id/payment', requireAuth(['user']), async (req, res) => {` | `app.get('/orders/:order_id/payment', requireAuth(['user', 'staff']), async (req, res) => {` |
| 1178 | `app.get('/orders/documents', requireAuth(['user']), async (req, res) => {` | `app.get('/orders/documents', requireAuth(['user', 'staff']), async (req, res) => {` |
| 1197 | `app.get('/user/orders', requireAuth(['user']), async (req, res) => {` | `app.get('/user/orders', requireAuth(['user', 'staff']), async (req, res) => {` |
| 594 | `app.post('/create-package', requireAuth(['user']), …` | **без изменений** |

Проверка владельца: `assertOrderOwner`/`resolveOwnerId` для `staff` уже возвращают «можно» (`lib/auth.js`), дополнительных правок не нужно.

## 3. `POST /client/orders/:order_id/sync` — токен из строки заказа

Зачем: сейчас берётся только `body/query.auth_token` или общий env-токен; токен самого заказа (`orders.lt_auth_token`) игнорируется.

**Строки ≈ 980–982**:

```js
// было
        const orderId = Number(req.params.order_id);
        const auth_token =
            req.body?.auth_token || req.query?.auth_token || process.env.LT_CLIENT_AUTH_TOKEN;
// стало
        const orderId = Number(req.params.order_id);
        const { resolveAuthToken } = require('./utils/levelTravelClientOrder');
        const [syncRows] = await db.query('SELECT * FROM orders WHERE order_id = ? LIMIT 1', [orderId]);
        const auth_token = resolveAuthToken(syncRows[0] || null, req.body?.auth_token || req.query?.auth_token);
```

(`resolveAuthToken`: явный токен → `orders.lt_auth_token` → `package._lt_auth_token|auth_token|client.auth_token` → env `LT_CLIENT_AUTH_TOKEN`; для внутренних id env не применяется. Внутренние заказы сюда не доходят — их перехватывает middleware.)

## 4. `GET /client/orders` — без `auth_token` в query, но с `order_id` → токен из БД

Зачем: список заказов клиента LT по одному известному заказу (админка) — без передачи токена в URL.

**Строки ≈ 854–864**:

```js
// было
        const src = { ...req.query, ...req.body };
        const auth_token = String(src.auth_token || '').trim();

        if (!auth_token) {
// стало
        const src = { ...req.query, ...req.body };
        let auth_token = String(src.auth_token || '').trim();

        // нет auth_token, но есть order_id — токен этого заказа из строки БД (без env-fallback: чужой токен не подставляем)
        if (!auth_token && src.order_id) {
            const { resolveAuthToken } = require('./utils/levelTravelClientOrder');
            const listOrderId = String(src.order_id).replace(/^ORDER/i, '').trim();
            const [listRows] = await db.query('SELECT * FROM orders WHERE order_id = ? LIMIT 1', [listOrderId]);
            if (listRows[0] && !assertOrderOwner(req, res, listRows[0].user_id)) return;
            auth_token = resolveAuthToken(listRows[0] || null, null, { allowEnv: false }) || '';
        }

        if (!auth_token) {
```

## 5. `POST /create-package` — `payload.auth_token` убрать из цепочки + лог ключей ответа LT

Зачем: токен клиента LT должен приходить **только** из ответа `orders/create`; значение из тела запроса фронта в `orders.lt_auth_token` попадать не должно. Лог ключей — чтобы один раз увидеть на проде, в каком поле LT реально отдаёт `auth_token` (`order.auth_token` / `order.client.auth_token` / корень).

**Строки ≈ 651–662**:

```js
// было
        if(response.data.success){
            let order_id = response.data.order.id;
            const { normalizeOrderPayFields, resolveLtOrderPayAmount } = require('./utils/orderPayment');
            let orderData = normalizeOrderPayFields({ ...response.data.order });
            const authToken =
                String(
                    response.data.order?.auth_token ||
                    response.data.auth_token ||
                    response.data.order?.client?.auth_token ||
                    payload.auth_token ||
                    '',
                ).trim() || null;
// стало
        if(response.data.success){
            let order_id = response.data.order.id;
            console.log('[LT create] order keys', Object.keys(response.data.order || {}), 'client keys', Object.keys(response.data.order?.client || {}));
            const { normalizeOrderPayFields, resolveLtOrderPayAmount } = require('./utils/orderPayment');
            let orderData = normalizeOrderPayFields({ ...response.data.order });
            const authToken =
                String(
                    response.data.order?.auth_token ||
                    response.data.auth_token ||
                    response.data.order?.client?.auth_token ||
                    '',
                ).trim() || null;
```

## 6. `.env` — `CORS_ORIGINS`

`lib/security.js` → `corsMiddleware()` берёт список из `CORS_ORIGINS` (CSV, без завершающего `/`); **пустая переменная = встроенный список** `https://totus.club, https://www.totus.club, https://admin.totus.club, https://calling.totus.club, https://ai.totus.club, http://localhost:3000|3008|3009|3012`. Заданная переменная **полностью заменяет** встроенный список — перечислять все origin. В `AUTH_MODE=enforce` неизвестный origin блокируется (браузер покажет CORS-ошибку на `/orders*`), в `log` — пропускается с записью в лог. При старте в лог пишется `[CORS] origins: …` (строка ≈ 1631).

Если админка (другой домен/порт), сайт или desktop получают CORS-ошибку на `/orders*`:

```dotenv
# .env (прод) — все origin сайта, админки, звонков, AI и локальных фронтов; без пробелов и завершающих /
CORS_ORIGINS=https://totus.club,https://www.totus.club,https://admin.totus.club,https://calling.totus.club,https://ai.totus.club,http://localhost:3000,http://localhost:3008,http://localhost:3009,http://localhost:3012
```

Desktop-приложение (Electron/Tauri) шлёт `Origin: null` или `file://` — при `AUTH_MODE=enforce` добавить его origin в список (или оставить `log`). После правки `.env` — `pm2 restart api` и проверить строку `[CORS] origins:` в логе.

## 7. `POST /packages/prebook` — короткий `warn` вместо дампа ошибки

Зачем: Level.Travel отвечает `400 Incorrect api version` на полном теле пребука (с `flight_pair_id` и `prebook_data`) — у партнёрского токена нет доступа к версии API, в которой живёт `prebook`. Все клиенты (`bookingPage/index.tsx`, `Booking.tsx`, `BookingScreen.tsx`) получают `skippable: true` и штатно продолжают оформление, то есть это не ошибка, а известное ограничение: в логе достаточно одной строки без дампа `{status, message, data}`.

Замеры на проде (16.09.2026, `performance.now()` в браузере, отель 9022465):

| Шаг | Время |
|---|---|
| `GET /packages/package_details` | 0.3–0.9 с |
| `GET /packages/actualize` | **0.7 с (тёплый) … 11.3 с (первый вызов)** |
| `POST /packages/flights` | ~1.0 с |
| `POST /packages/prebook` — полное тело → `Incorrect api version`, **весь цикл 3.8 → 3.7 → 3.6 → 3.5 → 3.4** | **0.22–0.38 с** (≈ 45–75 мс на версию) |
| `POST /packages/prebook` — `{package_id}` → `Package not found` / `500`, одна попытка | 0.09–0.15 с |

Вывод: перебор версий стоит ~0.3 с и узким местом не является — дольше всего ждёт `actualize` (он же вызывается дважды: при открытии страницы бронирования и повторно перед созданием заказа). Ограничения `ltRequest`: `timeout: 60000`, `retries: 0`; худший случай — если LT перестанет отвечать (не ошибка, а «тишина»): 5 × 60 с = **до 5 минут**. Ниже — только правка лога; таймаут и отказ от самого вызова решаются отдельно.

**Строки ≈ 307–314** (`app.post('/packages/prebook', …)`, блок `catch`):

```js
// было
    } catch (error) {
        logLtError('Package prebook error:', error);
        const ltError = error.response?.data;
        const msg = String(ltError?.error || ltError?.message || error.message || '');
        const skippable =
            msg.toLowerCase().includes('incorrect api version') ||
            msg.toLowerCase().includes('api version');
// стало
    } catch (error) {
        const ltError = error.response?.data;
        const msg = String(ltError?.error || ltError?.message || error.message || '');
        const skippable =
            msg.toLowerCase().includes('incorrect api version') ||
            msg.toLowerCase().includes('api version');
        // известное ограничение партнёрского токена: клиенты пропускают шаг (skippable) — одна короткая строка вместо дампа
        if (skippable) {
            console.warn(`[LT prebook] skipped: ${msg}`);
        } else {
            logLtError('Package prebook error:', error);
        }
```

Следующие строки (`const status = error.response?.status || 500;` и ответ клиенту) **не меняются** — поведение бронирования прежнее.

---

## Проверка после патча

1. `node --check app.js && npm run check`.
2. Staff-JWT: `GET /orders?order_id=<LT-заказ>` → `200` (раньше `403 forbidden`), в ответе `lt_auth_token` — токен **этого** заказа или `null` (никогда env-токен), `user_id`.
3. `GET /orders?order_id=9000000xx` (внутренний) → ответ middleware из БД: `lt_auth_token: null`, `totus_booking`, `internal: true`; в логе нет обращений `LT_CLIENT`.
4. `POST /client/orders/<id>/sync` без `auth_token` в теле → синхронизация по токену из `orders.lt_auth_token` (для заказа без токена и без env — `400 Missing auth_token`).
5. `GET /client/orders?order_id=<id>` без `auth_token` → список по токену заказа; для заказа без токена — `400 missing_auth_token`.
6. После `POST /create-package` в логе строка `[LT create] order keys […] client keys […]` — сообщить, где LT отдаёт `auth_token`.
7. Бронирование пакета с перелётом: в логе одна строка `[LT prebook] skipped: Incorrect api version` вместо блока `Package prebook error: {…}`; оформление доходит до оплаты как раньше.
