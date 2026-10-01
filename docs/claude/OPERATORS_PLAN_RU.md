# Операторы — справочник в админке

**Статус:** 17.09.2026 — backend и админка сделаны, PR открыты и ждут мержа.
totus_API [#15](https://github.com/tosmedia/totus_API/pull/15), Totus_admin [#10](https://github.com/tosmedia/Totus_admin/pull/10).
Макеты утверждены. Осталось: WEB / APP / desktop (снятие порога 990000).

## Зачем

Оператор «Arlekino» не существовал как сущность. Это были две денормализованные колонки в
`custom_room_types` (`operator_name VARCHAR(128) DEFAULT 'Arlekino'`, `operator_id INT NULL`),
скопированные в каждый Room Type, плюс фоллбэки `'Arlekino'` в коде и захардкоженное
«Arlekino Tour» в шаблонах писем (`lib/customRooms/bookingEmails.js`).

`operator_id` при этом вычислялся как `990000 + roomTypeId`, то есть **каждый Room Type
формально был отдельным оператором**. На витрине это схлопывается костылём «id ≥ 990000 →
считать одним оператором» в `roomFilters.ts` (WEB и APP).

## Решения владельца (17.09.2026)

1. **operator_id** — авто из пула 990000+, с возможностью ручной правки (только ≥ 990000,
   только уникальный). Так наши операторы гарантированно не пересекаются с операторами
   Level.Travel (у них id маленькие, например 78).
2. **Миграция** — все существующие Room Type переводятся на одного оператора «Arlekino»
   с одним стабильным `operator_id`.
3. **Поля первой итерации** — название, `operator_id`, вкл/выкл, порядок + почта бронирований
   (имя отправителя писем, адреса уведомлений). Без логотипа, бейджа и типов поиска.
4. **Порядок работ** — сначала макеты в Figma, потом код.

## Схема БД

Новая таблица `custom_room_operators`:

| колонка | тип | смысл |
|---|---|---|
| `id` | INT AI PK | внутренний id записи справочника |
| `operator_id` | INT NOT NULL UNIQUE | id на витрине, ≥ 990000 |
| `name` | VARCHAR(128) NOT NULL | название на витрине |
| `active` | TINYINT(1) DEFAULT 1 | вкл/выкл |
| `sort_order` | INT DEFAULT 0 | порядок в списках админки |
| `email_from_name` | VARCHAR(128) NULL | имя отправителя писем (сейчас «Arlekino Tour») |
| `notify_emails` | VARCHAR(512) NULL | адреса уведомлений о бронях (сейчас `BOOKINGS_NOTIFY_EMAIL`) |
| `created_by`, `created_at`, `updated_at` | | аудит |

**Связь с Room Type — по уже существующей колонке `custom_room_types.operator_id`.**
Туда пишется `operator_id` оператора из справочника, в `operator_name` — его имя. Новых колонок
нет; `store.js`, `inject.js` и `customRooms.controller.js` не менялись вовсе — витрина показывает
то, что записано в строке Room Type.

Первоначально планировалась отдельная колонка `operator_ref_id` с подстановкой имени при
сериализации. От неё отказались: она потребовала бы править `store.js` (35 КБ) и контроллер
(40 КБ) ради того же результата. Цена решения — при переименовании оператора нужно обновить
его Room Type, это делает `PUT /api/admin/operators/:id` одним `UPDATE` и возвращает
`roomTypesUpdated`.

**Миграция** `scripts/run-operators-migration.js` (идемпотентная): создаёт таблицу, заводит
операторов по именам, которые уже стоят у Room Type (обычно один — «Arlekino»), и проставляет
строкам `operator_id`. Первому оператору достаётся `990000` — именно это значение сейчас
показывают WEB и APP, схлопывая наши синтетические id, поэтому **витрина после миграции
не меняется**. Трогает только строки с пустым `operator_id`.

**Мягкая зависимость:** пока миграция не прогнана, таблицы нет — `GET /api/admin/operators`
отвечает `{ operators: [], available: false }` со статусом 200, мутации 503, а модуль custom
rooms работает ровно как раньше. Ничего не выключается (в отличие от обязательных колонок в
`store.js`, где отсутствие колонки гасит весь модуль).

## API (totus_API)

`routes/operators.routes.js` → `/api/admin/operators`, весь роутер за `requireStaff`
(staff-JWT strict), как «Отели и номера».

| метод | путь | назначение |
|---|---|---|
| GET | `/api/admin/operators` | список + `suggestedOperatorId` + `available` |
| POST | `/api/admin/operators` | создать (`operatorId` опционален → авто) |
| GET | `/api/admin/operators/:id` | карточка + счётчики Room Type |
| PUT | `/api/admin/operators/:id` | изменить + перенести имя в Room Type (`roomTypesUpdated`) |
| POST | `/api/admin/operators/:id/toggle` | вкл/выкл |
| POST | `/api/admin/operators/:id/duplicate` | копия с новым `operator_id`, выключенная |
| DELETE | `/api/admin/operators/:id` | удалить; 409 `operator_in_use`, если есть Room Type |

Подробности и коды ошибок — `docs/OPERATORS_API.md` в totus_API.

Публичного эндпоинта не добавляли. Для фронтов признак «наш оператор» возьмём из самих офферов
(`lt_extras.totus`), а не из порога 990000.

## Что сделано

**totus_API (PR #15)** — только новые файлы, существующие не тронуты:
`lib/customRooms/operators.js`, `controllers/operators.controller.js`,
`routes/operators.routes.js`, `scripts/run-operators-migration.js`,
`scripts/check-operators.js` (в `npm run check`), `docs/OPERATORS_API.md`,
`docs/OPERATORS_APP_PATCH.md`, `package.json` (`npm run migrate:operators`).

**Totus_admin (PR #10)**:
`lib/operators-api.ts`, `app/operators/page.tsx`, `app/operators/[id]/page.tsx`,
`components/operators/{OperatorsTab,OperatorForm,OperatorEditor}.tsx`, пункт меню в
`AdminNav.tsx`; в `components/rooms/RuleForm.tsx` поле «Название оператора» заменено выпадающим
списком из справочника, `RuleFormState` получил `operatorId`; в `RoomTypeWizard.tsx` и
`RoomTypeEditor.tsx` добавлено `operatorId: body.operatorId` в тело запроса.

## Что осталось

**Фронты (отдельный PR после раскатки):**
- `roomFilters.ts` (WEB, APP) — вместо порога `operator_id ≥ 990000` признак «наш оператор»
  берётся из самих офферов (`lt_extras.totus`). Главное — `buildHotelRoomsQueryParams`:
  наш `operator_id` нельзя отправлять в Level.Travel.
- `roomOffers.ts` (WEB, APP) — `OFFER_GROUP_LABELS` и `ARLEKINO_OPERATOR_ID_BASE` больше не нужны
  для отображения.
- `totusBooking.ts` (WEB, APP) — `TOTUS_DEFAULT_OPERATOR` остаётся только крайним фоллбэком.
- **totus_desktop** — Room Type v3 туда не портирован, но `shared/utils/hotelUtils/roomFilters.ts`
  отстал от v3 и отправит наш `operator_id` в Level.Travel. Синхронизировать в том же заходе.

**Почта бронирований:** поля `email_from_name` и `notify_emails` хранятся и редактируются, но
`lib/customRooms/bookingEmails.js` пока берёт подпись из константы `SIGNATURE = 'Arlekino Tour'`
и адреса из `BOOKINGS_NOTIFY_EMAIL`. Подключение — отдельным PR.

## Раскатка (за владельцем)

1. Смержить totus_API #15, `git pull` на сервере.
2. Добавить строку в `app.js` — `docs/OPERATORS_APP_PATCH.md`:
   `app.use('/api/admin/operators', require('./routes/operators.routes'));`
3. `npm run migrate:operators`
4. `pm2 restart api`
5. Смержить Totus_admin #10 и собрать админку.

## Макеты (Figma)

Файл `u6A5og35jw0BBJyOkKl8Ij`, страницы **OPERATORS · Admin · Light** `2156:105678` и
**OPERATORS · Admin · Dark** `2156:105679`.

| Экран | Light | Dark |
|---|---|---|
| Операторы — список | `2156:105680` | `2162:105678` |
| Оператор — создание (модал) | `2158:105678` | `2162:105803` |
| Оператор — редактирование | `2159:105678` | `2162:105973` |
| Оператор — Duplicate (модал) | `2160:105678` | `2162:106097` |
| Room Type — поле «Оператор» (фрагмент) | `2161:105678` | `2162:106262` |

Упрощения: раздел собран из существующих компонентов админки (таблица как в «Наши Room Type»,
модалки и тумблеры — из `shared.tsx`), новых визуальных примитивов не вводилось; данные в
таблице и статистика — примеры.
