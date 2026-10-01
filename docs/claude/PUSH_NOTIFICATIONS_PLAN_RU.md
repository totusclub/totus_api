# Push-уведомления по всей платформе — технический план

**Статус:** 07.09.2026 — план на проверку владельца. Код не пишется до подтверждения. Связанные документы: `claude/SUPPORT_CHAT_PLAN_RU.md` / `SUPPORT_CHAT_STATUS_RU.md` (в чате поддержки уже есть FCM-пуш для Android — он переедет в общий хаб), `docs/CALLING_API_DOCUMENTATION_RU.md`, `docs/API_DOCUMENTATION_RU.md`, `ROADMAP_RU.md` §1 (пуши в приложении и на сайте).

## 0. Что есть сейчас (по коду)

| Где | Факт |
|---|---|
| calling_api_v2 (voip) | `apn` (ключ .p8, только `pushType: voip`, topic `app.totus.club.voip`), `firebase-admin` (FCM data-пуш для входящего звонка на Android; в PR #5 — FCM-уведомление о сообщении поддержки), socket.io с JWT-комнатами `u:<userId>`. Токен один на пользователя: `users.voipToken` (iOS — PushKit VoIP-токен, Android — FCM-токен, web — строка `'web'`), перезаписывается последним устройством. |
| totus_API | Источник всех «бизнес-событий»: регистрация/вход, создание заказа (`/create-package`, `/vtb/create-order`), оплата СБП (`/check_pay`), статусы заказов Level.Travel, «Обращения по заказам», заявки на звонок; письма через Yandex Postbox (`utils/yandexCloudEmail.js`, шаблоны `utils/emailTemplates.js`). Пушей нет. |
| totus_APP | `@react-native-firebase/messaging` (Android: `getToken`, `onTokenRefresh`, background/foreground-обработчики только для `incoming_call`), `react-native-voip-push-notification` (iOS PushKit). Обычный APNs/FCM-токен на iOS **не запрашивается**; `notifee`/`push-notification-ios` нет; экрана уведомлений и настроек нет. |
| totus_WEB | Next 15, PWA/service worker нет, Web Push нет; есть Header/профиль, `GlobalAiChat`. |
| totus_desktop | Electron: сокет чата/звонков + `new Notification()` при неактивном окне (только пока приложение запущено). |
| Totus_admin | Next 14, staff-JWT, разделы Users/Orders/Обращения; рассылок нет. |
| Дизайн | Экранов «Уведомления» и «Настройки уведомлений» в Figma нет — по правилу проекта UI сначала рисуется и утверждается. |

## 1. Архитектура: единый хаб уведомлений

```
 Источники событий                     Хаб (calling_api_v2, lib/notifications/)                 Каналы доставки
 ───────────────────                   ──────────────────────────────────────────                ───────────────
 calling_api_v2: support chat,   ──►   notify(userId, type, payload)                     ──►  socket  `notify:new` → комната u:<id>   (in-app, бейдж, тост)
   пропущенный звонок                    1. настройки пользователя (тип включён?)         ──►  FCM     iOS + Android (firebase-admin)
 totus_API: заказы, оплата,      ──►    2. запись в `notifications` (центр уведомлений)   ──►  Web Push (VAPID, пакет web-push) — сайт
   документы, обращения,                 3. рассылка по устройствам из `push_devices`     ──►  Desktop — только сокет (приложение запущено)
   напоминания о поездке                 4. учёт результата, чистка мёртвых токенов        ──►  (e-mail остаётся в totus_API как раньше)
 Totus_admin: ручные/маркетинговые ─►    internal API: POST /internal/notify (секрет)
```

Почему хаб в **calling_api_v2**: там уже есть firebase-admin, APNs-провайдер, socket.io с комнатами по JWT, общая MySQL `kedam`, и туда уже ходят все клиенты. totus_API остаётся владельцем бизнес-событий и вызывает хаб по внутреннему HTTP с секретом (`INTERNAL_API_KEY`, оба сервиса на одном хосте — вызов на `127.0.0.1:4444`). Письма не переносим.

**iOS и Android — через FCM (firebase-admin)**, а не через прямой APNs: один код отправки для двух платформ, Firebase сам доставляет в APNs (нужно загрузить в консоль Firebase тот же `.p8` APNs-ключ, что используется для VoIP — это делает владелец). VoIP-пуши звонков остаются как есть (PushKit + `apn`), их не трогаем.

## 2. Хранение и управление токенами

Новая таблица (миграция `scripts/run-notifications-migration.js`, идемпотентно):

```sql
push_devices (
  id INT PK, user_id INT NOT NULL,
  platform ENUM('ios','android','web','desktop'), channel ENUM('fcm','webpush'),
  token TEXT NOT NULL,                       -- FCM-токен; для web — endpoint
  subscription JSON NULL,                    -- web: {endpoint, keys:{p256dh, auth}}
  device_id VARCHAR(64) NULL,                -- стабильный id установки (тот же, что deviceId в VoipService)
  app_version VARCHAR(32), locale VARCHAR(8), enabled TINYINT DEFAULT 1,
  last_seen_at DATETIME, created_at, updated_at,
  UNIQUE KEY uq_token (token(191)), KEY idx_user (user_id)
)
notifications (
  id BIGINT PK, user_id INT, type VARCHAR(48), title VARCHAR(160), body VARCHAR(512),
  data JSON NULL,                            -- {route, orderId, chatId, url}
  read_at DATETIME NULL, created_at DATETIME, KEY idx_user_created (user_id, created_at)
)
notification_settings (user_id INT PK, prefs JSON, updated_at)   -- {orders:true, support:true, reminders:true, marketing:false}
push_campaigns (id, staff_id, title, body, data JSON, segment JSON, status, sent_count, created_at)  -- ручные рассылки из админки
```

Правила: несколько устройств на пользователя (в отличие от `users.voipToken`); регистрация после входа (`POST /api/push/devices`, Bearer user-JWT, тело `{platform, channel, token|subscription, deviceId, appVersion, locale}` — upsert по токену), обновление при `onTokenRefresh`, снятие при выходе (`DELETE /api/push/devices/:token`) и автоматически при ответе FCM `registration-token-not-registered` / Web Push `404/410`; чужой токен пере-привязывается к новому пользователю при входе на том же устройстве. `users.voipToken` остаётся только для VoIP-звонков. Личность — только из JWT; PII в пуш-payload не кладём (только номера заказов, тип, маршрут).

## 3. Логика отправки (хаб)

`notify({ userId, type, title, body, data, channels? })` → проверка `notification_settings` (транзакционные типы нельзя отключить целиком, только маркетинг/напоминания) → INSERT `notifications` → `io.to('u:'+userId).emit('notify:new', …)` (и `notify:badge {unread}`) → выбор устройств: FCM — `sendEachForMulticast` с `notification {title, body}` + `data {type, route, …}` + `android.notification.channelId` по типу + `apns.payload.aps {badge, sound, thread-id}`; Web Push — `webpush.sendNotification(subscription, JSON)` с TTL; результат — счётчики и удаление мёртвых токенов. Дедупликация по `collapseKey`/`tag` (например, один пуш на диалог за 30 с). Маркетинг — окно тишины 21:00–09:00 МСК (откладываем), очередь батчами по 500 токенов, без ретраев (лог). Support chat из PR #5 переключается на `notify()` (условие «нет живого сокета» сохраняется).

Внутренний API для totus_API: `POST /internal/notify` `{userId | loyaltyId, type, title, body, data}` с заголовком `X-Internal-Key`; без ключа — 401 всегда. Отложенные события (напоминания о поездке) — скрипт `scripts/send-trip-reminders.js` в totus_API по cron/pm2 (раз в час: заказы с вылетом через 24 ч / через 3 дня без напоминания) → хаб.

## 4. Сценарии уведомлений (типы)

| Тип | Кому / когда | Источник | Маршрут по тапу |
|---|---|---|---|
| `order_created` | заказ создан, ждёт оплаты | totus_API | Детали заказа |
| `payment_success` / `payment_failed` | результат оплаты СБП | totus_API (`/check_pay`) | Детали заказа |
| `order_confirmed` / `order_status` | подтверждение туроператором, изменение статуса LT, отмена | totus_API (по опросу/вебхуку LT) | Детали заказа |
| `documents_ready` | ваучеры/билеты доступны | totus_API | Документы заказа |
| `trip_reminder_3d` / `trip_reminder_24h` | за 3 дня и за сутки до вылета (время вылета, рейс, отель) | скрипт в totus_API | Детали заказа |
| `order_request_status` | ответ на «Обращение по заказу» | totus_API (PATCH статуса) | Обращение / заказ |
| `support_message` | сообщение поддержки, когда нет живого сокета | calling_api_v2 | Чат с поддержкой |
| `missed_call` | пропущенный звонок поддержки (не ответил за 40 с) | calling_api_v2 | Аккаунт → звонок |
| `promo` | маркетинг (горящие туры, акции) — только с согласия (opt-in), сегмент, окно тишины | Totus_admin → хаб | Главная / URL |
| `system` | важное (обновление приложения, техработы) | Totus_admin | Главная |

Не в этом этапе: «брошенный поиск/бронирование», персональные ценовые алерты, ИИ-консьерж в отеле (в ROADMAP).

## 5. Изменения по репозиториям

**calling_api_v2 (хаб)** — `lib/notifications/{index.js (notify, каналы), devices.js (регистрация/чистка), fcm.js, webpush.js, routes.js}`; REST: `POST/DELETE /api/push/devices` (user), `GET /api/notifications?before&limit`, `POST /api/notifications/read` (user), `GET/PUT /api/notifications/settings` (user), `POST /internal/notify` (секрет), staff: `POST /api/push/campaigns` (+ `dryRun` — только подсчёт аудитории), `GET /api/push/campaigns`, `POST /api/push/test` (себе); сокет `notify:new`, `notify:badge`; подключение через `middleware/auth.js` (POLICY-handler, как чат — index.js не трогаем); зависимости: `web-push`; env: `INTERNAL_API_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `PUSH_QUIET_HOURS`; support chat → `notify()`.

**totus_API** — `lib/notifyHub.js` (клиент внутреннего API, fire-and-forget с логом); вызовы в контроллерах создания заказа, `/check_pay`, смены статусов LT, `PATCH /api/admin/order-requests/:id`; `scripts/send-trip-reminders.js` (cron); env `NOTIFY_HUB_URL=http://127.0.0.1:4444`, `INTERNAL_API_KEY`.

**totus_APP** — `modules/push/pushService.ts`: запрос разрешения не при запуске, а после входа / первого заказа (и по кнопке в настройках), `messaging().getToken()` (iOS — после `registerDeviceForRemoteMessages`), `onTokenRefresh`, регистрация в хабе, снятие при выходе; обработка: foreground — локальное уведомление через **`@notifee/react-native`** (новая зависимость; без него FCM в foreground ничего не показывает) + бейдж; background/quit — системное уведомление FCM; тап → deep link по `data.route` через `navigationRef`; Android-каналы (`orders`, `support`, `reminders`, `promo`); экран «Уведомления» (центр: список, непрочитанные, «Прочитать все») и «Настройки уведомлений» (переключатели по типам) в стеке «Аккаунт» + строка в «Аккаунте» и бейдж на вкладке; iOS-проект: capability Push Notifications + Background Modes → Remote notifications (правка `.entitlements`/`Info.plist`; загрузка APNs-ключа в Firebase — владелец); `CallService.js` — ветка не-звонковых сообщений передаётся в pushService.

**totus_WEB** — `public/sw.js` (service worker: `push` → `showNotification`, `notificationclick` → открыть `data.url`), `lib/webPush.ts` (`subscribe()` с VAPID public key после явного действия пользователя — кнопка/переключатель в ЛК, не автоматически при заходе), регистрация подписки в хабе, отписка при выходе; страница `/profile/notifications` (центр + настройки), колокольчик с бейджем в шапке (по сокету `notify:badge`; сокет уже есть в PR #6). Ограничения: iOS Safari — только для установленной PWA; Safari desktop — по жесту.

**totus_desktop** — центр уведомлений и настройки (те же экраны, что в приложении), системные `Notification` по сокету при неактивном окне (уже есть для чата — расширить на все типы), бейдж на иконке в Dock/taskbar (`app.setBadgeCount`). Push при закрытом приложении — не в этом этапе (macOS/Windows native push — отдельная задача).

**Totus_admin** — раздел «Уведомления»: форма рассылки (заголовок, текст, ссылка/маршрут, сегмент: все / платформа / есть заказы / с вылетом в диапазоне дат, предпросмотр, «Сколько получателей» (dryRun), отправить), история кампаний с результатами, кнопка «Тестовый пуш себе»; карточка пользователя — список его устройств и кнопка «Отправить тест».

**calling_v2** — без изменений (пропущенный звонок фиксируется на бэкенде).

## 6. Дизайн (до кода)

Нужно нарисовать и утвердить в Figma (страницы «NOTIFICATIONS · Light / Dark», по образцу «SUPPORT CHAT»): iPhone/iPad/Desktop/Web — экран «Уведомления» (список с иконками по типу, непрочитанные, пустое состояние), «Настройки уведомлений» (переключатели: Заказы и оплата, Поддержка, Напоминания о поездке, Акции и предложения), запрос разрешения (пояснительный экран перед системным диалогом), колокольчик/бейджи в шапке сайта и рейле desktop; Totus_admin — «Уведомления» (форма рассылки, история). Тексты пушей — короткие шаблоны на русском, например: «Заказ №48213 ожидает оплаты», «Оплата прошла — документы будут готовы в течение 15 минут», «Вылет завтра в 07:40, Шереметьево → Хургада».

## 7. Порядок работ и PR

| # | Шаг | Репо | Зависимости |
|---|---|---|---|
| 0 | Дизайн экранов в Figma, утверждение | — | — |
| 1 | Хаб: таблицы, устройства, FCM + Web Push, `/internal/notify`, перевод support chat на хаб | calling_api_v2 → prod | миграция БД (владелец), ключи VAPID (сгенерирую), APNs-ключ в Firebase (владелец) |
| 2 | Приложение: токены, обработка, deep links, экраны, iOS-capabilities | totus_APP → main | #1; сборка TestFlight — владелец |
| 3 | Сайт: service worker, подписка, центр/настройки, колокольчик | totus_WEB → main | #1 |
| 4 | Desktop: центр/настройки, системные уведомления всех типов, бейдж | totus_desktop → main | #1 |
| 5 | totus_API: события заказов/оплаты/обращений + напоминания о поездке | totus_API → main | #1 |
| 6 | Админка: рассылки, история, тест | Totus_admin → main | #1 |
| 7 | Документация проекта, доска | — | после мержей |

Ограничения как раньше: CI не трогаем; Android — только то, что перечислено (каналы, foreground-показ); Мила не меняется; каждый PR — отдельная ветка `claude/push-notifications`; мержи, миграции и настройки консолей (Firebase/Apple) — владелец.

## 8. Вопросы владельцу

1. iOS через FCM (загрузить APNs .p8 в Firebase-проект) — ок? Альтернатива — прямой APNs через `apn` (второй код отправки, но без зависимости от Firebase для iOS).
2. Маркетинговые рассылки нужны в этом этапе? Если да — только opt-in (согласие в настройках) и окно тишины 21:00–09:00 МСК.
3. Web Push на сайте нужен, или на сайте достаточно колокольчика/центра уведомлений по сокету (без системных пушей)?
4. Источник статусов Level.Travel для `order_confirmed`/`documents_ready`: сейчас опрос или вебхук (см. открытый вопрос по webhook-ключу LT)? От этого зависит, где вешать событие.
5. Новая зависимость `@notifee/react-native` в приложении — ок? (нужна для показа уведомлений в foreground и Android-каналов.)
6. Напоминания о поездке: за 3 дня и за 24 часа — подтвердить сроки и текст.
