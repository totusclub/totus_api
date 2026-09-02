const axios = require('axios');
const { requireEnv } = require('../lib/env');

const BASE_URL = 'https://api.level.travel';

// Без fallback-литерала (Б.1): токен только из окружения.
const LT_API_TOKEN =
  process.env.LT_API_TOKEN ||
  process.env.LT_PARTNER_API_KEY ||
  null;

/** Partner token LT; бросает понятную ошибку, если LT_API_TOKEN/LT_PARTNER_API_KEY не заданы. */
function getLtToken() {
  return LT_API_TOKEN || requireEnv('LT_API_TOKEN');
}

const DEFAULT_VERSIONS = ['3.8', '3.7', '3.6', '3.5', '3.4', '3.0'];

function getLtHeaders(version = '3.7') {
  return {
    Accept: `application/vnd.leveltravel.v${version}`,
    // Ленивый getter: app.js строит HEADERS при загрузке модуля, а ошибка
    // «токен не задан» должна возникать при реальном LT-вызове (внутри try/catch роута),
    // а не ронять процесс на старте (см. reportEnv в lib/env.js).
    get Authorization() {
      return `Token token="${getLtToken()}"`;
    },
    'Content-Type': 'application/json',
  };
}

function getLtErrorPayload(error) {
  return error?.response?.data ?? null;
}

function getLtErrorMessage(error) {
  const data = getLtErrorPayload(error);
  if (data == null) return error?.message || 'Unknown Level Travel error';
  if (typeof data === 'string') return data;
  return (
    data.error ||
    data.message ||
    (Array.isArray(data.errors) ? data.errors.join(', ') : null) ||
    JSON.stringify(data)
  );
}

function isLtVersionError(error) {
  const msg = String(getLtErrorMessage(error) || '').toLowerCase();
  return msg.includes('incorrect api version') || msg.includes('api version');
}

function isRetryableLtStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function logLtError(label, error, extra = {}) {
  const status = error?.response?.status;
  const data = getLtErrorPayload(error);
  console.error(label, {
    status: status || null,
    message: getLtErrorMessage(error),
    data,
    ...extra,
  });
}

/**
 * Call Level Travel trying Accept versions until one works.
 * Skips to next version only on "Incorrect api version".
 */
async function ltRequest({
  method = 'get',
  path,
  params,
  data,
  versions = DEFAULT_VERSIONS,
  timeout = 60000,
  retries = 1,
} = {}) {
  if (!path) throw new Error('ltRequest: path is required');

  const url = path.startsWith('http') ? path : `${BASE_URL}${path}`;
  let lastError = null;

  for (const version of versions) {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await axios({
          method,
          url,
          params,
          data,
          headers: getLtHeaders(version),
          timeout,
        });
      } catch (error) {
        lastError = error;
        const status = error?.response?.status;

        if (isLtVersionError(error)) {
          break; // try next Accept version
        }

        if (attempt < retries && isRetryableLtStatus(status)) {
          continue; // retry same version
        }

        throw error;
      }
    }
  }

  throw lastError || new Error('Level Travel request failed');
}

function sendLtAxiosError(res, error, fallbackMessage) {
  const status = error?.response?.status || 500;
  const data = getLtErrorPayload(error);
  if (data && typeof data === 'object') {
    return res.status(status).json(data);
  }
  return res.status(status).json({
    success: false,
    error: data || fallbackMessage || getLtErrorMessage(error),
  });
}

module.exports = {
  BASE_URL,
  LT_API_TOKEN,
  getLtToken,
  DEFAULT_VERSIONS,
  getLtHeaders,
  getLtErrorPayload,
  getLtErrorMessage,
  isLtVersionError,
  isRetryableLtStatus,
  logLtError,
  ltRequest,
  sendLtAxiosError,
};
