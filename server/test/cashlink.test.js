import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, call, login, ali, boss, now } from './helpers.js';

const F = '/api/erp/finance';
const bal = (db, id) => db.prepare('SELECT COALESCE(ROUND(SUM(amount), 2), 0) a FROM cash_entries WHERE cashbox_id = ?').get(id).a;
const pnl = (db, code) => db.prepare('SELECT COALESCE(ROUND(SUM(e.amount), 2), 0) a FROM pnl_entries e JOIN pnl_categories c ON c.id = e.category_id WHERE c.code = ?').get(code).a;

test('household payments leave a cashbox: office → chosen or main, field → the collector\'s own; voiding puts it back; test users touch none', async () => {
  const { app, db, ids } = setup();
  const b = await boss(app);
  const main = db.prepare('SELECT id FROM cashboxes WHERE is_main = 1').get().id;
  await call(app, 'POST', `${F}/cash-openings`, b, { cashboxId: main, amount: 500000 });
  // from the panel, no cashbox chosen → the main cashbox
  const p1 = (await call(app, 'POST', '/api/admin/payments', b, { supplierId: 1, amount: 100000, method: 'cash' })).body.id;
  assert.equal(bal(db, main), 400000);
  const e = db.prepare('SELECT * FROM cash_entries WHERE payment_id = ?').get(p1);
  assert.match(e.note, /Karimova Oydin/);
  // a chosen cashbox
  const other = (await call(app, 'POST', '/api/erp/finance/cashboxes', b, { name: 'Bank' })).body.id;
  await call(app, 'POST', '/api/admin/payments', b, { supplierId: 2, amount: 30000, method: 'transfer', cashboxId: other });
  assert.equal(bal(db, other), -30000);
  // voiding puts the money back
  await call(app, 'POST', `/api/admin/payments/${p1}/void`, b, { reason: 'Xato summa' });
  assert.equal(bal(db, main), 500000);
  // paid by the collector in the field (offline sync) → their own cashbox, made on first use
  const a = await ali(app);
  await call(app, 'POST', '/api/mobile/sync', a, { payments: [{ uuid: 'pay-field-1', supplierId: 1, amount: 50000, method: 'cash', paidAt: now() }] });
  const own = db.prepare('SELECT c.id, c.name FROM cashboxes c JOIN cashbox_keepers k ON k.cashbox_id = c.id WHERE k.user_id = ?').get(ids.ali);
  assert.ok(own, 'the collector got a cashbox');
  assert.equal(bal(db, own.id), -50000);
  // re-sent sync: no second cash entry
  await call(app, 'POST', '/api/mobile/sync', a, { payments: [{ uuid: 'pay-field-1', supplierId: 1, amount: 50000, method: 'cash', paidAt: now() }] });
  assert.equal(bal(db, own.id), -50000);
  // a test collector's payment touches no cashbox
  const t = await login(app, '900000000', '1111');
  const before = db.prepare('SELECT COUNT(*) n FROM cash_entries').get().n;
  await call(app, 'POST', '/api/mobile/sync', t, { payments: [{ uuid: 'pay-test-1', supplierId: 1, amount: 1000, method: 'cash', paidAt: now() }] });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM cash_entries').get().n, before);

  // balances: households are in the company-wide picture
  const sum = (await call(app, 'GET', `${F}/summary`, b)).body;
  assert.ok(sum.we_owe_households > 0);
  const det = (await call(app, 'GET', `${F}/balances`, b)).body;
  assert.ok(det.households.rows.some((r) => r.name === 'Karimova Oydin'));
  assert.equal(det.cashboxes.total, sum.cash);
});

test('cash count (kassa nazorati): a surplus is income; a shortage asks who pays and can be split', async () => {
  const { app, db, ids } = setup();
  const b = await boss(app);
  const main = db.prepare('SELECT id FROM cashboxes WHERE is_main = 1').get().id;
  await call(app, 'POST', `${F}/cash-openings`, b, { cashboxId: main, amount: 100000 });
  await call(app, 'POST', `${F}/cash-counts`, b, { cashboxId: main, counted: 101000 });
  assert.equal(bal(db, main), 101000);
  assert.equal(pnl(db, 'cash_surplus'), 1000);
  const ask = await call(app, 'POST', `${F}/cash-counts`, b, { cashboxId: main, counted: 95000 });
  assert.equal(ask.status, 400);
  assert.equal(ask.body.details.shortage, 6000);
  const ok = (await call(app, 'POST', `${F}/cash-counts`, b, { cashboxId: main, counted: 95000, charges: [{ userId: ids.store, amount: 4000 }] })).body;
  assert.equal(ok.label, 'KS-2');
  assert.equal(bal(db, main), 95000);
  assert.equal(pnl(db, 'cash_shortage'), 2000);
  assert.equal((await call(app, 'GET', `${F}/staff/${ids.store}`, b)).body.balance, 4000, 'the storekeeper owes 4 000');
  // cancelling the count reverses it
  await call(app, 'POST', `${F}/docs/${ok.id}/cancel`, b, { reason: 'Qayta sanaladi' });
  assert.equal(bal(db, main), 101000);
  assert.equal((await call(app, 'GET', `${F}/staff/${ids.store}`, b)).body.balance, 0);
});

test('conditional limit: with the alternative starter the output must be 315–330 instead of 320–335', async () => {
  const { app, db, ids } = setup();
  const b = await boss(app);
  const P = async (body) => (await call(app, 'POST', '/api/erp/products', b, body)).body.id;
  const milk = await P({ name: 'Xom sut', kind: 'raw_milk', unit: 'kg' });
  const st1 = await P({ name: 'Zakvaska A', kind: 'raw', unit: 'g' });
  const st2 = await P({ name: 'Zakvaska B', kind: 'raw', unit: 'g' });
  const siyro = await P({ name: '5% siyro', kind: 'semi', unit: 'kg' });
  const wh = (await call(app, 'POST', '/api/erp/warehouses', b, { name: 'Xom', kind: 'raw_milk' })).body.id;
  await call(app, 'POST', '/api/erp/docs', b, { type: 'opening', to: { warehouseId: wh }, lines: [{ productId: milk, qty: 1000, unitCost: 5000 }, { productId: st1, qty: 50, unitCost: 10 }, { productId: st2, qty: 50, unitCost: 10 }] });
  const tech = Number(db.prepare("INSERT INTO users (login, name, password_hash, role_id) VALUES ('tech', 'T', ?, (SELECT id FROM roles WHERE code = 'technologist'))")
    .run((await import('bcryptjs')).default.hashSync('pass1234', 4)).lastInsertRowid);
  db.prepare("INSERT INTO devices (user_id, name) VALUES (?, 'Q')").run(tech);
  const tr = (await call(app, 'POST', '/api/erp/docs', b, { type: 'transfer', from: { warehouseId: wh }, to: { userId: tech }, lines: [{ productId: milk, qty: 1000 }, { productId: st1, qty: 50 }, { productId: st2, qty: 50 }] })).body;
  const t = await login(app, 'tech', 'pass1234');
  await call(app, 'POST', `/api/erp/docs/${tr.id}/accept`, t, {});
  const r = (await call(app, 'POST', '/api/erp/prod/recipes', b, {
    name: '5%', kind: 'cook', productId: siyro, outMin: 320, outMax: 335,
    lines: [{ productId: milk, qty: 320 }, { productId: st1, qty: 4, alts: [{ productId: st2 }] }],
    limits: [{ name: 'B zakvaska bilan', productIds: [st2], outMin: 315, outMax: 330 }],
  })).body;
  assert.equal(r.limits[0].products[0], 'Zakvaska B');
  await call(app, 'POST', '/api/erp/prod/shift', t, {});
  // with starter A: the recipe's own range — 333 is fine
  const a = (await call(app, 'POST', '/api/erp/prod/tasks', t, { recipeId: r.id, milkQty: 320 })).body;
  assert.equal((await call(app, 'POST', `/api/erp/prod/tasks/${a.id}/complete`, t, { outputQty: 333 })).body.task.status, 'done');
  // with starter B: 333 is over the conditional 330
  const c = (await call(app, 'POST', '/api/erp/prod/tasks', t, { recipeId: r.id, milkQty: 320, lines: [{ lineId: r.lines[1].id, productId: st2 }] })).body;
  const res = (await call(app, 'POST', `/api/erp/prod/tasks/${c.id}/complete`, t, { outputQty: 333 })).body;
  assert.equal(res.needApproval, true);
  assert.deepEqual([res.range.min, res.range.max, res.range.rule], [315, 330, 'B zakvaska bilan']);
  void ids;
});
