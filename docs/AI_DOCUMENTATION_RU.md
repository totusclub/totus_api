# AI Documentation (RU) — totus_ai_v2 (Мила)

Документация построена **только по коду** репозитория `totus_ai_v2`.  
Если сведения отсутствуют в коде: `Не найдено в текущей кодовой базе.`  
Если вывод неочевиден: `Предположение:`.

Секреты из `.env` **не приводятся** — только имена переменных.

Этот файл — **карта всего проекта для Claude Code**. Более глубокие разборы уже есть в `docs/` (см. §15); перед сменой поведения ассистента читайте их.

---

# 1. Architecture

## Стек (монорепо)

| Компонент | Путь / пакет | Порт (локально) |
|-----------|--------------|-----------------|
| Express API + WebSocket | `server/` | **3011** (`PORT`) |
| Next.js host (тонкая оболочка) | `src/app/` | **3012** |
| Web UI-пакет | `packages/ai-assistant` → `@tosmedia/ai-assistant` | — |
| React Native UI-пакет | `packages/ai-assistant-native` → `@tosmedia/ai-assistant-native` | — |

Workspaces: `"workspaces": ["packages/*"]` в корневом `package.json`. Имя проекта: `totus-ai-v2`.

## Production

| Хост | Куда |
|------|------|
| `https://ai.totus.club` | Next.js UI → `:3012` |
| `https://apiv2.totus.club` | Express API + WS → `:3011` |

Источник: `DEPLOY.md`, `README.md`, `.env.example`.

## Потребители UI

| Клиент | Пакет | Установка (из docs/скриптов) |
|--------|-------|------------------------------|
| **totus_WEB** | `@tosmedia/ai-assistant` | git-ветка `pkg/ai-assistant` |
| **totusapp** | `@tosmedia/ai-assistant-native` | git-ветка `pkg/ai-assistant-native` |
| Хост `ai.totus.club` | тот же `@tosmedia/ai-assistant` через workspace | `src/app/AppShell.tsx` |

## Поток данных

```text
Клиент (totus_WEB / totusapp / ai.totus.club)
    │
    ├── REST  →  apiv2 (:3011) /api/*
    │              • поиск туров, health, rooms, bookings, schema, logs
    │              • /api/ai-chats — история (JWT Bearer)
    │
    └── WS    →  wss://apiv2…/ws/assistant  (без JWT)
                   │
                   ▼
            server/assistant.ts
                   │  LLM включён?
                   ├─ да → server/llm.ts (OpenAI SDK → DeepSeek / LLM_*)
                   │         tools → server/levelTravel.ts
                   └─ нет → rule-based fallback в assistant.ts
                   │
                   ▼
            Level.Travel API (api.level.travel)
                   │
                   ▼
            Deep-link бронирования → TOTUS_SITE_URL/hotel-details?…
            (по умолчанию https://totus.club/hotel-details?…)
```

Карточки отелей/номеров/направлений уходят клиенту по WS (`tours` / `rooms` / `destinations`); текст ассистента — стримом `token` → `done`.

---

# 2. Project Structure

```text
totus_ai_v2/
├── server/                          # Express API + WS + LLM + Level.Travel
│   ├── index.ts                     # HTTP routes, WS /ws/assistant, CORS, listen
│   ├── assistant.ts                 # сессии, restore, оркестрация → LLM / rule-based
│   ├── llm.ts                       # OpenAI client, TOUR_TOOLS, handleLlmMessage
│   ├── totusPrompt.ts               # системный промпт «Мила», totusConfig()
│   ├── levelTravel.ts               # Level.Travel HTTP, кэш, hotel-details URL
│   ├── authUser.ts                  # JWT Bearer (requireAuth)
│   ├── db.ts                        # MySQL pool, ensureChatSchema
│   ├── chatHistory.ts               # CRUD /api/ai-chats*
│   ├── chatLog.ts                   # диагностический journal (~/.totus-chat-logs)
│   ├── data.ts                      # SCHEMA_TABLES для /api/schema
│   └── types.ts                     # серверные типы Tour/Booking/…
├── packages/
│   ├── ai-assistant/                # @tosmedia/ai-assistant (web React)
│   └── ai-assistant-native/         # @tosmedia/ai-assistant-native (RN)
├── src/app/                         # Next.js host
│   ├── layout.tsx
│   ├── page.tsx                     # AiHomePage
│   ├── AppShell.tsx                 # AiAssistantProvider + ChatWidget
│   ├── globals.css
│   └── tours/[id]/page.tsx          # AiTourDetailPage
├── docs/
│   ├── KAK-RABOTAET-AI.md
│   ├── KAK-RABOTAET-LLM.md
│   ├── KAK-ISTORIYA-MYSQL.md
│   ├── KAK-OBNOVIT-AI.md
│   └── sql/ai_chats.sql
├── scripts/
│   ├── publish-ai-assistant-git.sh
│   └── publish-ai-assistant-native-git.sh
├── public/                          # favicon.svg, icons.svg
├── package.json
├── next.config.ts                   # rewrites /api,/ws → BACKEND
├── tsconfig.json / tsconfig.server.json
├── .env.example
├── DEPLOY.md
├── README.md
└── ИСТОРИЯ_ПРОЕКТА.md
```

Каталог автотестов (`*.test.*` / `*.spec.*`) — **Не найдено в текущей кодовой базе.**

---

# 3. Ports & Base URLs

| Сервис | Локально | Production |
|--------|----------|------------|
| API + WS | `http://localhost:3011` | `https://apiv2.totus.club` |
| WebSocket path | `ws://localhost:3011/ws/assistant` | `wss://apiv2.totus.club/ws/assistant` |
| Next UI | `http://localhost:3012` | `https://ai.totus.club` |

**CORS_ORIGINS** (из `.env.example` / дефолт в `server/index.ts`):

- Пример из `.env.example`: `http://localhost:3000,http://localhost:3012,https://ai.totus.club,https://totus.club,https://www.totus.club`
- Дефолт в коде без env: `http://localhost:3012,https://ai.totus.club,https://totus.club,https://www.totus.club`
- Запросы без `Origin` (non-browser) разрешены; `*` в списке — разрешить любой origin.

Локально Next проксирует `/api/*` и `/ws/*` на `BACKEND_URL` (дефолт `http://localhost:3011`), **если** `NEXT_PUBLIC_API_URL` не начинается с `http` (`next.config.ts`). В проде фронт ходит на абсолютные `NEXT_PUBLIC_*`.

---

# 4. HTTP API Reference

Базовый префикс: `/api`. Auth: **только** маршруты `/api/ai-chats*` требуют `Authorization: Bearer <JWT>`. Остальные эндпоинты без JWT (по коду `server/index.ts` + `chatHistory.ts`).

| Метод | Путь | Auth | Назначение |
|-------|------|------|------------|
| `GET` | `/api/health` | нет | `{ ok, service: 'tour-assistant', llm, db, kimi (legacy alias llm), levelTravel }` |
| `GET` | `/api/tours` | нет | Поиск пакетов Level.Travel; query: `fromCity`, `destination`, `nights`, `adults`, `kids`, `startDate`/`dateFrom`, `starsFrom`/`starsTo`, `priceMin`/`priceMax`, `sortBy`. Header `X-Tour-Source: level.travel`. Ошибка 502 + `{ error, source, tours: [] }` |
| `GET` | `/api/tours/:id` | нет | Тур из in-memory кэша; 404 если нет |
| `GET` | `/api/tours/:id/rooms` | нет | Типы номеров по контексту последнего/hotel search; 409 если нет поиска; booking_url через `buildBookingUrl` |
| `GET` | `/api/tours/:id/availability` | нет | Простая проверка даты/гостей по кэшу тура |
| `POST` | `/api/bookings` | нет | In-memory booking (`BK-…`); body: `tour_id`, `date`, `contact_email`, `guests`, … |
| `GET` | `/api/schema` | нет | `SCHEMA_TABLES` из `data.ts` (демо-схема, не MySQL) |
| `GET` | `/api/debug/countries` | нет | `supportedCountries()` |
| `GET` | `/api/debug/hotel/:id` | нет | Raw hotel reference Level.Travel |
| `GET` | `/api/debug/reviews/:id` | нет | Raw reviews |
| `GET` | `/api/logs` | нет | Диагностический journal; `?limit=&session=` |
| `GET` | `/api/logs/sessions` | нет | Список сессий journal |
| `GET` | `/api/ai-chats` | **JWT** | `{ chats, activeId }` |
| `PUT` | `/api/ai-chats/active` | **JWT** | `{ activeId }` → meta |
| `PUT` | `/api/ai-chats/:id` | **JWT** | upsert чата (`title`, `updatedAt`, `messages`) |
| `DELETE` | `/api/ai-chats/:id` | **JWT** | удаление чата пользователя |

При отсутствии MySQL: `/api/ai-chats*` → **503**. При отсутствии `JWT_SECRET`: **503** (`JWT_SECRET is not configured on AI API`).

---

# 5. WebSocket Protocol

- **Path:** `/ws/assistant` (`WebSocketServer` в `server/index.ts`).
- **Auth:** JWT на WS **нет**. Сессия — in-memory `WeakMap` на соединение.
- Клиент подключается без токена (`packages/*/src/hooks/useWebSocket.ts`).

## Клиент → сервер

| `type` | Поля | Поведение |
|--------|------|-----------|
| `chat` | `content: string` | Основной диалог → `handleAssistantMessage` |
| `reset` | — | Новая пустая `createSession()` |
| `restore` | `messages?`, `hotels?` | `seedRestoredSession`: последние ~40 сообщений в `llmMessages` + `contextNote` по отелям (до 8) |

Невалидный JSON → `{ type: 'error', error: 'Некорректное сообщение' }`.  
Сообщения без `type: 'chat'` и без `content` (кроме `reset`/`restore`) игнорируются.

## Сервер → клиент

| `type` | Назначение |
|--------|------------|
| `typing` | Индикатор набора |
| `token` | Чанк текста (`content`, `messageId`) |
| `done` | Конец ответа (`messageId`) |
| `error` | Ошибка (`error`) |
| `tool` | Статус инструмента (`tool`: name, arguments, status `running`/`done`/`error`, label, summary, api_calls) |
| `tours` | Карточки отелей (`tours`, `messageId`) |
| `rooms` | Номера (`hotel`, `rooms`, `messageId`) |
| `destinations` | Карточки направлений (`destinations`, `messageId`) |
| `booking` | Обрабатывается UI-типом; **в LLM-пути бронирования через WS в текущем коде не эмитится** (`Предположение:` остаток rule-based/legacy UI) |

После reconnect клиент сам шлёт `restore` с историей и отелями из `metadata.tour_results`.

---

# 6. LLM

## Провайдер

- SDK: пакет `openai` (`OpenAI` client).
- Включение: есть `LLM_API_KEY` **или** `DEEPSEEK_API_KEY`.
- Дефолты (`server/llm.ts` → `resolveProvider()`):
  - `LLM_BASE_URL` → иначе `https://api.deepseek.com`
  - `LLM_MODEL` → иначе **`deepseek-v4-flash`**
  - `LLM_TEMPERATURE` → иначе `0.35`
  - `LLM_THINKING` → иначе `disabled` (в запрос уходит `thinking: { type: 'disabled' }` для DeepSeek)
- Ключ: `LLM_API_KEY` приоритетнее `DEEPSEEK_API_KEY`.

## Оркестрация

1. `assistant.ts` → `handleAssistantMessage`: если LLM enabled → `handleLlmMessage`, иначе rule-based.
2. Ошибка LLM **не** падает в rule-based silently — в чат уходит `error` + `done`.
3. `llm.ts`: цикл tool_calls (guard ≤ 8), tools `TOUR_TOOLS`, стриминг текста чанками ~14 символов.
4. Системный промпт: `buildTotusSystemPrompt()` из `totusPrompt.ts` (агент по умолчанию **Мила**). При restore добавляется блок «Контекст восстановленного диалога».

## Tools (`TOUR_TOOLS`)

| Имя | Назначение |
|-----|------------|
| `search_tours` | Поиск пакетов; шлёт WS `tours`; Kayak-style picks; затем ожидается `annotate_hotels` |
| `get_hotel_info` | Карточка отеля (кэш + reference) |
| `get_hotel_offers` | Номера/цены; WS `rooms`; `all_rooms` — медленный hotel-scoped search |
| `get_hotel_reviews` | Отзывы `/references/hotel_reviews/{id}` |
| `annotate_hotels` | Персональные комментарии в уже показанные карточки |
| `show_destinations` | Карточки направлений; WS `destinations` |

## Env LLM_*

| Переменная | Роль |
|------------|------|
| `DEEPSEEK_API_KEY` | Ключ DeepSeek (часто основной) |
| `LLM_API_KEY` | Альтернативный/override ключ |
| `LLM_BASE_URL` | Base URL OpenAI-совместимого API |
| `LLM_MODEL` | Имя модели |
| `LLM_TEMPERATURE` | Temperature |
| `LLM_THINKING` | `enabled` / иначе disabled |

Промпт-плейсхолдеры: `TOTUS_AGENT_NAME`, `TOTUS_COMPANY_PHONE`, `TOTUS_PROMO_INFO`, `TOTUS_DEPARTURE_CITIES`.

`llmStatus()`: `{ enabled, model, baseURL, agent, brand: 'Тотус клуб', prompt: 'v3-assistant' }`.

---

# 7. Level.Travel Integration

Файл: `server/levelTravel.ts`.  
Base: `LEVEL_TRAVEL_BASE_URL` или `https://api.level.travel`.  
Version header: `LEVEL_TRAVEL_API_VERSION` или `3.7` → `Accept: application/vnd.leveltravel.v{VERSION}`.  
Auth: `Authorization: Token token={LEVEL_TRAVEL_API_KEY}`.

## Используемые пути API

| Path | Использование |
|------|----------------|
| `GET /search/enqueue` | Постановка package-поиска |
| `GET /search/status` | Poll операторов |
| `GET /search/get_grouped_hotels` | Сгруппированные отели |
| `GET /search/get_hotel_offers` | Офферы номеров (`per_page`, `page`) |
| `GET /search/actualize` | Актуализация оффера (`actualizeOffer`) |
| `GET /references/countries` | Справочник стран при старте |
| `GET /references/departures` | Города вылета при старте |
| `GET /references/hotels` | Reference отеля (`hotel_ids`) |
| `GET /references/hotel_reviews/{hotel_id}` | Отзывы |

Публичные URL поставщика (`LEVEL_TRAVEL_PUBLIC_URL`, `LEVEL_TRAVEL_AFLT`) используются во внутренних helper’ах; **клиенту** в карточках подставляются ссылки на сайт Totus.

## Booking / deep-link

- `TOTUS_SITE_URL` (дефолт `https://totus.club`) → `buildTotusHotelUrl()` →  
  `{TOTUS_SITE}/hotel-details?hotel_id=&from_city=&from_country=RU&to_country=&…&request_id=…`
- `TOTUS_BOOKING_URL_TEMPLATE` — опциональный шаблон `{tour_id}`, `{hotel_id}`, `{room}`; если пусто — fallback на `hotel-details`.
- Исключённые страны: `TOTUS_EXCLUDED_COUNTRIES` (дефолт в коде `FR,ES,GR,IT`).

`BUILD_TAG` в коде: `v38-context-restore · 2026-08-11`.

---

# 8. Chat History MySQL

| Файл | Роль |
|------|------|
| `server/db.ts` | Pool `mysql2`, `ensureChatSchema`, `dbStatus` |
| `server/chatHistory.ts` | Routes + CRUD |
| `docs/sql/ai_chats.sql` | Ручной SQL (тот же DDL) |

## Таблицы

- **`ai_chats`**: `id`, `user_id`, `title`, `messages_json`, `updated_at`, `created_at`
- **`ai_chat_meta`**: `user_id`, `active_chat_id`

Создаются при старте API, если заданы `DB_HOST` + `DB_USER` + `DB_NAME` (пароль `DB_PASSWORD` может быть пустым).

Лимиты: list ≤ 40 чатов; сообщения при сохранении обрезаются до последних **80**.

JWT: тот же `JWT_SECRET`, что у totus_API (комментарий в `authUser.ts` / `.env.example`). Payload должен содержать numeric `id` (user id).

Гости без токена: remote history не используется — локальное хранение в пакетах (`historyMode` и т.п.; детали в `docs/KAK-ISTORIYA-MYSQL.md`).

---

# 9. Auth

| Канал | Auth |
|-------|------|
| `/api/ai-chats*` | **Обязателен** Bearer JWT (`requireAuth`) |
| Остальной REST | Без JWT |
| WebSocket `/ws/assistant` | **Без JWT** |

Ошибки auth: 401 (нет/битый токен), 503 (нет `JWT_SECRET`).

---

# 10. UI Packages

| Пакет | Версия (package.json) | Ветка publish | Потребитель |
|-------|----------------------|---------------|-------------|
| `@tosmedia/ai-assistant` | **1.0.18** | `pkg/ai-assistant` | totus_WEB, Next host |
| `@tosmedia/ai-assistant-native` | **1.2.2** | `pkg/ai-assistant-native` | totusapp |

## Publish

```bash
# web
npm run build:assistant
npm run publish:assistant:git   # scripts/publish-ai-assistant-git.sh → force-push ветки

# native
npm run build:assistant-native
npm run publish:assistant-native:git
```

Также: `npm run publish:assistant` → GitHub Packages (`publishConfig.registry: https://npm.pkg.github.com`) для web-пакета.

Установка у потребителей:

```text
github:tosmedia/totus_ai_v2#pkg/ai-assistant
github:tosmedia/totus_ai_v2#pkg/ai-assistant-native
```

Экспорты web: компоненты `AiAssistantProvider`, `AiHomePage`, `ChatWidget`, `AiTourDetailPage`, … + `styles.css`.  
Native: `AiAssistantNativeProvider`, `ChatScreen` / `ChatWidget`, … (см. `packages/*/src/index.ts`).

---

# 11. Next.js Host

| Файл | Содержание |
|------|------------|
| `src/app/layout.tsx` | Metadata «Мила», шрифт Golos Text, `AppShell` |
| `src/app/page.tsx` | `<AiHomePage />` |
| `src/app/AppShell.tsx` | `AiAssistantProvider` (`apiBase`, `wsUrl`, `tourBasePath="/tours"`, `homePath="/"`) + `ChatWidget` |
| `src/app/tours/[id]/page.tsx` | `AiTourDetailPage` |
| `next.config.ts` | `transpilePackages: ['@tosmedia/ai-assistant']`; rewrites `/api`, `/ws` → `BACKEND_URL` если нет абсолютного `NEXT_PUBLIC_API_URL` |

Next: `^15.5.2`, React `^19.2.7`.

---

# 12. Environment Variables

Имена только (значения секретов не документируются).

| Переменная | Источник | Назначение |
|------------|----------|------------|
| `DB_HOST` | `.env.example` | MySQL host |
| `DB_USER` | `.env.example` | MySQL user |
| `DB_PASSWORD` | `.env.example` | MySQL password |
| `DB_NAME` | `.env.example` | MySQL database |
| `JWT_SECRET` | `.env.example` | JWT для `/api/ai-chats` (как totus_API) |
| `DEEPSEEK_API_KEY` | `.env.example` | Ключ модели |
| `LLM_BASE_URL` | `.env.example` + код | Override base URL |
| `LLM_MODEL` | `.env.example` + код | Override model |
| `LLM_TEMPERATURE` | `.env.example` + код | Temperature |
| `LLM_API_KEY` | **код** `llm.ts` | Альтернатива DeepSeek key |
| `LLM_THINKING` | **код** `llm.ts` | DeepSeek thinking mode |
| `LEVEL_TRAVEL_API_KEY` | `.env.example` | Partner token |
| `LEVEL_TRAVEL_API_VERSION` | `.env.example` | API version (дефолт 3.7) |
| `LEVEL_TRAVEL_BASE_URL` | **код** | Override API host |
| `LEVEL_TRAVEL_PUBLIC_URL` | **код** | Публичный сайт LT |
| `LEVEL_TRAVEL_AFLT` | **код** | Affiliate query param |
| `TOTUS_SITE_URL` | `.env.example` | База hotel-details (дефолт https://totus.club) |
| `TOTUS_EXCLUDED_COUNTRIES` | `.env.example` + код | ISO-коды исключений |
| `TOTUS_BOOKING_URL_TEMPLATE` | `.env.example` + код | Шаблон booking URL |
| `PORT` | `.env.example` | API port (3011) |
| `CORS_ORIGINS` | `.env.example` | CSV origins |
| `TOTUS_AGENT_NAME` | `.env.example` | Имя агента в промпте (дефолт Мила) |
| `TOTUS_COMPANY_PHONE` | `.env.example` | Телефон в промпте |
| `TOTUS_PROMO_INFO` | `.env.example` | Акции в промпте |
| `TOTUS_DEPARTURE_CITIES` | `.env.example` | Города вылета |
| `BACKEND_URL` | `.env.example` / next.config | Цель rewrites Next |
| `NEXT_PUBLIC_API_URL` | `.env.example` | Публичный API base для фронта |
| `NEXT_PUBLIC_WS_URL` | `.env.example` | Публичный WS URL |
| `TOTUS_LOG_DIR` | **код** `chatLog.ts` | Каталог diagnostic logs |

---

# 13. Scripts

Из корневого `package.json`:

| Script | Назначение |
|--------|------------|
| `predev` | `build:assistant` перед dev |
| `dev` | concurrently: API (`tsx server/index.ts`) + Next `:3012` |
| `dev:web` | `next dev -p 3012` |
| `server` / `start:api` | только API |
| `build` | `build:assistant` + `next build` |
| `build:assistant` | build workspace `@tosmedia/ai-assistant` |
| `build:assistant-native` | build native package |
| `build:web` | `next build` |
| `start` | API + `next start -p 3012` |
| `start:web` | только Next prod |
| `publish:assistant` | npm publish web package (GitHub Packages) |
| `publish:assistant:git` | git-ветка `pkg/ai-assistant` |
| `publish:assistant-native:git` | git-ветка `pkg/ai-assistant-native` |
| `lint` | `oxlint` |
| `typecheck:server` | `tsc --noEmit -p tsconfig.server.json` |

В пакетах: `build`, `typecheck`, у web ещё `build:css` / `pack:release`.

---

# 14. Deployment

Кратко по `DEPLOY.md`:

1. `git clone` → `cp .env.example .env` → заполнить ключи и production `NEXT_PUBLIC_*`.
2. `npm install` → `npm run build`.
3. `npm run start` или `pm2 start npm --name totus-ai -- start`.
4. Health: `http://127.0.0.1:3011/api/health`, UI `:3012`.
5. Nginx:
   - `ai.totus.club` → `127.0.0.1:3012` (с Upgrade headers).
   - `apiv2.totus.club` → `127.0.0.1:3011`; `/ws/assistant` с WebSocket upgrade и `proxy_read_timeout 3600s`.

Production env-минимум из DEPLOY: `PORT`, `CORS_ORIGINS`, `DEEPSEEK_API_KEY`, `LEVEL_TRAVEL_API_KEY`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_WS_URL`. Для истории чатов дополнительно `DB_*` + `JWT_SECRET`.

---

# 15. Existing Internal Docs

Читать **до** изменения поведения:

| Документ | Тема |
|----------|------|
| [`docs/KAK-RABOTAET-AI.md`](./docs/KAK-RABOTAET-AI.md) | Архитектура чата, web vs app, WS, карточки, deep-links |
| [`docs/KAK-RABOTAET-LLM.md`](./docs/KAK-RABOTAET-LLM.md) | Модель, промпт, tools, цикл ответа |
| [`docs/KAK-ISTORIYA-MYSQL.md`](./docs/KAK-ISTORIYA-MYSQL.md) | MySQL история, JWT, интеграция kedam/totusapp |
| [`docs/KAK-OBNOVIT-AI.md`](./docs/KAK-OBNOVIT-AI.md) | Как bump/publish пакеты и обновить kedam/totusapp |
| [`docs/sql/ai_chats.sql`](./docs/sql/ai_chats.sql) | DDL таблиц истории |
| [`DEPLOY.md`](./DEPLOY.md) | Nginx, pm2, prod env |
| [`ИСТОРИЯ_ПРОЕКТА.md`](./ИСТОРИЯ_ПРОЕКТА.md) | История решений / багфиксов |
| [`README.md`](./README.md) | Quick start |

Этот `AI_DOCUMENTATION_RU.md` — обзорная карта; детали сценариев и «почему так» — в `docs/KAK-*`.

---

# 16. Testing

- Автотесты (`*.test.*` / `*.spec.*`, jest/vitest config) — **Не найдено в текущей кодовой базе.**
- Доступны: `npm run typecheck:server`, `npm run lint` (`oxlint`), typecheck внутри пакетов.

---

# 17. Important Files

| Файл | Зачем открывать |
|------|-----------------|
| `server/index.ts` | Все HTTP routes + WS |
| `server/assistant.ts` | Сессии, restore, выбор LLM vs rules |
| `server/llm.ts` | Tools + LLM loop |
| `server/totusPrompt.ts` | Поведение Милы (промпт) |
| `server/levelTravel.ts` | Поиск, офферы, hotel-details URL |
| `server/chatHistory.ts` / `db.ts` / `authUser.ts` | История + JWT |
| `server/chatLog.ts` | Diagnostic journal |
| `packages/ai-assistant/src/hooks/useWebSocket.ts` | Клиентский WS-протокол (web) |
| `packages/ai-assistant-native/src/hooks/useWebSocket.ts` | То же для RN |
| `packages/*/src/lib/bookingHref.ts` | Ссылки на hotel-details у хоста |
| `packages/*/src/lib/historyApi.ts` | REST история чатов |
| `src/app/AppShell.tsx` | Wiring Next host |
| `next.config.ts` | Rewrites |
| `.env.example` | Канонический список env |
| `scripts/publish-*-git.sh` | Публикация UI-пакетов |

---

# 18. Instructions for Claude Code

## Где менять что

| Задача | Где |
|--------|-----|
| Тон / правила / сценарии Милы | `server/totusPrompt.ts` |
| Список/схемы tools, tool loop | `server/llm.ts` |
| Поиск LT, фильтры, deep-links | `server/levelTravel.ts` |
| WS protocol / restore | `server/index.ts` + `assistant.ts` + `packages/*/hooks/useWebSocket.ts` |
| История MySQL | `db.ts`, `chatHistory.ts`, `docs/sql/` |
| Web UI чата/карточек | `packages/ai-assistant/src/**` |
| RN UI | `packages/ai-assistant-native/src/**` |
| Хост ai.totus.club | `src/app/**` |

## Как запустить локально

```bash
cp .env.example .env   # ключи: DEEPSEEK_API_KEY, LEVEL_TRAVEL_API_KEY, …
npm install
npm run build:assistant
npm run dev
# UI http://localhost:3012 · API http://localhost:3011/api/health · WS :3011/ws/assistant
```

## Правила

1. **Перед сменой поведения** ассистента прочитай `docs/KAK-RABOTAET-AI.md` и `docs/KAK-RABOTAET-LLM.md` (и при истории — `KAK-ISTORIYA-MYSQL.md`).
2. **После изменений UI** — bump version в `package.json` пакета и `npm run publish:assistant:git` / `publish:assistant-native:git`; потребители ставят с `pkg/*` веток (`docs/KAK-OBNOVIT-AI.md`).
3. **Не ломай WS-протокол**: типы `chat` / `reset` / `restore` и серверные `token` / `done` / `tours` / `rooms` / `destinations` / `tool` / `typing` / `error` — контракт web + RN.
4. **JWT только для истории** (`/api/ai-chats*`). WS остаётся без аутентификации.
5. **Deep-links** на бронирование — на `totus.club` `/hotel-details` (через `TOTUS_SITE_URL` / `buildTotusHotelUrl`), не отдавать клиенту сырой Level.Travel как основной UX.
6. Не коммитить секреты из `.env`; в доках — только имена переменных.
7. Не писать diagnostic dumps внутрь дерева проекта (см. комментарии в `levelTravel.ts` / `chatLog.ts` — ломает hot-reload).

---

*Сгенерировано по состоянию кодовой базы `totus_ai_v2`. При расхождении с кодом приоритет у исходников.*
