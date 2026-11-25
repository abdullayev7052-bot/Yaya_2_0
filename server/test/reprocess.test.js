import { test } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { setup, call, login, boss } from './helpers.js';
import { roleIdByCode, ensureDeviceSlots } from '../src/db/index.js';

// 17 expired Smetana 400 g (cost 7 000 each) → 17 containers at 800 + 6.8 kg of "Vozvrat qatiq" at no cost.
async function plant() {
  const { app, db, ids } = setup();
  const id = Number(db.prepare('INSERT INTO users (login, name, password_hash, role_id) VALUES (?, ?, ?, ?)')
    .run('rep', 'Qayta ishlovchi Nodir', bcrypt.hashSync('pass1234', 4), roleIdByCode(db, 'reprocessor')).lastInsertRowid);
  ensureDeviceSlots(db, id);
  ids.rep = id;
  const b = await boss(app);
  const P = async (body) => (await call(app, 'POST', '/api/erp/products', b, body)).body.id;
  const p = {
    smetana: await P({ name: 'Smetana 20% 400 g', kind: 'finished', unit: 'dona', netto_g: 400 }),
    jar: await P({ name: 'V idish smetana 400 g', kind: 'pack', unit: 'dona' }),
    back: await P({ name: 'Vozvrat qatiq', kind: 'returned', unit: 'kg' }),
  };
  // Stage model: the expired goods are in the returns stage ("Vozvrat ombori"); the
  // reprocessor runs the "Yaroqsiz qayta ishlash" stage; jars go back to the jar warehouse.
  const stage = (code) => db.prepare('SELECT id FROM warehouses WHERE stage_code = ?').get(code).id;
  const ret = stage('returns'); const bad = stage('reprocess_bad');
  ids.ret = ret; ids.bad = bad;
  ids.pack = (await call(app, 'POST', '/api/erp/warehouses', b, { name: 'Idish ombori', kind: 'pack' })).body.id;
  await call(app, 'PUT', `/api/erp/prod/stages/${bad}`, b, { keepers: [id] });
  await call(app, 'PUT', `/api/erp/prod/map/${p.smetana}`, b, { stageIds: [stage('finished'), ret, bad] });
  await call(app, 'POST', '/api/erp/docs', b, { type: 'opening', to: { warehouseId: ret }, lines: [{ productId: p.smetana, qty: 17, unitCost: 7000 }] });
  const r = await login(app, 'rep', 'pass1234');
  const recipe = (await call(app, 'POST', '/api/erp/prod/recipes', b, {
    name: 'Smetana 400 g — qayta ishlash', kind: 'reprocess', productId: p.smetana,
    outputs: [
      { productId: p.jar, perUnit: 1, costValue: 800, isContainer: true },
      { productId: p.back, minPerUnit: 0.37, maxPerUnit: 0.45, costValue: 0 },
    ],
  })).body;
  return { app, db, ids, b, r, p, recipe };
}
const pnl = (db, code) => db.prepare('SELECT COALESCE(ROUND(SUM(e.amount), 2), 0) a FROM pnl_entries e JOIN pnl_categories c ON c.id = e.category_id WHERE c.code = ?').get(code).a;
const held = (db, productId, whId) => db.prepare('SELECT ROUND(SUM(qty), 3) q, ROUND(SUM(cost), 2) c FROM stock_moves WHERE product_id = ? AND warehouse_id = ?').get(productId, whId);

test('reprocessing: containers at a fixed cost, content by netto weight at no cost, missing containers explained, the rest is an expense', async () => {
  const { app, db, ids, r, p, recipe } = await plant();
  assert.equal(recipe.lines.length, 1, 'the input is the product itself');
  const t = (await call(app, 'POST', '/api/erp/prod/tasks', r, { recipeId: recipe.id, units: 17 })).body;
  // 14 containers back, 3 not explained → the system asks
  const ask = await call(app, 'POST', `/api/erp/prod/tasks/${t.id}/complete`, r, { outputs: [{ productId: p.jar, qty: 14 }] });
  assert.equal(ask.status, 400);
  assert.match(ask.body.error, /17 ta chiqishi kerak edi, 14 ta kiritdingiz — qolgan 3 tasi nima bo'ldi/);
  assert.equal(ask.body.details.missing, 3);
  const reasons = (await call(app, 'GET', '/api/erp/reasons?section=reprocess', r)).body;
  const broken = reasons.find((x) => x.name === 'Singan').id;
  const lost = reasons.find((x) => x.name === "Yo'qolgan").id;
  // content defaults to the netto weight: 17 × 0.4 = 6.8 kg
  const done = await call(app, 'POST', `/api/erp/prod/tasks/${t.id}/complete`, r, {
    outputs: [{ productId: p.jar, qty: 14 }], shortfall: [{ reasonId: broken, qty: 2 }, { reasonId: lost, qty: 1 }],
  });
  assert.equal(done.status, 200);
  assert.equal(done.body.task.status, 'done');
  assert.deepEqual(held(db, p.jar, ids.pack), { q: 14, c: 14 * 800 }, 'jars back in the jar warehouse');
  assert.deepEqual(held(db, p.back, ids.bad), { q: 6.8, c: 0 }, 'content in the reprocessing stage');
  assert.equal(held(db, p.smetana, ids.ret).q, 0, 'taken from the returns stage');
  assert.equal(pnl(db, 'container_loss'), 3 * 800);
  assert.equal(pnl(db, 'reprocess_loss'), 17 * 7000 - 14 * 800 - 3 * 800);
});

test('content outside its range (0.37–0.45 kg per unit) waits for a manager', async () => {
  const { app, b, r, p, recipe } = await plant();
  const t = (await call(app, 'POST', '/api/erp/prod/tasks', r, { recipeId: recipe.id, units: 10 })).body;
  const res = await call(app, 'POST', `/api/erp/prod/tasks/${t.id}/complete`, r, { outputs: [{ productId: p.jar, qty: 10 }, { productId: p.back, qty: 5 }] });
  assert.equal(res.body.needApproval, true);
  assert.deepEqual([res.body.range.min, res.body.range.max], [3.7, 4.5]);
  assert.equal((await call(app, 'POST', `/api/erp/prod/tasks/${t.id}/approve`, b, { note: "Qaymoqli edi" })).body.task.status, 'done');
});

test('more containers than expected is refused; a reprocessor sees only reprocessing recipes', async () => {
  const { app, r, p, recipe } = await plant();
  assert.deepEqual((await call(app, 'GET', '/api/erp/prod/recipes', r)).body.map((x) => x.kind), ['reprocess']);
  const t = (await call(app, 'POST', '/api/erp/prod/tasks', r, { recipeId: recipe.id, units: 2 })).body;
  assert.equal((await call(app, 'POST', `/api/erp/prod/tasks/${t.id}/complete`, r, { outputs: [{ productId: p.jar, qty: 3 }] })).status, 400);
});
