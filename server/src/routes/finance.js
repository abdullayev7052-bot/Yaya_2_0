// Finance API (Yaya 2.0, stage 6), under /api/erp/finance: cashboxes and their
// statements, expenses and other income, transfers between cashboxes, vendors with
// purchases and payments, payroll (salary, bonus, fine, payout), profit and loss,
// and the company-wide balances. A cashbox keeper may hand their own cashbox over
// to the main cashbox without finance rights.
import { audit } from '../db/index.js';
import { makeGuard } from '../auth.js';
import { StockError, cancelDoc } from '../erp/stock.js';
import {
  balancesDetail, balancesSummary, cashboxBalance, cashboxStatement, createCashCount, createCashMove, createCashOpening, createExpense, createIncome, createPurchase, createStaffEntry,
  createVendorPayment, finDoc, listFinDocs, listVendors, profitLoss, saveVendor, setSalary, staffBalance, statementOf,
} from '../erp/finance.js';

const today = () => new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);

export default async function financeRoutes(app, { db }) {
  const need = makeGuard(app, db);
  const has = (req, p) => req.me.perms.has(p);
  const bad = (reply, msg, details) => reply.code(400).send({ error: msg, details });
  const log = (req, action, details) => audit(db, req.actor, action, details);
  const ctx = (req) => ({ actor: req.actor, userId: req.me.id });
  const run = (reply, fn) => { try { return fn(); } catch (e) { if (e instanceof StockError) return bad(reply, e.message, e.details); throw e; } };
  const any = (...perms) => async (req, reply) => { if (!perms.some((p) => has(req, p))) return reply.code(403).send({ error: "Ruxsat yo'q" }); return undefined; };
  const guard = (...perms) => ({ preHandler: [need().preHandler, any(...perms)] });

  // ---------------------------------------------------------------- overview
  app.get('/summary', guard('finance.view'), async () => balancesSummary(db));
  // Balanslar: every party (households, vendors, staff) and every cashbox.
  app.get('/balances', guard('finance.view'), async () => balancesDetail(db));
  app.get('/pnl', guard('finance.view'), async (req) => profitLoss(db, { from: req.query.from || `${today().slice(0, 7)}-01`, to: req.query.to || today() }));

  // ---------------------------------------------------------------- cashboxes
  app.get('/cashboxes', guard('finance.view', 'finance.cash'), async () => db.prepare('SELECT * FROM cashboxes ORDER BY is_main DESC, active DESC, name').all()
    .map((c) => ({ ...c, balance: cashboxBalance(db, c.id),
      keepers: db.prepare('SELECT u.id, COALESCE(u.name, u.login) AS name FROM cashbox_keepers k JOIN users u ON u.id = k.user_id WHERE k.cashbox_id = ?').all(c.id) })));
  app.get('/cashboxes/:id', guard('finance.view', 'finance.cash'), async (req, reply) => {
    const c = db.prepare('SELECT * FROM cashboxes WHERE id = ?').get(Number(req.params.id));
    if (!c) return reply.code(404).send({ error: 'Topilmadi' });
    return { ...c, ...cashboxStatement(db, c.id, { from: req.query.from || null, to: req.query.to || null }) };
  });
  const cashOp = (path, fn, perm, action) => app.post(path, guard(perm), async (req, reply) => run(reply, () => {
    const d = fn(db, req.body ?? {}, ctx(req));
    log(req, action, { id: d.id, number: d.number });
    return finDoc(db, d.id);
  }));
  // Cashboxes and payment methods (were under sales until the sales part was taken out).
  const str = (v, n) => (v == null ? null : String(v).trim().slice(0, n) || null);
  const flag = (v) => (v == null ? null : Number(!!v));
  const setKeepers = (id, keepers) => {
    db.prepare('DELETE FROM cashbox_keepers WHERE cashbox_id = ?').run(id);
    for (const u of keepers) db.prepare('INSERT OR IGNORE INTO cashbox_keepers (cashbox_id, user_id) SELECT ?, id FROM users WHERE id = ?').run(id, Number(u));
  };
  app.post('/cashboxes', guard('finance.cash'), async (req, reply) => {
    const name = str(req.body?.name, 60);
    if (!name) return bad(reply, 'Nomi shart');
    const id = Number(db.prepare('INSERT INTO cashboxes (name) VALUES (?)').run(name).lastInsertRowid);
    setKeepers(id, req.body?.keepers ?? []);
    log(req, 'finance.cashbox', { id, name });
    return { id };
  });
  app.patch('/cashboxes/:id', guard('finance.cash'), async (req) => {
    const id = Number(req.params.id);
    db.prepare('UPDATE cashboxes SET name = COALESCE(?, name), active = COALESCE(?, active) WHERE id = ?').run(str(req.body?.name, 60), flag(req.body?.active), id);
    if (Array.isArray(req.body?.keepers)) setKeepers(id, req.body.keepers);
    return { ok: true };
  });
  app.get('/methods', guard('finance.view', 'finance.cash'), async () => db.prepare('SELECT * FROM payment_methods ORDER BY active DESC, sort, id').all());
  app.post('/methods', guard('finance.cash'), async (req, reply) => {
    const name = str(req.body?.name, 40);
    if (!name) return bad(reply, 'Nomi shart');
    if (db.prepare('SELECT 1 FROM payment_methods WHERE lower(name) = lower(?)').get(name)) return bad(reply, 'Bunday tur bor');
    return { id: db.prepare('INSERT INTO payment_methods (name) VALUES (?)').run(name).lastInsertRowid };
  });
  app.patch('/methods/:id', guard('finance.cash'), async (req) => {
    db.prepare('UPDATE payment_methods SET name = COALESCE(?, name), active = COALESCE(?, active) WHERE id = ?').run(str(req.body?.name, 40), flag(req.body?.active), Number(req.params.id));
    return { ok: true };
  });
  cashOp('/expenses', createExpense, 'finance.cash', 'finance.expense');
  cashOp('/incomes', createIncome, 'finance.cash', 'finance.income');
  cashOp('/cash-openings', createCashOpening, 'finance.cash', 'finance.cash_open');
  // Kassa nazorati: count the money; a shortage asks who pays (like a stock count).
  cashOp('/cash-counts', createCashCount, 'finance.cash', 'finance.cash_count');
  // Moving money: finance.cash from any cashbox; a keeper from their own cashbox to the main one.
  app.post('/cash-moves', need(), async (req, reply) => {
    const b = req.body ?? {};
    if (!has(req, 'finance.cash')) {
      const own = db.prepare('SELECT 1 FROM cashbox_keepers WHERE cashbox_id = ? AND user_id = ?').get(Number(b.fromId), req.me.id);
      const main = db.prepare('SELECT 1 FROM cashboxes WHERE id = ? AND is_main = 1').get(Number(b.toId));
      if (!own || !main) return reply.code(403).send({ error: "Faqat o'z kassangizdan asosiy kassaga topshira olasiz" });
    }
    return run(reply, () => { const d = createCashMove(db, b, ctx(req)); log(req, 'finance.cash_move', { id: d.id, amount: b.amount }); return finDoc(db, d.id); });
  });
  app.get('/main-cashbox', need(), async () => db.prepare('SELECT id, name FROM cashboxes WHERE is_main = 1 AND active = 1 ORDER BY id LIMIT 1').get() ?? null);

  // ---------------------------------------------------------------- documents
  app.get('/docs', guard('finance.view'), async (req) => listFinDocs(db, {
    type: req.query.type || null, from: req.query.from || null, to: req.query.to || null,
    vendorId: Number(req.query.vendorId) || null, staffId: Number(req.query.staffId) || null, cashboxId: Number(req.query.cashboxId) || null,
  }));
  app.get('/docs/:id', guard('finance.view'), async (req, reply) => finDoc(db, Number(req.params.id)) ?? reply.code(404).send({ error: 'Topilmadi' }));
  app.post('/docs/:id/cancel', guard('finance.cash', 'finance.vendors', 'finance.payroll'), async (req, reply) => run(reply, () => {
    const d = finDoc(db, Number(req.params.id));
    if (!d) return reply.code(404).send({ error: 'Topilmadi' });
    const perm = { purchase: 'finance.vendors', vendor_pay: 'finance.vendors', salary: 'finance.payroll', bonus: 'finance.payroll', fine: 'finance.payroll',
      staff_pay: 'finance.payroll', staff_open: 'finance.payroll' }[d.type] ?? 'finance.cash';
    if (!has(req, perm)) return reply.code(403).send({ error: "Ruxsat yo'q" });
    cancelDoc(db, d.id, req.actor, req.body?.reason ? String(req.body.reason).slice(0, 300) : null);
    log(req, 'finance.cancel', { id: d.id, label: d.label });
    return finDoc(db, d.id);
  }));

  // ---------------------------------------------------------------- vendors
  app.get('/vendors', guard('finance.vendors', 'finance.view'), async (req) => listVendors(db, { all: req.query.all === '1' }));
  app.get('/vendors/:id', guard('finance.vendors', 'finance.view'), async (req, reply) => {
    const v = db.prepare('SELECT * FROM vendors WHERE id = ?').get(Number(req.params.id));
    if (!v) return reply.code(404).send({ error: 'Topilmadi' });
    return { ...v, ...statementOf(db, 'vendor', v.id), docs: listFinDocs(db, { vendorId: v.id, limit: 100 }) };
  });
  app.post('/vendors', guard('finance.vendors'), async (req, reply) => run(reply, () => ({ id: saveVendor(db, null, req.body ?? {}) })));
  app.put('/vendors/:id', guard('finance.vendors'), async (req, reply) => run(reply, () => { saveVendor(db, Number(req.params.id), req.body ?? {}); return { ok: true }; }));
  cashOp('/purchases', createPurchase, 'finance.vendors', 'finance.purchase');
  cashOp('/vendor-payments', createVendorPayment, 'finance.vendors', 'finance.vendor_pay');

  // ---------------------------------------------------------------- payroll
  app.get('/staff', guard('finance.payroll', 'finance.view'), async () => db.prepare(`SELECT u.id, u.login, COALESCE(u.name, u.login) AS name, u.salary, u.salary_day, u.salary_since, u.active, r.name AS role
    FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.is_test = 0 ORDER BY u.active DESC, name`).all().map((u) => ({ ...u, balance: staffBalance(db, u.id) })));
  app.get('/staff/:id', guard('finance.payroll', 'finance.view'), async (req, reply) => {
    const u = db.prepare('SELECT id, COALESCE(name, login) AS name, salary, salary_day, salary_since FROM users WHERE id = ?').get(Number(req.params.id));
    if (!u) return reply.code(404).send({ error: 'Topilmadi' });
    return { ...u, ...statementOf(db, 'staff', u.id) };
  });
  app.put('/staff/:id/salary', guard('finance.payroll'), async (req, reply) => run(reply, () => {
    setSalary(db, Number(req.params.id), req.body ?? {});
    log(req, 'finance.salary', { userId: Number(req.params.id), salary: req.body?.salary, day: req.body?.salaryDay });
    return { ok: true };
  }));
  for (const [path, type] of [['/bonuses', 'bonus'], ['/fines', 'fine'], ['/staff-payments', 'staff_pay'], ['/staff-openings', 'staff_open']]) {
    app.post(path, guard('finance.payroll'), async (req, reply) => run(reply, () => {
      const d = createStaffEntry(db, type, req.body ?? {}, ctx(req));
      log(req, `finance.${type}`, { id: d.id, userId: req.body?.userId, amount: req.body?.amount });
      return finDoc(db, d.id);
    }));
  }
}
