# Подключение маршрутов Яндекс ID в app.js

PR новые файлы не монтирует — строку добавляет владелец (правило: `app.js` в PR не трогаем).

Рядом с существующей строкой `app.use('/api/auth', authRoutes);` добавить **выше** неё:

```js
app.use('/api/auth/yandex', require('./routes/yandexAuth.routes'));
```

Порядок с `/api/auth` не принципиален (в `auth.routes.js` нет путей `/yandex`), но выше — нагляднее.

Полная последовательность раскатки:

1. `git pull` на сервере.
2. `.env`: `YANDEX_OAUTH_CLIENT_ID`, `YANDEX_OAUTH_CLIENT_SECRET`, `YANDEX_OAUTH_REDIRECT_URI`,
   `YANDEX_AUTH_RETURN_WEB`, `YANDEX_AUTH_RETURN_APP`, `YANDEX_AUTH_RETURN_DESKTOP`.
3. `npm run migrate:yandex-auth`
4. Строка из этого файла в `app.js`.
5. `pm2 restart api`
6. Проверка: `curl -i "https://api.totus.club/api/auth/yandex/start?client=web&return=/"` —
   ожидаем `302` на `oauth.yandex.ru/authorize` (а не `503 yandex_auth_not_configured`).

Пока шаг 4 не сделан, ничего не меняется: остальной вход работает как раньше.
