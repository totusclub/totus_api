# Calling API Documentation (RU) — calling_api_v2

Документация построена **только по коду** репозитория `calling_api_v2`  
(`/Users/haykmaruqyan/Desktop/TOSMEDIA/TOTUS/calling_api_v2`).

Web-админка агента: см. **`CALLING_FRONT_DOCUMENTATION_RU.md`** в `calling_v2/`.

Если сведения отсутствуют в коде: **`Не найдено в текущей кодовой базе.`**  
Если вывод неочевиден: **`Предположение:`**

Секреты (DB password, APN keys, DeepSeek key) **не приводятся**.

Git: `https://github.com/tosmedia/calling_api_v2.git`

---

## Содержание

1. [Назначение](#1-назначение)
2. [Архитектура](#2-архитектура)
3. [Стек и запуск](#3-стек-и-запуск)
4. [Структура кода](#4-структура-кода)
5. [In-memory state](#5-in-memory-state)
6. [Авторизация](#6-авторизация)
7. [Users API](#7-users-api)
8. [Device registration](#8-device-registration)
9. [Calls & WebRTC signaling](#9-calls--webrtc-signaling)
10. [Socket.io протокол](#10-socketio-протокол)
11. [Contacts & Favorites](#11-contacts--favorites)
12. [TTS & Tour Assistant (mobile legacy)](#12-tts--tour-assistant-mobile-legacy)
13. [HTTP API — полный справочник](#13-http-api--полный-справочник)
14. [База данных MySQL](#14-база-данных-mysql)
15. [APNs VoIP Push](#15-apns-voip-push)
16. [Заказы (orders)](#16-заказы-orders)
17. [Production и деплой](#17-production-и-деплой)
18. [Безопасность](#18-безопасность)
19. [Инструкции для Claude Code](#19-инструкции-для-claude-code)

---

# 1. Назначение

**totus-backend** (`calling_api_v2`) — backend для:

- **VoIP / WebRTC signaling** между totusapp (iOS/Android) и web-агентами (`calling_v2`);
- **регистрации устройств** (voipToken, socketId) в MySQL;
- **iOS VoIP push** через APNs при входящем звонке;
- **users / contacts / favorites** для мобильного приложения;
- **legacy AI voice** (DeepSeek + Google TTS) — tour-assistant для mobile.

**Заказы туров в этом API не реализованы** — см. [§16](#16-заказы-orders).

---

# 2. Архитектура

```
Clients
  ├── calling_v2 (web agent)     ──HTTPS/WSS──┐
  └── totusapp (React Native)    ──HTTPS/WSS──┤
                                              ▼
                              calling_api_v2 (:4444)
                              Express + Socket.io
                                              │
                    ┌─────────────────────────┼─────────────────┐
                    ▼                         ▼                 ▼
              MySQL kedam              APNs (iOS VoIP)    DeepSeek / Google TTS
              users, contacts,         totusapp push      tour-assistant
              favorites
                    │
                    │  orders — отдельно
                    ▼
              totus_API → api.totus.club
```

**STUN/TURN:** не настраиваются на backend — только relay SDP/ICE между peers. ICE servers задаются **клиентами**.

**Production nginx:** `voip.totus.club` → `127.0.0.1:4444` (см. `SERVER_TLS_CONFIG_RU.md`).

В коде frontend hardcoded `server.totus.club` — **предположение:** alias того же backend.

---

# 3. Стек и запуск

| Компонент | Значение |
|-----------|----------|
| name | `totus-backend` |
| Entry | `index.js` (~3134 lines) |
| Framework | Express **^4.21.1** |
| WebSocket | Socket.io **^4.8.1** |
| DB | mysql2 **^3.6.0** |
| Push | apn **^2.2.0** |
| TTS | @google-cloud/text-to-speech |
| HTTP client | axios (DeepSeek) |
| Auth (с 01.09, PR #1) | `jsonwebtoken`, `bcryptjs`, `express-rate-limit`, `dotenv` |
| Port | `process.env.PORT \|\| **4444**` |

**Scripts:**

```bash
npm start      # NODE_ENV=development node index.js
npm run dev    # nodemon index.js (nodemon not in dependencies)
npm run check  # автотест auth-ядра (lib/auth.js) без БД — с 01.09
```

После PR #1 (волна 3) при деплое **обязателен `npm install`** — новые зависимости `bcryptjs`, `dotenv`, `express-rate-limit`, `jsonwebtoken`.

**Health check:**

```bash
curl http://localhost:4444/api/health
# → { "ok": true }
```

**Env (используемые):**

| Variable | Default / назначение |
|----------|---------|
| `PORT` | `4444` |
| `APN_VOIP_TOPIC` | `app.totus.club.voip` |
| `JWT_SECRET` | Проверка access-токенов — **то же значение, что у totus_API** (с 01.09) |
| `JWT_REFRESH_SECRET` | Refresh-токены агента — то же, что у totus_API (с 01.09) |
| `AUTH_MODE` | `log` (default, прод) \| `enforce` (с 01.09) |
| `AUTH_LOG_ONLY_PATHS` | Пути, остающиеся в log при enforce (с 01.09) |
| `CORS_ORIGINS` | CORS-whitelist (с 01.09) |
| `AUTH_RATE_WINDOW_MS`, `AUTH_RATE_LIMIT` | Rate-limit на `/api/web/login` (с 01.09) |

**С 01.09:** `dotenv` читает `.env` (на сервере — `/home/calling_api_v2/.env`, новый файл, создан владельцем); `.env.example` — в репо (PR #1). Без `JWT_SECRET` в env логин работает без токенов (предупреждение в лог). Старт пишет `[AUTH] mode=…`.

---

# 4. Структура кода

```
calling_api_v2/
├── index.js              # Monolith: routes + socket + APNs + DeepSeek; app.use(httpGate), io.use(socketGate)
├── db.js                 # MySQL pool + userDb (+ getUserByEmail, updateUserPassword), contactDb, favoriteDb, callDb*
├── ttsService.js         # Google Cloud TTS
├── lib/                  # с 01.09 (PR #1)
│   ├── auth.js           # копия JWT-ядра totus_API (requireAuth, AUTH_MODE, dotenv) — держать в синхроне
│   └── security.js       # CORS-whitelist, rate-limit на login
├── middleware/
│   └── auth.js           # httpGate (POLICY путь → роли + владелец), socketGate, socketLoyaltyId
├── scripts/              # вспомогательные скрипты
├── .env.example          # имена env (с 01.09)
├── p8/                   # Apple Push .p8 keys
└── *.json                # Google service account (TTS)
```

\* `callDb`, `candidateDb`, `deviceDb` **определены, но не импортируются** в `index.js`.

Отдельных `routes/`, `controllers/` **нет**; `middleware/` и `lib/` появились в PR #1 (01.09).

---

# 5. In-memory state

| Map | Key → Value |
|-----|-------------|
| `devices` | deviceId → { userId, loyaltyId, voipToken, platform, socketId } |
| `calls` | callId → { offer, answer, from/to device & loyalty, … } |
| `callCandidates` | callId → { caller: [], callee: [] } |
| `deviceSockets` | deviceId → socket.id |
| `socketDevices` | socket.id → deviceId |
| `loyaltyIdToDeviceId` | loyaltyId → deviceId |

Звонки **не пишутся в MySQL** (таблицы `calls` / `call_candidates` в `db.js` unused).

---

# 6. Авторизация

> **С 01.09.2026 (PR #1, волна 3 плана `SECURITY_JWT_PLAN_RU.md`, ветка `prod`).** JWT-гейт на HTTP и Socket.io в режиме **`AUTH_MODE=log`** — запросы без валидного токена пропускаются и логируются `[AUTH]`; `enforce` (реальная блокировка) — волна 6, после релиза приложения, которое шлёт Bearer на voip. Токены — тот же формат и тот же `JWT_SECRET`, что у `totus_API` (роли `user | agent | staff`).

## POST `/api/web/login`

**Body:** `{ email, password }`

**Logic** (`index.js` + `db.js`, с 01.09):

1. `getUserByEmail(email)` (`db.js`), `COALESCE(access, 0) = 0`.
2. `bcrypt.compare(password, users.password)`; если в БД plaintext и он совпал — **ленивый перехэш** в bcrypt (`updateUserPassword`), отдельный скрипт миграции не нужен.
3. `role !== 'agent'` → **403**.
4. Rate-limit на login (`lib/security.js`, `express-rate-limit`; ответ несёт заголовок `RateLimit`).
5. Response:

```json
{
  "ok": true,
  "user": { "id", "loyaltyId", "name", "fName", "lName", "email", "phone", "role" },
  "accessToken": "<agent JWT, 12 ч>",
  "refreshToken": "<refresh JWT, 30 д>"
}
```

Refresh агента — через `totus_API POST /api/auth/refresh` (так делает `calling_v2`). Без `JWT_SECRET` в env логин отдаёт `{ok, user}` без токенов.

## HTTP-гейт (`middleware/auth.js` → `httpGate`)

`app.use(httpGate)` — таблица `POLICY` «метод + путь → роли + владелец». Владелец — по `id`/`userId` в пути или теле либо по `loyalty_id` из payload токена; `agent`/`staff` проверку владельца обходят.

| Путь | Роли | Владелец |
|------|------|----------|
| `POST /api/web/login`, `GET /api/health` | public | — |
| `GET /api/users`, `PATCH /api/users/:id/access` | agent, staff | — |
| `GET /api/users/by-id/:id`, `GET /api/users/search/:id` | user | — |
| `GET /api/users/:loyaltyId` | user | свой `loyalty_id` |
| `POST /api/register-device`, `POST /api/unregister-device` | user | свой `loyalty_id` |
| `/api/calls*` | user | — |
| `/api/contacts*`, `/api/favorites*` | user | свой `userId` |
| `/api/tts*`, `/api/tour-assistant*`, `/api/v2*` | user | — |

В `log`-режиме нарушение политики → запись `[AUTH] reason=missing|invalid|forbidden|owner_mismatch …`, запрос выполняется; в `enforce` → `401`/`403`.

## Socket.io-гейт (`socketGate`)

`io.use(socketGate)` — токен из `handshake.auth.token` (запасной вариант `?token=`). `socketLoyaltyId(socket)` — личность из токена; `registerDevice` берёт `loyaltyId` из токена, а не из payload события.

---

# 7. Users API

## Endpoints

| Method | Path | Описание |
|--------|------|----------|
| GET | `/api/users` | Все пользователи |
| GET | `/api/users/:loyaltyId` | По loyalty_id (normalized, без пробелов) |
| GET | `/api/users/by-id/:userId` | По numeric id |
| GET | `/api/users/search/:loyaltyId` | Поиск для contacts |
| PATCH | `/api/users/:userId/access` | `{ access: boolean }` |

## Response shape (list item)

```json
{
  "id": 1,
  "loyaltyId": "...",
  "name": null,
  "fName": "...",
  "lName": "...",
  "email": "...",
  "phone": "...",
  "online": true,
  "hasVoipToken": true,
  "hasSocket": false,
  "access": 0
}
```

## Поле `access` — ⚠️ inconsistency

| Место | Семантика |
|-------|-----------|
| Login SQL | `access = 0` → login OK; `1` → blocked |
| `updateUserAccess` comment | `1 = enabled, 0 = disabled` |
| GET by-id response | `(access ?? 1) === 1` |

При изменениях — сверить все три места.

---

# 8. Device registration

## POST `/api/register-device`

**Body:** `{ deviceId, loyaltyId | userId, voipToken, platform?: 'ios'|'android'|'web' }`

- Find user by `loyalty_id` (spaces stripped in SQL)
- UPDATE `voipToken`, `socketId` in `users`
- Store in `devices` Map

## POST `/api/unregister-device`

Clear voipToken, socketId, online=0, remove from memory maps.

## Socket `registerDevice`

**Payload:** `{ deviceId, loyaltyId, userId? }`

- С 01.09 `loyaltyId` берётся из токена сокета (`socketLoyaltyId`), не из payload
- Set socketId, online=1 in DB
- Update in-memory maps
- Broadcast `user-status`

---

# 9. Calls & WebRTC signaling

Backend **не** терминирует медиа — только SDP + ICE relay + push.

## Flow

```
Caller POST /api/calls { callId, fromLoyaltyId, toLoyaltyId, offer, callerName }
  → store in calls Map
  → if iOS + voipToken: APNs VoIP push
  → if web/socket: emit offer + call-state: ringing

Callee POST /api/calls/:callId/answer { answer, deviceId }
  → store answer
  → emit answer + call-state: answered to caller socket

Both sides POST /api/calls/:callId/candidate
  → relay via socket or poll GET .../candidates

End: POST /api/calls/:callId/end
Reject: POST /api/calls/:callId/reject
```

## HTTP endpoints

| Method | Path | Назначение |
|--------|------|------------|
| POST | `/api/calls` | Start call |
| POST | `/api/calls/by-loyalty` | Resolve deviceId, forward to /api/calls |
| POST | `/api/calls/:callId/answer` | SDP answer |
| GET | `/api/calls/:callId` | Poll offer/answer |
| POST | `/api/calls/:callId/candidate` | Post ICE |
| GET | `/api/calls/:callId/candidates?for=caller\|callee` | Poll ICE |
| POST | `/api/calls/:callId/reject` | Reject |
| POST | `/api/calls/:callId/end` | End call |

## Call states (`call-state` event)

`ringing` | `dialing` | `answered` | `rejected` | `ended`

## Android push

**Не реализован:** log `"Android push not implemented yet"`.

---

# 10. Socket.io протокол

**Server CORS:** с 01.09 — whitelist из `CORS_ORIGINS` (та же функция, что для HTTP, `lib/security.js`); ранее `origin: '*'`.  
**Auth:** `io.use(socketGate)` — клиент передаёт `io(BASE_URL, { auth: { token } })` (см. §6).

### Client → Server

| Event | Payload |
|-------|---------|
| `registerDevice` | `{ deviceId, loyaltyId, userId? }` |
| `get-users-status` | — |
| `offer` | `{ callId, offer, fromDeviceId, toDeviceId }` |
| `answer` | `{ callId, answer, fromDeviceId, toDeviceId }` |
| `ice-candidate` | `{ callId, candidate, fromDeviceId, toDeviceId }` |

### Server → Client

| Event | Payload |
|-------|---------|
| `user-status` | `{ loyaltyId, online }` |
| `users-status` | array of statuses |
| `offer` | incoming offer |
| `answer` | answer SDP |
| `ice-candidate` | ICE candidate |
| `call-state` | `{ callId, state, direction, callerName?, fromLoyaltyId? }` |

---

# 11. Contacts & Favorites

Используются **totusapp**, не calling_v2.

## Contacts

| Method | Path |
|--------|------|
| POST | `/api/contacts` |
| GET | `/api/contacts/:userId` |
| GET | `/api/contacts/check/:userId/:contactLoyaltyId` |

## Favorites (hotels)

| Method | Path |
|--------|------|
| POST | `/api/favorites` |
| DELETE | `/api/favorites` |
| GET | `/api/favorites/:userId` |
| GET | `/api/favorites/:userId/:hotelId` |

DB: `contactDb`, `favoriteDb` in `db.js`.

---

# 12. TTS & Tour Assistant (mobile legacy)

## POST `/api/tts/synthesize`

Google TTS → base64 MP3 in JSON.

## POST `/api/tts/synthesize-to-file`

Google TTS → file on disk.

## POST `/api/tour-assistant`

DeepSeek chat + TTS + parse tour recommendations.

## POST `/api/tour-assistant/stream`

DeepSeek streaming → build search params JSON for frontend search.

**External:** `https://api.deepseek.com/v1/chat/completions` (key hardcoded in `index.js`).

---

# 13. HTTP API — полный справочник

| # | Method | Path |
|---|--------|------|
| 1 | OPTIONS | `*` (CORS preflight) |
| 2 | POST | `/api/web/login` |
| 3 | POST | `/api/register-device` |
| 4 | POST | `/api/unregister-device` |
| 5 | GET | `/api/users` |
| 6 | GET | `/api/users/:loyaltyId` |
| 7 | GET | `/api/users/by-id/:userId` |
| 8 | PATCH | `/api/users/:userId/access` |
| 9 | GET | `/api/users/search/:loyaltyId` |
| 10 | POST | `/api/contacts` |
| 11 | GET | `/api/contacts/:userId` |
| 12 | GET | `/api/contacts/check/:userId/:contactLoyaltyId` |
| 13 | POST | `/api/favorites` |
| 14 | DELETE | `/api/favorites` |
| 15 | GET | `/api/favorites/:userId` |
| 16 | GET | `/api/favorites/:userId/:hotelId` |
| 17 | POST | `/api/calls/by-loyalty` |
| 18 | POST | `/api/calls` |
| 19 | POST | `/api/calls/:callId/answer` |
| 20 | GET | `/api/calls/:callId` |
| 21 | POST | `/api/calls/:callId/candidate` |
| 22 | GET | `/api/calls/:callId/candidates` |
| 23 | POST | `/api/calls/:callId/reject` |
| 24 | POST | `/api/calls/:callId/end` |
| 25 | POST | `/api/tts/synthesize` |
| 26 | POST | `/api/tts/synthesize-to-file` |
| 27 | POST | `/api/tour-assistant` |
| 28 | POST | `/api/tour-assistant/stream` |
| 29 | GET | `/api/health` |

---

# 14. База данных MySQL

**File:** `db.js`  
**Database:** `kedam` (shared with totus_API user data)

**Config:** hardcoded host/user/password in `dbConfig` (comment mentions .env but literals used) — Б.1, не исправлено на 01.09.

**Новое в `db.js` (01.09):** `getUserByEmail`, `updateUserPassword` — для bcrypt-логина и ленивой миграции паролей.

### Active tables

**`users`**

| Column | Usage |
|--------|-------|
| id | PK |
| loyalty_id | Client ID, calls |
| name, f_name, l_name, email, phone | Profile |
| role | `agent` for web login |
| password | bcrypt (с 01.09; остатки plaintext перехэшируются при первом успешном логине) |
| voipToken | APNs token |
| socketId | Socket.io id |
| online | 0/1 |
| access | Block flag |
| date | Created |

**`contacts`:** user_id, contact_loyalty_id, created_at

**`favorites`:** user_id, hotel_id, hotel_data (JSON), created_at

### Unused (defined in db.js only)

- `calls`, `call_candidates` — `callDb`, `candidateDb`
- `deviceDb` — separate device table logic not wired to index.js

### loyalty_id normalization

SQL: `REPLACE(loyalty_id, " ", "") = ?` — пробелы в ID игнорируются.

---

# 15. APNs VoIP Push

**Library:** `apn`  
**Mode:** `production: true`  
**Topic:** `process.env.APN_VOIP_TOPIC || 'app.totus.club.voip'`  
**Key:** `p8/AuthKey_2X2QV7S43J.p8` (keyId, teamId in `providerOpts`)

Triggered on `POST /api/calls` when callee is iOS with valid voipToken.

---

# 16. Заказы (orders)

**Не найдено в calling_api_v2:**

- No `/orders` routes
- No proxy to totus_API
- No SQL on `orders` table

Заказы — **totus_API** (`api.totus.club`):

| Method | Path |
|--------|------|
| GET | `/user/orders?user_id=` |
| GET | `/orders?order_id=` |
| GET | `/client/orders` |

Связь: `orders.user_id` ↔ `users.id` в той же MySQL `kedam`.

Для orders в admin panel — интеграция на **frontend** (`calling_v2`), не в этом API.

---

# 17. Production и деплой

| Param | Value |
|-------|-------|
| Port | 4444 |
| nginx | `voip.totus.club` → `127.0.0.1:4444` |
| TLS | Let's Encrypt + `ssl-totus-tspu.conf` |
| trust proxy | `app.set('trust proxy', true)` |

```bash
cd /home/calling_api_v2          # ветка prod
git pull
npm install                      # обязателен после PR #1 (bcryptjs, dotenv, express-rate-limit, jsonwebtoken)
# .env: JWT_SECRET, JWT_REFRESH_SECRET (= totus_API), AUTH_MODE=log, CORS_ORIGINS — см. .env.example
pm2 restart api_calling
pm2 logs api_calling | grep '\[AUTH\]'   # стартовая строка mode=log и логи гейта
```

Живая проверка 01.09: `voip.totus.club/api/web/login` отдаёт заголовок `RateLimit`; `GET /api/users` без токена — 200 (log-режим, ожидаемо).

---

# 18. Безопасность

Состояние на 01.09.2026 (после PR #1, волна 3):

| Риск | Уровень | Статус / Detail |
|------|---------|--------|
| Auth on API routes | High (был Critical) | **JWT-гейт `httpGate` + `socketGate` в log-режиме** — пока ничего не блокирует; `enforce` — волна 6, после релиза приложения с Bearer на voip |
| Plaintext passwords | Resolved | **bcrypt, ленивая миграция** при первом успешном логине |
| Open CORS `*` | Resolved | **whitelist `CORS_ORIGINS`** (HTTP + Socket.io) |
| Hardcoded DB creds | High | `db.js` — Б.1, не исправлено |
| Secrets in repo | High | `p8/`, JSON сервисных аккаунтов, DeepSeek key — Б.1, не исправлено |
| Rate limiting | Partial | `express-rate-limit` на `/api/web/login`; остальные маршруты без лимита |
| Calls not persisted | Low | No audit log |

**Middleware present:** cors (whitelist), bodyParser.json, request logger, OPTIONS handler, `httpGate`, `socketGate`, login rate-limit.  
**Not present:** helmet, input validation library.

---

# 19. Инструкции для Claude Code

| Задача | Где |
|--------|-----|
| New HTTP route | Append in `index.js` **и** добавить правило в `POLICY` (`middleware/auth.js`) |
| Auth / роли / владелец | `middleware/auth.js` (`httpGate`, `socketGate`), ядро `lib/auth.js` (копия totus_API — синхронить) |
| CORS / rate-limit | `lib/security.js`, env `CORS_ORIGINS`, `AUTH_RATE_*` |
| User SQL | `db.js` → `userDb` (+ `getUserByEmail`, `updateUserPassword`) |
| Socket handler | `index.js` → `io.on('connection')`; личность — `socketLoyaltyId(socket)` |
| APNs config | `index.js` → `providerOpts`, `APN_VOIP_TOPIC` |
| TTS | `ttsService.js` |
| DeepSeek / tour-assistant | `index.js` (search `tour-assistant`) |

**Adding orders:** integrate in `calling_v2` + `totus_API`, **not** here.

**Do not break:**

- loyalty_id space normalization
- totusapp shares this API — test mobile after signaling changes; **текущая версия приложения не шлёт Bearer на voip — не переключать `AUTH_MODE=enforce` до релиза (волна 5/6)**
- APNs production vs sandbox keys

**Frontend:** `calling_v2/CALLING_FRONT_DOCUMENTATION_RU.md`

---

*26 августа 2026; обновлено 01.09.2026 (PR #1 — JWT-гейт, bcrypt, CORS-whitelist). Repo: `calling_api_v2`, ветка `prod`.*
