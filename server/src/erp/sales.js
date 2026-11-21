// Sales (Yaya 2.0, stage 4): customers, prices, sales, returns, payments and the
// 80 mm receipt. Built on the stock engine: a sale is a document that takes goods
// out FIFO from the seller's place (their hands or a warehouse they keep); a return
// brings goods into the warehouse of its return type. Every sale / return / payment
// can be cancelled, which reverses stock, the customer's balance, profit and loss
// and the cashbox exactly (cancelDocTx).
//
// Money:
// - customer balance = opening balance + party entries (positive = the customer owes us);
// - a sale books revenue (sales_revenue) and its FIFO cost (cogs); a return books
//   them back: revenue by what the customer is credited, cost by the chosen return cost;
// - money taken goes to the seller's own cashbox (made on first use).
import { randomUUID } from 'node:crypto';
import { getSetting } from '../settings.js';
import {
  StockError, addIn, getDoc, holderName, lastUnitCost, nextNumber, pnl, r2, r3, takeOut,
} from './stock.js';

const nowIso = () => new Date().toISOString();
const J = (v) => (v ? JSON.parse(v) : {});
const num = (v) => (v == null || v === '' ? null : Number(v));
const product = (db, id) => db.prepare('SELECT * FROM products WHERE id = ?').get(id);

// ---------------------------------------------------------------- customers
export function customerBalance(db, id) {
  const c = db.prepare('SELECT opening_balance FROM customers WHERE id = ?').get(id);
  if (!c) return 0;
  return r2(c.opening_balance + db.prepare("SELECT COALESCE(SUM(amount), 0) AS a FROM party_entries WHERE party_type = 'customer' AND party_id = ?").get(id).a);
}

export function listCustomers(db, { all = false } = {}) {
  return db.prepare(`SELECT c.*, t.name AS type_name FROM customers c LEFT JOIN customer_types t ON t.id = c.type_id
    ${all ? '' : 'WHERE c.active = 1'} ORDER BY c.active DESC, c.name`).all().map((c) => ({ ...c, balance: customerBalance(db, c.id) }));
}

export function saveCustomer(db, id, b) {
  const name = String(b?.name ?? '').trim().slice(0, 120);
  if (!name) throw new StockError('Mijoz nomini yozing');
  const typeId = num(b.typeId);
  if (typeId && !db.prepare('SELECT 1 FROM customer_types WHERE id = ?').get(typeId)) throw new StockError('Mijoz turi topilmadi');
  const opening = num(b.openingBalance) ?? 0;
  if (!Number.isFinite(opening)) throw new StockError("Boshlang'ich qarz noto'g'ri");
  const policy = b.expiredPolicy === 'keep' ? 'keep' : 'reduce';
  const phone = b.phone ? String(b.phone).replace(/[^\d+]/g, '').slice(0, 20) : null;
  if (id) {
    if (!db.prepare('SELECT 1 FROM customers WHERE id = ?').get(id)) throw new StockError('Mijoz topilmadi');
    db.prepare(`UPDATE customers SET name = ?, phone = ?, type_id = ?, address = ?, note = ?, opening_balance = ?, expired_policy = ?,
      active = COALESCE(?, active) WHERE id = ?`).run(name, phone, typeId, b.address ?? null, b.note ?? null, opening, policy, b.active == null ? null : Number(!!b.active), id);
    return id;
  }
  return Number(db.prepare('INSERT INTO customers (name, phone, type_id, address, note, opening_balance, expired_policy) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(name, phone, typeId, b.address ?? null, b.note ?? null, opening, policy).lastInsertRowid);
}

// ---------------------------------------------------------------- prices
// The most specific price wins: this customer, then their type, then the base price.
export function priceFor(db, productId, customer) {
  const scopes = [customer ? `c:${customer.id}` : null, customer?.type_id ? `t:${customer.type_id}` : null, 'base'].filter(Boolean);
  for (const sc of scopes) {
    const p = db.prepare('SELECT price FROM product_prices WHERE product_id = ? AND scope = ?').get(productId, sc);
    if (p) return p.price;
  }
  return null;
}

// Prices of every sellable product for a customer (for the sale screen).
export function pricesFor(db, customerId) {
  const c = customerId ? db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId) : null;
  return Object.fromEntries(db.prepare('SELECT DISTINCT product_id FROM product_prices').all().map((r) => [r.product_id, priceFor(db, r.product_id, c)]));
}

export function priceGrid(db) {
  return db.prepare('SELECT product_id, scope, price FROM product_prices').all();
}

export function setPrice(db, { productId, scope, price }, actor) {
  if (!product(db, Number(productId))) throw new StockError('Mahsulot topilmadi');
  const sc = String(scope ?? 'base');
  if (!/^(base|t:\d+|c:\d+)$/.test(sc)) throw new StockError('Narx turi noto\'g\'ri');
  if (price === null || price === '') {
    db.prepare('DELETE FROM product_prices WHERE product_id = ? AND scope = ?').run(Number(productId), sc);
    return;
  }
  const p = Number(price);
  if (!(p >= 0)) throw new StockError('Narx noto\'g\'ri');
  db.prepare(`INSERT INTO product_prices (product_id, scope, price, updated_at, updated_by) VALUES (?, ?, ?, datetime('now'), ?)
    ON CONFLICT(product_id, scope) DO UPDATE SET price = excluded.price, updated_at = excluded.updated_at, updated_by = excluded.updated_by`).run(Number(productId), sc, p, actor);
}

// ---------------------------------------------------------------- cashboxes
// The seller's own cashbox; one is made for them on first use.
export function cashboxOf(db, userId) {
  const own = db.prepare('SELECT c.id FROM cashboxes c JOIN cashbox_keepers k ON k.cashbox_id = c.id WHERE k.user_id = ? AND c.active = 1 ORDER BY c.is_main, c.id LIMIT 1').get(userId);
  if (own) return own.id;
  const id = Number(db.prepare('INSERT INTO cashboxes (name) VALUES (?)').run(`${holderName(db, { userId })} kassasi`).lastInsertRowid);
  db.prepare('INSERT INTO cashbox_keepers (cashbox_id, user_id) VALUES (?, ?)').run(id, userId);
  return id;
}
export const cashboxBalance = (db, id) => r2(db.prepare('SELECT COALESCE(SUM(amount), 0) AS a FROM cash_entries WHERE cashbox_id = ?').get(id).a);

// ---------------------------------------------------------------- documents
const party = (db, ctx, customerId, amount, kind, note) => {
  if (Math.abs(amount) < 0.005) return;
  db.prepare("INSERT INTO party_entries (party_type, party_id, amount, kind, doc_id, note, at) VALUES ('customer', ?, ?, ?, ?, ?, ?)")
    .run(customerId, r2(amount), kind, ctx.doc.id, note, ctx.at);
};
const cash = (db, ctx, cashboxId, amount, methodId, kind) => {
  if (Math.abs(amount) < 0.005) return;
  db.prepare('INSERT INTO cash_entries (cashbox_id, amount, method_id, doc_id, kind, at) VALUES (?, ?, ?, ?, ?, ?)').run(cashboxId, r2(amount), methodId, ctx.doc.id, kind, ctx.at);
};

function newDoc(db, type, { uuid, customerId, from, to, note, actor, userId }) {
  const id = Number(db.prepare(`INSERT INTO docs (uuid, type, number, status, doc_date, from_wh, from_user, to_wh, to_user, customer_id, note, created_by, created_by_id)
    VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(uuid, type, nextNumber(db, type), nowIso(), from?.warehouseId ?? null, from?.userId ?? null,
    to?.warehouseId ?? null, to?.userId ?? null, customerId, note ? String(note).slice(0, 500) : null, actor, userId).lastInsertRowid);
  return getDoc(db, id);
}
const finish = (db, ctx, actor, meta) => {
  db.prepare("UPDATE docs SET status = 'posted', posted_by = ?, posted_at = ?, meta = ? WHERE id = ?").run(actor, nowIso(), JSON.stringify(meta), ctx.doc.id);
};
function existing(db, uuid, type) {
  const d = db.prepare('SELECT * FROM docs WHERE uuid = ?').get(uuid);
  if (d && d.type !== type) throw new StockError('Bu UUID boshqa hujjatda ishlatilgan');
  return d;
}
function cleanSaleLines(db, lines, customer, allowPrice) {
  if (!Array.isArray(lines) || !lines.length) throw new StockError('Kamida bitta mahsulot kiriting');
  return lines.map((l, i) => {
    const p = product(db, Number(l.productId));
    if (!p) throw new StockError(`${i + 1}-qator: mahsulot topilmadi`);
    const qty = r3(l.qty);
    if (!(qty > 0)) throw new StockError(`${p.name}: miqdor noto'g'ri`);
    let price = priceFor(db, p.id, customer);
    if (l.price != null && l.price !== '' && Number(l.price) !== price) {
      if (!allowPrice) throw new StockError(`${p.name}: narxni o'zgartirishga ruxsat yo'q`);
      price = Number(l.price);
    }
    if (price == null || !(price >= 0)) throw new StockError(`${p.name}: narx belgilanmagan`);
    return { productId: p.id, qty, price };
  });
}
const activeCustomer = (db, id) => {
  const c = db.prepare('SELECT * FROM customers WHERE id = ? AND active = 1').get(Number(id));
  if (!c) throw new StockError('Mijozni tanlang');
  return c;
};
const method = (db, id) => {
  const m = db.prepare('SELECT * FROM payment_methods WHERE id = ? AND active = 1').get(Number(id));
  return m ?? db.prepare('SELECT * FROM payment_methods WHERE active = 1 ORDER BY sort, id LIMIT 1').get();
};

// A sale: goods out of `from` (FIFO), the customer owes the total, minus what they pay now.
export function createSale(db, b, { actor, userId, allowPrice = false }) {
  const uuid = String(b.uuid || randomUUID()).slice(0, 80);
  const ex = existing(db, uuid, 'sale');
  if (ex) return ex;
  const customer = activeCustomer(db, b.customerId);
  const from = b.from;
  if (!from) throw new StockError('Qayerdan sotilishini tanlang');
  const lines = cleanSaleLines(db, b.lines, customer, allowPrice);
  const paid = r2(num(b.paid) ?? 0);
  if (!(paid >= 0)) throw new StockError('To\'langan summa noto\'g\'ri');
  return db.transaction(() => {
    const doc = newDoc(db, 'sale', { uuid, customerId: customer.id, from, note: b.note, actor, userId });
    const ctx = { doc, at: nowIso(), touched: new Set() };
    const before = customerBalance(db, customer.id);
    const ins = db.prepare('INSERT INTO doc_lines (doc_id, product_id, qty, price, sort) VALUES (?, ?, ?, ?, ?)');
    let total = 0; let cogs = 0;
    lines.forEach((l, i) => {
      const lid = Number(ins.run(doc.id, l.productId, l.qty, l.price, i).lastInsertRowid);
      cogs += takeOut(db, ctx, { productId: l.productId, h: from, qty: l.qty, lineId: lid, kind: 'sale' }).reduce((a, x) => a + x.cost, 0);
      total += r2(l.qty * l.price);
    });
    total = r2(total);
    party(db, ctx, customer.id, total, 'sale', null);
    pnl(db, ctx, 'sales_revenue', total, customer.name);
    pnl(db, ctx, 'cogs', cogs, customer.name);
    let cashboxId = null; let m = null;
    if (paid > 0) {
      m = method(db, b.methodId);
      cashboxId = cashboxOf(db, userId);
      party(db, ctx, customer.id, -paid, 'payment', m?.name);
      cash(db, ctx, cashboxId, paid, m?.id, 'sale');
    }
    finish(db, ctx, actor, { total, paid, method: m?.name ?? null, cashboxId, debt_before: before, debt_after: customerBalance(db, customer.id) });
    return getDoc(db, doc.id);
  })();
}

// Cost of a returned product for this customer: "last" = the cost of the last lot
// sold to them; "avg" = their sales of it in the last N days, cost ÷ quantity.
export function returnUnitCost(db, customerId, productId, mode) {
  if (mode === 'avg') {
    const days = Number(getSetting(db, 'sales_return_avg_days')) || 7;
    const r = db.prepare(`SELECT SUM(-m.cost) AS c, SUM(-m.qty) AS q FROM stock_moves m JOIN docs d ON d.id = m.doc_id
      WHERE d.type = 'sale' AND d.status = 'posted' AND d.customer_id = ? AND m.product_id = ? AND m.qty < 0 AND m.kind = 'sale'
        AND d.doc_date >= datetime('now', ?)`).get(customerId, productId, `-${days} days`);
    if (r?.q > 0) return { unit: r.c / r.q, source: `o'rtacha (${days} kun)` };
  }
  const last = db.prepare(`SELECT m.lot_id, l.unit_cost, l.expires_at FROM stock_moves m JOIN docs d ON d.id = m.doc_id LEFT JOIN lots l ON l.id = m.lot_id
    WHERE d.type = 'sale' AND d.status = 'posted' AND d.customer_id = ? AND m.product_id = ? AND m.qty < 0 AND m.kind = 'sale'
    ORDER BY d.doc_date DESC, m.id DESC LIMIT 1`).get(customerId, productId);
  if (last?.lot_id) return { unit: last.unit_cost, expires: last.expires_at, source: 'oxirgi partiya' };
  return { unit: lastUnitCost(db, productId), source: 'oxirgi tannarx' };
}
const lastSalePrice = (db, customerId, productId) => db.prepare(`SELECT dl.price FROM doc_lines dl JOIN docs d ON d.id = dl.doc_id
  WHERE d.type = 'sale' AND d.status = 'posted' AND d.customer_id = ? AND dl.product_id = ? ORDER BY d.doc_date DESC, dl.id DESC LIMIT 1`).get(customerId, productId)?.price;

// A return: goods into the return type's warehouse at the chosen cost; the customer
// is credited the price, unless it is an expired return and their policy keeps the debt.
export function createReturn(db, b, { actor, userId, allowPrice = false }) {
  const uuid = String(b.uuid || randomUUID()).slice(0, 80);
  const ex = existing(db, uuid, 'return');
  if (ex) return ex;
  const customer = activeCustomer(db, b.customerId);
  const rt = db.prepare('SELECT * FROM return_types WHERE id = ? AND active = 1').get(Number(b.returnTypeId));
  if (!rt) throw new StockError('Qaytarish turini tanlang');
  if (!rt.warehouse_id || !db.prepare('SELECT 1 FROM warehouses WHERE id = ? AND active = 1').get(rt.warehouse_id)) throw new StockError(`"${rt.name}" uchun ombor belgilanmagan`);
  const mode = b.costMode === 'avg' ? 'avg' : 'last';
  if (!Array.isArray(b.lines) || !b.lines.length) throw new StockError('Kamida bitta mahsulot kiriting');
  const lines = b.lines.map((l, i) => {
    const p = product(db, Number(l.productId));
    if (!p) throw new StockError(`${i + 1}-qator: mahsulot topilmadi`);
    const qty = r3(l.qty);
    if (!(qty > 0)) throw new StockError(`${p.name}: miqdor noto'g'ri`);
    let price = lastSalePrice(db, customer.id, p.id) ?? priceFor(db, p.id, customer) ?? 0;
    if (l.price != null && l.price !== '' && Number(l.price) !== price) {
      if (!allowPrice) throw new StockError(`${p.name}: narxni o'zgartirishga ruxsat yo'q`);
      price = Number(l.price);
    }
    return { productId: p.id, qty, price };
  });
  const credited = !rt.expired || customer.expired_policy === 'reduce';
  const to = { warehouseId: rt.warehouse_id };
  return db.transaction(() => {
    const doc = newDoc(db, 'return', { uuid, customerId: customer.id, to, note: b.note, actor, userId });
    const ctx = { doc, at: nowIso(), touched: new Set() };
    const before = customerBalance(db, customer.id);
    const ins = db.prepare('INSERT INTO doc_lines (doc_id, product_id, qty, price, unit_cost, meta, sort) VALUES (?, ?, ?, ?, ?, ?, ?)');
    let value = 0; let cost = 0;
    lines.forEach((l, i) => {
      const uc = returnUnitCost(db, customer.id, l.productId, mode);
      const c = r2(l.qty * uc.unit);
      const lid = Number(ins.run(doc.id, l.productId, l.qty, l.price, uc.unit, JSON.stringify({ costSource: uc.source }), i).lastInsertRowid);
      addIn(db, ctx, { productId: l.productId, h: to, qty: l.qty, cost: c, lineId: lid, kind: 'return',
        lot: { unitCost: uc.unit, seq: i + 1, expiresAt: rt.expired ? ctx.at : (uc.expires ?? undefined) } });
      value += r2(l.qty * l.price); cost += c;
    });
    value = r2(value);
    const credit = credited ? value : 0;
    party(db, ctx, customer.id, -credit, 'return', rt.name);
    pnl(db, ctx, 'sales_revenue', -credit, `${customer.name}: qaytarish (${rt.name})`);
    pnl(db, ctx, 'cogs', -cost, `${customer.name}: qaytarish (${rt.name})`);
    finish(db, ctx, actor, { total: value, credit, credited, return_type: rt.name, return_type_id: rt.id, expired: !!rt.expired, cost_mode: mode,
      debt_before: before, debt_after: customerBalance(db, customer.id) });
    return getDoc(db, doc.id);
  })();
}

// Money from a customer (paying off debt) into the receiver's cashbox.
export function createPayment(db, b, { actor, userId }) {
  const uuid = String(b.uuid || randomUUID()).slice(0, 80);
  const ex = existing(db, uuid, 'payment');
  if (ex) return ex;
  const customer = activeCustomer(db, b.customerId);
  const amount = r2(num(b.amount) ?? 0);
  if (!(amount > 0)) throw new StockError('Summani kiriting');
  return db.transaction(() => {
    const doc = newDoc(db, 'payment', { uuid, customerId: customer.id, note: b.note, actor, userId });
    const ctx = { doc, at: nowIso(), touched: new Set() };
    const before = customerBalance(db, customer.id);
    const m = method(db, b.methodId);
    const cashboxId = cashboxOf(db, userId);
    party(db, ctx, customer.id, -amount, 'payment', m?.name);
    cash(db, ctx, cashboxId, amount, m?.id, 'payment');
    finish(db, ctx, actor, { total: amount, paid: amount, method: m?.name ?? null, cashboxId, debt_before: before, debt_after: customerBalance(db, customer.id) });
    return getDoc(db, doc.id);
  })();
}

// ---------------------------------------------------------------- reading
const TYPE = { sale: 'Sotuv', return: 'Qaytarish', payment: "To'lov" };
export function saleDetail(db, id) {
  const d = getDoc(db, id);
  if (!d || !TYPE[d.type]) return null;
  const m = J(d.meta);
  const c = d.customer_id ? db.prepare('SELECT id, name, phone FROM customers WHERE id = ?').get(d.customer_id) : null;
  const lines = db.prepare(`SELECT dl.id, dl.product_id, p.name AS product, p.unit, p.netto_g, p.volume, p.volume_unit, dl.qty, dl.price, dl.unit_cost
    FROM doc_lines dl JOIN products p ON p.id = dl.product_id WHERE dl.doc_id = ? ORDER BY dl.sort, dl.id`).all(id).map((l) => {
    const cost = d.type === 'sale'
      ? r2(db.prepare("SELECT COALESCE(SUM(-cost), 0) AS c FROM stock_moves WHERE line_id = ? AND qty < 0 AND kind = 'sale'").get(l.id).c)
      : r2((l.unit_cost ?? 0) * l.qty);
    return { ...l, sum: r2(l.qty * (l.price ?? 0)), cost };
  });
  const from = d.from_wh ? { warehouseId: d.from_wh } : d.from_user ? { userId: d.from_user } : null;
  const to = d.to_wh ? { warehouseId: d.to_wh } : null;
  return {
    id: d.id, uuid: d.uuid, type: d.type, type_label: TYPE[d.type], number: d.number, label: `${{ sale: 'S', return: 'Q', payment: 'TL' }[d.type]}-${d.number}`,
    status: d.status, doc_date: d.doc_date, note: d.note, customer: c, from, from_name: holderName(db, from), to, to_name: holderName(db, to),
    seller: d.created_by_id ? holderName(db, { userId: d.created_by_id }) : d.created_by, created_by: d.created_by, created_by_id: d.created_by_id,
    cancelled_at: d.cancelled_at, cancel_reason: d.cancel_reason,
    total: m.total ?? 0, paid: m.paid ?? 0, credit: m.credit, credited: m.credited, method: m.method, return_type: m.return_type, expired: m.expired, cost_mode: m.cost_mode,
    debt_before: m.debt_before, debt_after: m.debt_after,
    lines, total_cost: r2(lines.reduce((a, l) => a + l.cost, 0)),
    total_qty: r3(lines.reduce((a, l) => a + l.qty, 0)),
    total_weight_kg: r3(lines.reduce((a, l) => a + (l.netto_g ? (l.qty * l.netto_g) / 1000 : l.unit === 'kg' ? l.qty : 0), 0)),
    total_volume: r3(lines.reduce((a, l) => a + (l.volume ? l.qty * l.volume : 0), 0)),
  };
}

export function listSales(db, { type, from, to, customerId, userId, limit = 300 } = {}) {
  const where = ["type IN ('sale','return','payment')"]; const args = [];
  if (type) { where.push('type = ?'); args.push(type); }
  if (customerId) { where.push('customer_id = ?'); args.push(customerId); }
  if (userId) { where.push('created_by_id = ?'); args.push(userId); }
  if (from) { where.push("date(doc_date, '+5 hours') >= ?"); args.push(from); }
  if (to) { where.push("date(doc_date, '+5 hours') <= ?"); args.push(to); }
  return db.prepare(`SELECT id FROM docs WHERE ${where.join(' AND ')} ORDER BY doc_date DESC, id DESC LIMIT ?`).all(...args, Math.min(limit, 1000))
    .map((r) => { const s = saleDetail(db, r.id); delete s.lines; return s; });
}

// Customer card: balance and every movement of it (statement).
export function customerCard(db, id) {
  const c = db.prepare('SELECT c.*, t.name AS type_name FROM customers c LEFT JOIN customer_types t ON t.id = c.type_id WHERE c.id = ?').get(id);
  if (!c) return null;
  let run = c.opening_balance;
  const entries = db.prepare(`SELECT e.amount, e.kind, e.note, e.at, e.doc_id, d.type, d.number FROM party_entries e LEFT JOIN docs d ON d.id = e.doc_id
    WHERE e.party_type = 'customer' AND e.party_id = ? ORDER BY e.at, e.id`).all(id)
    .map((e) => { run = r2(run + e.amount); return { ...e, balance: run }; }).reverse();
  return { ...c, balance: customerBalance(db, id), entries };
}

// ---------------------------------------------------------------- receipt (80 mm)
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const money = (n) => (n == null ? '—' : Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' '));
const qtyf = (n) => String(Math.round(n * 1000) / 1000);
const local = (iso) => new Date(Date.parse(iso) + 5 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');

export function receiptHtml(db, id, { logoUrl = null } = {}) {
  const s = saleDetail(db, id);
  if (!s) return null;
  const company = getSetting(db, 'company_name') || 'Yaya';
  const showWeight = getSetting(db, 'receipt_show_weight') === '1';
  const title = s.type === 'return' ? `QAYTARISH — ${esc(s.return_type)}` : s.type === 'payment' ? "TO'LOV" : 'SOTUV';
  const rows = s.lines.map((l) => `<tr><td colspan="3">${esc(l.product)}</td></tr><tr><td>${qtyf(l.qty)} ${esc(l.unit)} × ${money(l.price)}</td><td></td><td class="r">${money(l.sum)}</td></tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(s.label)}</title><style>
    @page { size: 80mm auto; margin: 3mm; } body { width: 74mm; margin: 0 auto; font: 12px/1.35 'Courier New', monospace; color: #000; }
    h1 { font-size: 15px; text-align: center; margin: 4px 0; } .c { text-align: center; } .r { text-align: right; } table { width: 100%; border-collapse: collapse; }
    hr { border: 0; border-top: 1px dashed #000; margin: 6px 0; } .b { font-weight: bold; } .big { font-size: 14px; } img { display: block; margin: 0 auto; max-width: 30mm; max-height: 20mm; }
    .sign { margin-top: 18px; display: flex; justify-content: space-between; gap: 8px; } .sign div { flex: 1; border-top: 1px solid #000; text-align: center; padding-top: 2px; font-size: 10px; }
    @media screen { body { padding: 8px; background: #fff; } }
  </style></head><body>
  ${logoUrl ? `<img src="${esc(logoUrl)}" alt="">` : ''}<h1>${esc(company)}</h1>
  <div class="c b big">${title}${s.status === 'cancelled' ? ' (BEKOR QILINGAN)' : ''}</div>
  <div class="c">${esc(s.label)} · ${local(s.doc_date)}</div><hr>
  <table><tr><td>Mijoz:</td><td class="r">${esc(s.customer?.name)}</td></tr>${s.customer?.phone ? `<tr><td>Tel:</td><td class="r">${esc(s.customer.phone)}</td></tr>` : ''}
  <tr><td>Sotuvchi:</td><td class="r">${esc(s.seller)}</td></tr></table><hr>
  ${s.lines.length ? `<table>${rows}</table><hr>` : ''}
  <table>
    ${s.lines.length ? `<tr><td>Jami miqdor:</td><td class="r">${qtyf(s.total_qty)}</td></tr>` : ''}
    ${showWeight && s.total_weight_kg ? `<tr><td>Umumiy vazn:</td><td class="r">${qtyf(s.total_weight_kg)} kg</td></tr>` : ''}
    ${showWeight && s.total_volume ? `<tr><td>Umumiy hajm:</td><td class="r">${qtyf(s.total_volume)}</td></tr>` : ''}
    <tr class="b big"><td>${s.type === 'payment' ? "To'landi" : 'JAMI'}:</td><td class="r">${money(s.total)}</td></tr>
    ${s.type === 'sale' ? `<tr><td>To'landi${s.method ? ` (${esc(s.method)})` : ''}:</td><td class="r">${money(s.paid)}</td></tr>` : ''}
    ${s.type === 'payment' && s.method ? `<tr><td>To'lov turi:</td><td class="r">${esc(s.method)}</td></tr>` : ''}
    ${s.type === 'return' ? `<tr><td>Qarzdan ayrildi:</td><td class="r">${money(s.credit)}</td></tr>` : ''}
  </table><hr>
  <table><tr><td>Oldingi qarz:</td><td class="r">${money(s.debt_before)}</td></tr><tr class="b"><td>Hozirgi qarz:</td><td class="r">${money(s.debt_after)}</td></tr></table>
  <div class="sign"><div>Topshirdi</div><div>Qabul qildi</div></div>
  <p class="c" style="margin-top:10px">Xaridingiz uchun rahmat!</p>
  </body></html>`;
}
