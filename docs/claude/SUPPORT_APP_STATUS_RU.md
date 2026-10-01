# Totus Support App — статус (обновлено 30.09.2026)

Репозиторий: https://github.com/tosmedia/totus_support_app (ветка main)
Backend PR: tosmedia/calling_api_v2 #7 (claude/support-app-voip-topic → prod) — VoIP-пуши с topic `club.totus.support.voip` (lib/apnTopics.js, env APN_VOIP_TOPIC_ALT). Мержит владелец.

## Что это
React Native 0.79 (старая архитектура, Hermes), iOS + Android, bundle `club.totus.support`.
Вход агентом (`POST /api/web/login`, role agent), тот же backend calling_api_v2, без моков.
Референсы: calling_v2 (логика поддержки, Support Chat), totus_APP (VoIP-движок VoipService.ts перенесён почти дословно).

## Экраны
Чаты (фильтры, поиск, пагинация, real-time), Диалог (история, typing, read, clientMsgId, «Позвонить», «Взять себе», «Закрыть»), Пользователи (онлайн/VoIP, звонок, доступ), Звонки (журнал на устройстве), Профиль (подключения, STUN/TURN, батарея, выход). Экран звонка + свёрнутая плашка, CallKit/ConnectionService.

## Что должен сделать владелец
1. Firebase: Android-приложение `club.totus.support` в том же проекте → `android/app/google-services.json` (обязателен). iOS — опционально.
2. Apple: App ID `club.totus.support` (Team C6258722D6), Push + Background Modes (VoIP, Audio, Remote notifications).
3. Смержить и задеплоить calling_api_v2 PR #7 (иначе на iOS нет VoIP-пушей в закрытое приложение).
4. `npm install`, `cd ios && pod install`, сборка; VoIP-пуши в закрытое приложение проверять на TestFlight.

## Ограничения backend
- Одно устройство на учётку (один voipToken/socketId) — отдельная agent-учётка на сотрудника.
- Выход = unregister-device.
- Пушей сотрудникам о сообщениях backend не шлёт — только локальные уведомления, пока жив сокет.
- История звонков — локально (сервер не хранит).
- Диалог создаёт пользователь; сотрудник может позвонить без диалога.

## Проверки
Сборка в облачной среде невозможна (npm registry закрыт). Сделано: typecheck на заглушках типов, юнит-тест утилит, ревью субагентом, сверка SHA всех файлов в репозитории (pbxproj отличается только отсутствием завершающего перевода строки).

С 30.09 в репозитории заводится набор `npm run check` (Node ≥ 22.18, без `npm install`): `scripts/check-voip-answer-recovery.mjs` — 16 проверок.

---

## 30.09 — ответ на звонок из закрытого приложения / фона / экрана блокировки

**Статус:** [PR #1](https://github.com/tosmedia/totus_support_app/pull/1), ветка `claude/support-voip-background-answer`. В ветке 7 файлов (SHA сверены). `VoipService.ts` владелец применяет патчем: коннектор не пропускает 196 КБ. Меняется только приложение, сервер не трогаем (решение владельца).

### Как должно работать
VoIP-пуш → CallKit → «Ответить» → звонок соединяется сам, **без открытия приложения**. Так же стабильно, как при открытом приложении.

### Путь звонка (iOS) после исправления
1. PushKit → `AppDelegate.didReceiveIncomingPushWith` → `VoipPushHelper` + `CallKeepHelper.reportIncomingCall` (CallKit звонит без JS).
2. Сразу после этого `startReactNativeInBackgroundIfNeeded()` запускает React Native **без окна**: сцены при фоновом запуске нет.
3. `index.js` → `bootstrapVoipFromStoredSession()` → `initVoipAndCallKeep(loyaltyId)` из сохранённой сессии (AsyncStorage, до UI).
4. «Ответить»:
   - обработчики уже есть → `answerCall` → `handleAnswerCall`;
   - если ответ был раньше, чем поднялся JS → очередь CallKeep (`getInitialEvents`) → `processPendingAnswer`.
5. Оффер → WebRTC → ответ на backend (с `deviceId`) → ICE. `didActivateAudioSession` от CallKit → `RTCAudioSession.audioSessionDidActivate()` (звук на экране блокировки).
6. Если потом открыть приложение, сцена показывает тот же root view: второго JS нет, звонок не пересоздаётся.

### Причины поломки
1. **Главная.** React Native стартовал только при подключении сцены, то есть при открытии приложения (SceneDelegate, коммит «fix ios 27»). При фоновом запуске от PushKit JS не работал, и соединять звонок было некому.
2. На iOS очередь CallKeep не читалась (только Android), поэтому ответ, сделанный до старта JS, терялся.
3. Отложенный ответ обрабатывался до 5 раз. Каждый раз создавался новый `RTCPeerConnection` и затирал предыдущий.
4. Поздний пуш возвращал состояние «ringing». Ответ уходил без `deviceId`. Оффер запрашивался всего 4 с.
5. На iOS активация аудио от CallKit не передавалась в WebRTC — риск звонка без звука.
6. Сокет после долгого фона подключался с просроченным токеном.
7. При сбое экран оставался в «answered».

### Что изменено
- `ios/TotusSupport/AppDelegate.swift`:
  - `startReactNativeInBackgroundIfNeeded()` через `rootViewFactory.view(withModuleName:)`;
  - `startReactNative(in:)` переиспользует фоновый root view.
- `index.js` + `src/voip/coldStart.ts` — подъём движка звонков до UI (iOS).
- `src/voip/answerRecovery.ts` — чистая логика:
  - события CallKeep, включая аудио;
  - «один ответ на звонок»;
  - паузы запроса оффера;
  - решение при возврате в приложение.
- `src/voip/VoipService.ts`:
  - восстановление ответа на обеих платформах;
  - идемпотентный `schedulePendingAnswer`;
  - ожидание `deviceId`;
  - AppState `active`;
  - очистка при сбое;
  - защита от позднего пуша;
  - `RTCAudioSession` для CallKit.
- `src/api/voipAuth.ts` — refresh токена перед handshake сокета.
- `scripts/check-voip-answer-recovery.mjs` + `"check"` в `package.json`.

### Проверка на устройстве (владелец)
Все проверки — на сборке TestFlight/Release. Приложение **не открывать**, отвечать только в CallKit.
1. Закрыть приложение смахиванием, заблокировать телефон → позвонить с сайта → «Ответить» на экране блокировки → голос в обе стороны без разблокировки.
2. Приложение в фоне больше 30 минут, телефон заблокирован → то же самое.
3. Разблокированный телефон, приложение закрыто → «Ответить» в баннере → соединение; затем открыть приложение → тот же звонок, без переподключения.
4. «Ответить» и сразу «Завершить» → у звонящего звонок завершается.
5. Два звонка подряд с экрана блокировки → оба соединяются.

Если что-то не так — прислать лог Xcode (Console, фильтр `TotusSupport`) со строками `React Native started in background`, `Recovered answer`, `processPendingAnswer`, `audio session`.

### Известные ограничения
- Первый звонок после установки или перезагрузки телефона до первой разблокировки: AsyncStorage недоступен, сессию не прочитать. Это ограничение iOS.
- Android в этой части не менялся: «Ответить» поднимает приложение через `backToForeground`.
