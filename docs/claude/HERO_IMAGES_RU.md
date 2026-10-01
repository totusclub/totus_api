# Hero главной — несколько изображений, случайный выбор

**Статус (29.09.2026):** три PR открыты, ждут ревью и слияния.
- totus_API [#25](https://github.com/tosmedia/totus_API/pull/25)
- Totus_admin [#12](https://github.com/tosmedia/Totus_admin/pull/12)
- totus_WEB [#21](https://github.com/tosmedia/totus_WEB/pull/21)

Во всех трёх репозиториях ветка называется `claude/hero-multiple-images`.

## Логика
- В админке можно добавить сколько угодно изображений hero, заменить или удалить любое.
- Одно случайное изображение из списка выбирает `GET /api/home-hero` при каждом запросе (`crypto.randomInt`, `Cache-Control: no-store`).
  - Одно изображение — показывается всегда.
  - Изображений нет — `image: ''`, hero без фона.
- Сайт показывает только изображение с бэкенда. Статический `cover.webp` удалён.

## Бэкенд (totus_API)
- Таблица `home_hero_images` (`id`, `image`, `sort_order`, `created_at`, `updated_at`).
  - Создаётся автоматически при первом обращении.
  - Прежнее `home_hero.image` переносится в список, после переноса колонка очищается.
- В `home_hero` остаётся только заголовок.
- Эндпоинты админки (все под `/api/admin`):

| Метод | Путь | Что делает |
|---|---|---|
| GET | `/home-hero` | Заголовок и массив `images` |
| PUT | `/home-hero` | Заголовок. Файл от старой админки добавляется в список |
| GET | `/home-hero/images` | Список изображений |
| POST | `/home-hero/images` | Добавление: поле `images`, до 20 файлов за запрос |
| PUT | `/home-hero/images/:id` | Замена файла |
| DELETE | `/home-hero/images/:id` | Удаление |

- Проверка: `node scripts/check-home-hero.js`, входит в `npm run check`.
- Миграция при желании: `npm run migrate:home-hero-images`.

## Порядок выката
1. totus_API — обратно совместим.
2. Totus_admin.
3. totus_WEB.
