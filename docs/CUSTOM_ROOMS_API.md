# Собственные Room Type — API и подключение

Наши Room Type поверх предложений Level.Travel: план `claude/CUSTOM_ROOMS_PLAN_RU.md`, макеты `claude/CUSTOM_ROOMS_DESIGN_RU.md` (проект Totus Dev). Код: `lib/customRooms/{pricing,store,inject,packageFlow}.js`, `middleware/customRooms.js`, `routes/customRooms.routes.js`, `controllers/customRooms.controller.js`, `middleware/uploadRoomImage.js`.

## 1. Подключение (владелец) — две строки в `app.js`

`app.js` (60 КБ) через коннектор не правится, поэтому:

```js
// после  app.use(express.json());  (строка ~38) — ДО прокси-маршрутов Level.Travel
app.use(require('./middleware/customRooms'));

// рядом с остальными /api/admin (строки ~1599–1618)
app.use('/api/admin/rooms', require('./routes/customRooms.routes'));
```

Затем: `node scripts/run-custom-rooms-migration.js` (7 таблиц `custom_room_*` + 4 колонки в `orders`, идемпотентно), `pm2 restart api`, `npm run check` (`scripts/check-custom-rooms.js` — без БД). Лог при старте: `[custom-rooms] ready`; без миграции — `[custom-rooms] DISABLED …`, витрина работает как раньше, админка отвечает `503 custom_rooms_not_migrated`.

Переменные: `CUSTOM_ROOMS_HOTEL_SEARCH_TYPE_CODES` (необязательно; коды `search_type` в ответе LT `hotel_rooms`, считающиеся поиском «отель», по умолчанию `2`; основной источник — параметр `search_type` при `/start-search`).

## 2. Как работает витрина (frontend без изменений)

| Маршрут | Что делает middleware |
|---|---|
| `GET /start-search` | запоминает `request_id → search_type` (`custom_room_searches`) |
| `GET /hotels-rooms` | при `search_type = hotel`: для активных Room Type отеля предложения источника (номер × выбранные операторы × питание) удаляются из исходного номера и вставляются как наша комната `ID: "totus-<id>"` с нашим контентом и ценой `rule(providerPrice)`; offer `id = "t<rt>-<n>-<hash>"`, `operator_name` сохранён, `lt_extras.totus = {custom, roomTypeId, sourceRoomId}`; `min_price`, `meal_types[].min_price`, `filters.meals[].min_price` пересчитаны. Пары `virtual → source offer` — `custom_room_offer_map` (3 ч). Нет источника в выдаче — нашей комнаты нет |
| `GET /packages/package_details?tour_id=t…` | `tour_id` → исходный; в ответе цены `package.price` и равные цене провайдера «ценовые» поля → наша цена; `package.id` → `custom_room_package_map` (24 ч); `+ totus_room {roomTypeId, providerPrice, finalPrice}`. Устаревший id → `410 offer_expired` |
| `GET /packages/actualize`, `POST /orders/prebuild`, `POST /packages/prebook`, `POST /packages/flights` | по `package_id` из карты: свежая цена LT из ответа → пересчёт по актуальному правилу → цены переписаны; `totus_room.priceChanged {from,to}`, если провайдер изменил цену |
| `POST /create-package` | `body.payment.amount` := Final Price; после создания — `orders.custom_room_type_id/provider_price/final_price/price_rule`, цены в `orders.package` JSON и в ответе → наши. Заказ в LT создаётся по цене провайдера |
| `POST /vtb/create-order`, `GET /orders/:id/payment` | сумма платежа помеченного заказа := Final Price |
| `GET /orders`, `/user/orders`, `/client/orders*` | цены помеченных заказов → наши, `+ totus_room` |

Поля цены, которые переписываются: `price, full_price, total_price, remaining_amount, amount, analytics_price, price_rub, total, sum, cost, net_price, client_price, pay_amount, to_pay` — только если значение равно цене провайдера. **На проде проверить по реальному JSON `package_details`/`actualize`/`prebuild`** и при необходимости дополнить `PRICE_KEYS` в `lib/customRooms/packageFlow.js`.

Любая ошибка нашей логики → лог `[custom-rooms] …`, клиент получает оригинальный ответ LT.

## 3. Правило цены

`final = provider × (1 + value/100)` (percent) или `provider + value` (absolute) → округление 1/10/100 ₽ → `min_price`/`max_price` → минимальная маржа `final ≥ provider − margin` (margin: `percent` | `absolute`; своя на комнате или глобальная из настроек; ниже порога — поднимаем, `margin_clamped`). Считается на каждом ответе LT для каждого предложения (оператор × питание).

## 4. Админка — `/api/admin/rooms/*` (Bearer staff-JWT, strict)

- `GET /hotels/search?to_country=EG&to_city=…&from_city=Moscow&start_date=2026-10-12&nights=7&adults=2&stars=5&q=Rixos&only_ours=1&request_id=…&page_number=0` — enqueue (`search_type=hotel`) + ожидание статуса (до `wait_ms`, по умолчанию 20 с) + `get_grouped_hotels` (`filter_stars`, `filter_hotel_name`) → `{ request_id, status, ready_operators, hotels: [{…LT, totus_room_types}], raw_meta }`. Повторный вызов с `request_id` — без нового поиска.
- `GET /hotels/:hotelId/rooms?request_id=…` → `{ operators: [{operator_id, operator_name, rooms: [{room_id, ID, room, offers: [{id, meal, price, nights_count, extras, availability}], room_types: [id]}]}], rooms: [...], room_types: [{…, ruleLabel, status: replacing|inactive|source_missing|margin_clamped, preview: [{offer_id, meal, operator_id, operator_name, provider_price, final_price, margin, margin_percent, margin_clamped}]}], settings }`.
- `GET /room-types?hotel_id&active=1|0&q` → `{ room_types, settings }`; `GET /room-types/:id`.
- `POST /room-types` — создать: `{ hotelId, hotelName, hotelStars, hotelCity, sourceRoomId, sourceRoomName, sourceSnapshot?, source?: {room}, operatorIds: [12], operatorNames: ["Arlekino"], mealTypes?: ["AI"], content: {nameRu, nameEn, accommodation, area, view, description, facilities: [..], images: [{source:'lt'|'upload', url}]}, rule: {ruleType: percent|absolute, ruleValue, rounding, minPrice, maxPrice, minMarginType?, minMarginValue?}, packageTypes: ['hotel'], badge, active, sortOrder }`. Если передан `source.room` (объект `room` из выдачи) и нет `content` — контент и фото LT предзаполняются.
- `PUT /room-types/:id` — те же поля (частично); `POST /room-types/:id/toggle {active?}`; `DELETE /room-types/:id`.
- `POST /room-types/:id/duplicate { name?, copyContent?: true, copyRule?: true, images?: 'same'|'none' }` — копия создаётся выключенной.
- `POST /room-types/preview-price { rule, offers: [{operator_name, meal, price}] }` → `{ rule: {…, label}, rows: [{provider_price, final_price, margin, margin_percent, margin_clamped, floor}] }`.
- `GET /room-types/:id/price-log?from&to&operatorId&meal&limit`, `GET /room-types/:id/change-log`, `GET /room-types/:id/orders`.
- `POST /images` (multipart `image`, до 15 МБ, jpeg/png/webp) → `{ image: {source:'upload', url:'/uploads/rooms/<file>'} }`; `DELETE /images { url }`.
- `GET /settings`, `PUT /settings { minMarginType: percent|absolute|null, minMarginValue, rounding, badge, hotelOnly }`.

Ошибки: `400` валидация (`hotel_id_invalid, source_room_id_invalid, operator_required, name_required, rule_type_invalid, rule_value_invalid, rule_value_out_of_range, min_max_invalid, min_margin_invalid, request_id_required`), `404 not_found`, `503 custom_rooms_not_migrated`, ошибки LT — как отдаёт LT (`sendLtAxiosError`).

## 5. Таблицы

`custom_room_types`, `custom_room_settings`, `custom_room_price_log` (история цен, ≤ 1 запись/комната/оператор/питание/час при неизменной цене), `custom_room_change_log`, `custom_room_offer_map` (3 ч), `custom_room_package_map` (24 ч), `custom_room_searches` (6 ч); `orders.custom_room_type_id, provider_price, final_price, price_rule`. Просроченные карты чистятся раз в час.
