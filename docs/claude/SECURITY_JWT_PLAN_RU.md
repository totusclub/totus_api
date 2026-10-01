# TOTUS — план внедрения JWT по всему проекту (Б.2–Б.4, Б.6)

**Статус:** утверждён владельцем 31.08.2026. Живой документ: статусы волн обновляются по мере мержа PR. **01.09.2026:** волны 1 и 3 смержены и задеплоены на прод в режиме `log`; PR Totus_admin#3 (волна 2, админка) открыт.
**Контекст:** глобальная задача Б «Безопасность платформы» из `ROADMAP_RU.md`. Секреты из git (Б.1) и сервер (Б.5) — отдельные пункты, здесь не описываются, кроме ротации `JWT_SECRET`.

---

## 0. Исходное состояние (31.08.2026)

> Состояние на 31.08; волны 1–5 смержены 01–02.09 (всё в режиме `log`), осталось enforce (волны 2 и 6) — см. §3.1–3.5. Секреты (Б.1) вынесены из всех репо 01–02.09 — `SECURITY_AUDIT_SECRETS_RU.md`.

| Сервис | Что есть | Что не так |
|---|---|---|
| `totus_API` | user-JWT на `/api/auth/verify` (30 д, payload = вся строка `users`); staff-JWT 12 ч + refresh 30 д (после PR #1/#2); `middleware/authJwt.js` | middleware стоит только на `/api/admin/order-requests*`; `/api/admin/*`, `/user/orders`, `/orders`, `/api/email/test/*` — открыты; `user_id` берётся из query |
| `totus_WEB` | токен в `localStorage.auth_token`, профиль читается из payload (`jwt-decode`) | Bearer к `totus_API` **не отправляется** (кроме `orderRequestsApi`); нет общего axios-инстанса |
| `calling_api_v2` | `POST /api/web/login` (email + **plaintext** пароль, role=agent) | JWT нет вообще; все HTTP-маршруты и Socket.io открыты; `registerDevice` верит `loyaltyId` из payload; CORS `*` |
| `calling_v2` | сессия агента в `localStorage.webAppUser` | Bearer не шлёт, сокет без auth |
| `Totus_admin` | staff-вход через `totus_API` (`lib/staff-auth-api.ts`, refresh-once) | `authFetch` только у order-requests; остальные `lib/*-api.ts` и voip-маршруты без токена |
| `totus_ai_v2` | `requireAuth` (тот же `JWT_SECRET`) на `/api/ai-chats*` | WS `/ws/assistant` без токена; `/api/logs*`, `/api/debug/*`, `/api/schema` публичны |
| `totus_APP` | axios-interceptor Bearer + refresh на `api.totus.club`; `getAccessToken` для Милы | к `voip.totus.club` (favorites, contacts, register-device, calls, socket) токен не шлёт; refresh зовёт `/customer-auth/refresh-token` (в API-доке эндпоинта нет — проверить) |

---

## 1. Принципы

1. **Один эмитент, один секрет, один формат.** Все токены выпускает `totus_API`; один `JWT_SECRET` в `.env` каждого сервиса (`totus_ai_v2` уже так). Payload: `{ id, role: 'user'|'agent'|'staff', scope, iat, exp }` — без email/телефона/кода. Профиль — через `GET /api/auth/me`, не из токена.
2. **Одна проверка везде.** `requireAuth(roles)` — HTTP-middleware в трёх бэкендах + handshake-проверка Socket.io / WS. `401` — нет/битый/просрочен, `403` — не та роль.
3. **Владелец ресурса — из токена.** `user_id`/`loyaltyId` в query/body не источник истины; staff/agent могут указать чужой id, user — только свой.
4. **Режим наблюдения вместо staging.** Каждый middleware сначала в `AUTH_MODE=log` (пропускает всё, логирует запросы без валидного токена: маршрут, origin, UA). Логи чистые несколько дней → `AUTH_MODE=enforce`.
5. **Приложение в сторе пока не обновляется.** Текущая версия шлёт Bearer на `api.totus.club`, но не на `voip.totus.club` → `calling_api_v2` переходит в `enforce` только после релиза новой версии приложения.
6. **Ротация `JWT_SECRET`** (лежит в закоммиченном `.env`) — одним шагом с включением `enforce` в волне 2; все пользователи перелогинятся один раз.

---

## 2. Что делать — по репозиториям

### 2.1 `totus_API` (ядро, первым)

- `lib/auth.js` — verify/sign, `AUTH_MODE`, единый payload; `middleware/authJwt.js` → `requireAuth(roles)` с режимом `log|enforce`.
- User-токены: payload `{id, role:'user', scope:'user'}`; `POST /api/auth/refresh` (access 24 ч + refresh 30 д, хэш refresh в `users.refresh_token`). Пока приложение старое — `/verify` продолжает отдавать `authToken` на 30 д; TTL меняем после релиза приложения.
- `GET /api/auth/me` — профиль по токену.
- Staff: `sign-in` 12 ч / 30 д уже есть; вычистить остатки `10s`.
- Agent: `POST /api/auth/agent/sign-in` (email + bcrypt из `users`, `role='agent'`).
- Middleware: `requireAuth(['staff'])` — все `/api/admin/*` (CMS, users, orders, overview, upload); `requireAuth(['user','staff'])` + проверка владельца — `/user/orders`, `/orders`, `/orders/documents`, `/client/orders*`; `/api/email/test/*` — staff или удалить.
- Публичными остаются: поиск/справочники LT, чтение CMS (`/api/pages`, `/api/home-*`, `/api/faq`, `/api/footer-social`), `signup/signin/verify`, `callback-requests`, платёжные callback'и ВТБ, LT-webhooks (`Partner-Api-Key`).
- Сопутствующее: `helmet`, rate-limit на `/api/auth/*` и `/api/admin/auth/*`, CORS-whitelist.

### 2.2 `totus_WEB` (синхронно с 2.1)

- `src/api/http.ts` — единый axios-инстанс: Bearer из `localStorage.auth_token`, на `401` refresh, при неудаче logout. Перевести `AuthApi`, LT-прокси, orders, favorites, `orderRequestsApi`.
- Профиль — из `GET /api/auth/me`; `jwt-decode` только для `exp`.
- Убрать `user_id` из query/body, где он дублирует токен.
- Видимых изменений нет → макет по §3.7 не нужен.

### 2.3 `calling_api_v2`

- `middleware/auth.js` + `lib/auth.js` (тот же секрет, тот же `requireAuth`, `log|enforce`).
- `POST /api/web/login` → agent-JWT (прокси на `totus_API` или локальный выпуск тем же секретом); пароли агентов → bcrypt (миграция скриптом).
- HTTP: `['agent','staff']` — `/api/users*`, `PATCH /api/users/:id/access`; `['user','agent']` — `/api/register-device`, `/api/calls*`, `/api/contacts*`, `/api/favorites*` с проверкой принадлежности `loyaltyId`/`userId`.
- Socket.io: `io.use()` проверяет `handshake.auth.token`; `registerDevice` берёт `userId` из токена.
- CORS `*` → whitelist; rate-limit на login. Секреты из `db.js`/`p8/` — Б.1, отдельный PR.

### 2.4 `calling_v2`

- `lib/auth-api.ts` → agent-JWT; Bearer в `users-api`, `webrtc-service` (`/api/calls*`, `register-device`); `io(SERVER, { auth: { token } })`; `AuthGuard` — по валидности токена.

### 2.5 `Totus_admin`

- `authFetch` на все `lib/*-api.ts` (CMS, orders, users) и на voip-маршруты тем же staff-токеном. Экран входа не меняется.

### 2.6 `totus_ai_v2` (Мила)

- WS `/ws/assistant`: токен в `?token=` (или первое сообщение `auth`), проверка через `authUser.ts`, `log|enforce`. **Решение владельца:** пускать ли гостей без токена (открыто, см. §4).
- Закрыть `/api/logs*`, `/api/debug/*`, `/api/schema` — `requireAuth(['staff'])` или только localhost.
- Пакеты `@tosmedia/ai-assistant` / `-native`: передача токена в WS-клиент, перепубликация `pkg/*`.

### 2.7 `totus_APP` (отдельный релиз)

- `modules/axios`: refresh → `/api/auth/refresh` (проверить, существует ли `/customer-auth/refresh-token`).
- `favorites.ts`, `contacts.ts`, `users.ts`, `VoipService.ts` — voip-инстанс с Bearer; `io(..., { auth: { token } })`.
- Хранение токенов AsyncStorage → Keychain/Keystore — вторым шагом.

---

## 3. Волны PR

| Волна | PR | Режим после деплоя | Статус |
|---|---|---|---|
| 1 | `totus_API`: auth-ядро, `/me`, `/refresh`, agent sign-in, middleware в `log`; `totus_WEB`: interceptor, `/me` | `log` 3–5 дней | **Смержено и задеплоено 01.09 (log):** [totus_API#3](https://github.com/tosmedia/totus_API/pull/3), [totus_WEB#3](https://github.com/tosmedia/totus_WEB/pull/3). Живые проверки 01.09: `GET api.totus.club/api/auth/me` без токена → `{"error":"unauthorized"}`; `/api/auth/refresh` с мусором → 401; `/api/auth/agent/sign-in` → 401; `/api/admin/auth/users` без токена пока 200 (log-режим, ожидаемо) |
| 2 | `totus_API` → `enforce` на `/api/admin/*` и user-маршрутах; ротация `JWT_SECRET`; `Totus_admin` authFetch везде | `enforce` | **Клиентская часть смержена 01.09:** [Totus_admin#3](https://github.com/tosmedia/Totus_admin/pull/3) (единый staff-вход, Bearer на API и voip; staff-учётка создана). Осталось: `enforce` на totus_API + ротация `JWT_SECRET` — после анализа логов `[AUTH]` (3–5 дней) |
| 3 | `calling_api_v2`: bcrypt, middleware + socket-auth в `log`; `calling_v2` шлёт Bearer | `log` (ждём приложение) | **Смержено и задеплоено 01.09 (log):** [calling_api_v2#1](https://github.com/tosmedia/calling_api_v2/pull/1) → `prod`, [calling_v2#5](https://github.com/tosmedia/calling_v2/pull/5) → `main`. Большие файлы (`index.js`, `lib/webrtc-service.ts`) доехали через `push_wave3.sh` на Mac владельца; на сервере создан `/home/calling_api_v2/.env` (те же `JWT_SECRET`/`JWT_REFRESH_SECRET`, что у totus_API). Живые проверки 01.09: `voip.totus.club/api/web/login` отдаёт заголовок `RateLimit`; `/api/users` без токена пока 200 (log-режим, ожидаемо) |
| 4 | `totus_ai_v2`: WS-auth, закрыть debug/logs; перепубликация пакетов | `log` → `enforce` через неделю | **Смержен 01.09:** [totus_ai_v2#1](https://github.com/tosmedia/totus_ai_v2/pull/1). S1 — настройка `AI_GUEST_ACCESS` (по умолчанию гости разрешены). Осталось: публикация пакетов `pkg/*` с локальной машины (`npm run publish:assistant:git`) и `npm update @tosmedia/ai-assistant` на сайте + коммит lock (сейчас lock пинит v1.0.10 — сайт подключается к Миле гостем) |
| 5 | `totus_APP`: voip Bearer, socket auth, refresh → сборка → сторы | — | **Смержено в main:** волна 5 [totus_APP#1](https://github.com/tosmedia/totus_APP/pull/1) (01.09) + Б.1 [totus_APP#2](https://github.com/tosmedia/totus_APP/pull/2) (02.09: TURN через `GET /api/ice-servers`, `deepSeekApi.ts` удалён). Осталось: сборка iOS/Android, релиз в сторы (S4) |
| 6 | `calling_api_v2` → `enforce` (когда старых версий приложения в логах мало) | `enforce` | — |

Каждый PR — ветка `claude/*`, чеклист «`npm run build` перед мержем», деплой руками владельца (`git pull && npm install && pm2 restart …`), документация обновляется после мержа (оркестратор §3.5).

---

## 3.1. Как реализована волна 1 (факты по коду PR)

- `totus_API/lib/auth.js` — `requireAuth(roles, {strict})`, `AUTH_MODE` (`log` по умолчанию), `AUTH_LOG_ONLY_PATHS`, `resolveOwnerId`, `assertOrderOwner`; лог `[AUTH] mode=… reason=missing|invalid|forbidden|owner_mismatch METHOD path auth= origin= ip= ua= count=` с троттлингом 1/мин на ключ.
- `lib/security.js` — helmet (CSP выкл., CORP cross-origin — иначе `/uploads` не откроются с totus.club), CORS-whitelist (`CORS_ORIGINS`, дефолт — домены totus.club + localhost), rate-limit 30/15 мин на auth-эндпоинты. `app.set('trust proxy', 1)`.
- **Отступление от принципа 1 (временно):** user-токен несёт безопасный набор полей профиля (`id, name, f_name, l_name, email, phone, loyalty_id, date`) + `role`, `scope`, потому что текущие сайт и приложение читают профиль из payload. Полное сокращение до `{id, role, scope}` — в волне 5 вместе с релизом приложения. Из payload убраны `code`, `password`, `voipToken`, `socketId`, `access`.
- Refresh для user/agent — **stateless** (`JWT_REFRESH_SECRET`, `typ:'refresh'`), без колонки в БД; отзыв — только ротацией секрета. Staff-refresh как был (хранится в `staff.refresh_token`).
- `/verify` отдаёт `authToken` (30 д, совместимость) + `accessToken` + `refreshToken`. Алиас `POST /customer-auth/refresh-token` — для текущей версии приложения.
- Вход агента `POST /api/auth/agent/sign-in`: bcrypt, plaintext-пароли из `users` перехэшируются при первом успешном входе (ленивая миграция — скрипт не нужен).
- Новые зависимости API: `helmet`, `express-rate-limit` → при деплое обязателен `npm install`. `npm run check` — автотест логики ядра без БД.
- Сайт: interceptors на глобальном axios только для `API_BASE_URL`; `refresh_token` в `localStorage`; профиль из `/me` подмешивается поверх payload.
- **Найдено при работе (Б.1):** в `totus_WEB/package.json` в URL зависимости `@tosmedia/ai-assistant` зашит персональный GitHub-токен hayk95 — отозвать, установку перевести на `github:tosmedia/totus_ai_v2#pkg/ai-assistant` + git-credentials на сервере.

## 3.2. Как реализована волна 3 (факты по коду PR)

- `calling_api_v2/lib/auth.js` — копия ядра totus_API (держать в синхроне), читает `.env` через dotenv (`/home/calling_api_v2/.env` — новый файл, раньше env не было).
- `middleware/auth.js` — `httpGate`: таблица `POLICY` «метод + regexp пути → роли + владелец» (владелец по `id` в пути/теле или по `loyalty_id` из payload токена; agent/staff проверку владельца обходят); `socketGate` — `handshake.auth.token` (запасной вариант `?token=`); `socketLoyaltyId` — личность для `registerDevice`.
- Логин агента: bcrypt + ленивая миграция plaintext (как в totus_API `agent/sign-in`); ответ сохраняет `{ok, user}` и добавляет `accessToken`/`refreshToken`; без `JWT_SECRET` в env — логин работает без токенов (предупреждение в лог).
- CORS `*` → whitelist (`lib/security.js`, те же правила log/enforce), Socket.io cors — та же функция.
- `calling_v2`: `lib/http.ts` (`authFetch`, refresh через `totus_API /api/auth/refresh`, выход на `/login`), `auth-api` хранит токены (`webAppToken`, `webAppRefresh`), `webrtc-service` — все 12 fetch → `authFetch`, `io(..., { auth: { token } })`.
- **Ограничение инструмента:** файлы >~60 КБ не проходят через GitHub-коннектор (лимит вывода), а файл с TURN-кредами блокирует классификатор → большие правки едут через скрипт на Mac владельца (`push_wave3.sh`, проверка git-blob-SHA). На будущее: выносить логику в новые небольшие модули, в монолиты — минимальные вставки.
- **Найдено (Б.1):** `calling_api_v2/db.js` — креды MySQL в коде; `p8/` и JSON сервисных аккаунтов в репо; `calling_v2/lib/webrtc-service.ts` — TURN username/credential в бандле.

## 3.3. Как реализована волна 2 (админка) — PR Totus_admin#3, смержен 01.09

- **Единый staff-вход:** `/login` → `staffSignIn` (`totus_API POST /api/admin/auth/sign-in`), `AuthGuard` проверяет `staffAuth`; отдельная форма входа у раздела «Обращения» убрана.
- `lib/http.ts` — обёртка над `window.fetch`: staff Bearer подставляется во все запросы к `totus_API` и к voip (`calling_api_v2`) — то есть `authFetch` теперь глобально, а не только у order-requests.
- **Перед деплоем** нужна staff-учётка в `totus_API` — `scripts/create-staff-user.js`.
- Статус: ждёт согласования текстов экрана входа (§3.7 оркестратора, S5) и мержа. Серверная часть волны 2 (`AUTH_MODE=enforce` в `totus_API` + ротация `JWT_SECRET`) — после анализа логов `[AUTH]` за 3–5 дней.

## 3.4. Состояние на проде (01.09.2026)

- Везде `AUTH_MODE=log` — ничего не блокируется, только логи `[AUTH]` (totus_API и calling_api_v2).
- Живые проверки: `GET api.totus.club/api/auth/me` без токена → `{"error":"unauthorized"}`; `/api/auth/refresh` с мусором → 401; `/api/auth/agent/sign-in` → 401; `voip.totus.club/api/web/login` отдаёт заголовок `RateLimit`; `/api/admin/auth/users` и `voip /api/users` без токена — 200 (ожидаемо в log-режиме).
- **Б.1 — не исправлено:** `totus_WEB/package.json` — GitHub PAT в URL зависимости `@tosmedia/ai-assistant`; `calling_api_v2/db.js` — креды MySQL; `p8/` и JSON сервисных аккаунтов в `calling_api_v2`; TURN-креды в `calling_v2/lib/webrtc-service.ts`; `.env` в `totus_API`.

## 3.5. Как реализована волна 5 (приложение, факты по коду PR)

- `src/modules/api/voipAuth.ts`: `setVoipAccessToken` (App.tsx ← Redux), `getVoipAccessToken` (модульная переменная + fallback чтение `persist:root → auth.accessToken` из AsyncStorage для фоновых сценариев CallKeep), `voipFetch` (Bearer только для `VOIP_BASE_URL`), `voipSocketAuth` (функциональная `auth` для socket.io-client — токен перечитывается на каждом реконнекте). Без импорта store/axios — нет цикла с VoipService.
- `favorites.ts`, `contacts.ts`, `users.ts` — `voipFetch`; `VoipService.ts` — 14 `fetch` → `voipFetch`, `auth: voipSocketAuth` в `io()`, `setVoipAccessToken(null)` при logout (после `unregister-device`, который идёт ещё с токеном).
- `setAuth` сохраняет `refreshToken`; `Verification.tsx` передаёт `accessToken`/`refreshToken` из `/verify`. Найдено: до этого refresh в приложении не работал вообще (`refreshToken` = null, эндпоинта `/customer-auth/refresh-token` не было) — теперь алиас из волны 1 + сохранённый refresh продлевают сессию.
- Открытый вопрос для волны 6: входящий звонок при убитом приложении — `register-device`/`answer` из фонового контекста идут с токеном из AsyncStorage; если в логах voip такие запросы будут без токена, для `enforce` понадобится device-credential или `AUTH_LOG_ONLY_PATHS=/api/register-device,/api/calls`.

## 4. Открытые решения владельца

| # | Вопрос | Влияет на |
|---|---|---|
| S1 | Гости в Миле без токена — да/нет. **Снято с блокировки:** реализовано как настройка `AI_GUEST_ACCESS=1/0` в `.env` totus_ai_v2 (PR #1); решение можно менять без релиза | 2.6, волна 4 |
| S2 | Окно для ротации `JWT_SECRET` (перелогин всех) | волна 2 |
| S3 | Есть ли у агентов что-то кроме email/пароля в `users` | миграция bcrypt, 2.3 |
| S4 | Кто собирает и деплоит; кто делает iOS-сборку для волны 5 | все волны |
| S5 | Тексты экрана входа админки (см. PR Totus_admin#3) — утвердить | 2.5, волна 2 |
