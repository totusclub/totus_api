# CI для iOS: превью правок и сборки в TestFlight (RU)

**Статус: архитектура согласовывается (§6, 03.09.2026); внедрение — после «добро» владельца и шага 1 (ключи).** Составлено 30.08.2026 по вопросу владельца «есть ли симулятор iOS и можно ли отправлять версии в TestFlight». Appetize отложен.

Репозиторий: `tosmedia/totus_APP` (bare React Native 0.79.7, не Expo). Bundle iOS: `app.totus.club`, Android `com.totus.com`.

---

## 1. Ограничение, из которого всё следует

Симулятора iOS у Claude нет и быть не может: сессия работает в Linux-контейнере, а iOS Simulator — часть Xcode, который по лицензии Apple запускается только на macOS на «железе» Apple. Привязка сессии к Mac владельца это не меняет: шелл на стороне пользователя — отдельная Linux-VM с доступом к папкам, `xcodebuild` и `simctl` через неё недоступны.

Вывод: и «глаза» (превью правок), и сборки в TestFlight делаются **в CI на macOS-раннере**. Один и тот же раннер закрывает обе задачи.

---

## 2. Четыре уровня «посмотреть правки»

| Способ | Что даёт | Кто смотрит | Цена |
|---|---|---|---|
| **A. Скриншоты из CI** | macOS-раннер поднимает симулятор, Maestro прогоняет сценарий (главная → поиск → отель → чат с Милой), PNG кладутся в артефакты сборки и комментарий к PR | Claude видит картинки и оценивает вёрстку; владелец — в PR | входит в стоимость раннера |
| **B. Appetize.io / BrowserStack** | `.app` крутится в симуляторе внутри браузера, ссылку можно дать команде | владелец и команда с любого устройства | Appetize от ~$40/мес |
| **C. TestFlight** | реальные устройства | владелец + тестировщики | входит в Apple Developer Program |
| **D. Макеты до кода** | действующее правило §3.7 оркестратора: сначала макет «до/после» на канвасе, код — после «утверждаю» | владелец | бесплатно |

**Ключевое ограничение симулятора:** PushKit/VoIP-пуши, CallKeep и WebRTC на симуляторе не работают (нет push-токенов, микрофона, камеры). Телефония и голосовая часть Милы проверяются **только на живом устройстве через TestFlight**. Симулятор и скриншоты — про вёрстку, навигацию и тексты.

Рекомендованная комбинация: **A + C** из одной сборки, **B** — опционально, **D** уже работает.

---

## 3. Предусловия для TestFlight

1. **Apple Developer Program** — $99/год, аккаунт организации.
2. **Запись приложения в App Store Connect** с bundle ID `app.totus.club`.
3. **App Store Connect API Key** (App Store Connect → Users and Access → Integrations, роль App Manager): файл `AuthKey_XXX.p8`, **Key ID**, **Issuer ID**. Ими робот загружает билды вместо пароля.
4. **Подпись кода**: distribution-сертификат + provisioning profile типа App Store. Практичнее всего `fastlane match` — сертификаты в приватном репо, CI подтягивает сам.
5. Всё перечисленное — в **GitHub Secrets** репозитория `totus_APP`. Секреты добавляет владелец; Claude на них только ссылается в конфигах и никогда их не видит.

### Подводные камни именно этого проекта

- **`aps-environment = development`** в entitlements — для TestFlight нужен `production` (или разделение по конфигурациям). Иначе VoIP-пуши в бете не приходят, то есть телефония в тесте мертва.
- **`NSUserTrackingUsageDescription` отсутствует** в `Info.plist` при живом ATT-хуке в JS — риск отказа на Beta App Review для внешних тестировщиков.
- **`ios/Pods` закоммичен** — для CI плюс по скорости, но `pod install` в пайплайне всё равно нужен для консистентности.
- **`scripts/generate-autolinking.js` отсутствует**, хотя npm-скрипты его вызывают — сломает будущий Android-пайплайн (iOS не затрагивает).
- ~~**Ключи в git**~~ — **снято 02.09**: Б.1 закрыт, репозитории вычищены, ключи ротированы (см. `SECURITY_AUDIT_SECRETS_RU.md`).
- **Номер билда**: два билда с одинаковым номером TestFlight не примет, нужен авто-инкремент от последнего номера в TestFlight.

---

## 4. Где собирать

| Вариант | Плюсы | Минусы |
|---|---|---|
| **GitHub-hosted macOS** | ничего не держать включённым; с 01.01.2026 цены hosted-раннеров снижены до 39% — сборка ≈ $1–1.5 сверх бесплатных минут | macOS-минуты с множителем ×10; сборка bare RN ≈ 20–30 мин |
| **Self-hosted раннер на Mac разработчика** | бесплатно, быстро (кэш Pods/DerivedData на месте) | Mac должен быть включён и в сети; раннер получает доступ к машине |
| **Codemagic / Bitrise / Xcode Cloud** | заточены под RN, подпись и TestFlight «из коробки» | ещё один сервис и счёт; **API этих сервисов из среды Claude по сети недоступны** — команда из чата не сможет их дёргать; Xcode Cloud замкнут на экосистему Apple |

Рекомендация: GitHub-hosted macOS (см. §6); при росте частоты сборок — self-hosted (правка нескольких строк в workflow).

---

## 5. Состав пайплайна

```
.github/workflows/ios-testflight.yml   # триггер: изменение release-request.json + ручной запуск
release-request.json                   # версия + release notes; коммитит Claude по команде владельца
fastlane/Appfile                       # bundle id, team id
fastlane/Matchfile                     # репо с сертификатами
fastlane/Fastfile                      # lane :beta и lane :screenshots
.maestro/*.yaml                        # сценарии для скриншотов (опционально, этап 2)
```

**Lane `beta`:** checkout → Node 18 → `npm ci` → `pod install` → `match(appstore)` → номер билда = последний в TestFlight + 1 → `build_app` (export_method: `app-store`) → `upload_to_testflight` → внутренние тестировщики получают билд через 5–15 минут.

**Lane `screenshots`:** сборка под симулятор → `xcrun simctl boot` → Maestro прогоняет флоу → PNG в артефакты и в комментарий к PR.

**Лимиты TestFlight:** 100 внутренних тестировщиков (без ревью, билд доступен сразу), до 10 000 внешних (первый билд проходит Beta App Review, обычно 1–2 дня), до 100 хранимых билдов, срок жизни билда 90 дней, до 30 устройств на тестировщика.

**Оценка сроков:** первый зелёный билд в TestFlight — 1–2 дня (подпись и entitlements почти всегда ломаются с первого раза), скриншот-lane — ещё около половины дня.

---

## 6. Архитектура «одна команда в Claude → TestFlight» (предложена 03.09.2026)

**Запрос владельца:** писать в Claude «Release totus_APP to TestFlight» и получать готовый билд в TestFlight или разбор ошибки; сборка в облаке, не на MacBook.

**Решение: GitHub Actions + fastlane.** Ключевой аргумент: GitHub — единственный сервис, куда Claude из чатов проекта надёжно пишет (коннектор проверен десятками PR); API Codemagic/Bitrise из среды Claude недоступны.

### Схема

1. Владелец пишет команду в любом чате проекта (после внедрения — скилл `release-totus-app`).
2. Claude через GitHub-коннектор коммитит `release-request.json` (версия, release notes) в `totus_APP` → триггер workflow.
3. `ios-testflight.yml` на macos-раннере выполняет lane `beta` (§5).
4. Workflow пишет результат в GitHub Issue «Release vX.Y.Z»: при успехе — номер билда; **при падении — последние ~200 строк лога** (у коннектора нет доступа к логам Actions, поэтому лог приносит сам workflow).
5. Claude читает issue и отчитывается владельцу: успех с номером билда либо разбор причины по логу.

### Секреты (добавляет только владелец, GitHub Secrets репо totus_APP)

`ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8` (base64 от AuthKey_*.p8, роль App Manager), `APPLE_TEAM_ID`, `MATCH_PASSWORD` (пароль шифрования match), `MATCH_GIT_TOKEN` (fine-grained PAT только на приватный репо `tosmedia/ios-certificates`, contents RW).

### Порядок внедрения

1. **Владелец** (~30 мин): API-ключ ASC; запись приложения `app.totus.club` в ASC (если нет); пустой приватный репо `tosmedia/ios-certificates`; 6 секретов в totus_APP.
2. **Claude** (после «добро», PR в totus_APP): fastlane-файлы, workflow, шаг отчёта в issue + фиксы `aps-environment` → `production` и `NSUserTrackingUsageDescription`.
3. Первый прогон и отладка подписи (1–2 дня; логи падений — в issue).
4. После первого зелёного билда — скилл `release-totus-app`.

Напоминание: CI не проверяет телефонию (§2) — дымовой тест звонка на реальном устройстве после каждого релиза остаётся ручным.

---

## Источники по цифрам

- Тарификация GitHub Actions и снижение цен hosted-раннеров с 01.01.2026: https://github.blog/changelog/2025-12-16-coming-soon-simpler-pricing-and-a-better-experience-for-github-actions/ и https://docs.github.com/en/billing/managing-billing-for-your-products/about-billing-for-github-actions
- Лимиты TestFlight: https://developer.apple.com/testflight/
