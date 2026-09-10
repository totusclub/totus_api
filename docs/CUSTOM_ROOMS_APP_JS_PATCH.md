# Патч app.js для наших Room Type (две строки)

`app.js` не проходит через GitHub-коннектор (60 КБ) — применить вручную на сервере или в IDE.

1. После строки `app.use(express.json());` (≈ строка 38) добавить:

```js
// Наши Room Type (docs/CUSTOM_ROOMS_API.md): подмена предложений LT и цен — до прокси-маршрутов
app.use(require('./middleware/customRooms'));
```

2. Рядом с блоком `app.use('/api/admin', …)` (≈ строки 1599–1618) добавить:

```js
app.use('/api/admin/rooms', require('./routes/customRooms.routes'));
```

Проверка: `node --check app.js && npm run check`, затем `node scripts/run-custom-rooms-migration.js && pm2 restart api`.
