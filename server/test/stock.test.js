import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { setup, call, login, ali, boss, runShift, now } from './helpers.js';

const store = (app) => login(app, 'store', 'store123');

// Admin creates warehouses and products; the storekeeper keeps the finished-goods warehouse.
async function base(app, db, ids, { allowNegative = false } = {}) {
  const b = await boss(app);
  const fin = (await call(app, 'POST', '/api/erp/warehouses', b, { name: 'Tayyor mahsulot ombori', kind: 'finished', keepers: [ids.store], allowNegative })).body.id;
  const pack = (await call(app, 'POST', '/api/erp/warehouses', b, { name: 'Idish ombori', kind: 'pack' })).body.id;
  const smetana = (await call(app, 'POST', '/api/erp/products', b, { name: 'Smetana 20% 400 g', kind: 'finished', unit: 'dona', netto_g: 400, brutto_g: 425, shelf_life_hours: 168 })).body.id;
  const idish = (await call(app, 'POST', '/api/erp/products', b, { name: 'V idish 400 g', kind: 'pack', unit: 'dona' })).body.id;
  return { b, fin, pack, smetana, idish };
}
const opening = (app, h, warehouseId, lines, extra = {}) => call(app, 'POST', '/api/erp/docs', h, { type: 'opening', to: { warehouseId }, lines, ...extra });
const qtyAt = async (app, h, q) => (await call(app, 'GET', `/api/erp/stock?${new URLSearchParams(q)}`, h)).body.rows;

test('accepted milk enters the raw-milk warehouse at what households are owed; test shifts do not', async () => {
  const { app, db } = setup();
  const h = await ali(app);
  const b = await boss(app);
  await runShift(app, h, 'm1', [{ supplierId: 1, quantity: 20 }, { supplierId: 2, quantity: 10 }], { close: true });
  const shift = db.prepare("SELECT id FROM shifts WHERE client_uuid = 'm1'").get().id;
  // real quantity 29 kg instead of the written 30: the company still pays for 30
  assert.equal((await call(app, 'POST', `/api/admin/shifts/${shift}/accept`, b, { real: { 1: 29 } })).status, 200);
  const wh = db.prepare("SELECT id, name FROM warehouses WHERE kind = 'raw_milk'").get();
  assert.equal(wh.name, 'Xom sut ombori', 'created on first use');
  const rows = await qtyAt(app, b, { warehouseId: wh.id });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].qty, 29);
  assert.equal(rows[0].cost, 20 * 5000 + 10 * 6000, 'cost = what the households are owed');
  const doc = db.prepare("SELECT * FROM docs WHERE type = 'milk_in'").get();
  assert.equal(doc.source, 'shift');
  assert.equal((await call(app, 'POST', `/api/erp/docs/${doc.id}/cancel`, b, { reason: 'x' })).status, 400, 'shift milk cannot be cancelled here');

  // a test collector's shift never reaches the warehouse
  const t = await login(app, '900000000', '1111');
  await runShift(app, t, 't1', [{ supplierId: 1, quantity: 5 }], { close: true });
  const ts = db.prepare("SELECT id FROM shifts WHERE client_uuid = 't1'").get().id;
  await call(app, 'POST', `/api/admin/shifts/${ts}/accept`, b, {});
  assert.equal((await qtyAt(app, b, { warehouseId: wh.id }))[0].qty, 29);
  // collectors still only see milk products
  const boot = (await call(app, 'GET', '/api/mobile/bootstrap', h)).body;
  assert.ok(boot.products.every((p) => p.name.includes('sut')));
});

test('FIFO: the oldest lot goes first, at its own cost; a hand-over moves only when accepted', async () => {
  const { app, db, ids } = setup();
  const { b, fin, smetana } = await base(app, db, ids);
  await opening(app, b, fin, [{ productId: smetana, qty: 10, unitCost: 7000 }], { date: '2026-11-01T08:00:00Z' });
  await opening(app, b, fin, [{ productId: smetana, qty: 10, unitCost: 7600 }], { date: '2026-11-02T08:00:00Z' });
  const s = await store(app);

  // storekeeper hands 12 to Ali; nothing moves until Ali accepts
  const t = (await call(app, 'POST', '/api/erp/docs', s, { type: 'transfer', uuid: 'tr-1', from: { warehouseId: fin }, to: { userId: ids.ali }, lines: [{ productId: smetana, qty: 12 }] })).body;
  assert.equal(t.status, 'sent');
  assert.equal(t.total_cost, undefined, 'storekeeper never receives costs');
  assert.equal((await qtyAt(app, b, { warehouseId: fin }))[0].qty, 20);
  // re-sending the same uuid does not create a second document
  const again = (await call(app, 'POST', '/api/erp/docs', s, { type: 'transfer', uuid: 'tr-1', from: { warehouseId: fin }, to: { userId: ids.ali }, lines: [{ productId: smetana, qty: 12 }] })).body;
  assert.equal(again.id, t.id);
  // only the receiver (or a manager) may accept
  const acc = await login(app, 'acc', 'acc12345');
  assert.equal((await call(app, 'POST', `/api/erp/docs/${t.id}/accept`, acc, {})).status, 403);
  // Ali has no stock.transfer by default; give the collector role the permission
  const role = db.prepare("SELECT id, permissions FROM roles WHERE code = 'collector'").get();
  db.prepare('UPDATE roles SET permissions = ? WHERE id = ?').run(JSON.stringify([...JSON.parse(role.permissions), 'stock.transfer']), role.id);
  const a = await ali(app);
  const inbox = (await call(app, 'GET', '/api/erp/inbox', a)).body;
  assert.equal(inbox.length, 1);
  assert.equal((await call(app, 'POST', `/api/erp/docs/${t.id}/accept`, a, {})).status, 200);

  const fRows = await qtyAt(app, b, { warehouseId: fin });
  assert.equal(fRows[0].qty, 8);
  assert.equal(fRows[0].cost, 8 * 7600, 'the older 7000 lot is gone first');
  const mine = (await call(app, 'GET', '/api/erp/stock/mine', a)).body;
  assert.equal(mine.mine[0].qty, 12);
  assert.equal(mine.mine[0].cost, undefined, 'no costs for staff');
  const adminView = await qtyAt(app, b, { userId: ids.ali });
  assert.equal(adminView[0].cost, 10 * 7000 + 2 * 7600, 'admin sees the sums');
  // Ali hands it back; a rejected hand-over moves nothing
  const back = (await call(app, 'POST', '/api/erp/docs', a, { type: 'transfer', from: { userId: ids.ali }, to: { warehouseId: fin }, lines: [{ productId: smetana, qty: 2 }] })).body;
  assert.equal((await call(app, 'POST', `/api/erp/docs/${back.id}/reject`, s, { reason: 'Sanoq mos emas' })).status, 200);
  assert.equal((await call(app, 'GET', '/api/erp/stock/mine', a)).body.mine[0].qty, 12);
  // Ali cannot hand over goods from a warehouse he does not keep
  assert.equal((await call(app, 'POST', '/api/erp/docs', a, { type: 'transfer', from: { warehouseId: fin }, to: { userId: ids.ali }, lines: [{ productId: smetana, qty: 1 }] })).status, 403);
  // and cannot hand over more than he holds
  const tooMuch = await call(app, 'POST', '/api/erp/docs', a, { type: 'transfer', from: { userId: ids.ali }, to: { warehouseId: fin }, lines: [{ productId: smetana, qty: 13 }] });
  assert.equal(tooMuch.status, 200, 'sending is allowed; the check happens on acceptance');
  const fail = await call(app, 'POST', `/api/erp/docs/${tooMuch.body.id}/accept`, s, {});
  assert.equal(fail.status, 400);
  assert.match(fail.body.error, /yetarli emas/);
});

test('negative stock: refused unless the warehouse allows it; then an alert, and the next receipt settles it', async () => {
  const { app, db, ids } = setup();
  const { b, fin, smetana } = await base(app, db, ids);
  await opening(app, b, fin, [{ productId: smetana, qty: 5, unitCost: 7000 }]);
  const wo = { type: 'writeoff', from: { warehouseId: fin }, reasonId: 1, lines: [{ productId: smetana, qty: 8 }] };
  const r = await call(app, 'POST', '/api/erp/docs', b, wo);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /yetarli emas/);

  await call(app, 'PATCH', `/api/erp/warehouses/${fin}`, b, { allowNegative: true });
  assert.equal((await call(app, 'POST', '/api/erp/docs', b, wo)).status, 200);
  const rows = await qtyAt(app, b, { warehouseId: fin });
  assert.equal(rows[0].qty, -3);
  const alerts = (await call(app, 'GET', '/api/erp/alerts', b)).body;
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].text, /manfiy/);

  // a new receipt at a different price settles the shortage; the gap is a cost variance
  await opening(app, b, fin, [{ productId: smetana, qty: 10, unitCost: 8000 }]);
  const after = await qtyAt(app, b, { warehouseId: fin });
  assert.equal(after[0].qty, 7);
  assert.equal(after[0].cost, 7 * 8000);
  const variance = db.prepare("SELECT SUM(e.amount) a FROM pnl_entries e JOIN pnl_categories c ON c.id = e.category_id WHERE c.code = 'cost_variance'").get().a;
  assert.equal(variance, 3 * (8000 - 7000));
  const lots = (await call(app, 'GET', `/api/erp/stock/lots?warehouseId=${fin}&productId=${smetana}`, b)).body;
  assert.equal(lots.length, 1, 'no "no-lot" remainder is left');
});

test('write-off at the staff member\'s fault becomes their debt; cancelling reverses stock and debt', async () => {
  const { app, db, ids } = setup();
  const { b, fin, smetana } = await base(app, db, ids);
  await opening(app, b, fin, [{ productId: smetana, qty: 10, unitCost: 7000 }]);
  const spill = db.prepare("SELECT id FROM stock_reasons WHERE charge = 'staff'").get().id;
  const s = await store(app);
  // the storekeeper writes off 2 spilled jars, charged to Ali
  const d = (await call(app, 'POST', '/api/erp/docs', s, { type: 'writeoff', from: { warehouseId: fin }, reasonId: spill, chargeUserId: ids.ali, lines: [{ productId: smetana, qty: 2 }] })).body;
  assert.equal(d.status, 'posted');
  assert.equal((await call(app, 'GET', `/api/erp/staff-balance/${ids.ali}`, b)).body.balance, 14000);
  assert.equal((await call(app, 'GET', `/api/erp/staff-balance/${ids.ali}`, s)).status, 403, 'sums are not for the storekeeper');
  // a "staff" reason with goods in a warehouse needs a person
  assert.equal((await call(app, 'POST', '/api/erp/docs', s, { type: 'writeoff', from: { warehouseId: fin }, reasonId: spill, lines: [{ productId: smetana, qty: 1 }] })).status, 400);
  // only stock.cancel may reverse a posted document
  assert.equal((await call(app, 'POST', `/api/erp/docs/${d.id}/cancel`, s, { reason: 'xato' })).status, 403);
  assert.equal((await call(app, 'POST', `/api/erp/docs/${d.id}/cancel`, b, {})).status, 400, 'reason required');
  assert.equal((await call(app, 'POST', `/api/erp/docs/${d.id}/cancel`, b, { reason: 'Xato kiritildi' })).status, 200);
  assert.equal((await qtyAt(app, b, { warehouseId: fin }))[0].qty, 10);
  assert.equal((await call(app, 'GET', `/api/erp/staff-balance/${ids.ali}`, b)).body.balance, 0);
});

test('inventory: partial counts only listed items, full zeroes the rest; surplus and shortage hit profit and loss', async () => {
  const { app, db, ids } = setup();
  const { b, fin, smetana, idish } = await base(app, db, ids);
  await opening(app, b, fin, [{ productId: smetana, qty: 10, unitCost: 7000 }, { productId: idish, qty: 100, unitCost: 800 }]);
  const s = await store(app);
  // draft first (counts are saved as they go), then posted
  const draft = (await call(app, 'POST', '/api/erp/docs', s, { type: 'inventory', mode: 'partial', to: { warehouseId: fin }, lines: [{ productId: smetana, qty: 9 }] })).body;
  assert.equal(draft.status, 'draft');
  await call(app, 'PUT', `/api/erp/docs/${draft.id}`, s, { lines: [{ productId: smetana, qty: 12 }] });
  const posted = (await call(app, 'POST', `/api/erp/docs/${draft.id}/post`, s, {})).body;
  assert.equal(posted.status, 'posted');
  assert.equal(posted.lines[0].book, 10);
  assert.equal(posted.lines[0].diff, 2);
  let rows = await qtyAt(app, b, { warehouseId: fin });
  assert.equal(rows.find((r) => r.product_id === smetana).qty, 12);
  assert.equal(rows.find((r) => r.product_id === idish).qty, 100, 'partial: uncounted items untouched');

  // full count lists only the cups (95): the jars not counted become 0
  const full = (await call(app, 'POST', '/api/erp/docs', b, { type: 'inventory', mode: 'full', to: { warehouseId: fin }, post: true, lines: [{ productId: idish, qty: 95 }] })).body;
  assert.equal(full.lines.length, 2);
  rows = await qtyAt(app, b, { warehouseId: fin });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].qty, 95);
  const sum = (code) => db.prepare('SELECT COALESCE(SUM(e.amount), 0) a FROM pnl_entries e JOIN pnl_categories c ON c.id = e.category_id WHERE c.code = ?').get(code).a;
  assert.equal(sum('stock_surplus'), 2 * 7000);
  assert.equal(sum('stock_loss'), 12 * 7000 + 5 * 800);
});

test('a posted receipt cannot be cancelled once its goods moved on', async () => {
  const { app, db, ids } = setup();
  const { b, fin, pack, idish } = await base(app, db, ids);
  const o = (await opening(app, b, pack, [{ productId: idish, qty: 50, unitCost: 800 }])).body;
  const t = (await call(app, 'POST', '/api/erp/docs', b, { type: 'transfer', from: { warehouseId: pack }, to: { warehouseId: fin }, lines: [{ productId: idish, qty: 30 }] })).body;
  await call(app, 'POST', `/api/erp/docs/${t.id}/accept`, b, {});
  const r = await call(app, 'POST', `/api/erp/docs/${o.id}/cancel`, b, { reason: 'xato' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /boshqa joyga ketgan/);
  // undo the hand-over first, then the receipt can go
  assert.equal((await call(app, 'POST', `/api/erp/docs/${t.id}/cancel`, b, { reason: 'qaytarish' })).status, 200);
  assert.equal((await call(app, 'POST', `/api/erp/docs/${o.id}/cancel`, b, { reason: 'xato' })).status, 200);
  assert.equal((await qtyAt(app, b, {})).length, 0);
});

async function xlsx(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('S');
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
}

test('Excel: products and opening stock are checked first, then imported', async () => {
  const { app, db, ids } = setup();
  const b = await boss(app);
  const tpl = await call(app, 'GET', '/api/erp/import/products/template.xlsx', b);
  assert.equal(tpl.status, 200);
  const file = await xlsx([
    ['Nomi (majburiy)', 'Turi', 'Birlik', 'Netto (g)', 'Brutto (g)', 'Shakl', 'Yaroqlilik (soat)'],
    ['Qatiq 0,5 kg', 'Tayyor mahsulot', 'dona', 500, 530, 'Dumaloq', 120],
    ['Tomizg\'i', 'Xomashyo', 'kg'],
    ['Nimadir', 'Kosmik', 'kg'],
  ]);
  const dry = (await call(app, 'POST', '/api/erp/import/products', b, { file })).body;
  assert.equal(dry.ok, false);
  assert.equal(dry.errors[0].row, 4);
  const good = await xlsx([['Nomi (majburiy)', 'Turi', 'Birlik', 'Netto (g)'], ['Qatiq 0,5 kg', 'Tayyor', 'dona', 500], ['Tomizg\'i', 'Xomashyo', 'kg']]);
  assert.equal((await call(app, 'POST', '/api/erp/import/products', b, { file: good })).body.summary.create, 2);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM products WHERE name = 'Qatiq 0,5 kg'").get().n, 0, 'dry run writes nothing');
  const done = (await call(app, 'POST', '/api/erp/import/products', b, { file: good, dryRun: false })).body;
  assert.equal(done.ok, true);
  const q = db.prepare("SELECT * FROM products WHERE name = 'Qatiq 0,5 kg'").get();
  assert.equal(q.kind, 'finished');
  assert.equal(q.netto_g, 500);

  await call(app, 'POST', '/api/erp/warehouses', b, { name: 'Tayyor mahsulot ombori', kind: 'finished', keepers: [ids.store] });
  const op = await xlsx([['Ombor (majburiy)', 'Mahsulot (majburiy)', 'Miqdor (majburiy)', 'Tannarx (1 birlik, so\'m)', 'Yaroqlilik sanasi'],
    ['Tayyor mahsulot ombori', 'Qatiq 0,5 kg', 40, 6500, '2026-12-01']]);
  const r = (await call(app, 'POST', '/api/erp/import/opening', b, { file: op, dryRun: false })).body;
  assert.equal(r.ok, true);
  assert.equal(r.docs.length, 1);
  const rows = await qtyAt(app, b, {});
  assert.equal(rows[0].qty, 40);
  assert.equal(rows[0].cost, 260000);
  assert.equal(rows[0].weight_kg, 20, 'netto weight shown');
  assert.ok(rows[0].nearest_expiry.startsWith('2026-12-01'));
  // the storekeeper cannot import opening stock
  assert.equal((await call(app, 'POST', '/api/erp/import/opening', await store(app), { file: op })).status, 403);
  void now;
});
