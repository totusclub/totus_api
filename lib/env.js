'use strict';
// Единая точка доступа к секретам (Б.1, SECURITY_AUDIT_SECRETS_RU.md). Никаких fallback-литералов.
const REQUIRED = {
  LT_API_TOKEN: 'Level.Travel partner token (Authorization: Token token="…")',
  PARTNER_API_KEY: 'Level.Travel partner key для подписи callback/notify',
  VTB_CLIENT_ID: 'VTB Open API client_id (X-IBM-Client-Id)',
  VTB_CLIENT_SECRET: 'VTB Open API client_secret',
  VTB_MERCHANT_AUTH: 'VTB Merchant-Authorization',
  JWT_SECRET: 'подпись access-токенов',
  JWT_REFRESH_SECRET: 'подпись refresh-токенов',
  DB_HOST: 'MySQL', DB_USER: 'MySQL', DB_PASSWORD: 'MySQL', DB_NAME: 'MySQL',
};
const OPTIONAL = {
  LT_CLIENT_AUTH_TOKEN: 'Level.Travel client auth_token (sync заказов)',
  LT_SESSION_UUID: 'Cookie uuid для LT orders/create (если требуется)',
  TELEGRAM_GATEWAY_TOKEN: 'Telegram Gateway (верификация по телефону; без него /verification-code отключён)',
  EMAIL_USER: 'Яндекс-почта', EMAIL_PASS: 'пароль приложения Яндекс-почты',
  YANDEX_SMARTCAPTCHA_SERVER_KEY: 'SmartCaptcha server key',
  ORDER_REQUESTS_NOTIFY_EMAIL: 'адрес уведомлений об обращениях',
  NOTIFY_HUB_URL: 'хаб уведомлений calling_api_v2 (push/in-app; без него уведомления отключены)',
  INTERNAL_API_KEY: 'ключ X-Internal-Key хаба уведомлений (тот же, что в calling_api_v2)',
};
function env(name) { const v = process.env[name]; return v === undefined || v === '' ? undefined : String(v); }
/** Обязательная переменная: бросает понятную ошибку при использовании, если не задана. */
function requireEnv(name) {
  const v = env(name);
  if (!v) throw new Error(`[ENV] ${name} is not set (${REQUIRED[name] || OPTIONAL[name] || 'см. .env.example'})`);
  return v;
}
/** Отчёт при старте: что не задано. Не роняет процесс — но LT/VTB-вызовы без ключей вернут ошибку. */
function reportEnv() {
  const missing = Object.keys(REQUIRED).filter((k) => !env(k));
  const missingOpt = Object.keys(OPTIONAL).filter((k) => !env(k));
  if (missing.length) console.error(`[ENV] MISSING required: ${missing.join(', ')} — заполните .env (см. .env.example)`);
  else console.log('[ENV] all required variables present');
  if (missingOpt.length) console.warn(`[ENV] optional not set: ${missingOpt.join(', ')}`);
  return { missing, missingOpt };
}
module.exports = { env, requireEnv, reportEnv, REQUIRED, OPTIONAL };
