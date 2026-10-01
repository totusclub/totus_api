# Level.Travel API — где лежит документация и как её читать

**Статус:** доступ проверен 03.09.2026, работает.
**Для кого:** для всех чатов проекта Totus Dev. Если нужен вопрос по API Level.Travel
(поиск туров, актуализация, перелёты, создание заказа) — источник истины здесь, а не в памяти модели.

## Источник

| | |
|---|---|
| Документ | «Бронирование туров [Интеграция]» |
| Публичная ссылка | https://dynamics.yonote.ru/share/tour_booking |
| Платформа | Yonote (пространство `dynamics` — принадлежит Level.Travel) |
| Автор / владелец | annko@level.travel |
| ID документа | `116a7021-334c-4f8e-a64f-296e2e36dc20` (urlId `NWmtFUvsbq`) |
| Последнее обновление источника | 19.06.2025, ревизия 4 |
| Объём | ~117 000 символов (описания + полные примеры JSON-ответов) |
| Версия API | 3.7 |

Ссылка публичная — авторизация и токены не нужны, аккаунт в Yonote не нужен.

## Как это читать (важно)

Страница — SPA: текст подгружается скриптом, поэтому **обычный `WebFetch` вернёт только заголовок**.
Читать нужно через коннектор **Groover** (браузер с исполнением JS):

```
mcp__Groover__browse_navigate  url=https://dynamics.yonote.ru/share/tour_booking
                               wait_until=networkidle
mcp__Groover__browse_read      mode=text  max_chars=40000
```

Документ длинный, за один `browse_read` целиком не влезет. Читать частями:

```
mcp__Groover__browse_evaluate  script=document.body.innerText.slice(40000, 80000)
```

Оглавление одним запросом:

```
mcp__Groover__browse_evaluate  script=Array.from(document.querySelectorAll('h2,h3')).map(h=>h.innerText)
```

Что **не** работает:

- `WebFetch` / `http_fetch` по адресу страницы — отдают пустую оболочку без текста.
- `POST /api/documents.info` с `{"shareId":"tour_booking"}` — отвечает 200, но `text` пустой:
  приходят только метаданные (заголовок, автор, даты). Тело документа в этой версии Yonote
  через открытый API не отдаётся.
- `POST /api/documents.export` — 500.

Схема флоу бронирования (картинка в конце документа) доступна без авторизации:
`https://dynamics.yonote.ru/api/attachments.redirect?id=b52b962c-3c2e-43c7-b0e7-aaad3f6b61cf&shareId=tour_booking&documentId=116a7021-334c-4f8e-a64f-296e2e36dc20`

## Что внутри — карта документа

Разделы идут в порядке реального флоу бронирования:

| № | Раздел | Эндпоинт |
|---|---|---|
| 1 | Добавление поискового запроса в очередь | `GET /search/enqueue` |
| 2 | Запрос статуса поиска у поставщиков | `GET /search/status` |
| 3 | Выдача, сгруппированная по отелям | `GET /search/get_grouped_hotels` |
| 4 | Предложения по номерам и типам питания | `GET /search/hotel_rooms` |
| 5 | Создание пакета | `GET /packages/package_details` |
| 6 | Актуализация пакета | `GET /packages/actualize` |
| 7 | Перелёты по актуализированному пакету | `POST /packages/flights` |
| 8 | Актуализация тура с конкретным перелётом | `GET /packages/actualize` (с `flight_pair_id`) |
| 9 | Валидация туристов | `POST /tourists/validate` (для отелей — `POST /hotels/tourists/validate`) |
| 10 | Предпросмотр заказа | `POST /orders/prebuild` |
| 11 | Создание пребука заказа | `POST /packages/prebook` |
| 12 | Создание заказа | `POST /orders/create` |
| 13 | Флоу бронирования на схеме | картинка (ссылка выше) |

По каждому разделу в документе есть: описание, таблица параметров, curl-пример и **полный
пример ответа с комментариями по каждому полю** — именно за примерами ответов туда и стоит ходить.

## Ключевые факты (чтобы не открывать документ по мелочи)

**База:** `https://api.level.travel`. Тестовый стенд, упомянутый в примерах: `https://api.staging-prod1.level.travel`.

**Обязательные заголовки каждого запроса:**

```
Authorization: Token token=<api_key партнёра>
Accept: application/vnd.leveltravel.v3.7
Content-type: application/json
```

Токен выдаётся отдельно каждому партнёру и хранится у Level.Travel в поле `api_key`
таблицы `partners`.

**Поиск:**

- В `/search/enqueue` обязателен `search_type`: `package` (тур с перелётом) или `hotel` (только отель).
- Обязательные параметры: `from_city` (name_en), `to_country` (ISO2), `adults`.
- Взаимоисключающе: либо `nights` + `start_date`, либо `start_date` + `end_date`. Смешивать нельзя.
- Ответ даёт `request_id` — им адресуются все последующие запросы выдачи.
- `nights` — интервал вида `7..9`, максимум 9.

**Статусы поиска по поставщикам:** `pending`, `performing` — промежуточные;
`completed`, `cached`, `no_results`, `failed`, `skipped`, `all_filtered` — финальные.
Выдача показывает результаты только по поставщикам со статусом `completed` или `cached`.

**Типы питания:** `RO` без питания, `BB` завтрак, `HB`/`HBD` завтрак и ужин, `HBL` завтрак и обед,
`FB` завтрак-обед-ужин, `HB+`, `FB+` — они же расширенные, `AI` всё включено, `AI24` всё включено 24 часа,
`AIL` всё включено с ограничениями, `UAI` ультра всё включено, `DNR` ужин.

## Оговорки

- Документ живой, его правит Level.Travel. При расхождении с этим файлом источник главнее —
  перед серьёзной работой сверяйтесь по ссылке.
- Ссылка публичная, но это ссылка партнёра: наружу не публиковать.
- Наш собственный слой над этим API описан в `docs/API_DOCUMENTATION_RU.md`.
