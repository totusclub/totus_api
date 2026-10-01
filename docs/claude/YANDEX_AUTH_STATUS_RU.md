# Вход через Яндекс ID — статус

**17.09.2026.** Владелец зарегистрировал приложение на oauth.yandex.ru (тип «веб-сервисы»,
Redirect URI `https://api.totus.club/api/auth/yandex/callback`, права `login:info`, `login:email`,
`login:avatar`) и положил `YANDEX_OAUTH_CLIENT_ID` / `YANDEX_OAUTH_CLIENT_SECRET` в `.env` сервера.
Секреты мне не передавались и не нужны.

## Сделано

| Что | Где | Статус |
|---|---|---|
| План и схема потока | `claude/YANDEX_AUTH_PLAN_RU.md` | готов |
| Макеты Light + Dark (iPhone, iPad, Desktop, Web) | `claude/YANDEX_AUTH_DESIGN_RU.md`, Figma `2165:105678` / `2165:105679` | ждут проверки владельца |
| Серверная часть totus_API | PR #16, ветка `claude/yandex-auth` | ждёт мержа и раскатки |
| Сайт totus_WEB | PR #14, ветка `claude/yandex-auth` | ждёт проверки и мержа |
| Приложение totus_APP | PR #11, ветка `claude/yandex-auth` | ждёт проверки, сборки и мержа |
| Десктоп totus_desktop | PR #5, ветка `claude/yandex-auth` | ждёт проверки, сборки и мержа |

**PR #16** (только новые файлы + `package.json` и `.env.example`; `app.js` не тронут):
`lib/yandexAuth.js`, `controllers/yandexAuth.controller.js`, `routes/yandexAuth.routes.js`,
`scripts/run-yandex-auth-migration.js` (`npm run migrate:yandex-auth`),
`scripts/check-yandex-auth.js` (в `npm run check`), `docs/YANDEX_AUTH_API.md`,
`docs/YANDEX_AUTH_APP_PATCH.md`. Плюс `PATCH /api/auth/me/phone` (strict JWT,
`controllers/profile.controller.js`) — его просит шаг «Почти готово» на всех трёх клиентах.

Эндпоинты: `GET /api/auth/yandex/start`, `GET /api/auth/yandex/callback`,
`POST /api/auth/yandex/exchange` (публичные, общий rate-limit `/api/auth/*`),
`GET /api/auth/yandex/status`, `POST|DELETE /api/auth/yandex/link` (strict JWT).
Пока переменных нет или не прогнана миграция — все отвечают `503 yandex_auth_not_configured`.

## Раскатка (за владельцем)

1. Смержить totus_API #16, `git pull` на сервере.
2. `npm run migrate:yandex-auth` (создаёт `user_identities` и `users.avatar_url`).
3. Строка в `app.js` из `docs/YANDEX_AUTH_APP_PATCH.md`:
   `app.use('/api/auth/yandex', require('./routes/yandexAuth.routes'));`
4. `pm2 restart api`.
5. Проверка: `curl -i "https://api.totus.club/api/auth/yandex/start?client=web&return=/"` → 302 на `oauth.yandex.ru`.

Проверить регистрацию приложения со своей стороны я не могу: `client_id` лежит только в `.env`
сервера, а api.totus.club из моей среды недоступен (исходящие соединения ограничены). Первый живой
тест — шаг 5 после раскатки.

## Клиенты (17.09.2026, написаны)

Везде одинаково: кнопка появляется, только если `/api/auth/yandex/status` отвечает 200/401;
пока раздел выключен (503) — экраны выглядят как раньше.

1. **totus_WEB (PR #14)** — `YandexAuthApi.ts`, кнопка `YandexIdButton` в `signin.tsx`,
   страница `src/pages/auth/yandex.tsx` («Завершаем вход…», «Почти готово», ошибки), стили в
   `auth.module.css` (Light — чёрная кнопка, Dark — белая).
2. **totus_APP (PR #11)** — `modules/api/yandexAuth.ts`, кнопка на `LoginScreen`, системный браузер
   через `Linking.openURL` (новых зависимостей нет), `modules/auth/YandexAuthBridge.tsx` в
   `navigation/index.tsx` ловит `totus://auth/yandex`; схема заведена в `Info.plist`
   (`CFBundleURLTypes`) и `AndroidManifest.xml` (`intent-filter`, `launchMode=singleTask` уже был).
   Схема `totus://` раньше нигде не использовалась — конфликта со звонками нет.
3. **totus_desktop (PR #5)** — `setAsDefaultProtocolClient('totus')`, single-instance lock,
   `open-url` (macOS) / `second-instance` (Windows), придержанная ссылка холодного старта
   (`desktop:take-deep-link`), `onDeepLink`/`takeDeepLink` в preload, кнопка на `LoginScreen`,
   `app/YandexAuthBridge.tsx`, `build.protocols` в `package.json`.

Осталось: обновить `docs/API_DOCUMENTATION_RU.md` (§4.6), `docs/WEB_DOCUMENTATION_RU.md` и
`docs/APP_DOCUMENTATION_RU.md` — сделаю после того, как клиентские PR будут приняты.

**Открытый вопрос:** блокировать ли вход новому пользователю до ввода телефона. Сейчас в макетах
и в ответе `/exchange` (`isNew`, `needsPhone`) — не блокируем, телефон просим на бронировании.

---

## 01.10.2026 — состояние на проде и исправления

- **Развёрнуто:** totus_API #16 и totus_WEB #14 слиты и работают. `/start` → Яндекс; `/callback` и `/exchange` отвечают; `/auth/yandex` открывается. Проверено живыми запросами только на чтение.
- **«Сервис не верифицирован»** на экране согласия — статус приложения в Яндексе, вход не блокирует. Экран появляется только при первом входе аккаунтом или при выборе аккаунта. Убрать: верификация на oauth.yandex.ru (владелец; нужна опубликованная политика ПД).
- **Ошибка `yandex_state_invalid` (JSON на api.totus.club).** Причина: `state` жил 10 минут, страницу Яндекса держали дольше. Исправление — [totus_API #27](https://github.com/tosmedia/totus_API/pull/27): TTL 60 мин; просроченный или чужой `state` → возврат на экран входа с `error=yandex_state_expired` / `yandex_state_invalid`.
- **Зависание «Завершаем вход…».** Защита — [totus_WEB #26](https://github.com/tosmedia/totus_WEB/pull/26): тайм-аут 20 с на обмен ticket и тексты новых ошибок. Корневая причина отсутствия ответа не подтверждена (STATUS D11).
- Приложение и десктоп новые коды показывают общим текстом с «Попробовать снова» — правка не нужна.
