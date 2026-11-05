const express = require('express');
const { requireStaff } = require('../middleware/authJwt');
const chats = require('../lib/aiChatsAdmin');

/**
 * /api/admin/ai-chats — история чатов пользователей с Машей для админки.
 * Только сотрудники (staff-JWT, strict — не зависит от AUTH_MODE), только чтение.
 *
 *   GET /summary             → { users: { [userId]: { chats, lastAt } } }
 *   GET /?userId=<id>        → { userId, chats: [{ id, title, preview, messagesCount, userMessages, createdAt, updatedAt }] }
 *   GET /:chatId             → { chat: { id, userId, title, createdAt, updatedAt, messages: [...] } }
 *
 * Текст переписки в лог не пишется — только кто и что открыл.
 */
function buildAdminAiChatsRoutes({ getDb = () => require('../db'), log = (...a) => console.log(...a) } = {}) {
    const router = express.Router();
    router.use(requireStaff);
    router.use((req, res, next) => {
        res.set('Cache-Control', 'no-store');
        next();
    });

    const staffId = (req) => (req.auth && req.auth.id) || '-';

    router.get('/summary', async (req, res) => {
        try {
            res.json({ users: await chats.chatCounts(getDb()) });
        } catch (err) {
            console.error('[AI-CHATS] summary failed:', err.message);
            res.status(500).json({ error: 'ai_chats_failed' });
        }
    });

    router.get('/', async (req, res) => {
        const userId = Number(req.query.userId);
        if (!Number.isInteger(userId) || userId <= 0) return res.status(400).json({ error: 'invalid_user_id' });
        try {
            const list = await chats.listChats(getDb(), userId);
            log(`[AI-CHATS] staff=${staffId(req)} list user=${userId} chats=${list.length}`);
            res.json({ userId, chats: list });
        } catch (err) {
            console.error('[AI-CHATS] list failed:', err.message);
            res.status(500).json({ error: 'ai_chats_failed' });
        }
    });

    router.get('/:chatId', async (req, res) => {
        const chatId = String(req.params.chatId || '').trim();
        if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(chatId)) return res.status(400).json({ error: 'invalid_chat_id' });
        try {
            const chat = await chats.getChat(getDb(), chatId);
            if (!chat) return res.status(404).json({ error: 'chat_not_found' });
            log(`[AI-CHATS] staff=${staffId(req)} open chat=${chatId} user=${chat.userId} messages=${chat.messages.length}`);
            res.json({ chat });
        } catch (err) {
            console.error('[AI-CHATS] chat failed:', err.message);
            res.status(500).json({ error: 'ai_chats_failed' });
        }
    });

    return router;
}

module.exports = { buildAdminAiChatsRoutes };
