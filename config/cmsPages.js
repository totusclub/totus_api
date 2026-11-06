/** Footer pages editable in admin — must match totusapp/web-app footer-pages-catalog */
const ALLOWED_CMS_PAGE_SLUGS = new Set([
    'about-us',
    'help-faq',
    'partners',
    'advertise',
    'airlines',
    'low-fare-tips',
    'badges-certificates',
    'security',
    'cookie-settings',
    'privacy-policy',
    'terms',
    // Юридические документы ООО «ТОТУСКЛАБ» (пачка 1, 03.10.2026)
    'consent',
    'ads-consent',
    'recommendations',
    'requisites',
    // Юридические документы ООО «ТОТУСКЛАБ» (пачка 2, туры и размещение)
    'tour-offer',
    'hotel-booking',
    'cancellation',
    'tourist-memo',
    'payment',
    // Редакция от 30.10.2026: отдельные согласия и приложения к договору
    'personalization-consent',
    'marketing-data-consent',
    'booking-application',
    'operator-information',
]);

/** Юридические документы — порядок показа в приложении и на сайте */
const LEGAL_CMS_PAGE_SLUGS = [
    'terms',
    'privacy-policy',
    'consent',
    'personalization-consent',
    'ads-consent',
    'marketing-data-consent',
    'cookie-settings',
    'recommendations',
    'tour-offer',
    'booking-application',
    'operator-information',
    'hotel-booking',
    'cancellation',
    'tourist-memo',
    'payment',
    'requisites',
];

function isAllowedCmsPageSlug(slug) {
    return ALLOWED_CMS_PAGE_SLUGS.has(String(slug || '').trim());
}

module.exports = {
    ALLOWED_CMS_PAGE_SLUGS,
    LEGAL_CMS_PAGE_SLUGS,
    isAllowedCmsPageSlug,
};
