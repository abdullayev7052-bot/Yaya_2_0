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
  const reason = db.prepare("SELECT id FROM stock_reasons WHERE section = 'warehouse' AND charge = 'company' LIMIT 1").get().id;
  await call(app, 'POST', '/api/erp/docs', b, { type: 'writeoff', from: { warehouseId: fin }, reasonId: reason, lines: [{ productId: qatiq, qty: 1 }] });
  return { app, db, ids, b, qatiq, fin };
}

test('reports stop at the warehouse: no sales reports; values only for managers; staff report needs payroll', async () => {
  const { app, b } = await data();
  const list = (await call(app, 'GET', R, b)).body.map((x) => x.key);
  assert.ok(!list.some((k) => k.startsWith('sales')), 'sales reports are gone');
  assert.ok(['production_by_product', 'stock_movement', 'losses', 'expiry'].every((k) => list.includes(k)));
  assert.equal((await call(app, 'GET', `${R}/sales_by_product`, b)).status, 404);
  const q = `?from=2026-02-01&to=${today()}`;
  const mv = (await call(app, 'GET', `${R}/stock_movement${q}`, b)).body;
  assert.deepEqual([mv.rows[0].open_qty, mv.rows[0].in_qty, mv.rows[0].out_qty, mv.rows[0].close_qty], [20, 0, 1, 19]);
  assert.equal(mv.rows[0].close_value, 19 * 3000);
  // the storekeeper has reports, but not costs: value columns are gone
  const s = await login(app, 'store', 'store123');
  const mv2 = (await call(app, 'GET', `${R}/stock_movement${q}`, s)).body;
  assert.ok(!mv2.columns.some((c) => c.key === 'close_value'));
  assert.equal(mv2.rows[0].close_value, undefined);
  assert.equal((await call(app, 'GET', `${R}/staff_summary`, s)).status, 403);
  assert.ok(!(await call(app, 'GET', R, s)).body.some((x) => x.key === 'staff_summary'));
});

test('losses, expiry, staff; Excel export; trend without sales', async () => {
  const { app, b } = await data();
  const q = `?from=2026-01-01&to=${today()}`;
  const loss = (await call(app, 'GET', `${R}/losses${q}`, b)).body;
  assert.equal(loss.totals.amount, 3000);
  assert.equal(loss.rows[0].who, 'Kompaniya');
  assert.ok(Array.isArray((await call(app, 'GET', `${R}/expiry?days=30`, b)).body.rows));
  assert.ok(Array.isArray((await call(app, 'GET', `${R}/staff_summary${q}`, b)).body.rows));
  // Excel
  const x = await app.inject({ method: 'GET', url: `${R}/stock_movement/xlsx?from=2026-02-01&to=${today()}`, headers: b });
  assert.equal(x.statusCode, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(x.rawPayload);
  const ws = wb.worksheets[0];
  assert.equal(ws.getRow(4).getCell(1).value, 'Mahsulot');
  assert.equal(ws.getRow(5).getCell(1).value, '5% qatiq 400 g');
  // trend for the home page chart: milk and production only
  const tr = (await call(app, 'GET', `${R}/trend?days=7`, b)).body;
  assert.equal(tr.length, 7);
  assert.equal(tr[6].sales, undefined);
});
