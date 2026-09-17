# Операторы — API админки

`/api/admin/operators/*`, staff-JWT strict (`requireStaff`, `middleware/authJwt.js`), как «Отели и номера».
Данные — таблица `custom_room_operators`, слой доступа `lib/customRooms/operators.js`.
План и решения — `claude/OPERATORS_PLAN_RU.md`.

## Зачем

До появления справочника оператор существовал только как две денормализованные колонки в
`custom_room_types` (`operator_name`, `operator_id`) плюс фоллбэк `'Arlekino'` в коде, а
`operator_id` вычислялся как `990000 + id Room Type` — то есть каждый Room Type формально был
отдельным оператором, и фильтр «Туроператор» на витрине схлопывал их костылём «id ≥ 990000».

Теперь оператор — отдельная запись. Связь с Room Type идёт по **уже существующей** колонке
`custom_room_types.operator_id`: там лежит `operator_id` оператора из справочника, а
`custom_room_types.operator_name` — его имя. Новых колонок нет, `store.js` и `inject.js` не
менялись — витрина и так показывает то, что записано в строке Room Type.

Чтобы имя не разъезжалось со справочником, `PUT /api/admin/operators/:id` переписывает имя
(и `operator_id`, если его поменяли) во всех Room Type этого оператора. Переименование в
админке сразу меняет подпись предложения на витрине; в ответе приходит `roomTypesUpdated`.

## Таблица `custom_room_operators`

| колонка | тип | смысл |
|---|---|---|
| `id` | INT AI PK | внутренний id записи справочника |
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
ровно как раньше — имя из `custom_room_types.operator_name`, `operator_id` пустой и витрине
отдаётся вычисляемый `990000 + id Room Type`. Ничего не выключается.

## Эндпоинты

| метод | путь | тело / ответ |
|---|---|---|
| GET | `/api/admin/operators` | `{ operators, available, suggestedOperatorId, operatorIdBase }` |
| POST | `/api/admin/operators` | `{ name, operatorId?, sortOrder?, active?, emailFromName?, notifyEmails? }` → `{ ok, operator }` |
| GET | `/api/admin/operators/:id` | `{ operator }` |
| PUT | `/api/admin/operators/:id` | те же поля, все необязательные → `{ ok, operator, roomTypesUpdated }` |
| POST | `/api/admin/operators/:id/toggle` | `{ active? }` (без тела — переключает) → `{ ok, operator }` |
| POST | `/api/admin/operators/:id/duplicate` | `{ name?, operatorId?, copyEmails?, active? }` → `{ ok, operator }` |
| DELETE | `/api/admin/operators/:id` | `{ ok }` |

`GET` отдаёт `roomTypesCount` и `activeRoomTypesCount` по каждому оператору.

`duplicate` создаёт копию с новым `operator_id`; Room Type исходного оператора **не копируются** —
копия создаётся пустой. По умолчанию копия выключена (`active: false`) и настройки почты
копируются (`copyEmails: true`).

`DELETE` запрещён, пока за оператором закреплён хотя бы один Room Type
(`custom_room_types.operator_id = <operator_id>`).

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
| `operator_in_use` | 409 | за оператором закреплены Room Type (в ответе `roomTypesCount`) |

## Room Type

Ничего нового в контракте `/api/admin/rooms/room-types` не появилось: оператор выбирается
теми же полями, что и раньше —

- `operatorId` — `operator_id` выбранного оператора (990000+);
- `operatorName` — его название.

Админка берёт обе величины из справочника (выпадающий список), поэтому строка Room Type
всегда содержит корректный снимок. Смена оператора попадает в историю правок как
`operatorId` / `operatorName` — это уже поддержано.

Room Type, у которого `operatorId` пуст, остаётся на прежнем поведении: витрине отдаётся
`990000 + id Room Type`, то есть такой Room Type выглядит отдельным оператором.

## Проверки

`node scripts/check-operators.js` (или `npm run check`) — без БД и сети: валидация оператора,
связь с Room Type по `operator_id`, перенос имени в Room Type при переименовании и то, что
без миграции справочник просто пуст.
