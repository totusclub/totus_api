// Обёртки над lib/auth для маршрутов, рождённых защищёнными (order-requests):
// всегда enforce, независимо от AUTH_MODE.
const { requireAuth, optionalAuth } = require('../lib/auth');

exports.requireUser = requireAuth(['user'], { strict: true });
exports.requireStaff = requireAuth(['staff'], { strict: true });
exports.requireAuth = requireAuth;
exports.optionalAuth = optionalAuth;
