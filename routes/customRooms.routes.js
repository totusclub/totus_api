'use strict';

// Админка «Отели и номера» (Totus_admin). Монтируется в app.js:
//     app.use('/api/admin/rooms', require('./routes/customRooms.routes'));
// Все маршруты — staff-JWT strict (requireStaff), как order-requests.
const express = require('express');
const router = express.Router();
const { requireStaff } = require('../middleware/authJwt');
const upload = require('../middleware/uploadRoomImage');
const c = require('../controllers/customRooms.controller');

router.use(requireStaff);
router.use(c.readyGuard);

router.get('/hotels/search', c.searchHotels);
router.get('/hotels/:hotelId/rooms', c.hotelRooms);

router.get('/room-types', c.list);
router.post('/room-types', c.create);
router.post('/room-types/preview-price', c.previewPrice);
router.get('/room-types/:id', c.get);
router.put('/room-types/:id', c.update);
router.post('/room-types/:id/toggle', c.toggle);
router.post('/room-types/:id/duplicate', c.duplicate);
router.get('/room-types/:id/price-log', c.priceLog);
router.get('/room-types/:id/change-log', c.changeLog);
router.get('/room-types/:id/orders', c.orders);
router.delete('/room-types/:id', c.remove);

router.post('/images', upload.single('image'), c.uploadImage);
router.delete('/images', c.deleteImage);

router.get('/settings', c.getSettings);
router.put('/settings', c.putSettings);

module.exports = router;
