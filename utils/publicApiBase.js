function isLocalHost(host) {
    const value = String(host || '').toLowerCase();
    return value.startsWith('localhost') || value.startsWith('127.0.0.1');
}

function getPublicApiBase(req) {
    const host = req.get('host') || '';
    if (isLocalHost(host)) {
        return `${req.protocol}://${host}`.replace(/\/$/, '');
    }

    return (
        process.env.API_PUBLIC_URL ||
        process.env.PUBLIC_API_URL ||
        `${req.protocol}://${host}`
    ).replace(/\/$/, '');
}

module.exports = { getPublicApiBase, isLocalHost };
