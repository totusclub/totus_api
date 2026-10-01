# WEB Documentation (RU) — totus_WEB

Документация построена **только по коду** репозитория `totus_WEB` (`/Users/haykmaruqyan/Desktop/TOSMEDIA/TOTUS/kedam-WEB`).  
Если сведения отсутствуют в коде: `Не найдено в текущей кодовой базе.`  
Если вывод неочевиден: `Предположение:`.

Секреты, токены и значения env **не приводятся** — только имена переменных и публичные дефолтные URL из кода.

Продакшен-сайт: **https://totus.club** (из `PROJECT_CLOUD_BRIEF.md` / дефолт origin в `useSbpPay.ts`).

---

# 1. Frontend Architecture

## Стек

| Компонент | Факт из кода |
|-----------|--------------|
| Framework | Next.js `15.3.2` (`package.json`) |
| Router | **Pages Router** — `src/pages/` (App Router не используется) |
| UI | React `^19.0.0`, React DOM `^19.0.0` |
| Язык | TypeScript `^5` (`strict: true`) |
| State | Redux Toolkit `^2.8.1` + `next-redux-wrapper` `^8.1.0` + `react-redux` |
| HTTP | `axios` (LT / auth / search) и native `fetch` (CMS, home content, favorites, callback) |
| AI UI | `@tosmedia/ai-assistant` (`github:tosmedia/totus_ai_v2#pkg/ai-assistant`) |
| Path alias | `@/*` → `./src/*` (`tsconfig.json`) |

## Entry points

| Файл | Роль |
|------|------|
| `src/pages/_app.tsx` | Обёртка приложения: Redux wrapper, SEO, Metrika, Header/Footer, auth hydrate из `localStorage`, `GlobalAiChat`, cookie consent |
| `src/pages/_document.tsx` | HTML shell: `lang="ru"`, favicon/manifest, Google Fonts (Golos Text) |
| `next.config.ts` | `transpilePackages: ['@tosmedia/ai-assistant']`, `images.unoptimized`, `typescript.ignoreBuildErrors: true`, `eslint.ignoreDuringBuilds: true` |

## Поток запроса (типичный)

```text
Page (src/pages/*)
  ↓
Component (src/components/*)
  ↓
Hook и/или Redux thunk (src/hooks/*, src/store/slices/*)
  ↓
API-модуль (src/api/*) или прямой axios/fetch в slice
  ↓
totus_API (API_BASE_URL)  |  voip favorites  |  Totus AI (apiBase / wsUrl)
```

## Замечания по архитектуре

- **С 01.09.2026 (PR #3, волна 1 плана JWT):** `src/api/http.ts` ставит interceptors на глобальный axios — только для запросов к `API_BASE_URL`: `Authorization: Bearer` из `localStorage.auth_token`; на `401` — один refresh через `POST /api/auth/refresh` и повтор запроса; если refresh не удался — очистка сессии и событие `totus:auth-logout`. Отдельного `axios.create`-инстанса нет.
- Bearer/токен в AI передаётся через `getAccessToken` в `GlobalAiChat`.
- Для части запросов totus_API в body/params по-прежнему передаётся `user_id` (например `getOrdersUsers`, создание заказа в booking); на backend владелец берётся из токена (`API_DOCUMENTATION_RU.md` §7).
- `@tanstack/react-query` есть в `package.json`, но **импортов/использования в `src/` нет** (peerDependency пакета AI).
- React Context / RTK Query: **не найдено в текущей кодовой базе.**

---

# 2. Project Structure

```text
totus_WEB/
├── next.config.ts
├── package.json
├── .npmrc                          # legacy-peer-deps=true
├── .env.local                      # локальные NEXT_PUBLIC_* (не коммитить значения)
├── README.md                       # шаблон create-next-app + Deploy on Vercel
├── eslint.config.mjs
├── vendor/
│   └── tosmedia-ai-assistant/      # локальная копия dist пакета (vendor)
├── public/                         # статика, favicon, images, yandex verification html
└── src/
    ├── pages/                      # маршруты Pages Router
    ├── components/                 # UI и feature-компоненты
    ├── api/                        # HTTP-клиенты к backend / voip; http.ts — axios interceptors (Bearer + refresh)
    ├── store/                      # Redux store + slices
    ├── hooks/                      # React hooks
    ├── lib/                        # aiConfig, cmsPage, makeStaticCmsPage
    ├── config/                     # api, seo, cmsPageDefs, footerStaticPages
    ├── utils/                      # auth, booking flow, formatters, storage helpers
    ├── styles/                     # globals.css
    └── assets/                     # fonts, icons, images
```

### Назначение каталогов

| Каталог | Назначение |
|---------|------------|
| `src/pages` | Страницы и спецфайлы Next (`_app`, `_document`) |
| `src/components` | Feature UI: search, hotelDetails, booking, checkout, auth, profile, home, UI kit |
| `src/api` | Функции вызова API (LT proxy через totus_API, auth, CMS-контент home, favorites) |
| `src/store` | `configureStore` + slices: auth, search, departures, destinations, counter |
| `src/hooks` | Данные отеля, поиск, SBP, тема, CMS, auth restore |
| `src/lib` | Конфиг AI, загрузка CMS-страниц |
| `src/config` | Базовый URL API, SEO-маршруты, CMS defs, footer static SEO |
| `src/utils` | Auth HOC, booking funnel, SBP parse, фильтры, форматирование |
| `src/styles` | Глобальные стили + `@font-face` Golos Text |
| `public` | Статические файлы, отдаваемые как есть |
| `vendor` | Vendor-копия `@tosmedia/ai-assistant` dist |

`src/components/aiAssistant/` — **пустая директория** (AI подключён через `GlobalAiChat.tsx` + npm-пакет).

---

# 3. Base URLs / Env

## Базовые URL

| Назначение | Источник | Дефолт в коде |
|------------|----------|---------------|
| totus_API | `NEXT_PUBLIC_API_BASE_URL` \|\| `'https://api.totus.club'` | `src/config/api.ts` → `API_BASE_URL` |
| AI HTTP API | `getAiApiBase()` | `NEXT_PUBLIC_AI_API_URL` \|\| `${NEXT_PUBLIC_AI_SERVER_URL}/api` \|\| `https://apiv2.totus.club/api` (`src/lib/aiConfig.ts`) |
| AI WebSocket | `getAiWsUrl()` | `NEXT_PUBLIC_AI_WS_URL` \|\| ws от `NEXT_PUBLIC_AI_SERVER_URL` \|\| `wss://apiv2.totus.club/ws/assistant` |
| Favorites (voip) | `NEXT_PUBLIC_FAVORITES_API_URL` \|\| `https://voip.totus.club` | `src/api/favoritesApi.ts` |
| Site origin (SEO) | `NEXT_PUBLIC_SITE_URL` | если пусто — canonical/og без origin (`getSiteOrigin()`) |
| SBP return origin | `window.location.origin` \|\| `'https://totus.club'` | `src/hooks/useSbpPay.ts` |

## Прочие публичные env (читаются в коде)

| Ключ | Где используется |
|------|------------------|
| `NEXT_PUBLIC_YANDEX_SMARTCAPTCHA_SITEKEY` | `YandexSmartCaptcha.tsx` (signin/signup) |
| `NEXT_PUBLIC_YANDEX_MAPS_API_KEY` | `HotelLocationMap.tsx` |
| `NEXT_PUBLIC_APP_STORE_URL` | `apps/AppsLanding.tsx` (iOS badge) |
| `NEXT_PUBLIC_GOOGLE_PLAY_URL` | `apps/AppsLanding.tsx` (Android badge) |
| `NEXT_PUBLIC_AI_SERVER_URL` | fallback в `aiConfig.ts` (если нет отдельных AI_API/WS URL) |

## Ключи, присутствующие в `.env.local` (только имена)

По факту файла `.env.local` в репозитории (значения **не** документируются):

- `NEXT_PUBLIC_API_BASE_URL`
- `NEXT_PUBLIC_YANDEX_SMARTCAPTCHA_SITEKEY`
- `NEXT_PUBLIC_AI_API_URL`
- `NEXT_PUBLIC_AI_WS_URL`

Остальные ключи из таблицы выше в текущем `.env.local` **не найдены** (код использует дефолты / пустые строки).

---

# 4. All Routes / Pages

Auth: страницы с `withAuth` — защищённые (редирект на `/` без токена). Остальные — публичные (модалка auth на сайте, не отдельный route).

| Path | Файл | Назначение | Auth |
|------|------|------------|------|
| `/` | `pages/index.tsx` | Главная: поиск, баннеры, рекомендации, направления, партнёры, callback, FAQ | public |
| `/search` | `pages/search/index.tsx` | Результаты поиска отелей/туров + шаги funnel | public |
| `/hotel-details` | `pages/hotel-details/index.tsx` | Карточка отеля, номера, отзывы, карта | public |
| `/tickets` | `pages/tickets/index.tsx` | Выбор перелёта (package flow) | public |
| `/booking` | `pages/booking/index.tsx` | Форма туристов / бронирование | public |
| `/checkout` | `pages/checkout/index.tsx` | Сводка заказа / оплата | public |
| `/pay` | `pages/pay/index.tsx` | Статус оплаты SBP + WebView postMessage | public |
| `/profile` | `pages/profile/index.tsx` | ЛК + список заказов (desktop) | **withAuth** |
| `/profile/my-orders` | `pages/profile/my-orders/index.tsx` | Мои заказы (mobile variant) | **withAuth** |
| `/profile/my-orders/[order_id]` | `pages/profile/my-orders/[order_id].tsx` | Детали заказа + документы | **withAuth** |
| `/profile/favorites` | `pages/profile/favorites/index.tsx` | Избранные отели | **withAuth** |
| `/apps` | `pages/apps/index.tsx` → `AppsLanding.tsx` | Лендинг мобильного приложения | public |
| `/about-us` | `pages/about-us/index.tsx` | CMS slug `about-us` | public |
| `/privacy-policy` | `pages/privacy-policy/index.tsx` | CMS slug `privacy-policy` | public |
| `/career` | `pages/career/index.tsx` | CMS | public |
| `/blog` | `pages/blog/index.tsx` | CMS | public |
| `/how-we-work` | `pages/how-we-work/index.tsx` | CMS | public |
| `/help-faq` | `pages/help-faq/index.tsx` | CMS | public |
| `/press` | `pages/press/index.tsx` | CMS | public |
| `/branches` | `pages/branches/index.tsx` | CMS | public |
| `/hotel-owners` | `pages/hotel-owners/index.tsx` | CMS | public |
| `/partners` | `pages/partners/index.tsx` | CMS | public |
| `/advertise` | `pages/advertise/index.tsx` | CMS | public |
| `/airline-fees` | `pages/airline-fees/index.tsx` | CMS | public |
| `/airlines` | `pages/airlines/index.tsx` | CMS | public |
| `/low-fare-tips` | `pages/low-fare-tips/index.tsx` | CMS | public |
| `/badges-certificates` | `pages/badges-certificates/index.tsx` | CMS | public |
| `/security` | `pages/security/index.tsx` | CMS | public |
| `/cookie-settings` | `pages/cookie-settings/index.tsx` | CMS | public |
| `/terms` | `pages/terms/index.tsx` | CMS | public |
| `/ad-choices` | `pages/ad-choices/index.tsx` | CMS | public |
| `/ai` | `pages/ai/index.tsx` | Редирект на `/` (отдельная AI-страница отключена) | public |
| `/ai/tours/[id]` | `pages/ai/tours/[id].tsx` | Мост AI → `/hotel-details` (`lt_<hotelId>`) | public |

Вспомогательные (не маршруты):

- `pages/about-us/AboutUsFallback.tsx` — fallback-контент «О нас»
- `pages/_app.tsx`, `pages/_document.tsx` — каркас Next

Кастомная `pages/404.tsx`: **Не найдено в текущей кодовой базе.** (SEO-запись `/404` есть в `config/seo.ts`.)

CMS-страницы рендерятся через `CmsStaticPage` (клиентская загрузка `/api/pages/slug/...` с fallback defs).

---

# 5. User Flows (business)

## 5.1 Package tour (тур с перелётом)

Шаги UI из `bookingFlowUtils.getFlowSteps('package')`:

1. **search** — `/search` (выбор туров)
2. **hotel** — `/hotel-details` (отель и размещение)
3. **flights** — `/tickets` (выбор перелёта)
4. **booking** — `/booking`
5. **checkout** — `/checkout` → оплата SBP → `/pay`

После `createPackage` / `package_details`: `navigateAfterPackageCreate` ведёт на `/tickets?package=<id>` (не hotel-only).

## 5.2 Hotel-only

Шаги из `getFlowSteps('hotel')` — **без** flights:

1. search → 2. hotel → 3. booking → 4. checkout

`navigateAfterPackageCreate(..., 'hotel')` → `/booking?package=<id>&search_type=hotel`.

Признак: query `search_type=hotel` (`getSearchTypeFromQuery`).

## 5.3 Auth

1. Модалка `components/auth` (signin / signup) — не отдельный route.
2. Yandex SmartCaptcha (`smart-token` / `smartToken` в body), если задан sitekey.
3. `POST /api/auth/signin` или `/api/auth/signup` → экран verification.
4. `POST /api/auth/verify` → `{ auth, authToken, accessToken, refreshToken }` → `saveToken` (`localStorage` `auth_token`) + `refresh_token` (с 01.09) + `setAuth` в Redux; `verification.tsx` сразу подтягивает профиль `GET /api/auth/me`.
5. В WebView: `postMessage` с `{ screen: 'auth', user }`.

Cookie-сессии для auth: **нет**.

## 5.4 Profile / orders / favorites

- `/profile`, `/profile/my-orders`, `/profile/my-orders/[order_id]` — заказы через `getOrdersUsers` / `getOrder` / `getOrderDocuments`.
- `/profile/favorites` — voip `favoritesApi` по `userId` из JWT payload.
- Logout: `deleteToken` + `logout()` Redux; в WebView — `postMessage('logout')`.

## 5.5 AI (Мила)

- `GlobalAiChat` на всех страницах кроме `/ai*`: только если есть `user` + `token` (после mount).
- Пакет `@tosmedia/ai-assistant`: `AiAssistantProvider` + `ChatWidget`, `apiBase` / `wsUrl` из `aiConfig`, `getAccessToken`, `tourBasePath="/ai/tours"`, `homePath="/"`.
- `/ai` → redirect `/`.
- `/ai/tours/lt_<id>` → `/hotel-details` с query из `buildHotelDetailsDeepLinkQuery` (цена не прокидывается).

---

# 6. State Management

## Store (`src/store/index.ts`)

`configureStore` + `createWrapper` (`next-redux-wrapper`).

| Slice | Файл | Назначение |
|-------|------|------------|
| `auth` | `authSlice.ts` | `token`, `user`; actions `setAuth`, `logout` |
| `search` | `searchSlice.ts` | поиск: `runFullSearchFlow`, `searchFilters`, progress, hotels, poll cancel |
| `departures` | `departuresSlice.ts` | `fetchDepartures` → `GET /references/departures` |
| `destinations` | `destinationsSlice.ts` | `fetchDestinations` → `GET /references/autocomplete_v2` |
| `counter` | `counterSlice.ts` | демо increment/decrement (используется в `getServerSideProps` home) |

## Что не используется

| Технология | Статус |
|------------|--------|
| TanStack React Query в `src/` | **Не используется** (есть только в dependencies / peer AI) |
| React Context API | **Не найдено** |
| RTK Query (`createApi`) | **Не найдено** |

Гидратация auth: `_app.tsx` + `useAuth` читают `localStorage` и диспатчат `setAuth`, если `exp` не истёк (`isTokenAlive`). С 01.09 `_app.tsx` восстанавливает профиль из payload токена, затем обновляет его из `GET /api/auth/me`, и слушает событие `totus:auth-logout` (диспатчит `logout`).

---

# 7. API Client Layer

Все модули в `src/api/`:

### `levelTravelApi.tsx` → `API_BASE_URL` (totus_API)

| Функция | Метод | Endpoint |
|---------|-------|----------|
| `startSearch` | GET | `/start-search` |
| `checkSearchStatus` | GET | `/search-status` |
| `getHomeData` | GET | `/home/data` |
| `getGroupedHotels` | GET | `/grouped-hotels` |
| `runFullSearchFlow` | — | start → poll status → grouped (локальный orchestration) |
| `getHotelOffers` | GET | `/get-hotel-offers` |
| `getHotelRooms` | GET | `/hotels-rooms` |
| `getHotelInfo` | GET | `/references/hotels` |
| `getHotelReviews` | GET | `/references/hotel_reviews/:hotel_id` |
| `createPackage` | GET | `/packages/package_details` |
| `PackagesActualize` | GET | `/packages/actualize` |
| `Packagesflights` | POST | `/packages/flights` |
| `PackagesActualizeFlight` | GET | `/packages/actualize` (+ `flight_pair_id`) |
| `prebuildOrder` | POST | `/orders/prebuild` |
| `prebookPackage` | POST | `/packages/prebook` |
| `validateTourist` | POST | `/validate-tourists` |
| `createOrder` | POST | `/create-package` |
| `createPay` | POST | `/vtb/create-order` |
| `checkPay` | POST | `/check_pay` |
| `getOrder` | GET | `/orders` |
| `getOrderDocuments` | GET | `/orders/documents` |
| `getOrdersUsers` | GET | `/user/orders` (`user_id`) |

Повторяющиеся LT-прокси сведены в одну таблицу; детали query/body — в коде функций (санитизация фильтров, page_number, time ranges для flights).

### `AuthApi.tsx`

| Функция | Endpoint |
|---------|----------|
| `SignInRequest` | `POST /api/auth/signin` |
| `SignUpRequest` | `POST /api/auth/signup` |
| `verifyCodeRequest` | `POST /api/auth/verify` |
| `getMe` | `GET /api/auth/me` (с 01.09; Bearer через interceptor) |

### `http.ts` (с 01.09)

Interceptors на глобальном `axios`, только для URL с `API_BASE_URL`: request — `Authorization: Bearer <auth_token>`; response `401` — один `POST /api/auth/refresh { refreshToken }` → сохранить новую пару → повторить запрос; при неудаче — `deleteToken()` (оба ключа) + `window.dispatchEvent(new Event('totus:auth-logout'))`.

### CMS / home content (fetch)

| Файл | Endpoint |
|------|----------|
| `homeBannersApi.ts` | `GET /api/home-banners` |
| `homeHeroApi.ts` | `GET /api/home-hero` |
| `homePartnersApi.ts` | `GET /api/home-partners` |
| `faqApi.ts` | `GET /api/faq` |
| `footerSocialApi.ts` | `GET /api/footer-social` |
| `callbackRequestApi.ts` | `POST /api/callback-requests` |

CMS страницы (не в `src/api/`, но HTTP): `lib/cmsPage.ts` / `useCmsPage` / `CmsStaticPage` → `GET /api/pages/slug/:slug` (fallback `/api/admin/pages/slug/:slug`).

### `favoritesApi.ts` → voip base

| Функция | Endpoint |
|---------|----------|
| `addFavorite` | `POST /api/favorites` |
| `removeFavorite` | `DELETE /api/favorites` |
| `getUserFavorites` | `GET /api/favorites/:userId` |
| `isFavorite` | `GET /api/favorites/:userId/:hotelId` |

### Support (вне `src/api/`)

`components/support/index.tsx`: `POST ${API}/api/support/call` (кнопка также шлёт WebView `openModal`).

### Прямые вызовы из Redux slices

- `departuresSlice` → `GET /references/departures`
- `destinationsSlice` → `GET /references/autocomplete_v2`

### Auth к totus_API

- Interceptors в `src/api/http.ts` (с 01.09): Bearer из `localStorage.auth_token` на все axios-запросы к `API_BASE_URL`; `401` → refresh → повтор → иначе logout.
- Interceptors действуют только на axios — `fetch`-клиенты (CMS, favorites → voip, callback) Bearer не шлют.
- `user_id` может по-прежнему уходить в query/body отдельных методов; источник истины на backend — токен.
- JWT в AI: `getAccessToken` в `GlobalAiChat`.

---

# 8. Authentication (frontend)

| Тема | Факт |
|------|------|
| Хранение JWT | `localStorage` ключи `auth_token` (access) и `refresh_token` (с 01.09) — `utils/auth.tsx`, SSR-safe (проверка `window`) |
| Bearer к totus_API | `src/api/http.ts` — interceptors на глобальном axios только для `API_BASE_URL` (с 01.09) |
| Refresh | `401` → один `POST /api/auth/refresh { refreshToken }` → повтор; неудача → `deleteToken()` + событие `totus:auth-logout` |
| Профиль | Из payload токена при восстановлении, затем из `GET /api/auth/me` (`AuthApi.getMe()`); `verification.tsx` подтягивает `/me` сразу после входа |
| Decode | `jwt-decode` → payload user + `exp`; `isTokenAlive()` проверяет срок |
| Redux | `setAuth` / `logout`; `_app.tsx` слушает `totus:auth-logout` |
| HOC | `withAuth` — ждёт restore, иначе `router.replace('/')` |
| PIN flag | `localStorage` `pin_code` = `'YES'` (`savePin` / `getPin`) |
| Captcha | `@yandex/smart-captcha`, sitekey из env |
| WebView | `window.ReactNativeWebView.postMessage` (auth success, logout, openModal, pay status) |
| Auth cookies | **Не используются** для JWT |

Logout: `deleteToken()` (чистит `auth_token` и `refresh_token`) + `dispatch(logout())` в `HeaderProfileMenu` и `profile/menu`; автоматический logout — по событию `totus:auth-logout` из interceptor.

---

# 9. Key Components

| Папка / файл | Ответственность |
|--------------|-----------------|
| `GlobalAiChat.tsx` | FAB чата Милы для авторизованных |
| `header/` | Шапка, профиль-меню, theme-toggle |
| `footer/` | Подвал + ссылки (в т.ч. static CMS) |
| `mobileBottomBar/` | Нижняя навигация mobile |
| `search/` | Форма поиска на главной (откуда/куда/даты/гости/ночи) + hero |
| `searchPage/` | Steps funnel, результаты, фильтры package/hotel, ticket list |
| `hotelDetails/` | Header, info, desc, rooms, map, reviews, favorite button, search section |
| `hotelCard/`, `hotelBox/` | Карточки отелей в выдаче |
| `bookingPage/` | Форма бронирования, order card, создание заказа |
| `checkoutPage/` | Checkout UI + SBP |
| `UI/SbpPayButton/` | Кнопка/модалка/панель QR СБП |
| `auth/` | Modal flows: signin, signup, verification, SmartCaptcha |
| `profile/` | Меню ЛК, заказы, детали, OrderSbpPayButton |
| `favorites/` | Список избранного |
| `home/` | Banners, hotDeals, popularDestinations, partner, callRequest, faq |
| `modals/` | ticketModal, tourModal |
| `cookieConsent/` | Баннер согласия |
| `seo/SiteSeo.tsx` | Head meta / OG |
| `staticInfoPage/` | Оболочка статичных/CMS страниц |
| `selectedTour/`, `ticketItem/` | Отображение выбранного тура / билета |
| `support/` | Кнопка звонка поддержки (WebView/API) |
| `UI/*` | Переиспользуемые input, button, modal, calendar, range, gallery и т.д. |
| `ScrollRestoration.tsx` | Сохранение scroll в sessionStorage (**закомментирован** в `_app`) |
| `splashScreen/` | Splash UI |

---

# 10. Hooks

| Hook | Файл | Назначение |
|------|------|------------|
| `useAuth` | `useAuth.ts` | Redux auth + restore из `localStorage` |
| `useLoadHomeData` | `loadHomeData.ts` | `GET /home/data` для главной |
| `useCmsPage` | `useCmsPage.ts` | Загрузка CMS page по slug |
| `useDepartureSearch` | `useDepartureSearch.ts` | Поиск/фильтр городов вылета (departures) |
| `useDestinationsSearch` | `useDestinationsSearch.ts` | Автокомплит направлений |
| `useHotelDetails` | `useHotelDetails.ts` | `getHotelInfo` по hotel_id |
| `useHotelRooms` | `useHotelRooms.ts` | Номера отеля |
| `useHotelReviews` | `useHotelReviews.ts` | Отзывы |
| `useInitialHotelSearch` | `useInitialHotelSearch.ts` | Инициализация поиска на hotel-details |
| `useInitialSearchParams` | `useInitialSearchParams.ts` | Парсинг query search params |
| `useRequestIdSync` | `useRequestIdSync.ts` | Синхронизация `request_id` с URL/session |
| `useStaleHotelSearchRefresh` | `useStaleHotelSearchRefresh.ts` | Обновление устаревшего hotel search |
| `useStopSearchPollOnLeave` | `useStopSearchPollOnLeave.ts` | Стоп poll при уходе с `/search` / `/hotel-details` |
| `useSbpPay` | `useSbpPay.ts` | Создание SBP QR через `createPay` |
| `useIsDesktop` | `useIsDesktop.ts` | Viewport ≥ 1025 (SBP desktop) |
| `useTheme` | `useTheme.ts` | light/dark + `localStorage` `theme` |

---

# 11. Utils / Config / Lib

### Utils (notable)

| Файл | Роль |
|------|------|
| `bookingFlowUtils.ts` | Шаги funnel package vs hotel; навигация после package create |
| `bookingValidation.ts` | Валидация полей бронирования |
| `sbpPayment.ts` | Parse SBP response, QR image, `sbp_qrc_*` storage, paid check |
| `withAuth.tsx` | HOC защиты страниц |
| `auth.tsx` | Token/pin helpers + jwt decode |
| `hotelDetailsUtils.ts` | Deep link query, flex dates, meta отеля |
| `hotelSearchRefresh.ts` | Scoped request_id в sessionStorage |
| `searchListState.ts` | Persist списка поиска (`kedam_search_list_state`) |
| `searchResults.ts` / `searchStatus.ts` | Пагинация, operators CSV, stop polling |
| `orderDisplay.ts` / `orderPayment.ts` / `offerDisplay.ts` | Отображение заказов/офферов |
| `packagePrice.ts` / `formatPrice.ts` / `formatRussianPlural.ts` | Цены и плюралы |
| `cookieConsent.ts` | Ключ `cookie_consent` |
| `themeInit.ts` | Ранняя инициализация темы |
| `calendarDateRange.ts` / `dateTimeUtils.ts` / `documentMappings.ts` / `roomFilters.ts` / `listRoomPick.ts` / `favoriteHotelDisplay.ts` | Вспомогательная логика UI |

### Config

- `config/api.ts` — `API_BASE_URL`
- `config/seo.ts` — `SITE_NAME`, route SEO map, `getSiteOrigin`
- `config/cmsPageDefs.ts` — defs CMS + about/privacy
- `config/footerStaticPages.ts` — footer static slugs + SEO

### Lib

- `lib/aiConfig.ts` — AI base/ws URL
- `lib/cmsPage.ts` — `fetchCmsPageBySlug`, SEO fields payload
- `lib/makeStaticCmsPage.tsx` — factory SSR handlers (в pages в основном используется клиентский `CmsStaticPage`)

---

# 12. Styling

| Тема | Факт |
|------|------|
| Подход | **CSS Modules** (`*.module.css`) + `src/styles/globals.css` |
| Шрифт | **Golos Text** — Google Fonts link в `_document` + локальный `@font-face` ttf в `globals.css` |
| Tailwind | **Нет** в dependencies / коде |
| styled-components | **Нет** |
| Анимации / UI libs | `framer-motion`, `react-slick` + `slick-carousel`, `react-calendar`, `react-modal`, `react-range` |

Images: `next.config.ts` → `images.unoptimized: true`.

---

# 13. Storage

## localStorage

| Ключ | Назначение |
|------|------------|
| `auth_token` | JWT (access) |
| `refresh_token` | Refresh JWT для `POST /api/auth/refresh` (с 01.09) |
| `pin_code` | Флаг `'YES'` |
| `theme` | `'light'` \| `'dark'` |
| `cookie_consent` | `'accepted'` |

## sessionStorage

| Ключ / паттерн | Назначение |
|----------------|------------|
| `searchScroll` | Позиция скролла списка поиска |
| `kedam_search_list_state` | Состояние списка результатов |
| `kedam_restore_search_list` | Флаг восстановления списка (`'1'`) |
| `hotelDetailsFilterMeals` | Фильтр питания при переходе в отель |
| `hotel_scoped_rid_${hotelId}` | Scoped `request_id` для отеля |
| `sbp_qrc_${orderId}` | qrcId СБП для `/pay` |
| `checkout_buyer_${id}` | Данные покупателя для checkout |
| `scroll-${url}` | Scroll restoration (компонент сейчас не подключён в `_app`) |

---

# 14. External Integrations

| Интеграция | Как в коде |
|------------|------------|
| totus_API | `API_BASE_URL` — поиск LT, заказы, auth, CMS, VTB create-order, check_pay |
| voip favorites | `https://voip.totus.club` (или env) `/api/favorites` |
| Totus AI «Мила» | `@tosmedia/ai-assistant` → apiv2 HTTP + WS |
| Yandex Maps | `react-yandex-maps`, ключ `NEXT_PUBLIC_YANDEX_MAPS_API_KEY` |
| Yandex SmartCaptcha | `@yandex/smart-captcha` |
| Yandex Metrika | counter **106173650** в `_app.tsx` |
| VTB SBP | через API `POST /vtb/create-order`, `POST /check_pay`; QR fallback `api.qrserver.com` |
| React Native WebView | `postMessage` bridge (auth, logout, support modal, pay status) |
| App Store / Google Play | URL из env на `/apps` |

---

# 15. SEO

| Элемент | Факт |
|---------|------|
| `SiteSeo` | В `_app`: title/description/keywords, robots, canonical, Open Graph, Twitter |
| `_document` | `lang="ru"`, favicons, manifest, theme-color |
| `config/seo.ts` | Дефолты Totus Club + карта route SEO (в т.ч. noIndex для booking/checkout/pay/profile) |
| CMS SEO | Поля `seo_title`, `seo_desc`, `seo_keywords` в payload страницы (`cmsPage.ts`) |
| Origin | `NEXT_PUBLIC_SITE_URL`; без него canonical/og:url могут быть пустыми |

---

# 16. Scripts & Dependencies

## npm scripts

```bash
npm run dev     # next dev --turbopack
npm run build   # next build
npm run start   # next start
npm run lint    # next lint
```

## Ключевые зависимости

| Пакет | Зачем |
|-------|-------|
| `next` / `react` / `react-dom` | Приложение |
| `@reduxjs/toolkit`, `react-redux`, `next-redux-wrapper` | State |
| `axios` | HTTP к totus_API |
| `@tosmedia/ai-assistant` | Чат Милы |
| `@yandex/smart-captcha` | Captcha auth |
| `jwt-decode` | Decode JWT |
| `framer-motion`, `react-slick`, `react-calendar`, `react-modal`, `react-range` | UI |
| `react-yandex-maps` | Карта отеля |
| `date-fns` | Даты |
| `spark-md5` | MD5 (использование по месту в коде) |
| `@tanstack/react-query` | В package.json; **не используется в src/** (peer AI) |

## Конфиг установки

- `.npmrc`: `legacy-peer-deps=true`
- `next.config.ts`: `transpilePackages: ['@tosmedia/ai-assistant']`

---

# 17. Deployment

| Тема | Факт |
|------|------|
| Docker | **Не найдено в текущей кодовой базе** (нет Dockerfile / compose) |
| Runtime | `next build` → `next start` |
| README | Стандартный create-next-app: упоминание Deploy on **Vercel** |
| Build errors | `typescript.ignoreBuildErrors: true`, `eslint.ignoreDuringBuilds: true` |
| Prod site | https://totus.club (brief / SBP fallback origin) |

Детали CI/CD, хостинга и env на проде в репозитории: **Не найдено в текущей кодовой базе.**

---

# 18. Testing

Автотесты (`*.test.*`, `*.spec.*`, `__tests__`): **Не найдено в текущей кодовой базе.**

---

# 19. Important Files

| Файл | Почему важен |
|------|----------------|
| `src/pages/_app.tsx` | Каркас приложения, auth hydrate, Metrika, layout, AI |
| `src/pages/_document.tsx` | HTML document, fonts, favicon |
| `next.config.ts` | transpile AI, ignore build errors |
| `src/config/api.ts` | Base URL backend |
| `src/lib/aiConfig.ts` | AI API/WS |
| `src/api/levelTravelApi.tsx` | Основной клиент поиска/бронирования/оплаты |
| `src/api/AuthApi.tsx` | Auth endpoints (+ `getMe`) |
| `src/api/http.ts` | Axios interceptors: Bearer + refresh-once + `totus:auth-logout` (с 01.09) |
| `src/api/favoritesApi.ts` | Избранное (voip) |
| `src/store/index.ts` + `slices/*` | Redux |
| `src/utils/bookingFlowUtils.ts` | Package vs hotel funnel |
| `src/utils/withAuth.tsx` / `auth.tsx` | Auth gate + storage |
| `src/components/GlobalAiChat.tsx` | Интеграция Милы |
| `src/hooks/useSbpPay.ts` / `utils/sbpPayment.ts` | СБП |
| `src/config/seo.ts` | SEO карта |
| `src/styles/globals.css` | Глобальные стили и шрифт |

---

# 20. Instructions for Claude Code

## Где что лежит

- **Страницы:** `src/pages/`
- **Компоненты:** `src/components/`
- **API-клиенты:** `src/api/` (+ CMS в `src/lib/cmsPage.ts`)
- **Redux:** `src/store/`
- **Хуки:** `src/hooks/`
- **Конфиг URL/SEO:** `src/config/`
- **Funnel логика:** `src/utils/bookingFlowUtils.ts`

## Как запустить

```bash
cd totus_WEB
npm install   # учитывает .npmrc legacy-peer-deps
# заполнить .env.local (ключи — см. §3; значения не коммитить)
npm run dev
```

## Правила изменений

1. Следовать существующим паттернам (Pages Router, CSS Modules, Redux thunks, axios/fetch в `src/api`).
2. AI подключать через `@tosmedia/ai-assistant` и `src/lib/aiConfig.ts` / `GlobalAiChat` — не изобретать отдельный чат без запроса.
3. Не делать редизайн UI, если об этом не просили.
4. Перед изменением воронки бронирования сверяться с `bookingFlowUtils.ts` (package vs hotel, наличие `/tickets`).
5. Backend base — `API_BASE_URL` из `src/config/api.ts`.
6. JWT сайта хранится **только** в `localStorage` (`auth_token` + `refresh_token`); Bearer к totus_API добавляется централизованно interceptor'ом в `src/api/http.ts` — не дублировать заголовок в отдельных методах и не заводить второй axios-инстанс.
7. Не коммитить секреты / значения `.env.local`.
8. React Query в `src/` пока не принят — не внедрять без необходимости (AI-пакет может тянуть peer).

---

*Конец документа. Источник истины — код `totus_WEB`; при расхождении с этим файлом верить коду.*
