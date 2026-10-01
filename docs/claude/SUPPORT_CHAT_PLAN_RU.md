# Support Chat — технический план интеграции во всю платформу

**Статус:** 07.09.2026 — план на проверку владельца. Код не пишется до подтверждения. Дизайн экранов — `claude/SUPPORT_CHAT_DESIGN_RU.md` (Figma «SUPPORT CHAT · Light / Dark»).

## 0. Что изучено (по коду репозиториев, ветки main / prod)

| Репо | Что важно для чата |
|---|---|
| **calling_api_v2** (prod, voip.totus.club:4444) | Express + socket.io в одном процессе; JWT-гейт `httpGate` (таблица POLICY) и `socketGate` (токен из `handshake.auth.token`), роли `user / agent / staff`, `AUTH_MODE=log`; `requireAuth(roles, {strict:true})` работает и в log-режиме. MySQL `kedam` через `mysql2` pool (pool не экспортируется из `db.js`). Звонки — только in-memory (`devices`, `deviceSockets`, `loyaltyIdToDeviceId`: одно устройство на пользователя), никаких таблиц сообщений нет. Push: APNs только VoIP (PushKit-токен, для обычных уведомлений непригоден), FCM — обычный токен (можно слать notification). Почты нет. CORS-whitelist уже содержит admin.totus.club и calling.totus.club. |
| **totus_API** (api.totus.club) | Эмитент всех JWT (общий `JWT_SECRET`): user `{id, loyalty_id, role, scope:'user'}`, staff `{id, email, scope:'staff'}` (таблица `staff`: id, email, name, lastname, role). Паттерн «Обращения по заказам»: таблица `order_requests`, staff-роуты `/api/admin/order-requests`, письмо в поддержку через Yandex Postbox (`utils/yandexCloudEmail.js`). Миграции — ad-hoc скрипты `scripts/run-*-migration.js` с `CREATE TABLE IF NOT EXISTS`. Загрузка файлов — только staff (`/api/content/upload`). |
| **Totus_admin** (admin.totus.club:3009) | Next 14 App Router, inline-стили через `lib/theme.ts`, staff-JWT в `localStorage.staffAuth`, глобальный `window.fetch`-враппер с Bearer для api и voip хостов. Навигация — массив `LINKS` в `components/AdminNav.tsx`; **раздела звонков внутри нет** — пункт «Звонки» это внешняя ссылка на calling.totus.club. `socket.io-client` в зависимостях есть, но не используется; `CLAUDE.md` репо запрещает socket/WebRTC-логику (правило 3 — нужно уточнить: «socket только для чата поддержки»). Паттерн списка с фильтрами и поллингом 60 с — `app/order-requests/page.tsx`. |
| **calling_v2** (calling.totus.club:3008) | Панель агента: одна страница `app/page.tsx` (пользователи, «Позвонить», CallModal), навигации нет; собственный сокет в `lib/webrtc-service.ts` (не экспортируется), agent-JWT в handshake. |
| **totus_WEB** (totus.club) | Next 15 Pages Router, Redux, axios-интерцептор ставит Bearer только на api.totus.club (на voip — ручной `authHeaders()` как в `orderRequestsApi.ts`); ЛК: `pages/profile/*`, меню `components/profile/menu.tsx` (статический список), `HeaderProfileMenu`, `mobileBottomBar`; глобальный виджет по образцу `GlobalAiChat.tsx`; **socket.io-client нет**. Ветка `cahts` — групповой мессенджер на моках (11.2025): переиспользовать только `utils.ts` (группировка по датам) и рендер пузырей. |
| **totus_APP** (RN 0.79) | `Account.tsx` — карточки настроек, «Звонок в поддержку» → `CallSupportModal` → `startOutgoingVoiceCallByLoyaltyId`; стек `AccountStackScreen`; таб-бар скрывается по `SCREENS_WITHOUT_TAB_BAR` (authStack.tsx) **и** `ROOT_SCREENS_WITHOUT_TAB_BAR` (useHasBottomTabBar.ts). Сокет в `VoipService.ts` приватный (`socket`, `ensureSocketConnected` не экспортируются), `voipFetch` / `voipSocketAuth` — в `modules/api/voipAuth.ts`. iOS регистрирует только PushKit-токен; Android — FCM-токен, фоновые сообщения не-звонки игнорируются в `CallService.js`. |
| **totus_desktop** (Electron) | Копия слоя totus_APP; `renderer/voip/VoipClient.ts` — свой сокет (после последних правок регистрируется как web-клиент), `VoipManager` держит соединение на всех экранах. |

## 1. Архитектурные решения

1. **Бэкенд чата — в `calling_api_v2`** (voip.totus.club), как модуль `lib/supportChat.js`. Причины: там уже есть socket.io с JWT-гейтом, к нему уже ходят приложение, сайт (favorites), десктоп, панель агента и админка; звонки и чат — один realtime-сервис («связь с поддержкой»). `totus_API` остаётся эмитентом токенов и сервисом почты. Альтернатива «чат в totus_API» отвергнута: пришлось бы поднимать второй socket.io и второй набор соединений на всех клиентах.
2. **Хранение — MySQL `kedam`** (в отличие от звонков, которые in-memory): таблицы `support_chats` и `support_messages` (DDL в §3). Миграция — скрипт `scripts/run-support-chat-migration.js` (запускает владелец на сервере), модуль при старте проверяет наличие таблиц и пишет понятную ошибку.
3. **Один диалог на пользователя** (`support_chats.user_id` уникален среди открытых): пользователь всегда видит «свой чат с поддержкой», закрытый диалог переоткрывается новым сообщением. История хранится вся. Позже можно добавить темы/несколько обращений без миграции данных (поле `status` + `subject`).
4. **Транспорт:** тот же socket.io-namespace, события с префиксом `support:*`, доставка через **комнаты** (`u:<userId>`, `support:agents`, `chat:<id>`), в которые сокет входит по JWT при подключении. Комнаты решают ограничение «одно устройство на пользователя» из логики звонков (телефон + сайт + десктоп получают сообщения одновременно) и **не трогают** карты `devices / deviceSockets / loyaltyIdToDeviceId` — сигнализация звонков остаётся как есть. REST дублирует всё, что делает сокет (история, отправка, прочтение) — сокет только ускоряет доставку, поэтому потеря соединения ничего не ломает.
5. **Авторизация:** все `/api/support/*` монтируются с `requireAuth([...], {strict:true})` — защищены даже в `AUTH_MODE=log` (правило владельца: новые эндпоинты сразу с JWT). Личность (user_id / staff_id) берётся только из токена, никогда из тела запроса. Сторона поддержки — роли `staff` (админка) и `agent` (панель звонков).
6. **Интерфейс сотрудников — `Totus_admin`** (admin.totus.club), новый раздел «Чат поддержки» рядом с «Звонки» (внешняя ссылка на calling.totus.club). Realtime в админке — через `socket.io-client` (уже в зависимостях) со staff-JWT; ограничение `CLAUDE.md` репо уточняем: «сокет допустим только для чата поддержки, WebRTC/звонки по-прежнему в calling_v2». Кнопка «Позвонить» в чате админки ведёт в панель звонков deep-link'ом (`https://calling.totus.club/?call=<loyaltyId>`; в calling_v2 — небольшая правка, читающая параметр).
7. **Клиенты пользователя:** сайт (ЛК → «Чат с поддержкой», desktop и mobile), приложение iPhone/iPad (экран в стеке «Аккаунт»), desktop-приложение. Везде — по утверждённым макетам, вход из «Аккаунта / ЛК». В приложении и десктопе чат **переиспользует существующий сокет звонков** (добавляем экспортируемую шину `subscribeSocketEvent / emitSocketEvent` в VoipService / VoipClient), чтобы не держать второе соединение и не дублировать `registerDevice`.
8. **Уведомления (этап 1):** realtime + счётчики непрочитанного (бейдж в меню админки и на строке «Чат с поддержкой» у пользователя), звук/Notification API в открытой вкладке админки, Android — FCM-уведомление по существующему токену. **iOS-пуш о сообщении невозможен без нового APNs-токена** (в приложении зарегистрирован только PushKit VoIP-токен) — это этап 2 (см. §7). Письмо в поддержку о новом обращении при офлайне всех сотрудников — этап 2 через totus_API (Postbox).
9. **Безопасность контента:** только текст (≤ 4000 символов), экранирование при рендере, лимит 30 сообщений/мин на пользователя, вложения — этап 2 (нужен пользовательский upload-роут, сейчас загрузка только staff).

## 2. Схема взаимодействия

```
 totus_WEB (ЛК)        totus_APP (iPhone/iPad)     totus_desktop
      │ REST + socket (user JWT)  │ существующий сокет  │ существующий сокет
      └──────────────┬────────────┴─────────────────────┘
                     ▼
        calling_api_v2  /api/support/*  +  socket support:*  (комнаты u:<id>, support:agents, chat:<id>)
                     │ MySQL kedam: support_chats, support_messages (+ users, staff для имён)
      ┌──────────────┴────────────┐
      ▼                           ▼
 Totus_admin «Чат поддержки»   calling_v2 (deep-link на звонок; UI чата — по желанию, этап 2)
 (staff JWT, socket + REST)
```

## 3. Backend (`calling_api_v2`, PR в `prod`)

**Файлы:** `lib/supportChat.js` (сервис + роуты + сокет), `scripts/run-support-chat-migration.js`, правки: `db.js` (экспорт `pool`), `index.js` (+3 строки: require, `attachSocket(socket, io)` в `io.on('connection')`, `mountRoutes(app)`), `middleware/auth.js` (строки POLICY для `/api/support` — для самодокументирования), `lib/env.js` (`SUPPORT_CHAT_RATE_LIMIT`, `SUPPORT_HOURS_TEXT`), `.env.example`, `README`.

**DDL**
```sql
CREATE TABLE IF NOT EXISTS support_chats (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  status ENUM('open','pending','closed') NOT NULL DEFAULT 'open',   -- open: ждёт ответа поддержки, pending: ждёт пользователя, closed
  assigned_staff_id INT NULL, assigned_agent_id INT NULL,
  subject VARCHAR(255) NULL, order_id VARCHAR(64) NULL,
  last_message_id BIGINT NULL, last_message_at DATETIME NULL, last_message_preview VARCHAR(255) NULL,
  user_unread INT NOT NULL DEFAULT 0, staff_unread INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_user (user_id), KEY idx_status_last (status, last_message_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS support_messages (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  chat_id INT NOT NULL,
  sender_role ENUM('user','staff','agent','system') NOT NULL,
  sender_id INT NOT NULL,                       -- users.id или staff.id по sender_role
  sender_name VARCHAR(128) NULL,                -- снимок имени на момент отправки (для истории)
  body TEXT NOT NULL,
  meta JSON NULL,                               -- {orderId} — карточка заказа; позже вложения
  client_msg_id VARCHAR(64) NULL,               -- идемпотентность с мобильных
  read_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_chat_id (chat_id, id), UNIQUE KEY uq_client (chat_id, client_msg_id),
  CONSTRAINT fk_sm_chat FOREIGN KEY (chat_id) REFERENCES support_chats(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
```

**REST (Bearer обязателен, strict)**

| Кто | Метод | Путь | Что |
|---|---|---|---|
| user | GET | `/api/support/chat` | получить (или создать пустой) свой чат: `{chat, messages: последние 50, hours: {open:'09:00', close:'21:00', tz:'MSK', online: bool}}` |
| user | GET | `/api/support/chat/messages?before=<id>&limit=50` | пагинация истории вверх |
| user | POST | `/api/support/chat/messages` `{body, clientMsgId?, meta?:{orderId}}` | отправить (→ 201 `{message}`), переоткрывает closed |
| user | POST | `/api/support/chat/read` `{lastMessageId}` | прочитано |
| staff/agent | GET | `/api/support/chats?status=open|pending|closed|all&q=&limit=&offset=` | список диалогов с `user {id, name, email, phone, loyaltyId, online}`, unread, превью |
| staff/agent | GET | `/api/support/chats/:id` + `/messages?before&limit` | диалог и история |
| staff/agent | POST | `/api/support/chats/:id/messages` `{body}` | ответ (sender = staff/agent из токена, имя из `staff`/`users`) |
| staff/agent | POST | `/api/support/chats/:id/read` · `/assign` `{staffId?}` · `/status` `{status}` | прочитано / взять себе / закрыть-переоткрыть |
| staff/agent | GET | `/api/support/summary` | `{openCount, unreadTotal}` для бейджа навигации |

Ошибки в формате репо: `{error:'body_required'|'message_too_long'|'rate_limited'|'chat_not_found'|'forbidden'}`.

**Socket (тот же namespace; личность — `socket.data.auth` из `socketGate`)**

- При `connection`: `user/agent` → `join('u:'+auth.id)`; `staff/agent` → `join('support:agents')`. Без токена (старое приложение в log-режиме) — комнаты нет, доставка только через REST-поллинг/повторный GET при открытии экрана.
- Клиент → сервер: `support:send {chatId?, body, clientMsgId, meta}` (ack `{ok, message}`), `support:typing {chatId, typing}`, `support:read {chatId, lastMessageId}`, staff: `support:subscribe {chatId}` / `support:unsubscribe`.
- Сервер → клиент: `support:message {chat, message}` → в `u:<userId>`, `support:agents`, `chat:<id>`; `support:chat-updated {chatId, status, assigned, unread}`; `support:typing`; `support:read`.
- Одна функция `sendMessage()` обслуживает и REST, и сокет: INSERT → обновление `support_chats` → emit → (Android) FCM `notification` + `data:{type:'support_message', chatId}`, если у пользователя нет живого сокета в `u:<id>` (`io.in(room).fetchSockets()`).
- Обработчики звонков (`registerDevice`, `offer`, …) не меняются; `disconnect` не трогает комнаты (socket.io чистит сам).

**Тесты:** расширить `scripts/check-auth-core.js` правилами для `/api/support`; ручной сценарий curl (user → staff → user) в README PR.

## 4. Админка (`Totus_admin`, PR в `main`)

- `components/AdminNav.tsx`: пункт `{href:'/support-chat', label:'Чат поддержки', icon:'chat'}` перед «Звонки» + бейдж непрочитанного (из `GET /api/support/summary`, обновляется сокетом). `components/Icon.tsx`: иконки `chat`, `send`.
- `lib/support-chat-api.ts` (типы + функции через `authFetch` на `SERVER_BASE_URL`), `lib/support-chat-socket.ts` (одиночный `io(SERVER_BASE_URL, {auth:{token: staffAuth.accessToken}, transports:['websocket']})`, переподключение после refresh, `onSupportEvent()`), `components/SupportChatProvider.tsx` (счётчик непрочитанного для бейджа на любой странице).
- `app/support-chat/page.tsx` — двухпанельный экран: слева список диалогов (фильтры Открытые / Ждут пользователя / Закрытые / Все, поиск по имени/email/телефону/loyalty, непрочитанные вверх, превью и время), справа — диалог: шапка (имя, контакты, «онлайн» из `users.online`, ссылки на `/users` и `/orders?userId=`, «Позвонить» → calling.totus.club deep-link, «Взять себе», «Закрыть»), лента сообщений по макету (даты, пузыри, карточка заказа → `/orders/<orderId>`, «печатает…»), композер (Enter — отправить, Shift+Enter — перенос). Выбор диалога — `?chat=<id>`.
- Фолбэк без сокета — поллинг списка 15 с / открытого диалога 5 с (как `order-requests`). Уведомление о новом сообщении: звук + `Notification` API (по разрешению) + заголовок вкладки «(3) Чат поддержки».
- `CLAUDE.md` репо: правило 3 дополнить «socket.io-client допустим только для чата поддержки»; README — новые эндпоинты.

## 5. Клиенты пользователя

**totus_WEB (PR в `main`)** — зависимость `socket.io-client`; `config/api.ts` → `VOIP_BASE_URL`; `api/supportChatApi.ts` (fetch + `authHeaders()`, как `orderRequestsApi.ts`); `lib/supportSocket.ts` (singleton, `auth: cb => cb({token: loadToken()})`, отключение по `totus:auth-logout`); `store/slices/supportChatSlice.ts` (сообщения, `hasMore`, `unreadCount`, статус, оптимистичная отправка — формы из ветки `cahts`); страница `pages/profile/support-chat/index.tsx` (`withAuth`; desktop — `MenuProfile` слева + карточка чата справа по макету, mobile — полноэкранный чат, заголовок «Чат с поддержкой» в `header/index.tsx`); компоненты `components/support/chat/*`; пункт в `profile/menu.tsx` и `HeaderProfileMenu.tsx` (иконка `message` уже есть) с точкой непрочитанного; бейдж на иконке профиля в `mobileBottomBar`. Глобальный слушатель `SupportChatGate` в `_app.tsx` рядом с `GlobalAiChat` (только счётчик, без второго плавающего виджета — чтобы не конфликтовать с кнопкой Милы).

**totus_APP (PR в `main`; iPhone-вёрстка по утверждённому макету, iPad — вариант `TabletCentered`)** — `VoipService.ts`: экспорт шины `subscribeSocketEvent / emitSocketEvent / isSocketConnected` с реестром обработчиков, переустанавливаемых при пересоздании сокета; `modules/api/supportChat.ts` (`voipFetch`); `modules/hooks/useSupportChat.ts`; `modules/store/slices/supportChat.ts` (unread для строки в «Аккаунте»); `screens/support/SupportChatScreen.tsx` + `component/support/*` (шапка как `PrivacyPolicyScreen`, inverted FlatList, `KeyboardAvoidingView`, кнопка телефона → существующий `handleCallSupport`); регистрация `supportChat` в `AccountStackScreen`, в `SCREENS_WITHOUT_TAB_BAR` и `ROOT_SCREENS_WITHOUT_TAB_BAR`; строка «Чат с поддержкой» в `Account.tsx` над «Звонок в поддержку»; сброс состояния при `cleanupVoipOnLogout`. Android: в `CallService.js` ветка `data.type === 'support_message'` (при таpе — `navigationRef` → `supportChat`). Android-сборку не трогаем сверх этого; CI не подключаем.

**totus_desktop (PR в `main`)** — `VoipClient.ts`: та же шина событий; `shared/modules/api/supportChat.ts` (общий с приложением код); `renderer/screens/support/SupportChatScreen.tsx` по макету Desktop (роут `/support-chat`, `ROUTES.supportChat`), строка в `AccountScreen`, бейдж непрочитанного в рейле на «Аккаунт», системное уведомление Electron (`new Notification`) при свёрнутом окне.

**calling_v2 (маленький PR)** — чтение `?call=<loyaltyId>` на главной для кнопки «Позвонить» из чата админки. Полноценный чат в панели агента — по желанию, этап 2 (переиспользует те же REST/сокет).

## 6. Порядок работ и PR

| # | Репо / PR | Зависимости | Оценка |
|---|---|---|---|
| 1 | `calling_api_v2` → `prod`: модуль, миграция, README | — ; после мержа: `node scripts/run-support-chat-migration.js`, `pm2 restart api_calling` | 1–1,5 дня |
| 2 | `Totus_admin` → `main`: раздел «Чат поддержки» | #1 на проде | 1–1,5 дня |
| 3 | `totus_WEB` → `main`: ЛК desktop + mobile | #1 | 1 день |
| 4 | `totus_APP` → `main`: экран + шина сокета + Android FCM-ветка | #1; TestFlight-сборка — владелец | 1,5 дня |
| 5 | `totus_desktop` → `main` | #1 | 0,5 дня |
| 6 | `calling_v2` → `main`: deep-link `?call=` | — | 0,2 дня |
| 7 | Документация проекта: `docs/CALLING_API_DOCUMENTATION_RU.md` (§ Support Chat), `docs/ADMIN_DOCUMENTATION_RU.md`, `WEB/APP` доки, доска Totus Dev Board | после мержей | — |

Каждый PR — отдельная ветка `claude/support-chat`, без затрагивания CI и Android-специфики (кроме FCM-ветки в #4), Мила не меняется. Мержи и деплой — владелец.

## 7. Этап 2 (после запуска)

iOS-пуши о сообщениях (регистрация обычного APNs-токена в приложении через `@react-native-firebase/messaging`, новая колонка/таблица токенов, отправка через существующий `apnProvider` с `pushType:'alert'`); вложения (пользовательский upload в totus_API или в calling_api_v2, `meta.attachments`); письмо в поддержку при офлайне сотрудников (totus_API Postbox, внутренний вызов); шаблоны быстрых ответов и «Обращения по заказам» → сообщение в чат (объединение с `order_requests`); чат в панели calling_v2; оценка диалога.

## 8. Вопросы владельцу (нужны до старта)

1. **Где сидит поддержка:** раздел в `Totus_admin` (admin.totus.club, staff-вход) — как в плане, или в панели звонков calling.totus.club (agent-вход)? Можно оба, но первым делаем один.
2. **Кто отвечает:** сотрудники со staff-учётками (`staff`) и/или агенты (`users.role='agent'`)? В плане разрешены оба.
3. Часы работы и текст в пустом состоянии («ежедневно 9:00–21:00 МСК, ответ ~5 минут») — подтвердить; нужен ли авто-ответ вне часов.
4. Миграцию БД запускаешь сам на сервере (скрипт в PR #1) — ок?
5. Этап 1 без iOS-пушей (только внутри приложения + Android FCM) — приемлемо?
