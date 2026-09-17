# Патч app.js: монтирование /api/admin/operators

`app.js` через GitHub-коннектор не проходит по размеру, поэтому правка — одной строкой вручную.

## Что добавить

Рядом со строкой, которая монтирует «Отели и номера»:

```js
app.use('/api/admin/rooms', require('./routes/customRooms.routes'));
```

добавить следующей строкой:

```js
app.use('/api/admin/operators', require('./routes/operators.routes'));
```

Порядок значения не имеет, префиксы не пересекаются. Роутер сам вешает `requireStaff`
(staff-JWT strict), поэтому общий `app.use('/api/admin', requireAuth(['staff']))` выше
ничего не ломает — авторизация просто строже.

## Порядок раскатки

1. Смержить PR.
2. `git pull` на сервере.
3. Добавить строку выше в `app.js`.
4. `npm run migrate:operators` — создаёт `custom_room_operators`, заводит операторов по
   именам, которые уже стоят у Room Type (обычно один — «Arlekino», `operator_id` 990000),
   и проставляет строкам `custom_room_types.operator_id`. Новых колонок не добавляется.
   Скрипт идемпотентный: трогает только строки с пустым `operator_id`.
5. `pm2 restart api`.
6. Проверить: `GET /api/admin/operators` со staff-токеном отдаёт `available: true` и одного
   оператора со счётчиком Room Type.

## Откат

Снять строку из `app.js` и перезапустить — раздел «Операторы» перестанет отвечать, всё
остальное продолжит работать: справочник ни на что не влияет в рантайме, витрина берёт имя и
`operator_id` прямо из строки Room Type. Чтобы вернуть прежний вид фильтра «Туроператор»
(каждый Room Type — свой оператор), нужно очистить `custom_room_types.operator_id`:
`UPDATE custom_room_types SET operator_id = NULL;`
