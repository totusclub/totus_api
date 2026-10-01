# totus-yonote-mcp

MCP-коннектор к базе знаний **Yonote** для Claude. Работает **только на чтение**.
Зависимостей нет — нужен только Node.js 20+ (или Docker).

## Что умеет

| Инструмент | Что делает | Метод Yonote API |
|---|---|---|
| `yonote_search` | полнотекстовый поиск с фрагментами | `documents.search` |
| `yonote_search_titles` | быстрый поиск по заголовкам | `documents.search_titles` |
| `yonote_document` | документ целиком в Markdown | `documents.info` |
| `yonote_documents` | список документов с фильтрами | `documents.list` |
| `yonote_collections` | список коллекций | `collections.list` |
| `yonote_collection_structure` | дерево документов коллекции | `collections.documents` |
| `yonote_recent` | недавно просмотренные | `documents.viewed` |
| `yonote_document_comments` | комментарии к документу | `comments.list` |
| `yonote_whoami` | проверка подключения | `auth.info` |

Список разрешённых методов зашит в `lib/yonote.mjs` (`READ_ONLY_METHODS`). Любой вызов вне списка
отклоняется в самом клиенте — даже если инструмент запишут по ошибке, запись в базу знаний не уйдёт.

## Установка на сервер

```bash
# 1. Код
sudo mkdir -p /home/totus_yonote_mcp && cd /home/totus_yonote_mcp
# скопировать сюда содержимое архива

# 2. Настройки
cp .env.example .env
openssl rand -hex 32          # это MCP_ACCESS_TOKEN
nano .env                     # вписать YONOTE_API_TOKEN, YONOTE_WORKSPACE, MCP_ACCESS_TOKEN
chmod 600 .env

# 3. Проверка
node test/smoke.mjs           # 20 тестов на фейковом API, без обращения к Yonote
node server.mjs &             # поднимется на 127.0.0.1:8787
curl -s localhost:8787/healthz

# 4. Автозапуск
sudo cp deploy/totus-yonote-mcp.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now totus-yonote-mcp

# 5. HTTPS
sudo cp deploy/nginx-mcp.totus.club.conf /etc/nginx/sites-available/mcp.totus.club
sudo ln -s /etc/nginx/sites-available/mcp.totus.club /etc/nginx/sites-enabled/
sudo certbot --nginx -d mcp.totus.club
sudo nginx -t && sudo systemctl reload nginx
```

Через Docker: `docker compose up -d --build` (порт слушается только на 127.0.0.1, наружу — через nginx).

## Где взять токен Yonote

Yonote → аватар/настройки рабочего пространства → **API-токены** → создать токен.
Коннектор видит ровно то, что видит владелец токена. Хотите ограничить область —
заведите отдельного пользователя с доступом только к нужным коллекциям и выпустите токен ему.

## Подключение к Claude

**claude.ai (веб, Cowork, мобильные) → Settings → Connectors → Add custom connector:**

```
https://mcp.totus.club/mcp/<MCP_ACCESS_TOKEN>
```

Секрет в пути — потому что в веб-интерфейсе нельзя задать свой заголовок `Authorization`.
Ссылка равна паролю: не публиковать, при утечке — поменять `MCP_ACCESS_TOKEN` и пересоздать коннектор.

**Claude Code / Desktop (заголовок доступен):**

```bash
claude mcp add --transport http yonote https://mcp.totus.club/mcp \
  --header "Authorization: Bearer <MCP_ACCESS_TOKEN>"
```

**Локально, без сервера (stdio):**

```json
{
  "mcpServers": {
    "yonote": {
      "command": "node",
      "args": ["/путь/к/totus_yonote_mcp/server.mjs", "--stdio"],
      "env": { "YONOTE_API_TOKEN": "...", "YONOTE_WORKSPACE": "app" }
    }
  }
}
```

После подключения скажите Claude: «проверь подключение к Yonote» — вызовется `yonote_whoami`.

## Переменные окружения

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `YONOTE_API_TOKEN` | — (обязательна) | токен Yonote API |
| `YONOTE_WORKSPACE` | — | поддомен пространства → `https://<ws>.yonote.ru/api` |
| `YONOTE_API_BASE` | `https://app.yonote.ru/api` | полный URL API (для on-premise) |
| `MCP_ACCESS_TOKEN` | — (обязательна для HTTP) | секрет доступа к коннектору |
| `PORT` / `HOST` | `8787` / `127.0.0.1` | что слушать |
| `YONOTE_MAX_TEXT_CHARS` | `20000` | лимит текста документа в ответе |

## Безопасность

- Сервер не стартует без `MCP_ACCESS_TOKEN` — случайно открыть базу знаний в интернет не получится.
- Токены сравниваются `timingSafeEqual`, тело запроса ограничено 1 МБ.
- Наружу смотрит только nginx с TLS; сам процесс слушает localhost и работает под `www-data`
  с урезанными правами systemd.
- Запись в Yonote невозможна by design; чтобы добавить её, придётся осознанно расширить
  `READ_ONLY_METHODS` — это и есть точка контроля при код-ревью.

## Если что-то не работает

| Симптом | Причина |
|---|---|
| Claude пишет «connector failed» | проверьте `curl https://mcp.totus.club/healthz` и `systemctl status totus-yonote-mcp` |
| `401` | несовпадение `MCP_ACCESS_TOKEN` в URL и в `.env` |
| `Yonote API 401` в ответе инструмента | протух или не тот `YONOTE_API_TOKEN` |
| `Yonote API 404` | неверный `YONOTE_WORKSPACE` / `YONOTE_API_BASE` |
| Пустой поиск | у владельца токена нет доступа к коллекциям |
