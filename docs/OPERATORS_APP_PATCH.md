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
4. `npm run migrate:operators` — создаёт `custom_room_operators` и колонку
   `custom_room_types.operator_ref_id`, заводит операторов по именам, которые уже стоят у
   Room Type (обычно один — «Arlekino», `operator_id` 990000), и привязывает к ним строки.
   Скрипт идемпотентный: повторный запуск ничего не портит и привязки не трогает.
5. `pm2 restart api`.
6. Проверить: `GET /api/admin/operators` со staff-токеном отдаёт `available: true` и одного
   оператора со счётчиком Room Type.

## Откат

Снять строку из `app.js` и перезапустить: колонка `operator_ref_id` останется, но
`lib/customRooms/store.js` читает её мягко — витрина вернётся к прежнему поведению
(`operator_id = 990000 + id Room Type`) только если удалить саму таблицу
`custom_room_operators`. Пока таблица есть, оператор берётся из неё.
