import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { setup, call, login, boss } from './helpers.js';

const R = '/api/erp/reports';
const today = () => new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);

async function data() {
  const { app, db, ids } = setup();
  const b = await boss(app);
  const qatiq = (await call(app, 'POST', '/api/erp/products', b, { name: '5% qatiq 400 g', kind: 'finished', unit: 'dona', netto_g: 400 })).body.id;
  const fin = (await call(app, 'POST', '/api/erp/warehouses', b, { name: 'Tayyor', kind: 'finished' })).body.id;
  await call(app, 'POST', '/api/erp/docs', b, { type: 'opening', to: { warehouseId: fin }, date: '2026-01-01T08:00:00Z', lines: [{ productId: qatiq, qty: 20, unitCost: 3000 }] });
  const c = (await call(app, 'POST', '/api/erp/sales/customers', b, { name: 'Ahmad' })).body.id;
  await call(app, 'PUT', '/api/erp/sales/prices', b, { productId: qatiq, scope: 'base', price: 5000 });
  const rt = (await call(app, 'POST', '/api/erp/sales/return-types', b, { name: 'Toza', warehouseId: fin })).body.id;
  await call(app, 'POST', '/api/erp/sales/sales', b, { customerId: c, from: { warehouseId: fin }, lines: [{ productId: qatiq, qty: 10 }], paid: 20000 });
  await call(app, 'POST', '/api/erp/sales/returns', b, { customerId: c, returnTypeId: rt, lines: [{ productId: qatiq, qty: 2 }] });
  const reason = db.prepare("SELECT id FROM stock_reasons WHERE section = 'warehouse' AND charge = 'company' LIMIT 1").get().id;
  await call(app, 'POST', '/api/erp/docs', b, { type: 'writeoff', from: { warehouseId: fin }, reasonId: reason, lines: [{ productId: qatiq, qty: 1 }] });
  return { app, db, ids, b, qatiq, fin };
}

test('sales by product: net of returns, cost and profit for managers only', async () => {
  const { app, b } = await data();
  const r = (await call(app, 'GET', `${R}/sales_by_product?from=2026-01-01&to=${today()}`, b)).body;
  assert.equal(r.rows.length, 1);
  const row = r.rows[0];
  assert.equal(row.qty, 10);
  assert.equal(row.revenue, 50000);
  assert.equal(row.ret_value, 10000);
  assert.equal(row.net, 40000);
  assert.equal(row.cost, 8 * 3000);
  assert.equal(row.profit, 16000);
  assert.equal(row.margin, 40);
  // the storekeeper has reports, but not costs: those columns are gone
  const s = await login(app, 'store', 'store123');
  const r2 = (await call(app, 'GET', `${R}/sales_by_product?from=2026-01-01&to=${today()}`, s)).body;
  assert.ok(!r2.columns.some((c) => c.key === 'cost' || c.key === 'profit'));
  assert.equal(r2.rows[0].cost, undefined);
  // the staff money report needs payroll rights
  assert.equal((await call(app, 'GET', `${R}/staff_summary`, s)).status, 403);
  assert.ok(!(await call(app, 'GET', R, s)).body.some((x) => x.key === 'staff_summary'));
});

test('customers, sellers, days, stock movement, losses, expiry, staff; Excel export; trend', async () => {
  const { app, b } = await data();
  const q = `?from=2026-01-01&to=${today()}`;
  const cust = (await call(app, 'GET', `${R}/sales_by_customer${q}`, b)).body;
  assert.equal(cust.rows[0].paid, 20000);
  assert.equal(cust.rows[0].debt, 20000, '50 000 sold − 20 000 paid − 10 000 returned');
  assert.equal((await call(app, 'GET', `${R}/sales_by_seller${q}`, b)).body.rows[0].receipts, 1);
  assert.equal((await call(app, 'GET', `${R}/sales_daily${q}`, b)).body.totals.net, 40000);
  const mv = (await call(app, 'GET', `${R}/stock_movement?from=2026-02-01&to=${today()}`, b)).body.rows[0];
  // opening 20 (January); out: 10 sold + 1 written off; in: 2 returned; closing 11
  assert.deepEqual([mv.open_qty, mv.in_qty, mv.out_qty, mv.close_qty], [20, 2, 11, 11]);
  const loss = (await call(app, 'GET', `${R}/losses${q}`, b)).body;
  assert.equal(loss.totals.amount, 3000);
  assert.equal(loss.rows[0].who, 'Kompaniya');
  assert.ok(Array.isArray((await call(app, 'GET', `${R}/expiry?days=30`, b)).body.rows));
  assert.ok(Array.isArray((await call(app, 'GET', `${R}/staff_summary${q}`, b)).body.rows));
  // Excel
  const x = await app.inject({ method: 'GET', url: `${R}/sales_by_product/xlsx${q}`, headers: b });
  assert.equal(x.statusCode, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(x.rawPayload);
  const ws = wb.worksheets[0];
  assert.equal(ws.getCell('A1').value, "Savdo — mahsulotlar bo'yicha");
  assert.equal(ws.getRow(4).getCell(1).value, 'Mahsulot');
  assert.equal(ws.getRow(5).getCell(1).value, '5% qatiq 400 g');
  // trend for the home page chart
  const tr = (await call(app, 'GET', `${R}/trend?days=7`, b)).body;
  assert.equal(tr.length, 7);
  assert.equal(tr[6].sales, 40000);
});
