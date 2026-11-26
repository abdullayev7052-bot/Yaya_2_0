import { test } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { setup, call, login, ali, boss, runShift } from './helpers.js';
import { roleIdByCode, ensureDeviceSlots } from '../src/db/index.js';
import { runChecks } from '../src/erp/watch.js';

// The whole chain on one database, on the stage model: milk collection → raw milk
// warehouse → production stage (cook, boiling loss) → pouring → incubator → cold
// room → capping → finished goods → returns → reprocessing → finance → reports.
// At the end the
// books must balance:
//
//   stock value now = what came in (opening, milk, purchases) + piece wages
//     + inventory surplus − losses booked as expenses
//     − goods charged to staff − cost variances
//
// i.e. no cost appears or disappears anywhere along the way.
test('whole chain: every step works together and the books balance', async () => {
  const { app, db, ids } = setup();
  const add = (loginName, code, name) => {
    const id = Number(db.prepare('INSERT INTO users (login, name, password_hash, role_id) VALUES (?, ?, ?, ?)')
      .run(loginName, name, bcrypt.hashSync('pass1234', 4), roleIdByCode(db, code)).lastInsertRowid);
    ensureDeviceSlots(db, id);
    return id;
  };
  const u = { tech: add('tech', 'technologist', 'Dilnoza'), pour: add('pour', 'pourer', 'Malika'), cap: add('cap', 'capper', 'Bobur'),
    rep: add('rep', 'reprocessor', 'Nodir'), keep: add('keep', 'storekeeper', 'Aziz') };
  const b = await boss(app);
  const L = (n) => login(app, n, 'pass1234');
  const T = { tech: await L('tech'), pour: await L('pour'), cap: await L('cap'), rep: await L('rep'), keep: await L('keep') };
  const ok = async (p, what) => { const r = await p; assert.ok(r.status === 200, `${what}: ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
  const post = (h, url, body, what) => ok(call(app, 'POST', url, h, body), what ?? url);

  // ---- master data
  const W = async (body) => (await post(b, '/api/erp/warehouses', body)).id;
  const raw = await W({ name: 'Xom sut ombori', kind: 'raw_milk', allowNegative: true, keepers: [u.keep, u.tech] });
  const pack = await W({ name: 'Idish ombori', kind: 'pack', keepers: [u.keep, u.pour] });
  // stages: who runs which
  const S = Object.fromEntries((await ok(call(app, 'GET', '/api/erp/prod/stages', b), 'stages')).map((x) => [x.code, x.id]));
  const runBy = { produce: [u.tech], pour: [u.pour], incubator: [u.pour], cold: [u.keep], cap: [u.cap], finished: [u.keep], returns: [u.keep], reprocess_bad: [u.rep] };
  for (const [code, list] of Object.entries(runBy)) await ok(call(app, 'PUT', `/api/erp/prod/stages/${S[code]}`, b, { keepers: list }), code);
  await ok(call(app, 'PUT', `/api/erp/prod/stages/${S.cap}`, b, { pieceRate: 90 }), 'cap rate');
  const fin = S.finished;
  await ok(call(app, 'PUT', '/api/erp/settings/milk-warehouse', b, { warehouseId: raw }), 'milk warehouse');
  const P = async (body) => (await post(b, '/api/erp/products', body)).id;
  const p = {
    siyro: await P({ name: '5% siyro', kind: 'semi', unit: 'kg' }),
    jar: await P({ name: 'V idish 400 g (qopqoq bilan)', kind: 'pack', unit: 'dona' }),
    qatiq: await P({ name: '5% qatiq 400 g', kind: 'finished', unit: 'dona', netto_g: 400, dwell_hours: 6 }),
    back: await P({ name: 'Vozvrat qatiq', kind: 'returned', unit: 'kg' }),
  };
  await ok(call(app, 'PUT', `/api/erp/prod/map/${p.qatiq}`, b, { stageIds: ['produce', 'pour', 'incubator', 'cold', 'cap', 'finished', 'returns', 'reprocess_bad'].map((c) => S[c]) }), 'map');

  // ---- 1. milk collection: 60 + 40 kg yog'li, 20 kg yog'siz → 120 kg "Xom sut"
  const a = await ali(app);
  await runShift(app, a, 'chain-1', [{ supplierId: 1, quantity: 60 }, { supplierId: 2, quantity: 40 }, { supplierId: 1, productId: 2, quantity: 20 }], { close: true });
  const shiftId = db.prepare("SELECT id FROM shifts WHERE client_uuid = 'chain-1'").get().id;
  await post(b, `/api/admin/shifts/${shiftId}/accept`, {}, 'accept shift');
  const milkId = Number(db.prepare("SELECT value FROM settings WHERE key = 'erp_milk_product'").get().value);
  assert.equal(db.prepare('SELECT ROUND(SUM(qty), 3) q FROM stock_moves WHERE product_id = ? AND warehouse_id = ?').get(milkId, raw).q, 120);

  // ---- 2. a vendor sells us jars (a jar and its lid as one pair; half paid)
  const main = db.prepare('SELECT id FROM cashboxes WHERE is_main = 1').get().id;
  await post(b, '/api/erp/finance/cash-openings', { cashboxId: main, amount: 1000000 });
  const v = (await post(b, '/api/erp/finance/vendors', { name: 'Plastik' })).id;
  await post(b, '/api/erp/finance/purchases', { vendorId: v, warehouseId: pack, lines: [{ productId: p.jar, qty: 300, price: 900 }], paid: 135000, cashboxId: main });

  // ---- 3. production stage: 118 kg milk (straight from "Sut ombori") → 115.64 kg quyma; at the
  // end the collector's shift (120 kg) is chosen as received milk: 2 kg boiled away
  const cook = await post(b, '/api/erp/prod/recipes', { name: '5% siyro', kind: 'cook', productId: p.siyro, outMin: 95, outMax: 101, lines: [{ productId: milkId, qty: 100 }] });
  const t1 = await post(T.tech, '/api/erp/prod/tasks', { recipeId: cook.id, milkQty: 118 });
  await post(T.tech, `/api/erp/prod/tasks/${t1.id}/complete`, { outputQty: 115.64 });
  const boil = db.prepare("SELECT id FROM stock_reasons WHERE section = 'tech' AND name = 'Qaynatishda'").get().id;
  const ts = (await ok(call(app, 'GET', '/api/erp/prod/shift', T.tech), 'my shift')).shift;
  await ok(call(app, 'PUT', `/api/erp/prod/shifts/${ts.id}/milk`, T.tech, { shiftIds: [shiftId] }), 'received milk');
  await post(T.tech, `/api/erp/prod/shifts/${ts.id}/close`, { losses: [{ reasonId: boil, qty: 2 }] }, 'close tech shift');

  // ---- 4. pouring 240 jars (0.4 kg + jar) by two people: the quyma from the production
  // stage and the jars from the jar warehouse are taken by themselves
  const pourR = await post(b, '/api/erp/prod/recipes', { name: 'quyish', kind: 'pour', productId: p.qatiq, lines: [{ productId: p.siyro, qty: 0.4 }, { productId: p.jar, qty: 1 }], rates: [{ name: 'Quyish', amount: 170 }] });
  const t2 = await post(T.pour, '/api/erp/prod/tasks', { recipeId: pourR.id, units: 240 });
  await post(T.pour, `/api/erp/prod/tasks/${t2.id}/complete`, { workers: [u.pour, u.cap] });
  // 19.64 kg of quyma left in the production stage: spilt, the technologist pays
  const spill = db.prepare("SELECT id FROM stock_reasons WHERE section = 'warehouse' AND charge = 'staff'").get().id;
  await post(T.tech, '/api/erp/docs', { type: 'writeoff', from: { warehouseId: S.produce }, reasonId: spill, chargeUserId: u.tech, lines: [{ productId: p.siyro, qty: 19.64 }] }, 'spill');

  // ---- 5. incubator → cold room → capping (90 per jar) → finished goods
  await post(T.pour, '/api/erp/prod/moves', { stageId: S.incubator, productId: p.qatiq, qty: 240 }, 'incubator');
  await post(T.keep, '/api/erp/prod/moves', { stageId: S.cold, productId: p.qatiq, qty: 240 }, 'cold room');
  await post(T.cap, '/api/erp/prod/moves', { stageId: S.cap, productId: p.qatiq, qty: 240 }, 'capping');
  await post(T.keep, '/api/erp/prod/moves', { stageId: S.finished, productId: p.qatiq, qty: 240 }, 'finished');

  // ---- 6. 10 jars went past their date: into the returns stage
  await post(T.keep, '/api/erp/prod/moves', { stageId: S.returns, productId: p.qatiq, qty: 10 }, 'returns');
  assert.equal(db.prepare('SELECT ROUND(SUM(qty), 3) q FROM stock_moves WHERE product_id = ? AND warehouse_id = ?').get(p.qatiq, S.returns).q, 10);

  // ---- 7. reprocessing the 10 expired jars: 9 jars back, 1 broken; 4 kg of content
  const repR = await post(b, '/api/erp/prod/recipes', { name: 'qayta', kind: 'reprocess', productId: p.qatiq,
    outputs: [{ productId: p.jar, perUnit: 1, costValue: 800, isContainer: true }, { productId: p.back, minPerUnit: 0.37, maxPerUnit: 0.45, costValue: 0 }] });
  const t4 = await post(T.rep, '/api/erp/prod/tasks', { recipeId: repR.id, units: 10 });
  const broken = db.prepare("SELECT id FROM stock_reasons WHERE section = 'reprocess' AND name = 'Singan'").get().id;
  await post(T.rep, `/api/erp/prod/tasks/${t4.id}/complete`, { outputs: [{ productId: p.jar, qty: 9 }], shortfall: [{ reasonId: broken, qty: 1 }] });

  // ---- 8. a stock count in the finished warehouse finds 2 jars missing; the keeper pays
  const inv = await post(b, '/api/erp/docs', { type: 'inventory', to: { warehouseId: fin }, lines: [{ productId: p.qatiq, qty: 228 }] }, 'count');
  await post(b, `/api/erp/docs/${inv.id}/post`, { charges: [{ userId: u.keep, amount: 1000 }] }, 'post count');

  // ---- 9. payroll and an expense
  const otherExp = db.prepare("SELECT id FROM pnl_categories WHERE code = 'other_expense'").get().id;
  await post(b, '/api/erp/finance/expenses', { cashboxId: main, categoryId: otherExp, amount: 300000, note: 'Elektr' });
  await post(b, '/api/erp/finance/staff-payments', { userId: u.pour, cashboxId: main, amount: 20400 });

  // ================================================================ the books balance
  const one = (sql, ...args) => db.prepare(sql).get(...args).v ?? 0;
  const stockValue = one('SELECT ROUND(SUM(cost), 2) v FROM stock_moves');
  const came = one(`SELECT ROUND(SUM(m.cost), 2) v FROM stock_moves m JOIN docs d ON d.id = m.doc_id
    WHERE d.type IN ('opening','milk_in','purchase') AND d.status = 'posted' AND m.qty > 0`);
  const wages = -one("SELECT ROUND(SUM(amount), 2) v FROM party_entries WHERE party_type = 'staff' AND kind = 'piece'");
  const pnl = (code) => one('SELECT ROUND(SUM(e.amount), 2) v FROM pnl_entries e JOIN pnl_categories c ON c.id = e.category_id WHERE c.code = ?', code);
  const losses = ['stock_loss', 'writeoff', 'production_loss', 'reprocess_loss', 'container_loss'].reduce((s0, c) => s0 + pnl(c), 0);
  const staffGoods = one("SELECT ROUND(SUM(amount), 2) v FROM party_entries WHERE party_type = 'staff' AND kind IN ('writeoff','inventory','production','reprocess')");
  const expected = came + wages + pnl('stock_surplus') - losses - staffGoods - pnl('cost_variance');
  assert.ok(Math.abs(stockValue - expected) < 1, `stock ${stockValue} vs books ${expected}`);

  // no place is below zero where that is not allowed
  const negatives = db.prepare(`SELECT m.warehouse_id, m.holder_id, m.product_id, SUM(m.qty) q FROM stock_moves m LEFT JOIN warehouses w ON w.id = m.warehouse_id
    GROUP BY m.warehouse_id, m.holder_id, m.product_id HAVING SUM(m.qty) < -0.0005 AND COALESCE(w.allow_negative, 0) = 0`).all();
  assert.deepEqual(negatives, []);
  // money: cashbox = opening − vendor payment − expense − payout
  assert.equal(one('SELECT ROUND(SUM(amount), 2) v FROM cash_entries WHERE cashbox_id = ?', main), 1000000 - 135000 - 300000 - 20400);

  // ================================================================ reports agree with the documents
  const today = new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);
  const rep = (k) => ok(call(app, 'GET', `/api/erp/reports/${k}?from=2026-01-01&to=${today}`, b), k);
  const mv = await rep('stock_movement');
  assert.ok(Math.abs(mv.totals.close_value - stockValue) < 1, 'closing stock value = ledger');
  const pl = await ok(call(app, 'GET', `/api/erp/finance/pnl?from=2026-01-01&to=${today}`, b), 'pnl');
  assert.ok(pl.expense > 0);
  const workers = (await rep('production_by_worker')).rows;
  // 240 × 170 shared by two, 240 × 90 to the capper
  assert.equal(workers.find((w) => w.worker === 'Malika').wages, 20400);
  assert.equal(workers.find((w) => w.worker === 'Bobur').wages, 20400 + 21600);

  // ================================================================ no costs reach ordinary staff
  // Every screen a worker can open, after a full day of real data: none may carry a
  // cost, value or profit field.
  const FORBIDDEN = new Set(['cost', 'unit_cost', 'total_cost', 'cogs', 'profit', 'margin', 'open_value', 'close_value', 'loss', 'surplus', 'spread', 'spread_cost', 'value']);
  const found = [];
  const scan = (v, path) => {
    if (Array.isArray(v)) v.forEach((x, i) => scan(x, `${path}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (FORBIDDEN.has(k) && x != null) found.push(`${path}.${k}`); scan(x, `${path}.${k}`); }
  };
  const docIds = db.prepare('SELECT id FROM docs').all().map((r) => r.id);
  const taskIds = db.prepare('SELECT id FROM prod_tasks').all().map((r) => r.id);
  const shiftIds = db.prepare('SELECT id FROM prod_shifts').all().map((r) => r.id);
  const urls = [
    '/api/erp/meta', '/api/erp/stock/mine', '/api/erp/docs', '/api/erp/inbox', '/api/erp/products', '/api/erp/warehouses', '/api/erp/reasons', '/api/erp/overview', '/api/erp/alerts/mine',
    `/api/erp/stock?warehouseId=${fin}`, `/api/erp/stock/lots?warehouseId=${fin}&productId=${p.qatiq}`,
    '/api/erp/prod/shift', '/api/erp/prod/shifts', '/api/erp/prod/recipes', '/api/erp/prod/recipes?mine=1',
    '/api/erp/prod/board', '/api/erp/prod/stages', '/api/erp/prod/journal', `/api/erp/prod/map/${p.qatiq}`,
    ...docIds.map((id) => `/api/erp/docs/${id}`), ...taskIds.map((id) => `/api/erp/prod/tasks/${id}`), ...shiftIds.map((id) => `/api/erp/prod/shifts/${id}`),
    ...['production_by_product', 'stock_movement', 'losses', 'expiry'].map((k) => `/api/erp/reports/${k}?from=2026-01-01&to=${today}`),
  ];
  for (const [who, h] of Object.entries(T)) {
    for (const url of urls) {
      const r = await call(app, 'GET', url, h);
      if (r.status === 200 && typeof r.body === 'object') scan(r.body, `${who} ${url}`);
    }
  }
  assert.deepEqual(found, [], `cost fields reached staff: ${found.slice(0, 20).join(' | ')}`);

  // ================================================================ backup: export, clear history, restore
  const { snapshot, restore, wipeHistory, encrypt, decrypt } = await import('../src/backup.js');
  const counts = () => Object.fromEntries(['docs', 'stock_moves', 'lots', 'lot_sources', 'party_entries', 'cash_entries', 'pnl_entries', 'prod_tasks', 'prod_shifts',
    'recipes', 'customers', 'vendors', 'kiosks', 'product_prices', 'cashboxes'].map((t) => [t, db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n]));
  const before = counts();
  const file = encrypt(snapshot(db), 'zaxira-parol');
  wipeHistory(db);
  const wiped = counts();
  assert.equal(wiped.docs + wiped.stock_moves + wiped.cash_entries + wiped.prod_tasks, 0, 'history cleared');
  assert.equal(wiped.recipes, before.recipes, 'recipes are kept');
  restore(db, decrypt(file, 'zaxira-parol'));
  assert.deepEqual(counts(), before, 'everything back from the backup');
  assert.ok(Math.abs(one('SELECT ROUND(SUM(cost), 2) v FROM stock_moves') - stockValue) < 0.01);
});
