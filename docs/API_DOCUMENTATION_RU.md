# API Documentation (RU) — totus_API

Документация построена **только по коду** репозитория `totus_API` (`/Users/haykmaruqyan/Desktop/TOSMEDIA/TOTUS/kedam-API`).  
Если сведения отсутствуют в коде: `Не найдено в текущей кодовой базе.`  
Если вывод неочевиден: `Предположение:`.

Секреты, токены и пароли **не приводятся** — только имена переменных. В исходниках встречаются **захардкоженные credentials** (LT token, VTB client_id/secret, Telegram Gateway token и др.) — это отмечено как проблема безопасности без копирования значений.

---

# 1. Backend Architecture

## Стек

| Компонент | Факт из кода |
|-----------|--------------|
| Язык | JavaScript (Node.js) |
| HTTP-фреймворк | Express `^5.1.0` (`package.json`) |
| БД | MySQL через `mysql2` (`db.js`, pool) |
| ORM | Нет — сырой SQL |
| HTTP-клиент | `axios` (основной); `node-fetch` в зависимостях, в API-коде почти не используется |
| Auth | `jsonwebtoken`, `bcrypt` (staff), `bcryptjs` (agent sign-in); ядро `lib/auth.js` (с 01.09, PR #3) |
| Upload | `multer` |
| CORS | CORS-whitelist `CORS_ORIGINS` (`lib/security.js`, с 01.09); ранее `cors()` без ограничений |
| Security | `helmet` (без CSP, CORP cross-origin) + `express-rate-limit` на auth-эндпоинты (`lib/security.js`, с 01.09) |
| Env | `dotenv` (`.env`, затем `.env.local` с `override: true`) |
| Email | `nodemailer` + `@aws-sdk/client-sesv2` (Yandex Postbox) |
| Прочее | `qs` в dependencies |

## Entry points

| Файл | Роль |
|------|------|
| **`app.js`** | Реальный Express-сервер: middleware, все маршруты, `app.listen(PORT)` |
| **`index.js`** | Эксперимент SAMO.RU (`http://search.samo.ru/api/`). **Не** Express |
| **`package.json` → `"main": "index.js"`** | Несоответствие: main указывает на SAMO-скрипт, сервер — `app.js` |
| Скрипт `start` | **Отсутствует**. Запуск: `node app.js` |
| Порт | `process.env.PORT \|\| 3001` |

## Архитектурный стиль

- Отдельного слоя **services/** нет — бизнес-логика в `controllers/` и `utils/`.
- Отдельного слоя **repositories/** / **models/** нет.
- Глобального error middleware нет — `try/catch` в каждом handler.
- Фоновых очередей / cron / WebSocket **нет**.

## Поток запроса

```text
Client
  ↓
Route (inline в app.js ИЛИ routes/*)
  ↓
Опциональный middleware (cors / json / multer / Partner-Api-Key)
  ↓
Controller ИЛИ inline handler в app.js
  ↓
util («сервис») — Level Travel / VTB / Yandex / email / order*
  ↓
MySQL (db pool) и/или внешний HTTP API
  ↓
Response (JSON или static file)
```

## Внешние интеграции (кратко)

- Level.Travel `https://api.level.travel`
- VTB Open API (OAuth + SBP QR)
- Yandex SmartCaptcha
- Yandex Cloud Postbox (SESv2)
- Telegram Gateway API (телефонная верификация)
- SAMO.RU — только в `index.js`, не в Express

---

# 2. Backend Structure

```text
totus_API/
├── app.js                 # Express entry
├── index.js               # SAMO.RU experiment (не сервер)
├── db.js                  # mysql2 pool
├── package.json
├── test_db.js             # ручная проверка БД
├── call.html
├── config/
│   └── cmsPages.js        # allowlist slug CMS-страниц
├── lib/
│   ├── auth.js            # JWT-ядро: requireAuth, AUTH_MODE, resolveOwnerId (с 01.09)
│   └── security.js        # helmet, CORS-whitelist, rate-limit (с 01.09)
├── controllers/           # 13 контроллеров
├── middleware/            # multer-хелперы загрузок
├── routes/                # Express Router modules
├── scripts/               # миграции и seed
├── utils/                 # HTTP/платежи/email/LT (роль «сервисов»)
├── upload/content|home    # статика контента
└── uploads/               # banners, hero, hotels, orders, partners, popular
```

### Назначение директорий

| Директория | Назначение |
|------------|------------|
| `controllers/` | Обработчики `/api/*` (auth, CMS, email, content) |
| `routes/` | Маппинг HTTP → controller; mount prefixes в `app.js` |
| `utils/` | LT proxy helpers, VTB, emails, documents, captcha, logging |
| `middleware/` | Только multer storage для CMS-изображений |
| `lib/` | Auth-ядро (`auth.js`) и security-middleware (`security.js`) |
| `config/` | Allowlist slug для footer CMS pages |
| `scripts/` | One-off `CREATE TABLE` / seed / ALTER миграции |
| `uploads/`, `upload/` | Файлы на диске + `express.static` |

---

# 3. API Base URL

| Тип | Значение |
|-----|----------|
| Локальный listen | `http://localhost:${PORT}` (default **3001**) |
| Production public API (default в коде) | `https://api.totus.club` — default `API_PUBLIC_URL` в `utils/orderEmails.js` |
| Public base helper | `utils/publicApiBase.js`: localhost → `req.protocol://host`; иначе `API_PUBLIC_URL` \|\| `PUBLIC_API_URL` \|\| host |
| Upstream Level.Travel | `https://api.level.travel` (`BASE_URL` в `app.js` / `levelTravelHttp.js`) |
| Версионирование своего API | **Нет** `/api/v1`. Префиксы: без префикса (LT/proxy) и `/api/*` (auth/CMS) |
| Accept LT | `application/vnd.leveltravel.v3.x` (3.8…3.0) |

Checkout URL для писем: `CHECKOUT_URL` (см. `orderPayment.js`).

---

# 4. Complete API Endpoint Reference

Всего HTTP-эндпоинтов (без static): **108** (38 inline + 70 mounted).  
Static mounts: **3** (`/uploads`, `/upload/content`, `/upload/home`).

Полный нумерованный список — **Приложение A** (после §4).

Ниже — по категориям. Для LT-прокси: query/body проксируются на Level.Travel; ответ — JSON LT (или локальная обёртка ошибки).

---

## 4.1 Static

### `GET /uploads/*`, `GET /upload/content/*`, `GET /upload/home/*`

- **Назначение:** раздача файлов с диска.
- **Auth:** Public.
- **Errors:** стандартный Express static 404.

---

## 4.2 Level.Travel references (proxy)

Общее: **Auth** — Public для клиента; сервер добавляет LT `Authorization: Token token="…"`.  
**Response:** тело LT.  
**Errors:** чаще `500` `{ error: "Failed …" }`; `hotel_reviews` пробрасывает upstream status/body.

| Method | Path | LT upstream |
|--------|------|-------------|
| GET | `/references/departures` | `/references/departures` (+ in-memory cache 5 мин при 5xx) |
| GET | `/references/destinations` | `/references/destinations` |
| GET | `/references/autocomplete_v2` | `/references/autocomplete_v2` |
| GET | `/references/operators` | `/references/operators` |
| GET | `/references/airlines` | `/references/airlines` |
| GET | `/references/airports` | `/references/airports` |
| GET | `/references/hotels` | `/references/hotels` |
| GET | `/references/hotel_dump` | `/references/hotel_dump` |
| GET | `/references/hotel_reviews/:hotel_id` | `/references/hotel_reviews/:hotel_id` (+ `page`, `per_page`) |
| GET | `/references/flights_and_nights` | `/references/flights_and_nights` |

---

## 4.3 Search & packages (proxy + local validation)

### `GET /start-search`

- **Назначение:** старт поиска → LT `GET /search/enqueue`.
- **Auth:** Public (+ LT token server-side).
- **Request:** query → LT.
- **Errors:** `500` `{ error: 'Failed to start search' }`.

### `GET /search-status`

- **Request:** query `request_id` **обязателен**.
- **Errors:** `400` Missing request_id; `500` Failed to check status.
- **Upstream:** LT `/search/status`.

### `GET /grouped-hotels`

- **Request:** `request_id` обязателен; `operator_ids` или `readyOperators` → CSV; `filter_*`, `page_limit`, `page_number`, `sort_by`.
- **Upstream:** `/search/get_grouped_hotels`.
- **Errors:** через `sendLtAxiosError`.

### `GET /hotels-rooms`

- **Request:** `request_id` обязателен; `hotel_id`, `meals`, `confirmability`, `free_cancel`, `operators`.
- **Upstream:** `/search/hotel_rooms`.

### `GET /get-hotel-offers`

- **Request:** `request_id` + `hotel_id` обязательны; `operator_ids`, `compact`.
- **Upstream:** `/get_hotel_offers`.
- **Errors:** `400` / `500`.

### `GET /packages/package_details`, `GET /packages/actualize`

- Proxy GET на одноимённые LT paths. Errors: `500` Failed to start search (как в коде).

### `POST /orders/prebuild`

- Body → LT `POST /orders/prebuild`.
- Errors: upstream status + `{ success: false, error: … }`.

### `POST /packages/prebook`

- Body → LT через `ltRequest` (версии 3.8…3.4).
- Response: LT JSON; при ошибке может добавить `skippable` (api version).

### `POST /packages/flights`

- **Request:** body с `package_id` (положительное целое); остальные поля фильтруются (пустые time ranges отбрасываются).
- **Errors:** `400` Missing or invalid package_id; иначе `sendLtAxiosError`.

### `POST /validate-tourists`

- Body → LT `POST /tourists/validate`.
- Errors: upstream status / `{ success: false, error }`.

---

## 4.4 Orders create & client LT orders

### `POST /create-package`

- **Назначение:** создать заказ в LT (`POST /orders/create`), сохранить в `orders`, документы, опционально VTB-оплату и email.
- **Auth:** Public (LT token **захардкожен** в handler — security issue).
- **Request body (используемые поля):** `client` (name, surname, email, phone, bonus_score), `package_id`, `tourists`, `flight_pair_id`, `payment_option`, `selected_extras`, `booking_id`, `user_id`, `comment`, `email`/`phone`/`name`, `amount`/`payment`, `payUrl`/`qrcId`, `orderName`, `paymentPurpose`/`purposeText`, `auth_token`.
- **Required:** email и phone покупателя.
- **Response:** `response.data` от LT (при success). При catch — `{ error: … }` (часто без HTTP 5xx).
- **Side effects:** INSERT `orders`; `order_documents`; emails; VTB payment.

### `GET /client/orders`

- **Auth:** `auth_token` query/body (LT client token). Partner key добавляется proxy.
- **Request:** `page_number` (default 0), `page_limit` (default 10).
- **Errors:** `400` missing_auth_token; LT errors через `formatLtClientError`.
- **Response:** sanitized LT payload.

### `GET /client/orders/:order_id`

- **Auth:** `auth_token` или `orders.lt_auth_token`.
- **Query:** `save=0|false` отключает запись package в БД.
- **Response:** sanitized LT + `package_updated`.

### `POST /client/orders/:order_id/sync`

- **Auth:** body/query `auth_token` или `LT_CLIENT_AUTH_TOKEN`.
- **Назначение:** sync + download PDFs (`syncOrderFromClient`).
- **Errors:** `400` invalid/missing; upstream status; `500`.

### `GET /orders?order_id=`

- **Назначение:** checkout snapshot: LT client order если есть token, иначе DB row.
- **Response (LT path):** `{ order_id, package, pay_status, transaction_code, order_state, last_lt_event, …payment fields }`.
- **Errors:** `400` Missing order_id; `404` not found; `500`.

### `GET /orders/:order_id/payment`

- **Назначение:** статус/URL оплаты из package JSON.
- **Query:** `ensure=1|true` или `create=1` — создать VTB QR если нет; `amount`, `orderName`, `paymentPurpose`.
- **Errors:** `404` Order not found; `500`.

### `GET /orders/documents?order_id=`

- **Response:** `{ order_id, documents }`.
- **Errors:** `400` / `500`.

### `GET /user/orders?user_id=`

- **Auth (с 01.09):** `requireAuth(['user',…])` + владелец из токена (`resolveOwnerId`); `user_id` в query сверяется с токеном — в log-режиме несовпадение только логируется (`owner_mismatch`). То же для `/orders`, `/orders/documents`, `/orders/:id/payment`, `/client/orders*`, `/create-package`.
- **Response:** массив заказов пользователя (+ `last_lt_event`).
- **Errors:** `500`.

### `GET /home/data`

- Тот же handler, что `/api/home/data` — агрегат главной (см. CMS).

---

## 4.5 Payments & bank callbacks

### `POST /vtb/create-order`

- **Request:** `orderId`, `orderName`, `expire`, `amount.value`, `amount.code`, `returnUrl` обязательны; `paymentPurpose`/`purposeText`.
- **Note:** `expire`/`returnUrl` проверяются, но создание идёт через `createVtbPaymentForOrder` (свои URL/минуты).
- **Errors:** `400` Missing required fields; `500`.

### `POST /check_pay`

- **Request:** `qrcId` и/или `orderId`.
- **Назначение:** VTB QR info → обновить `pay_status`/`transaction_*`; при оплате — notify LT + email.
- **Response (пример полей):** `{ message, status, paid, qrcId, order_id, transaction_id, transaction_code, notify_* }`.
- **Особенность:** часто HTTP **200** даже при soft-error (`status: "error"`).

### `POST /payment/status`

- **Назначение:** подпись + `POST` LT `/orders/:id/notify` (cancelled signature path в коде).
- **Request:** `order_id`, `status`, `amount`.
- **Response:** статус/тело LT.

### `POST /vtb/callback`

- **Auth:** Public endpoint (обработка в `processVtbCallback`).
- **Response:** `200` result; errors `{ success: false, error }`.

### `POST /level_travel/notify-paid`

- **Request:** `order_id` обязателен, `amount` опционален.
- **Назначение:** partner → LT notify paid (`notifyLevelTravelOrderPaid`).

### `POST /tours/level_travel/notify`

- **Auth:** header `Partner-Api-Key` = `PARTNER_API_KEY`.
- **Назначение:** LT → partner order change; пишет `lt_order_events`, sync package/docs.
- **Errors:** `401` Unauthorized.

### `POST /tours/level_travel/order_refund`

- **Auth:** `Partner-Api-Key`.
- **Назначение:** refund notify (`processOrderRefund`).

### `GET /tours/level_travel/history`

- **Auth:** `Partner-Api-Key`.
- **Query:** `order_id`, `limit`, `offset`.
- **Response:** история из `lt_order_events`.

---

## 4.6 User auth — `/api/auth`

| Method | Path | Назначение |
|--------|------|------------|
| POST | `/api/auth/signup` | Регистрация + код на email + captcha |
| POST | `/api/auth/verify` | Проверка кода → `{ auth, authToken, accessToken, refreshToken }` |
| POST | `/api/auth/signin` | Запрос кода для существующего email |
| GET | `/api/auth/me` | **с 01.09** — профиль по Bearer (user/agent), всегда strict: без токена → `401 {"error":"unauthorized"}` |
| POST | `/api/auth/refresh` | **с 01.09** — stateless refresh: body `{ refreshToken }` → новая пара токенов; мусор → `401`. Алиас `POST /customer-auth/refresh-token` (для текущей версии приложения) |
| POST | `/api/auth/agent/sign-in` | **с 01.09** — вход агента: email + пароль из `users` (`role=agent`), bcrypt, ленивая миграция plaintext → `401` при ошибке |
| POST | `/api/auth/generation-loyalty` | Сгенерировать loyalty id (без записи user) |
| POST | `/api/auth/verification-code` | Telegram Gateway phone verify |
| POST | `/api/auth/telegram-verification-callback` | Callback Telegram (логирует body; ответа успеха почти нет) |

На `/api/auth/*` и `/api/admin/auth/*` — rate-limit 30 запросов / 15 мин (`AUTH_RATE_WINDOW_MS`, `AUTH_RATE_LIMIT`).

### Signup request

- Body: `name`, `l_name`, `email`, `phone`, captcha token (`smart-token` / `smartToken` / …).
- Success `201`: `{ message, screen: 'VERIFICATION' }`.
- Errors: `400` email exists / captcha; `500`.

### Verify

- Body: `email`, `code`.
- Success `200`: `{ auth: true, authToken: <JWT 30d, совместимость>, accessToken, refreshToken }` (с 01.09).
- Payload user-токена: `id, name, f_name, l_name, email, phone, loyalty_id, date, role, scope` — без `code`, `password`, `voipToken`, `socketId`, `access`.
- Apple demo: `test@totus.com` / `1111` (фиксированный код, email не шлётся).

### Signin

- Success `201`: `{ message, screen: 'VERIFICATION' }` или `{ message, screen: 'SIGNUP' }` если user not found (тоже 201).

---

## 4.7 Admin auth & dashboard — `/api/admin/auth`

| Method | Path | Auth |
|--------|------|------|
| POST | `/api/admin/auth/sign-in` | Public → email+password bcrypt (rate-limit 30/15 мин) |
| POST | `/api/admin/auth/refresh` | body `token` = refresh (rate-limit 30/15 мин) |
| POST | `/api/admin/auth/init` | Bearer access JWT |
| GET | `/api/admin/auth/users` | `requireAuth(['staff'])` в log-режиме (с 01.09; без токена пока 200 — ожидаемо до `enforce`) |
| GET | `/api/admin/auth/orders` | то же |
| GET | `/api/admin/auth/orders/:id` | то же (по `orders.id`) |
| GET | `/api/admin/auth/orders/user/:id` | то же |
| GET | `/api/admin/auth/overview` | то же |

Sign-in response: `{ accessToken, refreshToken, id, name, lastname, email, role }` — staff access 12 ч / refresh 30 д (`STAFF_ACCESS_TTL`, `STAFF_REFRESH_TTL`; после PR #1/#2, ранее `10s`).

Overview: `{ orders, stats: { totalUsers, totalOrders, todayOrders } }` (orders за 7 дней).

---

## 4.8 Email test — `/api/email`

| Method | Path |
|--------|------|
| GET | `/api/email/test/templates` |
| POST | `/api/email/test` |
| POST | `/api/email/test/send` |
| POST | `/api/email/test/all` |

Auth: с 01.09 — `requireAuth(['staff'])` в log-режиме (до `enforce` фактически public). Controllers: `email.controller.js`.

---

## 4.9 FAQ / Popular / Callback / Content / Pages

### FAQ

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/faq` | Public list `{ data: [...] }` |
| POST/PUT/GET/DELETE | `/api/admin/faq…` | Admin CRUD, `requireAuth(['staff'])` в log-режиме (с 01.09) |

Create/update body: `question`, `answer` (+ `id` на update). Responses: `{ message, data }`.

### Popular

| Method | Path |
|--------|------|
| CRUD | `/api/admin/popular` (+ `/:id`) | multer `image` |

### Callback requests

| Method | Path |
|--------|------|
| POST | `/api/callback-requests/` | body `{ phone }` → `201` `{ message, id }` |
| GET | `/api/admin/callback-requests` | `limit`/`offset` |
| DELETE | `/api/admin/callback-requests/:id` | |

### Content upload

| Method | Path | Field |
|--------|------|-------|
| POST | `/api/content/upload` | `upload` |
| POST | `/api/content/upload-image` | `file` |

Images only; max `UPLOAD_MAX_IMAGE_MB` (default 15). Errors: `413`/`400`/`500`.

### Pages

| Method | Path |
|--------|------|
| GET | `/api/pages/slug/:slug` | Public (allowlist slug) |
| GET/POST/PUT/DELETE | `/api/admin/pages…` | CRUD + `POST /save` upsert by slug |

Fields: `name`, `slug`, `seo_*`, `section`, `breadcrumb_label`, `mobile_header_title`, `content`.  
Неразрешённый slug → `403`/`404`.

---

## 4.10 Home CMS (public + admin)

| Method | Path |
|--------|------|
| GET | `/api/home-banners` |
| GET/PUT | `/api/admin/home-banners`, `/api/admin/home-banners/:position` |
| GET | `/api/home-partners` |
| CRUD | `/api/admin/home-partners` |
| GET | `/api/home-hero` |
| GET/PUT | `/api/admin/home-hero` |
| GET | `/api/home/data` |
| GET/PUT | `/api/admin/home-sections` |
| CRUD | `/api/admin/home-hotels`, `/api/admin/home-destinations` |
| GET | `/api/footer-social` |
| CRUD + icons | `/api/admin/footer-social…` |

`GET /home/data` и `GET /api/home/data` — один controller:

```json
{
  "recommendedTitle": "…",
  "destinationsTitle": "…",
  "recomendHotels": [{ "id", "name", "rate", "city", "price", "review", "image" }],
  "popularDestinations": [{ "id", "name", "image", "to_country" }]
}
```

Admin CMS routes: с 01.09 все `/api/admin/*` (кроме `auth/sign-in|refresh`), `/api/email/*`, `/api/content/upload*` — под `requireAuth(['staff'])` в **log-режиме** (`AUTH_MODE=log`: запросы без валидного токена пропускаются и логируются `[AUTH]`; блокировка — после переключения в `enforce`, см. §6–7).

---

---

## Приложение A. Полный каталог HTTP-эндпоинтов (108)

Источник: `app.js` + `routes/*`. Static mounts не входят в число 108.

### Inline (`app.js`) — 38

1. `GET /references/departures`
2. `GET /references/destinations`
3. `GET /references/autocomplete_v2`
4. `GET /references/operators`
5. `GET /references/airlines`
6. `GET /references/airports`
7. `GET /references/hotels`
8. `GET /references/hotel_dump`
9. `GET /references/hotel_reviews/:hotel_id`
10. `GET /references/flights_and_nights`
11. `GET /start-search`
12. `GET /packages/package_details`
13. `GET /packages/actualize`
14. `POST /orders/prebuild`
15. `POST /packages/prebook`
16. `GET /search-status`
17. `GET /grouped-hotels`
18. `GET /hotels-rooms`
19. `GET /get-hotel-offers`
20. `POST /packages/flights`
21. `POST /vtb/create-order`
22. `POST /create-package`
23. `POST /validate-tourists`
24. `GET /client/orders`
25. `GET /client/orders/:order_id`
26. `POST /client/orders/:order_id/sync`
27. `GET /orders`
28. `GET /orders/:order_id/payment`
29. `GET /orders/documents`
30. `GET /user/orders`
31. `GET /home/data`
32. `POST /check_pay`
33. `POST /payment/status`
34. `POST /vtb/callback`
35. `POST /level_travel/notify-paid`
36. `POST /tours/level_travel/notify`
37. `POST /tours/level_travel/order_refund`
38. `GET /tours/level_travel/history`

### Mounted `/api/*` — 70

39. `POST /api/auth/signup`
40. `POST /api/auth/verify`
41. `POST /api/auth/signin`
42. `POST /api/auth/generation-loyalty`
43. `POST /api/auth/verification-code`
44. `POST /api/auth/telegram-verification-callback`
45. `GET /api/email/test/templates`
46. `POST /api/email/test`
47. `POST /api/email/test/send`
48. `POST /api/email/test/all`
49. `POST /api/admin/auth/sign-in`
50. `POST /api/admin/auth/refresh`
51. `POST /api/admin/auth/init`
52. `GET /api/admin/auth/users`
53. `GET /api/admin/auth/orders`
54. `GET /api/admin/auth/orders/:id`
55. `GET /api/admin/auth/orders/user/:id`
56. `GET /api/admin/auth/overview`
57. `POST /api/admin/faq`
58. `PUT /api/admin/faq`
59. `GET /api/admin/faq`
60. `GET /api/admin/faq/:id`
61. `DELETE /api/admin/faq/:id`
62. `POST /api/admin/popular`
63. `PUT /api/admin/popular`
64. `GET /api/admin/popular`
65. `DELETE /api/admin/popular/:id`
66. `GET /api/admin/popular/:id`
67. `POST /api/content/upload`
68. `POST /api/content/upload-image`
69. `GET /api/pages/slug/:slug`
70. `GET /api/admin/pages/slug/:slug`
71. `GET /api/admin/pages/`
72. `GET /api/admin/pages/:id`
73. `POST /api/admin/pages/save`
74. `POST /api/admin/pages/`
75. `PUT /api/admin/pages/`
76. `DELETE /api/admin/pages/:id`
77. `POST /api/callback-requests/`
78. `GET /api/admin/callback-requests`
79. `DELETE /api/admin/callback-requests/:id`
80. `GET /api/home-banners`
81. `GET /api/admin/home-banners`
82. `PUT /api/admin/home-banners/:position`
83. `GET /api/home-partners`
84. `GET /api/admin/home-partners`
85. `POST /api/admin/home-partners`
86. `PUT /api/admin/home-partners/:id`
87. `DELETE /api/admin/home-partners/:id`
88. `GET /api/home-hero`
89. `GET /api/admin/home-hero`
90. `PUT /api/admin/home-hero`
91. `GET /api/home/data`
92. `GET /api/admin/home-sections`
93. `PUT /api/admin/home-sections`
94. `GET /api/admin/home-hotels`
95. `POST /api/admin/home-hotels`
96. `PUT /api/admin/home-hotels/:id`
97. `DELETE /api/admin/home-hotels/:id`
98. `GET /api/admin/home-destinations`
99. `POST /api/admin/home-destinations`
100. `PUT /api/admin/home-destinations/:id`
101. `DELETE /api/admin/home-destinations/:id`
102. `GET /api/footer-social`
103. `GET /api/admin/footer-social`
104. `GET /api/admin/footer-social/icons`
105. `POST /api/admin/footer-social`
106. `PUT /api/admin/footer-social/:id`
107. `DELETE /api/admin/footer-social/:id`
108. `GET /api/faq`

### Static (дополнительно, не в 108)

- `GET /uploads/*`
- `GET /upload/content/*`
- `GET /upload/home/*`

**Итого HTTP API: 108.** С static mounts: 111 точек входа Express.

Добавлено 01.09 (PR #3, не входят в 108): `GET /api/auth/me`, `POST /api/auth/refresh`, `POST /api/auth/agent/sign-in`, алиас `POST /customer-auth/refresh-token`.

---

# 5. Group Endpoints

| Группа | Prefix / paths |
|--------|----------------|
| Authentication (users) | `/api/auth/*` |
| Authentication (staff/admin) | `/api/admin/auth/*` |
| Level.Travel references | `/references/*` |
| Search & hotels | `/start-search`, `/search-status`, `/grouped-hotels`, `/hotels-rooms`, `/get-hotel-offers` |
| Packages & booking | `/packages/*`, `/orders/prebuild`, `/create-package`, `/validate-tourists` |
| Client LT orders | `/client/orders*` |
| Local orders / docs / payment | `/orders*`, `/user/orders`, `/check_pay`, `/payment/status`, `/vtb/*`, `/level_travel/*` |
| LT webhooks | `/tours/level_travel/*` |
| Home & CMS public | `/home/data`, `/api/home*`, `/api/faq`, `/api/pages`, `/api/footer-social` |
| Admin CMS | `/api/admin/*` (faq, popular, home-*, pages, callback-requests) |
| Content upload | `/api/content/*` |
| Email tests | `/api/email/*` |
| Callback form | `/api/callback-requests` |
| Static | `/uploads`, `/upload/*` |

Logout / password reset для users: **Не найдено в текущей кодовой базе.**

---

# 6. Authentication

> **С 01.09.2026 (PR #3, волна 1 плана `SECURITY_JWT_PLAN_RU.md`)** — единое auth-ядро `lib/auth.js`: роли `user | agent | staff`, `requireAuth(roles, {strict})`, режим `AUTH_MODE=log|enforce` (`log` — по умолчанию и на проде: запросы без валидного токена пропускаются, пишется лог `[AUTH] mode=… reason=missing|invalid|forbidden|owner_mismatch …`; `enforce` — `401`/`403`), `AUTH_LOG_ONLY_PATHS` (пути, которые остаются в log даже при enforce), `resolveOwnerId` / `assertOrderOwner` (владелец — из токена, не из query). Сопутствующее в `lib/security.js`: helmet (без CSP, CORP cross-origin), CORS-whitelist `CORS_ORIGINS`, rate-limit 30/15 мин на auth-эндпоинты; `app.set('trust proxy', 1)`. Проверка ядра без БД — `npm run check`.

## End users (`users`)

```text
signup/signin
  ↓
Yandex SmartCaptcha (кроме Apple demo)
  ↓
4-digit code → users.code + email (Yandex Postbox)
  ↓
POST /verify
  ↓
access JWT (JWT_SECRET, USER_ACCESS_TTL) + refresh JWT (JWT_REFRESH_SECRET, USER_REFRESH_TTL, typ:'refresh', stateless)
  ↓
{ auth: true, authToken (30d, совместимость), accessToken, refreshToken }
```

- Payload user-токена: `id, name, f_name, l_name, email, phone, loyalty_id, date, role:'user', scope` — **без** `code`, `password`, `voipToken`, `socketId`, `access` (ранее подписывалась вся строка `users`).
- `GET /api/auth/me` — профиль по Bearer (user/agent), всегда strict (`401 {"error":"unauthorized"}` без токена независимо от `AUTH_MODE`).
- `POST /api/auth/refresh` — body `{ refreshToken }`, stateless (без колонки в БД; отзыв — только ротацией `JWT_REFRESH_SECRET`). Алиас `POST /customer-auth/refresh-token` — для текущей версии приложения.
- Паролей у пользователей **нет**.
- Apple App Review: email `test@totus.com`, код `1111`.
- Captcha bypass: нет `YANDEX_SMARTCAPTCHA_SERVER_KEY` → skip; или `ALLOW_LOCAL_CAPTCHA_BYPASS=1` / `NODE_ENV=development` + token `local-dev`.

## Agents (`users.role = 'agent'`)

```text
POST /api/auth/agent/sign-in { email, password }
  ↓
bcrypt.compare(password, users.password)   # plaintext-пароль перехэшируется при первом успешном входе (ленивая миграция)
  ↓
access JWT (AGENT_ACCESS_TTL) + refresh JWT (AGENT_REFRESH_TTL), role:'agent'
```

- Неверные данные → `401`. Тот же формат токена принимает `calling_api_v2` (общий `JWT_SECRET`).

## Staff (`staff`)

```text
POST /api/admin/auth/sign-in
  ↓
bcrypt.compare(password, staff.password)
  ↓
access JWT (JWT_SECRET, STAFF_ACCESS_TTL = 12 ч) + refresh JWT (JWT_REFRESH_SECRET, STAFF_REFRESH_TTL = 30 д)
  ↓
UPDATE staff.refresh_token
```

- `/init`: Bearer access token.
- `/refresh`: body `token` должен совпасть с `staff.refresh_token`.

## Partner / LT

- Inbound webhooks: header **`Partner-Api-Key`**.
- Outbound LT: `Authorization: Token token="<LT_API_TOKEN|LT_PARTNER_API_KEY|hardcoded fallback>"`.
- Client orders: `auth_token` / колонка `orders.lt_auth_token`.

## Telegram

- Hardcoded Bearer к `gatewayapi.telegram.org`; код в коде фиксирован `1111` в `verificationCode`.

Cookies для auth: **Не найдено в текущей кодовой базе.**

---

# 7. Authorization

С 01.09.2026 guards `requireAuth(roles)` из `lib/auth.js` стоят на маршрутах ниже, **в log-режиме** (`AUTH_MODE=log` на проде: ничего не блокируется, только логи `[AUTH]`; переключение в `enforce` — волна 2, после анализа логов).

| Роль | Маршруты под guard | Что есть в коде |
|------|--------------------|-----------------|
| Anonymous | — | Поиск/справочники LT, чтение CMS (`/api/pages`, `/api/home-*`, `/api/faq`, `/api/footer-social`), signup/signin/verify, `callback-requests`, платёжные callback'и ВТБ, LT-webhooks |
| `user` (+ владелец) | `/user/orders`, `/orders`, `/orders/documents`, `/orders/:id/payment`, `/client/orders*`, `/create-package` | `requireAuth(['user',…])` + `assertOrderOwner`: владелец берётся из токена (`resolveOwnerId`), `user_id` в query — не источник истины; в log-режиме несовпадение пишется как `owner_mismatch` |
| `agent` | `GET /api/auth/me`, `POST /api/auth/refresh` | Токен от `/api/auth/agent/sign-in`; основная работа агента — в `calling_api_v2` |
| `staff` | все `/api/admin/*` кроме `auth/sign-in|refresh`, `/api/email/*`, `/api/content/upload*` | `requireAuth(['staff'])` (CMS, users, orders, overview, upload, email-тесты) |
| Partner (API key) | `/tours/level_travel/*` | `verifyPartnerApiKey` |

Всегда strict (независимо от `AUTH_MODE`): `GET /api/auth/me`.

Guards помимо `requireAuth`: `verifyPartnerApiKey`, inline Bearer на `/api/admin/auth/init`, captcha на signup/signin.

---

# 8. Database Integration

- **Драйвер:** `mysql2/promise` pool (`db.js`).
- **ORM / migrations framework:** нет (ручные `scripts/run-*.js`, `migrate-*.js`).
- **Transactions:** явных `BEGIN/COMMIT` в основном API-коде **Не найдено в текущей кодовой базе.** (отдельные query).

## Таблицы (по коду / миграциям)

| Таблица | Ключевые поля / заметки |
|--------|-------------------------|
| `users` | name, l_name, email, phone, code, loyalty_id |
| `staff` | email, password (bcrypt), refresh_token, name, lastname, role |
| `orders` | order_id, package (JSON text), user_id, lt_auth_token, pay_status, transaction_id, transaction_code, order_state, refund_amount, refund_at, c_date |
| `order_documents` | order_id, title, source_url, file_path, public_url, event_reference |
| `order_email_log` | order_id, email_type, recipient, message_id, claimed_at, sent_at |
| `lt_order_events` | order_id, reference UNIQUE, reference_type, event, changes, payload |
| `faq` | question, answer, c_date |
| `popular` | (image upload CRUD) |
| `pages` | name, slug UNIQUE, seo_*, section, content, … |
| `callback_requests` | phone, created_at |
| `home_banners` | position UNIQUE, image, url |
| `home_partners` | name, image, url, sort_order |
| `home_hero` | id=1, title, image |
| `home_sections` | id=1, recommended_title, destinations_title |
| `home_recommended_hotels` | hotel_id, name, rate, city, price, review, image, sort_order |
| `home_popular_destinations` | name, image, to_country, sort_order |
| `footer_social_links` | title, icon, url, sort_order, is_active |

Полный CREATE для `users`/`staff`/`orders` базовых колонок в репозитории: частично через ALTER-миграции; исходный CREATE **Не найден полностью** для всех legacy-колонок.

---

# 9. API → Database Mapping

| Endpoint | Handler | «Service» util | Table | Op |
|----------|---------|----------------|-------|-----|
| POST /api/auth/signup | auth.controller | captcha, email, loyalty | users | INSERT |
| POST /api/auth/verify | auth.controller | jwt | users | SELECT/UPDATE |
| POST /api/auth/signin | auth.controller | captcha, email | users | SELECT/UPDATE |
| POST /api/admin/auth/sign-in | authController | bcrypt, jwt | staff | SELECT/UPDATE |
| POST /create-package | app.js inline | orderDocuments, orderEmails, vtb | orders, order_documents | INSERT/UPDATE |
| GET /orders | app.js | levelTravelClientOrder, orderPayment | orders, lt_order_events | SELECT |
| POST /check_pay | app.js | VTB + LT notify | orders | UPDATE |
| POST /tours/level_travel/notify | webhooks | levelTravelWebhooks | lt_order_events, orders | INSERT/UPDATE |
| POST /api/callback-requests | callbackRequests | — | callback_requests | INSERT |
| GET /api/home/data | homeContent | publicApiBase | home_* | SELECT |
| CRUD /api/admin/faq | faq.controller | — | faq | CRUD |
| CRUD /api/admin/pages | pages.controller | cmsPages | pages | CRUD |
| POST /api/content/upload* | content.controller | multer | filesystem | write file |

LT-only proxies (`/references/*`, `/start-search`, …): **без БД**.

---

# 10. Controllers

В `controllers/` **13 файлов**:

| Файл | Ответственность |
|------|-----------------|
| `auth.controller.js` | User signup/verify/signin, loyalty gen, Telegram verify |
| `authController.js` | Staff auth, users/orders lists, overview |
| `callbackRequests.controller.js` | Заявки на звонок |
| `content.controller.js` | Возврат URL загруженного изображения |
| `email.controller.js` | Тестовая отправка шаблонов |
| `faq.controller.js` | FAQ CRUD |
| `footerSocial.controller.js` | Соцсети футера + allowlist icons |
| `homeBanners.controller.js` | Баннеры по position |
| `homeContent.controller.js` | Home aggregate + sections/hotels/destinations |
| `homeHero.controller.js` | Hero title/image |
| `homePartners.controller.js` | Партнёры |
| `pages.controller.js` | CMS pages |
| `popular.controller.js` | Popular block CRUD |

Большая часть booking/payment логики — **не в controllers**, а inline в `app.js` + `utils/*`.

---

# 11. Services (utils)

Отдельной папки `services/` нет. Роль сервисов выполняют:

| Файл | Методы / роль |
|------|---------------|
| `levelTravelHttp.js` | `getLtHeaders`, `ltRequest`, `logLtError`, `sendLtAxiosError` |
| `levelTravelClientOrder.js` | fetch/sync client orders, package build/save, auth token resolve |
| `levelTravelWebhooks.js` | `verifyPartnerApiKey`, `processOrderNotify`, `processOrderRefund` |
| `levelTravelPayment.js` | `notifyLevelTravelOrderPaid`, signatures |
| `vtbCreatePayment.js` | OAuth + dynamic QR + save payment |
| `vtbCallback.js` | `processVtbCallback` |
| `vtbPaymentPurpose.js` | текст назначения платежа |
| `orderPayment.js` | payUrl/qrcId в package, checkout URL, attach payment |
| `orderDocuments.js` | PDF download, sanitize URLs, prepareOrderRowForClient |
| `orderEmails.js` / `orderEmailTemplates.js` | transactional emails + locks |
| `yandexCloudEmail.js` | Postbox SES send |
| `yandexSmartCaptcha.js` | validate token |
| `emailTemplates.js` | verification email |
| `loyaltyGenerator.js` | unique loyalty ids (+ `loyalty_ids.json`) |
| `clientOrders.js` | LT event history queries |
| `callbackLogger.js` | structured logs |
| `publicApiBase.js` | absolute API base |

---

# 12. Middleware

| Middleware | Где | Что делает |
|------------|-----|------------|
| `lib/security.js` (helmet, cors whitelist, rate-limit) | app.js | helmet без CSP (CORP cross-origin — иначе `/uploads` не откроются с totus.club); CORS по `CORS_ORIGINS` (дефолт — домены totus.club + localhost); rate-limit 30/15 мин на `/api/auth/*`, `/api/admin/auth/*` |
| `requireAuth(roles, {strict})` (`lib/auth.js`) | routes `/api/admin/*`, `/api/email/*`, `/api/content/*`, user-маршруты заказов в app.js | JWT-guard по ролям `user|agent|staff`, `AUTH_MODE=log|enforce`, проверка владельца (`assertOrderOwner`) |
| `express.json()` | app.js | JSON body |
| `express.static` | uploads paths | static files |
| `middleware/upload*.js` | popular/banners/hero/hotels/destinations/partners | multer disk |
| content multer | `routes/content.routes.js` | image filter + size |
| `verifyPartnerApiKey` | LT webhook routes | 401 if bad key |
| `logLtRequest` | LT notify/refund | request logging |

Auth middleware: `lib/auth.js` (`requireAuth`, с 01.09). `app.set('trust proxy', 1)` — чтобы rate-limit и логи видели реальный IP за nginx.

---

# 13. Validation

- **Joi / Zod / express-validator:** нет.
- Ad-hoc:
  - captcha на signup/signin;
  - phone normalize (RU) для callback;
  - `package_id` digits для `/packages/flights`;
  - FAQ trim required;
  - CMS slug allowlist (`config/cmsPages.js`);
  - tourists → делегировано LT `/tourists/validate`;
  - VTB required fields на `/vtb/create-order`.

---

# 14. Error Handling

- Глобального handler: **нет**.
- Паттерн: `try/catch` → `res.status(…).json({ error|message|success:false })`.
- LT: `sendLtAxiosError` часто пробрасывает upstream status/body.
- `check_pay`: soft errors с HTTP 200.
- Webhooks: `logCallback` / `logCallbackError`.
- Multer: 413 size, 400 type.

Примеры:

```json
{ "error": "Missing request_id" }
```

```json
{ "success": false, "error": "Unauthorized" }
```

```json
{ "message": "Invalid code" }
```

---

# 15. External APIs

| Система | Base / endpoint | Auth | Зачем |
|---------|-----------------|------|-------|
| Level.Travel | `https://api.level.travel` | Token token | поиск, пакеты, заказы, notify |
| VTB Passport | `https://open.api.vtb.ru:443/passport/oauth2/token` | client_credentials (в коде hardcoded) | access token |
| VTB SBP | `gw.api.vtb.ru/.../qr/dynamics…` | Bearer + Merchant headers | QR create/info |
| Yandex SmartCaptcha | `smartcaptcha.cloud.yandex.ru/validate` | server key env | signup/signin |
| Yandex Postbox | `postbox.cloud.yandex.net` (SESv2) | `YC_POSTBOX_*` | email |
| Telegram Gateway | `https://gatewayapi.telegram.org/` | Bearer hardcoded | phone OTP |
| SAMO.RU | `http://search.samo.ru/api/` | digest login | только `index.js` |

Retry: `ltRequest` retries на 408/429/5xx + version fallback на «Incorrect api version».  
Departures: кэш 5 минут при ошибке.

---

# 16. Webhooks

| Endpoint | Source | Auth | Processing |
|----------|--------|------|------------|
| `POST /vtb/callback` | VTB bank | — | `processVtbCallback` → orders pay status |
| `POST /tours/level_travel/notify` | Level.Travel | Partner-Api-Key | events → DB + sync docs |
| `POST /tours/level_travel/order_refund` | Level.Travel | Partner-Api-Key | refund fields |
| `POST /level_travel/notify-paid` | Partner→LT | Public API | notify LT paid |
| `POST /api/auth/telegram-verification-callback` | Telegram | — | console.log only |

Idempotency LT: unique `reference` в `lt_order_events`.

---

# 17. File Upload API

| Path | Storage | Limits |
|------|---------|--------|
| `/api/content/upload`, `/upload-image` | `upload/content/` | images; default 15MB |
| Admin popular/banners/hero/hotels/destinations/partners | `uploads/<type>/` | jpeg/png/webp (+banner etc.), ~15MB |
| Order PDFs | `uploads/orders/:orderId/` | скачивание с LT URLs |

Returned URL: абсолютный через `getPublicApiBase` + path.  
Deletion: при update/delete CMS иногда unlink локального файла.

---

# 18. Pagination / Filtering / Sorting

| API | Params |
|-----|--------|
| `/grouped-hotels` | page_limit, page_number, sort_by, filter_* |
| `/client/orders` | page_number, page_limit |
| `/tours/level_travel/history` | limit, offset, order_id |
| `/api/admin/callback-requests` | limit (1–500, default 200), offset |
| `/references/hotel_reviews` | page, per_page |

Единого cursor pagination API: **Не найдено в текущей кодовой базе.**

---

# 19. API Response Architecture

Единого envelope **нет**. Встречаются:

- «сырой» LT JSON;
- `{ data: … }` (FAQ, admin lists);
- `{ message, data }` / `{ message, screen }`;
- `{ success: false, error }`;
- `{ auth, authToken }`;
- payment status объекты.

---

# 20. Environment Variables

Только имена (без значений).

| Variable | Purpose | Used in |
|----------|---------|---------|
| `PORT` | Listen port | `app.js` |
| `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | MySQL pool | `db.js` |
| `JWT_SECRET` | User / agent / staff access JWT (общий с `calling_api_v2`, `totus_ai_v2`) | `lib/auth.js`, auth controllers |
| `JWT_REFRESH_SECRET` | Refresh JWT (user/agent stateless, staff) | `lib/auth.js`, authController |
| `AUTH_MODE` | `log` (default, прод 01.09) \| `enforce` | `lib/auth.js` |
| `AUTH_LOG_ONLY_PATHS` | Пути, остающиеся в log-режиме при `enforce` | `lib/auth.js` |
| `CORS_ORIGINS` | CORS-whitelist (дефолт — домены totus.club + localhost) | `lib/security.js` |
| `USER_ACCESS_TTL`, `USER_REFRESH_TTL` | TTL токенов user | `lib/auth.js` |
| `AGENT_ACCESS_TTL`, `AGENT_REFRESH_TTL` | TTL токенов agent | `lib/auth.js` |
| `STAFF_ACCESS_TTL`, `STAFF_REFRESH_TTL` | TTL токенов staff (12 ч / 30 д) | `lib/auth.js` |
| `AUTH_RATE_WINDOW_MS`, `AUTH_RATE_LIMIT` | Rate-limit auth-эндпоинтов (30 / 15 мин) | `lib/security.js` |
| `LT_API_TOKEN` / `LT_PARTNER_API_KEY` | Outbound LT token | levelTravelHttp, app |
| `LT_CLIENT_AUTH_TOKEN` | Fallback client auth_token | app sync, clientOrder util |
| `LT_SIGN_KEY` | Подписи LT notify | levelTravelPayment |
| `PARTNER_API_KEY` | Inbound Partner-Api-Key | levelTravelWebhooks |
| `YANDEX_SMARTCAPTCHA_SERVER_KEY` | Captcha | yandexSmartCaptcha |
| `ALLOW_LOCAL_CAPTCHA_BYPASS` | Dev bypass | yandexSmartCaptcha |
| `NODE_ENV` | Dev captcha bypass | yandexSmartCaptcha |
| `YC_POSTBOX_ACCESS_KEY_ID`, `YC_POSTBOX_SECRET_ACCESS_KEY` | Postbox | yandexCloudEmail |
| `EMAIL_USER`, `EMAIL_FROM` | From address | email / yandexCloudEmail |
| `API_PUBLIC_URL`, `PUBLIC_API_URL` | Absolute links | publicApiBase, orderEmails |
| `CHECKOUT_URL` | Checkout links in emails | orderPayment |
| `UPLOAD_MAX_IMAGE_MB` | Content upload limit | content.routes |

В `.env` также есть `EMAIL_PASS`, `VTB_CALLBACK_URL` — **не читаются** через `process.env` в JS (поиск по кодовой базе).

Также: optional `.env.local` override. Полный список с комментариями — `.env.example` (добавлен в PR #3).

---

# 21. Background Jobs

- Cron / queues / workers: **Не найдено в текущей кодовой базе.**
- Fire-and-forget: `.catch()` на email/VTB после create-package / check_pay.
- In-memory: departures cache (5 мин); email locks Map в `orderEmails.js`.

---

# 22. Real-time API

WebSocket / Socket.IO / SSE: **Не найдено в текущей кодовой базе.**

---

# 23. Security

### Что реализовано

- JWT для users / agents / staff (access + refresh) — единое ядро `lib/auth.js` (с 01.09).
- `requireAuth(roles)` на `/api/admin/*`, `/api/email/*`, `/api/content/upload*` (staff) и user-маршрутах заказов (user + владелец) — **в log-режиме** (см. §7).
- bcrypt для staff passwords и паролей агентов (ленивая миграция plaintext при входе).
- helmet (без CSP, CORP cross-origin), CORS-whitelist `CORS_ORIGINS`, rate-limit 30/15 мин на auth-эндпоинты (`lib/security.js`).
- Yandex SmartCaptcha на signup/signin.
- Partner-Api-Key на LT inbound webhooks.
- Parameterized SQL (`?` placeholders) — защита от простой SQL injection.
- Multer file type/size limits на uploads.
- CMS slug allowlist.

### Проблемы / риски (без секретов)

- **`AUTH_MODE=log`** на проде — guards пока ничего не блокируют (`/api/admin/auth/users` без токена → 200); `enforce` + ротация `JWT_SECRET` — волна 2 плана JWT, после анализа логов.
- **Hardcoded secrets** в исходниках: LT token (app.js create-package / fallbacks), VTB client_id/secret/merchant headers, Telegram Gateway token, Partner key fallback в webhooks; `.env` закоммичен в репо (Б.1, не исправлено).
- VTB HTTPS: `rejectUnauthorized: false`.
- User-токен пока несёт поля профиля (сайт и приложение читают профиль из payload); сокращение до `{id, role, scope}` — с релизом приложения (волна 5).
- Refresh user/agent stateless — отзыв только ротацией `JWT_REFRESH_SECRET`.
- `index.js` / auth содержат credentials в репозитории.
- Нет CSRF-защиты.

---

# 24. API Business Logic

## Поиск тура

```text
GET /start-search → LT enqueue
  ↓
poll GET /search-status?request_id=
  ↓
GET /grouped-hotels → GET /hotels-rooms → GET /get-hotel-offers
  ↓
GET /packages/package_details | actualize
  ↓
POST /packages/prebook | /packages/flights
  ↓
POST /validate-tourists
  ↓
POST /create-package → LT create + DB + docs + VTB/email
```

## Оплата SBP

```text
create-package / vtb/create-order → VTB dynamic QR (payUrl, qrcId)
  ↓
клиент оплачивает
  ↓
POST /check_pay и/или POST /vtb/callback
  ↓
UPDATE orders.pay_status
  ↓
LT notify paid + emails
```

## LT webhook lifecycle

```text
LT POST /tours/level_travel/notify (+ Partner-Api-Key)
  ↓
dedupe by reference → lt_order_events
  ↓
sync package / download documents / emails by state
```

## User auth

```text
signup/signin → captcha → code email → verify → { authToken 30d, accessToken, refreshToken }
                                                  ↓
                                   Bearer accessToken → GET /api/auth/me (профиль)
                                   401 → POST /api/auth/refresh { refreshToken }
```

---

# 25. Important Backend Files

| File | Purpose | Importance |
|------|---------|------------|
| `app.js` | Server + LT/payment routes | Critical |
| `db.js` | MySQL pool | Critical |
| `controllers/auth.controller.js` | User auth | High |
| `controllers/authController.js` | Staff/admin | High |
| `utils/levelTravelHttp.js` | LT client | Critical |
| `utils/levelTravelClientOrder.js` | Client orders sync | Critical |
| `utils/levelTravelWebhooks.js` | Inbound LT | Critical |
| `utils/vtbCreatePayment.js` | Payments | Critical |
| `utils/orderDocuments.js` | PDFs | High |
| `utils/orderEmails.js` | Transactional mail | High |
| `utils/orderPayment.js` | Pay metadata | High |
| `package.json` | deps / scripts | High |
| `config/cmsPages.js` | CMS allowlist | Medium |
| `index.js` | SAMO experiment | Low (не сервер) |

---

# 26. API Dependencies

| Package | Зачем | Критичность |
|---------|-------|-------------|
| `express` ^5.1.0 | HTTP API | Critical |
| `mysql2` | БД | Critical |
| `axios` | LT/VTB/captcha/Telegram | Critical |
| `dotenv` | env | Critical |
| `cors` | CORS (whitelist через `lib/security.js`) | High |
| `helmet` | Security headers (с 01.09, PR #3) | High |
| `express-rate-limit` | Rate-limit auth-эндпоинтов (с 01.09, PR #3) | High |
| `jsonwebtoken` | JWT | High |
| `bcrypt` | staff passwords | High |
| `bcryptjs` | пароли агентов (`/api/auth/agent/sign-in`) | Medium |
| `multer` | uploads | High |
| `nodemailer` | MIME | High |
| `@aws-sdk/client-sesv2` | Postbox | High |
| `qs` | listed | Low / usage sparse |
| `node-fetch` | listed | Low (axios primary) |

---

# 27. API Scripts

`package.json` scripts:

| Script | Behavior |
|--------|----------|
| `test` | `echo "Error: no test specified" && exit 1` |
| `check` | Автотест логики auth-ядра (`lib/auth.js`) без БД (с 01.09) |
| `start` / `dev` / `build` | **Нет** |

Запуск API:

```bash
cd totus_API
npm install        # обязателен после PR #3: новые зависимости helmet, express-rate-limit
# настроить .env (DB_*, JWT_*, AUTH_MODE, CORS_ORIGINS, LT_*, PARTNER_API_KEY, … — см. .env.example)
npm run check      # проверка auth-ядра
node app.js
```

Миграции (примеры):

```bash
node scripts/run-lt-migration.js
node scripts/run-lt-auth-token-migration.js
node scripts/run-order-documents-migration.js
node scripts/run-order-email-log-migration.js
node scripts/migrate-pages.js
node scripts/migrate-home-*.js
node scripts/seed-home-*.js
```

Проверка БД: `node test_db.js`.

---

# 28. API Deployment

В репозитории totus_API:

- Dockerfile / docker-compose / PM2 / Nginx / systemd unit / CI: **Не найдено в текущей кодовой базе.**

Из кода известно:

- Production public URL default: `https://api.totus.club`.
- Process: Node Express listen `PORT`.

`Предположение:` деплой настраивается вне этого репозитория (хостинг/systemd/PM2 на сервере).

---

# 29. API Testing

| Item | Status |
|------|--------|
| Unit / integration / e2e | **Нет** |
| Swagger / OpenAPI / Postman в repo | **Нет** |
| `npm test` | placeholder, exit 1 |
| `test_db.js` | ручной ping MySQL |

---

# 30. Instructions for Claude Code

## Карта backend

| Что | Где |
|-----|-----|
| Запуск | `node app.js` из `totus_API/` (не `index.js`) |
| Порт | `PORT` или 3001 |
| Routes LT/orders/payments | **`app.js`** (inline) |
| Routes `/api/*` | `routes/*.js` + mount в конце `app.js` |
| Controllers | `controllers/` |
| «Services» | `utils/` |
| DB pool | `db.js` |
| Models/ORM | нет — SQL в controllers/utils |
| User auth | `controllers/auth.controller.js` + `routes/auth.routes.js` |
| Staff auth | `controllers/authController.js` + `routes/authRoutes.js` |
| JWT-ядро / guards | `lib/auth.js` (`requireAuth`, `AUTH_MODE`), `lib/security.js` (helmet, CORS, rate-limit) |
| Middleware uploads | `middleware/upload*.js` |
| Partner key | `utils/levelTravelWebhooks.js` |
| Env | `.env` / `.env.local`; имена в §20 |
| Migrations | `scripts/` |

## Критичные endpoints

- Поиск: `/start-search`, `/search-status`, `/grouped-hotels`, `/hotels-rooms`, `/packages/*`
- Бронь: `/create-package`, `/validate-tourists`
- Оплата: `/vtb/create-order`, `/check_pay`, `/vtb/callback`, `/level_travel/notify-paid`
- LT callbacks: `/tours/level_travel/notify`, `/order_refund`
- Auth: `/api/auth/*` (в т.ч. `/me`, `/refresh`, `/agent/sign-in`), `/api/admin/auth/sign-in`

## Перед изменением API проверь

1. `app.js` — нет ли уже inline-роута.
2. `utils/levelTravelHttp.js` — версии Accept / headers.
3. Схему `orders.package` JSON (`orderPayment`, `orderDocuments`).
4. Webhook idempotency (`lt_order_events.reference`).
5. Не логировать и не коммитить secrets; вынести hardcoded tokens в env.
6. Новые `/api/admin/*` маршруты — под `requireAuth(['staff'])`; user-маршруты с владельцем — через `resolveOwnerId`/`assertOrderOwner`, не по `user_id` из query. Ядро `lib/auth.js` держать в синхроне с копией в `calling_api_v2/lib/auth.js`.
7. `package.json` main ≠ реальный entry.

## Архитектурные правила (как есть)

- Thin routes + fat `app.js` / utils.
- Raw SQL, no ORM.
- LT — source of truth для туров; MySQL — локальный snapshot + CMS + payments metadata.
- Нет единого response format / global errors / queues.

---

*Конец документации. Источник: код totus_API. Секреты не включены.*
