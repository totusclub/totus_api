# Вход через Яндекс ID — API

План и решения: `claude/YANDEX_AUTH_PLAN_RU.md`. Макеты: `claude/YANDEX_AUTH_DESIGN_RU.md`.

Схема: OAuth 2.0 Authorization Code, **код на токен меняет только сервер** — `client_secret`
не покидает totus_API. Клиент получает наши обычные `accessToken` / `refreshToken`
(та же функция, что у `/api/auth/verify`), поэтому интерсепторы, `refresh` и `/api/auth/me`
не меняются. В адресной строке оказывается только одноразовый `ticket` (120 секунд),
сами токены приходят в теле POST-ответа.

## Включение

```
YANDEX_OAUTH_CLIENT_ID=...
YANDEX_OAUTH_CLIENT_SECRET=...
YANDEX_OAUTH_REDIRECT_URI=https://api.totus.club/api/auth/yandex/callback
YANDEX_AUTH_RETURN_WEB=https://totus.club
YANDEX_AUTH_RETURN_APP=totus://auth/yandex
YANDEX_AUTH_RETURN_DESKTOP=totus://auth/yandex
```

Пока переменных нет или не прогнана миграция (`npm run migrate:yandex-auth`), все маршруты
отвечают `503 { "error": "yandex_auth_not_configured", "reason": "env" | "schema" }` — клиенты по этому
ответу прячут кнопку. Для `reason: "env"` в ответе есть `missing` — имена незаполненных переменных
(значений нет). Диагностика на сервере: `npm run check:yandex-env`.
Монтирование роутера — `docs/YANDEX_AUTH_APP_PATCH.md`.

## Эндпоинты

| Метод | Путь | Auth | Назначение |
|---|---|---|---|
| GET | `/api/auth/yandex/start` | public | `?client=web\|app\|desktop&return=/lk&force=1` → 302 на `oauth.yandex.ru/authorize` |
| GET | `/api/auth/yandex/callback` | public | `?code&state` от Яндекса → 302 на клиент с `ticket` |
| POST | `/api/auth/yandex/exchange` | public | `{ ticket }` → токены |
| GET | `/api/auth/yandex/status` | strict JWT (user) | привязан ли Яндекс к текущему аккаунту |
| POST | `/api/auth/yandex/link` | strict JWT (user) | подтвердить привязку по `ticket` |
| DELETE | `/api/auth/yandex/link` | strict JWT (user) | отвязать |
| PATCH | `/api/auth/me/phone` | strict JWT (user) | телефон на шаге «Почти готово» (только РФ, `lib/phone.js`) |

### GET /api/auth/yandex/start

- `client` — `web` (по умолчанию), `app`, `desktop`; неизвестное значение → `web`.
- `return` — **только относительный путь** (`/lk`, `/orders/123`); абсолютные адреса и `//host`
  заменяются на `/` (защита от open redirect).
- `force=1` — `force_confirm=yes`: Яндекс снова показывает экран прав, даже если доступ уже
  подтверждался. Именно так клиенты повторяют вход после `yandex_email_required`: без этого
  Яндекс молча вернёт тот же набор прав и повтор бессмыслен.
- Запрашиваемые права: `login:info login:email login:avatar`.
- `state` — JWT (`JWT_SECRET`, `typ: 'yx_state'`, 10 минут) с клиентом и путём возврата.

### GET /api/auth/yandex/callback

Обмен кода (`POST https://oauth.yandex.ru/token`, Basic `client_id:client_secret`), профиль
(`GET https://login.yandex.ru/info?format=json`, заголовок `Authorization: OAuth <token>`),
поиск/создание пользователя, затем 302:

- `web` → `${YANDEX_AUTH_RETURN_WEB}/auth/yandex?ticket=…&return=…`
- `app` / `desktop` → `${YANDEX_AUTH_RETURN_APP}?ticket=…&return=…`

Почта берётся из `default_email`, иначе — первый непустой адрес из `emails` (оба поля приходят
только с правом `login:email`); адрес приводится к lower/trim. Если почты нет — в лог пишется
реально выданный `scope` из ответа token-эндпоинта, чтобы было видно, отсутствует ли `login:email`.

Ошибки возвращаются туда же параметром `error`: `yandex_access_denied` (отказ на странице Яндекса),
`yandex_email_required` (не выдан доступ к почте), `yandex_code_missing`, `yandex_failed`.
Неверный или просроченный `state` → `400 { "error": "yandex_state_invalid" }` (возвращать некуда).

### Сценарий «почта не выдана»

`yandex_email_required` — не тупик. Клиент показывает экран «Нужен доступ к почте» с двумя выходами:

1. **Разрешить доступ к почте** → `/api/auth/yandex/start?…&force=1` — Яндекс снова покажет экран прав.
2. **Войти по email** — обычный вход кодом из письма (на сайте — возврат на страницу с `?login=1`,
   по которому шапка сама открывает модалку; в приложении и десктопе — экран входа).

### POST /api/auth/yandex/exchange

Запрос: `{ "ticket": "…" }` — ticket одноразовый и живёт 120 секунд.

```json
{
  "auth": true,
  "authToken": "…", "accessToken": "…", "refreshToken": "…",
  "user": { "id": 42, "name": "Иван", "l_name": "Петров", "email": "ivan@yandex.ru", "loyalty_id": "…" },
  "isNew": true,
  "needsPhone": true
}
```

`isNew` — пользователь только что создан; `needsPhone` — в профиле нет телефона.
Клиент по ним показывает шаг «Почти готово» (не блокирующий: вход работает и без телефона).
Ошибки: `400 ticket_required` / `400 ticket_invalid`, `401 unauthorized`.

## Связывание аккаунтов

1. Есть строка `user_identities(provider='yandex', provider_uid)` → вход в её `user_id`
   (смена почты в Яндексе вход не ломает).
2. Иначе — поиск `users` по нормализованному email: нашли → привязываем к существующему
   аккаунту; не нашли → создаём пользователя (`phone = NULL`, `code = NULL`, `loyalty_id` как при обычной
   регистрации) и привязываем.
3. Нет почты в ответе Яндекса → `yandex_email_required` (см. сценарий выше).

Пустые `name` / `l_name` / `avatar_url` дозаполняются из профиля Яндекса; заполненные не перетираются.

`users.access` здесь **не проверяется**: это флаг видимости Totus AI и звонков в приложении,
а не бан — вход по коду из письма его тоже не смотрит.

Капча на этих маршрутах не нужна — робот не пройдёт подтверждение в Яндексе; общий rate-limit
`/api/auth/*` (30 запросов / 15 минут с IP) действует.

## Схема БД

```sql
CREATE TABLE user_identities (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  provider VARCHAR(16) NOT NULL,        -- 'yandex'
  provider_uid VARCHAR(64) NOT NULL,    -- id из login.yandex.ru/info
  email VARCHAR(255) NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NULL,
  UNIQUE KEY uniq_provider_uid (provider, provider_uid),
  KEY idx_user (user_id)
);
ALTER TABLE users ADD COLUMN avatar_url VARCHAR(255) NULL;
```

Таблица общая для будущих провайдеров (VK, Google, Apple) — новой миграции они не потребуют.

## Проверка

`npm run check` включает `scripts/check-yandex-auth.js`: state (подпись, `typ`, срок), одноразовость
ticket'а, нормализацию `client`, отбраковку внешних `return`, запрашиваемые права, `force_confirm`,
разбор почты из ответа Яндекса, адреса возврата и то, что `client_secret` не попадает в ссылку
авторизации. БД и сеть в проверке не участвуют.
