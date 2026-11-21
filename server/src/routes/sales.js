// Sales API (Yaya 2.0, stage 4), under /api/erp/sales. Sellers see prices, totals
// and their customers' debt (all on the receipt) but never cost or profit: those
// keys are stripped for anyone without stock.costs.
import { audit } from '../db/index.js';
import { makeGuard } from '../auth.js';
import { getSetting, setSetting } from '../settings.js';
import { StockError, cancelDoc, parseHolder } from '../erp/stock.js';
import {
  cashboxBalance, cashboxOf, createPayment, createReturn, createSale, customerCard, listCustomers, listSales, priceGrid,
  pricesFor, receiptHtml, saleDetail, saveCustomer, setPrice,
} from '../erp/sales.js';

const COST_KEYS = new Set(['cost', 'unit_cost', 'total_cost', 'cogs', 'profit']);
function stripCost(v) {
  if (Array.isArray(v)) return v.map(stripCost);
  if (v && typeof v === 'object' && !(v instanceof Buffer)) {
    const out = {};
    for (const [k, x] of Object.entries(v)) if (!COST_KEYS.has(k)) out[k] = stripCost(x);
    return out;
  }
  return v;
}

export default async function salesRoutes(app, { db }) {
  const need = makeGuard(app, db);
  const has = (req, p) => req.me.perms.has(p);
  const bad = (reply, msg, details) => reply.code(400).send({ error: msg, details });
  const deny = (reply) => reply.code(403).send({ error: "Ruxsat yo'q" });
  const log = (req, action, details) => audit(db, req.actor, action, details);
  const str = (v, max = 120) => (v == null ? null : String(v).trim().slice(0, max) || null);
  const run = (reply, fn) => { try { return fn(); } catch (e) { if (e instanceof StockError) return bad(reply, e.message, e.details); throw e; } };
  app.addHook('preSerialization', async (req, reply, payload) => (req.me && !req.me.perms.has('stock.costs') ? stripCost(payload) : payload));

  const seller = (req) => has(req, 'sales.sell') || has(req, 'sales.return') || has(req, 'sales.view_all');
  const keeperOf = (userId) => db.prepare('SELECT warehouse_id FROM warehouse_keepers WHERE user_id = ?').all(userId).map((r) => r.warehouse_id);
  const canSellFrom = (req, h) => !!h && (has(req, 'stock.manage') || h.userId === req.me.id || (h.warehouseId && keeperOf(req.me.id).includes(h.warehouseId)));

  // ---------------------------------------------------------------- reference data for the sale screens
  app.get('/meta', need(), async (req, reply) => {
    if (!seller(req) && !has(req, 'customers.manage') && !has(req, 'sales.prices')) return deny(reply);
    const keeps = keeperOf(req.me.id);
    return {
      customerTypes: db.prepare('SELECT * FROM customer_types ORDER BY active DESC, sort, name').all(),
      returnTypes: db.prepare(`SELECT r.*, w.name AS warehouse FROM return_types r LEFT JOIN warehouses w ON w.id = r.warehouse_id ORDER BY r.active DESC, r.sort, r.id`).all(),
      methods: db.prepare('SELECT * FROM payment_methods ORDER BY active DESC, sort, id').all(),
      sources: [{ userId: req.me.id, name: "Mening qo'lim" },
        ...db.prepare('SELECT id, name FROM warehouses WHERE active = 1 ORDER BY sort, name').all().filter((w) => has(req, 'stock.manage') || keeps.includes(w.id)).map((w) => ({ warehouseId: w.id, name: w.name }))],
      canEditPrice: has(req, 'sales.price_edit'),
      returnAvgDays: Number(getSetting(db, 'sales_return_avg_days')) || 7,
      receiptShowWeight: getSetting(db, 'receipt_show_weight') === '1',
    };
  });

  // ---------------------------------------------------------------- customers
  app.get('/customers', need(), async (req, reply) => {
    if (!seller(req) && !has(req, 'customers.manage')) return deny(reply);
    return listCustomers(db, { all: req.query.all === '1' && has(req, 'customers.manage') });
  });
  app.get('/customers/:id', need(), async (req, reply) => {
    if (!seller(req) && !has(req, 'customers.manage')) return deny(reply);
    const c = customerCard(db, Number(req.params.id));
    if (!c) return reply.code(404).send({ error: 'Topilmadi' });
    return { ...c, sales: listSales(db, { customerId: c.id, limit: 100 }) };
  });
  app.post('/customers', need(), async (req, reply) => {
    // Sellers may add a new customer on the spot (no opening balance); the rest is the manager's.
    if (!has(req, 'customers.manage') && !has(req, 'sales.sell')) return deny(reply);
    const body = has(req, 'customers.manage') ? req.body ?? {} : { ...req.body, openingBalance: 0 };
    return run(reply, () => { const id = saveCustomer(db, null, body); log(req, 'customer.create', { id, name: req.body?.name }); return { id }; });
  });
  app.put('/customers/:id', need('customers.manage'), async (req, reply) => run(reply, () => {
    const id = saveCustomer(db, Number(req.params.id), req.body ?? {});
    log(req, 'customer.update', { id, name: req.body?.name });
    return { ok: true };
  }));
  app.post('/customer-types', need('customers.manage'), async (req, reply) => {
    const name = str(req.body?.name, 60);
    if (!name) return bad(reply, 'Nomi shart');
    if (db.prepare('SELECT 1 FROM customer_types WHERE lower(name) = lower(?)').get(name)) return bad(reply, 'Bunday tur bor');
    return { id: db.prepare('INSERT INTO customer_types (name) VALUES (?)').run(name).lastInsertRowid };
  });
  app.patch('/customer-types/:id', need('customers.manage'), async (req) => {
    db.prepare('UPDATE customer_types SET name = COALESCE(?, name), active = COALESCE(?, active) WHERE id = ?')
      .run(str(req.body?.name, 60), req.body?.active == null ? null : Number(!!req.body.active), Number(req.params.id));
    return { ok: true };
  });

  // ---------------------------------------------------------------- prices
  app.get('/prices', need(), async (req, reply) => {
    if (req.query.customerId) { if (!seller(req)) return deny(reply); return pricesFor(db, Number(req.query.customerId)); }
    if (!has(req, 'sales.prices') && !has(req, 'sales.view_all')) return deny(reply);
    return priceGrid(db);
  });
  app.put('/prices', need('sales.prices'), async (req, reply) => run(reply, () => {
    const list = Array.isArray(req.body) ? req.body : [req.body];
    db.transaction(() => { for (const x of list) setPrice(db, x ?? {}, req.actor); })();
    log(req, 'prices.update', { count: list.length });
    return { ok: true };
  }));

  // ---------------------------------------------------------------- settings
  const flag = (v) => (v == null ? null : Number(!!v));
  app.post('/return-types', need('sales.manage'), async (req, reply) => {
    const name = str(req.body?.name, 60);
    if (!name) return bad(reply, 'Nomi shart');
    if (!db.prepare('SELECT 1 FROM warehouses WHERE id = ?').get(Number(req.body?.warehouseId))) return bad(reply, 'Omborni tanlang');
    return { id: db.prepare('INSERT INTO return_types (name, warehouse_id, expired) VALUES (?, ?, ?)').run(name, Number(req.body.warehouseId), flag(req.body.expired) ?? 0).lastInsertRowid };
  });
  app.patch('/return-types/:id', need('sales.manage'), async (req, reply) => {
    const b = req.body ?? {};
    if (b.warehouseId != null && !db.prepare('SELECT 1 FROM warehouses WHERE id = ?').get(Number(b.warehouseId))) return bad(reply, 'Ombor topilmadi');
    db.prepare('UPDATE return_types SET name = COALESCE(?, name), warehouse_id = COALESCE(?, warehouse_id), expired = COALESCE(?, expired), active = COALESCE(?, active) WHERE id = ?')
      .run(str(b.name, 60), b.warehouseId == null ? null : Number(b.warehouseId), flag(b.expired), flag(b.active), Number(req.params.id));
    return { ok: true };
  });
  app.post('/methods', need('sales.manage'), async (req, reply) => {
    const name = str(req.body?.name, 40);
    if (!name) return bad(reply, 'Nomi shart');
    if (db.prepare('SELECT 1 FROM payment_methods WHERE lower(name) = lower(?)').get(name)) return bad(reply, 'Bunday tur bor');
    return { id: db.prepare('INSERT INTO payment_methods (name) VALUES (?)').run(name).lastInsertRowid };
  });
  app.patch('/methods/:id', need('sales.manage'), async (req) => {
    db.prepare('UPDATE payment_methods SET name = COALESCE(?, name), active = COALESCE(?, active) WHERE id = ?').run(str(req.body?.name, 40), flag(req.body?.active), Number(req.params.id));
    return { ok: true };
  });
  app.get('/cashboxes', need(), async (req, reply) => {
    if (!has(req, 'sales.manage') && !has(req, 'stock.costs')) return deny(reply);
    return db.prepare('SELECT * FROM cashboxes ORDER BY is_main DESC, active DESC, name').all().map((c) => ({
      ...c, balance: cashboxBalance(db, c.id),
      keepers: db.prepare('SELECT u.id, COALESCE(u.name, u.login) AS name FROM cashbox_keepers k JOIN users u ON u.id = k.user_id WHERE k.cashbox_id = ?').all(c.id),
    }));
  });
  app.post('/cashboxes', need('sales.manage'), async (req, reply) => {
    const name = str(req.body?.name, 60);
    if (!name) return bad(reply, 'Nomi shart');
    const id = Number(db.prepare('INSERT INTO cashboxes (name) VALUES (?)').run(name).lastInsertRowid);
    for (const u of req.body?.keepers ?? []) db.prepare('INSERT OR IGNORE INTO cashbox_keepers (cashbox_id, user_id) SELECT ?, id FROM users WHERE id = ?').run(id, Number(u));
    return { id };
  });
  app.patch('/cashboxes/:id', need('sales.manage'), async (req) => {
    const id = Number(req.params.id);
    db.prepare('UPDATE cashboxes SET name = COALESCE(?, name), active = COALESCE(?, active) WHERE id = ?').run(str(req.body?.name, 60), flag(req.body?.active), id);
    if (Array.isArray(req.body?.keepers)) {
      db.prepare('DELETE FROM cashbox_keepers WHERE cashbox_id = ?').run(id);
      for (const u of req.body.keepers) db.prepare('INSERT OR IGNORE INTO cashbox_keepers (cashbox_id, user_id) SELECT ?, id FROM users WHERE id = ?').run(id, Number(u));
    }
    return { ok: true };
  });
  app.put('/settings', need('sales.manage'), async (req) => {
    if (req.body?.returnAvgDays != null) setSetting(db, 'sales_return_avg_days', Math.max(1, Math.min(365, Number(req.body.returnAvgDays) || 7)));
    if (req.body?.receiptShowWeight != null) setSetting(db, 'receipt_show_weight', req.body.receiptShowWeight ? '1' : '0');
    return { ok: true };
  });

  // ---------------------------------------------------------------- documents
  app.get('/docs', need(), async (req, reply) => {
    if (!seller(req)) return deny(reply);
    const q = { type: req.query.type || null, from: req.query.from || null, to: req.query.to || null, customerId: Number(req.query.customerId) || null };
    return listSales(db, has(req, 'sales.view_all') ? { ...q, userId: Number(req.query.userId) || null } : { ...q, userId: req.me.id });
  });
  app.get('/docs/:id', need(), async (req, reply) => {
    const d = saleDetail(db, Number(req.params.id));
    if (!d) return reply.code(404).send({ error: 'Topilmadi' });
    if (d.created_by_id !== req.me.id && !has(req, 'sales.view_all')) return deny(reply);
    return d;
  });
  app.get('/docs/:id/receipt', need(), async (req, reply) => {
    const d = saleDetail(db, Number(req.params.id));
    if (!d) return reply.code(404).send({ error: 'Topilmadi' });
    if (d.created_by_id !== req.me.id && !has(req, 'sales.view_all')) return deny(reply);
    const logo = db.prepare("SELECT updated_at FROM files WHERE key = 'logo'").get();
    return { html: receiptHtml(db, d.id, { logoUrl: logo ? `/api/public/logo.png` : null }) };
  });
  const mine = (req) => ({ actor: req.actor, userId: req.me.id, allowPrice: has(req, 'sales.price_edit') });
  app.post('/sales', need('sales.sell'), async (req, reply) => {
    const from = parseHolder(db, req.body?.from);
    if (!canSellFrom(req, from)) return reply.code(403).send({ error: 'Bu joydan sota olmaysiz' });
    return run(reply, () => { const d = createSale(db, { ...req.body, from }, mine(req)); log(req, 'sale.create', { id: d.id, number: d.number }); return saleDetail(db, d.id); });
  });
  app.post('/returns', need('sales.return'), async (req, reply) => run(reply, () => {
    const d = createReturn(db, req.body ?? {}, mine(req));
    log(req, 'return.create', { id: d.id, number: d.number });
    return saleDetail(db, d.id);
  }));
  app.post('/payments', need('sales.sell'), async (req, reply) => run(reply, () => {
    const d = createPayment(db, req.body ?? {}, mine(req));
    log(req, 'customer.payment', { id: d.id, number: d.number, amount: req.body?.amount });
    return saleDetail(db, d.id);
  }));
  app.post('/docs/:id/cancel', need('sales.cancel'), async (req, reply) => run(reply, () => {
    const d = saleDetail(db, Number(req.params.id));
    if (!d) return reply.code(404).send({ error: 'Topilmadi' });
    cancelDoc(db, d.id, req.actor, str(req.body?.reason, 300));
    log(req, 'sale.cancel', { id: d.id, label: d.label });
    return saleDetail(db, d.id);
  }));

  // My cashbox (the seller's own money for the day): only the total, no costs.
  app.get('/my-cashbox', need('sales.sell'), async (req) => {
    const id = cashboxOf(db, req.me.id);
    return { id, name: db.prepare('SELECT name FROM cashboxes WHERE id = ?').get(id).name, balance: cashboxBalance(db, id) };
  });
}
