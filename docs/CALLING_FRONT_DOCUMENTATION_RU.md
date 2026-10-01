# Calling Front Documentation (RU) — calling_v2

Документация по коду репозитория `calling_v2`, ветка **`develop`** (она стоит на prod как `front_calling`).

**27.08.2026 — админка выделена в отдельный репозиторий `tosmedia/Totus_admin`** (PR #1 `claude/split-admin` → `develop`). После мержа `calling_v2` — **только звонки**: логин агента, список пользователей для звонка, WebRTC. Всё про заказы, CMS, страницы — см. `ADMIN_DOCUMENTATION_RU.md`.

Backend (Express, Socket.io): **`CALLING_API_DOCUMENTATION_RU.md`**.  
Секреты (TURN credentials) не приводятся — только факт захардкоженности.

Git: `https://github.com/tosmedia/calling_v2.git` · prod-ветка `develop` · `main` — устаревший снимок (март 2026)

**01.09.2026 — PR #5 (волна 3 плана `SECURITY_JWT_PLAN_RU.md`: agent-JWT, `authFetch`, socket auth) смержен в `main` и задеплоен на прод.** Актуальный код авторизации — в `main`; запись о prod-ветке выше требует сверки с сервером.

---

## 1. Назначение

**totus-web-calling** — браузерная панель **агента поддержки** для звонков клиентам в мобильное приложение:

- вход по email/password (только `role: agent`);
- список пользователей приложения: online / VoIP-токен / access;
- исходящие звонки через WebRTC (браузер ↔ totusapp iOS/Android), входящие от приложения;
- блокировка/разблокировка пользователя (`access`) — нужна для кнопки «Позвонить»;
- проверка доступности STUN/TURN.

Переход в админку — по ссылке на `Totus_admin` (admin.totus.club, когда задеплоят).

---

## 2. Архитектура

```
Browser (calling_v2, Next.js :3008)
        │  HTTPS → REST (login, users, register-device, calls)
        │  WSS   → Socket.io (offer / answer / ice-candidate / call-state)
        ▼
https://voip.totus.club   ← lib/server.ts (SERVER_BASE_URL)
        ▼
calling_api_v2 (Express :4444) → MySQL kedam.users, APNs VoIP push, Socket.io ↔ totusapp
```

`server.totus.club` (NXDOMAIN) остался только в закомментированной строке `lib/server.ts` — **исправлено**, документация ранее была неточна.

---

## 3. Стек и конфигурация

| Компонент | Значение |
|-----------|----------|
| Framework | Next.js 14 (App Router), React 18, TypeScript 5 |
| Real-time | socket.io-client ^4.5.4 |
| Порт | **3008** (`next dev -p 3008` / `next start -p 3008`) |
| Env | нет `.env`; все URL в `lib/server.ts` (константа) |
| Path alias | `@/*` → `./*` |

---

## 4. Структура (после PR #1)

```
calling_v2/
├── app/
│   ├── layout.tsx            # Inter, AuthGuard, GlobalCallManager
│   ├── page.tsx              # Dashboard агента (~1360 строк)
│   ├── login/page.tsx
│   └── globals.css
├── components/
│   ├── AuthGuard.tsx         # redirect /login ↔ /
│   ├── CallModal.tsx         # UI активного звонка
│   └── GlobalCallManager.tsx # приём входящих на любой странице, poll webrtc-service
└── lib/
    ├── server.ts             # SERVER_BASE_URL = https://voip.totus.club
    ├── http.ts               # с 01.09: authFetch (Bearer + refresh-once), webAppToken / webAppRefresh
    ├── auth-api.ts           # login, localStorage webAppUser / webLoyaltyId, токены (с 01.09)
    ├── users-api.ts          # getAllUsers, getUserByLoyaltyId, updateUserAccess — через authFetch
    └── webrtc-service.ts     # WebRTC + Socket.io (~1400 строк), ICE servers, TURN creds (hardcoded); все fetch → authFetch
```

Удалено в PR #1 (переехало в `Totus_admin`): `app/{users,orders,lt-orders,pages,home-content,callback-requests,banners,faq,partners}`, `components/{AdminNav,PageShell,RichTextEditor,admin/*}`, `lib/{orders,pages,home-*,faq,footer-*,callback-requests}-api.ts`.

---

## 5. Маршруты

| URL | Файл | Описание |
|-----|------|----------|
| `/login` | `app/login/page.tsx` | Вход агента |
| `/` | `app/page.tsx` | Dashboard: агент, таймер, список пользователей, STUN/TURN |

---

## 6. Авторизация агента (с 01.09.2026, PR #5)

1. `POST {SERVER_BASE_URL}/api/web/login` `{ email, password }` → `{ ok, user, accessToken, refreshToken }` (agent-JWT 12 ч / refresh 30 д; на бэкенде bcrypt).
2. `storeUser(user)` → `localStorage.webAppUser`; `webLoyaltyId` — для WebRTC; `lib/auth-api.ts` сохраняет токены в `localStorage.webAppToken` / `webAppRefresh`.
3. `isAuthenticated()` = `user.role === 'agent'` **и** токен не просрочен.
4. `lib/http.ts` → `authFetch`: для запросов к `SERVER_BASE_URL` подставляет `Authorization: Bearer <webAppToken>`; на `401` — один refresh через `totus_API POST /api/auth/refresh { refreshToken }` → повтор запроса; если refresh не удался — очистка сессии и редирект на `/login`.
5. `removeUser()` (logout) чистит `webAppUser`, `webAppToken`, `webAppRefresh`.
6. Socket.io: `io(BASE_URL, { transports: ['websocket'], auth: { token } })` — токен проверяет `socketGate` на бэкенде.

Бэкенд (`calling_api_v2`) на проде в `AUTH_MODE=log` — токен пока не обязателен, но панель уже шлёт его везде (см. API doc §6).

Тип `User`: `id, loyaltyId, name, fName, lName, email, phone, role`.

---

## 7. Dashboard (`app/page.tsx`)

- Init: `getStoredUser()` → `initWebRTCWithLoyaltyId(loyaltyId)` → callbacks состояния звонка → `loadUsers()` + интервал 10 с.
- Секции: шапка (агент, loyaltyId, logout, таймер), карточки пользователей (online / VoIP / access / «Позвонить»), статус STUN/TURN («Проверить серверы»).
- Кнопка «Позвонить» disabled, если: свой loyaltyId, нет loyaltyId, заблокирован, offline **и** нет VoIP-токена.
- Чекбокс access → `updateUserAccess(user.id, hasAccess)` (`PATCH /api/users/:userId/access`). ⚠️ Семантика `access` на backend противоречива — см. API doc §7.

`GlobalCallManager` (в `layout.tsx`) опрашивает `webrtc-service` и показывает `CallModal` при входящем на любой странице.

---

## 8. WebRTC (`lib/webrtc-service.ts`)

- Init: UUID `deviceId` → `POST /api/register-device` `{ deviceId, loyaltyId, voipToken: 'web', platform: 'web' }` (через `authFetch`) → `io(SERVER_BASE_URL, { transports: ['websocket'], auth: { token } })` → `emit('registerDevice')` → Notification permission.
- Все 12 HTTP-вызовов в файле идут через `authFetch` (с 01.09).
- Outgoing: `getUserMedia({audio})` → `RTCPeerConnection` → `createOffer` → `POST /api/calls` → ответ по сокету `answer` (таймаут 30 с) + HTTP-poll fallback.
- Incoming: сокет `offer` / `call-state` → `CallModal` → `answerCall()` → `POST /api/calls/:callId/answer`.
- ICE: STUN `stun1/2.totus.club:3478`; TURN `turn1/2.totus.club:3478` (udp/tcp), TURNS `:5349`. Username/credential **захардкожены** (риск — в бандле клиента).
- Options: `iceCandidatePoolSize 10`, `iceTransportPolicy all`, `bundlePolicy max-bundle`, `rtcpMuxPolicy require`.
- States: `idle | calling | ringing | answered | ended | rejected`.
- Exports: `getCallState`, `getActiveCallInfo`, `toggleMute`, `toggleSpeaker`, `endCall`, `rejectCall`, `checkAllServersStatus`, `getIceServers`.

---

## 9. HTTP и Socket.io

Base: `SERVER_BASE_URL` (voip.totus.club). Все запросы кроме логина — через `authFetch` (`lib/http.ts`, Bearer agent-JWT); refresh — `POST {totus_API}/api/auth/refresh`.

| Method | Path | Файл |
|--------|------|------|
| POST | `/api/web/login` | auth-api (без Bearer) |
| GET | `/api/users`, `/api/users/:loyaltyId` | users-api (authFetch) |
| PATCH | `/api/users/:userId/access` | users-api (authFetch) |
| POST | `/api/register-device` | webrtc-service (authFetch) |
| POST | `/api/calls`, `/api/calls/:id/answer`, `/candidate`, `/end`, `/reject` | webrtc-service (authFetch) |
| GET | `/api/calls/:id` | webrtc-service (poll, authFetch) |

Socket: `io(BASE_URL, { transports: ['websocket'], auth: { token } })`. Listen: `call-state`, `offer`, `answer`, `ice-candidate`. Emit: `registerDevice`, `answer`, `ice-candidate`.

---

## 10. CallModal

Poll `webrtc-service` каждые 500 мс; caller name, state, таймер, Answer / Reject / End, Mute, Speaker; полноэкранный overlay при `callState !== 'idle'`.

---

## 11. Production и деплой

| Param | Value |
|-------|-------|
| nginx | `calling.totus.club` → `127.0.0.1:3008` |
| PM2 | `front_calling`, `/home/calling_v2`, ветка `develop` |

После мержа PR #1 на сервере:

```bash
cd /home/calling_v2
git remote set-url origin https://github.com/tosmedia/calling_v2.git   # после переноса репо
git pull && npm install && npm run build && pm2 restart front_calling
```

Локально с локальным API — поменять константу в `lib/server.ts` (закомментированная строка `192.168.x.x:4444` уже есть).

---

## 12. Безопасность (frontend)

| Риск | Детали |
|------|--------|
| Сессия и agent-JWT в localStorage (`webAppUser`, `webAppToken`, `webAppRefresh`) | XSS → hijack токена. С 01.09 Bearer шлётся на все voip-запросы и в socket handshake; backend в `AUTH_MODE=log` (Б.2 — enforce после релиза приложения) |
| TURN creds в бандле | `webrtc-service.ts` — Б.1, не исправлено |
| URL без env | prod/dev переключается правкой `lib/server.ts` |

---

## 13. Инструкции для Claude Code

| Задача | Файл |
|--------|------|
| Dashboard / список | `app/page.tsx` |
| Login / токены | `app/login/page.tsx`, `lib/auth-api.ts` |
| HTTP с Bearer / refresh | `lib/http.ts` (`authFetch`) — новые запросы к voip только через него |
| WebRTC / звонки | `lib/webrtc-service.ts` |
| Call UI | `components/CallModal.tsx`, `GlobalCallManager.tsx` |
| Base URL | `lib/server.ts` |

**Не добавлять сюда админ-разделы** — они в `Totus_admin`. **Не ломать:** totusapp использует тот же signaling и ICE; `loyaltyId` нормализуется без пробелов на сервере.

---

*27 августа 2026; обновлено 01.09.2026 (PR #5 — agent-JWT, `authFetch`, socket auth). Repo: `calling_v2`.*
