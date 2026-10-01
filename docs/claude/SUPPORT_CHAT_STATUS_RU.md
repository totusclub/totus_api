# Support Chat — статус реализации

**07.09.2026** — план (`claude/SUPPORT_CHAT_PLAN_RU.md`) подтверждён владельцем с уточнениями; все PR открыты, ждут проверки и мержа владельцем. Дизайн — `claude/SUPPORT_CHAT_DESIGN_RU.md`.

## Уточнения владельца к плану

1. Интерфейс поддержки — **панель звонков calling_v2** (calling.totus.club), а не Totus_admin. PR в Totus_admin не открывался.
2. Доступ и управление — только сотрудники поддержки. В панели сотрудник авторизован agent-JWT (`/api/web/login`, `users.role='agent'`), поэтому бэкенд принимает на стороне поддержки роли `agent` и `staff`; роль `user` к диалогам других людей доступа не имеет. Если нужен вход по staff-учёткам (таблица `staff`) и в панель звонков — отдельная правка calling_v2 (сейчас там только agent-вход).
3. Часы работы / пустое состояние — стандартный текст (`SUPPORT_HOURS_TEXT` в `.env` можно переопределить).
4. Миграцию БД запускает владелец. 5. iOS-пуши — не в этом этапе.

## Pull Requests (ветки `claude/support-chat`)

| # | Репо | PR | База | Что внутри |
|---|---|---|---|---|
| 1 | calling_api_v2 | https://github.com/tosmedia/calling_api_v2/pull/5 | `prod` | `lib/supportChat.js` (REST `/api/support/*`, socket `support:*`, комнаты `u:<id>` / `support:staff` / `chat:<id>`, FCM для Android), подключение через `middleware/auth.js` (POLICY-handler + `attachSocket` в `socketGate`; index.js не менялся — файл >60 КБ не проходит через коннектор), `db.js` (+`pool`), `scripts/run-support-chat-migration.js`, `scripts/check-support-chat.js` (в `npm run check`), `lib/env.js`, `.env.example`, `docs/SUPPORT_CHAT_API.md` |
| 2 | calling_v2 | https://github.com/tosmedia/calling_v2/pull/7 | `main` | вкладки «Звонки / Чат поддержки» (`AppHeader`, `AppNav`), `/chat` — список диалогов + переписка (`components/chat/*`), `lib/support-chat-api.ts`, отдельный сокет `lib/support-chat-socket.ts`, `SupportChatProvider` (бейдж, звук, Notification при скрытой вкладке), «Позвонить» → существующий звонок и переход на главную |
| 3 | totus_WEB | https://github.com/tosmedia/totus_WEB/pull/6 | `main` | `pages/profile/support-chat`, `components/support/chat/*`, `api/supportChatApi.ts`, `lib/supportSocket.ts`, срез `supportChat`, `SupportChatGate` в `_app`, пункты в меню ЛК / шапке / нижнем баре с точкой непрочитанного; + зависимость `socket.io-client` |
| 4 | totus_APP | https://github.com/tosmedia/totus_APP/pull/7 | `main` | экран `supportChat` в `AccountStackScreen` (без таб-бара), `component/support/*`, `modules/api/supportChat.ts`, отдельный сокет `modules/support/supportSocket.ts` + `SupportSocketBridge` в App.tsx, срез `supportChat`, строка в «Аккаунте», Android FCM-ветка `support_message` в `CallService.js`; VoipService.ts не тронут |
| 5 | totus_desktop | https://github.com/tosmedia/totus_desktop/pull/1 | `main` | роут `/support-chat`, `screens/support/SupportChatScreen`, `renderer/support/*` (сокет, провайдер, хук), строка в «Аккаунте», бейдж в рейле, системные уведомления Electron |

Отступление от плана: клиенты используют **отдельное socket.io-соединение** для чата (а не шину поверх сокета звонков) — `VoipService.ts` в приложении 190 КБ и не проходит через коннектор; для сервера это безопасно (второй сокет не шлёт `registerDevice`, звонки идут по прежнему сокету). В calling_api_v2 пустые диалоги (созданы `GET /api/support/chat`, без сообщений) в список поддержки не попадают.

## Порядок ввода в строй (владелец)

1. Мерж calling_api_v2 #5 в `prod` → на сервере `git pull && node scripts/run-support-chat-migration.js && pm2 restart api_calling && npm run check`; в логе `[support-chat] ready`.
2. Мерж calling_v2 #7 → `npm install && npm run build && pm2 restart front_calling`; проверить вкладку «Чат поддержки».
3. Мерж totus_WEB #6 → `npm install` (новая зависимость) → `npx tsc --noEmit` → сборка/деплой сайта.
4. Мерж totus_APP #7 → `npx tsc --noEmit`, сборка в TestFlight (iPhone + iPad), Android smoke.
5. Мерж totus_desktop #1 → `npm install && npm run typecheck && npm run dev`.

Во всех фронтах сборка в песочнице не прогонялась (нет npm-реестра) — только синтаксическая проверка tsc; первый `tsc --noEmit`/`build` на месте обязателен.

## Этап 2 (не начат)

iOS-пуши о сообщениях (обычный APNs-токен), вложения, письмо в поддержку при офлайне, объединение с «Обращениями по заказам», оценка диалога, staff-вход в панель звонков.
