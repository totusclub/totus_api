# TOTUS — повторный аудит безопасности, 21.09.2026

**Режим:** только чтение. Ничего не изменено, ветки/PR/коммиты не создавались.
**Охват:** `totus_API` (main), `calling_api_v2` (prod + main), `calling_v2` (main), `totus_WEB` (main), `Totus_admin` (main), `totus_APP` (main), `totus_desktop` (main), `totus_ai_v2` (main + pkg/ai-assistant).
**Что было раньше:** `SECURITY_AUDIT_SECRETS_RU.md` (Б.1, секреты) и `SECURITY_JWT_PLAN_RU.md` (Б.2–Б.6, JWT). Этот документ — независимая перепроверка по факту кода, а не по статусам тех документов.

---

## 0. Главный вывод

Слой авторизации написан и лежит во всех сервисах, но **он выключен**: `AUTH_MODE` по умолчанию `log` в `totus_API`, `calling_api_v2` и `totus_ai_v2`, а в режиме `log` `requireAuth` пропускает запрос без токена, проверка владельца возвращает «свой», CORS пускает любой Origin. Всё, что ниже помечено «в log-режиме открыто», сейчас доступно анонимно, если на проде не выставлен `enforce`. **Фактические значения переменных на серверах по коду не видны — это первое, что надо проверить.**

Отдельно от этого есть три вещи, которые не зависят от `AUTH_MODE` и опасны прямо сейчас: документы клиентов в git и в открытой статике, подделываемый callback банка и release-подпись Android debug-ключом.

---

## 1. Критично

| # | Где | Проблема |
|---|---|---|
| К1 | `totus_API`: `uploads/orders/*` в репозитории + `app.js:40` | **Документы реальных клиентов в git и в открытой статике.** Проверено лично: в `main` лежат 7 каталогов заказов с PDF — `Авиабилет__010101.pdf`, `Ваучер__010101.pdf`, `Виза.pdf`, `Страховка__010101.pdf`, `agreement_doc.pdf`. `app.use('/uploads', express.static(...))` — без авторизации. Имена предсказуемы (из заголовка документа LT), `order_id` — последовательные номера LT. Паспортные данные, ФИО, маршруты доступны по прямой ссылке и любому, у кого есть доступ к репозиторию. |
| К2 | все бэкенды: `lib/auth.js` / `server/authUser.ts` | **`AUTH_MODE=log` по умолчанию** → весь нестрогий слой авторизации — no-op. Строгими (`strict:true`) сделаны только новые эндпоинты: `/api/auth/me`, телефон, order-requests, rooms, operators, Support Chat, push-хаб. Всё остальное в log-режиме открыто. |
| К3 | `totus_API`: `app.js:1512` `POST /vtb/callback` | **Callback банка без проверки чего-либо.** Ни подписи, ни IP-allowlist, ни сверки суммы. Один POST с `status.value=RECONCILED` помечает чужой заказ оплаченным и шлёт в Level.Travel «оплачено» + письмо клиенту. |
| К4 | `totus_API`: `utils/levelTravelWebhooks.js:62` | **Fallback-литерал `PARTNER_API_KEY = '589e52d7…'`** — проверено лично, на месте. Это ключ проверки входящих webhook'ов LT; он в git-истории. Если на сервере переменная не задана — он и есть действующий. Плюс сравнение через `!==` (не timing-safe) и длины ключей в логах. |
| К5 | `totus_APP`: `android/app/build.gradle` | **Release подписывается debug-ключом** (`signingConfigs.debug`, пароль `android`, `debug.keystore` в репозитории). Любой может собрать вредоносный APK с той же подписью и установить его поверх настоящего вне Google Play. |
| К6 | `calling_api_v2@prod`: `index.js:1346`, `1424`, `1463`, `1493` | **Socket.io: `offer`/`answer`/`ice-candidate`/`registerDevice` не авторизованы вообще** — `socket.data.auth` в обработчиках не читается, `deviceId` берётся из payload. Зная чужой `deviceId` (он отдаётся в `GET /api/calls/:callId`), можно перехватить маршрутизацию звонков жертвы. |

---

## 2. Высокая

**totus_API**
- `routes/authRoutes.js:14` → `GET /api/admin/auth/users` делает `SELECT * FROM users` — наружу уходят `code` (код входа) и `password`.
- `app.js:906, 982` `/client/orders/:order_id` и `/sync` — проверки владельца нет **ни в log, ни в enforce**: IDOR по чужим заказам LT. `auth_token` LT передаётся в query (попадает в access-логи).
- `controllers/auth.controller.js:16,104` — код входа 4 цифры через `Math.random()`, **без TTL и без счётчика попыток**; rate-limit только по IP; капча на `/verify` не проверяется. 9000 вариантов перебираются тривиально.
- `app.js:544` `/vtb/create-order`, `app.js:1440` `/payment/status`, `app.js:1527` `/level_travel/notify-paid` — платёжные, без авторизации.
- `app.js:7` — `rejectUnauthorized: false` для всех вызовов ВТБ (MitM), `app.js:570` — access-token банка в `console.log`.
- `app.js:1603` — общий `requireAuth(['staff'])` на `/api/admin` смонтирован **позже** `/api/admin/auth`, а `POST /api/admin/auth/init` там вообще без guard.

**calling_api_v2 (prod)**
- `/api/calls*` — ноль проверок владельца: `fromLoyaltyId` берётся из тела, подставляется в пуш → звонок от имени кого угодно, включая «Поддержку Totus».
- `/api/ice-servers` — TURN-креды анонимам (в log-режиме), TTL 12 ч.
- `app.set('trust proxy', true)` → rate-limit логина обходится заголовком `X-Forwarded-For`; блокировки аккаунта нет.
- `lib/notifications/devices.js:66,76` — перепривязка чужого push-устройства (`ON DUPLICATE KEY UPDATE user_id`) и отключение чужих устройств (`UPDATE … WHERE device_id = ?` без `user_id`).
- `middleware/auth.js:128` — роль `agent` обходит все проверки владельца и может блокировать любого через `PATCH /api/users/:id/access`, без аудит-лога.

**totus_WEB / Totus_admin**
- `CmsStaticPage.tsx:151` — `dangerouslySetInnerHTML` с HTML из CMS без санитайза → stored XSS на totus.club → кража `auth_token`/`refresh_token` из localStorage.
- `src/api/favoritesApi.ts` — запросы к voip.totus.club **без `Authorization`**, `userId` параметром: чтение и запись чужого избранного.
- `src/api/levelTravelApi.tsx` — `user_id`, `order_id` и **сумма платежа** (`amount.value` в `/vtb/create-order`) приходят с клиента.
- Токены (включая staff-refresh на 30 дней) в `localStorage`; `AuthGuard` админки рендерит children до проверки, а `isStaffAuthenticated()` проверяет лишь наличие объекта в localStorage.
- `src/lib/cmsPage.ts:19` — публичный сайт ходит на `/api/admin/pages` без токена и рассчитывает на ответ.

**totus_ai_v2**
- `AI_GUEST_ACCESS` по умолчанию **разрешает гостей**, rate-limit и лимита размера сообщения нет вообще → аноним через `wss://.../ws/assistant` жжёт бюджет DeepSeek и платные запросы к Level.Travel.
- `/api/logs*`, `/api/logs/sessions`, `/api/schema`, `/api/debug/*` в log-режиме открыты — это журнал реальных диалогов клиентов.
- Токен передаётся в query string WebSocket (`?token=`) → оседает в логах nginx.

**totus_APP / totus_desktop**
- Deep link `totus://auth/yandex?ticket=…` обрабатывается **без `state` и без подтверждения** (и в приложении, и в десктопе): страница с такой ссылкой молча перелогинивает жертву в аккаунт атакующего (login CSRF).
- Токены в AsyncStorage (APP) и localStorage (desktop) без шифрования; Keychain/Keystore/`safeStorage` не используются.
- `electron/main.ts` — `sandbox: false` + `webviewTag: true` без обработчика `will-attach-webview`.

---

## 3. Средняя (сводно)

- **Демо-аккаунт** `test@totus.com` / код `1111` (`auth.controller.js:12`) — вход без письма и без капчи, при отсутствии строки пользователь создаётся. Телефонная верификация — фикция: `const code = 1111`, код нигде не сохраняется и не сверяется.
- **Загрузки:** `image/svg+xml` разрешён в `content.routes.js:36` при выключенном CSP → stored XSS на api.totus.club; `middleware/upload.js` без `limits`; расширение берётся из имени файла клиента.
- **JWT:** `verify` без `algorithms`; access-TTL пользователя 30 дней; refresh stateless на 90 дней без возможности отзыва; в payload — email, телефон, ФИО, loyalty_id; `JWT_SECRET` используется и для токенов, и для OAuth-`state` Яндекса.
- **Логирование ПД и токенов:** `app.js:934` (`auth_token` LT), `authController.js:75` (весь payload), `calling_api_v2` (voipToken, SDP, e-mail), `totus_APP`/`totus_desktop` — `console.log` тел запросов и ответов **в release** (`transform-remove-console` не подключён) → коды входа и токены в `adb logcat`.
- **helmet с выключенным CSP**, отсутствие security-заголовков в обоих Next-приложениях (нет CSP, HSTS, X-Frame-Options → clickjacking админки).
- **Капча отключается сама**, если не задана env-переменная (и на сайте, и на сервере: `yandexSmartCaptcha.js` fail-open при пустом ключе).
- **Яндекс-вход:** `resolveUser` молча связывает Яндекс-аккаунт с существующим пользователем по совпадению e-mail, без подтверждения владения.
- **Rate-limit** покрывает только auth: LT-прокси, платёжные маршруты, webhooks, TTS и ИИ-эндпоинты (платные) — без лимита.
- **`/api/users/by-id/:id`, `/api/users/search/:loyaltyId`** (voip) — без сверки с токеном: перебор = выгрузка ПД.
- **WebView капчи в APP:** `originWhitelist={['*']}`, `mixedContentMode="always"`, общие cookies totus.club.
- **Нет certificate pinning**, `enableProguardInReleaseBuilds = false`.
- **`package-lock.json` в `.gitignore`** у totus_API, нет lock-файла у Totus_admin → невоспроизводимые сборки и невозможность `npm audit`.
- **Мусор в зависимостях totus_WEB:** `"npm": "^11.4.0"` и `"i": "^0.3.7"` в runtime-зависимостях.
- **ПД клиента уходят в DeepSeek** без уведомления и без маскировки; косвенная промпт-инъекция через тексты отзывов отелей.

---

## 4. Организационное

- **GitHub Advanced Security по-прежнему выключен** — ни secret scanning, ни push protection.
- **Ветки `main` не защищены** ни в одном репозитории (`protected: false`), required review нет.
- **Открытых PR по безопасности нет** ни в одном репозитории — всё, что не смержено, лежит в ветках `claude/*` без ревью.
- **Ротация ключей из `SECURITY_AUDIT_SECRETS_RU.md` §3 — статус неизвестен.** Удаление из веток не отменяет утечку: PAT, APNs `.p8`, GCP/Firebase JSON, креды MySQL, DeepSeek, TURN остаются в истории git. Проверить историю из этой среды не удалось (`git clone` к github.com заблокирован сетевой политикой) — **нужен локальный прогон `gitleaks`/`trufflehog` по всей истории всех репозиториев**.

---

## 5. Что проверено и выглядит нормально

- **SQL-инъекций не найдено нигде** — везде плейсхолдеры; три места динамической сборки SQL проверены построчно и безопасны.
- **Вход через Яндекс ID реализован грамотно:** подписанный `state` с nonce и TTL 10 мин, одноразовый `ticket` из CSPRNG на 120 с, защита от open redirect с двух сторон, обмен кода только на сервере, `client_secret` не покидает backend, модуль fail-closed (503) без env или миграции.
- **GitHub PAT из `totus_WEB/package.json` убран** (в HEAD чисто; в истории остаётся).
- **TURN-креды из клиентского бандла `calling_v2` убраны**, ICE приходит с бэкенда.
- **Секреты-литералы вычищены** из `calling_api_v2` (обе ветки), `totus_APP`, `calling_v2`; в `totus_API` остался ровно один (К4). `.env` нигде не закоммичен, `.gitignore` корректны.
- **Support Chat и push-хаб** (`calling_api_v2`) сделаны правильно: всё strict, отправитель из токена, rate-limit, идемпотентность — на них `AUTH_MODE` не влияет.
- **Push нельзя отправить на чужое устройство** через API: `voipToken` всегда читается из БД по `loyaltyId`, `/internal/notify` защищён ключом со сравнением в константное время.
- **`preload.ts` десктопа минимален**, `openExternal` отфильтрован по схемам, `will-navigate` блокирует уход окна, перехват `https` в captcha-сессии узкий, проверка сертификатов не отключена, single-instance работает.
- **Bearer не утекает на сторонние домены** в APP (`isVoipUrl`), `calling_v2` и, с оговоркой (префиксная проверка вместо origin), в `totus_WEB`/`Totus_admin`.
- **Привязка чатов Милы к пользователю корректна** — гость не может прочитать чужие чаты.
- **Хэширование паролей** — bcrypt везде, с ленивой миграцией plaintext.
- **Демо-аккаунта и фиксированных кодов в клиентах нет** — только на сервере.

---

## 6. Предлагаемый порядок исправления (ждёт подтверждения владельца)

**Немедленно, без обсуждения объёма:**
1. Убрать `uploads/orders/**` из репозитория и из `express.static`, отдавать документы через авторизованный контроллер с проверкой владельца; файлы считать скомпрометированными (К1).
2. Проверить `AUTH_MODE` на всех трёх серверах; если `log` — спланировать переход в `enforce` (К2).
3. Закрыть `/vtb/callback` подписью/IP-allowlist и сверкой суммы (К3).
4. Ротировать `PARTNER_API_KEY` у Level.Travel и убрать литерал (К4).
5. Отдельный release-keystore для Android (К5).

**Волна 1 (сервер):** owner-проверки в `/client/orders/*` и `/api/calls*`, закрыть платёжные эндпоинты, `SELECT *` → белый список колонок, код входа 6 цифр из `crypto.randomInt` + TTL + счётчик попыток + капча на `/verify`, убрать `rejectUnauthorized:false` и логи с токенами, авторизация Socket.io по токену.

**Волна 2 (клиенты):** санитайз CMS-HTML, `favoritesApi` на Bearer, `state` для deep link в APP и desktop, убрать `console.log` тел запросов из release, токены в Keychain/`safeStorage`, security-заголовки в обоих Next-приложениях.

**Волна 3 (гигиена):** CSP, запрет SVG в загрузках, лимиты multer, `algorithms` в `jwt.verify`, сокращение TTL и возможность отзыва refresh, глобальный rate-limit, `AI_GUEST_ACCESS=0` + лимиты Милы, удаление демо-аккаунта, lock-файлы, GitHub Advanced Security + branch protection, прогон `gitleaks` по истории.

---

## 7. Чего этот аудит не покрыл

- Фактические значения env на прод-серверах (`AUTH_MODE`, `CORS_ORIGINS`, `PARTNER_API_KEY`, `AI_GUEST_ACCESS`) — в репозиториях их нет.
- Конфигурация nginx перед приложениями (часть маршрутов может быть закрыта там).
- История git всех репозиториев на остатки секретов — клонирование из этой среды заблокировано; нужен локальный `gitleaks`/`trufflehog`.
- Крупные файлы, прочитанные фрагментарно: `totus_APP/src/modules/voip/VoipService.ts` (190 КБ), `totus_ai_v2/server/levelTravel.ts` (72 КБ), `Totus_admin/lib/rooms-api.ts`, `controllers/customRooms.controller.js`.
- Динамическое тестирование (реальные запросы к прод-эндпоинтам) — из этой среды `api.totus.club` недоступен.
