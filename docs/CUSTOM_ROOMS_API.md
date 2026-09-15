# Собственные Room Type — API и подключение

Наши Room Type поверх предложений Level.Travel: план `claude/CUSTOM_ROOMS_PLAN_RU.md`, макеты `claude/CUSTOM_ROOMS_DESIGN_RU.md` (проект Totus Dev). Код: `lib/customRooms/{pricing,store,inject,packageFlow,diag}.js`, `middleware/customRooms.js`, `routes/customRooms.routes.js`, `controllers/customRooms.controller.js`, `middleware/uploadRoomImage.js`; бронирования без Level.Travel (раздел 6): `lib/customRooms/{bookings,bookingEmails,internalOrders,vtbCheck}.js`, `middleware/uploadVoucher.js`, правка `utils/vtbCallback.js`.

## 1. Подключение (владелец) — две строки в `app.js`

`app.js` (60 КБ) через коннектор не правится, поэтому:

```js
// после  app.use(express.json());  (строка ~38) — ДО прокси-маршрутов Level.Travel
app.use(require('./middleware/customRooms'));

// рядом с остальными /api/admin (строки ~1599–1618)
app.use('/api/admin/rooms', require('./routes/customRooms.routes'));
```

Затем: `node scripts/run-custom-rooms-migration.js` (9 таблиц `custom_room_*` + 4 колонки в `orders` + 3 колонки в `custom_room_package_map` + v2: 5 колонок в `custom_room_types` + диагностика: `last_skip_reason`, `last_checked_at` в `custom_room_types`; идемпотентно — повторный запуск после первой волны добавит только новое), `pm2 restart api`, `npm run check` (`scripts/check-custom-rooms.js`, `scripts/check-custom-rooms-diag.js` — без БД). Лог при старте: `[custom-rooms] ready`; без миграции — `[custom-rooms] DISABLED — tables missing: … | columns missing: …`, витрина работает как раньше, админка отвечает `503 custom_rooms_not_migrated`. **Важно:** проверка готовности требует все таблицы и колонки v2 — если после обновления кода миграцию не запустили, модуль выключен целиком (и витрина, и админка). Колонки диагностики необязательны: без них модуль работает, но причина пропуска не сохраняется.

**Если Room Type не виден на сайте** — открыть в админке «Отели и номера → Настройки → Диагностика» или `GET /api/admin/rooms/diagnostics` со staff-токеном (раздел 7): там видно, выполнена ли миграция, подключён ли middleware в `app.js`, доходят ли `GET /hotels-rooms` до него и по какой причине каждая активная Room Type пропущена в последнем ответе.

Переменные: `CUSTOM_ROOMS_HOTEL_SEARCH_TYPE_CODES` (необязательно; коды `search_type` в ответе LT `hotel_rooms`, считающиеся поиском «отель», по умолчанию `1` — LT отдаёт `0` для package и `1` для hotel; основной источник — параметр `search_type` при `/start-search`); `BOOKINGS_NOTIFY_EMAIL` (необязательно; адреса сотрудников через запятую — письмо «Новое бронирование Arlekino №…» после оплаты); `API_PUBLIC_URL` (уже используется письмами; из него строится ссылка на ваучер).

## 2. Как работает витрина (frontend без изменений)

| Маршрут | Что делает middleware |
|---|---|
| `GET /start-search` | запоминает `request_id → search_type` (`custom_room_searches`) |
| `GET /hotels-rooms` | **v3 (раздел 2.2):** при любом `search_type` (если не включён `hotelOnly` и `packageTypes` Room Type допускают этот тип) для каждой активной Room Type отеля, чей номер `source_room_id` есть в выдаче (**только по `room.id`**), наши предложения добавляются **внутрь этого номера — в начало `offers[meal]`**; отдельная комната `totus-<id>` больше не создаётся. Предложения — клоны самых дешёвых предложений LT источника (по одному на питание, если `meal_types` заданы, иначе одно самое дешёвое) с нашей ценой (`fixed` или `rule(providerPrice)`), `operator_id/operator_name` = наши («Arlekino»); offer `id = "t<rt>-<n>-<hash>"`, `lt_extras.totus = {custom:true, roomTypeId, sourceOfferId, meal, mode, source:'arlekino'}`; у номера `lt_extras.totus = {roomTypeId, customOffers, sourceRoomId}`; `min_price`, `meal_types[].min_price`, `filters.meals[].min_price` (и `min_price` отеля, если есть) пересчитаны по всем предложениям. **Предложения Level.Travel не удаляются и не переписываются** (порядок внутри группы LT сохраняется). Пары `virtual → source offer` — `custom_room_offer_map` (3 ч). Нет источника в выдаче или у него нет offers — наших предложений нет |
| `GET /packages/package_details?tour_id=t…` | `tour_id` → id предложения-шаблона; в ответе цены `package.price` и равные цене провайдера «ценовые» поля → наша цена; `package.id` → `custom_room_package_map` (24 ч) вместе со снимком ответа (`package_snapshot`), `hotel_id`, `meal`, `operator_name` Room Type; `+ totus_room {roomTypeId, providerPrice, finalPrice, mode}`. Устаревший id → `410 offer_expired` |
| `GET /packages/actualize` | по `package_id` из карты: при `rule` — свежая цена LT из ответа → пересчёт по актуальному правилу; при `fixed` — итоговая цена **не пересчитывается** от цены LT (в карте обновляется только `provider_price` для маржи); `totus_room.priceChanged {from,to}` — при `rule`, если провайдер изменил цену, при `fixed` — только если владелец поменял цену в админке; снимок в карте обновляется |
| `POST /orders/prebuild`, `POST /packages/prebook`, `POST /packages/flights` | для пакета из карты **LT не вызывается**: middleware отвечает сам `200 { success:true, …снимок package_details, totus_room, totus_booking:{internal:true, operator} }`; нет снимка → `410 offer_expired` (см. раздел 6) |
| `POST /create-package` | для пакета из карты **LT `/orders/create` не вызывается**: заказ создаётся у нас (раздел 6). Для остальных пакетов — как раньше (прокси LT) |
| `POST /check_pay`, `POST /level_travel/notify-paid`, `POST /payment/status`, `GET /client/orders/:id`, `POST /client/orders/:id/sync` | только для внутренних заказов (`order_id > 900000000`) — middleware отвечает сам (раздел 6); остальные заказы идут в app.js как раньше |
| `POST /vtb/create-order`, `GET /orders/:id/payment` | сумма платежа помеченного заказа := Final Price |
| `GET /orders?order_id=9000000xx` (внутренний заказ) | **v3:** middleware отвечает сам из БД (`internalOrders.orderSnapshot`), LT не вызывается; допускаются `user` и `staff`. Формат — как DB-ветка app.js: `{ order_id, package (JSON заказа с нашими ценами, state = статус бронирования), pay_status, transaction_code, order_state, user_id, lt_auth_token: null, last_lt_event: null, internal: true, payment: {paid, payUrl, qrcId, amount, paymentMinutes, checkoutUrl, payStatus}, totus_room, totus_booking }` |
| `GET /orders` (LT-заказ), `/user/orders`, `/client/orders*` | цены помеченных заказов → наши, `+ totus_room`; у внутренних заказов `+ totus_booking`, `order_state` из бронирования; ответы LT для обычных заказов не трогаются |

Поля цены, которые переписываются: `price, full_price, total_price, remaining_amount, amount, analytics_price, price_rub, total, sum, cost, net_price, client_price, pay_amount, to_pay` — только если значение равно цене провайдера. **На проде проверить по реальному JSON `package_details`/`actualize`/`prebuild`** и при необходимости дополнить `PRICE_KEYS` в `lib/customRooms/packageFlow.js`.

Любая ошибка нашей логики → лог `[custom-rooms] …`, клиент получает оригинальный ответ LT.

### 2.2. v3: один номер, две группы предложений (решение владельца 15.09.2026, вечер)

На витрине **не должно быть двух одинаковых Room Type**. Карточка номера одна — LT-шная (`room.id`, название, фото, описание LT; `content` Room Type из админки на витрину **не применяется**, остаётся для админки). Внутри номера — две группы предложений, которые frontend делит **только по метке** `offer.lt_extras.totus.custom`:

- **Arlekino** — наши offers: оператор `Arlekino` (`operator_id = 990000 + roomTypeId` или `rt.operatorId`), наша цена, наши условия; идут **первыми** в каждом `offers[meal]`, куда добавлены; выбор такого offer → наш booking flow без LT (`tour_id` вида `t…`, раздел 6);
- **Level.Travel** — оригинальные offers LT (их операторы, цены, условия, `lt_extras: null`) — байт-в-байт как отдал LT, в том же порядке; выбор → LT flow.

Хелпер (backend `lib/customRooms/inject.js`, на фронте — аналог в `src/utils/roomOffers.ts`):

```js
const isArlekinoOffer = (o) => Boolean(o?.lt_extras?.totus?.custom); // НЕ по id, оператору или названию
```

Стабильный ключ соответствия — `custom_room_types.source_room_id ↔ room.id` (число). Запасной связи по названию номера **нет** (`findSourceIndex` ищет только по `room.id`; дедупликация по названию запрещена) — при чужом `room.id` причина пропуска `source_room_missing`.

**Поля для фронта** (формат `HotelRoom` не меняется):

| Поле | Значение |
|---|---|
| `room.lt_extras.totus` | `{ roomTypeId, customOffers: <сколько наших offers внутри>, sourceRoomId }` — есть только у номеров с нашими предложениями (у LT `lt_extras` обычно `null`; объект создаётся) |
| `room.min_price` | минимум по **всем** предложениям номера (наши + LT): fixed 1 ₽ → «от 1 ₽», −10 % от 258 996 → «от 233 096 ₽» |
| `room.meal_types[].min_price`, `filters.meals[].min_price`, `min_price` отеля | пересчитаны так же |
| `offer.id` | `t<roomTypeId>-<n>-<hash>` — только для booking-развода (`isVirtualOfferId`), не для группировки |
| `offer.lt_extras.totus` | `{ custom: true, roomTypeId, sourceOfferId, meal, mode: 'fixed'\|'rule', source: 'arlekino' }` |
| `offer.operator_id`, `offer.operator_name` | `990000 + roomTypeId` (или `operatorId` Room Type), `'Arlekino'` — оператор «Arlekino» попадает в список операторов фильтра |
| `offer.price`, `price_per_night`, `analytics_price` | наши (`price_per_night = round(price / nights_count)`) |
| `offer.nights_count`, `start_date`, `availability`, `extras.instant_confirm`, `extras.cancellation_policy`, `surcharge` | как у шаблона LT (клон) — фильтры сайта по дате/ночам/отмене/подтверждению работают |
| `offer.extras.cheap`, `extras.best_price` | `false` (метки LT о цене провайдера сняты) |
| `offer.link` | `/package_details/<наш id>?…` (id шаблона заменён на наш) |

Пример offer «Arlekino» на реальном ответе (Rixos Premium Seagate 9022465, номер 101879 «Улучшенный номер Aqua», fixed 1 ₽):

```json
{"id":"t1-1-sfcrrn","nights_count":7,"price":1,"operator_id":990001,"operator_name":"Arlekino","start_date":"2026-09-29",
 "link":"/package_details/t1-1-sfcrrn?hotel_id=9022465&request_id=REQ",
 "lt_extras":{"totus":{"custom":true,"roomTypeId":1,"sourceOfferId":"078-4a3340af5bd0fdf50d0272286c4773a4","meal":"UAI","mode":"fixed","source":"arlekino"}},
 "price_per_night":0,"extras":{"cheap":false,"instant_confirm":true,"best_price":false,"surcharge":0,"cancellation_policy":null},
 "availability":{"flight":"n/a","hotel":"n/a"}}
```

Номер: `ID: "13705"`, `room.id: 101879`, `min_price: 1`, `meal_types: [{"id":"UAI","min_price":1,"description":"Ультра всё включено"}]`, `lt_extras: {"totus":{"roomTypeId":1,"customOffers":1,"sourceRoomId":101879}}`, `offers.UAI: [<наше t1-1-…>, <7 оригиналов LT: Level.Travel 258 996, Biblio Globus 273 157, …>]`.

`package = hotel`: Room Type с `packageTypes: ['hotel']` не попадает в выдачу/фильтры пакетного поиска (и наоборот `['package']`) — решает backend по `search_type` (`/start-search` → `custom_room_searches`, иначе код в теле ответа LT: 0 = package, 1 = hotel). Подпись «с перелётом»/«без перелёта» фронт берёт из `search_type` текущего поиска, не из Room Type.

Два Room Type на один номер: оба внутри номера (порядок по `sort_order`), `lt_extras.totus.roomTypeId` — первый, `customOffers` — сумма. Наши предложения никогда не берутся шаблоном (повторная обработка не даёт дубликата LT-клона). Сбой записи `custom_room_offer_map` → номер откатывается к оригиналу LT, клиент получает исходное тело.

**Как сайт получает номера (totus_WEB, страница `/hotel-details`):** `useInitialHotelSearch` → `GET /start-search?search_type=package` (по умолчанию; `hotel` только если в URL `search_type=hotel`) `&hotel_ids=<id>&from_city=Moscow&start_date&nights&adults…` → `request_id` → `useHotelRooms` опрашивает `GET /search-status` и несколько раз вызывает `GET /hotels-rooms?request_id&hotel_id` (при фильтрах — ещё `meals`, `operators`, `confirmability`, `free_cancel`). На клиенте номера фильтруются только по `offers[].nights_count` = `nights` из URL и `offers[].start_date` = выбранная дата; ключ номера — индекс, оператор — `offer.operator_id/operator_name` (фильтр «Операторы» строится из самих номеров). Наши предложения (`operator_id = 990000+id`, внутри исходного номера) через эти фильтры проходят, потому что клоны шаблона сохраняют `start_date`/`nights_count`. `/get-hotel-offers` сайт не использует.

Для каждой активной Room Type отеля в лог пишется одна строка `[custom-rooms] hotel <hotel_id>: rt <id> — injected (…) | skipped:<reason>`, причина сохраняется в `custom_room_types.last_skip_reason` + `last_checked_at` (в ответах админки — `lastSkipReason`, `lastCheckedAt`; при вставке сбрасывается в `null`). Причины: `no_pricing` (режим цены без цены/правила), `search_type (…)` (`hotelOnly` или `packageTypes` не совпали с типом поиска), `source_room_missing (source <id>; ids in result: …)` (номера с таким `room.id` нет в выдаче — перечислены id, которые есть), `no_offers (…)` (у источника нет предложений / нет нужного питания), `no_priced_offers`, `offer_map_failed (…)` (не удалось записать карту предложений — клиент получил оригинал LT).

### 2.1. v2: связь по номеру и фиксированная цена (решение владельца 15.09.2026)

Владелец в админке выбирает **конкретный номер Level.Travel** (`source_room_id`). Если пользователь любым способом в поиске приходит к этому номеру — независимо от даты, ночей, гостей и типа поиска — внутри него показывается наше предложение как оператор **Arlekino** с ценой из админки (1 ₽ → показываем 1 ₽). Связь — по номеру, а **не** по наличию в выдаче предложения конкретного оператора (так было в v1, и из-за этого Room Type не отображался).

- **Поиск источника**: только по `room.id === source_room_id` (v3: запасной вариант по названию убран — см. 2.2).
- **Шаблон** предложения — предложения исходного номера: `meal_types` заданы → по одному на каждое питание (самое дешёвое этого питания у номера), иначе одно с самым дешёвым питанием. Оператор шаблона не важен; `custom_room_offer_map.provider_price` = цена шаблона (для маржи), `operator_id` карты = оператор шаблона.
- **Цена** (`pricing_mode`): `fixed` (по умолчанию для новых) — `fixed_price` (`fixed_price_unit`: `total` за проживание | `per_night` × `nights_count` шаблона; нет ночей — как total); `rule` — прежнее правило от цены LT (раздел 3). `price_per_night = round(price / nights_count)`.
- **Оператор**: `operator_name` (по умолчанию `Arlekino`), `operator_id` — id в терминах LT, если известен, иначе синтетический `990000 + room_type_id` (в ответах `effectiveOperatorId`).
- **Контент/фото** Room Type: с v3 на витрину не применяются (карточка одна — LT-шная); хранятся для админки.
- `operator_ids` / `meal_types` Room Type — **необязательны** (пустые = не ограничивать). `operator_ids` лишь ограничивают, чьи предложения берутся шаблоном для нашей цены; предложения источника **не удаляются** (с 15.09 показываются оба). Настройка `hotelOnly` по умолчанию `false` (миграция v2 выставляет `false`; включить можно в настройках); `packageTypes` пустые = любой тип поиска.
- **Бронирование**: без изменений (раздел 6) — `package_details` с `tour_id` шаблона; `provider_price` в бронировании/заказе = цена шаблона LT; `price_rule` = снимок `{ mode:'fixed', fixedPrice, unit, operator }` или `{ mode:'rule', type, value, … , operator }`; в `totus_booking.priceRule` для fixed — `{ mode:'fixed', fixedPrice, unit, label:'1 ₽ (фикс.)' }`.
- **Ограничение — `/grouped-hotels`**: список отелей (цены «от N ₽» в карточках) не трогаем: до `hotel_rooms` неизвестно, есть ли номер в выдаче, поэтому у отелей с активными Room Type (в т. ч. с `fixed` ценой) карточка в списке показывает минимум LT, а наша цена видна на странице отеля.
- **Обратная совместимость**: существующие Room Type с правилом продолжают работать (`pricing_mode='rule'` при миграции, если `rule_type` не NULL, иначе `fixed`); строки без `pricing_mode` сериализуются так же. Room Type в режиме `rule` без правила на витрину не попадает.

## 3. Правило цены

`final = provider × (1 + value/100)` (percent) или `provider + value` (absolute) → округление 1/10/100 ₽ → `min_price`/`max_price` → минимальная маржа `final ≥ provider − margin` (margin: `percent` | `absolute`; своя на комнате или глобальная из настроек; ниже порога — поднимаем, `margin_clamped`). Считается на каждом ответе LT для каждого предложения-шаблона. Действует только при `pricing_mode='rule'`.

## 4. Админка — `/api/admin/rooms/*` (Bearer staff-JWT, strict)

- `GET /hotels/search?to_country=EG&to_city=…&from_city=Moscow&start_date=2026-10-12&nights=7&adults=2&stars=5&q=Rixos&only_ours=1&request_id=…&page_number=0` — enqueue (`search_type=hotel`) + ожидание статуса (до `wait_ms`, по умолчанию 20 с) + `get_grouped_hotels` (`filter_stars`, `filter_hotel_name`) → `{ request_id, status, ready_operators, hotels: [{…LT, totus_room_types}], raw_meta }`. Повторный вызов с `request_id` — без нового поиска.
- `GET /hotels/:hotelId/rooms?request_id=…` → `{ operators: [{operator_id, operator_name, rooms: [{room_id, ID, room, offers: [{id, meal, price, nights_count, extras, availability}], room_types: [id]}]}], rooms: [{…, room_types: [id]}], room_types: [{…, ruleLabel, pricingLabel, status: fixed|active|inactive|source_missing|no_offers|no_pricing|margin_clamped, preview: [{offer_id, meal, operator_id, operator_name, nights_count, provider_price, final_price, margin, margin_percent, margin_clamped, mode, our_operator_id, our_operator_name}]}], settings }` (v3: статуса `replacing` и поля `replaces_offer_ids` нет — предложения LT не замещаются; `active` — rule-режим, номер в выдаче, наши предложения внутри номера). v2: наши Room Type показываются под исходным номером **всегда**, когда номер есть в выдаче (`rooms[].room_types`); `status: fixed` — активна, номер в выдаче, фиксированная цена; preview для `fixed` — фиксированная цена, для `rule` — от самого дешёвого предложения номера (по питанию).
- `GET /room-types?hotel_id&active=1|0&q` → `{ room_types, settings }`; `GET /room-types/:id`. Объект Room Type v2: `+ pricingMode: fixed|rule, fixedPrice, fixedPriceUnit: total|per_night, operatorName, operatorId, effectiveOperatorId, pricing, previewPrice` (fixed → сама цена; rule → расчёт от `last.providerPrice`, `null`, если ещё не видели); `rule/ruleType/ruleValue` могут быть `null`; диагностика: `lastSkipReason` (причина, по которой комната не вставлена в последний ответ `/hotels-rooms`; `null` — вставлена или ещё не проверялась), `lastCheckedAt` (также в `last.skipReason/last.checkedAt`).
- `GET /diagnostics?recheck=1` — раздел 7 (отвечает и при `503 custom_rooms_not_migrated` у остальных маршрутов).
- `POST /room-types` — создать: `{ hotelId, hotelName, hotelStars, hotelCity, sourceRoomId, sourceRoomName, sourceSnapshot?, source?: {room}, pricingMode: 'fixed'|'rule' (default fixed; тело v1 с rule и без pricingMode → rule), fixedPrice, fixedPriceUnit?: 'total'|'per_night', operatorName?: 'Arlekino', operatorId?, operatorIds?: [12], operatorNames?: ["Arlekino"], mealTypes?: ["AI"], content: {nameRu, nameEn, accommodation, area, view, description, facilities: [..], images: [{source:'lt'|'upload', url}]}, rule?: {ruleType: percent|absolute, ruleValue, rounding, minPrice, maxPrice, minMarginType?, minMarginValue?}, packageTypes?: [] (пустые = любой тип поиска), badge, active, sortOrder }`. Валидация: `fixed` → `fixedPrice > 0`; `rule` → правило как раньше. Если передан `source.room` (объект `room` из выдачи) и нет `content` — контент и фото LT предзаполняются.
- `PUT /room-types/:id` — те же поля (частично; `pricingMode` не передан — режим не меняется); `POST /room-types/:id/toggle {active?}`; `DELETE /room-types/:id`.
- `POST /room-types/:id/duplicate { name?, copyContent?: true, copyRule?: true, images?: 'same'|'none' }` — копия создаётся выключенной (режим цены, фиксированная цена и оператор копируются).
- `POST /room-types/preview-price { pricingMode?: 'rule', rule, offers: [{operator_name, meal, price, nights_count}] } | { pricingMode:'fixed', fixedPrice, fixedPriceUnit?, offers? | nights? }` → `{ pricingMode, fixedPrice, fixedPriceUnit, label, rule: {…, label} | null, rows: [{provider_price, nights_count, final_price, margin, margin_percent, margin_clamped, floor, mode}] }`.
- `GET /room-types/:id/price-log?from&to&operatorId&meal&limit`, `GET /room-types/:id/change-log`, `GET /room-types/:id/orders`.
- `POST /images` (multipart `image`, до 15 МБ, jpeg/png/webp) → `{ image: {source:'upload', url:'/uploads/rooms/<file>'} }`; `DELETE /images { url }`.
- `GET /settings`, `PUT /settings { minMarginType: percent|absolute|null, minMarginValue, rounding, badge, hotelOnly }`.

Ошибки: `400` валидация (`hotel_id_invalid, source_room_id_invalid, name_required, pricing_mode_invalid, fixed_price_invalid, fixed_price_out_of_range, operator_id_invalid, rule_type_invalid, rule_value_invalid, rule_value_out_of_range, min_max_invalid, min_margin_invalid, request_id_required`; `operator_required` с v2 не возвращается), `404 not_found`, `503 custom_rooms_not_migrated`, ошибки LT — как отдаёт LT (`sendLtAxiosError`).

## 5. Таблицы

`custom_room_types` (v2: `pricing_mode ENUM('fixed','rule') DEFAULT 'fixed'`, `fixed_price`, `fixed_price_unit ENUM('total','per_night')`, `operator_name DEFAULT 'Arlekino'`, `operator_id`; `rule_type/rule_value/operator_ids` — NULL допустим; диагностика: `last_skip_reason VARCHAR(255)`, `last_checked_at DATETIME` — необязательны для работы модуля), `custom_room_settings`, `custom_room_price_log` (история цен, ≤ 1 запись/комната/оператор/питание/час при неизменной цене), `custom_room_change_log`, `custom_room_offer_map` (3 ч), `custom_room_package_map` (24 ч; + `hotel_id`, `meal`, `package_snapshot`), `custom_room_searches` (6 ч), `custom_room_bookings`, `custom_room_booking_events`; `orders.custom_room_type_id, provider_price, final_price, price_rule`. Просроченные карты чистятся раз в час.

## 6. Бронирования без Level.Travel (оператор Arlekino)

Решение владельца: пользователь выбирает наш номер (Arlekino) → оплачивает → бронирование хранится **только у нас** → появляется в админке → сотрудник подтверждает или отклоняет. **Level.Travel не участвует нигде**: `orders/create`, `prebook`, `prebuild`, `orders/:id/notify` для таких заказов не вызываются (см. `middleware/customRooms.js`, `lib/customRooms/internalOrders.js`, `utils/vtbCallback.js`). Возврат денег — только вручную (API VTB на возврат не используется; сотрудник отмечает «возврат выполнен»). Ваучер/подтверждение клиенту отправляем мы от имени **Arlekino Tour** (`lib/customRooms/bookingEmails.js`). Автоотклонения по таймеру нет.

### 6.1. Витрина (frontend до оплаты не меняется, формат ответов — как у LT)

Виртуальное предложение `tour_id = t<rt>-<n>-<hash>` → `package_details` (LT вызывается — нужен состав пакета; цены → наши; ответ сохраняется в `custom_room_package_map.package_snapshot`) → `actualize` (как раньше). Дальше для `package_id` из карты:

- `POST /orders/prebuild`, `POST /packages/prebook`, `POST /packages/flights` → `200 { success:true, ...package_snapshot, totus_room, totus_booking:{ internal:true, operator:'Arlekino' } }`, без LT. Нет снимка → `410 { success:false, error:'offer_expired' }`.
- `POST /create-package` (Bearer user-JWT — `requireAuth(['user'])` как в app.js; email + телефон покупателя обязательны, иначе `400 { success:false, error:'Buyer email and phone are required' }`): создаётся `custom_room_bookings` (status `pending_payment`), `order_id = 900000000 + booking.id`, строка `orders` (`package` JSON в формате LT-заказа с нашими ценами, `lt_auth_token = NULL`, `custom_room_type_id/provider_price/final_price/price_rule`, `order_state`), событие `created`. Платёж: `payload.payUrl` → `savePaymentToPackage` + письмо «заказ создан»; иначе `createVtbPaymentForOrder({ amount: final, paymentMinutes: 30, sendEmail: true })` (ошибка платежа не ломает ответ — ссылку можно получить через `GET /orders/:id/payment?ensure=1`). Ответ в формате LT create: `{ success:true, order:{ id: 900000012, state:'pending_payment', full_price, price, remaining_amount, package, tourists, client, … }, totus_room, totus_booking, payment:{ payUrl, qrcId, amount } }` — frontend читает `order.id`.
- `POST /check_pay { qrcId | orderId }` для внутреннего заказа (по `orderId` или `qrcId → orders.transaction_code`): статус СБП проверяется у VTB (`lib/customRooms/vtbCheck.js` — та же логика, что `/check_pay` в app.js), `orders.pay_status/transaction_id/transaction_code` обновляются, **LT notify не вызывается**; ответ в том же формате `{ message, status, paid, qrcId, order_id, transaction_id, transaction_code, notify_status:null, notify_result:'skipped_internal', notify_data:null, notify_error:null, internal:true, totus_booking }`. Первая успешная оплата → `onPaid`.
- `POST /vtb/callback` (`utils/vtbCallback.js`): для внутренних заказов `lt_notify = { result:'skipped', reason:'internal_order' }`, вызывается `bookings.onPaid`; `sendOrderPaidPendingEmail` не отправляется (текст про «документы через 15 минут» не подходит). REFUND-callback → в бронировании `refund_status='done'`.
- `onPaid`: `payment_status='paid'`, `paid_at`, `paid_amount`, `status='pending_confirmation'`, `orders.order_state='pending_confirmation'`, событие `paid`; клиенту письмо «Оплата получена — проверяем бронирование» (Arlekino Tour) + push `order_status` «Проверяем бронирование»; сотрудникам письмо на `BOOKINGS_NOTIFY_EMAIL`.
- Просмотр: `GET /orders?order_id=900000012` — **v3:** middleware отвечает сам из БД (раздел 2, `orderSnapshot`; `lt_auth_token: null`, `last_lt_event: null`, `internal: true`, `payment`, `totus_room`, `totus_booking`, `order_state` из бронирования; LT не вызывается; `user` и `staff`). `GET /user/orders` — app.js отдаёт DB-снимок, middleware добавляет `totus_booking` и `order_state`. Правки `app.js` для LT-заказов (`lt_auth_token` без env-fallback, `requireAuth(['user','staff'])`, `/client/orders*`, `/create-package`, `CORS_ORIGINS`) — `docs/ORDERS_FLOW_PATCH.md`. `GET /client/orders/:id` → `{ success:true, order:<package JSON заказа>, internal:true, totus_booking }`; `POST /client/orders/:id/sync` → `{ success:true, synced:false, internal:true, totus_booking }`. `GET /orders/:id/payment` — как раньше. `GET /orders/documents` — ваучер лежит в `order_documents` (`title='Ваучер'`, `event_reference='totus_voucher_<bookingId>'`).
- `POST /level_travel/notify-paid`, `POST /payment/status` с внутренним `order_id` → `200 { success:true, skipped:'internal_order', order_id }`.

### 6.2. Объект `totus_booking` (единый для клиентов и админки)

```json
{
  "internal": true, "bookingId": 12, "orderId": "900000012", "operator": "Arlekino",
  "status": "pending_confirmation",
  "statusLabel": "Проверяем бронирование",
  "statusText": "Оплачено 86 850 ₽. Подтвердим бронирование и пришлём ваучер.",
  "paymentStatus": "paid", "paidAt": "2026-09-10T14:20:00.000Z", "paidAmount": 86850,
  "hotelBookingRef": null, "confirmedAt": null, "clientMessage": null,
  "rejectedAt": null, "rejectReason": null, "rejectReasonLabel": null, "rejectMessage": null,
  "refund": null,
  "voucher": null,
  "hotel": { "id": 123, "name": "Rixos Premium", "stars": 5, "city": "Белек" }, "room": "Deluxe Sea View", "meal": "AI", "mealName": "Всё включено",
  "checkIn": "2026-10-12", "checkOut": "2026-10-19", "nights": 7, "adults": 2, "kids": 0,
  "providerPrice": 96500, "finalPrice": 86850, "priceRule": { "mode": "rule", "type": "percent", "value": -10, "label": "−10 %" }
}
```

v2: при фиксированной цене `"providerPrice": 97500` (цена шаблона LT), `"finalPrice": 1`, `"priceRule": { "mode": "fixed", "fixedPrice": 1, "unit": "total", "label": "1 ₽ (фикс.)" }`.

`status`: `pending_payment` («Ожидает оплаты») | `pending_confirmation` («Проверяем бронирование») | `confirmed` («Бронирование подтверждено») | `rejected` («Бронирование отклонено») | `cancelled` («Бронирование отменено»). `refund`: `{ amount, method:'manual', status:'pending'|'done', at }` после отклонения/отмены. `voucher`: `{ url, title:'Ваучер', sentAt }` после загрузки. `rejectReason`: `no_availability` «Нет мест на эти даты», `price_changed` «Цена изменилась», `data_error` «Ошибка в данных», `other` «Другое». `statusText` при отклонении: «Бронирование отклонено: <причина>. Возврат N ₽ выполним вручную в течение 1–3 дней.» / «…Возврат N ₽ выполнен.»; при подтверждении: «Номер брони HTL-…. Ваучер — в документах заказа.». ПД (имя, телефон, e-mail) в `totus_booking` нет.

### 6.3. Admin API — `/api/admin/rooms/bookings/*` (staff-JWT strict)

- `GET /bookings?status=all|pending|confirmed|rejected|refund|unpaid&hotel_id&operator&q&from&to&page&limit` → `{ items:[{ ...totus_booking, customer:{name, phone, email}, createdAt, updatedAt, staffComment, confirmedBy, rejectedBy, roomTypeId }], total, page, limit, summary:{ pending, confirmed30d, rejected, refundPending, refundPendingAmount } }`. `pending` = `pending_confirmation`; `rejected` = `rejected + cancelled`; `refund` = `refund_status='pending'`; `q` ищет по номеру заказа, отелю, номеру, номеру брони, контакту. `GET /bookings/summary` — только сводка.
- `GET /bookings/:id` → `{ booking:{ ...totus_booking, customer, tourists, contact, hotelSnapshot, roomSnapshot, staffComment, packageId }, roomType:{ id, name, sourceRoomName, hotelName, active }, events:[{ id, type, staffName, payload, createdAt }], order:{ orderId, payStatus, transactionCode, orderState, payUrl, payAmount } }`.
- `POST /bookings/:id/confirm { hotelBookingRef?, clientMessage?, notify=true }` — только из `pending_confirmation` (иначе `409 { error:'invalid_status', status, allowed }`); `status='confirmed'`, `orders.order_state='confirmed'`; письмо клиенту (+ ваучер вложением, если загружен) + push `order_confirmed` «Бронирование подтверждено»; события `confirmed`, `notified`, `voucher_sent`.
- `POST /bookings/:id/voucher` (multipart поле `voucher`, PDF ≤ 10 МБ → `uploads/vouchers/`, `middleware/uploadVoucher.js`) → `voucher_path/url`, запись в `order_documents`, событие `voucher_uploaded`. Можно до confirm (уйдёт с подтверждением) и после — тогда `POST /bookings/:id/resend-voucher` отправляет письмо с ваучером + push `documents_ready` (voucher). Ошибки: `400 file_too_large | file_invalid | file_required | voucher_required`.
- `POST /bookings/:id/reject { reason, message?, refundAmount (default = оплачено), refundDone?: false, notify=true }` — из `pending_confirmation`; `status='rejected'`, `payment_status='refund_pending'` (или `refunded|partially_refunded`, если `refundDone`), `refund_amount/method='manual'/status='pending'|'done'`, `orders.order_state='rejected'`; письмо + push `order_cancelled` «Бронирование отклонено» с причиной и строкой про возврат. Ошибки: `400 reason_invalid | refund_amount_invalid`.
- `POST /bookings/:id/cancel { reason (default other), message?, refundAmount?, refundDone?, notify=true }` — из `confirmed` (отмена уже подтверждённого): `status='cancelled'`, далее как reject.
- `POST /bookings/:id/refund-done { amount?, notify=true }` — только при `refund_status='pending'`; `refund_status='done'`, `refund_at`, `payment_status = refunded | partially_refunded`, `orders.refund_amount/refund_at`; письмо + push `order_status` «Возврат N ₽ выполнен».
- `POST /bookings/:id/comment { text }` — `staff_comment`; событие `comment`.

Все ответы действий: `{ ok:true, booking:<admin-объект> }`. Все действия пишут `staff_id/staff_name` из `req.auth` в `custom_room_booking_events` (`created | paid | payment_failed | confirmed | rejected | cancelled | refund_done | voucher_uploaded | voucher_sent | comment | notified`).

### 6.4. Письма и push

Письма клиенту (`lib/customRooms/bookingEmails.js`, транспорт `utils/yandexCloudEmail.sendEmail`, общий шаблон `utils/emailTemplates.emailShell`, шапка и подпись «Arlekino Tour»): оплачено/проверяем, подтверждено (+ PDF-ваучер ≤ 9 МБ вложением и ссылка), отклонено/отменено (причина + «Возврат N ₽ выполним вручную в течение 1–3 рабочих дней»), возврат выполнен, ваучер повторно. Push через `lib/notifyHub` (`order_status`, `order_confirmed`, `order_cancelled`, `documents_ready`; `data:{ orderId, route:'order'|'documents' }`, без ПД). Сотрудникам — `BOOKINGS_NOTIFY_EMAIL` после оплаты. Все отправки fire-and-forget, результат — в событии `notified`.

## 7. Диагностика — `GET /api/admin/rooms/diagnostics` (staff-JWT, работает и при DISABLED)

Зачем: у владельца нет доступа к логам сервера, а причин, по которым активированный Room Type не виден на сайте, несколько. Маршрут смонтирован **до** `readyGuard`, поэтому отвечает даже когда миграция не выполнена. `?recheck=1` — перепроверить схему БД прямо сейчас (иначе — состояние последней проверки, они идут раз в минуту при DISABLED и один раз при старте, когда всё в порядке).

```json
{
  "ready": true, "disabledReason": null, "missingTables": [], "missingColumns": [], "diagColumns": true, "checkedAt": "…", "dbError": null,
  "settings": { "hotelOnly": false, "badge": "Totus", "rounding": 1, "minMarginType": null, "minMarginValue": null },
  "env": { "hotelSearchTypeCodes": "1" },
  "activeRoomTypes": [{ "id": 9, "hotelId": 123, "hotelName": "Rixos", "sourceRoomId": 501, "sourceRoomName": "Deluxe", "pricingMode": "fixed", "pricingOk": true, "pricingLabel": "1 ₽ (фикс.)", "packageTypes": [], "lastSeenAt": null, "lastCheckedAt": "…", "lastSkipReason": "source_room_missing (source 501; ids in result: 611,612)" }],
  "appJsHooks": {
    "middleware": { "mounted": true, "middlewareCalls": 1532, "watchedCalls": 40, "notReadySkips": 0, "startSearchSeen": 12, "hotelsRoomsSeen": 25, "hotelsRoomsInjected": 0, "hotelsRoomsErrors": 0,
                    "lastStartSearchAt": "…", "lastHotelsRoomsAt": "…", "lastHotelsRoomsHotelId": "123", "lastHotelsRoomsSearchType": "package", "lastInjectAt": null, "lastError": null, "startedAt": "…" },
    "adminRoutes": true
  },
  "events": [{ "at": "…", "line": "[custom-rooms] hotel 123: rt 9 — skipped:source_room_missing (source 501; ids in result: 611,612)" }],
  "hints": ["Room Type #9 (Rixos): последний раз пропущен — source_room_missing (…)."]
}
```

- `ready=false` → `disabledReason` (`tables missing: …` / `columns missing: …` / `db error: …`): выполнить `node scripts/run-custom-rooms-migration.js && pm2 restart api`, открыть с `?recheck=1`.
- `appJsHooks.middleware.mounted=false` (`middlewareCalls=0`) — сам запрос диагностики проходит через `app.use(require('./middleware/customRooms'))`, поэтому ноль означает, что строка не подключена или процесс не перезапущен.
- `hotelsRoomsSeen=0` при `mounted=true` — до middleware не доходит `GET /hotels-rooms?request_id&hotel_id` (сайт ходит на другой хост/путь, или страницу отеля ещё не открывали после `pm2 restart` — счётчики в памяти процесса, `startedAt`).
- `hotelsRoomsSeen>0`, `hotelsRoomsInjected=0` — смотреть `activeRoomTypes[].lastSkipReason` и `events`: `search_type (…)` → выключить `hotelOnly` / поставить «Любой тип поиска» у Room Type; `source_room_missing (ids in result: …)` → в этой выдаче LT нет номера с таким `room.id` (сравнить с перечисленными id; v3: по названию номер не ищется — только `room.id`); `no_offers` → у источника нет предложений на эти параметры; `no_pricing` → сохранить цену в редакторе.
- `lastCheckedAt` пуст у Room Type, хотя `hotelsRoomsSeen` растёт — запросы идут по другому `hotel_id`, чем `hotelId` Room Type.

Проверка без БД: `node scripts/check-custom-rooms-diag.js` (причины пропуска, связь только по `room.id`, откат при сбое карты, счётчики middleware, ответ диагностики; входит в `npm run check`).

### 7.1 Живая проверка на проде (15.09.2026) и проверка на реальном ответе LT

Через публичные прокси `api.totus.club` (Москва → Египет, 29.09.2026, 7 ночей, 2 взрослых, `filter_hotel_name=rixos`, 8 отелей) в `GET /hotels-rooms` отеля 9022465 (Rixos Premium Seagate) Room Type #5 (`source_room_id 101879`, правило −10 %) срабатывает при всех трёх сценариях: `search_type=package`, `search_type=hotel` и поиск сайта с `hotel_ids=9022465` (на момент проверки — ещё в формате v2: отдельная комната `totus-5`). У остальных семи отелей Rixos активных Room Type нет.

**Ожидаемо после деплоя v3** (тот же отель, `scripts/check-custom-rooms-live.js` на реальном payload): одна карточка «Улучшенный номер Aqua» (`ID "13705"`, `room.id 101879`), без `totus-*`; внутри `offers.UAI` первым — «Arlekino» (`operator_id 990005`, `lt_extras.totus.custom: true`, 233 096 ₽ при −10 % от 258 996 / 1 ₽ при fixed 1 ₽), далее семь оригиналов Level.Travel (258 996, 273 157, …) без изменений; `min_price` номера и `filters.meals[UAI].min_price` — «от 233 096 ₽» / «от 1 ₽».

Особенности реального ответа LT, закреплённые в `scripts/fixtures/hotel_rooms_sample.json` и `scripts/check-custom-rooms-live.js` (входит в `npm run check`, как и `scripts/check-custom-rooms-orders.js` — перехват `GET /orders` для внутренних заказов, `resolveAuthToken`): `lt_extras: null` и `labels: null` у предложений, `search_type: 0` (package) / `1` (hotel) в теле ответа, `ID` и `hotel_id` — строки, у части номеров `room.id = 0` с hash-`ID` (из таких Room Type создать нельзя — `source_room_id_invalid`), `request_id` длиннее 64 символов (режется в `saveOfferMap`).

Если владелец не видит комнату на сайте, а `/hotels-rooms` её отдаёт — причина не в API: сверить `hotel_id`/даты в запросе сайта (DevTools → Network → `hotels-rooms`), обновить страницу без кэша; в админке (Настройки → Диагностика) у нужного Room Type смотреть `lastSkipReason`/`lastCheckedAt`.
