# TOTUS / Totus Club — обзорная карта проекта

**Назначение:** стартовый документ для управления проектом из Claude-проекта «Totus Dev». Собран 27.08.2026 по девяти MD-файлам документации (`docs/*`), которые были сгенерированы по коду и prod-серверу 26.08.2026. Доступ к коду: **GitHub-коннектор** подключён к чату-оркестратору (чтение/запись, см. §3.1); сборка и тесты — локально или в чате с привязанным репо (правила git — оркестратор §3.5).

---

## 1. Продукт

**Со слов владельца (27.08.2026):** Totus Club — туристическая платформа, которая на данный момент позволяет делать **поиск по турам** (пакет с перелётом) и **поиск по отелям** (только проживание). Работает с базой **Level.Travel**. К платформе подключены два инструмента:

- **Телефония** — агент поддержки звонит клиенту прямо в приложение: репозитории `calling_v2` (панель агента в браузере) и `calling_api_v2` (signaling), WebRTC в приложении iOS и Android.
- **ИИ-ассистент «Мила»** — умный личный ассистент, персональный турагент пользователя: подбирает туры, показывает отели и номера, отвечает на вопросы и заводит в обычную воронку бронирования.

Каналы: сайт totus.club, мобильное приложение Totus Club (iOS/Android), плюс standalone-хост Милы ai.totus.club.

### 1.1. Техническая карта

Семь сервисов (админка пока не задеплоена) на одном prod-сервере `109.73.206.121` (Ubuntu 22.04, nginx + PM2 + MySQL `kedam`):

| Сервис | Репо | Prod URL | Порт | Стек |
|---|---|---|---|---|
| Сайт | `tosmedia/totus_WEB` | totus.club | 3000 | Next.js 15 (Pages Router), React 19, Redux, CSS Modules, шрифт Golos Text |
| Backend туров/заказов/CMS | `tosmedia/totus_API` | api.totus.club | 3001 | Express 5, raw SQL, ~108 endpoints |
| Мобильное приложение | `tosmedia/totus_APP` | — (iOS `app.totus.club`, Android `com.totus.com`) | — | Bare RN 0.79, Redux-persist, CallKeep/WebRTC |
| AI-ассистент «Мила» | `tosmedia/totus_ai_v2` | apiv2.totus.club / ai.totus.club | 3011 / 3012 | Express + WS + DeepSeek (OpenAI SDK), Next host, два UI-пакета |
| Админка звонков (агенты) | `tosmedia/calling_v2` | calling.totus.club | 3008 | Next 14, WebRTC |
| VoIP backend | `tosmedia/calling_api_v2` | voip.totus.club | 4444 | Express + Socket.io + APNs, monolith `index.js` |
| Админка | `tosmedia/Totus_admin` | admin.totus.club *(план)* | 3009 | Next 14; выделена из `calling_v2` 27.08.2026, см. `ADMIN_DOCUMENTATION_RU.md` |

Внешние интеграции: Level.Travel API (туры, заказы, webhooks), ВТБ Open API (СБП QR), Yandex SmartCaptcha / Postbox / Maps / Metrika, Telegram Gateway, DeepSeek, Google TTS (legacy), APNs.

Основная пользовательская воронка (сайт и приложение одинаковы):

- **Тур (package):** поиск → отель → перелёт (`/tickets`) → бронирование → checkout → СБП → `/pay`
- **Отель (hotel-only):** поиск → отель → бронирование → checkout → СБП → `/pay` (признак `search_type=hotel`, шаг перелёта пропускается)

Заказы живут в `totus_API` (`orders`), история AI-чатов — в той же MySQL (`ai_chats`), пользователи — общая таблица `users` (её же использует VoIP для агентов). Собственной базы туров нет — LT является источником правды по турам, ценам и статусам заказов; своё у платформы — пользователи, лояльность, платежи (СБП/ВТБ), документы, письма, CMS, ИИ и телефония.

---

## 2. Как работать с документацией

Один сервис = один MD в `docs/`. Правило из оркестратора: **при конфликте MD и кода — код прав**, MD обновляется после изменения.

| Вопрос | Документ |
|---|---|
| Куда идти с задачей, cross-repo сценарии | `CLAUDE_ORCHESTRATOR_RU.md` |
| HTTP-контракты kedam, оплата, LT, CMS, auth | `API_DOCUMENTATION_RU.md` |
| Страницы сайта, Redux, API-клиенты, storage-ключи | `WEB_DOCUMENTATION_RU.md` |
| Навигация RN, VoIP в приложении, AI-таб | `APP_DOCUMENTATION_RU.md` |
| Мила: WS-протокол, tools, промпт, публикация пакетов | `AI_DOCUMENTATION_RU.md` |
| Агентская панель звонков | `CALLING_FRONT_DOCUMENTATION_RU.md` |
| Админ-панель (users, orders, CMS) | `ADMIN_DOCUMENTATION_RU.md` |
| Signaling, APNs, users/contacts/favorites | `CALLING_API_DOCUMENTATION_RU.md` |
| Порты, PM2, nginx, env-имена, git remotes на сервере | `SERVER_CONFIG_RU.md` |
| TLS/TSPU, история nginx | `SERVER_TLS_CONFIG_RU.md` |
| Открытые вопросы и история ответов | `QUESTIONS_RU.md` |
| Живая доска задач (статусы кликаются) | Totus Dev Board — https://claude.ai/code/artifact/3b90e109-54eb-4013-8995-fecd72664e73 |
| Дизайн-библиотека сайта (макеты из кода) | Totus Design Library — https://claude.ai/code/artifact/47b38de9-9ad6-408c-9af7-98d79e3138cb |
| Планы развития, порядок фаз, архитектурные решения | `ROADMAP_RU.md` |

---

## 3. Ключевые риски (сводно по всем докам)

Отсортировано по серьёзности. Это не мои находки, а то, что уже зафиксировано в документации — здесь собрано в один список, чтобы планировать.

**Критично (безопасность):**

1. `calling_api_v2`: все маршруты **без авторизации** (любой может получить список пользователей, PATCH `access`), пароли агентов **в plaintext**, CORS `*`, DB-креды и ключи APNs/DeepSeek в репо. **(01.09: JWT-гейт в log-режиме, bcrypt, CORS-whitelist — см. `SECURITY_JWT_PLAN_RU.md`; enforce — после релиза приложения; креды в репо — **Б.1 закрыт 02.09**: ключи вынесены в `.env`/файлы вне git и ротированы.)**
2. `totus_API`: почти все `/api/admin/*` CMS-маршруты **без JWT**; `GET /user/orders?user_id=` не проверяет владельца (IDOR); hardcoded LT/VTB/Telegram-секреты в исходниках; `rejectUnauthorized: false` к ВТБ; admin JWT живёт `10s` (фактически нерабочий). **(01.09: JWT-гейт в log-режиме на `/api/admin/*` и user-маршрутах с проверкой владельца, staff JWT 12 ч / 30 д, helmet + CORS + rate-limit — см. `SECURITY_JWT_PLAN_RU.md`; enforce + ротация `JWT_SECRET` — волна 2; секреты в исходниках и `.env` в git — **Б.1 закрыт 02.09** (PR totus_API#4).)**
3. Сервер: **MySQL 3306 открыт наружу** (0.0.0.0), UFW выключен, root-пароль SSH ранее попадал в чат.
4. ~~`totusapp`: DeepSeek-ключ, TURN-креды зашиты в бандл~~ — **закрыто 02.09** (totus_APP#2: `deepSeekApi.ts` удалён, TURN через `GET /api/ice-servers`; в силе после релиза новой версии в сторы). Captcha sitekey — публичный ключ, не секрет.

**Сломано / несоответствия:**

5. ~~`calling_v2` ходит на `server.totus.club`~~ — **исправлено в коде** (`lib/server.ts` → `voip.totus.club`, док был устаревшим). Legacy AI/TTS в приложении по-прежнему указывает на несуществующий `server.totus.club`.
6. STUN/TURN `stun1/2`, `turn1/2.totus.club` — на этом сервере не слушают; где они живут — неизвестно.
7. Семантика поля `users.access` противоречива в трёх местах (login SQL: `0` = разрешён; комментарий: `1` = enabled).
8. `totusapp`: скрипт `generate-autolinking.js` отсутствует; `android:clean` удаляет не тот applicationId; ATT-хук есть, а `NSUserTrackingUsageDescription` в plist — нет; entitlements `aps-environment = development`.
9. `totus_API`: `package.json` `main` указывает на SAMO-эксперимент, не на `app.js`; нет `start`-скрипта.

**Технический долг:**

10. Тестов нет нигде (кроме одного smoke-теста в RN). `totus_WEB` собирается с `ignoreBuildErrors` / `ignoreDuringBuilds`.
11. Nginx-конфиги, `ssl-totus-tspu.conf`, certbot — только на сервере, не в git.
12. Много inline-логики в `totus_API/app.js` и монолит `calling_api_v2/index.js` (~3100 строк).
13. В `totusapp` — много `*.bak*` файлов и legacy-экранов AI/calls вне навигации.
14. ~~Заказы в админке не реализованы~~ — реализованы в `Totus_admin` (`/orders`, `/lt-orders` → `api.totus.club`), но без auth на totus_API (01.09: единый staff-вход и глобальный Bearer — Totus_admin#3 **смержен**; enforce на API — волна 2).
15. ~~Б.1: PAT в `totus_WEB/package.json`, креды MySQL в `calling_api_v2/db.js`, TURN-креды в `calling_v2`~~ — **закрыто 02.09** (totus_WEB#4, calling_api_v2#2/#3, calling_v2#6; ротация — владелец). Хвосты в `SECURITY_AUDIT_SECRETS_RU.md` §4.

---

## 3.1. Факты из GitHub (проверено коннектором 27.08.2026)

| Репо | Ветки | Последний коммит | Замечания |
|------|-------|------------------|-----------|
| `totus_API` | `main` | 07.08.2026 «test account» | **В репо закоммичен `.env`** (773 байта) — секреты в git, срочно в Фазу 0.2 |
| `totus_WEB` | `main`, `develop`, `dev`, `cahts` | 24.08.2026 | Ветка `cahts` — chat UI WIP (11.2025), см. Q17 |
| `totus_APP` | `main` | 26.08.2026 «first commit» | История перезалита, см. Q18; `APP_DOCUMENTATION_RU.md` лежит в репо |
| `totus_ai_v2` | `main`, `pkg/ai-assistant`, `pkg/ai-assistant-native` | 24.08.2026 | Есть коммиты от Claude (11.08) и Cursor; `ИСТОРИЯ_ПРОЕКТА.md` в репо |
| `calling_v2` | `main`, `develop` | 17.07.2026 | Перенесён 27.08 |
| `calling_api_v2` | `main`, `develop`, `prod` | 17.07.2026 «ai optimisation» | **В репо три JSON service-account Google/Firebase и папка `p8/`** — ключи в git |
| `Totus_admin` | `main` | 27.08.2026 (Claude) | Заполнен из `calling_v2/develop`; сборка и деплой — впереди |

Прочие репо организации (не в документации): `Totus_superadmin`, `Totus_AI_photo`, `Call-APP-call-video-chat-`, `CALL-APP`, `schoolLA` — см. Q16.

Коммиты во всех репо — практически одним автором (Hayk Maruqyan), сообщения вида «small chnages» / «please fix …»; ревью и PR не используются.

---

## 4. Дизайн

Исходный дизайн есть в Figma; многие изменения в платформу вносились **минуя дизайн**. UI-факты из кода: Golos Text везде (web + iOS), light/dark тема на сайте и в приложении, CSS Modules без Tailwind, `theme/` токены в RN.

**Утверждённая схема (30.08.2026): код — источник правды, дизайн «пуллит» из кода.** Библиотека макетов сайта собрана из кода `totus_WEB` и живой главной totus.club (реальные картинки и тексты) и опубликована как design-канвас: **Totus Design Library** — https://claude.ai/code/artifact/47b38de9-9ad6-408c-9af7-98d79e3138cb. Семь артбордов: Главная, Выдача поиска, Страница отеля, Бронирование, Оплата (СБП), Личный кабинет, Дизайн-система (палитра light/dark, типографика, компоненты). После каждого мержа с изменением UI библиотека обновляется из кода (правило §3.7 оркестратора: видимые изменения сначала показываются макетом на этом канвасе, код — после «утверждаю»). Цены и рейтинги на макетах — образцы, не живые данные.

---

## 5. Чего не хватает для управления отсюда

- **Среда сборки.** Через коннектор код читается и коммитится пофайлово, но собрать, прогнать тесты или сделать массовый рефакторинг можно только в чате с привязанным репозиторием (claude.ai/code) или локально на Mac — см. `GIT_WORKFLOW_RU.md`.
- **Figma-ссылка** на исходный дизайн (опционально, см. §4).
- Доступ к prod-серверу для деплоя **не** нужен Claude напрямую — деплой-шаги описаны в `SERVER_CONFIG_RU.md` §3 и чеклисте оркестратора.

---

## 6. Журнал решений

| Дата | Решение |
|---|---|
| 27.08.2026 | Документация перенесена в проект «Totus Dev»; управление проектом ведётся отсюда |
| 27.08.2026 | Админка выделена из `calling_v2/develop` в `Totus_admin` (`main`); `calling_v2` очищен в PR #1 → `develop`. Обнаружено: `CALLING_FRONT` док описывал ветку `main`, а prod живёт на `develop` |
| 27.08.2026 | Подключён GitHub-коннектор к чату-оркестратору: чтение и запись подтверждены, Q7/Q8 закрыты |
| 27.08.2026 | Добавлен репозиторий `tosmedia/totus_admin` (админка); заведены `QUESTIONS_RU.md` и `ROADMAP_RU.md` |
| 27.08.2026 | Репозитории `calling_v2` и `calling_api_v2` перенесены из `Hayk95/*` в `tosmedia/*`; все ссылки в доках обновлены. На prod-сервере `git remote` в `/home/calling_v2` и `/home/calling_api_v2` нужно перевести на новые URL (`git remote set-url origin …`) — иначе `git pull` при деплое будет тянуть старый репо |
| 30.08.2026 | Собрана и опубликована **дизайн-библиотека сайта** (Totus Design Library, design-канвас): 7 артбордов из кода `totus_WEB` с реальными картинками; схема «код → дизайн» запущена |
| 31.08.2026 | Репозитории `kedam_API` → `totus_API`, `kedam_WEB` → `totus_WEB` переименованы на GitHub (владелец); `git remote` на сервере обновлён. Папки на сервере и база `kedam` оставлены как есть. PR #1 и #2 по обращениям («Изменить заказ») в обоих репо смержены в `main` 28.08 |
| 01.09.2026 | Волны 1 и 3 плана JWT (`SECURITY_JWT_PLAN_RU.md`) смержены и задеплоены в log-режиме: `totus_API#3`, `totus_WEB#3`, `calling_api_v2#1`, `calling_v2#5` (живые проверки прошли; на сервере создан `/home/calling_api_v2/.env`). PR `Totus_admin#3` (волна 2, единый staff-вход) открыт — ждёт согласования текстов экрана входа. Ограничение инструмента: файлы >~60 КБ и файлы с секретами не проходят через GitHub-коннектор — большие правки через `push_wave3.sh` на Mac владельца |
| 02.09.2026 | **Б.1 (вынос секретов) завершён по всем репо**: смержены totus_API#4, calling_api_v2#2/#3 (`GET /api/ice-servers`, режим static)/#4 (main ← prod), calling_v2#6, totus_APP#2 (+ волна 5 #1 днём ранее), totus_WEB#4 (PAT удалён; в package-lock PAT не было). Волны JWT 2 (клиентская часть), 4, 5 смержены 01–02.09. Ключи ротированы владельцем (APNs — новый после подсказки, что старый `2X2QV7S43J` переиспользовался). Осталось: релиз приложения → удалить TURN-пользователя `test` (2–3 нед.), перепубликация пакетов `pkg/*` + обновление зависимости сайта, enforce (волны 2/6), LT webhook-ключ, GitHub Advanced Security |
| 03.09.2026 | **Теги выбранных фильтров над списком отелей** (Figma List / Tours) — по §3.7 сначала канвас «Теги фильтров над списком» (артефакт f0bf5814-ba77-436e-8151-968c73c1f7bf, до/после для десктопа, мобайла и приложения), после «утверждаю» — PR totus_WEB#5 (`utils/filterChips.ts`, `SelectedFilters`, карточка тегов+сортировки, бейдж на мобильной кнопке, синхронизация сайдбара) и totus_APP#3 (`SelectedFiltersRow`, бейдж в `SearchResultHeader`). Серые теги-подсказки из Figma — отложены. Замечено: в дизайн-библиотеке артборд «Выдача поиска» содержал блок «Выбранные фильтры», которого в коде нет — поправить при следующем обновлении библиотеки |
