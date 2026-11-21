// Finance and payroll (Yaya 2.0, stage 6). Every operation is a document over the
// three ledgers — stock (stock_moves), parties (party_entries) and cash
// (cash_entries) — plus profit and loss (pnl_entries), so each one can be cancelled
// with an exact reversal (cancelDocTx).
//
// Signs:
// - cashbox: + money in, − money out;
// - staff:    positive = the person owes the company, negative = the company owes them
//             (salary, bonus and piece rates make it negative; payouts, fines and
//             goods lost by their fault make it positive);
// - vendor:   positive = we owe the vendor (purchases +, payments −);
// - customer: positive = the customer owes us (stage 4).
import { randomUUID } from 'node:crypto';
import {
  StockError, addIn, getDoc, holderName, nextNumber, pnl, r2, r3,
} from './stock.js';
import { cashboxBalance } from './sales.js';
import { balances as householdLedger } from '../ledger.js';

const nowIso = () => new Date().toISOString();
const J = (v) => (v ? JSON.parse(v) : {});
const num = (v) => (v == null || v === '' ? null : Number(v));
const localDay = (d = new Date()) => new Date(d.getTime() + 5 * 3600e3).toISOString().slice(0, 10);

// ---------------------------------------------------------------- balances
export const vendorBalance = (db, id) => {
  const v = db.prepare('SELECT opening_balance FROM vendors WHERE id = ?').get(id);
  return v ? r2(v.opening_balance + db.prepare("SELECT COALESCE(SUM(amount), 0) AS a FROM party_entries WHERE party_type = 'vendor' AND party_id = ?").get(id).a) : 0;
};
export const staffBalance = (db, id) => r2(db.prepare("SELECT COALESCE(SUM(amount), 0) AS a FROM party_entries WHERE party_type = 'staff' AND party_id = ?").get(id).a);

// ---------------------------------------------------------------- documents
function existing(db, uuid, type) {
  const d = db.prepare('SELECT * FROM docs WHERE uuid = ?').get(uuid);
  if (d && d.type !== type) throw new StockError('Bu UUID boshqa hujjatda ishlatilgan');
  return d;
}
function newDoc(db, type, { uuid, actor, userId, note, toUser = null, toWh = null, vendorId = null, date = null }) {
  const id = Number(db.prepare(`INSERT INTO docs (uuid, type, number, status, doc_date, to_user, to_wh, vendor_id, note, created_by, created_by_id)
    VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)`).run(uuid, type, nextNumber(db, type), date ?? nowIso(), toUser, toWh, vendorId,
    note ? String(note).slice(0, 500) : null, actor, userId).lastInsertRowid);
  return { doc: getDoc(db, id), ctx: { doc: getDoc(db, id), at: nowIso(), touched: new Set() } };
}
const post = (db, ctx, actor, meta) => db.prepare("UPDATE docs SET status = 'posted', posted_by = ?, posted_at = ?, meta = ? WHERE id = ?")
  .run(actor, nowIso(), JSON.stringify(meta), ctx.doc.id);
const party = (db, ctx, type, id, amount, kind, note) => {
  if (Math.abs(amount) < 0.005) return;
  db.prepare('INSERT INTO party_entries (party_type, party_id, amount, kind, doc_id, note, at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(type, id, r2(amount), kind, ctx.doc.id, note ?? null, ctx.at);
};
const cash = (db, ctx, cashboxId, amount, methodId, kind) => {
  if (Math.abs(amount) < 0.005) return;
  db.prepare('INSERT INTO cash_entries (cashbox_id, amount, method_id, doc_id, kind, note, at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(cashboxId, r2(amount), methodId ?? null, ctx.doc.id, kind, ctx.doc.note, ctx.at);
};
const money = (v, what = 'Summa') => {
  const a = r2(num(v) ?? 0);
  if (!(a > 0)) throw new StockError(`${what}ni kiriting`);
  return a;
};
const cashbox = (db, id) => {
  const c = db.prepare('SELECT * FROM cashboxes WHERE id = ? AND active = 1').get(Number(id));
  if (!c) throw new StockError('Kassani tanlang');
  return c;
};
const category = (db, id, kind) => {
  const c = db.prepare('SELECT * FROM pnl_categories WHERE id = ? AND kind = ? AND COALESCE(active, 1) = 1').get(Number(id), kind);
  if (!c) throw new StockError(kind === 'expense' ? 'Xarajat moddasini tanlang' : 'Daromad moddasini tanlang');
  return c;
};
const staffUser = (db, id) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
  if (!u) throw new StockError('Xodim topilmadi');
  return u;
};
function run(db, type, b, opts, fn) {
  const uuid = String(b?.uuid || randomUUID()).slice(0, 80);
  const ex = existing(db, uuid, type);
  if (ex) return ex;
  return db.transaction(() => fn(uuid))();
}

// Money out of a cashbox for an expense category (or in, for other income).
export function createExpense(db, b, { actor, userId }) {
  return run(db, 'expense', b, null, (uuid) => {
    const box = cashbox(db, b.cashboxId); const cat = category(db, b.categoryId, 'expense'); const amount = money(b.amount);
    if (cashboxBalance(db, box.id) < amount - 0.005 && !b.allowNegative) throw new StockError(`"${box.name}" da yetarli pul yo'q (${cashboxBalance(db, box.id)})`);
    const { doc, ctx } = newDoc(db, 'expense', { uuid, actor, userId, note: b.note });
    cash(db, ctx, box.id, -amount, b.methodId, 'expense');
    pnl(db, ctx, cat.id, amount, b.note ?? cat.name);
    post(db, ctx, actor, { amount, cashboxId: box.id, cashbox: box.name, categoryId: cat.id, category: cat.name });
    return getDoc(db, doc.id);
  });
}
export function createIncome(db, b, { actor, userId }) {
  return run(db, 'income', b, null, (uuid) => {
    const box = cashbox(db, b.cashboxId); const cat = category(db, b.categoryId, 'income'); const amount = money(b.amount);
    const { doc, ctx } = newDoc(db, 'income', { uuid, actor, userId, note: b.note });
    cash(db, ctx, box.id, amount, b.methodId, 'income');
    pnl(db, ctx, cat.id, amount, b.note ?? cat.name);
    post(db, ctx, actor, { amount, cashboxId: box.id, cashbox: box.name, categoryId: cat.id, category: cat.name });
    return getDoc(db, doc.id);
  });
}
// From one cashbox to another (e.g. a seller's cashbox to the main one).
export function createCashMove(db, b, { actor, userId }) {
  return run(db, 'cash_move', b, null, (uuid) => {
    const from = cashbox(db, b.fromId); const to = cashbox(db, b.toId); const amount = money(b.amount);
    if (from.id === to.id) throw new StockError('Bir kassaning o\'ziga o\'tkazib bo\'lmaydi');
    if (cashboxBalance(db, from.id) < amount - 0.005) throw new StockError(`"${from.name}" da yetarli pul yo'q (${cashboxBalance(db, from.id)})`);
    const { doc, ctx } = newDoc(db, 'cash_move', { uuid, actor, userId, note: b.note });
    cash(db, ctx, from.id, -amount, b.methodId, 'move');
    cash(db, ctx, to.id, amount, b.methodId, 'move');
    post(db, ctx, actor, { amount, fromId: from.id, from: from.name, toId: to.id, to: to.name });
    return getDoc(db, doc.id);
  });
}
export function createCashOpening(db, b, { actor, userId }) {
  return run(db, 'cash_open', b, null, (uuid) => {
    const box = cashbox(db, b.cashboxId); const amount = r2(num(b.amount) ?? 0);
    if (!Number.isFinite(amount) || amount === 0) throw new StockError('Summani kiriting');
    const { doc, ctx } = newDoc(db, 'cash_open', { uuid, actor, userId, note: b.note });
    cash(db, ctx, box.id, amount, null, 'opening');
    post(db, ctx, actor, { amount, cashboxId: box.id, cashbox: box.name });
    return getDoc(db, doc.id);
  });
}

// ---------------------------------------------------------------- vendors
export function saveVendor(db, id, b) {
  const name = String(b?.name ?? '').trim().slice(0, 120);
  if (!name) throw new StockError('Nomini yozing');
  const opening = num(b.openingBalance) ?? 0;
  const phone = b.phone ? String(b.phone).replace(/[^\d+]/g, '').slice(0, 20) : null;
  if (id) {
    db.prepare('UPDATE vendors SET name = ?, phone = ?, note = ?, opening_balance = ?, active = COALESCE(?, active) WHERE id = ?')
      .run(name, phone, b.note ?? null, opening, b.active == null ? null : Number(!!b.active), id);
    return id;
  }
  return Number(db.prepare('INSERT INTO vendors (name, phone, note, opening_balance) VALUES (?, ?, ?, ?)').run(name, phone, b.note ?? null, opening).lastInsertRowid);
}
export const listVendors = (db, { all = false } = {}) => db.prepare(`SELECT * FROM vendors ${all ? '' : 'WHERE active = 1'} ORDER BY active DESC, name`).all()
  .map((v) => ({ ...v, balance: vendorBalance(db, v.id) }));

// Goods bought from a vendor: into a warehouse as new lots at the price paid; we owe
// the total, minus what is paid now from a cashbox.
export function createPurchase(db, b, { actor, userId }) {
  return run(db, 'purchase', b, null, (uuid) => {
    const v = db.prepare('SELECT * FROM vendors WHERE id = ? AND active = 1').get(Number(b.vendorId));
    if (!v) throw new StockError('Yetkazib beruvchini tanlang');
    const wh = db.prepare('SELECT * FROM warehouses WHERE id = ? AND active = 1').get(Number(b.warehouseId));
    if (!wh) throw new StockError('Omborni tanlang');
    if (!Array.isArray(b.lines) || !b.lines.length) throw new StockError('Kamida bitta mahsulot kiriting');
    const lines = b.lines.map((l, i) => {
      const p = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(l.productId));
      if (!p) throw new StockError(`${i + 1}-qator: mahsulot topilmadi`);
      const qty = r3(l.qty); const price = num(l.price);
      if (!(qty > 0)) throw new StockError(`${p.name}: miqdor noto'g'ri`);
      if (!(price >= 0)) throw new StockError(`${p.name}: narx noto'g'ri`);
      return { productId: p.id, qty, price, expiresAt: l.expiresAt || undefined };
    });
    const paid = r2(num(b.paid) ?? 0);
    const box = paid > 0 ? cashbox(db, b.cashboxId) : null;
    const { doc, ctx } = newDoc(db, 'purchase', { uuid, actor, userId, note: b.note, toWh: wh.id, vendorId: v.id });
    const before = vendorBalance(db, v.id);
    const ins = db.prepare('INSERT INTO doc_lines (doc_id, product_id, qty, price, unit_cost, sort) VALUES (?, ?, ?, ?, ?, ?)');
    let total = 0;
    lines.forEach((l, i) => {
      const lid = Number(ins.run(doc.id, l.productId, l.qty, l.price, l.price, i).lastInsertRowid);
      const c = r2(l.qty * l.price);
      addIn(db, ctx, { productId: l.productId, h: { warehouseId: wh.id }, qty: l.qty, cost: c, lineId: lid, kind: 'purchase', lot: { unitCost: l.price, seq: i + 1, expiresAt: l.expiresAt } });
      total += c;
    });
    total = r2(total);
    party(db, ctx, 'vendor', v.id, total, 'purchase', null);
    if (paid > 0) { party(db, ctx, 'vendor', v.id, -paid, 'payment', null); cash(db, ctx, box.id, -paid, b.methodId, 'purchase'); }
    post(db, ctx, actor, { total, paid, cashboxId: box?.id ?? null, cashbox: box?.name ?? null, vendor: v.name, warehouse: wh.name, balance_before: before, balance_after: vendorBalance(db, v.id) });
    return getDoc(db, doc.id);
  });
}
export function createVendorPayment(db, b, { actor, userId }) {
  return run(db, 'vendor_pay', b, null, (uuid) => {
    const v = db.prepare('SELECT * FROM vendors WHERE id = ?').get(Number(b.vendorId));
    if (!v) throw new StockError('Yetkazib beruvchini tanlang');
    const box = cashbox(db, b.cashboxId); const amount = money(b.amount);
    if (cashboxBalance(db, box.id) < amount - 0.005) throw new StockError(`"${box.name}" da yetarli pul yo'q (${cashboxBalance(db, box.id)})`);
    const { doc, ctx } = newDoc(db, 'vendor_pay', { uuid, actor, userId, note: b.note, vendorId: v.id });
    const before = vendorBalance(db, v.id);
    party(db, ctx, 'vendor', v.id, -amount, 'payment', null);
    cash(db, ctx, box.id, -amount, b.methodId, 'vendor');
    post(db, ctx, actor, { amount, cashboxId: box.id, cashbox: box.name, vendor: v.name, balance_before: before, balance_after: vendorBalance(db, v.id) });
    return getDoc(db, doc.id);
  });
}

// ---------------------------------------------------------------- payroll
export function setSalary(db, userId, { salary, salaryDay }) {
  const u = staffUser(db, userId);
  const s = num(salary);
  if (s != null && !(s >= 0)) throw new StockError('Oklad noto\'g\'ri');
  const day = num(salaryDay);
  if (s && !(Number.isInteger(day) && day >= 1 && day <= 28)) throw new StockError('Oylik kuni 1 dan 28 gacha bo\'lsin');
  // A new or changed salary counts from today: no back pay for earlier months.
  const changed = (u.salary ?? null) !== (s || null) || (u.salary_day ?? null) !== (s ? day : null);
  db.prepare('UPDATE users SET salary = ?, salary_day = ?, salary_since = CASE WHEN ? THEN ? ELSE salary_since END WHERE id = ?')
    .run(s || null, s ? day : null, changed ? 1 : 0, localDay(), u.id);
}

// Bonus (company owes more), fine (the person owes), payout (money to the person),
// opening balance. Salary is accrued automatically (accrueSalaries).
export function createStaffEntry(db, type, b, { actor, userId }) {
  if (!['bonus', 'fine', 'staff_pay', 'staff_open'].includes(type)) throw new StockError('Turi noto\'g\'ri');
  return run(db, type, b, null, (uuid) => {
    const u = staffUser(db, b.userId);
    const amount = type === 'staff_open' ? r2(num(b.amount) ?? 0) : money(b.amount);
    if (type === 'staff_open' && (!Number.isFinite(amount) || amount === 0)) throw new StockError('Summani kiriting');
    if ((type === 'bonus' || type === 'fine') && !b.note) throw new StockError('Sababini yozing');
    const box = type === 'staff_pay' ? cashbox(db, b.cashboxId) : null;
    if (box && cashboxBalance(db, box.id) < amount - 0.005) throw new StockError(`"${box.name}" da yetarli pul yo'q (${cashboxBalance(db, box.id)})`);
    const { doc, ctx } = newDoc(db, type, { uuid, actor, userId, note: b.note, toUser: u.id });
    const before = staffBalance(db, u.id);
    if (type === 'bonus') { party(db, ctx, 'staff', u.id, -amount, 'bonus', b.note); pnl(db, ctx, 'bonus', amount, `${holderName(db, { userId: u.id })}: ${b.note}`); }
    if (type === 'fine') { party(db, ctx, 'staff', u.id, amount, 'fine', b.note); pnl(db, ctx, 'fines', amount, `${holderName(db, { userId: u.id })}: ${b.note}`); }
    if (type === 'staff_pay') { party(db, ctx, 'staff', u.id, amount, 'pay', b.note); cash(db, ctx, box.id, -amount, b.methodId, 'staff'); }
    // Opening: positive = the person owes the company, negative = the company owes them.
    if (type === 'staff_open') party(db, ctx, 'staff', u.id, amount, 'opening', b.note);
    post(db, ctx, actor, { amount, cashboxId: box?.id ?? null, cashbox: box?.name ?? null, staff: holderName(db, { userId: u.id }), balance_before: before, balance_after: staffBalance(db, u.id) });
    return getDoc(db, doc.id);
  });
}

// The fixed salary becomes owed on its day each month (from the month it was set).
// Runs from the minute check; one document per person and month (uuid), so it never doubles.
export function accrueSalaries(db, today = localDay()) {
  const month = today.slice(0, 7); const day = Number(today.slice(8, 10));
  const due = db.prepare('SELECT * FROM users WHERE active = 1 AND is_test = 0 AND salary > 0 AND salary_day BETWEEN 1 AND 28').all();
  let made = 0;
  for (const u of due) {
    if (day < u.salary_day) continue;
    const dueDate = `${month}-${String(u.salary_day).padStart(2, '0')}`;
    if (u.salary_since && dueDate < u.salary_since) continue;
    const uuid = `salary-${u.id}-${month}`;
    if (db.prepare('SELECT 1 FROM docs WHERE uuid = ?').get(uuid)) continue;
    db.transaction(() => {
      const { ctx } = newDoc(db, 'salary', { uuid, actor: 'system', userId: null, note: `${month} oyligi`, toUser: u.id, date: `${dueDate}T04:00:00.000Z` });
      const before = staffBalance(db, u.id);
      party(db, ctx, 'staff', u.id, -u.salary, 'salary', `${month} oyligi`);
      pnl(db, ctx, 'salary', u.salary, `${holderName(db, { userId: u.id })}: ${month}`);
      post(db, ctx, 'system', { amount: u.salary, month, staff: holderName(db, { userId: u.id }), balance_before: before, balance_after: staffBalance(db, u.id) });
    })();
    made += 1;
  }
  return made;
}

// ---------------------------------------------------------------- reading
const FIN_TYPES = ['purchase', 'vendor_pay', 'expense', 'income', 'cash_move', 'cash_open', 'cash_count', 'salary', 'bonus', 'fine', 'staff_pay', 'staff_open'];
const LABEL = {
  purchase: ['XK', 'Xarid (kirim)'], vendor_pay: ['YT', "Yetkazib beruvchiga to'lov"], expense: ['XR', 'Xarajat'], income: ['KR', 'Boshqa kirim'],
  cash_move: ['KO', 'Kassadan kassaga'], cash_open: ['KB', "Kassa boshlang'ich qoldig'i"], salary: ['OY', 'Oylik'], bonus: ['BN', 'Bonus'],
  fine: ['JR', 'Jarima'], staff_pay: ['IP', "Xodimga to'lov"], staff_open: ['XB', "Xodim boshlang'ich balansi"], cash_count: ['KS', "Kassa sanog'i"],
};
export function finDoc(db, id) {
  const d = getDoc(db, id);
  if (!d || !LABEL[d.type]) return null;
  const m = J(d.meta);
  const lines = d.type === 'purchase' ? db.prepare(`SELECT dl.product_id, p.name AS product, p.unit, dl.qty, dl.price FROM doc_lines dl JOIN products p ON p.id = dl.product_id
    WHERE dl.doc_id = ? ORDER BY dl.sort`).all(id).map((l) => ({ ...l, sum: r2(l.qty * l.price) })) : [];
  return {
    id: d.id, type: d.type, type_label: LABEL[d.type][1], label: `${LABEL[d.type][0]}-${d.number}`, number: d.number, status: d.status, doc_date: d.doc_date, note: d.note,
    created_by: d.created_by, vendor_id: d.vendor_id, staff_id: d.to_user, staff: d.to_user ? holderName(db, { userId: d.to_user }) : null,
    cancelled_at: d.cancelled_at, cancel_reason: d.cancel_reason, amount: m.amount ?? m.total ?? 0, ...m, lines,
  };
}
export function listFinDocs(db, { type, from, to, vendorId, staffId, cashboxId, limit = 300 } = {}) {
  const where = [`d.type IN (${FIN_TYPES.map(() => '?').join(',')})`]; const args = [...FIN_TYPES];
  if (type) { where.push('d.type = ?'); args.push(type); }
  if (vendorId) { where.push('d.vendor_id = ?'); args.push(vendorId); }
  if (staffId) { where.push('d.to_user = ?'); args.push(staffId); }
  if (cashboxId) { where.push('d.id IN (SELECT doc_id FROM cash_entries WHERE cashbox_id = ?)'); args.push(cashboxId); }
  if (from) { where.push("date(d.doc_date, '+5 hours') >= ?"); args.push(from); }
  if (to) { where.push("date(d.doc_date, '+5 hours') <= ?"); args.push(to); }
  return db.prepare(`SELECT d.id FROM docs d WHERE ${where.join(' AND ')} ORDER BY d.doc_date DESC, d.id DESC LIMIT ?`).all(...args, Math.min(limit, 1000)).map((r) => finDoc(db, r.id));
}

// A party's statement: opening, then every entry with the running balance.
export function statementOf(db, type, id) {
  const opening = type === 'vendor' ? (db.prepare('SELECT opening_balance FROM vendors WHERE id = ?').get(id)?.opening_balance ?? 0) : 0;
  let run = opening;
  const entries = db.prepare(`SELECT e.amount, e.kind, e.note, e.at, e.doc_id, d.type FROM party_entries e LEFT JOIN docs d ON d.id = e.doc_id
    WHERE e.party_type = ? AND e.party_id = ? ORDER BY e.at, e.id`).all(type, id).map((e) => { run = r2(run + e.amount); return { ...e, balance: run }; }).reverse();
  return { opening, balance: r2(run), entries };
}

// Cashbox statement for a period.
export function cashboxStatement(db, id, { from, to } = {}) {
  const where = ['e.cashbox_id = ?']; const args = [id];
  if (from) { where.push("date(e.at, '+5 hours') >= ?"); args.push(from); }
  if (to) { where.push("date(e.at, '+5 hours') <= ?"); args.push(to); }
  const before = from ? r2(db.prepare("SELECT COALESCE(SUM(amount), 0) AS a FROM cash_entries WHERE cashbox_id = ? AND date(at, '+5 hours') < ?").get(id, from).a) : 0;
  let run = before;
  const entries = db.prepare(`SELECT e.*, m.name AS method, d.type, d.number FROM cash_entries e LEFT JOIN payment_methods m ON m.id = e.method_id LEFT JOIN docs d ON d.id = e.doc_id
    WHERE ${where.join(' AND ')} ORDER BY e.at, e.id`).all(...args).map((e) => { run = r2(run + e.amount); return { ...e, balance: run }; });
  return { before, after: run, in: r2(entries.filter((e) => e.amount > 0).reduce((a, e) => a + e.amount, 0)), out: r2(-entries.filter((e) => e.amount < 0).reduce((a, e) => a + e.amount, 0)), entries: entries.reverse() };
}

// Profit and loss for a period, by category.
export function profitLoss(db, { from, to }) {
  const rows = db.prepare(`SELECT c.id, c.code, c.name, c.kind, ROUND(SUM(e.amount), 2) AS amount FROM pnl_entries e JOIN pnl_categories c ON c.id = e.category_id
    WHERE date(e.at, '+5 hours') BETWEEN ? AND ? GROUP BY c.id HAVING ABS(SUM(e.amount)) >= 0.005 ORDER BY c.kind DESC, ABS(SUM(e.amount)) DESC`).all(from, to);
  const income = r2(rows.filter((r) => r.kind === 'income').reduce((a, r) => a + r.amount, 0));
  const expense = r2(rows.filter((r) => r.kind === 'expense').reduce((a, r) => a + r.amount, 0));
  return { from, to, rows, income, expense, net: r2(income - expense) };
}

// Who owes whom, across the company.
export function balancesSummary(db) {
  const cust = db.prepare(`SELECT c.opening_balance + COALESCE((SELECT SUM(amount) FROM party_entries WHERE party_type = 'customer' AND party_id = c.id), 0) AS b FROM customers c`).all().map((r) => r.b);
  const vend = db.prepare('SELECT id FROM vendors').all().map((v) => vendorBalance(db, v.id));
  const staff = db.prepare("SELECT party_id, SUM(amount) AS b FROM party_entries WHERE party_type = 'staff' GROUP BY party_id").all().map((r) => r.b);
  const boxes = db.prepare('SELECT id, name, is_main FROM cashboxes WHERE active = 1 ORDER BY is_main DESC, name').all().map((c) => ({ ...c, balance: cashboxBalance(db, c.id) }));
  const pos = (a) => r2(a.filter((x) => x > 0).reduce((s, x) => s + x, 0));
  const neg = (a) => r2(-a.filter((x) => x < 0).reduce((s, x) => s + x, 0));
  return {
    cash: r2(boxes.reduce((a, c) => a + c.balance, 0)), cashboxes: boxes,
    customers_owe: pos(cust), we_owe_customers: neg(cust), we_owe_vendors: pos(vend), vendors_owe: neg(vend),
    we_owe_staff: neg(staff), staff_owe: pos(staff),
    // Households (milk collection ledger): positive balance = we owe them.
    we_owe_households: r2(householdLedger(db).totals.weOwe), households_owe: r2(householdLedger(db).totals.theyOwe),
  };
}

// ---------------------------------------------------------------- household payments (milk collection)
// A payment to a household leaves a cashbox: the one chosen, else the payer's own
// (a collector gets one made on first use, like a seller), else the main cashbox.
// Field payments synced later can never be refused, so the cashbox may go below
// zero — the cash count shows it. Test users' payments touch no cashbox.
const METHOD_NAME = { cash: 'Naqd', card: 'Karta', transfer: "O'tkazma" };
export function householdCashbox(db, user, requested) {
  const req = Number(requested);
  if (req && db.prepare('SELECT 1 FROM cashboxes WHERE id = ? AND active = 1').get(req)) return req;
  const own = db.prepare('SELECT c.id FROM cashboxes c JOIN cashbox_keepers k ON k.cashbox_id = c.id WHERE k.user_id = ? AND c.active = 1 ORDER BY c.is_main, c.id LIMIT 1').get(user.id);
  if (own) return own.id;
  if (user.perms?.has('collect.shift')) {
    const id = Number(db.prepare('INSERT INTO cashboxes (name) VALUES (?)').run(`${holderName(db, { userId: user.id })} kassasi`).lastInsertRowid);
    db.prepare('INSERT INTO cashbox_keepers (cashbox_id, user_id) VALUES (?, ?)').run(id, user.id);
    return id;
  }
  return db.prepare('SELECT id FROM cashboxes WHERE is_main = 1 AND active = 1 ORDER BY id LIMIT 1').get()?.id ?? null;
}
export function bookHouseholdPayment(db, paymentId, user, requested) {
  if (user?.is_test) return null;
  const p = db.prepare('SELECT p.*, s.name AS supplier FROM payments p JOIN suppliers s ON s.id = p.supplier_id WHERE p.id = ?').get(paymentId);
  if (!p || p.cashbox_id) return p?.cashbox_id ?? null;
  const box = householdCashbox(db, user, requested);
  if (!box) return null;
  const method = db.prepare('SELECT id FROM payment_methods WHERE name = ?').get(METHOD_NAME[p.method] ?? 'Naqd')?.id ?? null;
  db.prepare("INSERT INTO cash_entries (cashbox_id, amount, method_id, kind, note, at, payment_id) VALUES (?, ?, ?, 'household', ?, ?, ?)")
    .run(box, -p.amount, method, `Xonadonga to'lov: ${p.supplier}${p.number ? ` (#${p.number})` : ''}`, p.paid_at, p.id);
  db.prepare('UPDATE payments SET cashbox_id = ? WHERE id = ?').run(box, p.id);
  return box;
}
// Voiding the payment puts the money back into the same cashbox.
export function voidHouseholdPayment(db, paymentId) {
  const e = db.prepare("SELECT * FROM cash_entries WHERE payment_id = ? AND kind = 'household'").get(paymentId);
  if (!e || db.prepare("SELECT 1 FROM cash_entries WHERE payment_id = ? AND kind = 'household_void'").get(paymentId)) return;
  db.prepare("INSERT INTO cash_entries (cashbox_id, amount, method_id, kind, note, at, payment_id) VALUES (?, ?, ?, 'household_void', ?, datetime('now'), ?)")
    .run(e.cashbox_id, -e.amount, e.method_id, `Bekor qilindi: ${e.note}`, paymentId);
}

// ---------------------------------------------------------------- cash count (kassa nazorati)
// The money actually in the cashbox is counted. A difference is booked so the books
// match: a surplus is income; a shortage is charged to the people chosen (sums) and
// the rest is the company's loss. A shortage is never booked silently.
export function createCashCount(db, b, { actor, userId }) {
  return run(db, 'cash_count', b, null, (uuid) => {
    const box = cashbox(db, b.cashboxId);
    const counted = r2(num(b.counted));
    if (!(counted >= 0)) throw new StockError('Sanalgan summani kiriting');
    const book = cashboxBalance(db, box.id);
    const diff = r2(counted - book);
    let charges = [];
    if (diff < -0.004) {
      if (b.charges === undefined) throw new StockError(`Kamomad: ${-diff}. Kim hisobiga yozilishini tanlang`, { needDecision: true, book, counted, shortage: -diff });
      charges = (Array.isArray(b.charges) ? b.charges : []).map((c) => ({ user: staffUser(db, c.userId), amount: r2(num(c.amount) ?? 0) })).filter((c) => c.amount > 0);
      if (r2(charges.reduce((a, c) => a + c.amount, 0)) > -diff + 0.01) throw new StockError('Xodimlarga yozilgan summa kamomaddan ko\'p');
    }
    const { doc, ctx } = newDoc(db, 'cash_count', { uuid, actor, userId, note: b.note });
    cash(db, ctx, box.id, diff, null, 'count');
    if (diff > 0.004) pnl(db, ctx, 'cash_surplus', diff, box.name);
    if (diff < -0.004) {
      const staff = r2(charges.reduce((a, c) => a + c.amount, 0));
      for (const c of charges) party(db, ctx, 'staff', c.user.id, c.amount, 'cash_shortage', `${box.name}: kassa kamomadi`);
      pnl(db, ctx, 'cash_shortage', r2(-diff - staff), box.name);
    }
    post(db, ctx, actor, { cashboxId: box.id, cashbox: box.name, book, counted, diff, amount: Math.abs(diff),
      charges: charges.map((c) => ({ userId: c.user.id, name: holderName(db, { userId: c.user.id }), amount: c.amount })) });
    return getDoc(db, doc.id);
  });
}

// ---------------------------------------------------------------- balances (all parties)
export function balancesDetail(db) {
  const householdBalances = householdLedger(db).rows;
  const customers = db.prepare(`SELECT c.id, c.name, c.opening_balance + COALESCE((SELECT SUM(amount) FROM party_entries WHERE party_type = 'customer' AND party_id = c.id), 0) AS balance
    FROM customers c`).all().map((r) => ({ ...r, balance: r2(r.balance) })).filter((r) => Math.abs(r.balance) >= 0.01).sort((a, b) => b.balance - a.balance);
  const vendors = listVendors(db, { all: true }).filter((v) => Math.abs(v.balance) >= 0.01).map((v) => ({ id: v.id, name: v.name, balance: v.balance })).sort((a, b) => b.balance - a.balance);
  const staff = db.prepare("SELECT party_id AS id, ROUND(SUM(amount), 2) AS b FROM party_entries WHERE party_type = 'staff' GROUP BY party_id").all()
    .filter((r) => Math.abs(r.b) >= 0.01).map((r) => ({ id: r.id, name: holderName(db, { userId: r.id }), balance: r2(-r.b) })).sort((a, b) => b.balance - a.balance);
  const households = householdBalances.filter((r) => Math.abs(r.balance) >= 0.01).map((r) => ({ id: r.id, name: r.name, balance: r2(r.balance) }));
  const cashboxes = db.prepare('SELECT id, name, is_main FROM cashboxes WHERE active = 1 ORDER BY is_main DESC, name').all().map((c) => ({ ...c, balance: cashboxBalance(db, c.id) }));
  const pos = (a) => r2(a.filter((x) => x.balance > 0).reduce((s0, x) => s0 + x.balance, 0));
  const neg = (a) => r2(-a.filter((x) => x.balance < 0).reduce((s0, x) => s0 + x.balance, 0));
  return {
    // Every list: positive = in the direction of its title.
    customers: { title: 'Mijozlar bizga qarz', rows: customers, total: pos(customers), reverse: neg(customers) },
    households: { title: 'Biz xonadonlarga qarz', rows: households, total: pos(households), reverse: neg(households) },
    vendors: { title: 'Biz yetkazib beruvchilarga qarz', rows: vendors, total: pos(vendors), reverse: neg(vendors) },
    staff: { title: 'Biz xodimlarga qarz', rows: staff, total: pos(staff), reverse: neg(staff) },
    cashboxes: { title: 'Kassalarda', rows: cashboxes, total: r2(cashboxes.reduce((a, c) => a + c.balance, 0)) },
  };
}
