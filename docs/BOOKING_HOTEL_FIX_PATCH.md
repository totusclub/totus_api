# Патч `app.js` — отказ Level.Travel на `/orders/create` не должен быть «успехом» (16.09.2026)

`app.js` (60 КБ) через GitHub-коннектор не проходит — владелец применяет диффы ниже **вручную** (IDE/сервер). Правка точечная; после применения: `node --check app.js && npm run check`, затем `pm2 restart api`.

## Что произошло

При бронировании отеля (`search_type=hotel`) на сайте после валидации туристов всегда происходил редирект на `https://totus.club/checkout?order_id=900000003` — на уже существующую внутреннюю бронь Arlekino, а в Level.Travel заказ не создавался.

Цепочка (установлена 16.09.2026):

1. **Level.Travel.** `GET /packages/actualize?package_id=406801946&search_type=hotel` отвечает `200` с телом:

   ```json
   { "success": false, "rotten": true, "exception": "internal_server_error",
     "package": { "id": 406801946, "available": false, "…": "…" } }
   ```

   Объект `package` присутствует и в теле отказа. Проверено: воспроизводится стабильно для этого пакета (отель 9017691, `supplier_id: "11"`), тогда как пакет, созданный за 25 минут до этого, актуализируется нормально — то есть это не общий тайм-аут, а конкретное предложение.

2. **Фронт (`totus_WEB`).** Загрузка страницы бронирования проверяла только наличие `package`, поэтому мёртвое предложение открывалось как живое. Исправлено в `totus_WEB`, ветка `claude/booking-offer-guard`.

3. **`app.js` (этот патч).** `POST /create-package` при отказе LT отдаёт `200` с телом `{ error: ... }` — без `success: false` и **без единой строки в логе**. Фронт не считал это ошибкой, номер заказа из ответа не извлекался и подставлялся из `pickLatestOrderId` (в таблице `orders` нет `created_at`, поэтому сортировка всегда падает на тай-брейк по `order_id` по убыванию, а внутренние номера `9000000xx` больше любого номера LT).

Следствие: пользователь попадал на страницу оплаты чужого существующего заказа и мог оплатить его повторно. Стоит проверить брони `9000000xx` на лишние платежи.

## Диф

Поведение ответа **не меняется** — добавляются только две строки логов: на случай отказа LT (`catch`) и на случай `200` с `success: false` (сейчас оба случая молчат).

**Строки ≈ 813–819** (конец обработчика `app.post('/create-package', …)`):

```js
// было
        res.json(response.data);
    } catch (error) {
        res.json({error:error.response?.data || error.message});

    }
});
```

```js
// стало
        if (!response.data?.success) {
            console.error('[LT create] rejected:', JSON.stringify({
                package_id: req.body?.package_id ?? null,
                flight_pair_id: req.body?.flight_pair_id ?? null,
                lt: response.data,
            }));
        }

        res.json(response.data);
    } catch (error) {
        console.error('[LT create] failed:', JSON.stringify({
            status: error.response?.status ?? null,
            package_id: req.body?.package_id ?? null,
            flight_pair_id: req.body?.flight_pair_id ?? null,
            lt: error.response?.data || error.message,
        }));
        res.json({error:error.response?.data || error.message});

    }
});
```

Блок `if (!response.data?.success)` вставляется **перед** `res.json(response.data);`, второй `console.error` — первой строкой в `catch`.

**Персональные данные в лог не попадают:** ни туристы, ни `client`, ни email/телефон покупателя — только `package_id`, `flight_pair_id`, HTTP-статус и текст ошибки от Level.Travel.

## Проверка после патча

1. `node --check app.js && npm run check`.
2. Одно тестовое бронирование отеля → `pm2 logs api --lines 200 | grep "LT create"`.
3. В логе должна появиться строка `[LT create] failed: {…}` или `[LT create] rejected: {…}` с ответом Level.Travel — по ней станет понятна причина отказа на отельных пакетах.
4. Бронирование тура и бронирование Arlekino Room Type — без изменений (в успешном сценарии новых строк в логе нет).

## Что остаётся открытым

Причина самого отказа Level.Travel на отельных пакетах. Что уже проверено живыми запросами и **исключено**:

- payload устраивает LT: `POST /orders/prebuild` с телом ровно той формы, которую собирает `/create-package` (включая `client.id: 3003047`, `source: "desktop"`, `comment`, без ключа `flight_pair_id`), отвечает `order_valid: true`;
- `POST /validate-tourists` для отельного пакета — `valid: true`;
- `client.id: 3003047` — корректный ID партнёра в Level.Travel, менять не нужно (подтверждено владельцем).

Остающиеся кандидаты:

- предложение уже протухло (`rotten: true`) к моменту создания заказа — тогда отказ ожидаем, и правильное поведение теперь обеспечивает фронт;
- `/create-package` — единственное место, где в Level.Travel уходит дополнительный заголовок `Cookie: uuid=<LT_SESSION_UUID>` (строка ≈ 602); все остальные вызовы идут через `getLtHeaders('3.7')` без него;
- для отельных пакетов не вызывается `POST /packages/prebook`, хотя `actualize` возвращает в `misc_data` поля `book_hash`, `acm_component_id`, `supplier_id` — ровно то, что LT ждёт в `prebook_data`.

Выбирать между ними нужно по строке лога из п. 3.
