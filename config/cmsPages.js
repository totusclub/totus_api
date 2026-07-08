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
]);

function isAllowedCmsPageSlug(slug) {
    return ALLOWED_CMS_PAGE_SLUGS.has(String(slug || '').trim());
}

module.exports = {
    ALLOWED_CMS_PAGE_SLUGS,
    isAllowedCmsPageSlug,
};
