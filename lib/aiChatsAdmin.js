'use strict';

/**
 * История чатов пользователей с Машей (ИИ-ассистент) — только чтение, для админки.
 *
 * Чаты пишет сервер Маши (totus_ai_v2, server/chatHistory.ts) в общую базу:
 *   ai_chats(id, user_id, title, messages_json, updated_at, created_at)
 * Сообщения там уже без личных данных (маскируются при сохранении) и только
 * последние 80 в каждом чате. Удалённый пользователем чат удаляется из базы.
 *
 * Здесь — запросы и приведение сообщений к виду для просмотра: роль, текст, время
 * и карточки (туры, номера, направления, бронь, шаги поиска) без служебных полей.
 */

const MAX_CHATS = 200;
const MAX_CARDS = 12;

function isMissingTable(err) {
    return Boolean(err && (err.code === 'ER_NO_SUCH_TABLE' || err.errno === 1146));
}

function parseJson(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(String(value));
    } catch {
        return null;
    }
}

function str(value, max = 2000) {
    if (value === null || value === undefined) return null;
    const s = String(value).trim();
    return s ? s.slice(0, max) : null;
}

function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

/** Время сообщения → миллисекунды (клиенты пишут ISO-строку или число). */
function toMs(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const asNum = Number(value);
    if (Number.isFinite(asNum) && /^\d+$/.test(String(value))) return asNum;
    const t = Date.parse(String(value));
    return Number.isFinite(t) ? t : null;
}

function safeUrl(value) {
    const s = str(value, 1000);
    return s && /^https?:\/\//i.test(s) ? s : null;
}

function tourCard(t) {
    if (!t || typeof t !== 'object') return null;
    return {
        name: str(t.name, 200),
        destination: str(t.destination, 200),
        price: num(t.price),
        currency: str(t.currency, 8),
        stars: num(t.stars),
        nights: str(t.duration, 60),
        label: str(t.pick_label, 120),
        comment: str(t.comment, 500),
        link: safeUrl(t.link),
    };
}

function roomCards(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const rooms = Array.isArray(payload.rooms) ? payload.rooms : [];
    return {
        hotel: str(payload.hotel && payload.hotel.name, 200),
        rooms: rooms.slice(0, MAX_CARDS).map((r) => ({
            roomType: str(r && r.room_type, 200),
            minPrice: num(r && r.min_price),
            currency: str(r && r.currency, 8),
            link: safeUrl(r && (r.booking_url || r.url)),
        })),
    };
}

/** Сообщение из messages_json → вид для админки. Неизвестные поля не отдаются. */
function normalizeMessage(m, index) {
    const msg = m && typeof m === 'object' ? m : {};
    const role = msg.role === 'assistant' || msg.role === 'system' ? msg.role : 'user';
    const meta = msg.metadata && typeof msg.metadata === 'object' ? msg.metadata : {};
    const cards = {};

    const tours = Array.isArray(meta.tour_results) ? meta.tour_results.map(tourCard).filter(Boolean) : [];
    if (tours.length) {
        cards.tours = tours.slice(0, MAX_CARDS);
        if (tours.length > MAX_CARDS) cards.toursTotal = tours.length;
    }
    const rooms = roomCards(meta.room_cards);
    if (rooms && rooms.rooms.length) cards.rooms = rooms;
    const dest = Array.isArray(meta.destination_cards)
        ? meta.destination_cards
            .map((d) => (d && typeof d === 'object' ? { name: str(d.name, 120), country: str(d.country, 120) } : null))
            .filter((d) => d && d.name)
        : [];
    if (dest.length) cards.destinations = dest.slice(0, MAX_CARDS);
    if (meta.booking && typeof meta.booking === 'object') {
        cards.booking = {
            id: str(meta.booking.booking_id, 60),
            status: str(meta.booking.status, 30),
            tour: str(meta.booking.tour_name, 200),
            date: str(meta.booking.date, 30),
            guests: num(meta.booking.guests),
            total: num(meta.booking.total_price),
        };
    }
    const steps = Array.isArray(meta.tool_calls)
        ? meta.tool_calls
            .map((tc) => (tc && typeof tc === 'object' ? str(tc.summary || tc.label, 300) : null))
            .filter(Boolean)
        : [];
    if (steps.length) cards.steps = steps.slice(0, MAX_CARDS);

    return {
        id: str(msg.id, 64) || `m${index}`,
        role,
        text: typeof msg.content === 'string' ? msg.content : '',
        at: toMs(msg.timestamp),
        cards: Object.keys(cards).length ? cards : null,
    };
}

function messagesOf(row) {
    const raw = parseJson(row && row.messages_json);
    return Array.isArray(raw) ? raw : [];
}

function createdAtMs(row) {
    if (!row || !row.created_at) return null;
    const v = row.created_at instanceof Date ? row.created_at.getTime() : Date.parse(String(row.created_at));
    return Number.isFinite(v) ? v : null;
}

/** Число чатов по пользователям: { [userId]: { chats, lastAt } }. */
async function chatCounts(db) {
    try {
        const [rows] = await db.query(
            'SELECT user_id, COUNT(*) AS chats, MAX(updated_at) AS last_at FROM ai_chats GROUP BY user_id',
        );
        const out = {};
        for (const r of rows || []) out[String(r.user_id)] = { chats: Number(r.chats) || 0, lastAt: num(r.last_at) };
        return out;
    } catch (err) {
        if (isMissingTable(err)) return {};
        throw err;
    }
}

/** Чаты пользователя (без текста сообщений), новые сверху. */
async function listChats(db, userId) {
    let rows;
    try {
        [rows] = await db.query(
            'SELECT id, title, updated_at, created_at, messages_json FROM ai_chats WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?',
            [userId, MAX_CHATS],
        );
    } catch (err) {
        if (isMissingTable(err)) return [];
        throw err;
    }
    return (rows || []).map((row) => {
        const messages = messagesOf(row);
        const firstUser = messages.find((m) => m && m.role === 'user' && typeof m.content === 'string' && m.content.trim());
        const times = messages.map((m) => toMs(m && m.timestamp)).filter((v) => v !== null);
        return {
            id: String(row.id),
            title: str(row.title, 255) || 'Новый чат',
            preview: firstUser ? str(firstUser.content, 160) : null,
            messagesCount: messages.length,
            userMessages: messages.filter((m) => m && m.role === 'user').length,
            createdAt: createdAtMs(row) || (times.length ? Math.min(...times) : null),
            updatedAt: num(row.updated_at),
        };
    });
}

/** Один чат целиком. null — нет такого чата. */
async function getChat(db, chatId) {
    let rows;
    try {
        [rows] = await db.query(
            'SELECT id, user_id, title, updated_at, created_at, messages_json FROM ai_chats WHERE id = ? LIMIT 1',
            [chatId],
        );
    } catch (err) {
        if (isMissingTable(err)) return null;
        throw err;
    }
    const row = rows && rows[0];
    if (!row) return null;
    const messages = messagesOf(row).map(normalizeMessage);
    return {
        id: String(row.id),
        userId: Number(row.user_id),
        title: str(row.title, 255) || 'Новый чат',
        createdAt: createdAtMs(row),
        updatedAt: num(row.updated_at),
        messages,
    };
}

module.exports = { chatCounts, listChats, getChat, normalizeMessage, toMs, MAX_CHATS };
