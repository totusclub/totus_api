# TOTUS — TLS и серверная конфигурация (история изменений)

Документ собран **по фактам** из:

- кода в workspace (`totus_API`, `totus_WEB`, `totusapp`, `totus_ai_v2`);
- истории чатов Cursor (agent transcripts);
- git-истории `totus_API`;
- read-only проверки production-сервера `109.73.206.121` (nginx + Let's Encrypt), **26 августа 2026**.

Секреты (пароли SSH, TURN credentials, API keys) **не приводятся**.

Если сведения отсутствуют в репозитории или истории чатов: **«Не найдено в текущей кодовой базе / истории»**.

---

## 1. Общая схема (production)

**Сервер:** `109.73.206.121`  
**Reverse proxy:** nginx  
**TLS:** Let's Encrypt (Certbot), HTTP→HTTPS redirect на всех публичных доменах  
**Общий SSL-snippet:** `/etc/nginx/snippets/ssl-totus-tspu.conf` (на всех HTTPS vhost)

| Домен | Backend (localhost) | Назначение |
|-------|---------------------|------------|
| `totus.club`, `www.totus.club` | `:3000` | totus_WEB (Next.js) |
| `api.totus.club` | `:3001` | totus_API (Express) |
| `voip.totus.club` | `:4444` | VoIP / signaling (Node) |
| `calling.totus.club` | `:3008` | Calling admin / web-calling |
| `ai.totus.club` | `:3012` | totus_ai_v2 Next host |
| `apiv2.totus.club` | `:3011` | totus_ai_v2 Express API + WebSocket |

**WebRTC (VoIP, не nginx):** клиент `totusapp` использует STUN/TURN на `stun1/2.totus.club:3478`, `turn1/2.totus.club:3478` и **`turns:` на `:5349`** (TLS transport для TURN).

---

## 2. Текущая nginx/TLS конфигурация (снимок 26.08.2026)

### 2.1. Общие параметры HTTPS

На всех публичных vhost:

```nginx
listen 443 ssl http2;
listen [::]:443 ssl http2;
ssl_certificate /etc/letsencrypt/live/<domain>/fullchain.pem;
ssl_certificate_key /etc/letsencrypt/live/<domain>/privkey.pem;
include /etc/nginx/snippets/ssl-totus-tspu.conf;
ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
```

Порт **80**: Certbot-managed redirect `301 → https://$host$request_uri`, иначе `return 404`.

### 2.2. Snippet `ssl-totus-tspu.conf`

Файл на сервере (mtime **18 августа 2026**):

```nginx
ssl_protocols TLSv1.2;
ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305;
ssl_prefer_server_ciphers off;
ssl_session_cache shared:SSL:50m;
ssl_session_timeout 1d;
ssl_session_tickets off;
```

**Назначение (предположение по имени файла и связанным изменениям в коде):** совместимость с **TSPU** — фильтрацией HTTPS на некоторых мобильных сетях в РФ. Ограничение до **TLS 1.2**, набор AEAD/GCM cipher suites, отключены session tickets.

> В истории чатов Cursor **нет** отдельного сообщения с текстом «создали ssl-totus-tspu.conf». Факт изменения — по mtime файла на сервере и include в nginx vhost.

### 2.3. Особенности по доменам

| Домен | Доп. nginx-настройки |
|-------|----------------------|
| `api.totus.club` | `client_max_body_size 20M;` — загрузка изображений CMS |
| `apiv2.totus.club` | `proxy_read_timeout 3600s;` `proxy_send_timeout 3600s;` — длинные WS-сессии AI |
| `ai.totus.club` | `proxy_read_timeout 300;` `proxy_connect_timeout 300;` |
| Все прокси | `Upgrade` / `Connection upgrade` — WebSocket |

### 2.4. Let's Encrypt — сроки сертификатов (26.08.2026)

| Домен | notBefore | notAfter |
|-------|-----------|----------|
| `api.totus.club` | 2026-08-26 | 2026-11-24 |
| `totus.club` | 2026-08-26 | 2026-11-24 |
| `voip.totus.club` | 2026-08-26 | 2026-11-24 |
| `calling.totus.club` | 2026-08-26 | 2026-11-24 |
| `apiv2.totus.club` | 2026-08-10 | 2026-11-08 |
| `ai.totus.club` | 2026-08-10 | 2026-11-08 |

Certbot renewal configs обновлялись **26.08.2026** (api, totus, voip, calling) и **10.08.2026** (ai, apiv2).

---

## 3. Хронология изменений

### 3.1. Июнь 2026 — базовая nginx-развёртка

**Источник:** даты symlink в `/etc/nginx/sites-enabled/` на сервере.

| Дата (≈) | Событие |
|----------|---------|
| 26.06.2026 | Включён `default` site (phpMyAdmin) |
| 27.06.2026 | Включены `api.totus.club`, `totus.club`, `voip.totus.club`, `calling.totus.club` |

**Чат [phpMyAdmin nginx fix](5556531e-77e6-4a1c-9b5f-2ee4b9deea33):**

- **Проблема:** запросы по IP попадали в первый alphabetically vhost (`api.totus.club`), который на `:80` делал `return 404` (Certbot).
- **Изменение:** в `/etc/nginx/sites-available/default` добавлено `listen 80 default_server;`
- **Результат:** phpMyAdmin по IP снова отдаёт `401` (Basic Auth), а не `404`.

### 3.2. Июль 2026 — TSPU-snippet уже на api; backend TLS для VTB

**Сервер:** backup `/etc/nginx/sites-available/api.totus.club.bak-20260708102950` (**08.07.2026**) уже содержит:

```nginx
include /etc/nginx/snippets/ssl-totus-tspu.conf;
```

**Git `totus_API`, commit `4bcb721` (16.07.2026, «document urls»):**

- Добавлен `app.js` с исходящим HTTPS к VTB через:
  ```js
  const vtbHttpsAgent = new https.Agent({ rejectUnauthorized: false });
  ```
- URL токена VTB: `https://open.api.vtb.ru:443/passport/oauth2/token`
- То же в `utils/vtbCreatePayment.js` — **без изменений в git с момента создания**.

**Мобильное приложение (`totusapp`):**

- В `src/modules/store/slices/search.ts` интервал poll search-status: **6000 ms**
- Комментарий в коде: *«6s poll reduces parallel TLS bursts (TSPU on some RU mobile networks)»*
- Backup-файлы `search.ts.bak-jul15logic`, `search.ts.bak-jul21` — тот же интервал **6000 ms** (изменение интервала в доступной истории **не найдено**; вероятно было заложено сразу).

### 3.3. Август 2026 — AI-домены и обновление TSPU-snippet

| Дата | Событие | Источник |
|------|---------|----------|
| **10.08.2026** | Symlink + cert Let's Encrypt для `ai.totus.club`, `apiv2.totus.club` | mtime sites-enabled, cert notBefore |
| **10.08.2026** | Документирован пример nginx в `totus_ai_v2/DEPLOY.md` | код репозитория |
| **18.08.2026** | Обновлены mtime: `ssl-totus-tspu.conf`, `ai.totus.club`, `apiv2.totus.club` nginx configs | сервер |
| **26.08.2026** | Авто-renew cert для api/totus/voip/calling | certbot log |
| **26.08.2026** | **`client_max_body_size 20M;`** на `api.totus.club` | чат [413 upload fix](a09154e2-ee2a-4a0f-a153-21722b0c7f80) |

**Чат [413 Payload Too Large](a09154e2-ee2a-4a0f-a153-21722b0c7f80):**

1. Ошибка загрузки изображений в CMS — HTTP **413**
2. В коде API увеличен лимит multer (`UPLOAD_MAX_IMAGE_MB`, default 15 MB)
3. На сервере в nginx для `api.totus.club` добавлено:
   ```nginx
   client_max_body_size 20M;
   ```
4. `nginx -t` + `systemctl reload nginx` — успешно

### 3.4. Документация и планы (без применения на сервере)

**Чат [Security audit](9dde04ee-a68e-42f1-8866-ff48dcd2fe9f):**

- Созданы `SECURITY.md` и `SECURITY-v2.md` с рекомендациями: nginx hardening, fail2ban, Let's Encrypt, убрать `rejectUnauthorized: false` для VTB
- **Факт:** файлы **отсутствуют** в текущем workspace (удалены или не закоммичены) — только упоминание в истории чата
- **Факт:** рекомендации SECURITY-v2 **не подтверждены** как внедрённые на сервере (кроме уже существующего Certbot)

**Чат [PROJECT_CLOUD_BRIEF](940a3b07-0a76-4398-b510-1306ad432ab5):**

- Зафиксирована карта доменов и nginx-маршрутизация для Cloud Agent (без деталей cipher/TSPU)

---

## 4. TLS в коде приложений (не nginx)

### 4.1. totus_API — исходящий HTTPS к VTB

| Файл | Поведение |
|------|-----------|
| `totus_API/app.js` | `https.Agent({ rejectUnauthorized: false })` для VTB axios |
| `totus_API/utils/vtbCreatePayment.js` | то же |

**Риск:** отключена проверка сертификата upstream VTB.  
**История git:** с **16.07.2026**, изменений не было.

**Примечание:** в более раннем чате [VTB integration](50665dc4-7ed5-40ad-9034-b96ca19ace94) упоминались **test** URL VTB (`epa-ift-sbp.vtb.ru`, `test3.api.vtb.ru`). В **текущем** коде workspace — **`open.api.vtb.ru:443`** (prod-подобный endpoint). Переключение test→prod в git **не найдено** (возможно делалось вне зафиксированных коммитов или в другой ветке/копии `totus_API`).

### 4.2. Клиенты — публичные HTTPS endpoint'ы

| Проект | URL | Файл |
|--------|-----|------|
| totus_WEB | `https://api.totus.club` | `src/config/api.ts` |
| totus_WEB AI | `https://apiv2.totus.club/api`, `wss://apiv2.totus.club/ws/assistant` | `src/lib/aiConfig.ts` |
| totusapp tours | `https://api.totus.club` | `src/config/server.ts` |
| totusapp VoIP | `https://voip.totus.club` | `src/config/server.ts` |
| totus_ai_v2 | `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_WS_URL` | `.env.example`, `DEPLOY.md` |
| @tosmedia/ai-assistant | auto `wss://` when page is `https:` | `packages/ai-assistant/src/config.ts` |

### 4.3. totusapp — снижение TLS-нагрузки при поиске

```119:120:totusapp/src/modules/store/slices/search.ts
        // 6s poll reduces parallel TLS bursts (TSPU on some RU mobile networks).
        interval = setInterval(pollStatus, 6000);
```

Согласовано с server-side `ssl-totus-tspu.conf` и мобильными проблемами TSPU — **client-side mitigation**, не server config.

### 4.4. totusapp — WebRTC TURN over TLS

В `VoipService.ts` для relay используется **`turns:turn1.totus.club:5349?transport=tcp`** (и turn2) — отдельный TLS-порт TURN-сервера, **не** nginx `:443`.

---

## 5. Что есть в репозитории vs только на сервере

| Артеfact | В git/workspace | Только на сервере |
|----------|-----------------|-------------------|
| nginx vhost configs | Пример в `totus_ai_v2/DEPLOY.md` | `/etc/nginx/sites-available/*.totus.club` |
| `ssl-totus-tspu.conf` | **Не найдено** | `/etc/nginx/snippets/ssl-totus-tspu.conf` |
| Certbot renewal | **Не найдено** | `/etc/letsencrypt/` |
| STUN/TURN certs | **Не найдено** | Предположение: отдельная настройка coturn/turnserver |
| fail2ban / ModSecurity | План в SECURITY-v2 (чат) | Статус внедрения **не проверялся** |

**Рекомендация:** добавить в репозиторий `infra/nginx/` с шаблонами vhost + `ssl-totus-tspu.conf`, чтобы server config не терялся вне SSH.

---

## 6. Сводная таблица «что менялось»

| # | Когда | Где | Что изменилось | Зачем |
|---|-------|-----|----------------|-------|
| 1 | ~27.06.2026 | nginx | Первые vhost: api, totus, voip, calling + LE | Запуск production |
| 2 | ~26.06.2026 | nginx `default` | `default_server` на :80 | phpMyAdmin по IP |
| 3 | ≤08.07.2026 | nginx | `include ssl-totus-tspu.conf` на api | TSPU / TLS 1.2 |
| 4 | 16.07.2026 | totus_API code | `rejectUnauthorized: false` для VTB | Обход проблем cert VTB API |
| 5 | ≤15.07.2026 | totusapp | poll 6s + комментарий TSPU | Меньше параллельных TLS на моб. сетях |
| 6 | 10.08.2026 | nginx + LE | `ai.totus.club`, `apiv2.totus.club` | Деплой totus_ai_v2 |
| 7 | 18.08.2026 | nginx snippet | Обновлён `ssl-totus-tspu.conf`, ai/apiv2 configs | TSPU cipher/protocol tuning |
| 8 | 26.08.2026 | nginx api | `client_max_body_size 20M` | Загрузка изображений CMS |
| 9 | 26.08.2026 | Let's Encrypt | Renew api, totus, voip, calling | Плановое продление |

---

## 7. Проверка после изменений

```bash
# TLS снаружи
curl -sI https://api.totus.club/api/health
curl -sI https://apiv2.totus.club/api/health
curl -sI https://ai.totus.club

# nginx на сервере
nginx -t && systemctl reload nginx

# срок сертификата
openssl s_client -connect api.totus.club:443 -servername api.totus.club </dev/null 2>/dev/null | openssl x509 -noout -dates
```

---

## 8. Связанные файлы в workspace

| Файл | Содержание |
|------|------------|
| `totus_ai_v2/DEPLOY.md` | Пример nginx для ai/apiv2 |
| `PROJECT_CLOUD_BRIEF.md` | Карта доменов и портов |
| `API_DOCUMENTATION_RU.md` §23 | Риск `rejectUnauthorized: false` |
| `APP_DOCUMENTATION_RU.md` | SERVER_BASE_URL, VoIP STUN/TURN |
| `AI_DOCUMENTATION_RU.md` | apiv2 / wss URLs |

---

## 9. Ограничения этого документа

1. **Полная история nginx до июня 2026** в чатах Cursor **не найдена** — только backups на сервере с июля.
2. **Кто и когда создал `ssl-totus-tspu.conf` впервые** — только mtime **18.08.2026** на текущей версии; include уже был **08.07.2026** на api.
3. **TURN/STUN TLS (порты 3478/5349)** — конфиги coturn на сервере **не снимались** в этой сессии.
4. **SECURITY.md / SECURITY-v2.md** — упоминаются в чате, в workspace **отсутствуют**.

---

*Сгенерировано: 26 августа 2026. Источники: codebase TOTUS, agent transcripts Cursor, production server read-only audit.*
