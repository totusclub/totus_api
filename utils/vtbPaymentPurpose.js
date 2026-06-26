const SBP_PURPOSE_MAX = 140;

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function truncateAt(text, max = SBP_PURPOSE_MAX) {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= max) return normalized;
  return normalized.slice(0, max);
}

function formatRuDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'long',
  }).format(date);
}

function pickFirstString(values) {
  for (const value of values) {
    const text = normalizeWhitespace(value);
    if (text) return text;
  }
  return '';
}

function extractOrderDetails(pkg) {
  if (!pkg || typeof pkg !== 'object') return '';

  const direct = pickFirstString([
    pkg.description_for_client,
    pkg.package?.description_for_client,
    pkg.order?.description_for_client,
  ]);
  if (direct) return direct;

  const hotel = pickFirstString([
    pkg.hotel?.name,
    pkg.package?.hotel?.name,
    pkg.hotel_name,
  ]);
  const startDate = pkg.dates_info?.start_date || pkg.package?.dates_info?.start_date;
  const nights = pkg.dates_info?.nights ?? pkg.package?.dates_info?.nights;
  const country = pickFirstString([
    pkg.hotel?.country?.name,
    pkg.package?.hotel?.country?.name,
    pkg.hotel?.city?.country?.name,
    pkg.package?.hotel?.city?.country?.name,
  ]);
  const city = pickFirstString([
    pkg.hotel?.city?.name,
    pkg.package?.hotel?.city?.name,
  ]);

  const parts = [];
  if (hotel) parts.push(hotel);
  if (city && city !== hotel) parts.push(city);
  if (country) parts.push(country);

  const datePart = formatRuDate(startDate);
  if (datePart) parts.push(`вылет ${datePart}`);
  if (nights != null && nights !== '') {
    const nightsNum = Number(nights);
    parts.push(
      Number.isFinite(nightsNum)
        ? `${nightsNum} ${nightsNum === 1 ? 'ночь' : nightsNum < 5 ? 'ночи' : 'ночей'}`
        : `${nights} ночей`,
    );
  }

  return parts.join(', ');
}

function buildVtbPaymentPurpose({ orderId, orderName, paymentPurpose, package: pkg }) {
  const idStr = String(orderId || '').replace(/^ORDER/i, '');
  const orderRef = idStr ? `ORDER${idStr}` : '';
  const suffix = orderRef ? ` ${orderRef}` : '';
  const maxBody = Math.max(0, SBP_PURPOSE_MAX - suffix.length);

  const rawDetails =
    pickFirstString([paymentPurpose, extractOrderDetails(pkg), orderName]) ||
    (idStr ? `Заказ №${idStr}` : 'Оплата тура');

  const prefix = 'Totus Club: ';
  let body = rawDetails;

  if (!/totus/i.test(body)) {
    if (prefix.length + body.length <= maxBody) {
      body = `${prefix}${body}`;
    } else if (maxBody > prefix.length) {
      body = `${prefix}${truncateAt(body, maxBody - prefix.length)}`;
    } else {
      body = truncateAt(body, maxBody);
    }
  } else {
    body = truncateAt(body, maxBody);
  }

  const purpose = truncateAt(`${body}${suffix}`, SBP_PURPOSE_MAX);
  return {
    purpose,
    subscriptionPurpose: purpose,
  };
}

module.exports = {
  SBP_PURPOSE_MAX,
  buildVtbPaymentPurpose,
  extractOrderDetails,
};
