const express = require('express');
const { requireStaff } = require('../middleware/authJwt');

// Кеш поиска LT (lib/searchCache.js) — только для сотрудников:
//   GET  /api/admin/search-cache          — что прогрето: страны, дата вылета, число отелей, возраст снимка
//   POST /api/admin/search-cache/warmup   — прогреть сейчас (в фоне, ответ сразу)
function buildSearchCacheRoutes(searchCache) {
    const router = express.Router();
    router.use(requireStaff);

    router.get('/', (req, res) => {
        res.json({ success: true, ...searchCache.info() });
    });

    router.post('/warmup', (req, res) => {
        const info = searchCache.info();
        if (!info.enabled) {
            return res.status(409).json({ success: false, error: 'SEARCH_CACHE выключен (SEARCH_CACHE=on в .env)' });
        }
        searchCache.warmAll('ручной прогрев');
        res.status(202).json({ success: true, started: true, running: true });
    });

    return router;
}

module.exports = { buildSearchCacheRoutes };
