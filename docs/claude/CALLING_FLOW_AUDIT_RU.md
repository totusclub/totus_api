# Звонки Totus — полный аудит calling flow (02.10.2026)

**Статус (02.10):** владелец решил идти по плану §8 строго по порядку, каждый этап доводить до рабочего состояния.

| Этап | Состояние |
|---|---|
| 1. A1 + A6 + проверки сервера | **Проверено владельцем 02.10**: два звонка соединились на обоих устройствах. PR: [support_app #2](https://github.com/tosmedia/totus_support_app/pull/2), [totus_APP #14](https://github.com/tosmedia/totus_APP/pull/14) |
| 2. Сервер | [calling_api_v2 #8](https://github.com/tosmedia/calling_api_v2/pull/8) **слит и задеплоен** (S1, S2, S3, S6): приложение и сайт открыты — звонят оба (проверка владельца). Дальше: S4 (state, таймаут, отмена push), S5, P1-2 |
| 3. totus_APP | Начат по находке владельца («приложение закрыто, сайт открыт — на телефон не приходит»): PKPushRegistry при запуске + A2, A3, P1-3 (перенос из Support App) — [totus_APP #15](https://github.com/tosmedia/totus_APP/pull/15), ждём проверки на устройстве. Дальше: A4/A5 (Android), P1-8, P1-11 |
| 4–7 | Не начаты. Решение владельца: после стабильной работы сценария «закрытое приложение» проходим подряд все оставшиеся пункты |

**Что прочитано (через GitHub-коннектор):**
- `calling_api_v2@prod` b4349fc: `index.js`, `middleware/auth.js`, `lib/*`, `db.js`;
- `totus_APP@main` 4fdea217: `VoipService.ts` (5173 строки), `CallService.js`, `index.js`, `App.tsx`, `CallModal`, `SupportChat`, `CallsScreen`, `voipAuth.ts`, iOS-натив, Android-натив, манифест;
- `totus_support_app@main` (после слияния PR #1): `VoipService.ts`, `coldStart.ts`, `answerRecovery.ts`, `CallOverlay`, iOS- и Android-натив;
- `totus_WEB@main`: `supportCall.ts`, `supportCallApi.ts`, `supportSocket.ts`, `SupportCallProvider`, `SupportCallModal`;
- `calling_v2` (`main` 843b0a2 и `develop` 8ee2873): `webrtc-service.ts`, `CallModal`, `layout`, `page`, `http.ts`.

Выводы сделаны только по коду, на устройствах ничего не запускалось. Номера строк — для `VoipService.ts` и `index.js`; для остальных файлов указаны примерно.

## 0. Факты, которые меняют картину

1. **PR #1 в `totus_support_app` слит в `main` 30.09 без патча `VoipService.ts`.** В `main` лежит старый `VoipService.ts`, поэтому `answerRecovery.ts` — мёртвый код, а `npm run check` падает. Из PR реально работают только:
   - фоновый старт RN в `AppDelegate`;
   - `coldStart.ts`;
   - refresh JWT для сокета.
2. **PR #7 `calling_api_v2` (topic VoIP для support app) слит в `prod` 30.09.** Задеплоен ли — видно по строке `[apn] multi-topic VoIP enabled` в логе pm2.
3. **Android-пуш звонка на сервере есть** (FCM data, `index.js:989-1038`). Документация, где сказано «не реализован», устарела.
4. **В `totus_APP` неполный Android-натив.** В репозитории нет `MainActivity.kt`, хотя манифест на него ссылается. Нет `TotusVoipForegroundService` и `CallKeepLaunchStatePackage`, а `IncomingCallActivity` не объявлена в манифесте. В `android/app/src/main/java/com/totusclubapp/` всего 3 файла. Либо `main` на Android не собирается, либо сборка идёт с локальными файлами, которых нет в Git.
5. **Сервер звонков хранит одно устройство на учётку.** Это `users.voipToken` и `users.socketId` плюс карты 1:1 в памяти. Состояния звонка и таймаута на сервере нет, а записи `calls` никогда не удаляются.

## 1. Как устроен звонок (общая схема)

```
Звонящий: микрофон → ICE-серверы → RTCPeerConnection → createOffer
  → POST /api/calls {callId, offer, toLoyaltyId}
Сервер: ищет адресата
  - сначала в памяти: loyaltyId → deviceId → socketId;
  - иначе в БД: users.voipToken / socketId.
  Дальше:
  - есть сокет → socket offer + call-state ringing;
  - iOS → APNs VoIP (в payload весь SDP);
  - Android → FCM data (в payload весь SDP);
  - веб → только сокет.
Адресат:
  - iOS: PushKit → CallKit → [JS] → «Ответить» → GET /api/calls/:id (offer)
    → микрофон → createAnswer → POST /answer;
  - Android: FCM → headless JS → CallKeep (Telecom) → «Ответить» → то же.
ICE: trickle, каждый кандидат идёт через POST /candidate и socket ice-candidate;
  сервер буферизует HTTP-кандидаты и отдаёт их один раз (GET /candidates).
Завершение: POST /end и /reject → сервер шлёт call-state только по сокету.
```

## 2. Матрица комбинаций

Условные обозначения: ✅ работает по коду; ⚠️ работает с задержкой или нестабильно; ❌ не работает или ломается в типичном сценарии.

| Направление | Открыто | Фон | Убито / заблокировано | Главные причины |
|---|---|---|---|---|
| Сайт (WEB) → поддержка (support app iOS) | ✅ | ⚠️ | ❌/⚠️ | Не применён патч PR #1 (ответ до старта JS теряется, нет звука CallKit, offer ждём ~4 с); ранние ICE-кандидаты звонящего теряются |
| Сайт → поддержка (support app Android) | ⚠️ | ⚠️ | ❌/⚠️ | Telecom UI при выключенном Calling account не показывается; нет full-screen и рингтона; после рестарта сервера устройство считается `web` |
| Сайт → поддержка (панель calling_v2) | ⚠️ | ⚠️ (вкладка в фоне — без звука) | — | Устаревший disconnect делает линию «офлайн»; на `main` страница `/chat` не принимает звонки; нет рингтона |
| totus_APP → поддержка (support app / панель) | ⚠️ | ⚠️ | — | Ранние ICE-кандидаты теряются; нет таймаута «нет ответа»; на Android нет FGS при уходе в фон |
| Поддержка (панель / support app) → totus_APP iOS | ✅ | ⚠️ (риск без звука) | ⚠️/❌ | Те же ошибки, что в PR #1 (кроме SceneDelegate): многократный ответ, нет `RTCAudioSession`, offer ~4 с, `getInitialEvents` не читаются; PushKit регистрируется только из JS, после PersistGate |
| Поддержка → totus_APP Android | ⚠️ | ❌/⚠️ | ❌ | Неполный натив, нет FGS, full-screen, рингтона; 2–4 параллельных ответа с новыми `RTCPeerConnection` |
| Поддержка → сайт (WEB) | ⚠️ | ❌ (фоновая вкладка — без звука и уведомления) | — | Нет рингтона, Notification и web-push; микрофон запрашивается до «Ответить» |
| Любой → пользователь, открывший и сайт, и приложение | ❌ | ❌ | ❌ | Сайт пишет `voipToken = web-…` поверх APNs-токена телефона, и телефон перестаёт получать звонки |

## 3. Почему первый звонок после установки не соединяется сразу

Причины по вероятности:

1. **iOS: доступ к микрофону не запрошен заранее.** Он запрашивается только в `getUserMedia` в момент ответа. С экрана блокировки или из CallKit диалог не показать → ошибка → `endCall`. Касается totus_APP и support app.
2. **Устройство ещё не зарегистрировано с настоящим токеном.**
   - До входа `register-device` не отправляется.
   - PushKit/FCM-токен приходит позже логина (в totus_APP запрос токена повторяется через 0/1/3/5/10 с).
   - Пока регистрации нет, сервер отдаёт 404 «offline» или звонит в старый токен.
3. **Неудачный APNs-пуш возвращается как `200 ok`.** Это sandbox-токен debug-сборки, неверный topic (PR #7 не задеплоен) или payload больше 5 КБ из-за SDP. Звонящий слышит гудки, у адресата тишина.
4. **Android: Calling account (PhoneAccount) не включён.** При `selfManaged:false` Telecom молча не показывает звонок, а запасного пути нет.
5. **Холодный старт:**
   - JS + PersistGate;
   - запрос offer, у которого бюджет всего ~4 с;
   - фиксированные паузы ~1,2–4,5 с;
   - ожидание сбора ICE до 2,5 с;
   - ICE-кандидаты звонящего, отправленные до `POST /api/calls`, теряются.

   Отсюда «соединяется с задержкой» или «сбрасывается сразу после ответа».
6. **iOS до первой разблокировки после перезагрузки.** AsyncStorage недоступен, поэтому звонок не соединится. Это ограничение iOS; его можно ослабить, если хранить VoIP-токен в Keychain.

## 4. Найденные проблемы и что менять

### P0 — ломают звонок в типичных сценариях

| # | Где | Проблема | Что изменить |
|---|---|---|---|
| S1 | api `index.js:1523-1557` | Устаревший `disconnect` после переподключения удаляет маппинг **нового** сокета и пишет `online=0`. Устройство подключено, но недостижимо (сильнее всего бьёт по панели и вебу) | Удалять запись, только если `deviceSockets.get(deviceId) === socket.id`; в БД `UPDATE … WHERE socketId = ?` |
| S2 | api `index.js:236-256, 775-791` + WEB `supportCallApi` + calling_v2 `webrtc-service` | Веб-клиенты пишут `voipToken = web-<uuid>` в единственное поле. Телефон того же пользователя теряет звонки. Путь через БД принимает `web-…` за Android → FCM 500 | Для `platform:web` voipToken не трогать; отдельная таблица устройств (или `push_devices`) |
| S3 | api `index.js:60-65` + `db.js` | Одно устройство на учётку. Звонок на `SUPPORT_LOYALTY_ID` получает только последнее устройство; панель и support app «крадут» звонки друг у друга | Звонить на все устройства пользователя; при ответе остальным слать `answered_elsewhere`; отдельные учётки агентов или очередь |
| S4 | api `index.js:870-879, 1166-1185, 1261-1334` | Нет состояния, таймаута и очистки звонка. Если звонящий положил трубку, iOS/Android продолжают звонить, и можно ответить на мёртвый звонок; `GET /api/calls/:id` не отдаёт state | Поле `state` с метками времени; GET отдаёт state; answer не в ringing → 409; серверный таймаут 60 с → `missed` + `ended`; FCM `call_cancel` (Android); клиенты при пробуждении проверяют state; удаление записей и TTL кандидатов |
| S5 | api `index.js:951, 977, 1044` | Сбой APNs (BadDeviceToken / Unregistered / TopicDisallowed / PayloadTooLarge), «нет канала» и мёртвый сокет отдаются звонящему как `200 ok` → «гудки в никуда» | `sent=0` → 502 с причиной; очищать протухшие APNs/FCM-токены; клиент показывает «Абонент недоступен» |
| S6 | api `index.js:1373-1385` | После `pm2 restart` сокетный `registerDevice` создаёт устройство с `platform:'web'`. Телефонам уходит только сокетный offer без пуша → Android в фоне получает «тихий» пропущенный звонок | Брать платформу и токен из БД, телефонам всегда слать пуш; клиенты на каждый socket `connect` повторяют `POST /register-device` |
| A1 | support app `main` | Патч `VoipService.ts` из PR #1 не применён. Ответ из закрытого / заблокированного приложения до старта JS теряется; нет звука CallKit; offer ~4 с; несколько ответов | Применить `VoipService-background-answer.patch` (хеш `f53230a1`), `npm run check` |
| A2 | totus_APP `VoipService.ts:4718-4724, 1574-1586` и места вызова | Отложенный ответ запускается 2–5 раз, каждый раз с новым `RTCPeerConnection` без закрытия старого → звук теряется, микрофон остаётся включённым | Перенести `answerRecovery.ts` (`createAnswerGate`, `schedulePendingAnswer`) из support app; закрывать прежний `pc` |
| A3 | totus_APP `VoipService.ts:3521-3526` (support `3533-3538`) | iOS: активация аудио CallKit не передаётся в WebRTC → нет звука с экрана блокировки и из фона | `RTCAudioSession.audioSessionDidActivate/Deactivate`; не трогать `InCallManager` на iOS, пока сессией владеет CallKit |
| A4 | totus_APP Android-натив | Нет `MainActivity`, FGS, Package; `IncomingCallActivity` не в манифесте; JS-модули Android — заглушки; нет рингтона | Восстановить или закоммитить натив; FGS `phoneCall\|microphone`; full-screen-уведомление; проверить, что `main` собирается |
| A5 | totus_APP + support app, Android | `selfManaged:false`: при выключенном Calling account звонок не показывается, фолбэка нет | `selfManaged:true` + свой full-screen входящий (notifee, категория CALL) или фолбэк по `createIncomingConnectionFailed`; при входе проверять `checkPhoneAccountEnabled` |
| A6 | totus_APP + support app, iOS | Микрофон не запрошен заранее → первый ответ из CallKit сбрасывается | Запросить микрофон после входа или при первом открытии чата поддержки; показать статус в профиле |
| W1 | WEB `supportCall.ts:309`, calling_v2 `webrtc-service.ts:746` | Таймер ожидания ответа (30 с) не снимается и через 30 с убивает **следующий** звонок | Таймер и `AbortController` на попытку; проверять `callId === active` |
| W2 | calling_v2 `webrtc-service.ts:817, 857` | Ответ, пришедший через HTTP-опрос или `call-state`, не завершает ожидание → через 30 с идущий разговор обрывается | Вызывать `finish()` из опроса, как сделано на сайте |
| W3 | calling_v2 `main` `app/layout.tsx` | Из layout удалён `GlobalCallManager` → на `/chat` агент не зарегистрирован и не видит входящих | Вернуть инициализацию и карточку звонка на уровень layout |

### P1 — задержки, обрывы, «висящие» состояния

| # | Где | Проблема | Что изменить |
|---|---|---|---|
| P1-1 | все клиенты (APP `2289-2340`, WEB `:261/:404`, v2 `:527/:639`) | ICE-кандидаты звонящего уходят до `POST /api/calls` и теряются; веб и панель не опрашивают `/candidates`; сокетные кандидаты не буферизуются | Копить кандидаты до ответа `POST /api/calls`, потом отправлять пачкой; сервер буферизует все кандидаты и отдаёт их при answer или registerDevice |
| P1-2 | api `index.js:927-939, 995-1010` | Полный SDP в пуше: лимит APNs 5 КБ, FCM 4 КБ → PayloadTooLarge / 500 | В пуше только `callId`, `callerName`, `fromLoyaltyId`; offer — через GET |
| P1-3 | APP / support `1287-1315` | Offer ждём ~4 с; при неудаче звонок сбрасывается без `/end` | Бюджет ~25 с (`offerRetryDelayMs`); при сбое `/end` |
| P1-4 | все клиенты | ICE restart не работает (`restartIce()` без renegotiation), обрыв не обрабатывается; NetInfo ловит только переход offline → online | Re-offer с `iceRestart:true` через сокет; «Переподключение…»; через 15–20 с — завершение с причиной |
| P1-5 | все клиенты | «Разговор» и таймер показываются до установления ICE; `failed` / `connecting` не видны | Таймер с `connectionState === 'connected'`; новые статусы (см. §5) |
| P1-6 | APP `1959-2166`, support `2567-2593` | Исходящий из приложения без таймаута «нет ответа» → бесконечные гудки | Таймер 60 с (лучше общий серверный, S4) |
| P1-7 | WEB / v2: 30 с ожидания | Для звонка через VoIP-пуш 30 с мало: ответ на 25-й секунде опаздывает | 45–60 с; время задаёт сервер |
| P1-8 | APP / support `voipAuth`, calling_v2 `:83-87` | Сокет переподключается со старым JWT, обработчика `connect_error` нет; в режиме `enforce` socket.io больше не переподключится | `auth` как функция со свежим токеном; `connect_error` → refresh → `connect()`; 401 в `voipFetch` → refresh + повтор |
| P1-9 | APP / support Android `193-217` | Ответ из модалки не сообщается в Telecom: системный звонок продолжает звонить и через 3 с обрывает разговор | `answerIncomingCall` + `setCurrentCallActive` на Android |
| P1-10 | APP / support iOS | Исходящий не сообщает CallKit «подключено» (`reportConnectedOutgoingCall`) | Вызывать по ICE connected |
| P1-11 | APP `CallsScreen.tsx` | Второй сокет без JWT с тем же `deviceId` ломает маршрутизацию | Не регистрировать устройство из `CallsScreen` |
| P1-12 | APP iOS `AppDelegate` | `PKPushRegistry` создаёт только JS после PersistGate → CallKit звонит позже, а при сбое JS не звонит вовсе | Регистр в `AppDelegate.didFinishLaunching` + `coldStart` (как в support app) |
| P1-13 | все | Нет состояния «занято»: входящий во время разговора рвёт текущий звонок или висит без ответа | Ответ «занято» (`/reject`, reason busy); на сервере — признак «в звонке» |
| P1-14 | WEB, v2 | События `call-state ended/rejected` без проверки callId; сброс во время подготовки «воскрешает» звонок | Сверять callId, после каждого `await` проверять токен попытки |
| P1-15 | WEB, v2 | Нет рингтона, Notification и web-push для входящих; фоновая вкладка звонок пропускает | `<audio loop>`, Notification с `requireInteraction`, web-push через service worker |
| P1-16 | Android (APP, support) | Нет FGS на время звонка: при переключении приложений микрофон отключается (Android 11+), процесс могут убить | Свой FGS `phoneCall\|microphone` с начала звонка |
| P1-17 | APP / support | Лишние паузы 500+100+500+2000+100 мс, ожидание сокета до 4,5 с, `GET /api/calls/:id` на каждый кандидат | Убрать паузы, отправлять answer сразу после `setLocalDescription`, ICE-серверы загружать заранее |
| P1-18 | api `socketGate` + `/api/calls*` | Не проверяется, что отправитель — участник звонка; `fromLoyaltyId` можно подделать | Брать личность из JWT, сверять с участниками |

### P2

- APNs: один провайдер (production или sandbox), поэтому debug-сборки не получают пуши; `expiry` и `priority` не заданы; пакет `apn` не поддерживается.
- В iOS-пуше `handle`/`from` — токен самого адресата, а не звонящего.
- `loyaltyIdToDeviceId` без нормализации пробелов: поиск в памяти промахивается.
- Широковещательный `user-status` / `get-users-status` раскрывает онлайн-статус всех пользователей.
- Отклонение в CallKit / Telecom и в панели отправляет `/end` вместо `/reject`.
- После выхода и повторного входа в totus_APP не восстанавливаются FCM `onTokenRefresh`, NetInfo, AppState.
- В логах пишутся SDP и кандидаты целиком (IP-адреса, объём).
- `calling_v2@develop`: TURN-учётка в бандле, нет JWT. Переводить прод на `main` можно только после W3.

## 5. Статусы для пользователя (предложение)

Сейчас все этапы до ответа видны как «Вызов…», а сразу после SDP показываются «Разговор» и таймер, хотя звука ещё нет.

| Этап | Звонящий видит | Принимающий видит |
|---|---|---|
| Звонок создаётся, пуш отправлен | «Вызов…» | — |
| Сервер: пуш доставлен в APNs/FCM, сокета нет | «Абонент получает звонок…» | системный экран звонка |
| Ответ нажат, загружается offer / микрофон / ICE | «Соединение…» | «Соединение…» (CallKit: connecting) |
| ICE connected | «Разговор» + таймер | «Разговор» + таймер |
| ICE disconnected | «Переподключение…» | «Переподключение…» |
| Нет восстановления 15–20 с | «Связь прервалась» | то же |
| Пуш не доставлен (502) / нет устройства | «Абонент недоступен» | — |
| Нет ответа 60 с | «Не отвечает» | пропущенный |
| Отклонён / занят | «Отклонён» / «Занято» | — |

Если соединение идёт дольше 5 с, под «Соединением…» показывать подсказку «Устанавливаем защищённое соединение, это может занять до 15 секунд».

## 6. Логирование (чтобы видеть, на каком этапе сбой)

**Сервер.** Журнал `call_events {ts, callId, side, deviceId, event, data}` со следующими событиями:
- `create`;
- `callee.resolved` (`path: mem|db`, платформа, живой ли сокет);
- `offer.socket_emit` (с ack);
- `push.result` (provider, topic, status, reason, payloadBytes);
- `offer_fetched`;
- `answer.received` / `answer.delivered`;
- `candidate` (счётчики);
- `end` / `reject` / `timeout` с причиной.

Отдельно: `GET /api/calls/:id/trace` для staff. Убрать из логов SDP и полные кандидаты.

**Клиенты.** Трасса этапов с `callId` и временем:
`push_received → callkit_reported → js_ready → answer_tap → offer_fetched → mic_ok → answer_sent → first_remote_candidate → ice_connected (тип пары из getStats) → ended(reason)`.

- По завершении звонка трасса уходит на `POST /api/calls/:id/events`, в мобильных приложениях — ещё и в Crashlytics.
- Добавить `connect_error` сокета и лог режима `/api/ice-servers` (есть ли TURN).
- На сайте сейчас нет ни одного лога звонка.

## 7. Что проверить на сервере (нужен доступ владельца)

- В логе pm2 `calling_api_v2`:
  - `[apn] multi-topic VoIP enabled` — задеплоен ли PR #7;
  - `[apn] failed` с причинами;
  - `[fcm] send error`;
  - `[ice] … stun-only` — работает ли TURN.
- Задан ли `FIREBASE_CREDENTIALS_PATH`, и есть ли в Firebase-проекте Android-приложения `com.totusclubapp` и `club.totus.support`.
- Значение `APN_PRODUCTION`: debug-сборки с sandbox-токеном не получат пуш.
- Какая ветка `calling_v2` на проде (`develop` или `main`).
- Собирается ли `totus_APP@main` под Android без локальных файлов (см. §0 п. 4).

### Результаты проверки сервера (владелец, 02.10)
- **PM2:**
  - `api_calling` → `/home/calling_api_v2`, ветка `prod`;
  - `front_calling` → `/home/calling_v2`, ветка **`main`** — то есть W3 (на `/chat` агент не принимает звонки) уже на проде;
  - аптайм около 20 ч.
- `APN_PRODUCTION=1`.
- **Последние 3000 строк лога `api_calling`:**
  - **`[apn] failed` — 10 раз, `BadDeviceToken` и `DeviceTokenNotForTopic`.**
    - `DeviceTokenNotForTopic` в итоговой ошибке значит, что повтор с topic Support App (PR #7) не сработал: либо процесс не перезапущен после слияния, либо у сборки Support App другой bundle id. Строки `multi-topic VoIP enabled` в окне нет, но она пишется только при старте — нужно проверить весь файл лога.
    - `BadDeviceToken` при `APN_PRODUCTION=1` — sandbox-токены отладочных сборок из Xcode или старые токены. Сервер их не очищает (S5).
  - **`[fcm] … not a valid FCM registration token` — повторяется.** Подтверждает S2: веб-клиенты пишут `voipToken = web-…`, сервер принимает его за Android-токен и шлёт FCM. Firebase при этом инициализирован (ошибка на уровне токена, а не настройки).
  - `stun-only = 0` ничего не доказывает: предупреждение пишется другим текстом («отдаю только STUN») и один раз после старта. Режим TURN не подтверждён.

- **Уточнение (владелец, 02.10):**
  - **PR #7 задеплоен.** На сервере `b4349fc` (слияние #7), `multi-topic VoIP enabled` в логе 3 раза — по разу на каждый старт. `APN_VOIP_TOPIC_ALT` не задан, поэтому используется значение по умолчанию `club.totus.support.voip`. Оно совпадает с bundle id Support App (`club.totus.support`, team `C6258722D6`).
    - Ошибки `DeviceTokenNotForTopic` в логе, вероятно, остались от времени до перезапуска. Проверяем живым звонком: должна появиться строка `[apn] VoIP push delivered with topic club.totus.support.voip`.
  - **TURN** — `TURN_SECRET` есть, предупреждения «только STUN» в логе ошибок нет: режим ephemeral, relay работает.
  - **Firebase** — `FIREBASE_CREDENTIALS_PATH` задан, FCM отправляется. Ошибки только от токенов `web-…` (S2).
  - **`APN_PRODUCTION=1`** — пуши уходят только через production APNs. Обе сборки Debug подписаны с `aps-environment=development` (это sandbox-токены), поэтому VoIP-звонки проверяем только на TestFlight / Release.

## 8. Предлагаемый порядок (на решение владельца)

1. **Быстро, без риска:**
   - A1 — применить патч support app;
   - проверки §7 на сервере;
   - A6 — ранний запрос микрофона.
2. **Сервер:**
   - S1 (устаревший disconnect);
   - S2 (не затирать voipToken вебом);
   - S5 (честный ответ при сбое пуша);
   - S6 (платформа после рестарта);
   - P1-2 (без SDP в пуше);
   - S4 (state + таймаут + отмена).

   Это небольшие изменения в `index.js`, и они чинят большую часть «тишины» и «гудков в никуда».
3. **totus_APP:** перенести наработки PR #1 (A2, A3, P1-3, P1-8, P1-12) и разобраться с Android-нативом (A4).
4. **Веб:** W1–W3, P1-1, P1-7, P1-15.
5. **Статусы и логирование (§5, §6)** — на всех клиентах одним этапом, вместе с серверным `call_events`.
6. **Android-платформа:** A5, P1-9, P1-16. Объёмная работа: `selfManaged`, FGS, full-screen.
7. **Мультиустройство (S3)** — отдельный этап, меняет модель данных.
