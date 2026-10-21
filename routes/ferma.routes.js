const express = require('express');
const { createFermaController } = require('../controllers/ferma.controller');
const { getFerma } = require('../lib/ferma');
const { requireStaff } = require('../middleware/authJwt');

function buildFermaRoutes(getDeps = getFerma) {
    const c = createFermaController(getDeps);

    // Mounted at /api/ferma — callback от Ferma (секрет в пути, без входа)
    const publicRouter = express.Router();
    publicRouter.post('/callback/:secret', c.callback);

    // Mounted at /api/admin/fiscal — только сотрудники (strict: не зависит от AUTH_MODE)
    const adminRouter = express.Router();
    adminRouter.use(requireStaff);
    adminRouter.get('/config', c.config);
    adminRouter.post('/token', c.token);
    adminRouter.get('/cashboxes', c.cashboxes);
    adminRouter.get('/queue', c.queue);
    adminRouter.get('/ferma-status', c.fermaStatus);
    adminRouter.post('/preview', c.preview);
    adminRouter.post('/receipts', c.createReceipt);
    adminRouter.get('/receipts', c.listReceipts);
    adminRouter.get('/receipts/:id', c.getReceipt);
    adminRouter.post('/receipts/:id/refresh', c.refreshReceipt);
    adminRouter.post('/receipts/:id/retry', c.retryReceipt);
    adminRouter.post('/receipts/:id/refund', c.refundReceipt);
    adminRouter.post('/reconcile', c.reconcile);
    adminRouter.get('/registry', c.registry);
    adminRouter.post('/selftest', c.selftest);

    return { publicRouter, adminRouter };
}

module.exports = { buildFermaRoutes };
