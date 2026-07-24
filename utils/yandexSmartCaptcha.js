const axios = require('axios');

const VALIDATE_URL = 'https://smartcaptcha.cloud.yandex.ru/validate';

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return (
    req.headers['x-real-ip'] ||
    req.ip ||
    req.connection?.remoteAddress ||
    ''
  );
}

/**
 * Validate Yandex SmartCaptcha token.
 * If YANDEX_SMARTCAPTCHA_SERVER_KEY is not set, skips validation (local/dev).
 */
async function verifyYandexSmartCaptcha(req, token) {
  const secret = String(process.env.YANDEX_SMARTCAPTCHA_SERVER_KEY || '').trim();

  if (!secret) {
    console.warn(
      '[SMARTCAPTCHA] YANDEX_SMARTCAPTCHA_SERVER_KEY is not set — skipping validation'
    );
    return { ok: true, skipped: true };
  }

  const captchaToken = String(token || '').trim();
  if (!captchaToken) {
    return { ok: false, message: 'Captcha token is required' };
  }

  const ip = getClientIp(req);
  const body = new URLSearchParams({
    secret,
    token: captchaToken,
    ...(ip ? { ip: String(ip) } : {}),
  });

  try {
    const response = await axios.post(VALIDATE_URL, body.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000,
      validateStatus: () => true,
    });

    if (response.status !== 200) {
      console.error('[SMARTCAPTCHA] validate HTTP error', response.status, response.data);
      return {
        ok: false,
        message: 'Captcha service unavailable',
        upstream_status: response.status,
      };
    }

    const status = response.data?.status;
    if (status === 'ok') {
      return { ok: true, host: response.data?.host };
    }

    return {
      ok: false,
      message: response.data?.message || 'Captcha validation failed',
    };
  } catch (err) {
    console.error('[SMARTCAPTCHA] validate request failed', err.message);
    return { ok: false, message: 'Captcha service unavailable', error: err.message };
  }
}

module.exports = {
  verifyYandexSmartCaptcha,
  getClientIp,
};
