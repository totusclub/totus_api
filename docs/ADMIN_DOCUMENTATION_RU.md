# Admin Documentation (RU) — Totus_admin

Админ-панель Totus Club. **Выделена из `calling_v2` (ветка `develop`) 27.08.2026** — до этого админка жила внутри панели звонков.

Git: `https://github.com/tosmedia/Totus_admin` (ветка `main`)  
Документация построена по коду на момент выделения. При расхождении — код прав.

---

## 1. Назначение

Операционная панель для агентов/менеджеров Totus Club:

- пользователи приложения (просмотр, поиск, блокировка `access`);
- заказы (локальные из `totus_API` и живые из Level.Travel);
- CMS сайта: страницы, главная (hero, баннеры, контент, FAQ, партнёры, соцсети футера);
- заявки на обратный звонок.

**Звонков здесь нет** — они в `calling_v2` (calling.totus.club); в навигации есть внешняя ссылка «Звонки».

---

## 2. Стек

| Компонент | Значение |
|-----------|----------|
| Framework | Next.js 14 (App Router), React 18, TypeScript 5 |
| Стили | inline-styles (тёмная тема, акцент `#FE732E`), общий `PageShell` |
| package name / version | `totus-admin` / `0.1.0` |
| Dev / prod порт | **3009** (`next dev -p 3009`, `next start -p 3009`) |
| Зависимости | `next`, `react`, `react-dom`, `socket.io-client` (унаследован, не используется — можно удалить) |

---

## 3. Env

`.env.example`:

```
NEXT_PUBLIC_VOIP_API_URL=https://voip.totus.club     # auth агента, users
NEXT_PUBLIC_API_BASE_URL=https://api.totus.club      # заказы, CMS (/api/admin/*)
```

Значения по умолчанию зашиты в `lib/server.ts`, env их переопределяет. Секретов в репо нет.

---

## 4. Структура

```
Totus_admin/
├── app/
│   ├── layout.tsx            # AuthGuard, без GlobalCallManager
│   ├── page.tsx              # redirect → /users
│   ├── login/page.tsx        # вход агента
│   ├── users/page.tsx        # пользователи + access
│   ├── orders/page.tsx       # все заказы (агрегация по пользователям)
│   ├── orders/[orderId]/     # детали заказа, документы
│   ├── lt-orders/page.tsx    # заказы Level.Travel по auth_token
│   ├── pages/page.tsx        # CMS-страницы (список)
│   ├── pages/[slug]/         # редактор страницы (RichTextEditor)
│   ├── home-content/page.tsx # CMS главной: секции
│   ├── callback-requests/    # заявки на звонок
│   └── banners/ faq/ partners/   # заглушки/редиректы (по 130 байт)
├── components/
│   ├── AdminNav.tsx          # Пользователи · Заказы · Level Travel · Страницы · Главная · Заявки · Звонки↗
│   ├── AuthGuard.tsx
│   ├── PageShell.tsx
│   ├── RichTextEditor.tsx
│   └── admin/home/           # HeroBanners, Content, Faq, Partners, FooterSocial, CallbackRequests, styles
├── lib/
│   ├── server.ts             # SERVER_BASE_URL (voip), API_BASE_URL (kedam)
│   ├── auth-api.ts           # POST /api/web/login (voip), localStorage webAppUser
│   ├── users-api.ts          # GET /api/users, PATCH /api/users/:id/access (voip)
│   ├── orders-api.ts         # /user/orders, /orders, /orders/documents, /client/orders* (kedam)
│   ├── pages-api.ts          # /api/admin/pages* (kedam)
│   ├── home-content-api.ts, home-banners-api.ts, home-partners-api.ts,
│   │   faq-api.ts, footer-social-api.ts, callback-requests-api.ts   # /api/admin/* (kedam)
│   └── footer-pages-catalog.ts   # каталог slug'ов статичных страниц сайта
├── .env.example · README.md · CLAUDE.md
```

---

## 5. Auth

**В `main` (до мержа PR #3):**

- `POST {VOIP}/api/web/login` `{ email, password }` → `{ ok, user }`; пускает только `role === 'agent'`. Сессия — `localStorage.webAppUser`; `AuthGuard` редиректит на `/login`.
- Отдельный staff-вход через `totus_API` (`lib/staff-auth-api.ts`, refresh-once) — только у раздела «Обращения» (PR #1/#2); `authFetch` с Bearer — только у `order-requests`. Остальные `lib/*-api.ts` (CMS, orders, users) и voip-маршруты — **без токена**.

**В PR [Totus_admin#3](https://github.com/tosmedia/Totus_admin/pull/3) (волна 2 плана `SECURITY_JWT_PLAN_RU.md`, открыт 01.09, ждёт согласования текстов экрана входа и мержа):**

- **Единый staff-вход:** `/login` → `staffSignIn` (`totus_API POST /api/admin/auth/sign-in`, staff access 12 ч / refresh 30 д); `AuthGuard` проверяет `staffAuth` (заменяет вход агента через voip `/api/web/login`); у «Обращений» убрана своя форма входа.
- **Глобальный Bearer:** `lib/http.ts` — обёртка `window.fetch`, подставляет staff-токен во все запросы к `totus_API` и к voip (`calling_api_v2` принимает роль `staff` для `/api/users*`). Отдельные `authFetch` в `lib/*-api.ts` не нужны.
- **Перед деплоем** нужна staff-учётка в таблице `staff` `totus_API` — `scripts/create-staff-user.js`.

Серверная сторона: с 01.09 `totus_API` и `calling_api_v2` проверяют токены в **log-режиме** (`AUTH_MODE=log` — без токена запросы пока проходят, только логируются); `enforce` в `totus_API` — после мержа PR #3 и анализа логов 3–5 дней. До этого админка защищена только клиентским guard'ом (Б.2/Б.3 в `ROADMAP_RU.md`).

---

## 6. Backend-зависимости

| Backend | Эндпоинты | Док |
|---------|-----------|-----|
| voip.totus.club (`calling_api_v2`) | `/api/web/login`, `/api/users`, `/api/users/:id/access` | `CALLING_API_DOCUMENTATION_RU.md` §6–7 |
| api.totus.club (`totus_API`) | `/user/orders`, `/orders`, `/orders/documents`, `/client/orders`, `/client/orders/:id`, `/api/admin/pages*`, `/api/admin/home-*`, `/api/admin/faq*`, `/api/admin/footer-social*`, `/api/admin/callback-requests*`, `/api/content/upload*` | `API_DOCUMENTATION_RU.md` §4.4, 4.9, 4.10 |

`getAllOrders()` в `orders-api.ts` собирает «все заказы» перебором `/user/orders` по каждому пользователю батчами по 8 — на большой базе будет медленно; нормальный путь — `GET /api/admin/auth/orders` в totus_API (с 01.09 под `requireAuth(['staff'])` в log-режиме, см. API doc §4.7).

С 01.09 `totus_API` отдаёт CORS только для whitelist `CORS_ORIGINS` (дефолт — домены totus.club + localhost), `calling_api_v2` — тоже whitelist: при деплое на `admin.totus.club` проверить, что origin входит в список.

---

## 7. Деплой (план)

| Param | Value |
|-------|-------|
| Домен | `admin.totus.club` — **DNS и nginx ещё не настроены** |
| Порт | 3009 |
| PM2 | `front_admin` (предложение) |
| Путь на сервере | `/home/Totus_admin` (предложение) |

```bash
git clone https://github.com/tosmedia/Totus_admin.git /home/Totus_admin
cd /home/Totus_admin && npm install && npm run build
pm2 start npm --name front_admin -- start
# nginx: admin.totus.club → 127.0.0.1:3009 (по образцу calling.totus.club), certbot
```

CORS: с 01.09 оба бэкенда используют whitelist (`CORS_ORIGINS` в `.env` totus_API и calling_api_v2; дефолт — домены totus.club + localhost) — `admin.totus.club` должен входить в список. Перед деплоем PR #3 — создать staff-учётку (`scripts/create-staff-user.js`).

---

## 8. Известные хвосты

- `next build` после выделения **не запускался** (перенос через GitHub API) — обязательно собрать перед деплоем.
- JWT: единый staff-вход и глобальный Bearer — в PR #3 (открыт 01.09, не смержен); до мержа большинство запросов к `totus_API`/voip идут без токена (бэкенды в log-режиме, не блокируют). Нужно: утвердить тексты экрана входа (S5 в `SECURITY_JWT_PLAN_RU.md`), смержить, создать staff-учётку.
- `components/admin/home/CallbackRequestsSection.tsx` не используется (есть отдельная страница `/callback-requests`).
- `socket.io-client` в зависимостях лишний.
- `/banners`, `/faq`, `/partners` — заглушки.

---

## 9. Инструкции для Claude Code

| Задача | Где |
|--------|-----|
| Новый раздел админки | `app/<section>/page.tsx` + пункт в `components/AdminNav.tsx` + `lib/<section>-api.ts` |
| CMS главной | `components/admin/home/*`, `lib/home-*-api.ts` |
| Заказы | `lib/orders-api.ts`, `app/orders/*`, `app/lt-orders` |
| Base URL | только `lib/server.ts` + env |
| Auth / Bearer | после PR #3: `lib/http.ts` (обёртка fetch, staff Bearer), `AuthGuard` по `staffAuth`; отдельные `authFetch` в `lib/*-api.ts` не добавлять |

Правила: не выдумывать эндпоинты (только `API_DOCUMENTATION_RU.md` / `CALLING_API_DOCUMENTATION_RU.md`); звонки сюда не добавлять; ветки `claude/*`, PR в `main`.

---

*27 августа 2026; обновлено 01.09.2026 (auth: PR #3 открыт). Repo: `Totus_admin`.*
