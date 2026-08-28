const jwt = require('jsonwebtoken');

function extractBearerToken(req) {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) return null;
    const token = header.slice(7).trim();
    return token || null;
}

// Site/app user token: signed with JWT_SECRET, payload is the users row (numeric id).
exports.requireUser = (req, res, next) => {
    if (!process.env.JWT_SECRET) {
        return res.status(503).json({ error: 'auth_not_configured' });
    }

    const token = extractBearerToken(req);
    if (!token) {
        return res.status(401).json({ error: 'unauthorized' });
    }

    try {
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        if (!payload || typeof payload !== 'object' || !Number.isFinite(Number(payload.id))) {
            return res.status(401).json({ error: 'unauthorized' });
        }
        req.authUser = payload;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'unauthorized' });
    }
};

// CMS staff token: signed with JWT_SECRET, must carry scope: 'staff'.
exports.requireStaff = (req, res, next) => {
    if (!process.env.JWT_SECRET) {
        return res.status(503).json({ error: 'auth_not_configured' });
    }

    const token = extractBearerToken(req);
    if (!token) {
        return res.status(401).json({ error: 'unauthorized' });
    }

    try {
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        if (!payload || typeof payload !== 'object' || !Number.isFinite(Number(payload.id))) {
            return res.status(401).json({ error: 'unauthorized' });
        }
        if (payload.scope !== 'staff') {
            return res.status(403).json({ error: 'forbidden' });
        }
        req.authStaff = payload;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'unauthorized' });
    }
};
