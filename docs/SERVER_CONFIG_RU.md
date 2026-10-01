# TOTUS Production Server — полная конфигурация

**Снимок с сервера (read-only audit):** 26 августа 2026  
**IP:** `109.73.206.121`  
**Hostname:** `msk-1-vm-vovu`  
**OS:** Ubuntu 22.04.5 LTS (Jammy), kernel 5.15.0-187-generic, x86_64

> Секреты (пароли SSH, DB, API keys, `.env` values) **не включены** — только имена переменных и пути к файлам.

---

## Содержание

1. [Сводная таблица доменов и портов](#1-сводная-таблица-доменов-и-портов)
2. [Слушающие порты](#2-слушающие-порты)
3. [PM2 — процессы приложений](#3-pm2--процессы-приложений)
4. [Nginx — reverse proxy](#4-nginx--reverse-proxy)
5. [TLS / Let's Encrypt](#5-tls--lets-encrypt)
6. [MySQL](#6-mysql)
7. [Пути приложений на сервере](#7-пути-приложений-на-сервере)
8. [Git remotes (на сервере)](#8-git-remotes-на-сервере)
9. [Переменные окружения (имена)](#9-переменные-окружения-имена)
10. [Прочие сервисы](#10-прочие-сервисы)
11. [Ресурсы сервера](#11-ресурсы-сервера)
12. [Важные замечания](#12-важные-замечания)
13. [Связанные документы](#13-связанные-документы)

---

# 1. Сводная таблица доменов и портов

| Публичный домен | HTTPS | nginx → backend | PM2 / процесс | Путь на сервере | Назначение |
|-----------------|-------|-----------------|---------------|-----------------|------------|
| **totus.club**, www.totus.club | ✅ 443 | `127.0.0.1:3000` | `front` | `/home/kedam_WEB` | Основной сайт (Next.js) |
| **api.totus.club** | ✅ 443 | `127.0.0.1:3001` | `api` | `/home/kedam_API` | Backend API (Express, kedam) |
| **voip.totus.club** | ✅ 443 | `127.0.0.1:4444` | `api_calling` + node | `/home/calling_api_v2` | VoIP API + WebSocket (signaling) |
| **calling.totus.club** | ✅ 443 | `127.0.0.1:3008` | `front_calling` | `/home/calling_v2` | Web-админка агента (звонки) |
| **ai.totus.club** | ✅ 443 | `127.0.0.1:3012` | `totus-ai-web` | `/home/totus_ai_v2` | AI UI (Next.js host) |
| **apiv2.totus.club** | ✅ 443 | `127.0.0.1:3011` | `totus-ai-api` | `/home/totus_ai_v2` | AI API + WS `/ws/assistant` |
| **109.73.206.121** (IP) | — | `:80` default | nginx | phpMyAdmin `/phpmyadmin` | phpMyAdmin (Basic Auth) |
| **admin.totus.club** *(план)* | — | `127.0.0.1:3009` | `front_admin` | `/home/Totus_admin` | Админ-панель (`tosmedia/Totus_admin`, выделена из calling_v2 27.08.2026) — **DNS/nginx/PM2 ещё не настроены** |

### Домены в коде, но **не** в nginx на этом сервере

| Домен | Статус |
|-------|--------|
| **server.totus.club** | **NXDOMAIN** (DNS не найден). В `calling_v2` hardcoded как API URL — **не работает** без DNS или смены на `voip.totus.club` |

### STUN/TURN (WebRTC)

| Host | Порт | На этом сервере |
|------|------|-----------------|
| stun1/2.totus.club | 3478 | **Не слушает** (3478/5349 не открыты на 109.73.206.121) |
| turn1/2.totus.club | 3478, 5349 | **Предположение:** отдельный хост или не развёрнут |

---

# 2. Слушающие порты

| Порт | Bind | Процесс | Назначение |
|------|------|---------|------------|
| **22** | 0.0.0.0 | sshd | SSH |
| **53** | 127.0.0.53 | systemd-resolved | Local DNS |
| **80** | 0.0.0.0 | nginx | HTTP (redirect / default / phpMyAdmin) |
| **443** | 0.0.0.0 | nginx | HTTPS (все *.totus.club vhost) |
| **3306** | 0.0.0.0 | mysqld | MySQL (открыт наружу) |
| **33060** | 127.0.0.1 | mysqld | MySQL X Protocol |
| **3000** | * | next-server | totus_WEB |
| **3001** | * | node (totus_API/app.js) | totus_API |
| **3008** | * | next-server | calling_v2 |
| **3011** | * | node (totus_ai_v2 server) | AI API + WebSocket |
| **3012** | * | next-server | AI web host |
| **4444** | * | node (calling_api_v2/index.js) | VoIP backend |
| **10050** | 0.0.0.0 | zabbix_agentd | Zabbix monitoring |

**UFW:** inactive (firewall выключен, INPUT policy ACCEPT).

---

# 3. PM2 — процессы приложений

**Manager:** PM2 v7.0.1 (`pm2-root.service`, autostart enabled)

| PM2 name | PID (snapshot) | CWD | Command | Uptime (snapshot) |
|----------|----------------|-----|---------|-------------------|
| **front** | 300558 | `/home/kedam_WEB` | `npm start` → Next `:3000` | ~2 days |
| **api** | 2599 | `/home/kedam_API` | `node app.js` `:3001` | ~19 days |
| **front_calling** | 708 | `/home/calling_v2` | `npm start` → Next `:3008` | ~19 days |
| **api_calling** | 706 | `/home/calling_api_v2` | `npm start` → node `:4444` | ~19 days |
| **totus-ai-api** | 299707 | `/home/totus_ai_v2` | `npm run server` → `:3011` | ~2 days |
| **totus-ai-web** | 299296 | `/home/totus_ai_v2` | `npm run start:web` → `:3012` | ~2 days |

**Node.js на сервере:** v20.20.2  
**npm:** 10.8.2

---

# 4. Nginx — reverse proxy

**Config:** `/etc/nginx/nginx.conf`  
**Sites enabled:** `/etc/nginx/sites-enabled/`

| File | server_name | proxy_pass | Особенности |
|------|-------------|------------|-------------|
| `totus.club` | totus.club, www.totus.club | `:3000` | WebSocket Upgrade headers |
| `api.totus.club` | api.totus.club | `:3001` | **`client_max_body_size 20M`** (CMS uploads) |
| `voip.totus.club` | voip.totus.club | `:4444` | WebSocket Upgrade |
| `calling.totus.club` | calling.totus.club | `:3008` | WebSocket Upgrade |
| `ai.totus.club` | ai.totus.club | `:3012` | `proxy_read_timeout 300`, `proxy_connect_timeout 300` |
| `apiv2.totus.club` | apiv2.totus.club | `:3011` | `proxy_read_timeout 3600s`, `proxy_send_timeout 3600s` (WS AI) |
| `default` | `_` (default_server) | static/php | phpMyAdmin на `/phpmyadmin` |

### Общие настройки HTTPS (все vhost)

```nginx
listen 443 ssl http2;
ssl_certificate /etc/letsencrypt/live/<domain>/fullchain.pem;
ssl_certificate_key /etc/letsencrypt/live/<domain>/privkey.pem;
include /etc/nginx/snippets/ssl-totus-tspu.conf;
ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
```

### HTTP → HTTPS

На всех `*.totus.club` vhost: Certbot-managed `301` redirect с `:80` на HTTPS.

### `default` (port 80)

- `listen 80 default_server`
- `root /var/www/html`
- **phpMyAdmin:** `location ^~ /phpmyadmin` → `/usr/share/phpmyadmin`, PHP 8.1-FPM, **Basic Auth** (`/etc/nginx/.phpmyadmin_htpasswd`)

### Global SSL (nginx.conf + snippet)

**`/etc/nginx/snippets/ssl-totus-tspu.conf`:**

```nginx
ssl_protocols TLSv1.2;
ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305;
ssl_prefer_server_ciphers off;
ssl_session_cache shared:SSL:50m;
ssl_session_timeout 1d;
ssl_session_tickets off;
```

**Дополнительно в `nginx.conf`:** `keepalive_timeout 75s`, `keepalive_requests 1000` (комментарий: Russia TSPU).

---

# 5. TLS / Let's Encrypt

**Certbot timer:** active (auto-renewal)

| Certificate | Domains | Expiry (UTC) | Days left (snapshot) |
|-------------|---------|--------------|----------------------|
| totus.club | totus.club, www.totus.club | 2026-11-24 | ~89 |
| api.totus.club | api.totus.club | 2026-11-24 | ~89 |
| voip.totus.club | voip.totus.club | 2026-11-24 | ~89 |
| calling.totus.club | calling.totus.club | 2026-11-24 | ~89 |
| ai.totus.club | ai.totus.club | 2026-11-08 | ~73 |
| apiv2.totus.club | apiv2.totus.club | 2026-11-08 | ~73 |

**Paths:** `/etc/letsencrypt/live/<domain>/`

---

# 6. MySQL

| Param | Value |
|-------|-------|
| Service | `mysql.service` (active) |
| Port | **3306** (0.0.0.0 — доступен извне) |
| Databases | `kedam`, `phpmyadmin` |
| App DB | **kedam** (shared: totus_API, calling_api_v2 users, totus_ai_v2 chats) |

**Config app:** `/home/kedam_API/.env` — `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`  
**totus_ai_v2:** `/home/totus_ai_v2/.env` — отдельные `DB_*` (могут указывать на тот же kedam)  
**calling_api_v2:** DB-креды по-прежнему в коде `db.js` (Б.1); `/home/calling_api_v2/.env` (создан 01.09) — auth-переменные (`JWT_SECRET`, `JWT_REFRESH_SECRET`, `AUTH_MODE`), см. §9.

---

# 7. Пути приложений на сервере

| Path | Stack | Port | PM2 |
|------|-------|------|-----|
| `/home/kedam_WEB` | Next.js 15.x | 3000 | front |
| `/home/kedam_API` | Express 5 (app.js) | 3001 | api |
| `/home/calling_v2` | Next.js (`next start -p 3008`) | 3008 | front_calling |
| `/home/calling_api_v2` | Express + Socket.io; с 01.09 есть `.env` (JWT-гейт, `AUTH_MODE=log`) | 4444 | api_calling |
| `/home/totus_ai_v2` | Express/tsx + Next | 3011 + 3012 | totus-ai-api, totus-ai-web |

> **Деплой после волн 1/3 (01.09.2026):** для `api` (`/home/kedam_API`) и `api_calling` (`/home/calling_api_v2`) **`npm install` обязателен** — добавлены зависимости (`helmet`, `express-rate-limit` в totus_API; `bcryptjs`, `dotenv`, `express-rate-limit`, `jsonwebtoken` в calling_api_v2). Стандартная последовательность: `git pull && npm install && pm2 restart <name>`; для фронтов — плюс `npm run build`. У `api_calling` после рестарта в логах — стартовая строка `[AUTH] mode=log`.

**Другие пути:**

| Path | Назначение |
|------|------------|
| `/var/www/html` | nginx default root |
| `/usr/share/phpmyadmin` | phpMyAdmin |
| `/etc/nginx/sites-available/` | nginx vhost configs |
| `/root/.pm2/` | PM2 logs & dumps |

---

# 8. Git remotes (на сервере)

| Directory | Remote | Branch |
|-----------|--------|--------|
| `/home/kedam_API` | `https://github.com/tosmedia/totus_API.git` | main |
| `/home/kedam_WEB` | `https://github.com/tosmedia/totus_WEB.git` | main |
| `/home/calling_v2` | `https://github.com/tosmedia/calling_v2.git` | `claude/split-admin` *(временно; после мержа PR #1 вернуть на `develop`)* |
| `/home/calling_api_v2` | `https://github.com/tosmedia/calling_api_v2.git` | prod |
| `/home/totus_ai_v2` | `https://github.com/tosmedia/totus_ai_v2.git` | main |

> **31.08.2026:** репозитории `kedam_API` и `kedam_WEB` переименованы на GitHub в `totus_API` и `totus_WEB`; владелец подтвердил, что `git remote` на сервере обновлён в обеих папках. Папки на сервере (`/home/kedam_API`, `/home/kedam_WEB`), PM2-процессы, nginx, `.env` и база `kedam` **не переименовывались** — намеренно.

> **27.08.2026:** `calling_v2` и `calling_api_v2` перенесены в `tosmedia/*`; **владелец подтвердил**, что `git remote` на сервере обновлён в обеих папках. `/home/calling_v2` временно на ветке `claude/split-admin` (PR #1, админка вырезана) — после `pm2 restart front_calling` разделы админки пропадут с calling.totus.club до деплоя `Totus_admin`; после мержа PR #1 вернуть сервер на `develop`.

---

# 9. Переменные окружения (имена)

### `/home/kedam_API/.env`

```
PORT, DB_HOST, DB_USER, DB_PASSWORD, DB_NAME, JWT_SECRET, JWT_REFRESH_SECRET,
EMAIL_USER, EMAIL_PASS, EMAIL_FROM, PARTNER_API_KEY, VTB_CALLBACK_URL,
LT_CLIENT_AUTH_TOKEN, API_PUBLIC_URL, YANDEX_SMARTCAPTCHA_SERVER_KEY,
YC_POSTBOX_ACCESS_KEY_ID, YC_POSTBOX_SECRET_ACCESS_KEY
```

`PORT=3001`

Новые (с 01.09, PR totus_API#3, см. `.env.example` в репо): `AUTH_MODE` (на проде `log`), `AUTH_LOG_ONLY_PATHS`, `CORS_ORIGINS`, `USER_ACCESS_TTL`, `USER_REFRESH_TTL`, `AGENT_ACCESS_TTL`, `AGENT_REFRESH_TTL`, `STAFF_ACCESS_TTL`, `STAFF_REFRESH_TTL`, `AUTH_RATE_WINDOW_MS`, `AUTH_RATE_LIMIT`.

### `/home/kedam_WEB/.env.local`

```
NEXT_PUBLIC_API_BASE_URL, NEXT_PUBLIC_YANDEX_SMARTCAPTCHA_SITEKEY
```

### `/home/totus_ai_v2/.env`

```
PORT, DEEPSEEK_API_KEY, LEVEL_TRAVEL_API_KEY, LEVEL_TRAVEL_API_VERSION,
TOTUS_SITE_URL, TOTUS_AGENT_NAME, TOTUS_COMPANY_PHONE, TOTUS_PROMO_INFO,
TOTUS_DEPARTURE_CITIES, CORS_ORIGINS, NEXT_PUBLIC_API_URL, NEXT_PUBLIC_WS_URL,
DB_HOST, DB_USER, DB_PASSWORD, DB_NAME, JWT_SECRET
```

`PORT=3011`

### `/home/calling_api_v2/.env` (создан владельцем 01.09.2026)

До волны 3 файла не было (в коде использовались только `PORT` default 4444 и `APN_VOIP_TOPIC`). С PR calling_api_v2#1 `dotenv` читает `.env`:

```
JWT_SECRET, JWT_REFRESH_SECRET     # те же значения, что в /home/kedam_API/.env
AUTH_MODE=log
```

Также поддерживаются (см. `.env.example` в репо): `AUTH_LOG_ONLY_PATHS`, `CORS_ORIGINS`, `AUTH_RATE_WINDOW_MS`, `AUTH_RATE_LIMIT`, `PORT`, `APN_VOIP_TOPIC`. DB-креды остаются в `db.js` (Б.1).

> При ротации `JWT_SECRET` (волна 2) менять **в обоих** `.env` (`kedam_API` и `calling_api_v2`) одновременно — токены общие; `totus_ai_v2` использует тот же `JWT_SECRET`.

---

# 10. Прочие сервисы

| Service | Status | Notes |
|---------|--------|-------|
| **nginx** | running | Reverse proxy, TLS termination |
| **mysql** | running | Port 3306 public |
| **pm2-root** | running | Process manager |
| **php8.1-fpm** | running | phpMyAdmin |
| **zabbix_agentd** | running | Port 10050 |
| **certbot.timer** | active | SSL auto-renew |
| **coturn / stun** | not found | No 3478/5349 on this host |

**PHP:** 8.1.2

---

# 11. Ресурсы сервера

| Resource | Value (snapshot) |
|----------|------------------|
| Disk `/` | 49G total, 9.6G used (20%) |
| RAM | 3.8 Gi total, ~1.4 Gi used, ~2.1 Gi available |
| CPU | x86_64 |

---

# 12. Важные замечания

### ⚠️ Безопасность

1. **MySQL 3306** открыт на `0.0.0.0` — высокий риск; ограничить firewall / bind 127.0.0.1.
2. **UFW выключен** — нет host firewall.
3. **phpMyAdmin** на IP `:80/phpmyadmin` — защищён Basic Auth, но лучше VPN/IP whitelist.
4. **server.totus.club** — DNS не существует; `calling_v2` на prod должен использовать **`https://voip.totus.club`**.
5. Root SSH password был передан в чат — **рекомендуется сменить** и перейти на SSH keys.

### Архитектурные связи

```text
Пользователь сайта     → totus.club:443        → :3000 totus_WEB
                       → api.totus.club:443    → :3001 totus_API

Мобильное приложение   → api.totus.club        → туры/заказы
                       → voip.totus.club       → VoIP/signaling :4444
                       → apiv2.totus.club      → AI Мила

Агент поддержки        → calling.totus.club    → :3008 calling_v2
                       → (должен) voip.totus.club → :4444 API звонков

AI standalone          → ai.totus.club         → :3012
                       → apiv2.totus.club      → :3011 + WS
```

### nginx backups на сервере

- `/etc/nginx/sites-available/api.totus.club.bak-*`
- `/etc/nginx/sites-available/default.bak*`

---

# 13. Связанные документы

| Файл | Содержание |
|------|------------|
| `SERVER_TLS_CONFIG_RU.md` | История TLS/TSPU изменений |
| `API_DOCUMENTATION_RU.md` | totus_API endpoints |
| `WEB_DOCUMENTATION_RU.md` | totus_WEB |
| `APP_DOCUMENTATION_RU.md` | totusapp mobile |
| `AI_DOCUMENTATION_RU.md` | totus_ai_v2 |
| `CALLING_FRONT_DOCUMENTATION_RU.md` | calling_v2 |
| `CALLING_API_DOCUMENTATION_RU.md` | calling_api_v2 |
| `PROJECT_CLOUD_BRIEF.md` | Обзор экосистемы |

---

*Аудит выполнен read-only по SSH 26.08.2026; дополнено 01.09.2026 (`.env` calling_api_v2, `npm install` после волн 1/3 — со слов владельца, без повторного аудита). При изменении nginx/pm2/DNS — обновите этот файл.*
