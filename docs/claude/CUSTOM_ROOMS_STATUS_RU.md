# Собственные Room Type — статус реализации

**Статус:** 15.09.2026 — v3: связь Room Type **по выбранному номеру LT** (не по предложению оператора) и **фиксированная цена Arlekino** — PR totus_API #7 и Totus_admin #6 (см. раздел «v2 логики» ниже). PR #6 и #5 смержены владельцем 15.09; на сервере ещё нужны две строки в `app.js`. 11.09 — v2: бронирование наших Room Type (оператор Arlekino) переведено на **внутренний заказ без Level.Travel** (решение владельца 10.09), добавлены раздел «Бронирования» в админке и клиентские статусы на сайте, в приложении и в desktop. Открыты 5 PR, ждут проверки, мержа и деплоя владельцем. План: `claude/CUSTOM_ROOMS_PLAN_RU.md` (v4, §11), дизайн: `claude/CUSTOM_ROOMS_DESIGN_RU.md` (v4, страницы «ROOMS · Bookings»).

## PR

| # | Репо | PR | Что внутри |
|---|---|---|---|
| 1 | totus_API → main | [#6](https://github.com/tosmedia/totus_API/pull/6) | Room Type (v1: `lib/customRooms/{pricing,store,inject,packageFlow}.js`, `middleware/customRooms.js`, `/api/admin/rooms/*`, миграция) **+ бронирования без LT**: `lib/customRooms/{bookings,internalOrders,vtbCheck,bookingEmails}.js`, `middleware/uploadVoucher.js`, таблицы `custom_room_bookings` / `custom_room_booking_events`, admin API `/api/admin/rooms/bookings/*`, правка `utils/vtbCallback.js`, `docs/CUSTOM_ROOMS_API.md` §6. `app.js` не тронут — две строки добавляет владелец |
| 2 | Totus_admin → main | [#5](https://github.com/Tosmedia/Totus_admin/pull/5) | Раздел «Отели и номера» (v1) **+ вкладка «Бронирования (N)»**: сводка, фильтры, таблица, карточка `/rooms/booking/[id]` (панель действий, таймлайн, «Заказ хранится только в Totus. В Level.Travel не отправляется»), модалы подтверждения (ваучер PDF, номер брони) и отклонения/отмены (причина, сообщение, возврат полностью/частично **вручную**, «возврат уже выполнен»), «Отметить возврат выполненным», «Отправить ваучер повторно» |
| 3 | totus_WEB → main | [#8](https://github.com/tosmedia/totus_WEB/pull/8) | `src/utils/totusBooking.ts`, `src/components/totusBooking/*`; экран «Оплата прошла» на `/pay`, статусы в «Моих заказах» и карточке заказа, ваучер в документах, «Туроператор: Arlekino», «Написать в поддержку», «Подобрать другой номер» |
| 4 | totus_APP → main | [#9](https://github.com/tosmedia/totus_APP/pull/9) | То же для iPhone/iPad: `src/utils/totusBooking.ts`, `component/orders/totusBooking/*`, `checkout/TotusBookingSuccess.tsx`, точечные правки `PendingPayment`, `OrderListItem`, `OrderDetails(+Sections)` |
| 5 | totus_desktop → main | [#3](https://github.com/tosmedia/totus_desktop/pull/3) | То же для desktop: `shared/utils/totusBooking.ts`, `renderer/components/totusBooking/*`, правки `PendingPaymentScreen`, `OrderListItem`, `OrderDetailsScreen(+Sections)`, vitest на хелпер |

Контракт клиентов: `docs/CUSTOM_ROOMS_API.md` в totus_API (§6 — бронирования, объект `totus_booking`).

## Как устроено

**Витрина и цена** — как в v1: Provider Price → правило → Final Price на каждом ответе LT; наша Room Type замещает предложения «номер × выбранные операторы» исходного номера LT в формате LT (`ID: totus-<id>`, offer `id: t<rt>-<n>-<hash>`).

**Бронирование (новое).** Клиентский flow до оплаты не менялся: `package_details` (LT вызывается — нужен состав пакета; цены → наши, снимок в карту) → `actualize` → `prebuild`/`prebook`/`flights` (**middleware отвечает сам снимком, LT не вызывается**) → `create-package` (**LT `/orders/create` не вызывается**: заказ `order_id = 900000000 + id` в `orders` + `custom_room_bookings`, статус `pending_payment`) → `/vtb/create-order` / `check_pay` (сумма = Final Price; **VTB проверяется нами, LT notify не отправляется**; `vtb/callback` для внутренних заказов тоже без LT) → оплачено → `pending_confirmation`, письмо клиенту от «Arlekino Tour» + push «Проверяем бронирование», письмо сотрудникам на `BOOKINGS_NOTIFY_EMAIL` → админка «Бронирования»: **Подтвердить** (номер брони, ваучер PDF → `order_documents`, письмо + push) / **Отклонить** (причина, сообщение, возврат — только вручную: `refund_status pending → done` кнопкой «Отметить возврат выполненным», письмо + push) / отменить подтверждённое. Автоотклонения по таймеру нет. Клиенты читают `totus_booking` из `/orders`, `/user/orders`, `/check_pay`: «Проверяем бронирование» / «Бронирование подтверждено» / «Бронирование отклонено» + возврат. Без «Totus»-оформления, оператор — «Arlekino».

## Что делает владелец

1. totus_API: две строки в `app.js` (`docs/CUSTOM_ROOMS_APP_JS_PATCH.md`), `.env`: `BOOKINGS_NOTIFY_EMAIL` (+ `API_PUBLIC_URL` для ссылок на ваучеры), `node scripts/run-custom-rooms-migration.js`, `pm2 restart api`, `npm run check` → лог `[custom-rooms] ready`.
2. Totus_admin: `npm run build`, деплой. totus_WEB: `next build`. totus_APP: сборка iOS (iPad — визуально). totus_desktop: `npm install && npm run typecheck && npm run test && npm run build`.
3. **Сквозной прогон:** админка → Room Type (−10 %) → сайт/приложение: выбрать номер Arlekino → оформление → оплата СБП → экран «Оплата прошла» → заказ `9000000xx` во вкладке «Бронирования (1)» → Подтвердить с PDF (письмо/push, ваучер в документах заказа) / Отклонить → «Возврат · В обработке» → «Отметить возврат выполненным». По логам убедиться, что для этого заказа нет вызовов `api.level.travel` (кроме `package_details`/`actualize`/`validate-tourists` до оформления).
4. Проверить на реальном JSON `package_details` поля снимка (даты, питание, гости — `extractBookingFields` в `bookings.js`) и `PRICE_KEYS`.
5. `hotel.id` в `totus_booking` должен быть id отеля каталога — от него зависит «Подобрать другой номер».

## Ограничения / замечания

- `/validate-tourists` (валидация туристов LT по `package_id`) по-прежнему уходит в LT — это проверка данных, заказ не создаёт; если нужно исключить и его — одна проверка в middleware.
- Возврат денег — только ручная отметка (без API VTB); ваучер — наш PDF из админки.
- В админке «Написать клиенту» не показывается (нет маршрута чата поддержки в Totus_admin — он в calling_v2); «Экспорт CSV» и фото отеля в карточке не реализованы.
- Сайт: `orderDisplay.ts` не менялся (статус переопределяется в компонентах-потребителях).
- Все проверки — только синтаксис (`node --check`, `tsc --noResolve`) и `scripts/check-custom-rooms.js` на фейковой БД; сборки — у владельца.

## v2 логики (15.09.2026) — связь по номеру, фиксированная цена

Решение владельца: Room Type привязывается к конкретному номеру Level.Travel; если этот номер появился в выдаче при любых датах/ночах/гостях и любом типе поиска — рядом показывается наше предложение как оператор «Arlekino» с ценой из админки (1 ₽ → 1 ₽); если предложений несколько — самое дешёвое. Предложения LT остаются как есть (замещение только если в Room Type явно указаны операторы).

| Репо | PR | Что внутри |
|---|---|---|
| totus_API → main | [#7](https://github.com/tosmedia/totus_API/pull/7) | `pricing_mode fixed|rule`, `fixed_price`, `fixed_price_unit total|per_night`, `operator_name/operator_id`; inject по `source_room_id` с шаблоном — самое дешёвое предложение номера; при fixed цена не пересчитывается в actualize; миграция (повторный запуск) переводит старые Room Type в `rule`, `package_types → []`, `hotelOnly → false`; исправлен баг v1: `max_price = NULL` ломал правило и комната не показывалась |
| Totus_admin → main | [#6](https://github.com/Tosmedia/Totus_admin/pull/6) | Мастер/редактор: номер LT обязателен, операторы/питание — необязательное «Ограничить», переключатель «Фиксированная цена Arlekino» ⟷ «Правило от цены LT», «за проживание / за ночь», название оператора, тип поиска любой/только отель; статус `fixed`, «1 ₽ (фикс.)» в карточках; наши Room Type под номером всегда |

Владельцу: `git pull` обоих репо → две строки в `app.js` (если ещё нет) → `node scripts/run-custom-rooms-migration.js` → `pm2 restart api` → `npm run build` админки → создать Room Type с ценой 1 ₽ без операторов → открыть отель на сайте с любыми датами: рядом с номером «Arlekino · 1 ₽». Ограничение: цена «от N ₽» в списке отелей (`/grouped-hotels`) наши предложения не учитывает — наличие номера известно только на странице отеля.

## Диагностика «Room Type не виден» (15.09.2026) — PR totus_API #8, Totus_admin #7

Сайт ищет номера так: `/start-search?search_type=package&hotel_ids=<id>…` → поллинг `/hotels-rooms?request_id&hotel_id` (строка); `/get-hotel-offers` не используется; клиентских фильтров, выкидывающих нашу комнату, нет. Найдено и исправлено: Room Type без сохранённой цены молча выпадал; сопоставление источника только по `room.id` (в пакетном поиске id отличаются) — добавлен fallback по названию номера; относительные URL фото; сбой записи `custom_room_offer_map` молча возвращал оригинал LT. Добавлено: `GET /api/admin/rooms/diagnostics` (готовность, отсутствующие таблицы/колонки, счётчики middleware, активные Room Type с `lastSkipReason/lastCheckedAt`), лог `[custom-rooms] hotel <id>: rt <id> — injected|skipped:<reason>`, карточка «Диагностика» в настройках админки. Самые вероятные причины у владельца: не запущена миграция v2 (модуль DISABLED), не перезапущен pm2, `hotelOnly=true` при поиске `package`.

## 15.09 (вечер) — живая проверка и «оба предложения рядом»

Проверка на проде через публичные эндпоинты: `/hotels-rooms` для Rixos Premium Seagate (9022465) уже отдаёт нашу комнату `totus-5` (Arlekino, 233 096 ₽ по правилу −10 % от Level.Travel 258 996) — inject работает; на сайте карточка отображалась второй, но выглядела копией карточки источника. Решение владельца: для одного Room Type показывать **оба** предложения — Arlekino и оригинал LT. Сделано: замещение предложений источника убрано (`removeReplacedOffers` не вызывается, `replaces_offer_ids` пусто) — PR totus_API [#9](https://github.com/tosmedia/totus_API/pull/9) (там же: код `search_type` hotel=1 по умолчанию, тест на реальном payload `scripts/fixtures/hotel_rooms_sample.json`); чип оператора «Arlekino» у карточки нашего номера на сайте — PR totus_WEB [#9](https://github.com/tosmedia/totus_WEB/pull/9). PR #8 (диагностика) и Totus_admin #7 смержены.

## v3 (16.09.2026) — один Room Type, две группы предложений; auth_token / forbidden / CORS

Решение владельца: наш Room Type не дублирует номер LT; в одной карточке номера две группы предложений — «Arlekino» (наши offers, наша цена) и «Level.Travel» (оригиналы, нетронуты); цена «от» — минимум по всем; выбор Arlekino-offer → наш flow, LT-offer → LT flow. Ключ соответствия — `custom_room_types.source_room_id` ↔ `room.id` LT; дедуп по названию убран.

| Репо | PR | Что внутри |
|---|---|---|
| totus_API | [#10](https://github.com/tosmedia/totus_API/pull/10) (ветка `claude/custom-rooms-fix`; #9 смержен) | `inject.js`: наши offers внутрь `offers[meal]` исходного номера первыми, `lt_extras.totus` на offer (`custom:true, roomTypeId, sourceOfferId, meal, mode, source:'arlekino'`) и на номере (`roomTypeId, customOffers, sourceRoomId`), пересчёт всех минимумов, `findSourceIndex` только по `room.id`, `isArlekinoOffer`; перехват `GET /orders?order_id=9000000xx` (из БД, без LT); `resolveAuthToken` без env-fallback для внутренних id; `docs/ORDERS_FLOW_PATCH.md` — 6 диффов для `app.js` (lt_auth_token/user_id в LT-ветке `/orders`, `requireAuth(['user','staff'])` на маршрутах заказов, `/client/orders/:id/sync` и `/client/orders` через `resolveAuthToken`, убрать `payload.auth_token`, лог ключей ответа `orders/create`) + `.env CORS_ORIGINS`; тесты `check-custom-rooms{,-live,-diag,-orders}.js`; `docs/CUSTOM_ROOMS_API.md` §2.2 |
| totus_WEB | [#10](https://github.com/tosmedia/totus_WEB/pull/10) | `src/utils/roomOffers.ts`; `priceList.tsx` — секции «Arlekino»/«Level.Travel»; чип оператора убран; фильтр «Туроператор»: один пункт «Arlekino» (990000), наши id не уходят в LT |
| totus_APP | [#10](https://github.com/tosmedia/totus_APP/pull/10) | То же: `roomOffers.ts`, `useRoomTransformers`, `AllOptionsModalContent` (две группы), `roomFilters.ts`, `useHotelRoomFilters.ts`, подпись с перелётом/без по `search_type` |
| totus_desktop | [#4](https://github.com/tosmedia/totus_desktop/pull/4) | То же + vitest `roomOffers.test.ts` |
| Totus_admin | [#8](https://github.com/Tosmedia/Totus_admin/pull/8) | `/lt-orders` — токен только своего заказа из `GET /orders`, без N×`/user/orders`; карточка заказа — для внутренних плашка «Бронирование Arlekino» + ссылка на бронирование; статусы `active`, тексты v3 |

Root cause «Для этого заказа не сохранён auth_token Level Travel» (сообщение из админки): `GET /orders` в LT-ветке не отдавал `lt_auth_token`; плюс токен может не приходить от LT в `orders/create` (недокументировано). `forbidden` — staff-JWT на маршрутах `requireAuth(['user'])` (log-режим, не блокирует до enforce). CORS — `CORS_ORIGINS` в `.env` заменяет список по умолчанию. Всё это — в `docs/ORDERS_FLOW_PATCH.md`.

Владельцу: применить патч `app.js` и `.env`, влить PR (backend первым), `pm2 restart api`, сборки фронтов; проверить на Rixos Premium Seagate (9022465): одна карточка «Улучшенный номер Aqua» «от 1 ₽», внутри Arlekino и Level.Travel, «Выбрать» у Arlekino → наш flow, у LT → LT; фильтр «Arlekino» одним пунктом; в админке `/orders/<LT id>` показывает данные LT, `/orders/9000000xx` — плашку Arlekino.

## «Наш отель»: продавать только Arlekino (16.09.2026)

Требование владельца: «если добавляю отель у нас в системе и указываю для него hotel type, при бронировании оффер Level.Travel не должен регистрироваться в нашей базе — только Arlekino». Уточнения оставлены на нас, поэтому сделан **явный флаг у Room Type, выключенный по умолчанию** (текущее поведение — обе группы предложений — не меняется, пока флаг не включён).

Проверено на проде: коллизии package_id нет — LT отдаёт новый `package.id` на каждый `package_details`, у нашего предложения `totus_room != null`, у LT — `null`; LT-заказ идёт обычным путём и в `custom_room_bookings` не попадает. То есть «LT регистрируется как наш» не происходило; требование реализовано как запрет продавать LT там, где отель наш.

| Репо | PR | Что внутри |
|---|---|---|
| totus_API | [#12](https://github.com/tosmedia/totus_API/pull/12) | `custom_room_types.exclusive` + `exclusive_scope ('room'\|'hotel')` (миграция идемпотентна); `applyExclusive` в `inject.js` — у отеля с активным флагом из выдачи убираются все предложения Level.Travel (в исходном номере или во всём отеле), наши остаются, минимумы пересчитываются, пустые номера выпадают; `afterForeignPackageDetails` → `410 offer_expired` при попытке открыть LT-предложение в таком отеле (защита от устаревшей страницы — LT-заказ не создастся); поля в admin API; `docs/CUSTOM_ROOMS_API.md` §2.3; `scripts/check-custom-rooms-exclusive.js` |
| Totus_admin | [#9](https://github.com/tosmedia/Totus_admin/pull/9) | Блок «Продажи» в мастере/редакторе Room Type (чекбокс + область «только этот номер / весь отель» + предупреждение), бейдж «Только наши», пометки во вкладке номеров отеля, `exclusiveColumns` в «Диагностике» |

Владельцу: влить #12 → `node scripts/run-custom-rooms-migration.js` → `pm2 restart api` → `npm run build` админки; проверить, что без флага всё как раньше, затем включить флаг на тестовом Room Type.

Также PR totus_API [#11](https://github.com/tosmedia/totus_API/pull/11) — короткий `warn` вместо дампа для `prebook` + замеры таймингов (prebook ~0.3 с на весь перебор версий; actualize 0.7–11.3 с — настоящее узкое место).
