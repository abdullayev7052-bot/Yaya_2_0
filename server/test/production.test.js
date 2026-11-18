import { test } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { setup, call, login, boss } from './helpers.js';
import { roleIdByCode, ensureDeviceSlots } from '../src/db/index.js';

// A dairy with raw milk, cream, a starter, a technologist and a pourer.
async function plant() {
  const { app, db, ids } = setup();
  const add = (loginName, code, name) => {
    const id = Number(db.prepare('INSERT INTO users (login, name, password_hash, role_id) VALUES (?, ?, ?, ?)')
      .run(loginName, name, bcrypt.hashSync('pass1234', 4), roleIdByCode(db, code)).lastInsertRowid);
    ensureDeviceSlots(db, id);
    return id;
  };
  ids.tech = add('tech', 'technologist', 'Texnolog Dilnoza');
  ids.pour = add('pour', 'technologist', 'Quyuvchi Malika');
  const b = await boss(app);
  const t = await login(app, 'tech', 'pass1234');
  const P = async (body) => (await call(app, 'POST', '/api/erp/products', b, body)).body.id;
  const raw = (await call(app, 'POST', '/api/erp/warehouses', b, { name: 'Xom sut ombori', kind: 'raw_milk', allowNegative: true })).body.id;
  const store = (await call(app, 'POST', '/api/erp/warehouses', b, { name: 'Xomashyo ombori', kind: 'raw' })).body.id;
  const p = {
    milk: await P({ name: 'Xom sut', kind: 'raw_milk', unit: 'kg' }),
    cream: await P({ name: 'Toza qaymoq', kind: 'raw', unit: 'kg' }),
    starter: await P({ name: 'Zakvaska Donetsk 505', kind: 'raw', unit: 'g' }),
    starter2: await P({ name: 'Zakvaska Chr Hansen', kind: 'raw', unit: 'g' }),
    siyro: await P({ name: '5% siyro', kind: 'semi', unit: 'kg' }),
    sepCream: await P({ name: 'Qaymoq (separatsiya)', kind: 'raw', unit: 'kg' }),
    skim: await P({ name: "Yog'siz sut (separatsiya)", kind: 'raw', unit: 'kg' }),
  };
  await call(app, 'POST', '/api/erp/docs', b, { type: 'opening', to: { warehouseId: raw }, lines: [{ productId: p.milk, qty: 1000, unitCost: 5000 }] });
  await call(app, 'POST', '/api/erp/docs', b, { type: 'opening', to: { warehouseId: store }, lines: [
    { productId: p.cream, qty: 20, unitCost: 40000 }, { productId: p.starter, qty: 100, unitCost: 50 }, { productId: p.starter2, qty: 100, unitCost: 80 }] });
  // the 5% recipe: 320 kg milk + 6 kg cream + 4.2 g starter (alternative: Chr Hansen), output 320–335 kg
  const r5 = (await call(app, 'POST', '/api/erp/prod/recipes', b, {
    name: '5% siyro', kind: 'cook', productId: p.siyro, outMin: 320, outMax: 335,
    lines: [{ productId: p.milk, qty: 320 }, { productId: p.cream, qty: 6 }, { productId: p.starter, qty: 4.2, alts: [{ productId: p.starter2 }] }],
  })).body;
  const sep = (await call(app, 'POST', '/api/erp/prod/recipes', b, {
    name: 'Separatsiya', kind: 'separation', lines: [{ productId: p.milk, qty: 1000 }],
    outputs: [{ productId: p.sepCream, costMode: 'fixed', costValue: 42000 }, { productId: p.skim, costMode: 'rest' }],
  })).body;
  // milk and materials are handed to the technologist, who accepts them
  const give = async (from, lines) => {
    const d = (await call(app, 'POST', '/api/erp/docs', b, { type: 'transfer', from: { warehouseId: from }, to: { userId: ids.tech }, lines })).body;
    assert.equal((await call(app, 'POST', `/api/erp/docs/${d.id}/accept`, t, {})).status, 200);
  };
  await give(raw, [{ productId: p.milk, qty: 1000 }]);
  await give(store, [{ productId: p.cream, qty: 20 }, { productId: p.starter, qty: 100 }, { productId: p.starter2, qty: 100 }]);
  return { app, db, ids, b, t, p, raw, store, r5, sep };
}

const lotCost = (db, productId) => db.prepare('SELECT ROUND(SUM(cost), 2) c, ROUND(SUM(qty), 3) q FROM stock_moves WHERE product_id = ?').get(productId);

test('recipe: base weight and milk; limits scale with the batch (326.0042 kg → 320–335; half → 160–167.5)', async () => {
  const { r5, sep } = await plant();
  assert.equal(r5.base_weight, 326.004);
  assert.equal(r5.base_milk, 320);
  assert.equal(r5.lines[2].alts.length, 1);
  assert.equal(sep.outputs.length, 2);
});

test('technologist shift: tasks from recipes, approval over the limit, separation, and the end-of-shift milk spread over the outputs', async () => {
  const { app, db, ids, b, t, p, raw, r5, sep } = await plant();
  // no task without a shift
  assert.equal((await call(app, 'POST', '/api/erp/prod/tasks', t, { recipeId: r5.id, milkQty: 160 })).status, 400);
  const shift = (await call(app, 'POST', '/api/erp/prod/shift', t, { uuid: 'ps-1' })).body.shift;
  assert.equal(shift.status, 'open');
  assert.equal((await call(app, 'POST', '/api/erp/prod/shift', t, { uuid: 'ps-2' })).status, 400, 'one open shift per person');

  // 1) half a batch, starter swapped for its alternative
  const t1 = (await call(app, 'POST', '/api/erp/prod/tasks', t, { uuid: 'tq-1', recipeId: r5.id, milkQty: 160, lines: [{ lineId: r5.lines[2].id, productId: p.starter2 }] })).body;
  assert.deepEqual(t1.plan.map((l) => l.qty), [160, 3, 2.1]);
  assert.equal(t1.plan[2].productId, p.starter2);
  // only a recipe alternative may replace a line
  assert.equal((await call(app, 'POST', '/api/erp/prod/tasks', t, { recipeId: r5.id, milkQty: 160, lines: [{ lineId: r5.lines[1].id, productId: p.skim }] })).status, 400);
  const done1 = await call(app, 'POST', `/api/erp/prod/tasks/${t1.id}/complete`, t, { outputQty: 163 });
  assert.equal(done1.status, 200);
  assert.equal(done1.body.task.status, 'done');
  assert.equal(done1.body.task.outputs[0].cost, undefined, 'the technologist never sees costs');
  const costT1 = 160 * 5000 + 3 * 40000 + 2.1 * 80;
  assert.equal((await call(app, 'GET', `/api/erp/prod/tasks/${t1.id}`, b)).body.outputs[0].cost, costT1);
  assert.equal((await call(app, 'GET', `/api/erp/prod/tasks/${t1.id}`, b)).body.outputs[0].provisional, true, 'cost is provisional until the shift closes');

  // 2) a full batch weighed at 340 kg: over 335 → waits for the manager
  const t2 = (await call(app, 'POST', '/api/erp/prod/tasks', t, { uuid: 'tq-2', recipeId: r5.id, milkQty: 320 })).body;
  const over = await call(app, 'POST', `/api/erp/prod/tasks/${t2.id}/complete`, t, { outputQty: 340 });
  assert.equal(over.body.needApproval, true);
  assert.deepEqual([over.body.range.min, over.body.range.max], [320, 335]);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM alerts WHERE type = 'prod.limit' AND resolved_at IS NULL").get().n, 1);
  assert.equal((await call(app, 'GET', '/api/erp/prod/approvals', b)).body.tasks.length, 1);
  assert.equal((await call(app, 'POST', `/api/erp/prod/tasks/${t2.id}/approve`, t, {})).status, 403, 'the technologist cannot approve');
  assert.equal((await call(app, 'POST', `/api/erp/prod/tasks/${t2.id}/approve`, b, { note: 'Tekshirildi' })).body.task.status, 'done');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM alerts WHERE type = 'prod.limit' AND resolved_at IS NULL").get().n, 0);

  // 3) separation of 400 kg: cream at a fixed 42 000/kg, the rest to skim milk
  const t3 = (await call(app, 'POST', '/api/erp/prod/tasks', t, { uuid: 'tq-3', recipeId: sep.id, milkQty: 400 })).body;
  const d3 = (await call(app, 'POST', `/api/erp/prod/tasks/${t3.id}/complete`, t, { outputs: [{ productId: p.sepCream, qty: 28 }, { productId: p.skim, qty: 372 }] })).body;
  const sepDetail = (await call(app, 'GET', `/api/erp/prod/tasks/${t3.id}`, b)).body;
  assert.equal(sepDetail.outputs.find((o) => o.product_id === p.sepCream).cost, 28 * 42000);
  assert.equal(sepDetail.outputs.find((o) => o.product_id === p.skim).cost, 400 * 5000 - 28 * 42000);
  assert.equal(d3.task.status, 'done');

  // part of batch 1 already moves on to the pourer before the shift is closed
  const h = (await call(app, 'POST', '/api/erp/docs', t, { type: 'transfer', from: { userId: ids.tech }, to: { userId: ids.pour }, lines: [{ productId: p.siyro, qty: 63 }] })).body;
  assert.equal((await call(app, 'POST', `/api/erp/docs/${h.id}/accept`, await login(app, 'pour', 'pass1234'), {})).status, 200);

  // close: 1000 received, 880 used → 120 kg to explain
  const sh = (await call(app, 'GET', '/api/erp/prod/shift', t)).body.shift;
  assert.equal(sh.milk.in_hands, 120);
  assert.equal(sh.milk.used, 880);
  const unexplained = await call(app, 'POST', `/api/erp/prod/shifts/${sh.id}/close`, t, { returned: 20, returnTo: raw, losses: [] });
  assert.equal(unexplained.status, 400);
  assert.equal(unexplained.body.details.unexplained, 100);
  // boiling 90 kg: the limit is 100 per 1000 kg used → 88 kg for 880 → manager approval
  const reasons = (await call(app, 'GET', '/api/erp/reasons?section=tech', b)).body;
  const boil = reasons.find((r) => r.name === 'Qaynatishda').id;
  const spilt = reasons.find((r) => r.name === "To'kildi").id;
  const closing = await call(app, 'POST', `/api/erp/prod/shifts/${sh.id}/close`, t, { returned: 20, returnTo: raw, losses: [{ reasonId: boil, qty: 90 }, { reasonId: spilt, qty: 10 }] });
  assert.equal(closing.body.needApproval, true);
  assert.deepEqual(closing.body.over.map((o) => o.allowed), [88]);
  const closed = await call(app, 'POST', `/api/erp/prod/shifts/${sh.id}/approve`, b, { note: 'Qozon eski' });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.shift.status, 'closed');

  // the boiling loss (90 × 5000 = 450 000) is spread by milk used: 160 / 320 / 400 of 880
  const boilCost = 450000;
  const siyro = lotCost(db, p.siyro);
  const t2cost = 320 * 5000 + 6 * 40000 + 4.2 * 50;
  assert.ok(Math.abs(siyro.c - (costT1 + t2cost + boilCost * (480 / 880))) < 0.05, `siyro ${siyro.c}`);
  // the part already with the pourer took its share too
  const pourCost = db.prepare('SELECT ROUND(SUM(cost), 2) c FROM stock_moves WHERE product_id = ? AND holder_id = ?').get(p.siyro, ids.pour).c;
  const t1lotShare = (boilCost * 160) / 880;
  assert.ok(Math.abs(pourCost - ((costT1 + t1lotShare) * 63) / 163) < 0.05, `pourer ${pourCost}`);
  // separation: cream keeps 42 000/kg, skim milk takes the share
  assert.equal(lotCost(db, p.sepCream).c, 28 * 42000);
  assert.ok(Math.abs(lotCost(db, p.skim).c - (400 * 5000 - 28 * 42000 + (boilCost * 400) / 880)) < 0.05);
  // spilt milk is an expense, not a batch cost
  const loss = db.prepare("SELECT ROUND(SUM(e.amount), 2) a FROM pnl_entries e JOIN pnl_categories c ON c.id = e.category_id WHERE c.code = 'production_loss'").get().a;
  assert.equal(loss, 50000);
  // costs are final now; the 20 kg left waits for the raw-milk keeper as a hand-over
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lots WHERE provisional = 1').get().n, 0);
  const ret = db.prepare("SELECT * FROM docs WHERE type = 'transfer' AND status = 'sent'").get();
  assert.equal(ret.to_wh, raw);
  assert.equal(db.prepare('SELECT qty FROM doc_lines WHERE doc_id = ?').get(ret.id).qty, 20);
  // nothing can be added to a closed shift
  assert.equal((await call(app, 'POST', '/api/erp/prod/tasks', t, { recipeId: r5.id, milkQty: 10 })).status, 400);
});

test('a gain (more milk left than the books say) lowers the batch cost; a finished task can be cancelled while the shift is open', async () => {
  const { app, db, t, p, raw, r5 } = await plant();
  await call(app, 'POST', '/api/erp/prod/shift', t, {});
  const a = (await call(app, 'POST', '/api/erp/prod/tasks', t, { recipeId: r5.id, milkQty: 320 })).body;
  await call(app, 'POST', `/api/erp/prod/tasks/${a.id}/complete`, t, { outputQty: 326 });
  const c = (await call(app, 'POST', '/api/erp/prod/tasks', t, { recipeId: r5.id, milkQty: 160 })).body;
  await call(app, 'POST', `/api/erp/prod/tasks/${c.id}/complete`, t, { outputQty: 163 });
  // the second batch was a mistake: cancelling gives the milk back
  assert.equal((await call(app, 'POST', `/api/erp/prod/tasks/${c.id}/cancel`, t, {})).status, 400, 'reason required');
  assert.equal((await call(app, 'POST', `/api/erp/prod/tasks/${c.id}/cancel`, t, { reason: 'Xato kiritildi' })).body.status, 'cancelled');
  const sh = (await call(app, 'GET', '/api/erp/prod/shift', t)).body.shift;
  assert.equal(sh.milk.in_hands, 680);
  assert.equal(sh.milk.used, 320);
  const before = lotCost(db, p.siyro).c;
  // 690 kg actually left (10 kg more than the books): a gain at the shift's milk cost
  const r = await call(app, 'POST', `/api/erp/prod/shifts/${sh.id}/close`, t, { returned: 690, returnTo: raw, losses: [] });
  assert.equal(r.status, 200);
  assert.equal(r.body.shift.status, 'closed');
  assert.equal(lotCost(db, p.siyro).c, before - 10 * 5000);
});

test('overview: one page over the whole chain, each block only with its permission', async () => {
  const { app, b, t, r5 } = await plant();
  await call(app, 'POST', '/api/erp/prod/shift', t, {});
  const a = (await call(app, 'POST', '/api/erp/prod/tasks', t, { recipeId: r5.id, milkQty: 320 })).body;
  await call(app, 'POST', `/api/erp/prod/tasks/${a.id}/complete`, t, { outputQty: 326 });
  const o = (await call(app, 'GET', '/api/erp/overview', b)).body;
  assert.ok(o.milk && o.stock && o.production && o.alerts && Array.isArray(o.pnl));
  assert.equal(o.production.tasks_done, 1);
  assert.equal(o.production.milk_used, 320);
  assert.equal(o.production.open_shifts, 1);
  assert.equal(o.stock.raw_milk, 680);
  assert.ok(o.stock.value > 0);
  const mine = (await call(app, 'GET', '/api/erp/overview', t)).body;
  assert.deepEqual(Object.keys(mine), ['day'], 'a technologist sees none of it');
});
