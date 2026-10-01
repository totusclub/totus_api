# TOTUS — аудит секретов в репозиториях (Б.1)

**Дата:** 01.09.2026. **Режим:** только чтение, ничего не изменено. Значения секретов в документе не приводятся — только тип, место и маска (первые 4 символа + длина).
**Важно:** всё, что хоть раз попало в коммит, остаётся в истории git навсегда. Удаление из текущей версии не отменяет утечку — ключи из §3 нужно **перевыпустить**.

GitHub Advanced Security / secret scanning на репозиториях организации **выключен** (сканер `run_secret_scanning` отвечает «not enabled») — ни push-protection, ни авто-отзыва утёкших токенов нет.

---

## 1. Найденные секреты

| # | Репо (ветка) | Где | Что | Маска | Как задано | История |
|---|---|---|---|---|---|---|
| 1 | totus_API (main) | `.env` | MySQL host/user/password (старый хост `213.109.202.180`, user `root`) | `your…(20)` | файл `.env` в репо, `.gitignore` без `.env` | 6 коммитов с 23.06.2025 |
| 2 | totus_API | `.env` | `JWT_SECRET` (общий для totus_API / calling_api_v2 / totus_ai_v2) | `99a8…(128)` | файл | то же |
| 3 | totus_API | `.env` | старый `JWT_SECRET` (закомментирован) | `04b2…(128)` | файл | то же |
| 4 | totus_API | `.env` | `JWT_REFRESH_SECRET` | `8b68…(128)` | файл | то же |
| 5 | totus_API | `.env` | пароль приложения Яндекс-почты (`tokclub@yandex.ru`) | `mvxr…(16)` | файл | то же |
| 6 | totus_API | `.env` | `PARTNER_API_KEY` (Level.Travel, подпись callback'ов) | `305a…(64)` | файл | то же |
| 7 | totus_API | `.env` | `LT_CLIENT_AUTH_TOKEN` | `384f…(36)` | файл | то же |
| 8 | totus_API | `app.js:55`, `utils/levelTravelHttp.js:8`, `levelTravelPayment.js:10`, `levelTravelClientOrder.js:13`, `vtbCallback.js:10` | Level.Travel partner token | `6a6c…(32)` | env с fallback на литерал | вся история |
| 9 | totus_API | `app.js:597, 1350, 1441, 1449` | тот же LT token — **чистый литерал** (заголовок и ключ подписи) | `6a6c…(32)` | литерал | вся история |
| 10 | totus_API | `app.js:576, 1297`, `utils/vtbCreatePayment.js:16, 114` | VTB `client_id` / `X-IBM-Client-Id` | `wb1a…(63)` | литерал | вся история |
| 11 | totus_API | `app.js:577`, `utils/vtbCreatePayment.js:17` | **VTB `client_secret`** | `XMB2…(16)` | литерал | вся история |
| 12 | totus_API | `app.js:1298`, `utils/vtbCreatePayment.js:115` | VTB `Merchant-Authorization` | `93f6…(36)` | литерал | вся история |
| 13 | totus_API | `app.js:599` | LT `Cookie: uuid=…` | `e5ce…(36)` | литерал | вся история |
| 14 | totus_API | `controllers/auth.controller.js:217` | Telegram Gateway token | `AAGB…(46)` | литерал | 9 коммитов с 23.06.2025 |
| 15 | totus_API | `index.js:4-5` | SAMO login + пароль (забытый скрипт) | `Wajk…(22)` | литерал | 1 коммит 13.06.2025 |
| 16 | calling_api_v2 (prod) | `db.js:9-12` | MySQL `totus@109.73.206.121` + пароль (**боевая база**) | `f?pJ…(14)` | литерал в коде | 10 коммитов с 06.12.2025 |
| 17 | calling_api_v2 (main) | `db.js:9-12` | MySQL `root@213.109.202.180` + пароль (= #1) | `your…(20)` | литерал | 7 коммитов |
| 18 | calling_api_v2 (prod+main) | `p8/AuthKey_2X2QV7S43J.p8`, `AuthKey_FV2BW9CFNB.p8`, `AuthKey_T2GPU4VQ5W.p8` | **три APNs private key** | — | файлы, `*.p8` не в ignore | с 06.12.2025 |
| 19 | calling_api_v2 | `index.js` | APNs keyId `2X2QV7S43J`, teamId | — | литерал | вся история |
| 20 | calling_api_v2 | `totus-voice-ac1464f87501.json` | **GCP service account** (`totus-voice`) | — | файл | с 11.12.2025 |
| 21 | calling_api_v2 | `totusapp-2ab2b-firebase-adminsdk-fbsvc-c36c3f7233.json` | **Firebase Admin SDK key** (FCM-пуши) | — | файл | с 29.04.2026 |
| 22 | calling_api_v2 | `totusvoice-911c60095e2f.json` | **GCP service account** (TTS) | — | файл | с 11.02.2026 |
| 23 | calling_api_v2 | `index.js:1655` (prod) / `:1533` (main) | DeepSeek API key | `sk-e…(35)` | литерал | с 12.2025 |
| 24 | calling_api_v2 | `tour-assistant/v2/config.js:6` | тот же DeepSeek key | `sk-e…(35)` | env с fallback | — |
| 25 | calling_v2 (main) | `lib/webrtc-service.ts:476-502` (6 мест) | TURN username `test` + credential (**в браузерном бандле**) | `Totu…(18)` | литерал | — |
| 26 | calling_v2 | `lib/webrtc-service.ts:537-538` (закомментировано) | Xirsys username/credential | `3S4j…(84)` / `77c5…(36)` | комментарий | — |
| 27 | totus_WEB (main) | `package.json:13` | **GitHub PAT (classic) пользователя hayk95** в URL зависимости `@tosmedia/ai-assistant` | `ghp_VI0C…(40)` | литерал | с 10.08.2026, 4 коммита; в `package-lock.json` PAT нет |
| 28 | totus_APP (main) | `src/modules/api/deepSeekApi.ts:4` | тот же DeepSeek key (#23) — **в мобильном бандле** | `sk-e…(35)` | литерал | 1 коммит 26.08.2026 |
| 29 | totus_APP | `src/modules/voip/VoipService.ts:1542-1568` (6 мест) | те же TURN-креды, что #25 | `Totu…(18)` | литерал | — |

**Чисто:** `totus_ai_v2` (нет `.env`, всё из env, `.gitignore` с `.env`/`*.pem`/`*.key`), `Totus_admin` (нет `.env`, только публичные URL), `totus_API/db.js`, `lib/auth.js`, `utils/yandex*`, `scripts/*`; `calling_api_v2/lib/*`, `ttsService.js` (только путь к JSON); `totus_WEB/src/config/*`, `useSbpPay.ts`.

## 2. Публичные ключи (ротация не нужна)

Yandex SmartCaptcha sitekey (`totus_APP/src/config/captcha.ts`; на сайте — из `NEXT_PUBLIC_*`), Yandex Metrika id, `APN_VOIP_TOPIC`, `VTB_CALLBACK_URL`. `ios/totusClubApp/GoogleService-Info.plist` — тестовый плейсхолдер (project `test-1aaaa`), не боевой; `android/app/google-services.json` в репо отсутствует. Отдельно на ревью: Apple demo-аккаунт `test@totus.com` / код `1111` обходит капчу и код — не секрет, но точка входа.

## 3. Что перевыпускать (порядок по ущербу)

1. **GitHub PAT hayk95** (#27) — немедленно: classic PAT = доступ ко всем репо пользователя.
2. **Три APNs .p8** (#18) — отозвать в Apple Developer, выпустить один новый ключ.
3. **Три GCP/Firebase service-account ключа** (#20–22) — удалить в IAM, выпустить новые.
4. **VTB** `client_secret` + `Merchant-Authorization` (#11, #12); `client_id` желательно пересоздать парой.
5. **Level.Travel** partner token, `PARTNER_API_KEY`, `LT_CLIENT_AUTH_TOKEN`, cookie uuid (#6–9, #13).
6. **MySQL** пароли `totus@109.73.206.121` и `root@213.109.202.180` (#16, #17, #1); проверить, что `root` не доступен извне.
7. **JWT_SECRET / JWT_REFRESH_SECRET** (#2–4) — общие для трёх сервисов; ротация разлогинит всех — совместить с волной 2 плана JWT.
8. **DeepSeek key** (#23, #24, #28) — после ротации убрать из приложения (ходить через бэкенд).
9. **TURN credential** (#25, #29) — статический пароль в клиентских бандлах; перейти на ephemeral-креды coturn (`use-auth-secret`), выдаваемые бэкендом. Xirsys (#26) — отозвать, если аккаунт жив.
10. Яндекс app-password (#5), Telegram Gateway token (#14), SAMO (#15).

## 3.1. Дополнение 01.09 (найдено при выносе секретов из totus_API)

- `utils/levelTravelWebhooks.js`: fallback `process.env.PARTNER_API_KEY || '589e…'` — ключ проверки **входящего** заголовка `Partner-Api-Key` от Level.Travel; значение отличается от `PARTNER_API_KEY` в старом `.env` (`305a…`). Какой из двух реально присылает LT — выяснить у LT, положить в `.env`, литерал убрать отдельным коммитом.
- В серверном `.env` totus_API **не было** `LT_API_TOKEN`, `VTB_CLIENT_ID`, `VTB_CLIENT_SECRET`, `VTB_MERCHANT_AUTH` — прод работал на литералах из кода. После мержа PR #4 без этих переменных LT и ВТБ перестанут работать.

## 4. Что делать в репозиториях (после подтверждения)

**Статус 02.09:**
- `totus_API` — PR [#4](https://github.com/tosmedia/totus_API/pull/4) **смержен, задеплоен**: в `main` нет `.env` и `index.js` (SAMO), литералы → env. Проверка прода 02.09: `/references/departures` 200 (LT_API_TOKEN из `.env` работает), `/customer-auth/refresh-token` отвечает, `/home/data` 200.
- `calling_api_v2` — PR [#2](https://github.com/tosmedia/calling_api_v2/pull/2) **смержен в `prod`, задеплоен**: в ветке нет 3 `.p8` и 3 JSON (#18, #20–22); `index.js` blob `70f5ab96…`, `db.js` `5887d985…` (пушены push_secrets_voip.sh, сверено). Проверка прода 02.09: `/api/health` `{ok:true}`, `/api/tts/synthesize` 200 (GOOGLE_APPLICATION_CREDENTIALS работает). `[apn]`/`[fcm]` в pm2-логах и тестовый iOS-звонок — на владельце.
- **Ротация ключей** (§3) — на владельце; удаление из веток не отменяет утечку в истории.
**Статус 02.09 (вечер): этап «клиенты + PAT» полностью смержен и задеплоен.** `totus_WEB` #4, `calling_api_v2` #3 и #4 (main ← prod), `calling_v2` #6, `totus_APP` #2 — все смержены; `GET /api/ice-servers` на проде отвечает `mode: static` (вариант Б — новая статическая пара в `.env`, coturn `lt-cred-mech`); в собранном бандле calling.totus.club старого TURN-пароля нет. Осталось из Б.1: релиз приложения в сторы → через 2–3 недели удалить пользователя `test` в coturn (и при желании перейти на вариант А `use-auth-secret` — код готов, достаточно задать `TURN_SECRET` вместо `TURN_STATIC_*`); перепубликация пакетов `pkg/*` и `npm update @tosmedia/ai-assistant` на сайте; ответ LT по webhook-ключу (§3.1); включить GitHub Advanced Security; по желанию `git filter-repo` после всех ротаций.

Детали PR этапа:
  - `totus_WEB` [PR #4](https://github.com/tosmedia/totus_WEB/pull/4) `claude/secrets-web` (#27): `package.json` — зависимость `@tosmedia/ai-assistant` → `github:tosmedia/totus_ai_v2#pkg/ai-assistant` (в `package-lock.json` PAT не было, менять не нужно — lock резолвит `git+ssh`, пин `27ed576`/v1.0.10); `.idea/` удалён и в `.gitignore`. До деплоя: отозвать PAT hayk95, deploy key на сервере (команды в PR).
  - `calling_api_v2` [PR #3](https://github.com/tosmedia/calling_api_v2/pull/3) `claude/ice-servers`: `GET /api/ice-servers` (lib/iceServers.js + правило в middleware/auth.js, index.js не тронут). Режимы: ephemeral (TURN_SECRET, HMAC-SHA1 как в coturn use-auth-secret, TTL 12ч), static (TURN_STATIC_USERNAME/CREDENTIAL из .env), stun-only (ничего не задано). `.env.example`/`lib/env.js` — TURN_*, STUN_URLS, TURN_URLS.
  - `calling_v2` [PR #6](https://github.com/tosmedia/calling_v2/pull/6) `claude/secrets-calling` (#25, #26): webrtc-service.ts — 6 TURN-литералов и Xirsys-комментарий удалены, `fetchIceServers()` через authFetch с кэшем и STUN-фолбэком; файл пушен через API (SHA `92b1a830`), классификатор больше не блокирует.
  - `totus_APP` [PR #2](https://github.com/tosmedia/totus_APP/pull/2) `claude/jwt-app` → main, draft (#28, #29): `deepSeekApi.ts` удалён (мёртвый код, проверено — 0 импортов); VoipService.ts с `fetchIceServers()` (SHA `71f45123`) пушится скриптом `Claude/Totus Club/Dev/secrets-app/push_secrets_app.sh` на Mac. Волна 5 (PR #1) уже смержена в main 01.09.
  - `calling_api_v2` [PR #4](https://github.com/tosmedia/calling_api_v2/pull/4) `prod` → `main`: синхронизация, убирает из `main` утёкшие ключи (#17, #18, #20–23).
- Решения владельца: где стоит coturn (Q3) и вариант А (use-auth-secret) или Б (новая статическая пара); удаление TURN-пользователя `test` — только через 2–3 недели после релиза приложения.


- **Удалить из репо:** `totus_API/.env`, `totus_API/index.js` (SAMO-скрипт); `calling_api_v2/p8/*.p8` и три JSON сервисных аккаунтов — на ветках `prod` и `main`; мусор `.idea/`.
- **`.gitignore`:** totus_API — `.env`, `.env.*`, `!.env.example`, `*.p8`, `*.pem`, `*.key`, `*-firebase-adminsdk-*.json`; calling_api_v2 — `p8/`, `*.p8`, `*.pem`, `*.key`, `*service-account*.json`, `*-firebase-adminsdk-*.json`, `totus-voice-*.json`, `totusvoice-*.json`, `.idea/`, `data/`; totus_WEB — `.idea/`.
- **Код: литерал → env без fallback:** totus_API — `LT_API_TOKEN` (5 файлов + 4 inline в app.js), `VTB_CLIENT_ID` / `VTB_CLIENT_SECRET` / `VTB_MERCHANT_AUTH`, `TELEGRAM_GATEWAY_TOKEN`; calling_api_v2 — `db.js` на `DB_*`, `DEEPSEEK_API_KEY` без fallback, `APN_KEY_PATH` / `APN_KEY_ID` / `APN_TEAM_ID`, `GOOGLE_APPLICATION_CREDENTIALS` / `FIREBASE_CREDENTIALS_PATH`; calling_v2 и totus_APP — TURN-креды с бэкенда (эндпоинт `GET /api/ice-servers` с ephemeral-кредами) вместо литералов.
- **`totus_WEB/package.json`:** `@tosmedia/ai-assistant` → `github:tosmedia/totus_ai_v2#pkg/ai-assistant`; на сервере — git-credentials (deploy key на totus_ai_v2, read-only).
- **История git:** после ротации — по желанию `git filter-repo` на totus_API, calling_api_v2, totus_WEB (без ротации бессмысленно).
- **Организация GitHub:** включить secret scanning + push protection (GitHub Advanced Security), чтобы это не повторялось.
