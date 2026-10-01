# CLAUDE Orchestrator (RU) — TOTUS / Totus Club

**Назначение:** этот файл — **главный координатор** для работы с Claude Code через **несколько отдельных чатов**.  
Каждый чат = один MD-файл документации. Оркестратор описывает **какой чат для какой задачи**, границы ответственности и правила передачи контекста между чатами.

> **Как использовать:** открой **этот файл первым** в Claude Code (или держи его в корне workspace `TOTUS/`). Для каждой области — отдельный чат + один MD из таблицы ниже.

---

## Содержание

1. [Карта экосистемы](#1-карта-экосистемы)
2. [Список чатов Claude (9 + оркестратор)](#2-список-чатов-claude-9--оркестратор)
3. [Правила оркестрации](#3-правила-оркестрации)
4. [Дерево решений — какой чат открыть](#4-дерево-решений--какой-чат-открыть)
5. [Сценарии «несколько чатов»](#5-сценарии-несколько-чатов)
6. [Готовые промпты для старта каждого чата](#6-готовые-промпты-для-старта-каждого-чата)
7. [Production URLs (единый справочник)](#7-production-urls-единый-справочник)
8. [Чего нет в документации](#8-чего-нет-в-документации)
9. [Чеклист перед деплоем](#9-чеклист-перед-деплоем)

---

# 1. Карта экосистемы

```text
                         ┌─────────────────────────────────────┐
                         │  CLAUDE_ORCHESTRATOR_RU.md (этот)   │
                         │  + SERVER_CONFIG_RU.md (инфра)      │
                         └──────────────────┬──────────────────┘
                                            │
     ┌──────────────┬──────────────┬───────┴────────┬──────────────┐
     ▼              ▼              ▼                ▼              ▼
 totus_WEB     totus_API      totusapp        totus_ai_v2    calling_v2
 (сайт)        (туры/API)     (mobile)        (AI Мила)      + calling_api_v2
     │              │              │                │              │
     └────── api.totus.club ────────┴── voip / apiv2 ──────────────┘
                    │
              MySQL kedam (109.73.206.121)
```

**Сервер:** `109.73.206.121` — все prod-сервисы на одной VM (см. `SERVER_CONFIG_RU.md`).

**Git:** 6 отдельных репозиториев, все в организации `tosmedia`: totus_API, totus_WEB, totus_APP, totus_ai_v2, calling_v2, calling_api_v2 (последние два перенесены из `Hayk95/*` в `tosmedia/*`, 27.08.2026).

---

# 2. Список чатов Claude (9 + оркестратор)

Используй **канонические файлы из корня `TOTUS/`** (копии в подпапках — дубликаты).

| # | Имя чата (рекомендуемое) | MD-файл | Репозиторий | Когда использовать |
|---|--------------------------|---------|-------------|-------------------|
| **0** | `TOTUS Orchestrator` | `CLAUDE_ORCHESTRATOR_RU.md` | весь TOTUS | Маршрутизация задач, cross-repo, «куда идти» |
| **1** | `totus_API` | `API_DOCUMENTATION_RU.md` | `totus_API/` | Backend: endpoints, MySQL, LT, VTB, auth, CMS |
| **2** | `totus_WEB` | `WEB_DOCUMENTATION_RU.md` | `totus_WEB/` | Сайт Next.js: страницы, Redux, UI, AI widget |
| **3** | `totusapp` | `APP_DOCUMENTATION_RU.md` | `totusapp/` | React Native: навигация, VoIP client, mobile API |
| **4** | `totus_ai_v2` | `AI_DOCUMENTATION_RU.md` | `totus_ai_v2/` | Мила: LLM, WS, packages, MySQL history |
| **5** | `calling-front` | `CALLING_FRONT_DOCUMENTATION_RU.md` | `calling_v2/` | Web-админка агента, WebRTC client |
| **6** | `calling-api` | `CALLING_API_DOCUMENTATION_RU.md` | `calling_api_v2/` | VoIP backend, Socket.io, APNs |
| **7** | `server-config` | `SERVER_CONFIG_RU.md` | инфра | Домены, порты, PM2, nginx, MySQL на prod |
| **8** | `server-tls` | `SERVER_TLS_CONFIG_RU.md` | инфра | TLS, TSPU, история nginx/ssl |
| **9** | `totus-admin` | *(документации пока нет)* | `totus_admin/` | Админка — репо `tosmedia/totus_admin` добавлен 27.08.2026, см. `QUESTIONS_RU.md` Q1 |

**Служебные документы проекта (не чаты):** `PROJECT_OVERVIEW_RU.md` (карта + риски), `QUESTIONS_RU.md` (открытые вопросы), `ROADMAP_RU.md` (планы и фазы).

**Индекс calling (опционально):** `CALLING_DOCUMENTATION_RU.md` — только ссылки на чаты 5 и 6.

### Что НЕ выносить в отдельный чат (читать по ссылке из нужного чата)

| Файл | Где смотреть |
|------|--------------|
| `totus_ai_v2/docs/KAK-*.md` | Чат **4** (AI) |
| `totus_ai_v2/DEPLOY.md` | Чат **4** + **7** |
| `CALLING_DOCUMENTATION_RU.md` | Чаты **5** + **6** |

---

# 3. Правила оркестрации

## 3.1. Один чат = одна зона ответственности

- В чате **totus_API** не менять `calling_v2` и не выдумывать endpoints — только `API_DOCUMENTATION_RU.md`.
- В чате **calling-front** не править `totus_API/app.js` — для заказов в admin позже → чат **1** + **5**.

## 3.2. Cross-repo задачи

1. Начни в **чате 0 (Orchestrator)** или выбери **primary** repo по [§4](#4-дерево-решений--какой-чат-открыть).
2. Primary чат делает изменения в своём repo.
3. Для второго repo — **новое сообщение** в другом чате с кратким контекстом:

```text
Контекст из чата totus_API: добавлен GET /api/foo.
Нужно в totus_WEB: вызвать его из src/api/...
См. WEB_DOCUMENTATION_RU.md §7.
```

## 3.3. Источник правды

| Тема | Primary MD |
|------|------------|
| HTTP endpoints kedam | `API_DOCUMENTATION_RU.md` |
| Prod порты/domains | `SERVER_CONFIG_RU.md` |
| TLS/nginx история | `SERVER_TLS_CONFIG_RU.md` |
| VoIP signaling | `CALLING_API_DOCUMENTATION_RU.md` |
| AI WebSocket | `AI_DOCUMENTATION_RU.md` |

При конфликте MD и кода — **код wins**; обнови MD в том же чате после изменения.

## 3.4. Секреты

- Не копировать `.env`, пароли SSH, TURN credentials в чаты.
- Для prod — чат **7** называет **имена** переменных, не значения.

## 3.5. Git

- Доступ к GitHub из чатов — через **GitHub-коннектор** (org `tosmedia`); токены в чат не вставлять.
- Claude пишет только в ветки `claude/<тема>`; в `main` / `develop` / `prod` — только через PR, мержит человек.
- Перед любым коммитом — явное «добро» владельца в чате.

## 3.6. Доска задач — обязательна для всех чатов

Живой трекер: **Totus Dev Board** — https://claude.ai/code/artifact/3b90e109-54eb-4013-8995-fecd72664e73

Колонки: Идеи · Недочёты · Минорные · Админка · Безопасность · База и Backend · Дизайн · Функции · Платформы · ИИ · Инфраструктура. Статусы: план → в работе → готово (кликаются на странице). «+ задача» в колонке добавляет пункт.

Правила для каждого чата проекта:

1. **Перед началом работы** — открой доску (Artifact read по URL) и найди свою задачу; если её нет — добавь.
2. **Взял задачу** — переведи в «в работе»; **закончил** — в «готово» (обновление: прочитать артефакт по URL, изменить JSON в `<script id="board-data">`, опубликовать с тем же `url`).
3. **Идея ≠ задача**: идея живёт в колонке «Идеи», при принятии раскладывается на задачи по колонкам (с пометкой идеи в meta), сама идея переводится в «в работе» и в «готово» — когда реализованы все её задачи.
4. Минорные правки (кнопка, текст, стиль) — в колонку «Минорные»; крупные — по своим колонкам.
5. Доска — статусы и список; подробности задач — в `ROADMAP_RU.md`, вопросы — в `QUESTIONS_RU.md`.

## 3.7. Визуальное согласование UI — до кода

Любое видимое пользователю изменение (сайт, админка, приложение, панель звонков):

1. **Сначала макет** — дизайн-канвас в чате (реальные токены: Golos Text, #FE732E, тёмная тема админки), формат «до / после» для правок, артборды для новых экранов.
2. **Утверждение владельца** — только после явного «утверждаю» пишется код (в ветку `claude/*`).
3. **Для web/админки** — перед мержем показать скриншот собранной страницы из ветки.
4. Исключение: изменения без визуальной стороны (бэкенд, безопасность, письма) — согласуются текстом.

## 3.8. Язык

- Документация и ответы Claude: **русский** (как в MD).
- Имена файлов, endpoints, env — как в коде (English).

---

# 4. Дерево решений — какой чат открыть

```text
Задача?
│
├─ Не знаю с чего начать ─────────────────────────► Чат 0 (Orchestrator)
│
├─ Оплата / заказ / Level.Travel / CMS / admin API ► Чат 1 (totus_API)
│
├─ Страница сайта / поиск / hotel-details / checkout ► Чат 2 (totus_WEB)
│
├─ Мобильное приложение / звонок из app / RN bug ───► Чат 3 (totusapp)
│
├─ AI Мила / apiv2 / WebSocket / ai-assistant pkg ──► Чат 4 (totus_ai_v2)
│
├─ Админка звонков / agent dashboard / CallModal ───► Чат 5 (calling-front)
│
├─ VoIP API / Socket.io / APNs / register-device ───► Чат 6 (calling-api)
│
├─ Деплой / nginx / PM2 / «почему 502» / порты ─────► Чат 7 (server-config)
│
└─ SSL / TSPU / certbot / HTTPS на моб. сетях ──────► Чат 8 (server-tls)
```

---

# 5. Сценарии «несколько чатов»

| Задача | Порядок чатов |
|--------|----------------|
| Новый endpoint + UI на сайте | **1** (API) → **2** (WEB) |
| Новый endpoint + mobile | **1** (API) → **3** (APP) |
| AI tool + карточка на сайте | **4** (AI) → **2** (WEB, `@tosmedia/ai-assistant`) |
| AI tool + mobile | **4** (AI) → **3** (APP, native package) |
| Звонок agent → user не работает | **5** (front) + **6** (api) + **3** (app VoIP) |
| 413 upload CMS image | **1** (API multer) + **7** (nginx 20M) |
| Заказы в calling admin (будущее) | **1** (orders API) + **5** (UI) — orders **не** в calling сейчас |
| Prod deploy kedam | **7** (pm2 pull) + **1** или **2** (app) |
| AI deploy apiv2/ai.totus | **7** + **4** + `totus_ai_v2/DEPLOY.md` |

---

# 6. Готовые промпты для старта каждого чата

Скопируй **первое сообщение** в новый чат Claude Code и приложи указанный MD (или открой workspace `TOTUS/`).

---

### Чат 0 — Orchestrator

```text
Ты координатор проекта TOTUS (Totus Club). Прочитай CLAUDE_ORCHESTRATOR_RU.md.
Помогай выбирать правильный чат/репозиторий для задачи.
Не пиши код во всех репо сразу — укажи primary chat и follow-up шаги.
Workspace: TOTUS/ (5+ git repos).
```

---

### Чат 1 — totus_API

```text
Ты Senior Backend Developer. Единственный источник правды: API_DOCUMENTATION_RU.md и код totus_API/.
Работай только с totus_API. Не выдумывай endpoints. Секреты не выводи.
Задача: [ОПИШИ ЗАДАЧУ]
```

---

### Чат 2 — totus_WEB

```text
Ты Senior Frontend Developer (Next.js). Источник правды: WEB_DOCUMENTATION_RU.md и totus_WEB/.
Backend — api.totus.club (см. API_DOCUMENTATION_RU.md только для контрактов API).
AI — @tosmedia/ai-assistant → apiv2.totus.club.
Задача: [ОПИШИ ЗАДАЧУ]
```

---

### Чат 3 — totusapp

```text
Ты React Native developer. Источник правды: APP_DOCUMENTATION_RU.md и totusapp/.
Bare RN 0.79, не Expo. API: api.totus.club, VoIP: voip.totus.club, AI: apiv2.
Задача: [ОПИШИ ЗАДАЧУ]
```

---

### Чат 4 — totus_ai_v2

```text
Ты AI/fullstack developer (Express + Next monorepo). Источник: AI_DOCUMENTATION_RU.md.
Дополнительно: docs/KAK-RABOTAET-*.md в totus_ai_v2.
Prod: apiv2.totus.club :3011, ai.totus.club :3012.
Задача: [ОПИШИ ЗАДАЧУ]
```

---

### Чат 5 — calling-front

```text
Ты frontend developer calling_v2 (Next.js agent panel).
Источник: CALLING_FRONT_DOCUMENTATION_RU.md.
Backend: voip.totus.club (НЕ server.totus.club — NXDOMAIN).
Задача: [ОПИШИ ЗАДАЧУ]
```

---

### Чат 6 — calling-api

```text
Ты backend developer calling_api_v2 (Express + Socket.io + APNs).
Источник: CALLING_API_DOCUMENTATION_RU.md.
Port 4444, MySQL kedam.users. Заказов в этом API нет.
Задача: [ОПИШИ ЗАДАЧУ]
```

---

### Чат 7 — server-config

```text
Ты DevOps. Источник: SERVER_CONFIG_RU.md (prod 109.73.206.121).
PM2, nginx, порты, пути /home/*. Не выводи секреты из .env.
Задача: [ОПИШИ ЗАДАЧУ]
```

---

### Чат 8 — server-tls

```text
Ты DevOps/TLS. Источник: SERVER_TLS_CONFIG_RU.md + SERVER_CONFIG_RU.md §TLS.
TSPU snippet, certbot, nginx ssl. Задача: [ОПИШИ ЗАДАЧУ]
```

---

# 7. Production URLs (единый справочник)

| URL | Backend port | PM2 | Документация |
|-----|--------------|-----|--------------|
| https://totus.club | 3000 | front | WEB |
| https://api.totus.club | 3001 | api | API |
| https://voip.totus.club | 4444 | api_calling | CALLING API |
| https://calling.totus.club | 3008 | front_calling | CALLING FRONT |
| https://ai.totus.club | 3012 | totus-ai-web | AI |
| https://apiv2.totus.club | 3011 | totus-ai-api | AI |

**⚠️ Bug:** `calling_v2` в коде использует `server.totus.club` — DNS не существует. Fix → чат **5** + **7** (или смена BASE_URL на `voip.totus.club`).

---

# 8. Чего нет в документации

| Тема | Статус |
|------|--------|
| Заказы в calling_v2 admin | Не реализовано — только totus_API |
| STUN/TURN на 109.73.206.121 | Порты 3478/5349 не слушают |
| server.totus.club | NXDOMAIN |
| totusapp на prod server | Сборка локально / CI, не PM2 на VM |
| SECURITY.md | Упоминался в чатах, файла нет в workspace |

---

# 9. Чеклист перед деплоем

- [ ] Изменения в правильном git repo (не monorepo — отдельный push)
- [ ] Чат **7**: `pm2 restart <name>` после pull на сервере
- [ ] Чат **7**: `nginx -t && systemctl reload nginx` если менялся nginx
- [ ] API + WEB: совместимость контрактов (чаты **1** + **2**)
- [ ] AI package bump: чат **4** → `KAK-OBNOVIT-AI.md` → update в WEB/APP
- [ ] VoIP: тест agent (calling) + mobile (totusapp) — чаты **5**, **6**, **3**

---

## Быстрая таблица файлов в корне TOTUS/

```
TOTUS/
├── CLAUDE_ORCHESTRATOR_RU.md    ← этот файл (чат 0)
├── API_DOCUMENTATION_RU.md      ← чат 1
├── WEB_DOCUMENTATION_RU.md      ← чат 2
├── APP_DOCUMENTATION_RU.md      ← чат 3
├── AI_DOCUMENTATION_RU.md       ← чат 4
├── CALLING_FRONT_DOCUMENTATION_RU.md  ← чат 5
├── CALLING_API_DOCUMENTATION_RU.md    ← чат 6
├── SERVER_CONFIG_RU.md          ← чат 7
├── SERVER_TLS_CONFIG_RU.md      ← чат 8
└── CALLING_DOCUMENTATION_RU.md  ← индекс calling (опционально)
```

---

*Создано: 26 августа 2026. Обновляй при добавлении новых MD или сервисов.*
