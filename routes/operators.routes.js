'use strict';

// Справочник операторов (Totus_admin → «Операторы»). Монтируется в app.js:
//     app.use('/api/admin/operators', require('./routes/operators.routes'));
// Все маршруты — staff-JWT strict (requireStaff), как «Отели и номера».
const express = require('express');
const router = express.Router();
const { requireStaff } = require('../middleware/authJwt');
const c = require('../controllers/operators.controller');

router.use(requireStaff);

// Чтение отвечает и без миграции (available: false) — админка показывает подсказку, а не ошибку.
router.get('/', c.list);

router.use(c.readyGuard);
router.post('/', c.create);
router.get('/:id', c.get);
router.put('/:id', c.update);
router.post('/:id/toggle', c.toggle);
router.post('/:id/duplicate', c.duplicate);
router.delete('/:id', c.remove);

module.exports = router;
