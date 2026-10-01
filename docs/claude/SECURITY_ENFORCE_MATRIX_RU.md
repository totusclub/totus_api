# TOTUS — матрица вызовов API и план перехода в AUTH_MODE=enforce

**Дата:** 21.09.2026. Пункт К2 из `SECURITY_AUDIT_2026-09_RU.md`.
**Статус:** инструмент и план — в PR [totus_API#22](https://github.com/tosmedia/totus_API/pull/22). Режим **не включён**, ждёт починки клиентов и решения по гостевому бронированию.

---

## 1. Как устроена подстановка токена в клиентах

| Клиент | Механизм | Ограничен своим хостом |
|---|---|---|
| totus_WEB | `src/api/http.ts` — интерсептор на глобальном axios, refresh на 401 | Да (`isApiRequest()` по origin; проверка префиксная — см. аудит, п. 8) |
| totus_APP | `src/modules/axios/index.ts` — свой инстанс с `baseURL`, токен из redux, авто-refresh | Проверки хоста нет, но вызовы только относительные |
| totus_desktop | `src/shared/modules/axios/index.ts` — то же, что в APP | То же |
| Totus_admin | `lib/http.ts` — глобальный патч `window.fetch`, staff-Bearer на два базовых URL | Да, по списку баз |

## 2. Что сломается при enforce (по коду, не по логам)

| # | Где | Что увидит человек | Починка |
|---|---|---|---|
| 1 | totus_WEB: `src/lib/cmsPage.ts`, `src/hooks/useCmsPage.ts`, `src/components/staticInfoPage/CmsStaticPage.tsx` | Статические страницы (оферта, политика, помощь) покажут «Контент пока не опубликован» | Убрать fallback на `/api/admin/pages*`; недостающие страницы отдавать публичным роутером |
| 2 | Totus_admin: `components/AuthGuard.tsx` | Пустые таблицы в любом разделе после жёсткой перезагрузки | `installStaffFetch()` на уровне модуля/layout, до рендера дерева |
| 3 | totus_APP: `src/modules/store/actions/notification.ts` | Устройство молча не регистрируется, пуши перестают приходить | Читать токен из AsyncStorage, как в `voipAuth.ts`; до релиза — держать `/notification-tokens` в `AUTH_LOG_ONLY_PATHS` |
| 4 | totus_WEB: `src/api/YandexAuthApi.ts` | — | Не блокер: `isYandexAuthEnabled()` считает раздел включённым и при 401 |

## 3. Безопасно закрывать сразу

Все клиенты уже шлют Bearer: `/user/orders`, `/orders`, `/orders/documents`, `/vtb/create-order`, `/check_pay`, `/api/auth/me`, `PATCH /api/auth/me/phone`, `/api/order-requests*`, весь `/api/admin/*` (кроме `GET /api/admin/pages` и `/api/admin/pages/slug/:slug`), `/client/orders*`.

Оговорка: админка запрашивает чужие `user_id`/`order_id`, поэтому staff-роль обязана обходить проверку владельца — в `resolveOwnerId`/`assertOrderOwner` это уже учтено.

## 4. Остаётся публичным

Поиск и справочники LT (`/start-search`, `/search-status`, `/grouped-hotels`, `/get-hotel-offers`, `/hotels-rooms`, `/references/*`, `/home/data`, `/packages/*`), контент сайта (`/api/pages/slug/:slug`, `/api/faq`, `/api/footer-social`, `/api/home-*`), вход и регистрация (`/api/auth/signin|signup|verify|refresh`, `/customer-auth/refresh-token`, `/api/auth/yandex/*`, `/api/admin/auth/sign-in|refresh`), `POST /api/callback-requests`, платёжные callback'и и webhook'и LT.

## 5. Порядок включения

0. Прогнать `node scripts/analyze-auth-log.js` на логах за 3–5 дней, сверить с этой матрицей.
1. Починить три места из §2 (три небольших PR в клиентах).
2. `AUTH_MODE=enforce` + `AUTH_LOG_ONLY_PATHS=/api/admin/pages,/notification-tokens`.
3. Сокращать `AUTH_LOG_ONLY_PATHS` по мере релизов клиентов, пока не опустеет.
4. **Отдельно и позже:** ротация `JWT_SECRET` (разлогинит всех; секрет общий для totus_API, calling_api_v2 и totus_ai_v2 — менять во всех трёх `.env` одновременно).

Откат в любой момент: `AUTH_MODE=log` + `pm2 restart --update-env`, без выкатки кода.

## 6. Открытые вопросы владельцу

1. **Гостевое бронирование.** `/orders/prebuild`, `/packages/prebook`, `/validate-tourists`, `/create-package` стоят под `requireAuth(['user'])` без strict. Если тур можно забронировать без регистрации — после enforce продажи гостям остановятся. Решить: сделать публичными или сделать вход обязательным шагом бронирования.
2. **`auth_token` Level.Travel в query string** (`/client/orders*` из админки) — оседает в access-логах nginx. Перенести в заголовок отдельной задачей.

## 7. Что осталось непроверенным

- Прямые вызовы `fetch`/`axios` из экранов totus_APP (`src/screens/**`) — GitHub-поиск по этому репозиторию не работает, разобраны только каталоги `src/modules/**`.
- `VoipService.ts` (190 КБ), `pushService.ts`, `src/lib/webPush.ts` — целиком не читались.
- Есть ли в UI гейт авторизации перед бронированием (страницы checkout/booking не читались) — отсюда и вопрос 1.
