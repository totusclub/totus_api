// Заявки «Стать партнёром» (/partners → админка). Без npm install и без БД:
//   node scripts/check-partner-requests.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

// Поддельная БД: хранит строки в памяти, разбирает только нужные запросы.
const rowsStore = [];
const queries = [];
const dbPath = path.join(root, 'db.js');
require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
        async query(sql, params = []) {
            const s = sql.replace(/\s+/g, ' ').trim();
            queries.push(s);
            if (/^CREATE TABLE IF NOT EXISTS partner_requests/.test(s)) return [{}];
            if (/^INSERT INTO partner_requests/.test(s)) {
                const [company, name, email, phone, kind, message, source, ip, user_agent] = params;
                const row = { id: rowsStore.length + 1, company, name, email, phone, kind, message, source, ip, user_agent, status: 'new', note: null };
                rowsStore.push(row);
                return [{ insertId: row.id, affectedRows: 1 }];
            }
            if (/^SELECT id, company/.test(s)) {
                const status = /WHERE status = \?/.test(s) ? params[0] : null;
                return [rowsStore.filter((r) => !status || r.status === status)];
            }
            if (/^SELECT COUNT\(\*\) AS total/.test(s)) {
                const status = /WHERE status = \?/.test(s) ? params[0] : null;
                return [[{ total: rowsStore.filter((r) => !status || r.status === status).length }]];
            }
            if (/^SELECT status, COUNT/.test(s)) {
                const m = {};
                for (const r of rowsStore) m[r.status] = (m[r.status] || 0) + 1;
                return [Object.entries(m).map(([status, cnt]) => ({ status, cnt }))];
            }
            if (/^UPDATE partner_requests SET/.test(s)) {
                const id = params[params.length - 1];
                const row = rowsStore.find((r) => r.id === id);
                if (!row) return [{ affectedRows: 0 }];
                const cols = s.match(/SET (.*) WHERE/)[1].split(', ').map((c) => c.split(' = ')[0]);
                cols.forEach((c, i) => { row[c] = params[i]; });
                return [{ affectedRows: 1 }];
            }
            if (/^DELETE FROM partner_requests/.test(s)) {
                const i = rowsStore.findIndex((r) => r.id === params[0]);
                if (i < 0) return [{ affectedRows: 0 }];
                rowsStore.splice(i, 1);
                return [{ affectedRows: 1 }];
            }
            throw new Error('unexpected sql: ' + s);
        },
    },
};

const ctrl = require(path.join(root, 'controllers/partnerRequests.controller'));

function res() {
    const r = { statusCode: 200, body: null };
    r.status = (c) => { r.statusCode = c; return r; };
    r.json = (b) => { r.body = b; return r; };
    return r;
}
const req = (body, extra = {}) => ({ body, ip: '1.2.3.4', get: () => 'test-agent', params: {}, query: {}, ...extra });

let passed = 0;
let failed = 0;
async function check(name, fn) {
    try {
        await fn();
        passed += 1;
        console.log(`  ok   ${name}`);
    } catch (e) {
        failed += 1;
        console.log(`  FAIL ${name}\n       ${e && e.message ? e.message : e}`);
    }
}

const good = {
    company: '  ООО «Ромашка Тур» ',
    name: 'Анна',
    email: 'Anna@Example.RU',
    phone: '+7 (900) 123-45-67',
    kind: 'operator',
    message: 'Хотим подключить туры в Турцию.',
};

(async () => {
    console.log('Заявки партнёров');

    await check('валидная заявка сохраняется: 201, поля очищены, почта в нижнем регистре, телефон цифрами', async () => {
        const r = res();
        await ctrl.create(req(good), r);
        assert.strictEqual(r.statusCode, 201, JSON.stringify(r.body));
        assert.strictEqual(r.body.ok, true);
        const row = rowsStore[0];
        assert.strictEqual(row.company, 'ООО «Ромашка Тур»');
        assert.strictEqual(row.email, 'anna@example.ru');
        assert.strictEqual(row.phone, '+79001234567');
        assert.strictEqual(row.kind, 'operator');
        assert.strictEqual(row.source, 'web');
        assert.strictEqual(row.ip, '1.2.3.4');
        assert.ok(queries.some((q) => /^CREATE TABLE IF NOT EXISTS partner_requests/.test(q)), 'таблица создаётся сама');
    });

    await check('ошибки полей — 400 с кодом и понятным текстом, в БД ничего не пишется', async () => {
        const cases = [
            [{ ...good, company: '' }, 'company_required'],
            [{ ...good, name: 'А' }, 'name_required'],
            [{ ...good, email: '' }, 'email_required'],
            [{ ...good, email: 'не почта' }, 'invalid_email'],
            [{ ...good, phone: '123' }, 'invalid_phone'],
            [{ ...good, kind: 'spam' }, 'invalid_kind'],
            [{ ...good, message: 'x'.repeat(2001) }, 'message_too_long'],
        ];
        const before = rowsStore.length;
        for (const [body, code] of cases) {
            const r = res();
            await ctrl.create(req(body), r);
            assert.strictEqual(r.statusCode, 400, code);
            assert.strictEqual(r.body.error, code);
            assert.ok(r.body.message && /[а-я]/i.test(r.body.message), `нет текста для ${code}`);
        }
        assert.strictEqual(rowsStore.length, before);
    });

    await check('телефон и сообщение необязательны; тип по умолчанию — other', async () => {
        const r = res();
        await ctrl.create(req({ company: 'Отель Море', name: 'Пётр', email: 'p@hotel.ru' }), r);
        assert.strictEqual(r.statusCode, 201);
        const row = rowsStore[rowsStore.length - 1];
        assert.strictEqual(row.phone, null);
        assert.strictEqual(row.message, null);
        assert.strictEqual(row.kind, 'other');
    });

    await check('заполненное скрытое поле website (бот) — 201 без записи', async () => {
        const before = rowsStore.length;
        const r = res();
        await ctrl.create(req({ ...good, website: 'http://spam' }), r);
        assert.strictEqual(r.statusCode, 201);
        assert.strictEqual(rowsStore.length, before);
    });

    await check('админка: список с total и счётчиками по статусам, фильтр по статусу', async () => {
        const r = res();
        await ctrl.adminList(req({}, { query: {} }), r);
        assert.strictEqual(r.statusCode, 200);
        assert.strictEqual(r.body.data.length, 2);
        assert.strictEqual(r.body.total, 2);
        assert.deepStrictEqual(r.body.counts, { new: 2, in_progress: 0, done: 0, rejected: 0 });
        const bad = res();
        await ctrl.adminList(req({}, { query: { status: 'x' } }), bad);
        assert.strictEqual(bad.statusCode, 400);
    });

    await check('админка: смена статуса и заметки, 404 для несуществующей, 400 для плохого статуса', async () => {
        const r = res();
        await ctrl.adminUpdate(req({ status: 'in_progress', note: 'Позвонить в пятницу' }, { params: { id: '1' } }), r);
        assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
        assert.strictEqual(rowsStore[0].status, 'in_progress');
        assert.strictEqual(rowsStore[0].note, 'Позвонить в пятницу');
        const nf = res();
        await ctrl.adminUpdate(req({ status: 'done' }, { params: { id: '99' } }), nf);
        assert.strictEqual(nf.statusCode, 404);
        const bs = res();
        await ctrl.adminUpdate(req({ status: 'archived' }, { params: { id: '1' } }), bs);
        assert.strictEqual(bs.statusCode, 400);
        const empty = res();
        await ctrl.adminUpdate(req({}, { params: { id: '1' } }), empty);
        assert.strictEqual(empty.body.error, 'nothing_to_update');
    });

    await check('админка: удаление', async () => {
        const r = res();
        await ctrl.adminDelete(req({}, { params: { id: '2' } }), r);
        assert.strictEqual(r.statusCode, 200);
        assert.strictEqual(rowsStore.length, 1);
    });

    await check('маршруты: публичный POST с ограничением частоты, админские — только staff', () => {
        const routes = read('routes/partnerRequests.routes.js');
        assert.match(routes, /router\.post\('\/', partnerRequestLimiter, controller\.create\)/);
        for (const line of [
            "adminRouter.get('/', requireStaff, controller.adminList)",
            "adminRouter.patch('/:id', requireStaff, controller.adminUpdate)",
            "adminRouter.delete('/:id', requireStaff, controller.adminDelete)",
        ]) assert.ok(routes.includes(line), line);
        const app = read('app.js');
        assert.ok(app.includes("app.use('/api/partner-requests', partnerRequestsRoutes);"));
        assert.ok(app.includes("app.use('/api/admin/partner-requests', partnerRequestsAdminRoutes);"));
        assert.ok(app.indexOf("app.use('/api/admin', requireAuth(['staff']));") < app.indexOf("app.use('/api/admin/partner-requests'"));
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
