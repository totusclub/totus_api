# Push-уведомления — статус реализации

**Статус:** 08.09.2026 — код написан по плану `claude/PUSH_NOTIFICATIONS_PLAN_RU.md` и утверждённому дизайну `claude/NOTIFICATIONS_DESIGN_RU.md`; открыты 6 PR (по одному на репозиторий), ждут проверки и мержа владельцем. Контракт хаба для всех клиентов — `docs/NOTIFICATIONS_API.md` в calling_api_v2.

## PR

| # | Репо | PR | Что внутри |
|---|---|---|---|
| 1 | calling_api_v2 → prod | [#6](https://github.com/tosmedia/calling_api_v2/pull/6) | Хаб `lib/notifications/` (service/devices/fcm/webpush/campaigns/reminders/calls/routes), миграция `scripts/run-notifications-migration.js` (6 таблиц), `scripts/generate-vapid-keys.js`, `scripts/check-notifications.js`, подключение через `middleware/auth.js` (POLICY handler + tap для звонков + socket), Support Chat → `notify()`, `web-push` в зависимостях |
| 2 | totus_APP → main | [#8](https://github.com/tosmedia/totus_APP/pull/8) | `@notifee/react-native`, `src/modules/push/*` (регистрация FCM-токена iOS/Android, foreground-показ, deep links, PushBridge, шторка предзапроса), slice `notifications`, экраны «Уведомления»/«Настройки уведомлений», строка в «Аккаунте», бейдж таб-бара, `remote-notification` в Info.plist, убран запрос разрешения при запуске в AppDelegate |
| 3 | totus_WEB → main | [#7](https://github.com/tosmedia/totus_WEB/pull/7) | `public/sw.js` (Web Push, клик, дедуп с видимой вкладкой), `src/lib/webPush.ts` (подписка по действию, VAPID), slice, `NotificationsBridge` (сокет + тост), колокольчик с поповером в шапке, `/profile/notifications` и `/settings`, отписка при выходе |
| 4 | totus_desktop → main | [#2](https://github.com/tosmedia/totus_desktop/pull/2) | `NotificationsProvider` (сокет `notify:*`, системные уведомления при неактивном окне, бейдж Dock через IPC `set-badge-count`, диалог разрешения), экраны `/account/notifications(/settings)`, бейдж в рейле, строка в «Аккаунте» |
| 5 | totus_API → main | [#5](https://github.com/tosmedia/totus_API/pull/5) | `lib/notifyHub.js` (клиент `/internal/notify`, тексты без ПД, дедуп), хуки в `utils/orderEmails.js`, `utils/vtbCallback.js`, `utils/levelTravelWebhooks.js`, `utils/levelTravelClientOrder.js`, `controllers/orderRequests.controller.js`; `app.js` не тронут |
| 6 | Totus_admin → main | [#4](https://github.com/tosmedia/Totus_admin/pull/4) | `lib/push-api.ts`, раздел «Уведомления» (`/notifications?tab=campaigns|reminders|history`): рассылки с сегментами и предпросмотром, правила напоминаний с редактором и тестом, история со сводкой; пункт в AdminNav |

Все Support Chat PR (calling_api_v2 #5, calling_v2 #7, totus_WEB #6, totus_APP #7, totus_desktop #1) смержены — ветки push-уведомлений от них, диффы чистые.

## Как устроено (кратко)

`notify(userId, type, …)` в calling_api_v2 → настройки пользователя (`notification_settings`, категории orders/documents/system неотключаемы, promo — opt-in) → строка в `notifications` (центр) → socket `notify:new`/`notify:badge` в комнату `u:<userId>` → push по `push_devices` (FCM для iOS+Android через firebase-admin, Web Push для сайта; desktop — только сокет). Тихие часы 21:00–09:00 МСК (`PUSH_QUIET_HOURS`) — отложенная доставка для promo/напоминаний. Источники: totus_API (`POST /internal/notify` c `X-Internal-Key`: заказ создан, оплата, статусы LT по webhook, документы, обращения), хаб (сообщение поддержки без живого сокета, пропущенный звонок поддержки — tap-наблюдатели `/api/calls*`), Totus_admin (рассылки, правила напоминаний; движок напоминаний раз в 10 мин в хабе по `orders.package`).

## Что делает владелец после мержа

1. calling_api_v2: `npm install` → `node scripts/run-notifications-migration.js` → `node scripts/generate-vapid-keys.js` (VAPID в `.env`) → `openssl rand -hex 32` → `INTERNAL_API_KEY` в `.env` calling_api_v2 **и** totus_API (`NOTIFY_HUB_URL=http://127.0.0.1:4444`) → `pm2 restart api_calling` и API → лог `[notify] ready (fcm=on, webpush=on…)`.
2. Firebase Console → Cloud Messaging → загрузить APNs-ключ `.p8` (иначе iOS-пуши не уходят).
3. totus_APP: `pod install`, сборка, TestFlight; проверить `aps-environment`.
4. totus_WEB: HTTPS, добавить `public/icons/icon-192.png`, `badge-72.png` (сейчас sw.js подменяет на существующий favicon), `npm run build`.
5. Totus_admin → «Уведомления» → «Напоминания»: включить два стартовых правила (за 3 дня, за сутки — созданы выключенными), «Тестовый пуш себе».
6. Проверить реальные состояния Level.Travel/VTB против словарей в `totus_API/lib/notifyHub.js` и `utils/levelTravelWebhooks.js` (`PAYMENT_STATES_SKIP`, `ORDER_STATE_LABELS_RU`).

## Известные ограничения / следующий этап

- E-mail-канал в правилах напоминаний сохраняется, но письма пока не шлются (totus_API — отдельный этап).
- Desktop: push при закрытом приложении — не в этом этапе (только пока запущено).
- iOS Safari Web Push — только для установленной PWA (подсказка в настройках сайта).
- Замечено пред-существующее: `totus_APP/index.js` импортирует `handleIncomingPush` из `CallService.js`, которого там нет (headless-таски CallKeep) — не трогали, стоит проверить владельцу.
- Карточка пользователя в админке (устройства + «Отправить тест») не сделана — страницы `app/users/[id]` нет; клиент `getUserDevices` готов.
- Ревью интеграции (кросс-проверка контракта по всем PR) выполнено, найденные расхождения исправлены в тех же ветках (список рассылок `{items}`, `clickAction` Android, статус scheduled при PUT, отписка Web Push при выходе, дедуп тоста и системного пуша, двойные пуши об оплате, хук при ошибке SMTP, ПД в тексте статуса, маршрут `account`, unread после реконнекта desktop).
