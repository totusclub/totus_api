# Переход AUTH_MODE в enforce

По пункту К2 из `SECURITY_AUDIT_2026-09_RU.md`.

## Где мы сейчас

`lib/auth.js` умеет два режима:

- **`log`** (значение по умолчанию) — запрос без валидного токена пропускается,
  в лог пишется строка `[AUTH]`. Проверка владельца тоже не срабатывает:
  `resolveOwnerId` возвращает запрошенный чужой id, `assertOrderOwner` — `true`.
- **`enforce`** — 401/403 как положено.

Значит, весь нестрогий слой авторизации сейчас ничего не защищает. Исключение —
маршруты с `{strict: true}` (`/api/auth/me`, телефон, order-requests, rooms,
operators): там проверка работает всегда.

Третья настройка — `AUTH_LOG_ONLY_PATHS`: CSV префиксов путей, которые остаются в
режиме наблюдения даже при `enforce`. Именно она позволяет включать защиту
постепенно, а не одним рубильником.

## Шаг 0. Посмотреть, что реально ходит без токена

```bash
cd /путь/к/totus_API
pm2 logs totus-api --lines 200000 --nostream | node scripts/analyze-auth-log.js
```

Скрипт сведёт строки `[AUTH]` по маршрутам и причинам, покажет, кто ходит
(браузер, приложение, скрипт), и напечатает заготовку `AUTH_LOG_ONLY_PATHS`.
Ничего не меняет и никуда не отправляет.

Что смотреть в выводе: если у маршрута среди источников только «скрипт/бот» и
незнакомые origin — это чужой трафик, закрываем смело. Если браузер или
мобильное приложение — сначала чиним клиента.

## Шаг 1. Что починить в клиентах до включения

По разбору кода всех четырёх клиентов нашлось четыре места, которые сломаются.
Отсортированы по тому, насколько заметно это будет человеку.

| # | Где | Что произойдёт | Что делать |
| --- | --- | --- | --- |
| 1 | `totus_WEB`: `src/lib/cmsPage.ts`, `src/hooks/useCmsPage.ts`, `src/components/staticInfoPage/CmsStaticPage.tsx` | Сайт при неудаче публичного `/api/pages/slug/:slug` падает на `/api/admin/pages/slug/:slug` и `/api/admin/pages` голым fetch без токена. После enforce такие страницы (оферта, политика, помощь) покажут «Контент пока не опубликован» | Убрать fallback на admin-маршруты; недостающие страницы отдавать публичным роутером. Заодно закроется утечка списка всех страниц |
| 2 | `Totus_admin`: `components/AuthGuard.tsx` | `installStaffFetch()` вызывается в `useEffect` родителя, а эффекты дочерних страниц React выполняет раньше — первый запрос после жёсткой перезагрузки уходит без заголовка. Сейчас это незаметно, после enforce — пустые таблицы в любом разделе | Вызывать `installStaffFetch()` на уровне модуля или в layout до рендера дерева |
| 3 | `totus_APP`: `src/modules/store/actions/notification.ts` | `POST /notification-tokens` берёт токен из redux. При раннем старте (фоновый запуск по пушу или звонку) redux-persist ещё не регидратирован — запрос уйдёт анонимным. После enforce устройство молча не зарегистрируется и пуши перестанут приходить | Читать токен из AsyncStorage, как уже сделано в `src/modules/api/voipAuth.ts` (`readPersistedToken`). До релиза — держать `/notification-tokens` в `AUTH_LOG_ONLY_PATHS` |
| 4 | `totus_WEB`: `src/api/YandexAuthApi.ts` | `GET /api/auth/yandex/status` идёт отдельным axios без интерсепторов, то есть без токена | **Не блокер**: `isYandexAuthEnabled()` считает раздел включённым при 200/401/403, так что 401 кнопку не уберёт. Просто иметь в виду |

## Шаг 2. Что можно закрывать сразу

Здесь все клиенты, которые ходят на эти маршруты, уже шлют Bearer:

- `GET /user/orders`, `GET /orders`, `GET /orders/documents` — сайт, приложение,
  десктоп и админка. **Важно:** админка запрашивает чужие `user_id`/`order_id`,
  так что staff-роль обязана проходить проверку владельца (в `resolveOwnerId` и
  `assertOrderOwner` это уже учтено) — иначе раздел «Заказы» ляжет целиком.
- `POST /vtb/create-order`, `POST /check_pay` — все три клиента с токеном.
- `GET /api/auth/me`, `PATCH /api/auth/me/phone` — уже strict.
- `POST /api/order-requests`, `GET /api/order-requests` — сайт ставит заголовок явно.
- Весь `/api/admin/*`, кроме `GET /api/admin/pages` и `GET /api/admin/pages/slug/:slug`
  (см. пункт 1 выше) — только админка.
- `GET /client/orders`, `GET /client/orders/:id` — только админка. Отдельно:
  `auth_token` Level.Travel уезжает туда в query string и оседает в логах nginx —
  стоит перенести в заголовок отдельной задачей.

## Шаг 3. Что остаётся публичным навсегда

Эти маршруты не должны требовать токена ни при каком режиме:

- **Поиск и справочники:** `/start-search`, `/search-status`, `/grouped-hotels`,
  `/get-hotel-offers`, `/hotels-rooms`, `/references/*`, `/home/data`,
  `/packages/package_details`, `/packages/actualize`, `POST /packages/flights`.
  Гость обязан видеть выдачу без входа.
- **Контент сайта:** `/api/pages/slug/:slug`, `/api/faq`, `/api/footer-social`,
  `/api/home-banners`, `/api/home-hero`, `/api/home-partners`.
- **Вход и регистрация:** `/api/auth/signin`, `/signup`, `/verify`,
  `/api/auth/refresh`, `/customer-auth/refresh-token`, `/api/auth/yandex/*`,
  `/api/admin/auth/sign-in`, `/api/admin/auth/refresh`.
- **Обратный звонок:** `POST /api/callback-requests`.
- **Платёжные callback'и и webhook'и LT** — у них своя проверка (или должна
  быть — см. К3 в аудите), JWT там неприменим.

## Шаг 4. Включение

```bash
# в .env сервера
AUTH_MODE=enforce
AUTH_LOG_ONLY_PATHS=/api/admin/pages,/notification-tokens
```

Список выше — минимальный набор по итогам разбора кода; сверьте его с тем,
что показал анализатор на реальных логах. По мере починки клиентов вычёркивайте
пути из `AUTH_LOG_ONLY_PATHS`, пока переменная не опустеет.

После `pm2 restart totus-api --update-env`:

```bash
# без токена — ждём 401
curl -s -o /dev/null -w "%{http_code}\n" "https://api.totus.club/api/admin/auth/users"
curl -s -o /dev/null -w "%{http_code}\n" "https://api.totus.club/user/orders?user_id=1"

# публичное — ждём 200
curl -s -o /dev/null -w "%{http_code}\n" "https://api.totus.club/home/data"
curl -s -o /dev/null -w "%{http_code}\n" "https://api.totus.club/api/faq"
```

В интерфейсе пройти сценарии: поиск тура гостем → вход → список заказов →
карточка заказа → документы → оплата; в админке — жёсткая перезагрузка
каждого раздела (именно она ловит проблему № 2).

**Откат:** `AUTH_MODE=log` и `pm2 restart totus-api --update-env` — всё возвращается
к прежнему поведению без выкатки кода.

## Шаг 5. Ротация JWT_SECRET — отдельно

Секрет лежал в закоммиченном `.env` и остаётся в истории git, поэтому его нужно
сменить. Но **не одновременно с enforce**: ротация разлогинивает всех
пользователей сразу, и если совместить два изменения, будет непонятно, что
именно сломалось. Порядок: enforce → несколько дней наблюдения → ротация
в спокойное время суток. Тот же секрет используют `calling_api_v2` и `totus_ai_v2`
— менять нужно во всех трёх `.env` одновременно.

## Открытый вопрос

Цепочка бронирования (`POST /orders/prebuild`, `/packages/prebook`,
`/validate-tourists`, `/create-package`) сейчас стоит под `requireAuth(['user'])`
без strict. Если бронировать тур можно без регистрации — после enforce продажи
гостям остановятся. Перед включением нужно решить: либо эти четыре маршрута
становятся публичными, либо вход становится обязательным шагом бронирования.
