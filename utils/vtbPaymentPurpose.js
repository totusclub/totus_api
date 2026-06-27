const SBP_PURPOSE_MAX = 140;

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function truncateAt(text, max = SBP_PURPOSE_MAX) {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= max) return normalized;
  return normalized.slice(0, max);
}

function pickFirstString(values) {
  for (const value of values) {
    const text = normalizeWhitespace(value);
    if (text) return text;
  }
  return '';
}

function formatNightsRu(nights) {
  const n = Number(nights);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n === 1) return '1 ночь';
  if (n >= 2 && n <= 4) return `${n} ночи`;
  return `${n} ночей`;
}

function formatAdultsRu(adults) {
  const n = Number(adults);
  if (!Number.isFinite(n) || n <= 0) return '';
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} взрослый`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return `${n} взрослых`;
  }
  return `${n} взрослых`;
}

function pickPositiveNumber(values) {
  for (const value of values) {
    if (value == null || value === '') continue;
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function extractNightsCount(pkg) {
  const nested = pkg?.package && typeof pkg.package === 'object' ? pkg.package : {};
  return pickPositiveNumber([
    nested.dates_info?.nights_count,
    nested.nights_count,
    nested.dates_info?.nights,
    nested.dates_info?.original_nights,
    pkg?.dates_info?.nights_count,
    pkg?.dates_info?.nights,
    pkg?.nights_count,
    pkg?.nights,
  ]);
}

function extractAdultsCount(pkg) {
  const nested = pkg?.package && typeof pkg.package === 'object' ? pkg.package : {};
  const fromFields = pickPositiveNumber([
    nested.adults_count,
    pkg?.adults_count,
    nested.dates_info?.adults,
    pkg?.dates_info?.adults,
  ]);
  if (fromFields) return fromFields;

  if (Array.isArray(pkg?.tourists) && pkg.tourists.length > 0) {
    return pkg.tourists.length;
  }

  return null;
}

function extractOrderDetails(pkg) {
  if (!pkg || typeof pkg !== 'object') return '';

  const nested = pkg.package && typeof pkg.package === 'object' ? pkg.package : {};
  const hotelObj = nested.hotel || pkg.hotel || null;

  const hotel = pickFirstString([
    hotelObj?.name,
    pkg.hotel_name,
  ]);

  const nights = extractNightsCount(pkg);
  const adults = extractAdultsCount(pkg);

  const parts = [];
  if (hotel) parts.push(hotel);

  const nightsPart = formatNightsRu(nights);
  if (nightsPart) parts.push(nightsPart);

  const adultsPart = formatAdultsRu(adults);
  if (adultsPart) parts.push(adultsPart);

  return parts.join(', ');
}

function buildVtbPaymentPurpose({ orderId, orderName, paymentPurpose, package: pkg }) {
  const idStr = String(orderId || '').replace(/^ORDER/i, '');
  const orderRef = idStr ? `ORDER${idStr}` : '';
  const suffix = orderRef ? ` ${orderRef}` : '';
  const maxBody = Math.max(0, SBP_PURPOSE_MAX - suffix.length);

  const orderDetails = extractOrderDetails(pkg);
  const rawDetails =
    pickFirstString([orderDetails, orderName, paymentPurpose]) ||
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
