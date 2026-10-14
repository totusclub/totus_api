# TOTUS — текущее состояние (STATUS)

**Обновлено:** 14.10.2026 — чат Cowork «Totus Dev» (согласия и ссылки под формами сайта + журнал согласий — totus_API #38, totus_WEB #77; шрифты приложения Museo Sans Cyrl + Forum — totus_APP #42; админка: «Application error» на заявках на звонок и обращениях — totus_API #37, Totus_admin #17; страница «Партнёры» и заявки партнёров в админке: totus_API #36, Totus_admin #16, totus_WEB #76; билеты на телефоне: вариант B — totus_WEB #75; главная на компьютере #74 слита) и чат «AI» (Мила: персональные данные не уходят в DeepSeek — totus_ai_v2 #6).
Регламент ведения — `claude/WORKFLOW_RU.md`. История — `claude/JOURNAL_RU.md`.

---

## 1. Сейчас в работе

Строку добавить при старте задачи, убрать при завершении.

| Чат | Задача | Репо / слой | С какого времени |
|---|---|---|---|
| этот | Согласия и ссылки под формами сайта (чекбоксы, cookie-баннер с отказом, Метрика по согласию, подвал) + журнал согласий на сервере — totus_API #38, totus_WEB #77; ждём слияния (API первым, `npm run migrate:consents`); дальше — приложения и уведомления в чате, звонке, Миле | totus_API, totus_WEB | 14.10 |
| этот | Шрифты приложения: Museo Sans Cyrl (текст) + Forum (заголовки, названия отелей) — PR totus_APP #42; ждём `npx react-native-asset`, сборки iOS / Android, проверки экранов и лицензии App на Museo | totus_APP | 14.10 |
| этот | Админка: «Application error» на /callback-requests и /order-requests (даты из API как `{}`) — totus_API #37 + Totus_admin #17; ждём слияния (API первым) и проверки страниц | totus_API, Totus_admin | 14.10 |
| этот | Страница «Партнёры» (/partners) + заявки «Стать партнёром» в админке — totus_API #36, Totus_admin #16, totus_WEB #76; ждём слияния (API → админка → сайт) и проверки отправки | totus_API, Totus_admin, totus_WEB | 14.10 |
| этот | Билеты на телефоне: вариант B «Билет» + багаж «обратно» и пересадка — PR totus_WEB #75; ждём слияния и проверки на телефоне | totus_WEB | 12.10 |
| «AI» | Мила: защита персональных данных — план согласован с решениями владельца (#5, `claude/AI_PII_GUARD_RU.md`), этап 1 реализован: блокировка любых персональных данных на сервере, маскирование restore, истории и журнала — totus_ai_v2 #6; ждём слияния (после #4) и деплоя (только API), затем `npm run pii:scrub -- --apply` | totus_ai_v2 | 12.10 |
| этот | Hero статикой (AVIF + WebP, public/hero) — PR totus_WEB #73 черновик: владелец собирает картинки скриптом и коммитит, затем слияние; Метрика #72 слита — ждём замера PageSpeed | totus_WEB | 11.10 |
| этот | Мобильная версия: аудит скорости готов (`claude/WEB_PERF_MOBILE_2026-10-11_RU.md`), план A–H ждёт согласования; срочно — LT недоступен, поиск/отель висят без таймаутов | totus_WEB, totus_API | 11.10 |
| этот | Главная, «Оставьте номер»: градиент слоя только CSS вместо layer.png — PR totus_WEB #71; ждём слияния и проверки | totus_WEB | 11.10 |
| этот | Страница отеля на телефоне (вариант C) + свой знак ₽ — #70 слит 11.10; ждём сборки и проверки на телефоне; вопрос: шире пробел тысяч? | totus_WEB | 09.10 |
| этот | Шрифты сайта: Museo Sans Cyrl (текст) + Forum (заголовки, названия отелей) вместо Golos Text — PR totus_WEB #69; ждём веб-лицензию Museo, слияния и проверки после сборки | totus_WEB | 09.10 |
| этот | Android: Mute/Unmute микрофона в звонке работает не на всех устройствах — разбор готов (`claude/ANDROID_MUTE_ANALYSIS_RU.md`), ждём обсуждения и логов с проблемного устройства | totus_APP | 09.10 |
| этот | Предложения из выдачи пропадают на странице отеля (кеш `no_results` у LT для поиска по одному отелю) — разбор готов (`claude/HOTEL_OFFERS_MISSING_RU.md`), ждём «добро» на план | totus_WEB | 09.10 |
| этот | Перелёты: лёгкий ответ `?view=list` (totus_API #34) + отмена устаревших запросов и пауза 400 мс на фильтры (totus_WEB #45); ждём слияния и проверки | totus_API, totus_WEB | 08.10 |
| этот | Сайт: билеты показываются частями (по 20, догрузка при прокрутке / «Показать ещё») — PR totus_WEB #44; ждём слияния и проверки | totus_WEB | 08.10 |
| этот | этот | Скорость сайта (`claude/WEB_PERF_AUDIT_2026-10-07_RU.md`): этап A (сервер) — PR totus_API #33 (слияние, `npm install`, `npm run optimize:images`); этап B (бандл) — totus_WEB #36 слит; PageSpeed C1–C2 — #37 слит (mobile 47 → 73, desktop 86 → 98); C3–C4 (#38), C6 (#39) слиты; mobile 66–73, CLS 0, TBT 90 мс; критический CSS — #41 слит, **сборка падала** (нужен critters, а не beasties) — исправление PR #42; для ускорения `npm install critters`; решения: кнопки, Метрика; план C1–C7 — `claude/PAGESPEED_PLAN_RU.md` (mobile 47 → цель 85–95+; решения: цвет кнопок, Метрика) | totus_API, totus_WEB | 07.10 |
| этот | Сайт: код доступа 1289 вместо 2103 — PR totus_WEB #40 (вводившим 2103 окно покажется снова); ждём слияния и деплоя | totus_WEB | 07.10 |
| этот | Сайт: снова код доступа 2103 при первом открытии (откат #17 по просьбе владельца) — PR totus_WEB #35; ждём слияния и деплоя | totus_WEB | 07.10 |
| этот | Навигация: «Назад» по истории (заказ поверх текущего экрана, история вкладок, без второго tab) — PR totus_APP #34; ждём сборки и проверки на устройствах | totus_APP | 06.10 |
| этот | Избранное: добавленное на сайте — в приложении без фото — PR calling_api_v2 #14 (нормализация картинок при записи и чтении) + totus_APP #33 + totus_WEB #34; ждём выката (сервер первым) | calling_api_v2, totus_APP, totus_WEB | 06.10 |
| этот | Сайт: профиль («Мои заказы») долго грузится — PR totus_WEB #33 (`?view=list`, один запрос, кэш вкладки) + totus_API #32 (поля суммы СБП в лёгком списке); ждём слияния (API первым) | totus_WEB, totus_API | 06.10 |
| этот | Заказы: больше минуты и ложное «Заказов нет» — PR totus_API #31 (`/user/orders?view=list`, лог `[ORDERS]`) + totus_APP #32 (список сразу из сохранённого, без ложного «нет»); #30 / #31 слиты; ждём выката, строк `[ORDERS]` и индексов | totus_API, totus_APP | 06.10 |
| этот | Android: push в закрытом приложении — PR calling_api_v2 #13 (push поддержки по устройствам) + totus_APP #30 (показ из headless, если система не показала); ждём выката и проверки | calling_api_v2, totus_APP | 06.10 |
| этот | Приложение: убран экран ввода PIN-кода (PasscodeModal, код 2103) — PR totus_APP #29; ждём слияния и сборки | totus_APP | 06.10 |
| этот | Android SDK 36 (Android 16) для Google Play — PR totus_APP #28; ждём сборки и проверки «Назад» / звонков на A15 | totus_APP | 05.10 |
| этот | Звонки: завершённый звонок «оживает», второй не приходит на телефоны — PR calling_api_v2 #11 (сервер) + totus_APP #21 (Android + iOS); ждём выката и проверки на устройствах (`claude/CALL_END_SYNC_RU.md`) | calling_api_v2, totus_APP | 05.10 |
| этот | Звонки: #9 слит; по находкам владельца — calling_api_v2 #10 + totus_APP #16 + support_app #3 (ждём выката и проверки всего flow); затем сайт / панель, Android, статусы | calling_api_v2, totus_APP, totus_support_app, totus_WEB, calling_v2 | 02.10 |
| этот | Футер v2 + /legal: #28 слит раньше доработок (на main «Скоро», Арлекинотур, «ПДн») — **срочно слить totus_WEB #29**; Totus_admin #14; totus_APP #17 | totus_WEB, Totus_admin, totus_APP | 05.10 |
| этот | «Мои заказы» медленно — диагностика готова, ждём замеры и «добро» владельца | totus_API `/user/orders`, totus_WEB профиль | 01.10 |

---

## 2. Открытые PR (сверено с GitHub 29.09, 21:00 UTC)

| PR | Что | Что нужно от владельца |
|---|---|---|
| [totus_API #38](https://github.com/tosmedia/totus_API/pull/38) | Журнал согласий: таблица `consent_log`, запись при успешных формах (звонок, регистрация, бронирование, партнёры), `POST /api/consents` для Яндекс ID; режим «только записывать» — старые приложения не ломаются; `check-consents` 12/12 в `npm run check` | **Первым**: слить, `npm run migrate:consents && pm2 restart api` |
| [totus_WEB #77](https://github.com/tosmedia/totus_WEB/pull/77) | Согласия под формами по утверждённому макету: отдельные чекбоксы (персональные данные, реклама, оферта / условия размещения), ссылки на документы; cookie-баннер «Настроить / Отклонить / Принять», Метрика только после согласия; подвал без заглушки РТА, «Настройки cookie» | После #38: `npm run check && npm run build && pm2 restart front`; пройти звонок, регистрацию, Яндекс ID, бронирование, партнёров; баннер cookie появится всем снова; РТА — `NEXT_PUBLIC_TOURAGENT_REGISTRY_NUMBER` |
| [totus_APP #42](https://github.com/tosmedia/totus_APP/pull/42) | Шрифты приложения как на сайте: Museo Sans Cyrl 300/500/700/900 для текста, Forum для заголовков и названий отелей; подключение прежнее (assets/fonts, ios/fonts + UIAppFonts, плюс android/app/src/main/assets/fonts); `check-app-fonts.mjs` 11/11 (не зарегистрирована); package.json не менялся | Лицензия App на Museo → слить → `npx react-native-asset` (или 5 файлов в target Xcode) → сборка iOS и Android; главная, выдача, отель, бронирование, заказы, Мила, поддержка в обеих темах |
| [totus_API #37](https://github.com/tosmedia/totus_API/pull/37) | Даты в ответах API снова ISO-строки, а не `{}` (`signDocUrlsDeep` учитывает `toJSON`); чинит падение админки на /callback-requests и /order-requests | **Первым**: слить, `npm run check`, `pm2 restart api`; `curl https://api.totus.club/api/admin/callback-requests` → `created_at` строкой |
| [Totus_admin #17](https://github.com/tosmedia/Totus_admin/pull/17) | Форматтеры дат на /callback-requests и /order-requests всегда возвращают строку (страховка от падения) | После #37: слить, `npm run build && pm2 restart front_admin`; открыть обе страницы |
| [totus_API #36](https://github.com/tosmedia/totus_API/pull/36) | Заявки партнёров: `POST /api/partner-requests` (публично, 5 заявок / 15 мин с IP, скрытое поле от ботов), `/api/admin/partner-requests` — список, статус, заметка, удаление (только staff); таблица `partner_requests` создаётся сама; `check-partner-requests` 8/8 в `npm run check` | **Первым**: слить, `npm run check`, `pm2 restart api` |
| [Totus_admin #16](https://github.com/tosmedia/Totus_admin/pull/16) | Раздел «Заявки партнёров» (`/partner-requests`): фильтр по статусу со счётчиками, поиск, карточка (почта, телефон, сообщение, заметка), статусы Новая / В работе / Договорились / Отклонена, удаление; обновление раз в минуту | После #36: слить, `npm run build && pm2 restart front_admin` |
| [totus_WEB #76](https://github.com/tosmedia/totus_WEB/pull/76) | Страница «Партнёры» по макету Figma (`2422:109219`): туроператоры, приём платежей, «Стать партнёром» + форма — заявка уходит в админку; CMS для /partners больше не используется; `check-partners-page.mjs` 7/7 (не зарегистрирована); package.json не менялся | После #36: squash merge → `npm run build && pm2 restart front`; отправить тестовую заявку с /partners и увидеть её в админке, затем удалить |
| [totus_ai_v2 #6](https://github.com/tosmedia/totus_ai_v2/pull/6) | Мила: персональные данные не уходят в DeepSeek и не хранятся в открытом виде — проверка входа, restore и каждого запроса к модели, маскирование истории, журнала, отзывов; `pii.rules` в `/api/health` | **После #4**: слить; `cd /home/totus_ai_v2 && git pull && npm install && npm run check && pm2 restart totus-ai-api`; проверить `pii` в `/api/health`; `npm run pii:scrub`, затем `npm run pii:scrub -- --apply` |
| [totus_ai_v2 #5](https://github.com/tosmedia/totus_ai_v2/pull/5) | Мила: защита персональных данных — исследование, план, решения владельца (только документ) | Слить (деплой не нужен) |
| [totus_WEB #75](https://github.com/tosmedia/totus_WEB/pull/75) | Билеты на телефоне (до 1024 px): вариант B «Билет» — сегменты как в билете, цена и «Выбрать» 44 на корешке, «Самый выгодный» сверху; рамки видны в тёмной; багаж «обратно» из обратного рейса, «С пересадкой» вместо пустой строки; компьютер без изменений; package.json не менялся | Squash merge → `npm run build && pm2 restart front`; билеты к туру на телефоне в обеих темах; `node scripts/check-tickets-mobile.mjs` |
| totus_WEB #74 (слит 12.10) | Главная на компьютере (шире 1024 px): вариант B «Строгий» — скругление 12, шаг 56, фото 16:10 / 3:2, направления 3 колонки; тёмная тема (белый на оранжевом, рамки #2c2c2c); форма поиска в колонке; телефон не меняется; package.json не менялся | Squash merge → `npm run build && pm2 restart front`; главная на компьютере в обеих темах; `node scripts/check-home-desktop.mjs` |
| totus_WEB #73 (слит 11.10) | Hero главной статикой: 3 картинки в public/hero, AVIF + WebP, случайный выбор на сервере сайта, без /api/home-hero; админка hero на сайт больше не влияет | `npm i --no-save sharp && node scripts/hero-assets.mjs` в ветке → `check-home-hero-static` 7/7 → commit public/hero → снять черновик → squash merge → `npm run build && pm2 restart front`; Network: `/hero/…avif`; PageSpeed mobile |
| totus_WEB #72 (слит 11.10) | Метрика после загрузки | PageSpeed mobile заново |
| [totus_WEB #71](https://github.com/tosmedia/totus_WEB/pull/71) | Главная, блок «Оставьте номер»: слой — CSS-градиент (linear + 3 radial) вместо `url(/images/layer.png)`, положение как у cover; без серой подложки и класса Loaded; проверки css-inline / home-mobile / pagespeed-c3 обновлены; package.json не менялся | Squash merge → `npm run build && pm2 restart front`; главная на компьютере и телефоне — блок «Оставьте номер»; `node scripts/check-pagespeed-c3.mjs && node scripts/check-css-inline.mjs && node scripts/check-home-mobile.mjs`; при желании удалить `public/images/layer.png` |
| totus_WEB #70 (слит 11.10) | Страница отеля на телефоне — вариант C «Без карточек» (до 1024 px); свой знак ₽ под Museo (data: в globals.css) и единая запись «270 802 ₽» по всему сайту; проверка `check-hotel-mobile.mjs`; package.json не менялся | Squash merge → `npm run build && pm2 restart front`; на телефоне: страница отеля в обеих темах, цены в поиске, на отеле, в билетах, в заказе; `node scripts/check-pagespeed-c3.mjs` и `check-hotel-mobile.mjs` |
| [totus_WEB #69](https://github.com/tosmedia/totus_WEB/pull/69) | Шрифты: Museo Sans Cyrl 300/500/700/900 для текста, Forum для заголовков и названий отелей, знаки ₽/стрелки из подмножества Golos; файлы в `src/assets/fonts`, без Google Fonts/CDN; package.json не менялся | Веб-лицензия Museo Sans Cyrl (заменить `MuseoSansCyrl-*.woff2` купленными, имена те же) → squash merge → `npm run build && pm2 restart front`; пройти страницы из PR на телефоне и компьютере, в обеих темах |
| totus_WEB #68 (слит) | Поиск на телефоне: шапка (колокольчик и фильтр без наложения), отступы 16/12, карточка 12/16 до 1024 px, загрузка по форме страницы, две колонки на планшете (утверждённый макет) | Squash merge → `npm run build && pm2 restart front`; проверить поиск на телефоне (вход, фильтры, загрузка, обе темы) |
| totus_WEB #66 (слит) | Главная на телефоне: единые отступы, фото 200/8 как в поиске, плавные карусели (нативная прокрутка), белый текст на фото в тёмной теме, нижнее меню с иконками приложения (утверждённый макет) | Squash merge → `npm run build && pm2 restart front`; пролистать главную на телефоне в обеих темах |
| [totus_WEB #65](https://github.com/tosmedia/totus_WEB/pull/65) | Мила на телефоне: чат на весь экран (макет утверждён) — поле над клавиатурой, без масштаба и сдвига вбок, «Назад» закрывает, «Мои чаты» со смахиванием; компьютер без изменений; пакет и package.json не менялись | Merge → деплой, проверить на iPhone (Safari) и Android (Chrome): открыть Милу, ввод с клавиатурой, туры, «Мои чаты», «Назад» |
| [totus_APP #41](https://github.com/tosmedia/totus_APP/pull/41) | Звонки: все надписи на экранах звонка по-русски (iOS SPEAKER/MUTE → ДИНАМИК/МИКРОФОН, «Входящий звонок», ошибки звонка, CallKit, Info.plist); VoipService не менялся; package.json не менялся | Merge → сборка iOS и Android, проверить звонок в поддержку и входящий |
| [totus_WEB #62](https://github.com/tosmedia/totus_WEB/pull/62) | Окна с фото: название отеля / номера в левой части шапки (package.json не меняется) | Squash merge → `npm run build && pm2 restart front` |
| totus_WEB #61 (слит) | Название в шапке окон с фото | — |
| totus_WEB #60 (слит) | Календарь «Даты и ночи» | `npm run build && pm2 restart front`, если ещё не выкачено |
| [totus_WEB #59](https://github.com/tosmedia/totus_WEB/pull/59) | Поиск на телефоне: «Сортировка» и «Показано N из M отелей» больше не накладываются (счётчик справа, при нехватке места — в две строки) | Squash merge → `npm run build && pm2 restart front`; проверить выдачу на телефоне |
| totus_WEB #58, #57 (слиты) | Фото карточки в мобильной выдаче высотой 200; «Свернуть» звонок | `npm run build && pm2 restart front`, если ещё не выкачено |
| totus_APP #40 | Android: поле ввода Милы (AI) над клавиатурой (как в чате поддержки) | Merge → Android-сборка, проверить экран Милы |
| totus_APP #39 | Android: экран чата поддержки уменьшается на высоту клавиатуры нативно (как adjustResize) | Merge → полная пересборка Android (нативный код), проверить чат и другие экраны с полями ввода |
| totus_WEB #53 | Тема Светлая / Тёмная / Системная в профиле (по умолчанию Системная), без белой вспышки | Squash merge → `npm run build && pm2 restart front` |
| totus_APP #35 | Тема Светлая / Тёмная / Системная в «Аккаунте» (по умолчанию Системная) | Merge → новая сборка iOS/Android |
| [totus_WEB #50](https://github.com/tosmedia/totus_WEB/pull/50) | **Срочно:** вернуть показ картинки hero на главной (стили потеряны при слиянии #49) | Слить, `npm run build && pm2 restart front`; проверить главную |
| [totus_WEB #49](https://github.com/tosmedia/totus_WEB/pull/49) | Поле «Куда»: список стран сразу по нажатию, картинки для всех 57 стран, фокус на телефоне | Слить (squash; если после #48 — конфликт в строке `check`, оставить обе), `npm run build && pm2 restart front` |
| [totus_WEB #48](https://github.com/tosmedia/totus_WEB/pull/48) | Страница отеля на телефоне: аккуратный блок предложений номера (утверждённый макет) | Слить (squash), `npm run build && pm2 restart front`; проверить на телефоне |
| [totus_API #35](https://github.com/tosmedia/totus_API/pull/35) | Hero: мобильная версия картинки `<файл>.m.webp` (~50 КБ), поле `image_mobile` в `/api/home-hero`, создаётся в фоне | Слить, `pm2 restart api`; проверить `image_mobile` в ответе и `[HERO] mobile` в логе |
| [totus_WEB #47](https://github.com/tosmedia/totus_WEB/pull/47) | Главная на телефоне: hero из мобильной версии, фото отелей после загрузки (LCP) | Слить, `npm run build && pm2 restart front`; PageSpeed mobile |
| [totus_WEB #46](https://github.com/tosmedia/totus_WEB/pull/46) | Главная на телефоне: первая карточка в слайдерах «Начните планирование» / «Популярные направления» не обрезана (`infinite: false` на < 480 px) | Слить, `npm run build && pm2 restart front`; проверить главную на телефоне |
| [totus_APP #34](https://github.com/tosmedia/totus_APP/pull/34) | «Назад» по истории: `backBehavior="history"`, `orderDetails` поверх текущего экрана, без второго `tab`, без копий `checkout` / `ticketDetails`, отель из «Избранного» в «Аккаунте» | Сборка; сценарии из PR на Android и iPhone; слияние |
| [calling_api_v2 #14](https://github.com/tosmedia/calling_api_v2/pull/14) | Избранное: у каждой картинки `uri` при записи и чтении (старые записи и старые приложения — с фото) | **Первым**: слить в `prod`, `npm run check`, `pm2 restart api_calling` |
| [totus_APP #33](https://github.com/tosmedia/totus_APP/pull/33) | Избранное: любой формат картинки → `{uri}`, сохраняются только переносимые картинки | Сборка, сценарии из PR |
| [totus_WEB #34](https://github.com/tosmedia/totus_WEB/pull/34) | Избранное: сайт сохраняет и `uri` | `npm run build`, `pm2 restart front` |
| [totus_API #32](https://github.com/tosmedia/totus_API/pull/32) | Лёгкий список: поля суммы и назначения платежа СБП для сайта | Слить **до** totus_WEB #33, `pm2 restart api` |
| [totus_WEB #33](https://github.com/tosmedia/totus_WEB/pull/33) | Профиль: `/user/orders?view=list`, один запрос, список сразу из кэша вкладки, без ложного «Заказов нет» | После API #32: слить, `npm run build`, `pm2 restart front`; проверить СБП в карточке |
| [totus_API #31](https://github.com/tosmedia/totus_API/pull/31) (слит) | `/user/orders?view=list` — только поля карточки (< 3 КБ на заказ); без `view` ответ прежний; лог `[ORDERS]` | Слить, `pm2 restart api`; прислать строки `[ORDERS]`; `add-orders-indexes.js --apply` при нехватке |
| [totus_APP #32](https://github.com/tosmedia/totus_APP/pull/32) | Заказы: `?view=list`, список сразу из сохранённого, без таймаута с потерей ответа, без ложного «Заказов нет» | После API #31: сборка, сценарии из PR |
| [totus_API #30](https://github.com/tosmedia/totus_API/pull/30) (слит) | `/user/orders`: документы всех заказов одним запросом (ответ тот же); `scripts/add-orders-indexes.js` | Слить, `npm run check`, `pm2 restart api`; `node scripts/add-orders-indexes.js` (при нехватке — `--apply`); проверить gzip nginx |
| [totus_APP #31](https://github.com/tosmedia/totus_APP/pull/31) (слит) | Заказы: безопасные даты (падение), без тел ответов в логах, один запрос при обновлении токена, таймаут 30 с, кэш списка на сессию, memo карточек | Сборка, сценарии из PR; слияние |
| [calling_api_v2 #13](https://github.com/tosmedia/calling_api_v2/pull/13) | Push поддержки доходит до закрытого телефона, даже если открыт сайт / iPhone (решение по каждому устройству, `presence.js`); миграций нет | Слить в `prod`, `npm run check`, `pm2 restart api_calling` |
| [totus_APP #30](https://github.com/tosmedia/totus_APP/pull/30) | Android: push в закрытом приложении — показ из headless-обработчика, если система не показала (без дублей); сокеты сообщают `presence` / `deviceId` | После #13: сборка, сценарии из PR (смахнуть из недавних, не «Остановить»); слияние |
| [totus_WEB #25](https://github.com/tosmedia/totus_WEB/pull/25) | Производительность, этап 1: фото отеля сразу, lazy-картинки, без дубля `/hotels-rooms` (UI не меняется) | `npm run build`, проверка страницы отеля и главной, слияние, `pm2 restart front` |
| [calling_api_v2 #11](https://github.com/tosmedia/calling_api_v2/pull/11) | Звонки на все телефоны аккаунта (таблица `call_devices`), отменяющий push `call_ended` (FCM + APNs VoIP), «надгробия» звонков 24 ч | **Первым**: слить в `prod`, `npm run check`, `pm2 restart api_calling`; при первом старте создаётся таблица `call_devices` (нужно право CREATE у пользователя БД) |
| [totus_APP #21](https://github.com/tosmedia/totus_APP/pull/21) (слит 04.10) | Завершённый звонок не возвращается как входящий: `call_ended`, сверка с сервером, вытеснение «звонящего», 65 с; iOS AppDelegate — отмена в CallKit | После #11: сборки Android + iOS, 8 сценариев из PR на A15 + iPhone + сайт; слияние |
| [totus_APP #29](https://github.com/tosmedia/totus_APP/pull/29) | Убран экран ввода PIN-кода (2103) на вкладке «Поиск»; вход по коду из письма не тронут | Слияние, сборка; проверка начисто (удалить → установить → онбординг → «Поиск» без пароля) |
| [totus_APP #28](https://github.com/tosmedia/totus_APP/pull/28) | Android: compileSdk / targetSdk 36; opt-out predictive back (RN 0.79) и ресайза на планшетах; versionCode / ключ загрузки из `TOTUS_*` | SDK Platform 36 + Build-Tools 36.0.0, `bundleRelease`, проверка на A15, Play Console; слияние |
| [totus_APP #27](https://github.com/tosmedia/totus_APP/pull/27) (слит) | iOS: без повторного «входящего» после ответа на Android (заглушка только в фоне без звонка, JS оставляет звонящий вызов отменяющему push); имя звонящего при ответе из CallKit; RN в фоне после отчёта в CallKit | Сборка в Xcode, 3 сценария из PR; слияние |
| [totus_APP #26](https://github.com/tosmedia/totus_APP/pull/26) (слит) + `287e83d4` | iOS: VoIP push всегда доходит до CallKit — отчёт прямо в `CXProvider` (без тихого no-op RNCallKeep), completion из ответа CallKit, один `PKPushRegistry`, лог `[TotusVoIP]` | Сборка в Xcode (Swift здесь не собирается), TestFlight, закрытое + заблокированное приложение → звонок из support app; при сбое — Console.app `TotusVoIP`; слияние |
| [totus_APP #25](https://github.com/tosmedia/totus_APP/pull/25) (слит) | iOS: нативная настройка CallKit до PushKit | Сбой повторился — продолжение в #26 |
| [totus_APP #24](https://github.com/tosmedia/totus_APP/pull/24) (слит) | iOS: отменяющий push — completion до завершения CallKit | Проверить вместе с #25 |
| [totus_APP #23](https://github.com/tosmedia/totus_APP/pull/23) (слит) | iOS: UUID CallKit в нижнем регистре, удалённый конец — reportEndCall | Проверить вместе с #24 |
| [calling_api_v2 #12](https://github.com/tosmedia/calling_api_v2/pull/12) (слит) | Повторное подключение `call_devices`, телефоны звонка в логе | Проверить в логе `[call-devices] table ready` и `phones of user` |
| [totus_APP #22](https://github.com/tosmedia/totus_APP/pull/22) (слит) | Одно окно звонка (звонок из «Аккаунта») | Проверить на устройствах |
| [totus_APP #20](https://github.com/tosmedia/totus_APP/pull/20) (слит) | Android: входящий глушится громкостью / питанием (self-managed Telecom, UI наш) | Проверка на A15 (особенно «Динамик») |
| [totus_APP #19](https://github.com/tosmedia/totus_APP/pull/19) (слит 04.10) | Android: свой экран звонка вместо системного Telecom (Kotlin + JS), микрофон по кнопке, сброс без «воскрешения» | `./gradlew assembleDebug`, таблица сценариев в PR на A15; декларации Play Console (full-screen intent, FGS microphone); слияние |
| [calling_api_v2 #10](https://github.com/tosmedia/calling_api_v2/pull/10) | Устаревший `ended` не обрывает новый звонок (исправление #9), поздний `/end`, «пропущенный» после 61 с | **Первым**: squash-merge в `prod`, `npm run check`, `pm2 restart api_calling` |
| [totus_APP #16](https://github.com/tosmedia/totus_APP/pull/16) | Сверка `callId`, loyaltyId без пробелов, 4xx на ответ → отбой, watchdog 20 с без медиа | После #10: squash-merge, TestFlight, сценарии из PR |
| [totus_support_app #3](https://github.com/tosmedia/totus_support_app/pull/3) | То же для Support (звонящий) | После #10: squash-merge, TestFlight |
| [totus_support_app #2](https://github.com/tosmedia/totus_support_app/pull/2) | Звонки, этап 1: `VoipService.ts` из PR #1 + ранний запрос микрофона (iOS) | `npm run check`, сборка, TestFlight, чек-лист в PR; слияние |
| [totus_APP #14](https://github.com/tosmedia/totus_APP/pull/14) | Звонки, этап 1: ранний запрос микрофона (iOS) | Сборка, TestFlight, проверка первого звонка после установки; слияние |
| [totus_support_app #1](https://github.com/tosmedia/totus_support_app/pull/1) — слит 30.09 без `VoipService.ts` | iOS: ответ из закрытого / фона / экрана блокировки | Файл добавлен в #2 — патч вручную применять не нужно |
| [calling_api_v2 #7](https://github.com/tosmedia/calling_api_v2/pull/7) — **слит в `prod` 30.09** | VoIP-пуши iOS для Totus Support (доп. APNs topic) | Проверить деплой: в логе pm2 строка `[apn] multi-topic VoIP enabled` |
| ветка [`claude/docs-sync`](https://github.com/tosmedia/totus_API/tree/claude/docs-sync) (постоянная, без PR) | Зеркало документов проекта в `totus_API/docs`, обновляется после каждого изменения | Решить по чувствительным данным (см. JOURNAL 01.10) |
| ветка [`claude/company-docs`](https://github.com/tosmedia/totus_WEB/tree/claude/company-docs) (totus_WEB, без PR) | Юридические документы ТОТУСКЛАБ, пачка 1: исходники + HTML в `company_docs/`; на сайт не выкладывается | Решить, когда открывать PR в `main` (после заполнения полей и юриста) |
| [totus_API #28](https://github.com/tosmedia/totus_API/pull/28), [Totus_admin #13](https://github.com/tosmedia/Totus_admin/pull/13), [totus_WEB #27](https://github.com/tosmedia/totus_WEB/pull/27) — **слиты и развёрнуты 05.10** | Юридические документы ТОТУСКЛАБ: 7 страниц на сайте, тексты в CMS загружены 05.10 | Проверено: все 7 адресов totus.club показывают новые тексты |
| [totus_WEB #29](https://github.com/tosmedia/totus_WEB/pull/29) (исправляет слитый #28) | /legal без «Готовятся/Скоро», 7 документов; футер без Арлекинотура; полные названия без «ПДн» в хлебных крошках, меню профиля | **Срочно**: слить, `npm run build`, `pm2 restart front` |
| [Totus_admin #14](https://github.com/tosmedia/Totus_admin/pull/14) | Каталог страниц: названия без «ПДн» | Слить, `npm run build`, `pm2 restart front_admin` |
| [totus_APP #17](https://github.com/tosmedia/totus_APP/pull/17) | Экран «Документы» (7 документов из CMS) для iPhone, iPad, Android; офлайн-копия политики — оператор ТОТУСКЛАБ | Слияние, сборки TestFlight / Google Play / RuStore |
| [totus_API #24](https://github.com/tosmedia/totus_API/pull/24) | CORS: свой режим, 403, Origin десктопа, exposedHeaders, maxAge | Ревью и слияние |
| [totus_desktop #6](https://github.com/tosmedia/totus_desktop/pull/6) | macOS codesign: entitlements для helper-процессов | Ревью и слияние |

Всё остальное за сентябрь (84 PR) слито.

---

## 3. Слито 29.09 — состояние развёртывания

| PR | Что | Развёрнут? |
|---|---|---|
| [totus_ai_v2 #2](https://github.com/tosmedia/totus_ai_v2/pull/2) | Мила: все фильтры Level.Travel + живой тон | **Не подтверждено**: `/api/health` Милы не показывает версию. Нужно: `git pull && npm run build && pm2 restart totus-ai-api totus-ai-web` (имена по оркестратору; сверить в `pm2 list`), затем проверить в чате запрос «Турция 5★ с аквапарком, Анталья» |
| [totus_API #26](https://github.com/tosmedia/totus_API/pull/26) | Регистрация из приложения: «Signup failed» | **Не подтверждено**. После деплоя, если ошибка повторится: `pm2 logs api --lines 2000 --nostream \| grep "\[SIGNUP\]"`. Корневая причина не подтверждена логами |
| [totus_API #25](https://github.com/tosmedia/totus_API/pull/25) | Hero: неограниченный список изображений, случайный выбор | **Да** — `GET /api/home-hero` отдаёт `images_count: 3` |
| [Totus_admin #12](https://github.com/tosmedia/Totus_admin/pull/12) | Админка: управление изображениями hero | Не подтверждено (админка снаружи не проверялась) |
| [totus_WEB #24](https://github.com/tosmedia/totus_WEB/pull/24) | Hero Desktop 500px, контент прижат к низу | **Да** — на totus.club есть класс `heroTitle_desktopContent` |
| [totus_WEB #23](https://github.com/tosmedia/totus_WEB/pull/23), [#22](https://github.com/tosmedia/totus_WEB/pull/22), [#21](https://github.com/tosmedia/totus_WEB/pull/21) | Заголовок hero в Header, Footer в мобильной версии, hero только с бэкенда | Да (та же сборка сайта, что и #24) |
| [totus_WEB #20](https://github.com/tosmedia/totus_WEB/pull/20), [#19](https://github.com/tosmedia/totus_WEB/pull/19) | Раскладка RU↔EN в поиске и в поле «Откуда?» | Вероятно да (та же сборка), отдельно не проверялось |
| [totus_WEB #18](https://github.com/tosmedia/totus_WEB/pull/18), [#17](https://github.com/tosmedia/totus_WEB/pull/17) | Hero только с бэкенда; убрано окно PIN при первом входе (**PIN возвращается в totus_WEB #35, 07.10**) | Вероятно да, отдельно не проверялось |

---

## 4. Долги и незавершённое

| # | Что | Откуда | Что сделать |
|---|---|---|---|
| D1 | Figma: 4 кадра Desktop 1440 (Light/Dark, гость/авторизован) в разделе «Home · Заголовок hero в Header» (node `2224:105678`, файл `u6A5og35jw0BBJyOkKl8Ij`) показывают hero **350px** по центру, а в коде **500px + flex-end** | totus_WEB #24; коннектор Figma требовал повторного входа | Переподключить Figma, обновить кадры (высота 500, выравнивание вниз, отступы 48/48) и заметку-спецификацию `2225:105791` |
| D2 | Проверки остались во временной папке, в репозитории их нет: регистрация (totus_API #26), фильтры Милы (totus_ai_v2 #2) | Нарушение шага 4 регламента (до его введения) | С «добро» владельца: `scripts/check-signup.js` в totus_API (+ в `npm run check`); `scripts/check-lt-filters.ts` + скрипт `check` в totus_ai_v2 |
| D3 | Мила: нет маркера версии в `/api/health` — нельзя проверить, что задеплоено | Выявлено 29.09 | Добавить `BUILD_TAG` / хэш коммита в ответ health (отдельная задача, с «добро») |
| D4 | Регистрация: реальная причина «Signup failed» не подтверждена логами | totus_API #26 | Владелец: после деплоя проверить регистрацию из приложения; при ошибке прислать строку `[SIGNUP]` |
| D5 | Доска Totus Dev Board не обновлялась задачами 29.09 (hero, раскладка, регистрация, Мила) | Оркестратор §3.6 | Внести задачи и отметить «готово» |
| D6 | Безопасность: `AUTH_MODE=enforce` не включён | `claude/SECURITY_ENFORCE_MATRIX_RU.md` | Три клиентские правки + решение по гостевому бронированию |
| D7 | Приложение поддержки: Firebase `club.totus.support`, App ID Apple, сборка | `claude/SUPPORT_APP_STATUS_RU.md` | Владелец |
| D8 | Хвосты Б.1: удалить TURN-пользователя `test` после релиза приложения, перепубликовать `pkg/*`, webhook-ключ LT, GitHub Advanced Security | `claude/ROADMAP_RU.md`, `claude/SECURITY_AUDIT_SECRETS_RU.md` | Владелец |
| D9 | Косметика: в totus_ai_v2 `server/llm.ts` escape ` ` в регэкспе стал самим символом NBSP (поведение то же) | totus_ai_v2 #2 | При следующей правке файла вернуть ` ` |
| D10 | totus_APP: тот же `VoipService.ts` (исходник порта) — вероятно, та же ошибка ответа из закрытого приложения на iOS и повторная обработка ответа | Выявлено 30.09 при разборе Support App | После проверки фикса в Support App на устройстве перенести в totus_APP отдельным PR (с «добро») |
| D11 | Юридическое: у ООО «ТОТУСКЛАБ» нет номера в реестре турагентов — без него оферта на туры неполная (у Ozon Travel РТА указан в п. 2.2 оферты) | 01.10, разбор документов Ozon Travel | Владелец: выяснить у Level.Travel, вносит ли он ТОТУСКЛАБ в реестр как субагента |
| D12 | Юридические тексты пачки 1 опубликованы как есть 03.10: 58 мест `[[…]]` (на сайте видны в скобках; список — артефакт «Документы Totus Club», раздел «Чего не хватает»). Осталось: РТА, номер РКН, контакты, хостинг, ОФД, юрлицо Level.Travel, провайдер LLM, запись звонков, правообладатель ПО, даты) | 01.10, артефакт «Документы Totus Club»; `company_docs/` в totus_WEB | Владелец присылает данные → подстановка в `claude/legal` и `company_docs` → `cms_build.py` → загрузка в CMS (`POST /api/admin/pages/save` из сессии админки, сверка blob SHA) → юрист |
| D13 | В футере сайта в колонке реквизитов — ООО «Арлекинотур» вместо ООО «ТОТУСКЛАБ» | 03.10, totus_WEB #27 | Закрывается totus_WEB #28 (после деплоя) |
| D14 | Пачка 2 опубликована 06.10: 5 новых страниц и обновлённые terms / requisites / privacy-policy / consent в CMS, SHA сверены; /legal — 12 документов | 06.10 | Сборка приложения с totus_APP #17; заполнить поля `[…]`; юрист |
| D15 | totus_APP: Android-дерево в Git неполное (нет MainActivity, Gradle-файлов, ресурсов) — сборка только из локального дерева разработчика | 03.10, `claude/ANDROID_STABILITY_PLAN_RU.md` | Владелец: закоммитить реальное `android/` (этап 0–1 плана) |

---

## 5. Проверки (наборы тестов)

| Репо | Набор | Размер на 30.09 |
|---|---|---|
| totus_API | `npm run check` | `node --check app.js` + 13 скриптов `scripts/check-*.js` (auth-core, notify-hub, custom-rooms ×5, operators, yandex-auth, phone, order-docs, home-hero) |
| totus_ai_v2 | `npm run check` (ветка #6, включает #4) | 4 скрипта: `check-pii` (171 фраза + маскирование), `check-hotel-facts` (7), `check-human-tone` (4), `check-mila-flow` (10) |
| totus_support_app | `npm run check` (Node ≥ 22.18) | 2 скрипта, 24 проверки: `check-voip-answer-recovery` (16, проходят только с `VoipService.ts` из #2), `check-mic-permission` (8, ветка `claude/voip-stage1`) |
| calling_api_v2 | `npm run check` | + `check-multi-device-calls.js` (17, в prod) + `check-call-lifecycle.js` (15) + `check-call-end-sync.js` (14, в prod) — на настоящем `index.js`; + `check-push-presence.js` (11, ветка #13) |
| totus_APP | `npm run check` (Node ≥ 22.18) | в main: `check-mic-permission` (9), `check-voip-answer-recovery` (15), `check-android-firebase-guard` (8), `check-android-call-flow` (17); `check-call-end-sync` (40) + `check-call-modal-owner` (4) + `check-ios-voip-push` (10) + `check-android-sdk36` (7, ветка #28); + `check-android-killed-push` (14, ветка #30) |
| totus_WEB | `npm run check` (Node ≥ 22.18) | 1 скрипт, 10 проверок: `scripts/check-perf-stage1.mjs` (в ветке PR #25) |
| totus_API (ветка #28) | + `check-cms-legal-pages.js` | 13 проверок |
| Totus_admin | `npm run check` (ветка #13) | 1 скрипт, 9 проверок: `check-legal-pages.mjs` |
| totus_WEB (ветка #27) | + `check-legal-pages.mjs` | 23 проверки |
| totus_APP (ветка #17) | + `check-legal-docs.mjs` | 14 проверок; весь check 38 |
| totus_desktop, calling_v2 | не заведены | — |

---

## 6. Прод-сервисы (из `docs/CLAUDE_ORCHESTRATOR_RU.md` §7)

| URL | Репо | Порт | PM2 | Маркер версии |
|---|---|---|---|---|
| https://totus.club | totus_WEB | 3000 | front | CSS-классы / чанки Next в HTML |
| https://api.totus.club | totus_API | 3001 | api | новые поля ответов (например `images_count` в `/api/home-hero`) |
| https://apiv2.totus.club / https://ai.totus.club | totus_ai_v2 | 3011 / 3012 | totus-ai-api / totus-ai-web | нет (D3) |
| https://voip.totus.club | calling_api_v2 (ветка `prod` — основная для прода; `claude/*` от `prod`, PR в `prod`) | 4444 | api_calling | — |
| https://calling.totus.club | calling_v2 | 3008 | front_calling | — |
| admin.totus.club | Totus_admin | 3009 | front_admin | — |

Сервер `109.73.206.121`. Сливает и деплоит только владелец.

---

## 7. Тематические документы (где подробности)

- **Hero:** `claude/HERO_IMAGES_RU.md`
- **Мила, защита персональных данных:** `claude/AI_PII_GUARD_RU.md` (исследование, архитектура, план этапов 1–3, вопросы В1–В7)
- **Мила, фильтры:** `claude/MILA_LT_FILTERS_RU.md`
- **Room Type / Arlekino:** `claude/CUSTOM_ROOMS_STATUS_RU.md`
- **Push:** `claude/PUSH_NOTIFICATIONS_STATUS_RU.md`
- **Support Chat:** `claude/SUPPORT_CHAT_STATUS_RU.md`
- **Приложение поддержки:** `claude/SUPPORT_APP_STATUS_RU.md`
- **Яндекс ID:** `claude/YANDEX_AUTH_STATUS_RU.md`
- **Безопасность:**
  - `claude/SECURITY_AUDIT_2026-09_RU.md`
  - `claude/SECURITY_ENFORCE_MATRIX_RU.md`
  - `claude/SECURITY_JWT_PLAN_RU.md`
- **Юридическое:**
  - `claude/LEGAL_DOCS_RU.md`
  - `claude/TOTUSKLAB_DOCS_RU.md`
  - `claude/OZON_TRAVEL_REF_RU.md` — документы Ozon Travel как образец (артефакт «Документы Ozon Travel»)
  - `claude/legal/*.md` — тексты документов ТОТУСКЛАБ, пачка 1 (артефакт «Документы Totus Club», https://claude.ai/artifact/Xt4nZ2vbZuP93GAcV7BeMS); копия с HTML — `totus_WEB/company_docs` (ветка `claude/company-docs`)
- **Главная на компьютере:** `claude/HOME_DESKTOP_RU.md` (разбор и варианты, 12.10; артефакт «Главная на компьютере» — https://claude.ai/artifact/CeYPR5tHTtR8ycAkeXyqU4)
- **Билеты на телефоне:** `claude/TICKETS_MOBILE_RU.md` (разбор и варианты, 12.10; артефакт «Билеты на телефоне» — https://claude.ai/artifact/AmxpF3yQGGWU9JMvtUnt4X)
- **Производительность сайта:** `claude/WEB_PERF_MOBILE_2026-10-11_RU.md` (мобильная, 11.10), `claude/WEB_PERF_AUDIT_RU.md` (аудит 01.10; этап 1 — PR totus_WEB #25)
- **Android-стабилизация:** `claude/ANDROID_STABILITY_PLAN_RU.md` (анализ 03.10, план этапов 0–7)
- **QA перед запуском:** `claude/QA_LAUNCH_PLAN_RU.md` (план, ждёт решений Р1–Р8); трекер-артефакт «Totus QA к запуску» — https://claude.ai/artifact/DH2T4AxM8nVb2Spa1pEBSX
- **План и вопросы:**
  - `claude/ROADMAP_RU.md`
  - `claude/QUESTIONS_RU.md`
- **Правила чатов:** `docs/CLAUDE_ORCHESTRATOR_RU.md`
