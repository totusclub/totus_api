const express = require('express');
const rateLimit = require('express-rate-limit');
const controller = require('../controllers/partnerRequests.controller');
const { requireStaff } = require('../middleware/authJwt');

const router = express.Router();
const adminRouter = express.Router();

// Не больше 5 заявок за 15 минут с одного IP.
const partnerRequestLimiter = rateLimit({
    windowMs: Number(process.env.PARTNER_REQUESTS_RATE_WINDOW_MS || 15 * 60 * 1000),
    limit: Number(process.env.PARTNER_REQUESTS_RATE_LIMIT || 5),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'too_many_requests', message: 'Слишком много заявок, попробуйте позже' },
});

// Mounted at /api/partner-requests (форма на totus.club/partners, без входа)
router.post('/', partnerRequestLimiter, controller.create);

// Mounted at /api/admin/partner-requests (CMS staff, Bearer staff JWT)
adminRouter.get('/', requireStaff, controller.adminList);
adminRouter.patch('/:id', requireStaff, controller.adminUpdate);
adminRouter.delete('/:id', requireStaff, controller.adminDelete);

module.exports = { router, adminRouter, partnerRequestLimiter };
