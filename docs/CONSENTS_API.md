# Журнал согласий (consent_log)

Зачем: по 152-ФЗ (ст. 9, с 01.09.2025) согласие на обработку персональных данных — отдельный документ, его даёт активное действие пользователя (чекбокс, не отмеченный заранее), а оператор обязан доказать, что согласие получено. Согласие на рекламу (38-ФЗ ст. 18) — отдельное и необязательное. Журнал хранит, кто, когда, в какой форме, на какую редакцию документа и с какого IP дал согласие или отказался.

## Как клиент передаёт согласия

В тело уже существующих запросов добавляется поле `consents` — только галочки, без версий и адресов документов:

```json
{ "consents": { "pd": true, "ads": false } }
```

| Тип | Документ | Где обязателен |
|---|---|---|
| `pd` | /consent — согласие на обработку персональных данных | все формы |
| `ads` | /ads-consent — согласие на получение рекламы | нигде, только по желанию |
| `tour_offer` | /tour-offer — оферта о реализации туристского продукта | бронирование тура |
| `hotel_terms` | /hotel-booking — условия бронирования размещения | бронирование отеля без перелёта |

Адрес документа и его редакцию (`CONSENTS_DOC_VERSION`, по умолчанию `2026-10-01`) подставляет сервер.

## Какие запросы пишутся

`middleware/consentsRecorder.js` стоит сразу после `express.json()` и пишет журнал **после успешного ответа** формы. Сами обработчики форм не менялись.

| Запрос | Форма | Когда считается успехом |
|---|---|---|
| `POST /api/callback-requests` | `callback` | статус < 400 |
| `POST /api/auth/signup` | `signup` | в ответе есть `screen` |
| `POST /create-package` | `booking` | статус < 400, нет `error`, `success !== false` (Level.Travel отвечает 200 с `error`) |
| `POST /api/partner-requests` | `partner` | в ответе есть `id` (ловушка для ботов отвечает без него) |
| `POST /api/consents` | `account` | отдельный эндпоинт, см. ниже |

## POST /api/consents

Согласия вошедшего пользователя, переданные отдельным шагом (например, из личного кабинета). Форма всегда `account` — другое значение `form` сервер заменяет на `account`. Только с JWT пользователя (`requireAuth(['user'], { strict: true })`).

```http
POST /api/consents
Authorization: Bearer <access>
{ "form": "account", "consents": { "pd": true, "ads": false } }
```

Ответ `201 { ok: true, written: 2 }`; без согласий — `400 consents_required`; без токена — `401`.

## Режим наблюдения

Если обязательного согласия нет (например, старая версия приложения), запрос **не отклоняется**, в лог пишется:

```
[CONSENTS] missing form=callback types=pd source=app user=- ip=…
```

Источник: `web`, если есть заголовок `Origin`, иначе `app`. Когда приложения начнут присылать `consents`, по этим строкам видно, кто ещё не обновился.

## Таблица

Создаётся сама при первой записи; заранее — `npm run migrate:consents`.

Поля: `user_id`, `email`, `phone`, `consent_type`, `granted` (1/0), `doc_url`, `doc_version`, `form`, `ref_id` (номер заказа или заявки), `source`, `ip`, `user_agent`, `created_at`.

Посмотреть согласия пользователя:

```sql
SELECT created_at, form, consent_type, granted, doc_version, ip
FROM consent_log WHERE user_id = ? OR email = ? ORDER BY created_at DESC;
```

## Проверка

`node scripts/check-consents.js` — без БД и без npm install, входит в `npm run check`.
