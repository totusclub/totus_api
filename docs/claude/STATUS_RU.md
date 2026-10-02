# TOTUS — текущее состояние (STATUS)

**Обновлено:** 01.10.2026 — чат Cowork «Totus Dev» (план QA перед запуском).
Регламент ведения — `claude/WORKFLOW_RU.md`. История — `claude/JOURNAL_RU.md`.

---

## 1. Сейчас в работе

Строку добавить при старте задачи, убрать при завершении.

| Чат | Задача | Репо / слой | С какого времени |
|---|---|---|---|
| этот | Звонки: #8 слит; закрытое приложение + сайт — totus_APP #15 (ждём проверки на устройстве); затем подряд все остальные пункты аудита | calling_api_v2, totus_APP, totus_support_app, totus_WEB, calling_v2 | 02.10 |
| этот | «Мои заказы» медленно — диагностика готова, ждём замеры и «добро» владельца | totus_API `/user/orders`, totus_WEB профиль | 01.10 |

---

## 2. Открытые PR (сверено с GitHub 29.09, 21:00 UTC)

| PR | Что | Что нужно от владельца |
|---|---|---|
| [totus_WEB #25](https://github.com/tosmedia/totus_WEB/pull/25) | Производительность, этап 1: фото отеля сразу, lazy-картинки, без дубля `/hotels-rooms` (UI не меняется) | `npm run build`, проверка страницы отеля и главной, слияние, `pm2 restart front` |
| [totus_APP #15](https://github.com/tosmedia/totus_APP/pull/15) | iOS: звонок в закрытое приложение (PKPushRegistry при запуске + восстановление ответа из Support App) | `npm run check`, TestFlight, сценарии (а)–(г) из PR, слияние |
| [totus_support_app #2](https://github.com/tosmedia/totus_support_app/pull/2) | Звонки, этап 1: `VoipService.ts` из PR #1 + ранний запрос микрофона (iOS) | `npm run check`, сборка, TestFlight, чек-лист в PR; слияние |
| [totus_APP #14](https://github.com/tosmedia/totus_APP/pull/14) | Звонки, этап 1: ранний запрос микрофона (iOS) | Сборка, TestFlight, проверка первого звонка после установки; слияние |
| [totus_support_app #1](https://github.com/tosmedia/totus_support_app/pull/1) — слит 30.09 без `VoipService.ts` | iOS: ответ из закрытого / фона / экрана блокировки | Файл добавлен в #2 — патч вручную применять не нужно |
| [calling_api_v2 #7](https://github.com/tosmedia/calling_api_v2/pull/7) — **слит в `prod` 30.09** | VoIP-пуши iOS для Totus Support (доп. APNs topic) | Проверить деплой: в логе pm2 строка `[apn] multi-topic VoIP enabled` |
| ветка [`claude/docs-sync`](https://github.com/tosmedia/totus_API/tree/claude/docs-sync) (постоянная, без PR) | Зеркало документов проекта в `totus_API/docs`, обновляется после каждого изменения | Решить по чувствительным данным (см. JOURNAL 01.10) |
| [totus_API #24](https://github.com/tosmedia/totus_API/pull/24) | CORS: свой режим, 403, Origin десктопа, exposedHeaders, maxAge | Ревью и слияние |
| [totus_desktop #6](https://github.com/tosmedia/totus_desktop/pull/6) | macOS codesign: entitlements для helper-процессов | Ревью и слияние |

Всё остальное за сентябрь (84 PR) слито.

---

## 3. Слито 29.09 — состояние развёртывания

| PR | Что | Развёрнут? |
|---|---|---|
| [totus_ai_v2 #2](https://github.com/tosmedia/totus_ai_v2/pull/2) | Мила: все фильтры Level.Travel + живой тон | **Не подтверждено**: `/api/health` Милы не показывает версию. Нужно: `git pull && npm run build && pm2 restart totus-ai-api totus-ai-web` (имена по оркестратору; сверить в `pm2 list`), затем проверить в чате запрос «Турция 5★ с аквапарком, Анталья» |
| [totus_API #26](https://github.com/tosmedia/totus_API/pull/26) | Регистрация из приложения: «Signup failed» | **Не подтверждено**. После деплоя, если ошибка повторится: `pm2 logs api --lines 2000 --nostream \| grep "\[SIGNUP\]"`. Корневая причина не подтверждена логами |
| [totus_API #25](https://github.com/tosmedia/totus_API/pull/25) | Hero: неограниченный список изображений, случайный выбор | **Да** — `GET /api/home-hero` отдаёт `images_count: 3` |
| [Totus_admin #12](https://github.com/tosmedia/Totus_admin/pull/12) | Админка: управление изображениями hero | Не подтверждено (админка снаружи не проверялась) |
| [totus_WEB #24](https://github.com/tosmedia/totus_WEB/pull/24) | Hero Desktop 500px, контент прижат к низу | **Да** — на totus.club есть класс `heroTitle_desktopContent` |
| [totus_WEB #23](https://github.com/tosmedia/totus_WEB/pull/23), [#22](https://github.com/tosmedia/totus_WEB/pull/22), [#21](https://github.com/tosmedia/totus_WEB/pull/21) | Заголовок hero в Header, Footer в мобильной версии, hero только с бэкенда | Да (та же сборка сайта, что и #24) |
| [totus_WEB #20](https://github.com/tosmedia/totus_WEB/pull/20), [#19](https://github.com/tosmedia/totus_WEB/pull/19) | Раскладка RU↔EN в поиске и в поле «Откуда?» | Вероятно да (та же сборка), отдельно не проверялось |
| [totus_WEB #18](https://github.com/tosmedia/totus_WEB/pull/18), [#17](https://github.com/tosmedia/totus_WEB/pull/17) | Hero только с бэкенда; убрано окно PIN при первом входе | Вероятно да, отдельно не проверялось |

---

## 4. Долги и незавершённое

| # | Что | Откуда | Что сделать |
|---|---|---|---|
| D1 | Figma: 4 кадра Desktop 1440 (Light/Dark, гость/авторизован) в разделе «Home · Заголовок hero в Header» (node `2224:105678`, файл `u6A5og35jw0BBJyOkKl8Ij`) показывают hero **350px** по центру, а в коде **500px + flex-end** | totus_WEB #24; коннектор Figma требовал повторного входа | Переподключить Figma, обновить кадры (высота 500, выравнивание вниз, отступы 48/48) и заметку-спецификацию `2225:105791` |
| D2 | Проверки остались во временной папке, в репозитории их нет: регистрация (totus_API #26), фильтры Милы (totus_ai_v2 #2) | Нарушение шага 4 регламента (до его введения) | С «добро» владельца: `scripts/check-signup.js` в totus_API (+ в `npm run check`); `scripts/check-lt-filters.ts` + скрипт `check` в totus_ai_v2 |
| D3 | Мила: нет маркера версии в `/api/health` — нельзя проверить, что задеплоено | Выявлено 29.09 | Добавить `BUILD_TAG` / хэш коммита в ответ health (отдельная задача, с «добро») |
| D4 | Регистрация: реальная причина «Signup failed» не подтверждена логами | totus_API #26 | Владелец: после деплоя проверить регистрацию из приложения; при ошибке прислать строку `[SIGNUP]` |
| D5 | Доска Totus Dev Board не обновлялась задачами 29.09 (hero, раскладка, регистрация, Мила) | Оркестратор §3.6 | Внести задачи и отметить «готово» |
| D6 | Безопасность: `AUTH_MODE=enforce` не включён | `claude/SECURITY_ENFORCE_MATRIX_RU.md` | Три клиентские правки + решение по гостевому бронированию |
| D7 | Приложение поддержки: Firebase `club.totus.support`, App ID Apple, сборка | `claude/SUPPORT_APP_STATUS_RU.md` | Владелец |
| D8 | Хвосты Б.1: удалить TURN-пользователя `test` после релиза приложения, перепубликовать `pkg/*`, webhook-ключ LT, GitHub Advanced Security | `claude/ROADMAP_RU.md`, `claude/SECURITY_AUDIT_SECRETS_RU.md` | Владелец |
| D9 | Косметика: в totus_ai_v2 `server/llm.ts` escape ` ` в регэкспе стал самим символом NBSP (поведение то же) | totus_ai_v2 #2 | При следующей правке файла вернуть ` ` |
| D10 | totus_APP: тот же `VoipService.ts` (исходник порта) — вероятно, та же ошибка ответа из закрытого приложения на iOS и повторная обработка ответа | Выявлено 30.09 при разборе Support App | После проверки фикса в Support App на устройстве перенести в totus_APP отдельным PR (с «добро») |

---

## 5. Проверки (наборы тестов)

| Репо | Набор | Размер на 30.09 |
|---|---|---|
| totus_API | `npm run check` | `node --check app.js` + 13 скриптов `scripts/check-*.js` (auth-core, notify-hub, custom-rooms ×5, operators, yandex-auth, phone, order-docs, home-hero) |
| totus_ai_v2 | нет (`typecheck:server`, `lint`) | 0 — завести (D2) |
| totus_support_app | `npm run check` (Node ≥ 22.18) | 2 скрипта, 24 проверки: `check-voip-answer-recovery` (16, проходят только с `VoipService.ts` из #2), `check-mic-permission` (8, ветка `claude/voip-stage1`) |
| calling_api_v2 | `npm run check` | + `check-multi-device-calls.js` — 17 сценариев на настоящем `index.js` (ветка `claude/calls-multi-device`) |
| totus_APP | `npm run check` (Node ≥ 22.18) | 2 скрипта: `check-mic-permission` (9, в main), `check-voip-answer-recovery` (15, ветка `claude/voip-closed-app`) |
| totus_WEB | `npm run check` (Node ≥ 22.18) | 1 скрипт, 10 проверок: `scripts/check-perf-stage1.mjs` (в ветке PR #25) |
| Totus_admin, totus_APP, totus_desktop, calling_v2, calling_api_v2 | не заведены | — |

---

## 6. Прод-сервисы (из `docs/CLAUDE_ORCHESTRATOR_RU.md` §7)

| URL | Репо | Порт | PM2 | Маркер версии |
|---|---|---|---|---|
| https://totus.club | totus_WEB | 3000 | front | CSS-классы / чанки Next в HTML |
| https://api.totus.club | totus_API | 3001 | api | новые поля ответов (например `images_count` в `/api/home-hero`) |
| https://apiv2.totus.club / https://ai.totus.club | totus_ai_v2 | 3011 / 3012 | totus-ai-api / totus-ai-web | нет (D3) |
| https://voip.totus.club | calling_api_v2 (ветка `prod` — основная для прода; `claude/*` от `prod`, PR в `prod`) | 4444 | api_calling | — |
| https://calling.totus.club | calling_v2 | 3008 | front_calling | — |
| admin.totus.club | Totus_admin | 3009 | front_admin | — |

Сервер `109.73.206.121`. Сливает и деплоит только владелец.

---

## 7. Тематические документы (где подробности)

- **Hero:** `claude/HERO_IMAGES_RU.md`
- **Мила, фильтры:** `claude/MILA_LT_FILTERS_RU.md`
- **Room Type / Arlekino:** `claude/CUSTOM_ROOMS_STATUS_RU.md`
- **Push:** `claude/PUSH_NOTIFICATIONS_STATUS_RU.md`
- **Support Chat:** `claude/SUPPORT_CHAT_STATUS_RU.md`
- **Приложение поддержки:** `claude/SUPPORT_APP_STATUS_RU.md`
- **Яндекс ID:** `claude/YANDEX_AUTH_STATUS_RU.md`
- **Безопасность:**
  - `claude/SECURITY_AUDIT_2026-09_RU.md`
  - `claude/SECURITY_ENFORCE_MATRIX_RU.md`
  - `claude/SECURITY_JWT_PLAN_RU.md`
- **Юридическое:**
  - `claude/LEGAL_DOCS_RU.md`
  - `claude/TOTUSKLAB_DOCS_RU.md`
- **Производительность сайта:** `claude/WEB_PERF_AUDIT_RU.md` (аудит 01.10; этап 1 — PR totus_WEB #25)
- **QA перед запуском:** `claude/QA_LAUNCH_PLAN_RU.md` (план, ждёт решений Р1–Р8); трекер-артефакт «Totus QA к запуску» — https://claude.ai/artifact/DH2T4AxM8nVb2Spa1pEBSX
- **План и вопросы:**
  - `claude/ROADMAP_RU.md`
  - `claude/QUESTIONS_RU.md`
- **Правила чатов:** `docs/CLAUDE_ORCHESTRATOR_RU.md`
