import { test } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { setup, call, login, boss } from './helpers.js';
import { roleIdByCode, ensureDeviceSlots } from '../src/db/index.js';
import { runChecks } from '../src/erp/watch.js';
import { moveHandsToStages } from '../src/erp/stages.js';
import { addIn, getDoc } from '../src/erp/stock.js';

// A plant on the stage model (stage 10): stages are warehouses run by their keepers;
// every action takes from the previous stage on the product's map.
async function plant() {
  const { app, db, ids } = setup();
  const add = (loginName, code, name) => {
    const id = Number(db.prepare('INSERT INTO users (login, name, password_hash, role_id) VALUES (?, ?, ?, ?)')
      .run(loginName, name, bcrypt.hashSync('pass1234', 4), roleIdByCode(db, code)).lastInsertRowid);
    ensureDeviceSlots(db, id);
    return id;
  };
  const u = { tech: add('tech', 'technologist', 'Dilnoza'), pour1: add('pour1', 'pourer', 'Malika'), pour2: add('pour2', 'pourer', 'Gulnora'),
    cap: add('cap', 'capper', 'Bobur'), keep: add('keep', 'storekeeper', 'Aziz'), rep: add('rep', 'reprocessor', 'Nodir') };
  const b = await boss(app);
  const L = (n) => login(app, n, 'pass1234');
  const T = { tech: await L('tech'), pour1: await L('pour1'), pour2: await L('pour2'), cap: await L('cap'), keep: await L('keep'), rep: await L('rep') };
  const ok = async (p, what) => { const r = await p; assert.ok(r.status === 200, `${what}: ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
  const post = (h, url, body, what) => ok(call(app, 'POST', url, h, body), what ?? url);
  const W = async (body) => (await post(b, '/api/erp/warehouses', body)).id;
  const wh = {
    raw: await W({ name: 'Xom sut ombori', kind: 'raw_milk', keepers: [u.tech] }),
    store: await W({ name: 'Xomashyo ombori', kind: 'raw', keepers: [u.tech, u.keep] }),
    pack: await W({ name: 'Idish ombori', kind: 'pack', keepers: [u.pour1, u.pour2, u.keep] }),
  };
  await ok(call(app, 'PUT', '/api/erp/settings/milk-warehouse', b, { warehouseId: wh.raw }), 'milk warehouse');
  const stages = (await ok(call(app, 'GET', '/api/erp/prod/stages', b), 'stages'));
  const S = Object.fromEntries(stages.map((s) => [s.code, s.id]));
  const keepers = { produce: [u.tech], pour: [u.pour1, u.pour2], incubator: [u.pour1, u.pour2], cold: [u.keep], cap: [u.cap], finished: [u.keep], returns: [u.keep], reprocess_bad: [u.rep], pack: [u.keep] };
  for (const [code, list] of Object.entries(keepers)) await ok(call(app, 'PUT', `/api/erp/prod/stages/${S[code]}`, b, { keepers: list }), `keepers ${code}`);
  await ok(call(app, 'PUT', `/api/erp/prod/stages/${S.cap}`, b, { pieceRate: 90 }), 'cap rate');
  const P = async (body) => (await post(b, '/api/erp/products', body)).id;
  const p = {
    milk: await P({ name: 'Xom sut', kind: 'raw_milk', unit: 'kg' }),
    cream: await P({ name: 'Toza qaymoq', kind: 'raw', unit: 'kg' }),
    starter: await P({ name: 'Zakvaska', kind: 'raw', unit: 'g', hasVariants: true, variants: '499, 505' }),
    siyro: await P({ name: '5% siyro', kind: 'semi', unit: 'kg' }),
    tvorog: await P({ name: 'Tvorog quyma', kind: 'semi', unit: 'kg' }),
    jar: await P({ name: 'V idish 400 g', kind: 'pack', unit: 'dona' }),
    qatiq: await P({ name: '5% qatiq 400 g', kind: 'finished', unit: 'dona', netto_g: 400 }),
    back: await P({ name: 'Vozvrat qatiq', kind: 'returned', unit: 'kg' }),
    sepCream: await P({ name: 'Qaymoq (separatsiya)', kind: 'raw', unit: 'kg' }),
    skim: await P({ name: "Yog'siz sut (separatsiya)", kind: 'raw', unit: 'kg' }),
  };
  const v = Object.fromEntries(db.prepare('SELECT variant, id FROM products WHERE parent_id = ?').all(p.starter).map((x) => [x.variant, x.id]));
  await post(b, '/api/erp/docs', { type: 'opening', to: { warehouseId: wh.raw }, lines: [{ productId: p.milk, qty: 1000, unitCost: 5000 }] });
  await post(b, '/api/erp/docs', { type: 'opening', to: { warehouseId: wh.store }, lines: [
    { productId: p.cream, qty: 20, unitCost: 40000 }, { productId: v['499'], qty: 100, unitCost: 50 }, { productId: v['505'], qty: 100, unitCost: 80 }] });
  await post(b, '/api/erp/docs', { type: 'opening', to: { warehouseId: wh.pack }, lines: [{ productId: p.jar, qty: 500, unitCost: 800 }] });
  const R = async (body) => post(b, '/api/erp/prod/recipes', body);
  const r = {
    r5: await R({ name: '5% siyro', kind: 'cook', productId: p.siyro, outMin: 320, outMax: 335,
      lines: [{ productId: p.milk, qty: 320 }, { productId: p.cream, qty: 6 }, { productId: p.starter, qty: 4.2 }] }),
    tv: await R({ name: 'Tvorog', kind: 'cook', productId: p.tvorog, lines: [{ productId: p.skim, qty: 50 }, { productId: p.starter, qty: 1 }] }),
    sep: await R({ name: 'Separatsiya', kind: 'separation', lines: [{ productId: p.milk, qty: 1000 }],
      outputs: [{ productId: p.sepCream, costMode: 'fixed', costValue: 42000 }, { productId: p.skim, costMode: 'rest' }] }),
    pour: await R({ name: 'Quyish 400 g', kind: 'pour', productId: p.qatiq, lines: [{ productId: p.siyro, qty: 0.4 }, { productId: p.jar, qty: 1 }], rates: [{ name: 'Quyish', amount: 170 }] }),
    rep: await R({ name: 'Qayta ishlash', kind: 'reprocess', productId: p.qatiq,
      outputs: [{ productId: p.jar, perUnit: 1, costValue: 800, isContainer: true }, { productId: p.back, minPerUnit: 0.37, maxPerUnit: 0.45, costValue: 0 }] }),
  };
  // Tex karta: production makes its quyma with r5, pouring uses the pour recipe, reprocessing the rep recipe
  const recipeOf = { produce: r.r5.id, pour: r.pour.id, reprocess_bad: r.rep.id };
  await ok(call(app, 'PUT', `/api/erp/prod/map/${p.qatiq}`, b, { stages: ['produce', 'pour', 'incubator', 'cold', 'cap', 'finished', 'returns', 'reprocess_bad'].map((c) => ({ stageId: S[c], recipeId: recipeOf[c] ?? null })) }), 'tex karta');
  const reasons = (await ok(call(app, 'GET', '/api/erp/reasons?section=tech', b), 'reasons'));
  return { app, db, ids, u, b, T, ok, post, wh, S, p, v, r, reasons };
}
const bal = (db, whId, productId) => db.prepare('SELECT COALESCE(ROUND(SUM(qty), 3), 0) q, COALESCE(ROUND(SUM(cost), 2), 0) c FROM stock_moves WHERE warehouse_id = ? AND product_id = ?').get(whId, productId);
const pnl = (db, code) => db.prepare('SELECT COALESCE(ROUND(SUM(e.amount), 2), 0) a FROM pnl_entries e JOIN pnl_categories c ON c.id = e.category_id WHERE c.code = ?').get(code).a;
const near = (a, b, what, eps = 0.05) => assert.ok(Math.abs(a - b) < eps, `${what}: ${a} vs ${b}`);

test('stages: ten stages in order, stages are warehouses, maps decide the previous stage, a new stage can be placed between two', async () => {
  const { app, db, b, S, p, ok } = await plant();
  const stages = (await call(app, 'GET', '/api/erp/prod/stages', b)).body;
  assert.deepEqual(stages.map((s) => s.code), ['produce', 'pour', 'pack', 'incubator', 'cold', 'cap', 'finished', 'returns', 'reprocess_ok', 'reprocess_bad']);
  assert.equal(stages.find((s) => s.code === 'cap').piece_rate, 90);
  assert.ok((await call(app, 'GET', '/api/erp/warehouses', b)).body.filter((w) => w.is_stage).every((w) => w.kind_label === 'Bosqich'));
  // a new 'keep' stage between the incubator and the cold room
  const st = await ok(call(app, 'POST', '/api/erp/prod/stages', b, { name: 'Sovutish tunneli', type: 'keep', after: S.incubator }), 'new stage');
  const order = (await call(app, 'GET', '/api/erp/prod/stages', b)).body.map((s) => s.name);
  assert.deepEqual(order.slice(3, 6), ['Issiqxona', 'Sovutish tunneli', 'Sovuqxona']);
  // maps: the stage before the cold room is the incubator; with the incubator off, pouring
  const map = (await call(app, 'GET', `/api/erp/prod/map/${p.qatiq}`, b)).body.map((s) => s.code);
  assert.deepEqual(map, ['produce', 'pour', 'incubator', 'cold', 'cap', 'finished', 'returns', 'reprocess_bad']);
  const { prevStage } = await import('../src/erp/stages.js');
  assert.equal(prevStage(db, p.qatiq, S.cold), S.incubator);
  await call(app, 'PUT', `/api/erp/prod/map/${p.qatiq}`, b, { stageIds: [S.produce, S.pour, S.cold, S.cap, S.finished] });
  assert.equal(prevStage(db, p.qatiq, S.cold), S.pour, 'a stage that is off is skipped');
  // a 'keep' stage has no recipe
  assert.equal((await call(app, 'POST', '/api/erp/prod/recipes', b, { name: 'x', kind: 'cook', productId: p.siyro, stageId: st.id, lines: [{ productId: p.milk, qty: 1 }] })).status, 400);
});

test('one product, one recipe per stage; variants are their own products; a parent holds no stock', async () => {
  const { app, db, b, p, v } = await plant();
  const dup = await call(app, 'POST', '/api/erp/prod/recipes', b, { name: 'boshqa 5%', kind: 'cook', productId: p.siyro, lines: [{ productId: p.milk, qty: 100 }] });
  assert.equal(dup.status, 400);
  assert.match(dup.body.error, /bitta mahsulotga bitta tarkib/);
  // variants
  assert.deepEqual(db.prepare('SELECT name FROM products WHERE parent_id = ? ORDER BY id').all(p.starter).map((x) => x.name), ['Zakvaska / 499', 'Zakvaska / 505']);
  assert.equal(db.prepare('SELECT unit FROM products WHERE id = ?').get(v['499']).unit, 'g', 'the parent\'s unit');
  const parentIn = await call(app, 'POST', '/api/erp/docs', b, { type: 'opening', to: { warehouseId: db.prepare("SELECT id FROM warehouses WHERE kind = 'raw'").get().id }, lines: [{ productId: p.starter, qty: 1, unitCost: 1 }] });
  assert.equal(parentIn.status, 400);
  assert.match(parentIn.body.error, /variantini tanlang/);
  await call(app, 'POST', `/api/erp/products/${p.starter}/variants`, b, { variants: ['510'] });
  await call(app, 'PATCH', `/api/erp/products/${p.starter}`, b, { name: 'Zakvaska DVS' });
  assert.deepEqual(db.prepare('SELECT name FROM products WHERE parent_id = ? ORDER BY id').all(p.starter).map((x) => x.name), ['Zakvaska DVS / 499', 'Zakvaska DVS / 505', 'Zakvaska DVS / 510']);
  // variant-based is chosen at creation only
  assert.equal((await call(app, 'POST', `/api/erp/products/${p.cream}/variants`, b, { variants: ['a'] })).status, 400);
  assert.equal((await call(app, 'POST', '/api/erp/prod/recipes', b, { name: 'x', kind: 'cook', productId: p.starter, lines: [{ productId: p.milk, qty: 1 }] })).status, 400, 'a parent is not an output');
});

test('technologist: tasks at the production stage straight from the warehouses; variant chosen; limit approval; separation at the end settles skim milk used during the shift at its real cost', async () => {
  const { app, db, u, b, T, ok, post, wh, S, p, v, r, reasons } = await plant();
  // the pourer does not run the production stage
  assert.equal((await call(app, 'POST', '/api/erp/prod/tasks', T.pour1, { recipeId: r.r5.id, milkQty: 320 })).status, 403);
  // 1) a full batch; "Zakvaska" → variant 505 chosen in the app
  const t1 = await post(T.tech, '/api/erp/prod/tasks', { recipeId: r.r5.id, milkQty: 320, lines: [{ lineId: r.r5.lines[2].id, productId: v['505'] }] });
  assert.ok(t1.shift_id, 'the shift opened by itself');
  const d1 = await post(T.tech, `/api/erp/prod/tasks/${t1.id}/complete`, { outputQty: 326 });
  assert.equal(d1.task.status, 'done');
  assert.equal(d1.task.outputs[0].cost, undefined, 'the technologist never sees costs');
  assert.equal(bal(db, S.produce, p.siyro).q, 326, 'the quyma is in the production stage');
  assert.equal(bal(db, wh.raw, p.milk).q, 680, 'milk came straight from the raw-milk warehouse');
  assert.equal(bal(db, wh.store, v['505']).q, 95.8);
  // 2) over the range → waits for the manager
  const t2 = await post(T.tech, '/api/erp/prod/tasks', { recipeId: r.r5.id, milkQty: 160 });
  const over = await post(T.tech, `/api/erp/prod/tasks/${t2.id}/complete`, { outputQty: 170 });
  assert.equal(over.needApproval, true);
  assert.deepEqual([over.range.min, over.range.max], [160, 167.5]);
  await post(b, `/api/erp/prod/tasks/${t2.id}/reject`, { note: "Qayta o'lchang" });
  await post(T.tech, `/api/erp/prod/tasks/${t2.id}/cancel`, { reason: 'Kerak emas' });
  // 3) skim milk is used before the separation is entered: the raw warehouse goes below zero
  const t3 = await post(T.tech, '/api/erp/prod/tasks', { recipeId: r.tv.id, factor: 1 });
  await post(T.tech, `/api/erp/prod/tasks/${t3.id}/complete`, { outputQty: 12 });
  assert.equal(bal(db, wh.store, p.skim).q, -50);
  const sh = (await call(app, 'GET', '/api/erp/prod/shift', T.tech)).body.shift;
  assert.equal(sh.milk.used, 320);
  assert.equal(sh.milk.book, 680);
  assert.equal(sh.separation.outputs.find((o) => o.product_id === p.skim).book, -50);
  // close: 400 kg separated (unknown), 20 kg lost boiling, 260 kg counted in the tank;
  // cream made 28 kg, skim milk left 300 kg → made 350 kg
  const boil = reasons.find((x) => x.name === 'Qaynatishda').id;
  const unexplained = await call(app, 'POST', `/api/erp/prod/shifts/${sh.id}/close`, T.tech, { milkLeft: 260, losses: [{ reasonId: boil, qty: 20 }] });
  assert.equal(unexplained.status, 400);
  assert.equal(unexplained.body.details.unexplained, 400);
  const closed = await post(T.tech, `/api/erp/prod/shifts/${sh.id}/close`, { milkLeft: 260, losses: [{ reasonId: boil, qty: 20 }],
    separation: { outputs: [{ productId: p.sepCream, qty: 28 }, { productId: p.skim, qty: 300 }] } });
  assert.equal(closed.shift.status, 'closed');
  assert.equal(closed.shift.close_data.sepMilk, 400);
  // real costs: separation 400 × 5000 = 2 000 000 → cream 28 × 42 000, skim milk the rest (824 000 for 350 kg);
  // boiling 20 × 5000 = 100 000 spread by milk: 320 / 720 to the quyma, 400 / 720 to skim milk
  const skimCost = 824000 + (100000 * 400) / 720;
  near(bal(db, wh.store, p.sepCream).c, 28 * 42000, 'cream keeps its fixed cost');
  near(bal(db, wh.store, p.skim).c, (skimCost * 300) / 350, 'skim milk left');
  // (its starter: not chosen, so the variant with the most stock — 499 at 50)
  near(bal(db, S.produce, p.tvorog).c, (skimCost * 50) / 350 + 50, 'the tvorog made from skim milk before it was known now carries its real cost');
  near(bal(db, S.produce, p.siyro).c, 320 * 5000 + 6 * 40000 + 4.2 * 80 + (100000 * 320) / 720, 'quyma with its share of boiling');
  assert.ok(Math.abs(pnl(db, 'cost_variance')) < 0.05, `no cost left as a variance: ${pnl(db, 'cost_variance')}`);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lots WHERE provisional = 1').get().n, 0, 'all final');
  assert.equal(bal(db, wh.raw, p.milk).q, 260);
  // the whole value is still there: opening = stock now (no expense was booked)
  const total = db.prepare('SELECT ROUND(SUM(cost), 2) c FROM stock_moves').get().c;
  near(total, 1000 * 5000 + 20 * 40000 + 100 * 50 + 100 * 80 + 500 * 800, 'value conserved');
});

test('pouring, the keep stages and capping: who-did-it wages, jars taken automatically, a negative cold room settled at real cost, reprocessing from the returns stage', async () => {
  const { app, db, u, b, T, ok, post, wh, S, p, r } = await plant();
  // quyma: one batch of 326 kg
  const t1 = await post(T.tech, '/api/erp/prod/tasks', { recipeId: r.r5.id, milkQty: 320 });
  await post(T.tech, `/api/erp/prod/tasks/${t1.id}/complete`, { outputQty: 326 });
  const siyroUnit = (320 * 5000 + 6 * 40000 + 4.2 * 50) / 326;
  // waiting at the pouring stage: the quyma in the production stage
  const board = (await call(app, 'GET', '/api/erp/prod/board', T.pour1)).body.stages;
  const pourBoard = board.find((s) => s.code === 'pour');
  assert.equal(pourBoard.waiting[0].waiting.qty, 326);
  assert.equal(board.find((s) => s.code === 'produce'), undefined, 'only my stages');
  // the capper cannot pour
  assert.equal((await call(app, 'POST', '/api/erp/prod/tasks', T.cap, { recipeId: r.pour.id, units: 100 })).status, 403);
  // 100 jars by Malika and Gulnora: 17 000 split; jars leave the jar warehouse by themselves
  const pt = await post(T.pour1, '/api/erp/prod/tasks', { recipeId: r.pour.id, units: 100 });
  assert.equal(pt.shift_id, null, 'no shift outside production');
  const pd = await post(T.pour1, `/api/erp/prod/tasks/${pt.id}/complete`, { outputQty: 100, workers: [u.pour1, u.pour2] });
  assert.equal(pd.task.wages[0].amount, undefined, 'workers never see sums');
  const W = async (id) => (await call(app, 'GET', `/api/erp/prod/tasks/${id}`, b)).body.wages.map((w) => [w.name, w.amount]).sort();
  assert.deepEqual(await W(pt.id), [['Gulnora', 8500], ['Malika', 8500]]);
  assert.equal(bal(db, wh.pack, p.jar).q, 400);
  assert.equal(bal(db, S.produce, p.siyro).q, 286);
  const u1 = (40 * siyroUnit + 100 * 800 + 17000) / 100;
  near(bal(db, S.pour, p.qatiq).c, 100 * u1, 'poured jars');
  // by default the person doing it is the only worker
  const pt2 = await post(T.pour1, '/api/erp/prod/tasks', { recipeId: r.pour.id, units: 10 });
  const pd2 = await post(T.pour1, `/api/erp/prod/tasks/${pt2.id}/complete`, { outputQty: 10 });
  assert.deepEqual(await W(pt2.id), [['Malika', 1700]]);
  const u2 = (4 * siyroUnit + 10 * 800 + 1700) / 10;
  // keep stages: incubator (pourers) takes 100 of 110, the rest stays at pouring
  await post(T.pour1, '/api/erp/prod/moves', { stageId: S.incubator, productId: p.qatiq, qty: 100 });
  assert.equal(bal(db, S.pour, p.qatiq).q, 10);
  assert.equal((await call(app, 'POST', '/api/erp/prod/moves', T.pour1, { stageId: S.cold, productId: p.qatiq, qty: 10 })).status, 403, 'not their stage');
  await post(T.keep, '/api/erp/prod/moves', { stageId: S.cold, productId: p.qatiq, qty: 100 });
  // the capper caps 110 — 10 more than the cold room holds: it goes below zero and warns
  const cap = await post(T.cap, '/api/erp/prod/moves', { stageId: S.cap, productId: p.qatiq, qty: 110 });
  assert.deepEqual(await W(cap.task.id), [['Bobur', 9900]]);
  assert.equal(bal(db, S.cold, p.qatiq).q, -10);
  assert.ok(db.prepare("SELECT 1 FROM alerts WHERE type = 'stock.negative' AND resolved_at IS NULL").get(), 'the admin is warned');
  // the other 10 jars arrive later: the cold room is settled and the capped jars take their real cost
  await post(T.pour1, '/api/erp/prod/moves', { stageId: S.incubator, productId: p.qatiq, qty: 10 });
  await post(T.keep, '/api/erp/prod/moves', { stageId: S.cold, productId: p.qatiq, qty: 10 });
  assert.equal(bal(db, S.cold, p.qatiq).q, 0);
  near(bal(db, S.cold, p.qatiq).c, 0, 'cold room empty and worth nothing');
  near(bal(db, S.cap, p.qatiq).c, 100 * u1 + 10 * u2 + 9900, 'capped jars at their real cost plus the capping wage');
  assert.ok(Math.abs(pnl(db, 'cost_variance')) < 0.05, `no variance: ${pnl(db, 'cost_variance')}`);
  // finished goods, then 10 back to the returns stage, reprocessed: 9 jars back to the jar warehouse, 1 broken
  await post(T.keep, '/api/erp/prod/moves', { stageId: S.finished, productId: p.qatiq, qty: 110 });
  await post(T.keep, '/api/erp/prod/moves', { stageId: S.returns, productId: p.qatiq, qty: 10 });
  const rt = await post(T.rep, '/api/erp/prod/tasks', { recipeId: r.rep.id, units: 10 });
  const broken = db.prepare("SELECT id FROM stock_reasons WHERE section = 'reprocess' AND name = 'Singan'").get().id;
  await post(T.rep, `/api/erp/prod/tasks/${rt.id}/complete`, { outputs: [{ productId: p.jar, qty: 9 }, { productId: p.back, qty: 4 }], shortfall: [{ reasonId: broken, qty: 1 }] });
  assert.equal(bal(db, S.returns, p.qatiq).q, 0);
  assert.equal(bal(db, wh.pack, p.jar).q, 500 - 110 + 9, 'containers back where jars are kept');
  assert.equal(bal(db, S.reprocess_bad, p.back).q, 4);
  // a capped move cannot be cancelled once its jars moved on
  assert.equal((await call(app, 'POST', `/api/erp/prod/tasks/${cap.task.id}/cancel`, T.cap, { reason: 'x' })).status, 400);
  // the journal shows who did what at each stage
  const j = (await call(app, 'GET', `/api/erp/prod/journal?stageId=${S.cap}`, b)).body;
  assert.equal(j[0].user_name, 'Bobur');
  // books: stock value = what came in + wages − expenses
  const total = db.prepare('SELECT ROUND(SUM(cost), 2) c FROM stock_moves').get().c;
  const wages = -db.prepare("SELECT ROUND(SUM(amount), 2) a FROM party_entries WHERE kind = 'piece'").get().a;
  const expenses = pnl(db, 'reprocess_loss') + pnl(db, 'container_loss') + pnl(db, 'cost_variance');
  near(total, 1000 * 5000 + 20 * 40000 + 100 * 50 + 100 * 80 + 500 * 800 + wages - expenses, 'books balance');
});

test('packing a bought product (production off), a keep stage without a map entry is refused, and cancelling an untouched move', async () => {
  const { app, db, u, b, T, ok, post, wh, S, p } = await plant();
  const kg = await post(b, '/api/erp/products', { name: 'Smetana (xarid)', kind: 'raw', unit: 'kg' }).then((x) => x.id);
  const box = await post(b, '/api/erp/products', { name: 'Smetana 1 kg', kind: 'finished', unit: 'dona', netto_g: 1000 }).then((x) => x.id);
  await post(b, '/api/erp/docs', { type: 'opening', to: { warehouseId: wh.store }, lines: [{ productId: kg, qty: 50, unitCost: 30000 }] });
  const rp = await post(b, '/api/erp/prod/recipes', { name: 'Qadoqlash 1 kg', kind: 'pack', productId: box, lines: [{ productId: kg, qty: 1 }, { productId: p.jar, qty: 1 }], rates: [{ name: 'Qadoqlash', amount: 100 }] });
  assert.equal(rp.stage_id, S.pack);
  await ok(call(app, 'PUT', `/api/erp/prod/map/${box}`, b, { stageIds: [S.pack, S.finished] }), 'map');
  const t = await post(T.keep, '/api/erp/prod/tasks', { recipeId: rp.id, units: 20 });
  const d = await post(T.keep, `/api/erp/prod/tasks/${t.id}/complete`, { outputQty: 20 });
  assert.equal(d.task.status, 'done');
  near(bal(db, S.pack, box).c, 20 * (30000 + 800 + 100), 'packed');
  assert.equal(bal(db, wh.store, kg).q, 30);
  const mv = await post(T.keep, '/api/erp/prod/moves', { stageId: S.finished, productId: box, qty: 20 });
  assert.equal(bal(db, S.finished, box).q, 20);
  // the incubator is not on this product's map
  assert.equal((await call(app, 'POST', '/api/erp/prod/moves', T.pour1, { stageId: S.incubator, productId: box, qty: 1 })).status, 400);
  // an untouched move can be cancelled: the goods go back to the stage they came from
  await post(T.keep, `/api/erp/prod/tasks/${mv.task.id}/cancel`, { reason: 'Xato' });
  assert.equal(bal(db, S.finished, box).q, 0);
  assert.equal(bal(db, S.pack, box).q, 20);
});

test('"in my hands" is gone: hand-overs to a person are refused; old stock in hands moves to the stage of the role', async () => {
  const { app, db, u, b, wh, S, p } = await plant();
  const r = await call(app, 'POST', '/api/erp/docs', b, { type: 'transfer', from: { warehouseId: wh.raw }, to: { userId: u.tech }, lines: [{ productId: p.milk, qty: 1 }] });
  assert.equal(r.status, 400);
  // stock left in a person's hands from before
  const id = Number(db.prepare("INSERT INTO docs (uuid, type, number, status, doc_date, created_by) VALUES ('old', 'opening', 99, 'posted', ?, 'x')").run(new Date().toISOString()).lastInsertRowid);
  addIn(db, { doc: getDoc(db, id), at: new Date().toISOString(), touched: new Set() }, { productId: p.siyro, h: { userId: u.pour1 }, qty: 7, cost: 7000, lot: { unitCost: 1000, seq: 1 } });
  // and an old hand-over to a person still waiting to be accepted
  const sent = Number(db.prepare("INSERT INTO docs (uuid, type, number, status, doc_date, from_wh, to_user, created_by) VALUES ('old-sent', 'transfer', 98, 'sent', ?, ?, ?, 'x')").run(new Date().toISOString(), wh.raw, u.tech).lastInsertRowid);
  assert.equal(moveHandsToStages(db), 1);
  assert.equal(db.prepare('SELECT status FROM docs WHERE id = ?').get(sent).status, 'cancelled', 'old hand-overs to a person close');
  assert.equal(bal(db, S.pour, p.siyro).q, 7, "the pourer's goods are in the pouring stage");
  assert.equal(db.prepare('SELECT COUNT(*) n FROM (SELECT 1 FROM stock_moves WHERE holder_id IS NOT NULL GROUP BY holder_id, product_id HAVING ABS(SUM(qty)) > 0.0005)').get().n, 0);
});

test('a task past its time limit raises an alert with the worker\'s name; it closes when the task is done', async () => {
  const { app, db, b, T, post, r } = await plant();
  await call(app, 'PUT', `/api/erp/prod/recipes/${r.pour.id}`, b, { ...r.pour, productId: r.pour.product_id, maxMinutes: 30,
    lines: r.pour.lines.map((l) => ({ productId: l.product_id, qty: l.qty })), rates: r.pour.rates });
  const t1 = await post(T.tech, '/api/erp/prod/tasks', { recipeId: r.r5.id, milkQty: 320 });
  await post(T.tech, `/api/erp/prod/tasks/${t1.id}/complete`, { outputQty: 326 });
  const t = await post(T.pour1, '/api/erp/prod/tasks', { recipeId: r.pour.id, units: 10 });
  runChecks(db);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM alerts WHERE type = 'task.late'").get().n, 0);
  db.prepare("UPDATE prod_tasks SET created_at = datetime('now', '-40 minutes') WHERE id = ?").run(t.id);
  runChecks(db);
  runChecks(db);
  const late = db.prepare("SELECT * FROM alerts WHERE type = 'task.late'").all();
  assert.equal(late.length, 1, 'raised once');
  assert.match(late[0].text, /Malika/);
  await post(T.pour1, `/api/erp/prod/tasks/${t.id}/complete`, {});
  runChecks(db);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM alerts WHERE type = 'task.late' AND resolved_at IS NULL").get().n, 0);
});

test('overview: production block from the stage tasks, each block only with its permission', async () => {
  const { app, b, T, post, r } = await plant();
  const a = await post(T.tech, '/api/erp/prod/tasks', { recipeId: r.r5.id, milkQty: 320 });
  await post(T.tech, `/api/erp/prod/tasks/${a.id}/complete`, { outputQty: 326 });
  const o = (await call(app, 'GET', '/api/erp/overview', b)).body;
  assert.ok(o.milk && o.stock && o.production && o.alerts && Array.isArray(o.pnl));
  assert.equal(o.production.tasks_done, 1);
  assert.equal(o.production.milk_used, 320);
  assert.equal(o.production.open_shifts, 1);
  const mine = (await call(app, 'GET', '/api/erp/overview', T.tech)).body;
  assert.deepEqual(Object.keys(mine), ['day'], 'a technologist sees none of it');
});

test('monoblock: only people marked for it, a PIN only for them, and no two people with the same PIN', async () => {
  const { app, db, u, b } = await plant();
  const T = await login(app, 'tech', 'pass1234');
  assert.equal((await call(app, 'PUT', `/api/kiosk/admin/pin/${u.tech}`, b, { pin: '1234' })).status, 400, 'not marked for the monoblock');
  await call(app, 'PATCH', `/api/admin/staff/${u.tech}`, b, { kiosk: true });
  await call(app, 'PATCH', `/api/admin/staff/${u.pour1}`, b, { kiosk: true });
  assert.equal((await call(app, 'PUT', `/api/kiosk/admin/pin/${u.tech}`, b, { pin: '1234' })).status, 200);
  const same = await call(app, 'PUT', `/api/kiosk/admin/pin/${u.pour1}`, b, { pin: '1234' });
  assert.equal(same.status, 400);
  assert.match(same.body.error, /boshqa xodimda bor/);
  assert.equal((await call(app, 'PUT', `/api/kiosk/admin/pin/${u.pour1}`, b, { pin: '4321' })).status, 200);
  // the monoblock lists only people marked for it
  const staff = (await call(app, 'GET', '/api/kiosk/admin', b)).body.staff;
  assert.equal(staff.find((s) => s.id === u.tech).kiosk, 1);
  // off the monoblock: the PIN goes
  await call(app, 'PATCH', `/api/admin/staff/${u.tech}`, b, { kiosk: false });
  assert.equal(db.prepare('SELECT pin_hash FROM users WHERE id = ?').get(u.tech).pin_hash, null);
  void T;
});

test('three pourers split 170 as 56.67 / 56.67 / 56.66; the recipe base weight; a gain at the shift close lowers the batch cost', async () => {
  const { app, db, u, b, T, post, wh, S, p, r } = await plant();
  assert.equal(r.r5.base_weight, 326.004);
  assert.equal(r.r5.base_milk, 320);
  const t1 = await post(T.tech, '/api/erp/prod/tasks', { recipeId: r.r5.id, milkQty: 320 });
  await post(T.tech, `/api/erp/prod/tasks/${t1.id}/complete`, { outputQty: 326 });
  const pt = await post(T.pour1, '/api/erp/prod/tasks', { recipeId: r.pour.id, units: 1 });
  await post(T.pour1, `/api/erp/prod/tasks/${pt.id}/complete`, { outputQty: 1, workers: [u.pour1, u.pour2, u.cap] });
  const w = (await call(app, 'GET', `/api/erp/prod/tasks/${pt.id}`, b)).body.wages.map((x) => x.amount).sort();
  assert.deepEqual(w, [56.66, 56.67, 56.67]);
  // 690 kg counted where the books say 680: a 10 kg gain at the shift's milk cost
  const before = bal(db, S.produce, p.siyro).c + bal(db, S.pour, p.qatiq).c - 1 * 800 - 170; // the whole batch, including the jar's 0.4 kg
  const sh = (await call(app, 'GET', '/api/erp/prod/shift', T.tech)).body.shift;
  const r2 = await post(T.tech, `/api/erp/prod/shifts/${sh.id}/close`, { milkLeft: 690, losses: [] });
  assert.equal(r2.shift.status, 'closed');
  assert.equal(r2.shift.close_data.gain, 10);
  near(bal(db, S.produce, p.siyro).c + bal(db, S.pour, p.qatiq).c - 1 * 800 - 170, before - 10 * 5000, 'the gain lowered what the shift made');
  assert.equal(bal(db, wh.raw, p.milk).q, 690);
});

test('Tex karta: only finished products; production names the quyma recipe, pouring the pour recipe; several products from one quyma', async () => {
  const { app, db, u, b, T, ok, post, wh, S, p, r } = await plant();
  // only finished products have a Tex karta
  assert.equal((await call(app, 'PUT', `/api/erp/prod/map/${p.siyro}`, b, { stages: [{ stageId: S.produce }] })).status, 400);
  // the editor offers the right recipes per stage
  const tex = (await call(app, 'GET', `/api/erp/prod/tex/${p.qatiq}`, b)).body;
  assert.deepEqual(tex.stages.find((x) => x.code === 'produce').recipes.map((x) => x.name), ['5% siyro', 'Tvorog'], 'quyma recipes');
  assert.equal(tex.stages.find((x) => x.code === 'produce').recipe_id, r.r5.id);
  assert.equal(tex.stages.find((x) => x.code === 'cold').recipes.length, 0, 'a keep stage has none');
  // a keep stage cannot take a recipe; a recipe of another stage cannot be chosen
  assert.equal((await call(app, 'PUT', `/api/erp/prod/map/${p.qatiq}`, b, { stages: [{ stageId: S.cold, recipeId: r.r5.id }] })).status, 400);
  assert.equal((await call(app, 'PUT', `/api/erp/prod/map/${p.qatiq}`, b, { stages: [{ stageId: S.pour, recipeId: r.r5.id }] })).status, 400);
  // two more finished products from the same 5% quyma, poured with a general 800 g recipe
  const bochka = await post(b, '/api/erp/products', { name: 'Qatiq bochka 800 g', kind: 'finished', unit: 'dona', netto_g: 800 }).then((x) => x.id);
  const banka = await post(b, '/api/erp/products', { name: 'Qatiq banka 800 g', kind: 'finished', unit: 'dona', netto_g: 800 }).then((x) => x.id);
  const p800 = await post(b, '/api/erp/prod/recipes', { name: '800 g idishga quyish', kind: 'pour', lines: [{ productId: p.siyro, qty: 0.8 }, { productId: p.jar, qty: 1 }], rates: [{ name: 'Quyish', amount: 200 }] });
  assert.equal(p800.product_id, null, 'a general pouring recipe');
  for (const pid of [bochka, banka]) await ok(call(app, 'PUT', `/api/erp/prod/map/${pid}`, b, { stages: [{ stageId: S.produce, recipeId: r.r5.id }, { stageId: S.pour, recipeId: p800.id }, { stageId: S.finished }] }), 'tex');
  // one quyma batch; the pouring stage shows three products waiting on the same quyma
  const t1 = await post(T.tech, '/api/erp/prod/tasks', { recipeId: r.r5.id, milkQty: 320 });
  await post(T.tech, `/api/erp/prod/tasks/${t1.id}/complete`, { outputQty: 326 });
  const pourBoard = (await call(app, 'GET', '/api/erp/prod/board', T.pour1)).body.stages.find((x) => x.code === 'pour');
  assert.deepEqual(pourBoard.waiting.map((w) => [w.product, w.waiting.product, w.waiting.qty]),
    [['5% qatiq 400 g', '5% siyro', 326], ['Qatiq banka 800 g', '5% siyro', 326], ['Qatiq bochka 800 g', '5% siyro', 326]]);
  // the pourer chooses the product: its Tex karta gives the recipe; the output is that product
  const pt = await post(T.pour1, '/api/erp/prod/tasks', { stageId: S.pour, productId: bochka, units: 50 });
  assert.equal(pt.product, 'Qatiq bochka 800 g');
  await post(T.pour1, `/api/erp/prod/tasks/${pt.id}/complete`, { outputQty: 50 });
  assert.equal(bal(db, S.pour, bochka).q, 50);
  assert.equal(bal(db, S.produce, p.siyro).q, 326 - 40);
  // without a Tex karta recipe for that stage: refused
  const lone = await post(b, '/api/erp/products', { name: 'Qatiq kosa', kind: 'finished', unit: 'dona' }).then((x) => x.id);
  assert.equal((await call(app, 'POST', '/api/erp/prod/tasks', T.pour1, { stageId: S.pour, productId: lone, units: 1 })).status, 400);
  void u; void wh;
});

test('no piece wage in production: a quyma recipe cannot have one and "who did it" is not asked; pouring pays; product flags', async () => {
  const { app, db, u, b, T, post, p, r } = await plant();
  const bad = await call(app, 'POST', '/api/erp/prod/recipes', b, { name: 'x', kind: 'cook', productId: p.back, lines: [{ productId: p.milk, qty: 10 }], rates: [{ name: 'Texnolog', amount: 50 }] });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /ishbay haq bo'lmaydi/);
  const t1 = await post(T.tech, '/api/erp/prod/tasks', { recipeId: r.r5.id, milkQty: 320 });
  const d1 = await post(T.tech, `/api/erp/prod/tasks/${t1.id}/complete`, { outputQty: 326, workers: [u.pour1, u.pour2] });
  assert.deepEqual(d1.task.workers.map((w) => w.id), [u.tech], 'production: only the person doing it, nobody paid');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM party_entries WHERE kind = 'piece'").get().n, 0);
  // product flags: sold by weight too, usable as a raw material
  await call(app, 'PATCH', `/api/erp/products/${p.siyro}`, b, { forSale: true, asRaw: true });
  const s = db.prepare('SELECT for_sale, as_raw FROM products WHERE id = ?').get(p.siyro);
  assert.deepEqual([s.for_sale, s.as_raw], [1, 1]);
});
