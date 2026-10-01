# TOTUS — дизайн-система Ref (единая для веба и приложения)

Собрана 27.08.2026 в файле **TOTUS-CLUB-Design-System** (`WzBOCuSHW91ByNBgE2fhFd`).
Оригинальные коллекции `◉ Color Mode` (32), `Radius` (8), `Sizes` (17) **не изменялись**.

| Коллекция | Режимы | Переменных |
|-----------|--------|-----------|
| `◉ Color Mode Ref` | ☼ Light Mode, ☾ Dark Mode | 39 |
| `Radius Ref` | Mode 1 | 10 |
| `Sizes Ref` | Mode 1 | 17 |

---

## 1. Принципы

1. **Источник истины — продакшн по реальному применению.** Токен входит в систему, если что-то красит в коде или в макетах. Пять «спорных» токенов (`primary_a`, `secondary_blue`, `primary_orange`, `primary_pink`, `glassPrimary`) в вебе не применяются ни разу — значения взяты из макета.
2. **Одна тёмная тема на обе платформы.** Раньше веб был тёмно-серым (`#141414`), приложение — чёрным (`#000000`), шкалы серых разные.
3. **Контраст проверен.** Норма для обычного текста — 4.5:1.
4. **Новых цветов не выдумывали.** Статусы в тёмной теме — существующие `secondary_*`.
5. **Парность `primary` / `secondary`** восстановлена для всех оттенков.

---

## 2. Что исправлено в цветах

| Было | Стало | Почему |
|------|-------|--------|
| `textTertiary` dark `#7a7a7a` — контраст **4.29** | **`#a3a3a3`** — 7.30 | не проходил норму 4.5:1 |
| `textDisabled` dark `#3d3d3d` — контраст **1.70** | **`#5a5a5a`** — 2.67 | был практически неразличим |
| `borderTertiary` dark `#1f1f1f` — контраст **1.12** | **`#2a2a2a`** — 1.28 | граница сливалась с фоном |
| `secondary_blue` dark = `#fe732e` (**оранжевый**) | `#61aaf2` | ошибка заведения |
| `primary_a` dark = `#1f1f1f` | `#111111` | тёмный режим не был заполнен |
| `primary_orange` = `#fe732e` (дубль `core_orange`) | `#c2410b` | восстановлена пара primary/secondary |
| `secondary_orange` — **отсутствовал** | `#fa8842` | применяется в `button`, `cookieConsent` |
| `primary_blue` — **отсутствовал** | `#0d77d3` | применяется в `orderDisplay`, `profile`, `appsLanding` |
| `Color/Core/Color` — без имени | `secondary_pink` `#f285c5` | встала в пару к `primary_pink` `#d941bf` |
| `primary_barand_orange` + `secondary_barand_orange` | один `brand_orange` `#e1732e` | опечатка и дубль |
| `Smooth` и `Smooth 2` — оба 16 | один `Smooth` = 16 | дубль убран |
| `Sizes`: имя `104`, значение **112** | `112` | имя приведено к значению |

**Добавлены роли из приложения:** `bgElevated`, `overlay`. **Добавлена группа `Color/Semantic`:** `brand`, `error`, `warning`, `success`.

---

## 3. Полный состав `◉ Color Mode Ref`

### Color/Core — палитра (19)

| Переменная | ☼ Light | ☾ Dark |
|---|---|---|
| `primary_a` | `#1f1f1f` | `#111111` |
| `primary_b` | `#ffffff` | `#ffffff` |
| `core_orange` | `#fe732e` | `#fe732e` |
| `primary_orange` | `#c2410b` | `#c2410b` |
| `secondary_orange` | `#fa8842` | `#fa8842` |
| `brand_orange` | `#e1732e` | `#e1732e` |
| `primary_blue` | `#0d77d3` | `#0d77d3` |
| `secondary_blue` | `#61aaf2` | `#61aaf2` |
| `primary_red` | `#cf3030` | `#cf3030` |
| `secondary_red` | `#f26161` | `#f26161` |
| `primary_green` | `#288556` | `#288556` |
| `secondary_green` | `#39bf87` | `#0dd6a4` |
| `primary_yellow` | `#ce8508` | `#ce8508` |
| `secondary_yellow` | `#facd64` | `#facd64` |
| `primary_purple` | `#7e24b2` | `#7e24b2` |
| `secondary_purple` | `#a985f2` | `#a985f2` |
| `primary_pink` | `#d941bf` | `#d941bf` |
| `secondary_pink` | `#f285c5` | `#f285c5` |
| `glassPrimary` | `#8080804d` | `#8080804d` |

### Color/Semantic — смысловые (4, алиасы)

| Переменная | ☼ Light | ☾ Dark |
|---|---|---|
| `brand` | → `core_orange` | → `core_orange` |
| `error` | → `primary_red` `#cf3030` | → `secondary_red` `#f26161` |
| `warning` | → `primary_yellow` `#ce8508` | → `secondary_yellow` `#facd64` |
| `success` | → `secondary_green` `#39bf87` | → `secondary_green` `#0dd6a4` |

### Color/Background (7)

| Переменная | ☼ Light | ☾ Dark |
|---|---|---|
| `bgPrimary` | `#ffffff` | `#141414` |
| `bgSecondary` | `#f5f5f5` | `#1f1f1f` |
| `bgTertiary` | `#b6b6b6` | `#7a7a7a` |
| `bgElevated` | `#ffffff` | `#1f1f1f` |
| `bgDisabled` | `#f5f5f5` | `#1f1f1f` |
| `bgActive` | `#e0e0e0` | `#3d3d3d` |
| `overlay` | `#1f1f1f94` (58%) | `#000000cc` (80%) |

### Color/Content, Border, Hover (9)

| Переменная | ☼ Light | ☾ Dark | Контраст в тёмной |
|---|---|---|---|
| `textPrimary` | `#1f1f1f` | `#ffffff` | 18.42 |
| `textSecondary` | `#3d3d3d` | `#b8b8b8` | 9.29 |
| `textTertiary` | `#7a7a7a` | `#a3a3a3` | 7.30 |
| `textDisabled` | `#b8b8b8` | `#5a5a5a` | 2.67 |
| `textPrimaryB` | `#ffffff` | `#1f1f1f` | — |
| `borderPrimary` | `#1f1f1f` | `#7a7a7a` | 4.29 |
| `borderSecondary` | `#b8b8b8` | `#3d3d3d` | 1.70 |
| `borderTertiary` | `#e0e0e0` | `#2a2a2a` | 1.28 |
| `hoverPrimary` | `#e2e2e2` | `#4c4c4c` | — |

### Radius Ref (10)

`Sharp` 0 · **`Micro` 2** · **`Fine` 4** · `Firm` 8 · `Firm 2` 12 · `Smooth` 16 · `Round` 20 · **`Wide` 24** · `Round 2` 40 · `Circular` 200

Три радиуса добавлены потому, что реально применяются в коде и отсутствовали в системе: **24** — карточка отеля и кнопка профиля, **4** и **2** — бейджи оценки на карточке.

### Sizes Ref (17)

4 · 8 · 16 · 24 · 32 · 40 · 48 · 56 · 64 · 72 · 80 · 88 · 96 · 112 · 144 · 176 · 200

---

## 4. Типографика

Шкала в системе — 26 стилей, все `Golos Text`, letterSpacing **−2%**:

| Стиль | Размер / межстрочный | Начертания |
|---|---|---|
| Title XXXL | 80 / 88 | Medium, Semibold |
| Title XXL | 64 / 72 | Medium, Semibold |
| Title XL | 48 / 56 | Medium, Semibold |
| Title L | 40 / 48 | Medium, Semibold |
| Title M | 32 / 40 | Regular, Medium, Semibold |
| Title S | 24 / 32 | Regular, Medium, Semibold |
| Headline | 20 / 24 | Regular, Medium, Semibold |
| Headline - Body | 16 / 20 | Regular, Medium, Semibold |
| Body - Caption | 14 / 18 | Regular, Medium |
| Caption | 12 / 16 | Regular, Medium |
| Textlink Large | 16 / 24 | Medium, подчёркнутый |
| Textlink Medium | 14 / 20 | Medium, подчёркнутый |

**Хорошая новость:** −2% в пикселях это размер × 0.02 — то есть `−0.32px` при 16, `−0.28` при 14, `−0.24` при 12, `−0.4` при 20. Именно эти значения и стоят в CSS. Шкала переносилась из макета аккуратно, и совпадений больше, чем отступлений.

### Отступления от шкалы (выборка: `button`, `hotelCard`, `header`)

| Где | Что в коде | Проблема |
|-----|-----------|----------|
| `hotelCard` | **13px** / 16 / w500 | размера 13 в шкале нет |
| `hotelCard` | 16 / **16** / w500 | межстрочный 16 вместо 20 |
| `hotelCard` | 12 / 16 / ls **−0.32** | должно быть −0.24 (−2% от 12) |
| `hotelCard` (моб.) | 12 / **14** | межстрочный вне шкалы |
| `header` | **15px** / 20 / **w600** | размера 15 в шкале нет |
| `header` | 14 / 18 / **w600** | Semibold на 14px в шкале нет — только Regular и Medium |
| `header` | 12 / **14** / w400 | межстрочный вне шкалы |
| `header` | **13px** (аватар) | размера 13 нет |

Совпадают со шкалой: `button` 16/20 w500 (Headline-Body/Medium), `hotelCard` 20/24 w500 (Headline/Medium), 14/18 w400 (Body-Caption/Regular), 12/16 w400 (Caption/Regular), `header` 16/20 w500 и 14/18 w500.

---

## 5. Цвета и тени мимо системы (найдено в коде)

| Что | Где | Комментарий |
|-----|-----|-------------|
| `rgba(255, 122, 0, …)` = **`#FF7A00`** | `header`, `sbpQrPanel`, `checkout` | «почти бренд», но **не** `#fe732e`. Ховеры, обводки, подсветки. Уже разошлось по трём файлам |
| Градиент `#ff8a3d → #ff6a00` | `header` (аватар профиля) | ещё два оранжевых вне палитры |
| `#336df9` | `header` (`.headBanner`) | синий, единственное вхождение |
| `#fff` вместо `--primary_b` | `header`, `hotelCard` | захардкожено |
| `0 6px 18px rgba(0,0,0,.06)` | `header` (ховер профиля) | не равна `baseShadow` |
| `0 16px 40px rgba(0,0,0,.12)` | `header` (выпадающее меню) | не равна `baseShadow` |
| `0 1px 4px rgba(0,0,0,.1)` | `hotelCard` (скелетон) | не равна `baseShadow` |

`baseShadow` в системе: `0 4 12` + `0 1 4`, обе 12%. Ни одна из трёх теней в коде ей не соответствует — то есть теней де-факто четыре разных вида вместо одной.

---

## 6. Что менять в коде

### `totus_WEB/src/styles/globals.css`

```css
[data-theme="dark"] {
  --textTertiary: #a3a3a3;   /* было #7a7a7a — контраст 4.29, ниже нормы */
  --textDisabled: #5a5a5a;   /* было #3d3d3d — контраст 1.70 */
  --borderTertiary: #2a2a2a; /* было #1f1f1f — сливалась с фоном */
}
```

Новые роли в оба режима:

```css
:root {
  --bgElevated: #ffffff;
  --overlay: rgba(31, 31, 31, 0.58);
  --secondary_pink: #f285c5;
  --brand_orange: #e1732e;
  --brand: var(--core_Orange);
  --error: var(--primary_red);
  --warning: var(--primary_yellow);
  --success: var(--secondary_green);
}

[data-theme="dark"] {
  --bgElevated: #1f1f1f;
  --overlay: rgba(0, 0, 0, 0.8);
  --error: var(--secondary_red);
  --warning: var(--secondary_yellow);
}
```

`--primary_pink` меняется с `#f285c5` на `#d941bf` (старое значение переезжает в `--secondary_pink`).

Отдельно: заменить `rgba(255,122,0,…)` на `--core_Orange` с прозрачностью, убрать градиент аватара в пользу `--core_Orange`, свести три тени к `baseShadow`, вернуть размеры 13 и 15 в шкалу (13 → 14, 15 → 16), поправить межстрочные 16/16 → 16/20 и 12/14 → 12/16.

### `totus_APP/src/theme/`

`colors.ts`:

```ts
export const brandColor   = '#FE732E';  // без изменений
export const successColor = '#39BF87';  // без изменений
export const errorColor   = '#CF3030';  // было #FF3E3E
export const warningColor = '#CE8508';  // было #FFC107
```

`dark.ts`:

```ts
background:          '#141414',  // было #000000
backgroundSecondary: '#1F1F1F',  // было #1A1A1A
surface:             '#1F1F1F',  // было #1A1A1A
textSecondary:       '#B8B8B8',  // было #E0E0E0
textTertiary:        '#A3A3A3',  // было #B0B0B0
textDisabled:        '#5A5A5A',  // было #707070
borderDark:          '#7A7A7A',  // было #5A5A5A
border:              '#2A2A2A',  // было #3A3A3A
```

В тёмной теме статусы переключаются на `secondary_*`: ошибка `#F26161`, предупреждение `#FACD64`, успех `#0DD6A4`.

`light.ts` — почти совпадает. Отличие: `backgroundTertiary` `#E4E4E4` против `bgTertiary` `#b6b6b6`. Это **разные роли под одним именем**; в новой системе подложка называется `bgElevated`.

---

## 7. Открытые вопросы

1. **`brand_orange` `#e1732e`** — не применяется ни в вебе, ни в приложении. Отдельный фирменный оранжевый или наследие шаблона?
2. **`#FF7A00`** — оранжевый, разошедшийся по трём файлам. Это ошибка копипаста или сознательный «оранжевый для интерактива»? Если ошибка — заменяем на `#fe732e`.
