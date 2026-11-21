import { test } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { setup, call, login, boss } from './helpers.js';
import { roleIdByCode, ensureDeviceSlots } from '../src/db/index.js';

async function shop() {
  const { app, db, ids } = setup();
  const id = Number(db.prepare('INSERT INTO users (login, name, password_hash, role_id) VALUES (?, ?, ?, ?)')
    .run('seller', 'Sotuvchi Jasur', bcrypt.hashSync('pass1234', 4), roleIdByCode(db, 'seller')).lastInsertRowid);
  ensureDeviceSlots(db, id);
  ids.seller = id;
  const b = await boss(app);
  const s = await login(app, 'seller', 'pass1234');
  const qatiq = (await call(app, 'POST', '/api/erp/products', b, { name: '5% qatiq 400 g', kind: 'finished', unit: 'dona', netto_g: 400 })).body.id;
  const smetana = (await call(app, 'POST', '/api/erp/products', b, { name: 'Smetana 400 g', kind: 'finished', unit: 'dona' })).body.id;
  const fin = (await call(app, 'POST', '/api/erp/warehouses', b, { name: 'Tayyor mahsulot ombori', kind: 'finished', keepers: [id] })).body.id;
  const exp = (await call(app, 'POST', '/api/erp/warehouses', b, { name: "Muddati o'tganlar", kind: 'expired' })).body.id;
  await call(app, 'POST', '/api/erp/docs', b, { type: 'opening', to: { warehouseId: fin }, date: '2026-11-01T08:00:00Z', lines: [{ productId: qatiq, qty: 10, unitCost: 3000 }] });
  await call(app, 'POST', '/api/erp/docs', b, { type: 'opening', to: { warehouseId: fin }, date: '2026-11-02T08:00:00Z', lines: [{ productId: qatiq, qty: 10, unitCost: 3600 }, { productId: smetana, qty: 5, unitCost: 7000 }] });
  const types = (await call(app, 'GET', '/api/erp/sales/meta', b)).body.customerTypes;
  const shopT = types.find((t) => t.name === "Do'kon").id;
  const dealer = types.find((t) => t.name === 'Diler').id;
  const C = async (body) => (await call(app, 'POST', '/api/erp/sales/customers', b, body)).body.id;
  const cust = {
    a: await C({ name: 'Ahmad do\'koni', phone: '+998 90 111 22 33', typeId: shopT, openingBalance: 10000 }),
    bb: await C({ name: 'Barno diler', typeId: dealer }),
    c: await C({ name: 'Chilonzor diler', typeId: dealer, expiredPolicy: 'keep' }),
  };
  await call(app, 'PUT', '/api/erp/sales/prices', b, [
    { productId: qatiq, scope: 'base', price: 5000 }, { productId: qatiq, scope: `t:${dealer}`, price: 4500 }, { productId: qatiq, scope: `c:${cust.c}`, price: 4200 }]);
  const rt = {
    clean: (await call(app, 'POST', '/api/erp/sales/return-types', b, { name: 'Toza', warehouseId: fin })).body.id,
    expired: (await call(app, 'POST', '/api/erp/sales/return-types', b, { name: "Muddati o'tgan", warehouseId: exp, expired: true })).body.id,
  };
  return { app, db, ids, b, s, qatiq, smetana, fin, exp, cust, rt };
}
const pnlSum = (db, code) => db.prepare('SELECT COALESCE(ROUND(SUM(e.amount), 2), 0) a FROM pnl_entries e JOIN pnl_categories c ON c.id = e.category_id WHERE c.code = ?').get(code).a;
const stockAt = (db, productId, wh) => db.prepare('SELECT ROUND(SUM(qty), 3) q, ROUND(SUM(cost), 2) c FROM stock_moves WHERE product_id = ? AND warehouse_id = ?').get(productId, wh);

test('prices: customer, then type, then base', async () => {
  const { app, s, qatiq, cust } = await shop();
  const P = async (c) => (await call(app, 'GET', `/api/erp/sales/prices?customerId=${c}`, s)).body[qatiq];
  assert.deepEqual([await P(cust.a), await P(cust.bb), await P(cust.c)], [5000, 4500, 4200]);
});

test('sale: FIFO cost, debt before/after, money to the seller\'s own cashbox; return (last / avg cost, expired policy); payment; cancel', async () => {
  const { app, db, b, s, ids, qatiq, smetana, fin, exp, cust, rt } = await shop();
  // the seller cannot change prices, nor sell what has no price
  assert.equal((await call(app, 'POST', '/api/erp/sales/sales', s, { customerId: cust.a, from: { warehouseId: fin }, lines: [{ productId: qatiq, qty: 1, price: 100 }] })).status, 400);
  const noPrice = await call(app, 'POST', '/api/erp/sales/sales', s, { customerId: cust.a, from: { warehouseId: fin }, lines: [{ productId: smetana, qty: 1 }] });
  assert.match(noPrice.body.error, /narx belgilanmagan/);

  const sale = await call(app, 'POST', '/api/erp/sales/sales', s, { uuid: 'sale-1', customerId: cust.a, from: { warehouseId: fin }, lines: [{ productId: qatiq, qty: 12 }], paid: 30000 });
  assert.equal(sale.status, 200);
  const d = sale.body;
  assert.equal(d.total, 60000);
  assert.equal(d.paid, 30000);
  assert.equal(d.debt_before, 10000);
  assert.equal(d.debt_after, 40000);
  assert.equal(d.total_cost, undefined, 'sellers never see cost');
  assert.equal(d.lines[0].price, 5000);
  assert.equal(d.total_weight_kg, 4.8);
  // re-sending the same uuid does not sell twice
  assert.equal((await call(app, 'POST', '/api/erp/sales/sales', s, { uuid: 'sale-1', customerId: cust.a, from: { warehouseId: fin }, lines: [{ productId: qatiq, qty: 12 }], paid: 30000 })).body.id, d.id);
  // the manager sees the cost: the 10 older (3000) first, then 2 at 3600
  assert.equal((await call(app, 'GET', `/api/erp/sales/docs/${d.id}`, b)).body.total_cost, 10 * 3000 + 2 * 3600);
  assert.equal(pnlSum(db, 'sales_revenue'), 60000);
  assert.equal(pnlSum(db, 'cogs'), 37200);
  const box = (await call(app, 'GET', '/api/erp/sales/my-cashbox', s)).body;
  assert.equal(box.balance, 30000);
  assert.match(box.name, /Sotuvchi Jasur/);

  // receipt: type, seller, prices, debt before and after
  const html = (await call(app, 'GET', `/api/erp/sales/docs/${d.id}/receipt`, s)).body.html;
  assert.match(html, /SOTUV/);
  assert.match(html, /Sotuvchi Jasur/);
  assert.match(html, /Oldingi qarz:<\/td><td class="r">10 000/);
  assert.match(html, /Hozirgi qarz:<\/td><td class="r">40 000/);

  // clean return of 2: at the last lot's cost (3600), credited at the sale price
  const ret = (await call(app, 'POST', '/api/erp/sales/returns', s, { customerId: cust.a, returnTypeId: rt.clean, costMode: 'last', lines: [{ productId: qatiq, qty: 2 }] })).body;
  assert.equal(ret.credit, 10000);
  assert.equal(ret.debt_after, 30000);
  assert.deepEqual(stockAt(db, qatiq, fin), { q: 10, c: 8 * 3600 + 2 * 3600 });

  // an expired return from a customer whose policy keeps the debt: no credit, goods to the expired warehouse at their average cost
  await call(app, 'POST', '/api/erp/sales/sales', s, { customerId: cust.c, from: { warehouseId: fin }, lines: [{ productId: qatiq, qty: 3 }] });
  const exr = (await call(app, 'POST', '/api/erp/sales/returns', s, { customerId: cust.c, returnTypeId: rt.expired, costMode: 'avg', lines: [{ productId: qatiq, qty: 1 }] })).body;
  assert.equal(exr.credit, 0);
  assert.equal(exr.debt_after, exr.debt_before);
  assert.equal(exr.debt_after, 3 * 4200);
  assert.deepEqual(stockAt(db, qatiq, exp), { q: 1, c: 3600 });

  // the customer pays off the rest
  const pay = (await call(app, 'POST', '/api/erp/sales/payments', s, { customerId: cust.a, amount: 30000 })).body;
  assert.equal(pay.debt_after, 0);
  assert.equal((await call(app, 'GET', '/api/erp/sales/my-cashbox', s)).body.balance, 60000);
  const card = (await call(app, 'GET', `/api/erp/sales/customers/${cust.a}`, s)).body;
  assert.equal(card.balance, 0);
  assert.equal(card.entries.length, 4);

  // only sales.cancel may cancel; it reverses stock, debt and money
  assert.equal((await call(app, 'POST', `/api/erp/sales/docs/${pay.id}/cancel`, s, { reason: 'x' })).status, 403);
  assert.equal((await call(app, 'POST', `/api/erp/sales/docs/${pay.id}/cancel`, b, { reason: "Noto'g'ri mijoz" })).status, 200);
  assert.equal((await call(app, 'GET', `/api/erp/sales/customers/${cust.a}`, b)).body.balance, 30000);
  assert.equal((await call(app, 'GET', '/api/erp/sales/my-cashbox', s)).body.balance, 30000);
  // a seller sees only their own documents; the manager all
  assert.ok((await call(app, 'GET', '/api/erp/sales/docs', s)).body.every((x) => x.created_by_id === ids.seller));
});

test('a seller may add a customer on the spot, but not an opening debt; only the manager edits customers', async () => {
  const { app, s, b } = await shop();
  const c = (await call(app, 'POST', '/api/erp/sales/customers', s, { name: 'Yangi mijoz', openingBalance: 999999 })).body.id;
  const card = (await call(app, 'GET', `/api/erp/sales/customers/${c}`, b)).body;
  assert.equal(card.balance, 0);
  assert.equal((await call(app, 'PUT', `/api/erp/sales/customers/${c}`, s, { name: 'X' })).status, 403);
});
