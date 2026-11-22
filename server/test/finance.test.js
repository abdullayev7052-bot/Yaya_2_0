import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, call, login, boss } from './helpers.js';
import { accrueSalaries } from '../src/erp/finance.js';

const F = '/api/erp/finance';
async function office() {
  const { app, db, ids } = setup();
  const b = await boss(app);
  const main = db.prepare('SELECT id FROM cashboxes WHERE is_main = 1').get().id;
  const cats = (await call(app, 'GET', '/api/erp/pnl-categories', b)).body;
  const cat = (code) => cats.find((c) => c.code === code).id;
  return { app, db, ids, b, main, cat };
}
const bal = (db, id) => db.prepare('SELECT COALESCE(ROUND(SUM(amount), 2), 0) a FROM cash_entries WHERE cashbox_id = ?').get(id).a;
const pnl = (db, code) => db.prepare('SELECT COALESCE(ROUND(SUM(e.amount), 2), 0) a FROM pnl_entries e JOIN pnl_categories c ON c.id = e.category_id WHERE c.code = ?').get(code).a;

test('cashboxes: opening, expense (not beyond the balance), other income, hand-over to the main cashbox', async () => {
  const { app, db, ids, b, main, cat } = await office();
  await call(app, 'POST', `${F}/cash-openings`, b, { cashboxId: main, amount: 1000000 });
  assert.equal((await call(app, 'POST', `${F}/expenses`, b, { cashboxId: main, categoryId: cat('other_expense'), amount: 2000000, note: 'Ijara' })).status, 400, 'not more than is in the cashbox');
  const ex = (await call(app, 'POST', `${F}/expenses`, b, { cashboxId: main, categoryId: cat('other_expense'), amount: 200000, note: 'Ijara' })).body;
  assert.equal(ex.label, 'XR-1');
  await call(app, 'POST', `${F}/incomes`, b, { cashboxId: main, categoryId: cat('other_income'), amount: 50000, note: 'Eski tara sotildi' });
  assert.equal(bal(db, main), 850000);
  assert.equal(pnl(db, 'other_expense'), 200000);
  // the storekeeper's own cashbox: they may hand it over to the main cashbox, nothing else
  const own = (await call(app, 'POST', '/api/erp/finance/cashboxes', b, { name: 'Omborchi kassasi', keepers: [ids.store] })).body.id;
  await call(app, 'POST', `${F}/cash-openings`, b, { cashboxId: own, amount: 30000 });
  const s = await login(app, 'store', 'store123');
  assert.equal((await call(app, 'POST', `${F}/expenses`, s, { cashboxId: own, categoryId: cat('other_expense'), amount: 1000, note: 'x' })).status, 403);
  const other = (await call(app, 'POST', '/api/erp/finance/cashboxes', b, { name: 'Boshqa kassa' })).body.id;
  assert.equal((await call(app, 'POST', `${F}/cash-moves`, s, { fromId: own, toId: other, amount: 10000 })).status, 403);
  assert.equal((await call(app, 'POST', `${F}/cash-moves`, s, { fromId: own, toId: main, amount: 30000 })).status, 200);
  assert.equal(bal(db, own), 0);
  assert.equal(bal(db, main), 880000);
  // cancelling the expense puts the money back
  assert.equal((await call(app, 'POST', `${F}/docs/${ex.id}/cancel`, b, { reason: 'Xato' })).status, 200);
  assert.equal(bal(db, main), 1080000);
  assert.equal(pnl(db, 'other_expense'), 0);
});

test('vendors: a purchase brings stock in at the price paid; we owe the rest; paying clears it', async () => {
  const { app, db, b, main } = await office();
  await call(app, 'POST', `${F}/cash-openings`, b, { cashboxId: main, amount: 500000 });
  const jar = (await call(app, 'POST', '/api/erp/products', b, { name: 'V idish 400 g', kind: 'pack', unit: 'dona' })).body.id;
  const wh = (await call(app, 'POST', '/api/erp/warehouses', b, { name: 'Idish ombori', kind: 'pack' })).body.id;
  const v = (await call(app, 'POST', `${F}/vendors`, b, { name: 'Plastik zavodi', openingBalance: 20000 })).body.id;
  const p = (await call(app, 'POST', `${F}/purchases`, b, { vendorId: v, warehouseId: wh, lines: [{ productId: jar, qty: 100, price: 800 }], paid: 30000, cashboxId: main })).body;
  assert.equal(p.total, 80000);
  assert.equal(p.balance_before, 20000);
  assert.equal(p.balance_after, 70000);
  assert.deepEqual(db.prepare('SELECT ROUND(SUM(qty), 3) q, ROUND(SUM(cost), 2) c FROM stock_moves WHERE product_id = ?').get(jar), { q: 100, c: 80000 });
  assert.equal(bal(db, main), 470000);
  await call(app, 'POST', `${F}/vendor-payments`, b, { vendorId: v, cashboxId: main, amount: 70000 });
  const card = (await call(app, 'GET', `${F}/vendors/${v}`, b)).body;
  assert.equal(card.balance, 0);
  assert.equal(card.opening, 20000);
  assert.equal(card.entries.length, 3);
});

test('payroll: salary earned on its day (no back pay, never twice), bonus and fine with a reason, payout from a cashbox', async () => {
  const { app, db, ids, b, main } = await office();
  assert.equal((await call(app, 'PUT', `${F}/staff/${ids.store}/salary`, b, { salary: 3000000, salaryDay: 31 })).status, 400);
  await call(app, 'PUT', `${F}/staff/${ids.store}/salary`, b, { salary: 3000000, salaryDay: 5 });
  db.prepare("UPDATE users SET salary_since = '2026-11-21' WHERE id = ?").run(ids.store);
  assert.equal(accrueSalaries(db, '2026-11-25'), 0, 'November 5 is before the salary was set: no back pay');
  assert.equal(accrueSalaries(db, '2026-12-04'), 0, 'not yet its day');
  assert.equal(accrueSalaries(db, '2026-12-05'), 1);
  assert.equal(accrueSalaries(db, '2026-12-20'), 0, 'once a month');
  const staffBal = async () => (await call(app, 'GET', `${F}/staff/${ids.store}`, b)).body.balance;
  assert.equal(await staffBal(), -3000000, 'the company owes the salary');
  assert.equal((await call(app, 'POST', `${F}/bonuses`, b, { userId: ids.store, amount: 200000 })).status, 400, 'a reason is required');
  await call(app, 'POST', `${F}/bonuses`, b, { userId: ids.store, amount: 200000, note: 'Reja bajarildi' });
  await call(app, 'POST', `${F}/fines`, b, { userId: ids.store, amount: 50000, note: 'Ishga kelmagan (1 kun)' });
  assert.equal(await staffBal(), -3150000);
  assert.equal(pnl(db, 'salary'), 3000000);
  assert.equal(pnl(db, 'bonus'), 200000);
  assert.equal(pnl(db, 'fines'), 50000);
  // paying out needs the money in the cashbox
  assert.equal((await call(app, 'POST', `${F}/staff-payments`, b, { userId: ids.store, cashboxId: main, amount: 3150000 })).status, 400);
  await call(app, 'POST', `${F}/cash-openings`, b, { cashboxId: main, amount: 5000000 });
  await call(app, 'POST', `${F}/staff-payments`, b, { userId: ids.store, cashboxId: main, amount: 3150000 });
  assert.equal(await staffBal(), 0);
  assert.equal(bal(db, main), 1850000);
  // a manager without payroll rights cannot see or pay salaries; the summary adds it all up
  const s = await login(app, 'store', 'store123');
  assert.equal((await call(app, 'GET', `${F}/staff`, s)).status, 403);
  const sum = (await call(app, 'GET', `${F}/summary`, b)).body;
  assert.equal(sum.cash, 1850000);
  assert.equal(sum.we_owe_staff, 0);
  const pl = (await call(app, 'GET', `${F}/pnl?from=2026-01-01&to=2030-12-31`, b)).body;
  assert.equal(pl.expense, 3200000);
  assert.equal(pl.income, 50000);
});

test('sales are out: the seller role retires (its people kept but switched off), sales routes are gone, cashboxes live in finance', async () => {
  const { app, db } = setup();
  const { setupErp } = await import('../src/erp/schema.js');
  const role = Number(db.prepare("INSERT INTO roles (code, name, permissions) VALUES ('seller', 'Sotuvchi', '[]')").run().lastInsertRowid);
  const jasur = Number(db.prepare("INSERT INTO users (login, name, password_hash, role_id) VALUES ('jasur', 'Jasur', 'x', ?)").run(role).lastInsertRowid);
  const box = Number(db.prepare("INSERT INTO cashboxes (name) VALUES ('Jasur kassasi')").run().lastInsertRowid);
  db.prepare('INSERT INTO cashbox_keepers (cashbox_id, user_id) VALUES (?, ?)').run(box, jasur);
  setupErp(db, () => {});
  assert.equal(db.prepare('SELECT active FROM users WHERE id = ?').get(jasur).active, 0, 'the seller cannot sign in');
  assert.equal(db.prepare('SELECT active FROM cashboxes WHERE id = ?').get(box).active, 0, 'their empty cashbox closes');
  assert.ok(db.prepare("SELECT 1 FROM roles WHERE code = 'seller'").get(), 'kept while someone has it');
  db.prepare('DELETE FROM users WHERE id = ?').run(jasur);
  setupErp(db, () => {});
  assert.equal(db.prepare("SELECT 1 FROM roles WHERE code = 'seller'").get(), undefined, 'removed once nobody has it');
  const b = await boss(app);
  assert.equal((await call(app, 'GET', '/api/erp/sales/customers', b)).status, 404);
  const id = (await call(app, 'POST', '/api/erp/finance/cashboxes', b, { name: 'Bank' })).body.id;
  assert.ok((await call(app, 'GET', '/api/erp/finance/cashboxes', b)).body.some((c) => c.id === id));
  assert.ok((await call(app, 'GET', '/api/erp/finance/methods', b)).body.length >= 3);
});
