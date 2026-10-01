# Авторизация через Яндекс ID — технический план

**Статус:** 17.09.2026 — план на проверку владельца. Код не пишется до утверждения макетов (правило проекта: видимые изменения UI сначала в дизайне).
**Решения владельца:** площадки — сайт, приложение, десктоп (админка не входит); связывание — по email (тот же email → тот же аккаунт); приложение в Яндекс OAuth ещё не зарегистрировано; порядок — сначала макет в Figma.

Связанные документы: `docs/API_DOCUMENTATION_RU.md` §4.6, `claude/SECURITY_JWT_PLAN_RU.md`, `docs/APP_DOCUMENTATION_RU.md`, `docs/WEB_DOCUMENTATION_RU.md`, `claude/DESKTOP_DESIGN_RU.md`.

---

## 0. Что есть сейчас (по коду, 17.09.2026)

| Где | Факт |
|---|---|
| totus_API | `POST /api/auth/signup` → 4-значный код на email (Yandex Postbox) + SmartCaptcha; `POST /api/auth/signin` (тот же код существующему email, `screen: SIGNUP` если пользователя нет); `POST /api/auth/verify` → `issueUserTokens()` = `{ auth, authToken, accessToken, refreshToken }`; `GET /api/auth/me`; `POST /api/auth/refresh` (stateless). Паролей у пользователей нет. Токены: access `JWT_SECRET`/`USER_ACCESS_TTL` (сейчас 30 д), refresh `JWT_REFRESH_SECRET`/90 д. `lib/auth.js`: `signUserToken`, `signRefreshToken`, `requireAuth`, `publicUser`. Rate-limit 30/15 мин на `/api/auth/*`. |
| Таблица `users` | `id, name, f_name, l_name, email, phone, code, loyalty_id, password (только агенты), role, access, voipToken, date`. `loyalty_id` выдаёт `utils/loyaltyGenerator.generateUniqueLoyaltyId()`. |
| totus_WEB | `AuthModal` (модалка 450 px, экраны `AUTH → VERIFICATION → SIGNUP`), `src/api/AuthApi.tsx`, токены в `localStorage` (`auth_token`, `refresh_token`), Bearer подставляет интерсептор `src/api/http.ts`. |
| totus_APP | `src/screens/auth/{LoginScreen, SignupScreen, VerificationScreen}.tsx`, Redux `loginUser`, SmartCaptcha на экране входа. |
| totus_desktop | `src/renderer/screens/auth/{LoginScreen, SignupScreen, VerificationScreen}.tsx` — та же схема через `api.totus.club`. |
| Totus_admin | Отдельный вход сотрудников (`staff`) — **в этой задаче не трогаем**. |

---

## 1. Что именно делаем

OAuth 2.0 Authorization Code, **обмен кода на токен делает только сервер** (`client_secret` не покидает totus_API). Клиенты (сайт, приложение, десктоп) никогда не видят токен Яндекса — они получают наши обычные `accessToken`/`refreshToken`, поэтому весь остальной код (интерсепторы, refresh, `GET /api/auth/me`) остаётся без изменений.

```
клиент                         totus_API                     Яндекс
  │ «Войти с Яндекс ID»          │                             │
  ├─ открыть /api/auth/yandex/start?client=web&return=/lk ─────►│
  │                              ├─ state (подпись, 10 мин) ───►│ 302 oauth.yandex.ru/authorize
  │                              │                              │  пользователь подтверждает
  │◄──────────────── 302 /api/auth/yandex/callback?code&state ──┤
  │                              ├─ POST oauth.yandex.ru/token ►│  (Basic client_id:secret)
  │                              ├─ GET login.yandex.ru/info ──►│  (Authorization: OAuth …)
  │                              ├─ найти/создать users, выпустить наши JWT
  │◄─ 302 на сайт/deep link с одноразовым ticket (120 c) ───────┤
  ├─ POST /api/auth/yandex/exchange { ticket } ────────────────►│
  │◄─ { auth, authToken, accessToken, refreshToken, user, isNew }│
```

**Почему ticket, а не токены в URL:** правило проекта — ПД и секреты не кладём в query. В адресе оказывается только одноразовая строка со сроком жизни 120 секунд, которая обменивается один раз; сами JWT приходят в теле POST-ответа.

---

## 2. Что нужно от владельца: регистрация приложения на oauth.yandex.ru

1. Открыть **oauth.yandex.ru** под рабочим аккаунтом Яндекса (тем же, где Postbox и SmartCaptcha) → «Создать приложение».
2. Название: **Totus Club**, иконка — логотип, описание — «Онлайн-бронирование туров и отелей».
3. Тип — **приложение для авторизации** (даёт группу прав `login:*`). Тип после создания не меняется.
4. Платформа — **«Веб-сервисы»**, Redirect URI:
   - `https://api.totus.club/api/auth/yandex/callback` (прод);
   - `http://localhost:3001/api/auth/yandex/callback` (разработка, если Яндекс разрешит второй адрес).
   Отдельные платформы для iOS/Android/десктопа **не нужны**: все клиенты возвращаются на этот же серверный адрес, а дальше сервер уводит пользователя в приложение по deep link.
5. Права (раздел «Яндекс ID»):
   - «Доступ к логину, имени и фамилии, полу» — `login:info`;
   - «Доступ к адресу электронной почты» — `login:email` (обязательно, по нему связываем аккаунты);
   - «Доступ к портрету пользователя» — `login:avatar` (не обязательно, нужно только если хотим аватар в ЛК).
   Номер телефона (`login:default_phone`) **не запрашиваем**: пользователи чаще отказываются, а телефон нам всё равно нужен подтверждённый — спросим сами на шаге брони.
6. Скопировать **ClientID** и **Client secret** и положить на сервер в `.env` totus_API (мне их присылать не нужно):
   ```
   YANDEX_OAUTH_CLIENT_ID=...
   YANDEX_OAUTH_CLIENT_SECRET=...
   YANDEX_OAUTH_REDIRECT_URI=https://api.totus.club/api/auth/yandex/callback
   YANDEX_AUTH_RETURN_WEB=https://totus.club
   YANDEX_AUTH_RETURN_APP=totus://auth/yandex
   YANDEX_AUTH_RETURN_DESKTOP=totus://auth/yandex
   ```
   Пока переменных нет — раздел выключен: `/api/auth/yandex/*` отвечает `503 { error: 'yandex_auth_not_configured' }`, кнопка на клиентах не показывается. Ничего из текущего входа не ломается.

---

## 3. База данных

Новая таблица вместо колонок в `users` — чтобы завтра добавить VK/Google/Apple без новой миграции:

```sql
CREATE TABLE IF NOT EXISTS user_identities (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  user_id       INT NOT NULL,
  provider      VARCHAR(16)  NOT NULL,          -- 'yandex'
  provider_uid  VARCHAR(64)  NOT NULL,          -- id из login.yandex.ru/info
  email         VARCHAR(255) NULL,              -- email на момент привязки
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NULL,
  UNIQUE KEY uniq_provider_uid (provider, provider_uid),
  KEY idx_user (user_id)
);
```

Плюс одна необязательная колонка: `ALTER TABLE users ADD COLUMN avatar_url VARCHAR(255) NULL` (портрет из Яндекса, если дали право). Миграция — идемпотентный скрипт `scripts/run-yandex-auth-migration.js` + `npm run migrate:yandex-auth`, как остальные миграции проекта. До миграции модуль сам себя выключает (проверка таблицы при старте, как в custom rooms).

---

## 4. Логика связывания аккаунтов

По ответу `login.yandex.ru/info`: `id`, `default_email`, `first_name`, `last_name`, `login`, `default_avatar_id`.

1. Есть строка в `user_identities` с этим `provider_uid` → вход в её `user_id`. (Email в Яндексе могли сменить — связь по `id`, не по почте.)
2. Иначе ищем `users` по нормализованному `default_email` (lower/trim, как в `auth.controller.js`):
   - нашли → привязываем `user_identities` к существующему пользователю, входим в него; недостающие `name`/`l_name` дозаполняем из Яндекса, уже заполненные не перезаписываем;
   - не нашли → создаём пользователя: `email`, `name = first_name`, `l_name = last_name`, `phone = NULL`, `code = NULL`, `loyalty_id = generateUniqueLoyaltyId()`; затем привязка.
3. Нет `default_email` (право не выдано) → `400 { error: 'yandex_email_required' }`, на клиенте — «Разрешите доступ к адресу почты — он нужен для входа».
4. `users.access = 1` (заблокирован) → `403`.
5. Ответ помечается `isNew: true` для новых пользователей — клиент показывает шаг «добавьте телефон» (не блокирующий: телефон нужен на бронировании, вход работает и без него).

Капча на этом маршруте не нужна — робот не пройдёт подтверждение в Яндексе.

---

## 5. Эндпоинты totus_API (`routes/yandexAuth.routes.js` + `controllers/yandexAuth.controller.js`)

| Метод | Путь | Auth | Назначение |
|---|---|---|---|
| GET | `/api/auth/yandex/start` | public | `?client=web\|app\|desktop&return=<относительный путь>` → 302 на `https://oauth.yandex.ru/authorize?response_type=code&client_id=…&redirect_uri=…&scope=login:info login:email login:avatar&state=…&force_confirm=no` |
| GET | `/api/auth/yandex/callback` | public | `?code&state` → обмен кода (`POST https://oauth.yandex.ru/token`, Basic `client_id:client_secret`, `grant_type=authorization_code`), профиль (`GET https://login.yandex.ru/info?format=json`, заголовок `Authorization: OAuth <token>`), поиск/создание пользователя, 302 с одноразовым `ticket` |
| POST | `/api/auth/yandex/exchange` | public | `{ ticket }` → `{ auth: true, authToken, accessToken, refreshToken, user, isNew }` (тот же `issueUserTokens`, что и `/verify`) |
| POST | `/api/auth/yandex/link` | `requireAuth(['user'], { strict: true })` | Этап 2: привязать Яндекс к уже открытой сессии из ЛК |
| DELETE | `/api/auth/yandex/link` | `requireAuth(['user'], { strict: true })` | Этап 2: отвязать (запрещаем, если это единственный способ входа) |

Правило владельца соблюдено: новые эндпоинты `/link` сразу strict-JWT; публичные — только те, что по природе публичные (как `signin`/`verify`), и все под общим rate-limit `/api/auth/*`.

**state** — подписанный `JWT_SECRET` компактный токен, TTL 10 минут: `{ c: client, r: return, n: nonce, typ: 'yx_state' }`. На callback проверяем подпись, TTL и `typ`; чужой/просроченный → `400 yandex_state_invalid`.

**ticket** — случайные 32 байта, лежат в памяти процесса (`Map` + TTL 120 с, одноразовые): `ticket → { userId, isNew, createdAt }`. Процесс один (pm2), перезапуск просто аннулирует незавершённые входы — пользователь нажмёт «Войти» ещё раз.

**Куда редиректим с callback:**
- `web` → `${YANDEX_AUTH_RETURN_WEB}/auth/yandex?ticket=…` (страница-обменник, затем возврат на `return`);
- `app` / `desktop` → `${YANDEX_AUTH_RETURN_APP}?ticket=…` (deep link `totus://auth/yandex`).
`return` принимаем **только как относительный путь** (`/lk`, `/orders/123`); абсолютные URL и `//host` отбрасываем — защита от open redirect.

---

## 6. Клиенты

### 6.1 Сайт (totus_WEB)
- В `AuthModal`, экран `AUTH`: кнопка **«Войти с Яндекс ID»** над полем email + разделитель «или по почте».
- Клик → `window.location.href = ${API_BASE_URL}/api/auth/yandex/start?client=web&return=${encodeURIComponent(pathname)}`.
- Новая страница `/auth/yandex`: читает `ticket`, шлёт `POST /api/auth/yandex/exchange`, сохраняет токены (`saveToken` / `saveRefreshToken` из `src/utils/auth.tsx`), редиректит на `return`. При ошибке — модалка входа с текстом ошибки.
- `isNew: true` → мягкий шаг «Добавьте телефон» в ЛК.

### 6.2 Приложение (totus_APP)
- Кнопка на `LoginScreen` (и на `SignupScreen`) под капчей.
- Открытие в системном браузере: iOS `SFSafariViewController`, Android Custom Tabs (`react-native-inappbrowser-reborn` — единственная новая зависимость; если не хотим новых пакетов, fallback `Linking.openURL`).
- Возврат — deep link `totus://auth/yandex?ticket=…`: обработчик в существующем `Linking`-слушателе → `exchange` → тот же redux-экшен, что после `verify`.
- Схему `totus://` нужно подтвердить/добавить в `Info.plist` (`CFBundleURLTypes`) и `AndroidManifest.xml` (`intent-filter`) — проверю при реализации; если схема уже занята под звонки, возьмём `totusclub://`.
- Вход через установленное приложение Яндекса (Яндекс ID SDK) — **этап 2**, отдельной задачей: это нативная зависимость и отдельный релиз.

### 6.3 Десктоп (totus_desktop)
- Кнопка на `LoginScreen` → `shell.openExternal(startUrl)` (вход всегда во внешнем браузере — правило Яндекса и безопаснее, чем окно Electron).
- Возврат: `app.setAsDefaultProtocolClient('totus')` + обработка `open-url` (macOS) / второго инстанса (Windows) → передать `ticket` в renderer по IPC → `exchange`.

---

## 7. Дизайн (следующий шаг, до кода)

Макеты в Figma: экран/модалка входа сайта, приложения и десктопа с кнопкой «Войти с Яндекс ID», состояние ошибки («не выдан доступ к почте»), шаг «Добавьте телефон» для нового пользователя — светлая и тёмная темы. Кнопка — по фирменным правилам Яндекса (фирменный красный `#FC3F1D` либо чёрная/белая, логотип слева, подпись «Войти с Яндекс ID», высота как у существующей `AppButton size=large`). Утверждение владельцем → только потом код.

---

## 8. Порядок работ

1. Владелец регистрирует приложение на oauth.yandex.ru и кладёт `client_id`/`client_secret` в `.env` сервера (§2).
2. Макеты в Figma → утверждение.
3. totus_API: миграция + контроллер + маршруты + `npm run check` (PR).
4. totus_WEB → totus_APP → totus_desktop (отдельные PR, каждый работает сам по себе — кнопка прячется, если `/api/auth/yandex/start` отвечает 503).
5. Обновить `docs/API_DOCUMENTATION_RU.md` (§4.6) и `docs/APP_DOCUMENTATION_RU.md`.

## 9. Риски и решения

| Риск | Решение |
|---|---|
| Чужой email в Яндексе | Яндекс отдаёт только подтверждённый адрес аккаунта; связываем по нему и фиксируем `provider_uid` — дальше вход не зависит от смены почты |
| Open redirect через `return` | Принимаем только относительные пути, deep link берём из `.env`, не из запроса |
| Перехват ticket | 120 секунд, одноразовый, обменивается по HTTPS POST; сами JWT в URL не попадают |
| Пользователь без телефона | Вход разрешаем, телефон просим на бронировании (`isNew` + подсказка в ЛК) |
| Секрет в репозитории | `client_secret` только в `.env` сервера; в коде — `process.env`, в логах — никогда |
| Старые версии приложения | Ничего не ломается: новые маршруты не трогают `signin/verify/refresh` |
