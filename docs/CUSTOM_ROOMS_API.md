# Собственные Room Type — API и подключение

Наши Room Type поверх предложений Level.Travel: план `claude/CUSTOM_ROOMS_PLAN_RU.md`, макеты `claude/CUSTOM_ROOMS_DESIGN_RU.md` (проект Totus Dev). Код: `lib/customRooms/{pricing,store,inject,packageFlow}.js`, `middleware/customRooms.js`, `routes/customRooms.routes.js`, `controllers/customRooms.controller.js`, `middleware/uploadRoomImage.js`; бронирования без Level.Travel (раздел 6): `lib/customRooms/{bookings,bookingEmails,internalOrders,vtbCheck}.js`, `middleware/uploadVoucher.js`, правка `utils/vtbCallback.js`.

## 1. Подключение (владелец) — две строки в `app.js`

`app.js` (60 КБ) через коннектор не правится, поэтому:

```js
// после  app.use(express.json());  (строка ~38) — ДО прокси-маршрутов Level.Travel
app.use(require('./middleware/customRooms'));

// рядом с остальными /api/admin (строки ~1599–1618)
app.use('/api/admin/rooms', require('./routes/customRooms.routes'));
```

Затем: `node scripts/run-custom-rooms-migration.js` (9 таблиц `custom_room_*` + 4 колонки в `orders` + 3 колонки в `custom_room_package_map`, идемпотентно — повторный запуск после первой волны добавит только новое), `pm2 restart api`, `npm run check` (`scripts/check-custom-rooms.js` — без БД). Лог при старте: `[custom-rooms] ready`; без миграции — `[custom-rooms] DISABLED …`, витрина работает как раньше, админка отвечает `503 custom_rooms_not_migrated`.

Переменные: `CUSTOM_ROOMS_HOTEL_SEARCH_TYPE_CODES` (необязательно; коды `search_type` в ответе LT `hotel_rooms`, считающиеся поиском «отель», по умолчанию `2`; основной источник — параметр `search_type` при `/start-search`); `BOOKINGS_NOTIFY_EMAIL` (необязательно; адреса сотрудников через запятую — письмо «Новое бронирование Arlekino №…» после оплаты); `API_PUBLIC_URL` (уже используется письмами; из него строится ссылка на ваучер).

## 2. Как работает витрина (frontend без изменений)

| Маршрут | Что делает middleware |
|---|---|
| `GET /start-search` | запоминает `request_id → search_type` (`custom_room_searches`) |
| `GET /hotels-rooms` | при `search_type = hotel`: для активных Room Type отеля предложения источника (номер × выбранные операторы × питание) удаляются из исходного номера и вставляются как наша комната `ID: "totus-<id>"` с нашим контентом и ценой `rule(providerPrice)`; offer `id = "t<rt>-<n>-<hash>"`, `operator_name` сохранён, `lt_extras.totus = {custom, roomTypeId, sourceRoomId}`; `min_price`, `meal_types[].min_price`, `filters.meals[].min_price` пересчитаны. Пары `virtual → source offer` — `custom_room_offer_map` (3 ч). Нет источника в выдаче — нашей комнаты нет |
| `GET /packages/package_details?tour_id=t…` | `tour_id` → исходный; в ответе цены `package.price` и равные цене провайдера «ценовые» поля → наша цена; `package.id` → `custom_room_package_map` (24 ч) вместе со снимком ответа (`package_snapshot`), `hotel_id`, `meal`; `+ totus_room {roomTypeId, providerPrice, finalPrice}`. Устаревший id → `410 offer_expired` |
| `GET /packages/actualize` | по `package_id` из карты: свежая цена LT из ответа → пересчёт по актуальному правилу → цены переписаны; `totus_room.priceChanged {from,to}`, если провайдер изменил цену; снимок в карте обновляется |
| `POST /orders/prebuild`, `POST /packages/prebook`, `POST /packages/flights` | для пакета из карты **LT не вызывается**: middleware отвечает сам `200 { success:true, …снимок package_details, totus_room, totus_booking:{internal:true, operator} }`; нет снимка → `410 offer_expired` (см. раздел 6) |
| `POST /create-package` | для пакета из карты **LT `/orders/create` не вызывается**: заказ создаётся у нас (раздел 6). Для остальных пакетов — как раньше (прокси LT) |
| `POST /check_pay`, `POST /level_travel/notify-paid`, `POST /payment/status`, `GET /client/orders/:id`, `POST /client/orders/:id/sync` | только для внутренних заказов (`order_id > 900000000`) — middleware отвечает сам (раздел 6); остальные заказы идут в app.js как раньше |
| `POST /vtb/create-order`, `GET /orders/:id/payment` | сумма платежа помеченного заказа := Final Price |
| `GET /orders`, `/user/orders`, `/client/orders*` | цены помеченных заказов → наши, `+ totus_room`; у внутренних заказов `+ totus_booking`, `order_state` из бронирования |

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

`custom_room_types`, `custom_room_settings`, `custom_room_price_log` (история цен, ≤ 1 запись/комната/оператор/питание/час при неизменной цене), `custom_room_change_log`, `custom_room_offer_map` (3 ч), `custom_room_package_map` (24 ч; + `hotel_id`, `meal`, `package_snapshot`), `custom_room_searches` (6 ч), `custom_room_bookings`, `custom_room_booking_events`; `orders.custom_room_type_id, provider_price, final_price, price_rule`. Просроченные карты чистятся раз в час.

## 6. Бронирования без Level.Travel (оператор Arlekino)

Решение владельца: пользователь выбирает наш номер (Arlekino) → оплачивает → бронирование хранится **только у нас** → появляется в админке → сотрудник подтверждает или отклоняет. **Level.Travel не участвует нигде**: `orders/create`, `prebook`, `prebuild`, `orders/:id/notify` для таких заказов не вызываются (см. `middleware/customRooms.js`, `lib/customRooms/internalOrders.js`, `utils/vtbCallback.js`). Возврат денег — только вручную (API VTB на возврат не используется; сотрудник отмечает «возврат выполнен»). Ваучер/подтверждение клиенту отправляем мы от имени **Arlekino Tour** (`lib/customRooms/bookingEmails.js`). Автоотклонения по таймеру нет.

### 6.1. Витрина (frontend до оплаты не меняется, формат ответов — как у LT)

Виртуальное предложение `tour_id = t<rt>-<n>-<hash>` → `package_details` (LT вызывается — нужен состав пакета; цены → наши; ответ сохраняется в `custom_room_package_map.package_snapshot`) → `actualize` (как раньше). Дальше для `package_id` из карты:

- `POST /orders/prebuild`, `POST /packages/prebook`, `POST /packages/flights` → `200 { success:true, ...package_snapshot, totus_room, totus_booking:{ internal:true, operator:'Arlekino' } }`, без LT. Нет снимка → `410 { success:false, error:'offer_expired' }`.
- `POST /create-package` (Bearer user-JWT — `requireAuth(['user'])` как в app.js; email + телефон покупателя обязательны, иначе `400 { success:false, error:'Buyer email and phone are required' }`): создаётся `custom_room_bookings` (status `pending_payment`), `order_id = 900000000 + booking.id`, строка `orders` (`package` JSON в формате LT-заказа с нашими ценами, `lt_auth_token = NULL`, `custom_room_type_id/provider_price/final_price/price_rule`, `order_state`), событие `created`. Платёж: `payload.payUrl` → `savePaymentToPackage` + письмо «заказ создан»; иначе `createVtbPaymentForOrder({ amount: final, paymentMinutes: 30, sendEmail: true })` (ошибка платежа не ломает ответ — ссылку можно получить через `GET /orders/:id/payment?ensure=1`). Ответ в формате LT create: `{ success:true, order:{ id: 900000012, state:'pending_payment', full_price, price, remaining_amount, package, tourists, client, … }, totus_room, totus_booking, payment:{ payUrl, qrcId, amount } }` — frontend читает `order.id`.
- `POST /check_pay { qrcId | orderId }` для внутреннего заказа (по `orderId` или `qrcId → orders.transaction_code`): статус СБП проверяется у VTB (`lib/customRooms/vtbCheck.js` — та же логика, что `/check_pay` в app.js), `orders.pay_status/transaction_id/transaction_code` обновляются, **LT notify не вызывается**; ответ в том же формате `{ message, status, paid, qrcId, order_id, transaction_id, transaction_code, notify_status:null, notify_result:'skipped_internal', notify_data:null, notify_error:null, internal:true, totus_booking }`. Первая успешная оплата → `onPaid`.
- `POST /vtb/callback` (`utils/vtbCallback.js`): для внутренних заказов `lt_notify = { result:'skipped', reason:'internal_order' }`, вызывается `bookings.onPaid`; `sendOrderPaidPendingEmail` не отправляется (текст про «документы через 15 минут» не подходит). REFUND-callback → в бронировании `refund_status='done'`.
- `onPaid`: `payment_status='paid'`, `paid_at`, `paid_amount`, `status='pending_confirmation'`, `orders.order_state='pending_confirmation'`, событие `paid`; клиенту письмо «Оплата получена — проверяем бронирование» (Arlekino Tour) + push `order_status` «Проверяем бронирование»; сотрудникам письмо на `BOOKINGS_NOTIFY_EMAIL`.
- Просмотр: `GET /orders?order_id=900000012` и `GET /user/orders` — app.js отдаёт DB-снимок (нет `lt_auth_token`), middleware добавляет `totus_booking` и `order_state`. `GET /client/orders/:id` → `{ success:true, order:<package JSON заказа>, internal:true, totus_booking }`; `POST /client/orders/:id/sync` → `{ success:true, synced:false, internal:true, totus_booking }`. `GET /orders/:id/payment` — как раньше. `GET /orders/documents` — ваучер лежит в `order_documents` (`title='Ваучер'`, `event_reference='totus_voucher_<bookingId>'`).
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
  "providerPrice": 96500, "finalPrice": 86850, "priceRule": { "type": "percent", "value": -10, "label": "−10 %" }
}
```

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
