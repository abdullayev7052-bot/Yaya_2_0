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

test("accepted milk (yog'li + yog'siz) enters the warehouse as one Xom sut at the shift average; test shifts do not", async () => {
  const { app, db } = setup();
  const h = await ali(app);
  const b = await boss(app);
  await runShift(app, h, 'm1', [{ supplierId: 1, quantity: 20 }, { supplierId: 2, quantity: 10 }, { supplierId: 1, productId: 2, quantity: 10 }], { close: true });
  const shift = db.prepare("SELECT id FROM shifts WHERE client_uuid = 'm1'").get().id;
  // real yog'li sut 29 kg instead of the written 30: the company still pays for 30
  assert.equal((await call(app, 'POST', `/api/admin/shifts/${shift}/accept`, b, { real: { 1: 29 } })).status, 200);
  const wh = db.prepare("SELECT id, name FROM warehouses WHERE kind = 'raw_milk'").get();
  assert.equal(wh.name, 'Sut ombori', 'created on first use');
  const rows = await qtyAt(app, b, { warehouseId: wh.id });
  assert.equal(rows.length, 1, 'one product in the warehouse');
  assert.equal(rows[0].product, "Yog'li sut");
  assert.equal(rows[0].qty, 39);
  const owed = 20 * 5000 + 10 * 6000 + 10 * 3000;
  assert.equal(rows[0].cost, owed, 'cost = what the households are owed');
  assert.equal(rows[0].unit_cost, Math.round((owed / 39) * 100) / 100, "unit cost = this shift's real average");
  // the panel's milk-collection product list stays Yog'li / Yog'siz sut only
  const panel = (await call(app, 'GET', '/api/admin/products', b)).body;
  assert.deepEqual(panel.map((p) => p.name).sort(), ["Yog'li sut", "Yog'siz sut"]);
  const doc = db.prepare("SELECT * FROM docs WHERE type = 'milk_in'").get();
  assert.equal(doc.source, 'shift');
  assert.equal((await call(app, 'POST', `/api/erp/docs/${doc.id}/cancel`, b, { reason: 'x' })).status, 400, 'shift milk cannot be cancelled here');

  // a test collector's shift never reaches the warehouse
  const t = await login(app, '900000000', '1111');
  await runShift(app, t, 't1', [{ supplierId: 1, quantity: 5 }], { close: true });
  const ts = db.prepare("SELECT id FROM shifts WHERE client_uuid = 't1'").get().id;
  await call(app, 'POST', `/api/admin/shifts/${ts}/accept`, b, {});
  assert.equal((await qtyAt(app, b, { warehouseId: wh.id }))[0].qty, 39);
  // collectors still only see milk products
  const boot = (await call(app, 'GET', '/api/mobile/bootstrap', h)).body;
  assert.ok(boot.products.every((p) => p.name.includes('sut')));
});

test('FIFO: the oldest lot goes first, at its own cost; a hand-over between warehouses moves only when accepted; nothing goes to a person', async () => {
  const { app, db, ids } = setup();
  const { b, fin, smetana } = await base(app, db, ids);
  await opening(app, b, fin, [{ productId: smetana, qty: 10, unitCost: 7000 }], { date: '2026-11-01T08:00:00Z' });
  await opening(app, b, fin, [{ productId: smetana, qty: 10, unitCost: 7600 }], { date: '2026-11-02T08:00:00Z' });
  const s = await store(app);
  // Ali keeps the shop warehouse
  const shop = (await call(app, 'POST', '/api/erp/warehouses', b, { name: "Do'kon ombori", kind: 'general', keepers: [ids.ali] })).body.id;
  // a hand-over to a person is refused (goods are always in a warehouse or a stage)
  assert.equal((await call(app, 'POST', '/api/erp/docs', s, { type: 'transfer', from: { warehouseId: fin }, to: { userId: ids.ali }, lines: [{ productId: smetana, qty: 1 }] })).status, 400);
  // storekeeper hands 12 to the shop; nothing moves until its keeper accepts
  const t = (await call(app, 'POST', '/api/erp/docs', s, { type: 'transfer', uuid: 'tr-1', from: { warehouseId: fin }, to: { warehouseId: shop }, lines: [{ productId: smetana, qty: 12 }] })).body;
  assert.equal(t.status, 'sent');
  assert.equal(t.total_cost, undefined, 'storekeeper never receives costs');
  assert.equal((await qtyAt(app, b, { warehouseId: fin }))[0].qty, 20);
  // re-sending the same uuid does not create a second document
  const again = (await call(app, 'POST', '/api/erp/docs', s, { type: 'transfer', uuid: 'tr-1', from: { warehouseId: fin }, to: { warehouseId: shop }, lines: [{ productId: smetana, qty: 12 }] })).body;
  assert.equal(again.id, t.id);
  // only the receiver (or a manager) may accept
  const acc = await login(app, 'acc', 'acc12345');
  assert.equal((await call(app, 'POST', `/api/erp/docs/${t.id}/accept`, acc, {})).status, 403);
  // Ali has no stock.transfer by default; give the collector role the permission
  const role = db.prepare("SELECT id, permissions FROM roles WHERE code = 'collector'").get();
  db.prepare('UPDATE roles SET permissions = ? WHERE id = ?').run(JSON.stringify([...JSON.parse(role.permissions), 'stock.transfer']), role.id);
  const a = await ali(app);
  assert.equal((await call(app, 'GET', '/api/erp/inbox', a)).body.length, 1);
  assert.equal((await call(app, 'POST', `/api/erp/docs/${t.id}/accept`, a, {})).status, 200);
  const fRows = await qtyAt(app, b, { warehouseId: fin });
  assert.equal(fRows[0].qty, 8);
  assert.equal(fRows[0].cost, 8 * 7600, 'the older 7000 lot is gone first');
  const mine = (await call(app, 'GET', '/api/erp/stock/mine', a)).body;
  assert.deepEqual(mine.mine, [], 'nothing in hands');
  assert.equal(mine.warehouses[0].rows[0].qty, 12);
  assert.equal(mine.warehouses[0].rows[0].cost, undefined, 'no costs for staff');
  assert.equal((await qtyAt(app, b, { warehouseId: shop }))[0].cost, 10 * 7000 + 2 * 7600, 'admin sees the sums');
  // Ali hands 2 back; a rejected hand-over moves nothing
  const back = (await call(app, 'POST', '/api/erp/docs', a, { type: 'transfer', from: { warehouseId: shop }, to: { warehouseId: fin }, lines: [{ productId: smetana, qty: 2 }] })).body;
  assert.equal((await call(app, 'POST', `/api/erp/docs/${back.id}/reject`, s, { reason: 'Sanoq mos emas' })).status, 200);
  assert.equal((await qtyAt(app, b, { warehouseId: shop }))[0].qty, 12);
  // Ali cannot hand over goods from a warehouse he does not keep
  assert.equal((await call(app, 'POST', '/api/erp/docs', a, { type: 'transfer', from: { warehouseId: fin }, to: { warehouseId: shop }, lines: [{ productId: smetana, qty: 1 }] })).status, 403);
  // and cannot hand over more than there is: sending is allowed, the check happens on acceptance
  const tooMuch = await call(app, 'POST', '/api/erp/docs', a, { type: 'transfer', from: { warehouseId: shop }, to: { warehouseId: fin }, lines: [{ productId: smetana, qty: 13 }] });
  assert.equal(tooMuch.status, 200);
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
  const full = (await call(app, 'POST', '/api/erp/docs', b, { type: 'inventory', mode: 'full', to: { warehouseId: fin }, post: true, charges: [], lines: [{ productId: idish, qty: 95 }] })).body;
  assert.equal(full.lines.length, 2);
  rows = await qtyAt(app, b, { warehouseId: fin });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].qty, 95);
  const sum = (code) => db.prepare('SELECT COALESCE(SUM(e.amount), 0) a FROM pnl_entries e JOIN pnl_categories c ON c.id = e.category_id WHERE c.code = ?').get(code).a;
  assert.equal(sum('stock_surplus'), 2 * 7000);
  assert.equal(sum('stock_loss'), 12 * 7000 + 5 * 800, 'charges: [] = all to the company');
});

test('inventory shortage: asked every time; company, one person, or split by sums', async () => {
  const { app, db, ids } = setup();
  const { b, fin, smetana } = await base(app, db, ids);
  await opening(app, b, fin, [{ productId: smetana, qty: 10, unitCost: 7000 }]);
  const s = await store(app);
  const draft = (await call(app, 'POST', '/api/erp/docs', s, { type: 'inventory', to: { warehouseId: fin }, lines: [{ productId: smetana, qty: 7 }] })).body;
  // preview: the storekeeper sees the difference, never the sum
  const pv = await call(app, 'GET', `/api/erp/docs/${draft.id}/preview`, s);
  assert.equal(pv.status, 200);
  assert.equal(pv.body.lines[0].diff, -3);
  assert.equal(pv.body.loss, undefined);
  assert.equal((await call(app, 'GET', `/api/erp/docs/${draft.id}/preview`, b)).body.loss, 21000);
  assert.equal(db.prepare("SELECT status FROM docs WHERE id = ?").get(draft.id).status, 'draft', 'preview changes nothing');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM stock_moves WHERE doc_id = ?').get(draft.id).n, 0);
  // posting a shortage without a decision is refused, with the amount for the screen
  const ask = await call(app, 'POST', `/api/erp/docs/${draft.id}/post`, b, {});
  assert.equal(ask.status, 400);
  assert.equal(ask.body.details.needDecision, true);
  assert.equal(ask.body.details.loss, 21000);
  // the storekeeper cannot split sums; their attempt leaves one alert for the managers
  assert.equal((await call(app, 'POST', `/api/erp/docs/${draft.id}/post`, s, { charges: [] })).status, 403);
  assert.equal((await call(app, 'POST', `/api/erp/docs/${draft.id}/post`, s, {})).status, 400);
  assert.equal((await call(app, 'POST', `/api/erp/docs/${draft.id}/post`, s, {})).status, 400);
  const openAlerts = () => db.prepare("SELECT COUNT(*) n FROM alerts WHERE type = 'stock.shortage' AND resolved_at IS NULL").get().n;
  assert.equal(openAlerts(), 1);
  // more than the shortage cannot be charged
  assert.equal((await call(app, 'POST', `/api/erp/docs/${draft.id}/post`, b, { charges: [{ userId: ids.ali, amount: 30000 }] })).status, 400);
  // split: 15 000 to Ali, 4 000 to the storekeeper, the rest (2 000) to the company
  const ok = await call(app, 'POST', `/api/erp/docs/${draft.id}/post`, b, { charges: [{ userId: ids.ali, amount: 15000 }, { userId: ids.store, amount: 4000 }] });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.charges.length, 2);
  assert.equal(openAlerts(), 0, 'the alert closes once the count is posted');
  assert.equal((await call(app, 'GET', `/api/erp/staff-balance/${ids.ali}`, b)).body.balance, 15000);
  assert.equal((await call(app, 'GET', `/api/erp/staff-balance/${ids.store}`, b)).body.balance, 4000);
  const loss = db.prepare("SELECT SUM(e.amount) a FROM pnl_entries e JOIN pnl_categories c ON c.id = e.category_id WHERE c.code = 'stock_loss'").get().a;
  assert.equal(loss, 2000);
  // cancelling reverses all of it
  assert.equal((await call(app, 'POST', `/api/erp/docs/${draft.id}/cancel`, b, { reason: 'Qayta sanaladi' })).status, 200);
  assert.equal((await call(app, 'GET', `/api/erp/staff-balance/${ids.ali}`, b)).body.balance, 0);
  assert.equal((await qtyAt(app, b, { warehouseId: fin }))[0].qty, 10);
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
  // variants in one cell: a parent and its variants, each a product of its own
  const vf = await xlsx([['Nomi (majburiy)', 'Turi', 'Birlik', 'Variantlar (vergul bilan)'], ['Zakvaska', 'Xomashyo', 'g', '499, 505']]);
  assert.equal((await call(app, 'POST', '/api/erp/import/products', b, { file: vf, dryRun: false })).body.ok, true);
  assert.equal(db.prepare("SELECT has_variants FROM products WHERE name = 'Zakvaska'").get().has_variants, 1);
  assert.deepEqual(db.prepare("SELECT name, unit FROM products WHERE parent_id = (SELECT id FROM products WHERE name = 'Zakvaska') ORDER BY id").all(),
    [{ name: 'Zakvaska / 499', unit: 'g' }, { name: 'Zakvaska / 505', unit: 'g' }]);
  // an existing product without variants cannot get them
  const bad = await xlsx([['Nomi (majburiy)', 'Turi', 'Birlik', 'Variantlar (vergul bilan)'], ["Tomizg'i", 'Xomashyo', 'kg', 'A']]);
  assert.equal((await call(app, 'POST', '/api/erp/import/products', b, { file: bad })).body.ok, false);

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

test('a backup of the original (milk-only) Yaya restores into Yaya 2.0 and keeps working', async () => {
  const { snapshot, restore } = await import('../src/backup.js');
  const { ERP_SCHEMA_TABLES } = await import('../src/erp/schema.js');
  const { app, db } = setup();
  const b = await boss(app);
  const snap = snapshot(db);
  // what an old Yaya file looks like: no warehouse tables, products without the new columns
  for (const t of ERP_SCHEMA_TABLES) delete snap.tables[t];
  snap.tables.products = snap.tables.products.map(({ id, name, unit, active, created_at }) => ({ id, name, unit, active, created_at }));
  restore(db, snap);
  assert.ok(db.prepare('SELECT COUNT(*) n FROM units').get().n > 0, 'reference rows seeded again');
  assert.ok(db.prepare('SELECT COUNT(*) n FROM stock_reasons').get().n > 0);
  assert.deepEqual(db.prepare('SELECT DISTINCT kind FROM products').all().map((r) => r.kind), ['milk']);
  // milk collection and the warehouse both work after the restore
  const h = await ali(app);
  await runShift(app, h, 'r1', [{ supplierId: 1, quantity: 10 }], { close: true });
  const shift = db.prepare("SELECT id FROM shifts WHERE client_uuid = 'r1'").get().id;
  assert.equal((await call(app, 'POST', `/api/admin/shifts/${shift}/accept`, b, {})).status, 200);
  assert.equal((await qtyAt(app, b, { kind: 'main_raw' }))[0].qty, 10);
});

test('a product is deleted for good only with no stock, no history and no recipe using it', async () => {
  const { app, db, ids } = setup();
  const { b, fin, smetana, idish } = await base(app, db, ids);
  // with stock: refused, and the reason names the warehouse
  await opening(app, b, fin, [{ productId: smetana, qty: 5, unitCost: 7000 }]);
  const r1 = await call(app, 'DELETE', `/api/erp/products/${smetana}`, b);
  assert.equal(r1.status, 400);
  assert.match(r1.body.error, /qoldig'i bor: Tayyor mahsulot ombori/);
  // a new product made by mistake, never used: deleted
  const extra = (await call(app, 'POST', '/api/erp/products', b, { name: 'Xato mahsulot', kind: 'raw', unit: 'kg' })).body.id;
  assert.equal((await call(app, 'DELETE', `/api/erp/products/${extra}`, b)).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM products WHERE id = ?').get(extra).n, 0);
  // a variant product goes together with its variants
  const z = (await call(app, 'POST', '/api/erp/products', b, { name: 'Zakvaska', kind: 'raw', unit: 'g', hasVariants: true, variants: '499, 505' })).body.id;
  assert.equal((await call(app, 'DELETE', `/api/erp/products/${z}`, b)).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM products WHERE name LIKE 'Zakvaska%'").get().n, 0);
  // the storekeeper cannot delete
  assert.equal((await call(app, 'DELETE', `/api/erp/products/${idish}`, await store(app))).status, 403);
  void idish;
});
