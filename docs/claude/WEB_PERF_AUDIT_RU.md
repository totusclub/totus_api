# totus_WEB — аудит производительности (01.10.2026)

**Статус:** этап 1 — [PR totus_WEB #25](https://github.com/tosmedia/totus_WEB/pull/25): пункты 4, 5 (атрибуты lazy/priority), 8 (дубль), `console.log`. Пункт 3 (gSSP) отложен: даты формы поиска считаются в рендере — статика дала бы мигание дат; шрифт и Метрика — после проверки или решения владельца.
**Источник:**
- код `tosmedia/totus_WEB` `main` @ `11b2b48`, прочитан через GitHub-коннектор;
- живой totus.club (HTML главной и чанки `/_next/static`).

**Стек:** Next.js 15.3.2, **Pages Router**, React 19, Redux Toolkit + next-redux-wrapper, axios, CSS Modules.

## Замеры на проде

| Что | Значение |
|---|---|
| `_app` чанк (грузится на каждой странице) | **701 KB** сырой / **233 KB** gzip |
| Из него SVG-путей иконок | ~158 KB (311 путей) |
| Главная `index` чанк | ~40 KB |
| Общий чанк `4533` (react-slick) | 64 KB / 16 KB gzip |
| Глобальный CSS | 105 KB / 18 KB gzip |
| HTML главной | 73 KB, из них **~60 KB — 39 inline SVG**; видимого текста ~0,9 KB |
| Главная | `gssp: true` (getServerSideProps на каждый запрос), состояние стора пустое |
| Контент главной | hero, баннеры, `home/data`, партнёры, FAQ — всё через `useEffect` после гидрации, `cache:'no-store'` |
| Шрифт | Golos Text, локальный TTF 178 KB, в CSS указан `format("woff2")` (ошибка); в `_document` также подключён Google Fonts |

Не удалось проверить из облака (нужно на сервере):
- gzip/brotli: `curl -sI -H 'Accept-Encoding: br,gzip' https://totus.club/_next/static/chunks/pages/_app-*.js`;
- `Cache-Control: immutable` на `/_next/static`;
- кеш картинок `/images/*`;
- HTTP/2 в nginx.

## Проблемы по приоритету

### P0 — самый большой эффект

1. **Тяжёлый `_app` для всех, включая гостей.** В `_app.tsx` статически импортированы:
   - `GlobalAiChat` — весь `@tosmedia/ai-assistant` + CSS, хотя гостю рендерится `null`;
   - `SupportChatGate`, `NotificationsBridge` — `socket.io-client`, `lib/webPush`, `notificationsApi`;
   - `SupportCallProvider` — `lib/supportCall` (WebRTC) + `SupportCallModal`;
   - в Header — `SearchForm` (date-fns + locale, свой календарь);
   - `AuthModal` (react-modal, SmartCaptcha, Yandex ID) **дважды**: в Header и в MobileBottomBar.

   **Исправление:** `next/dynamic(..., {ssr:false})`; модуль для авторизованных монтировать только при `token`; `import('socket.io-client')` внутри `connectSupportSocket`; `AuthModal` рендерить по открытию.
2. **Реестр иконок.** `components/icons/Icon.tsx` статически собирает все 79 иконок, включая логотипы партнёров: onexTour 51 KB, biblioGlobus 19 KB, pegas 11 KB и др. — ≈98 KB. Tree-shaking это не убирает. Плюс 39 SVG инлайнятся в SSR-HTML (~60 KB).

   **Исправление:** прямые импорты нужных иконок; партнёрские и редкие — локально или как `/public/*.svg` через `<img>`.
3. **Главная: пустой `getServerSideProps`.** `pages/index.tsx` делает только `dispatch(increment())`. Последствия:
   - каждый запрос рендерится на сервере, CDN-кеша нет, растёт TTFB;
   - каждый клиентский переход на `/` делает лишний `/_next/data/.../index.json`.

   **Исправление:** удалить gSSP — страница станет статической, UI тот же.
4. **Страница отеля: галерея ждёт поиск номеров.** В `hotelDetailsInfo/index.tsx` `VerticalSlider loading={roomsSectionLoading}`: главное фото (LCP) появляется после startSearch → status → hotels-rooms, то есть через секунды или десятки секунд, хотя фото уже есть из `/references/hotels`.

   **Исправление:** не привязывать галерею к загрузке номеров; главному `<img>` — `fetchPriority="high"`.
5. **Все картинки грузятся сразу:**
   - `UI/verticalSlide` — все фото отеля (x500);
   - `UI/smallSlide` — все превью x900 в каждом номере (сотни картинок);
   - `hotelCard` — фото CSS-фоном у каждой из 50–250 карточек;
   - нигде нет `loading="lazy"`, `decoding`, width/height.

   **Исправление:** `loading="lazy" decoding="async"`; в карточке `<img object-fit:cover>` вместо фона; первые 2–3 карточки — eager/high.

### P1 — сеть и CPU

6. **Поллинг поиска** (`searchSlice.runFullSearchFlow`, 3 с × 40):
   - `clearActiveSearchPoll`/`stopActiveSearchPoll` снимают только таймер, а запрос в полёте перезапускает цепочку;
   - при новом поиске или фильтре параллельно крутятся две цепочки;
   - старые результаты могут перезаписать новые (нет проверки `requestId`).

   **Исправление:** счётчик поколений, `AbortController` (`thunkAPI.signal` → axios), игнор чужих `requestId`, бэкофф.
7. **Фильтры** (`searchFilters`): каждый клик — запрос без отмены; применяется последний пришедший ответ, а не последний запрошенный. **Исправление:** то же — `requestId` + abort.
8. **`useHotelRooms`:** при `searchDone` — **два одинаковых** `/hotels-rooms` подряд. При активных фильтрах номеров фильтр-запрос, вероятно, повторяется на каждом опросе (сброс `lastFilterRequestKeyRef` по `canonicalRooms`). Отмены нет. **Исправление:** убрать повторный fetch, сбрасывать ключ только при смене базового ключа, abort.
9. **Ре-рендеры:**
   - `useSelector(state => state.search)` целиком в `resultList`, `searchResult`, `filters` (32 KB JSX), `searchForm` — каждый `updateProgress` раз в 3 с перерисовывает всё;
   - `HotelCard` без `React.memo` подписан на `state.search.hotels` и вызывает `useTheme()`: localStorage + 2 setState + `storage`-листенер в каждой карточке, на 50 карточек ~100 лишних рендеров.

   **Исправление:** точечные селекторы / `shallowEqual`, `React.memo`, цвет иконки через CSS-переменную вместо `useTheme`, `content-visibility:auto` для карточек.
10. **Модалки на каждый элемент списка:**
    - `TicketItem` монтирует `TicketModal` + `AuthModal` на каждый рейс (100 рейсов → 200 порталов);
    - `GalleryModal` — на каждый номер.

    **Исправление:** рендерить по `open` или одну модалку на список; `key=flight_pair_id`.
11. **`useAuth` в 7 компонентах** каждый повторяет `setAuth` из localStorage; `getMe` даёт новый объект `user`. Эффекты с deps `[user]` повторяют `getSupportChat(1)` и `fetchUnread()` и переподписывают сокет (вывод по коду).

    **Исправление:** восстановление только в `_app`; deps по `user?.id` и `token`.
12. **Шрифт:**
    - Google Fonts (блокирующий CSS) + локальный TTF 178 KB c неверным `format("woff2")`;
    - один источник через `next/font` (WOFF2 ~60–70 KB, cyrillic+latin, self-host).

    На проде ссылки на Google Fonts в HTML не видно — проверить в DevTools, какой файл реально грузится.
13. **LCP главной:** hero через `fetch(...?_=Date.now(), no-store)` → `new Image()` → CSS-фон после `onload`. **Исправление:** `<img fetchpriority="high" object-fit:cover>`. Опционально — hero с сервера + `<link rel=preload>` (компромисс с TTFB).
14. **Бронирование:**
    - на маунте и на сабмите грузится полный `Packagesflights` ради `fuel_charge` одной пары;
    - валидация всех туристов на каждый символ.

    **Исправление:** передать `fuel_charge` из `/tickets`, полный список — только как fallback; валидацию — по blur или с debounce.

### P2 — средний и малый эффект

15. **Главная: desktop и mobile рендерятся оба** (hotDeals, popularDestinations, partner) + `react-slick` инициализируется скрытым. `slick-theme.css` тянет шрифт slick и gif. **Исправление:** один вариант через `useIsDesktop`, `Slider` через dynamic, `settings` в константу или `useMemo`, без `slick-theme.css` (стрелки свои).
16. **Яндекс.Карта** монтируется сразу после номеров, даже ниже экрана. **Исправление:** `IntersectionObserver` (rootMargin 200px), до этого — тот же плейсхолдер.
17. **Тяжёлые PNG:**
    - `/images/layer.png` 188 KB, `girl.png` 196 KB;
    - `bannerApp.png` 69 KB (рядом лежит неиспользуемый `bannerApp.webp` на 9 KB), `bannerVtb.png` 126 KB;
    - в `public/images` PNG по 320–450 KB.

    **Исправление:** WebP/AVIF тех же размеров. `images.unoptimized:true` — оптимизации нет вообще.
18. **Яндекс Метрика** с `webvisor/clickmap` на `afterInteractive` → `lazyOnload`. Нужен ли Вебвизор на 100% сессий — решение бизнеса.
19. **Тема** применяется после загрузки JS (`utils/themeInit` в `_app`) — мигание светлой темы. **Исправление:** инлайн-скрипт в `_document`.
20. **Мелочи:**
    - `console.log('homeData')` на каждый рендер главной;
    - `resize`-листенеры без throttle (verticalSlide — неиспользуемый, filters, searchForm) → `matchMedia`;
    - `whereTo` перезапрашивает популярные направления при каждом открытии;
    - `sessionStorage.removeItem` внутри `useMemo`;
    - deps `[router]` в `pay` и `useStopSearchPollOnLeave`;
    - `dispatchSearch` в updater `setParams`.
21. **Зависимости:**
    - `i`, `npm` — мусор, удалить;
    - `react-calendar`, `react-range`, `react-yandex-maps`, `spark-md5`, `framer-motion`, `@tanstack/react-query` — проверить grep'ом, неиспользуемые удалить (на бандл влияют только при импорте);
    - `ignoreBuildErrors` прячет ошибки.
22. **`"use client"`** — в Pages Router не действует, на скорость не влияет.

## План внедрения (UI и функции не меняются)

| Этап | Что | Риск | Ожидаемый эффект |
|---|---|---|---|
| 1. Быстрые | п.3 (gSSP), п.4 (галерея), `console.log`, lazy-атрибуты картинок (п.5), дубль `/hotels-rooms` (п.8), шрифт (п.12), Метрика `lazyOnload` | низкий | TTFB главной, LCP отеля в разы, сеть на отеле и в выдаче |
| 2. Бандл | п.1–2: dynamic для блоков авторизованных, AuthModal, SearchForm; разбор реестра иконок | низкий/средний | `_app` −300–400 KB raw (оценка по исходникам, подтвердить `@next/bundle-analyzer`) |
| 3. Поиск | п.6–7: поколения + abort + `requestId` | средний | меньше запросов к LT, нет подмены результатов |
| 4. Ре-рендеры | п.9–11: селекторы, memo, модалки по open, `useAuth` | средний | INP на выдаче и перелётах |
| 5. Картинки и главная | п.13, 15–17: hero `<img>`, WebP, один вариант списка, карта по вьюпорту | низкий | LCP главной, трафик |

Замеры до и после: Lighthouse mobile (главная, выдача, отель), `@next/bundle-analyzer`, вкладка Network (число запросов `/search-status`, `/hotels-rooms`).
