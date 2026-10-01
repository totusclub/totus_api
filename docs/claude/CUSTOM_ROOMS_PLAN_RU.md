# Собственные Room Type поверх предложений Level.Travel — технический план

**Статус:** 11.09.2026 — v4 (§11 реализован, 5 PR): бронирование наших Room Type **не идёт в Level.Travel** (§0.5 заменён, новый §11). Backend/админка Room Type — PR totus_API #6, Totus_admin #5; дизайн бронирований — `claude/CUSTOM_ROOMS_DESIGN_RU.md` (страницы «ROOMS · Bookings»), код бронирований — после утверждения макетов. v3 была после двух раундов уточнений владельца (§0, §9). Порядок работ: логика (этот документ) → дизайн в Figma (админка + пользовательский сценарий) → после утверждения макетов код: backend и админка, затем интеграция с frontend. До утверждения Figma код не пишется. Связанные документы: `docs/API_DOCUMENTATION_RU.md` (§4.3 поиск/пакеты, §4.4 заказы), `docs/LEVELTRAVEL_API_ACCESS_RU.md`, `docs/ADMIN_DOCUMENTATION_RU.md`.

## 0. Согласованная логика (ответы владельца 10.09)

1. **Скидка ниже цены провайдера допустима** — разницу субсидируем; в правиле цены предусмотрен необязательный порог **минимальной маржи** (в % или ₽; глобальная настройка + переопределение на комнате); при нарушении Final Price поднимается до порога, комната помечается в админке.
2. **Иерархия на витрине и в админке:** Отель → **Оператор/провайдер** (например, «Arlekino» — туроператор, чьё предложение приходит через Level.Travel) → номер Level.Travel → **наши Room Type** под ним. Оператор всегда виден (`operator_name` из offer).
3. **Нет исходного номера в актуальной выдаче LT — нашей комнаты нет.** Никаких фиксированных цен без источника.
4. Наша Room Type создаётся **на основе конкретного номера LT** (выбор в админке из реальной выдачи) для отмеченного оператора; к каждому выбранному предложению (оператор × питание) применяется наше правило.
5. ~~Бронирование через цепочку Level.Travel~~ — **отменено 10.09 (вечер).** Новое решение владельца: «Пользователь выбирает Arlekino → оплачивает → бронирование сохраняется только у нас → появляется в админке → я подтверждаю или отклоняю → Level.Travel вообще не участвует». Подробно — §11.
6. **Все номера Level.Travel остаются видимыми.** Наша Room Type замещает только то предложение (номер × оператор, например Arlekino), на основе которого создана и которое отмечено в админке; остальные операторы этого номера и все прочие номера показываются как обычные предложения LT. Наше предложение выделено визуально.
7. Примеров production-JSON нет — точный список полей цены в `package_details`/`actualize` снимем на проде на этапе разработки (через прокси с тестовым `request_id`).

## 1. Суть

Три цены разделены: **Provider Price** (актуальная цена LT в конкретном предложении) → **Price Rule** (наше правило: ±N ₽, ±N %, округление, min/max, минимальная маржа — хранится у нас) → **Final Price** (цена для пользователя). Наша Room Type — самостоятельная сущность в нашей БД с редактируемым контентом; с LT её связывает `source reference` (отель + исходный номер + оператор(ы) + питание). Цена пересчитывается при **каждом** ответе LT, поэтому изменение цены провайдера (10 000 → 12 000) отражается автоматически. Frontend продолжает получать данные в формате LT (замещение делает backend); визуальное отличие наших предложений — этап интеграции с frontend после макетов.

## 2. Что есть сейчас (по коду)

Цепочка клиента (сайт и приложение одинаковы): `GET /search-status` (enqueue, `search_type=hotel|package`) → `GET /hotels-rooms?request_id&hotel_id` → LT `/search/hotel_rooms` → `result[]` = `HotelRoom { ID, min_price, meal_types[], room {id, name_ru, description, area, view, facilities[], images[]}, offers { [meal]: Offer[] {id, price, operator_id, operator_name, start_date, nights_count, extras, availability…} } }` → выбор offer → `GET /packages/package_details?request_id&tour_id=<offer.id>` → `package.id` → `GET /packages/actualize?package_id` → `POST /orders/prebuild` → `POST /packages/prebook` → `POST /create-package` (LT `/orders/create`, INSERT `orders`, оплата VTB на `payload.payment.amount` или цену заказа LT). Всё — прямые прокси в `app.js` (60 КБ, через коннектор не правится), цены нигде не трогаются. Контент номера у LT статичен, предложения (цены) существуют только в контексте поиска (даты, ночи, туристы).

## 3. Архитектура

```
Totus_admin ──(staff-JWT)──► totus_API /api/admin/rooms/* ──► MySQL kedam: custom_room_types, custom_room_price_log, custom_room_settings
                                     │  (поиск отелей/номеров для админки — те же прокси LT)
Сайт / приложение ──► totus_API (API без изменений):
   /hotels-rooms ─► LT ─► middleware customRooms: предложения источника (номер × оператор) ЗАМЕЩАЮТСЯ нашим Room Type
                          (offers клонируются, price = rule(providerPrice), оператор сохраняется; остальное — как есть)
   /packages/package_details?tour_id=<наш offer id> ─► подмена на исходный tour_id ─► LT ─► цены в ответе переписаны,
                          package.id → custom_room_package_map
   /packages/actualize, /orders/prebuild, /packages/prebook ─► LT ─► по карте цены переписаны (пересчёт от свежей цены LT)
   /create-package ─► LT /orders/create (по цене LT) ─► orders + provider/final price ─► VTB на Final Price
```

Всё в **totus_API** (`lib/customRooms/*`, `middleware/customRooms.js`, `routes/customRooms.routes.js`). В `app.js` — две строки (`app.use(customRoomsMiddleware)` до прокси-маршрутов и `app.use('/api/admin', customRoomsAdminRoutes)`), их добавляет владелец по патчу. Middleware оборачивает `res.json` только для перечисленных путей; при любой ошибке нашей логики отдаётся оригинал LT и пишется лог.

## 4. Структура данных

```sql
custom_room_types (
  id INT PK,
  hotel_id INT NOT NULL, hotel_name VARCHAR(255), hotel_stars TINYINT, hotel_city VARCHAR(128),
  source_room_id INT NOT NULL,          -- LT room.id (source reference, обязателен)
  source_snapshot JSON,                 -- слепок исходного номера LT на момент создания («сбросить к оригиналу»)
  operator_ids JSON NOT NULL,           -- операторы, чьи предложения замещаем (например [Arlekino]); выбираются в админке
  meal_types JSON NULL,                 -- ограничить типы питания (NULL = все)
  name_ru, name_en, accommodation, area, view, description, facilities JSON,
  images JSON,                          -- [{source:'lt'|'upload', url}] — фото LT по ссылке или свои из uploads/
  rule_type ENUM('percent','absolute') NOT NULL, rule_value DECIMAL(10,2) NOT NULL,        -- +1 / -10 (%), +1000 / -1000 (₽)
  rounding INT DEFAULT 1,               -- 1 / 10 / 100 ₽
  min_price DECIMAL(12,2) NULL, max_price DECIMAL(12,2) NULL,
  min_margin_type ENUM('percent','absolute') NULL, min_margin_value DECIMAL(10,2) NULL,     -- NULL = глобальная настройка
  package_types JSON DEFAULT '["hotel"]',
  badge VARCHAR(64) DEFAULT 'Totus',
  active TINYINT(1) DEFAULT 1, sort_order INT DEFAULT 0,
  last_provider_price, last_final_price, last_seen_at, last_operator VARCHAR(128),
  created_by VARCHAR(128), created_at, updated_at,
  KEY idx_hotel (hotel_id, active), KEY idx_source (source_room_id)
)
custom_room_settings (key PK, value JSON)          -- глобальные: min_margin {type,value}, badge, rounding по умолчанию
custom_room_price_log (id, room_type_id, request_id, source_offer_id, operator_id, operator_name, meal,
  provider_price, final_price, rule_snapshot JSON, margin_clamped TINYINT, seen_at)   -- история цен (≤ 1 запись/комната/оператор/питание/час)
custom_room_change_log (id, room_type_id, staff_id, staff_name, changes JSON, created_at)   -- история правок правила/контента
custom_room_offer_map (virtual_offer_id VARCHAR(64) PK, room_type_id, request_id, source_offer_id, operator_id, meal,
  provider_price, final_price, created_at, expires_at)          -- ~2 ч (время жизни поиска LT)
custom_room_package_map (lt_package_id VARCHAR(64) PK, room_type_id, virtual_offer_id, source_offer_id,
  provider_price, final_price, rule_snapshot JSON, created_at, expires_at)
orders: + custom_room_type_id INT NULL, provider_price DECIMAL(12,2) NULL, final_price DECIMAL(12,2) NULL, price_rule JSON NULL
```

Миграция — идемпотентный `scripts/run-custom-rooms-migration.js` (запускает владелец).

## 5. Логика цены

`finalPrice(provider, rule)`: `provider × (1 + value/100)` или `provider + value` → округление → ограничение `min/max_price` → проверка минимальной маржи (`final ≥ provider − margin`, margin в % или ₽; если ниже — поднимаем до порога, флаг `margin_clamped` в лог и статус в админке). Считается на каждом ответе LT для каждого предложения (оператор × питание) отдельно. Правило, история цен и история правок — только у нас. Заказ в LT — по цене провайдера; клиент платит Final Price через VTB; разница (маржа или субсидия) — наша.

## 6. Витрина (backend, frontend без изменений на этапе 1)

- `/hotels-rooms` (`search_type = hotel`): для каждой активной Room Type отеля ищем в `result[]` исходный номер (`room.id = source_room_id`) и его предложения выбранных операторов (`operator_ids`, `meal_types`). Эти предложения **удаляются из исходного номера** (если у номера не осталось предложений — исчезает и его карточка), и рядом вставляется наша комната (`ID = "totus-<id>"`, `room` — наш контент, `offers` — клоны удалённых предложений с `id = "t<roomTypeId>-<hash>"`, `price/price_per_night/analytics_price` = Final Price, `operator_name` сохранён, `labels: [{id:'totus', name: badge}]`, `lt_extras.totus = {custom: true, sourceRoomId, operatorName}`); `min_price` и `filters.meals.min_price` пересчитываются. Всё остальное (другие операторы этого номера, другие номера) — как есть. Если источника нет в выдаче — нашей комнаты нет. Пары `virtual_offer_id → source_offer_id` — в `custom_room_offer_map`.
- `/packages/package_details?tour_id=t…` → подмена на исходный `tour_id`, ответ с переписанными ценами + `totus_room`, `package.id` в `custom_room_package_map`.
- `/packages/actualize`, `/orders/prebuild`, `/packages/prebook` — по карте: свежая цена LT из ответа → пересчёт → переписанные цены.
- `/create-package` — по карте: LT-заказ как обычно (цена провайдера), в `orders` — `custom_room_type_id/provider_price/final_price/price_rule`, VTB-платёж принудительно на Final Price, в `package` JSON заказа цены заменяются на наши (для «Моих заказов», писем, админки).
- `search_type = package` (с перелётом) — без изменений.
- Этап «интеграция с frontend» (после макетов): бейдж/оформление наших предложений по `lt_extras.totus`/`labels`, оператор, подпись «на основе номера … · оператор».

## 7. Админка (Totus_admin → «Отели и номера») — состав экранов для Figma

1. **Отели** — форма поиска (страна/курорт, город вылета, даты, ночи, туристы), фильтры: **звёзды** (multi), название, «только с нашими Room Type»; карточки отелей (звёзды, рейтинг, город, мин. цена, число наших Room Type, операторы).
2. **Отель** — шапка; вкладки **Номера Level.Travel** / **Наши Room Type** / **История цен**. Номера — группировка **по оператору** (Arlekino, …) → номер LT (фото, название, площадь, питание, цена провайдера) → под ним наши Room Type (правило, Final Price сейчас, маржа, статус «показывается вместо предложения Arlekino» / «источник не найден на эти даты» / «маржа ограничена»). Действия: у номера LT «Создать Room Type»; у нашей «Изменить», «Дублировать», «Вкл/выкл», «Удалить», «Сбросить контент к оригиналу».
3. **Создание Room Type на основе номера** — шаг 1: источник и предложения (оператор × питание, цены LT) — выбрать, какие замещаем; шаг 2: контент (предзаполнен из LT, всё редактируется; **фото: LT или свои**, загрузка/замена); шаг 3: **цена** — тип правила (% / ₽), значение, округление, min/max, минимальная маржа (глобальная / своя, % или ₽), бейдж; справа **preview** «Оператор · Питание · Цена LT → Наша · маржа» по актуальной выдаче + «как увидит пользователь».
4. **Редактирование Room Type** — те же секции + история правок.
5. **Duplicate** — модал: имя копии, что копировать (контент / правило), фото «те же / заменить», сразу открыть редактор.
6. **Наши Room Type** (все отели) — таблица: отель, оператор, номер-источник, правило, цена LT / наша / маржа, когда видели, заказы, статус; фильтры; «Проверить цены сейчас».
7. **История цен** комнаты — график и таблица «дата · оператор · питание · цена LT · наша · правило · маржа» + история правок.
8. **Настройки** — глобальная минимальная маржа (% / ₽), бейдж и округление по умолчанию.

REST (`/api/admin/rooms/*`, staff-JWT strict): `GET /hotels/search`, `GET /hotels/:id/rooms?request_id`, CRUD `/room-types`, `POST /room-types/from-provider`, `POST /room-types/:id/duplicate`, `POST /room-types/:id/preview-price`, `POST /room-types/:id/images` (загрузка), `GET /room-types/:id/price-log`, `GET /room-types/:id/change-log`, `GET /room-types/:id/orders`, `GET/PUT /settings`.

## 8. Пользовательский сценарий для Figma (сайт + приложение)

Поиск отеля (без перелёта) → карточка отеля → блок «Выберите номер»: группа **оператор (Arlekino)** → наша Room Type (бейдж «Totus», подпись «Наше предложение · на основе номера … · Arlekino», наша цена) рядом с обычными номерами LT этого и других операторов; исходное предложение Arlekino для этого номера не показывается — вместо него наше → «Все варианты» (питание — наши цены) → выбор → оформление с нашей ценой и пометкой «бронирование выполняет туроператор через Level.Travel» → оплата Final Price → «Мои заказы» с нашей ценой.

## 9. Уточнения (ответы 10.09, вторая итерация)

1. **Все номера Level.Travel остаются видимыми.** Наша Room Type замещает только предложение «номер × отмеченный оператор» (Arlekino); остальные операторы этого номера и все прочие номера — как обычные предложения LT; наше — выделено.
2. Минимальная маржа — оба варианта: % и ₽.
3. Фото — два источника: фото Level.Travel (по ссылке из источника) или свои (загрузка в админке в `uploads/` totus_API). При создании на основе номера — предзаполнены фото LT с возможностью заменить; при Duplicate — те же или заменить; для собственного контента — загрузить свои. В `images` — массив `{source:'lt'|'upload', url}`.
4. Название на витрине — из редактора; бейдж «Totus» — на этапе интеграции с frontend.

## 10. Шаги

| # | Шаг | Где |
|---|---|---|
| 0 | Figma: страницы «ROOMS · Admin · Light/Dark» (экраны §7) и «ROOMS · Витрина · Light/Dark» (сценарий §8: desktop/сайт, iPhone, web mobile) — утверждение | Figma u6A5og35jw0BBJyOkKl8Ij |
| 1 | totus_API: миграция, `lib/customRooms/*`, middleware, admin-роуты, загрузка фото, проверки без БД, патч app.js, документация | PR totus_API |
| 2 | Totus_admin: раздел «Отели и номера» | PR Totus_admin |
| 3 | Владелец: миграция, патч app.js, деплой; сквозная проверка (создать Room Type → витрина → заказ → сумма VTB = Final Price) | — |
| 4 | Интеграция с frontend по макетам: бейдж/оператор/оформление наших предложений | PR totus_WEB, totus_APP (+ desktop) |

## 11. Бронирование наших Room Type без Level.Travel (решение владельца 10.09)

**Логика.** Room Type «Arlekino» существует только в нашей БД и в LT не отправляется. Когда клиент выбирает наше предложение, он оплачивает его сразу (Final Price, VTB как сейчас). Заказ создаётся **только у нас** со статусом `pending_confirmation` и попадает в админку → «Отели и номера → Бронирования». Сотрудник **подтверждает** (опционально номер брони у отеля, ваучер PDF, комментарий; клиенту push + e-mail) или **отклоняет** (причина, сообщение клиенту, возврат полностью/частично через VTB или «вручную»). В LT ни `orders/create`, ни `prebook`, ни `notifyLevelTravelOrderPaid` для таких заказов не вызываются.

**Что меняется в PR totus_API #6 (`lib/customRooms/packageFlow.js`, `middleware/customRooms.js`).**
- `package_details` / `actualize` — как сейчас (нужны LT-данные пакета для карточки оформления: отель, даты, туристы), цены → наши.
- `prebook` / `prebuild` для виртуального предложения — **не отправлять в LT**, отвечать синтезированным успехом в формате LT.
- `/create-package` для виртуального предложения — **не вызывать LT `/orders/create`**; создать внутренний заказ (`orders` + `custom_room_bookings`), создать VTB-платёж на Final Price, вернуть ответ в формате текущего `create-package` (id заказа, ссылка на оплату).
- `/check_pay` — для внутренних заказов не вызывать `notifyLevelTravelOrderPaid`; после оплаты статус `pending_confirmation`, уведомление сотрудникам (хаб `lib/notifyHub.js`).
- Просмотр заказов (`/orders`, `/user/orders`, `/client/orders*`) — для внутренних заказов отдавать статус/тексты из нашей БД (без запроса в LT).

**Данные.** Таблица `custom_room_bookings`: `id, order_id, room_type_id, hotel_id, source_offer_id, operator_id, operator_name, meal, check_in, check_out, nights, tourists_json, contact_json, provider_price, final_price, price_rule_json, payment_status (pending|paid|refunded|partially_refunded), status (pending_confirmation|confirmed|rejected|cancelled), confirmed_at, confirmed_by, hotel_booking_ref, voucher_path, reject_reason, reject_message, refund_amount, refund_method (vtb|manual), refund_status, refund_at, staff_comment, deadline_at, created_at, updated_at` + `custom_room_booking_events` (таймлайн). Статусы клиенту: «Проверяем бронирование» / «Бронирование подтверждено» / «Бронирование отклонено».

**Админка (Totus_admin).** Вкладка «Бронирования» в разделе «Отели и номера»: список (сводка, фильтры, таблица), карточка заказа, модалы подтверждения и отклонения с возвратом, состояния «подтверждено/отклонено/пусто». API: `GET /api/admin/rooms/bookings`, `GET /api/admin/rooms/bookings/:id`, `POST …/confirm`, `POST …/reject`, `POST …/voucher` (multer), `POST …/resend-voucher`, `POST …/comment` — все staff strict JWT.

**Уведомления.** Через хаб calling_api_v2: сотрудникам — «Новое бронирование Arlekino №…»; клиенту — «Проверяем бронирование», «Бронирование подтверждено», «Бронирование отклонено — возврат отправлен» (push + e-mail).

**Ответы владельца (10.09):** (а) возврат — только вручную, без API VTB; (б) ваучер/подтверждение отправляем мы, от «Arlekino Tour»; (в) автоотклонения по таймеру нет; (г) frontend реализовать сразу — тот же flow до оплаты, после оплаты заказ у нас и в админке. Реализовано 11.09: PR totus_API #6, Totus_admin #5, totus_WEB #8, totus_APP #9, totus_desktop #3 — см. `claude/CUSTOM_ROOMS_STATUS_RU.md`.
