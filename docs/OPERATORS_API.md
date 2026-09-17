# Операторы — API админки

`/api/admin/operators/*`, staff-JWT strict (`requireStaff`, `middleware/authJwt.js`), как «Отели и номера».
Данные — таблица `custom_room_operators`, слой доступа `lib/customRooms/operators.js`.
План и решения — `claude/OPERATORS_PLAN_RU.md`.

## Зачем

До появления справочника оператор существовал только как две денормализованные колонки в
`custom_room_types` (`operator_name`, `operator_id`) плюс фоллбэк `'Arlekino'` в коде, а
`operator_id` вычислялся как `990000 + id Room Type` — то есть каждый Room Type формально был
отдельным оператором, и фильтр «Туроператор» на витрине схлопывал их костылём «id ≥ 990000».

Теперь оператор — отдельная запись. Room Type ссылается на неё колонкой
`custom_room_types.operator_ref_id`; имя и `operator_id` для витрины берутся из справочника,
а старые колонки остаются снимком (их пишет backend, руками менять не нужно).

## Таблица `custom_room_operators`

| колонка | тип | смысл |
|---|---|---|
| `id` | INT AI PK | внутренний id, на него ссылается `custom_room_types.operator_ref_id` |
| `operator_id` | INT NOT NULL UNIQUE | id на витрине, только ≥ 990000 |
| `name` | VARCHAR(128) NOT NULL | название на витрине |
| `active` | TINYINT(1) DEFAULT 1 | выключенный не показывается |
| `sort_order` | INT DEFAULT 0 | порядок в списках админки |
| `email_from_name` | VARCHAR(128) NULL | имя отправителя писем по броням |
| `notify_emails` | VARCHAR(512) NULL | адреса уведомлений о новых бронях, через запятую |
| `created_by`, `created_at`, `updated_at` | | аудит |

`operator_id` берётся из пула **990000 и выше**: у операторов Level.Travel id маленькие
(например 78), пересечься нельзя. Значение выдаётся автоматически (следующее свободное) и
может быть задано вручную — но только из этого диапазона и только уникальное.

## Мягкая зависимость

Пока `scripts/run-operators-migration.js` не прогнан, таблицы нет:
`operators.isAvailable()` возвращает `false`, `GET /api/admin/operators` отвечает
`{ operators: [], available: false }` со статусом 200, а весь модуль custom rooms работает
ровно как раньше — имя из `custom_room_types.operator_name`, `operator_id = 990000 + id`.
Ничего не выключается (в отличие от обязательных колонок в `lib/customRooms/store.js`).

## Эндпоинты

| метод | путь | тело / ответ |
|---|---|---|
| GET | `/api/admin/operators` | `{ operators, available, suggestedOperatorId, operatorIdBase }` |
| POST | `/api/admin/operators` | `{ name, operatorId?, sortOrder?, active?, emailFromName?, notifyEmails? }` → `{ ok, operator }` |
| GET | `/api/admin/operators/:id` | `{ operator }` |
| PUT | `/api/admin/operators/:id` | те же поля, все необязательные → `{ ok, operator }` |
| POST | `/api/admin/operators/:id/toggle` | `{ active? }` (без тела — переключает) → `{ ok, operator }` |
| POST | `/api/admin/operators/:id/duplicate` | `{ name?, operatorId?, copyEmails?, active? }` → `{ ok, operator }` |
| DELETE | `/api/admin/operators/:id` | `{ ok }` |

`GET` отдаёт `roomTypesCount` и `activeRoomTypesCount` по каждому оператору.

`duplicate` создаёт копию с новым `operator_id`; Room Type исходного оператора **не копируются** —
копия создаётся пустой. По умолчанию копия выключена (`active: false`) и настройки почты
копируются (`copyEmails: true`).

`DELETE` запрещён, пока на оператора ссылается хотя бы один Room Type.

## Коды ошибок

| код | статус | когда |
|---|---|---|
| `operators_not_migrated` | 503 | миграция не прогнана (только для мутаций) |
| `not_found` | 404 | оператора нет |
| `operator_name_required` | 400 | пустое название |
| `operator_id_invalid` | 400 | не целое или меньше 990000 |
| `operator_id_taken` | 409 | такой `operator_id` уже занят |
| `operator_sort_order_invalid` | 400 | порядок не целый или отрицательный |
| `operator_emails_invalid` | 400 | адреса уведомлений не похожи на e-mail или длиннее 512 символов |
| `operator_in_use` | 409 | на оператора ссылаются Room Type (в ответе `roomTypesCount`) |

## Room Type

`POST/PUT /api/admin/rooms/room-types` принимают `operatorRefId`:

- число — привязать Room Type к оператору; `operatorName` и `operatorId` перезаписываются
  снимком из справочника, что бы ни прислала админка;
- `null` — отвязать (вернуться к свободной строке `operatorName`);
- поле не передано при создании — берётся первый активный оператор по порядку;
- поле не передано при редактировании — привязка сохраняется;
- несуществующий id — `operator_ref_invalid` (400).

В ответе Room Type добавились `operatorRefId`, `operatorRefName`, `operatorRefActive`.
Смена оператора попадает в историю правок (`operatorRefId` в change-log).

## Проверки

`node scripts/check-operators.js` (или `npm run check`) — без БД и сети: валидация оператора,
подстановка оператора в Room Type, привязка в админской валидации и то, что без миграции
поведение прежнее.
