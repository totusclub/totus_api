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
]);

/** Юридические документы — порядок показа в приложении и на сайте */
const LEGAL_CMS_PAGE_SLUGS = [
    'terms',
    'privacy-policy',
    'consent',
    'ads-consent',
    'cookie-settings',
    'recommendations',
    'tour-offer',
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
