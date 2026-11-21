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
  const exp = (await call(app, 'POST', '/api/erp/warehouses', b, { name: "Muddati o'tganlar", kind: 'expired' })).body.id;
  await call(app, 'POST', '/api/erp/docs', b, { type: 'opening', to: { warehouseId: exp }, lines: [{ productId: p.smetana, qty: 17, unitCost: 7000 }] });
  const tr = (await call(app, 'POST', '/api/erp/docs', b, { type: 'transfer', from: { warehouseId: exp }, to: { userId: id }, lines: [{ productId: p.smetana, qty: 17 }] })).body;
  const r = await login(app, 'rep', 'pass1234');
  assert.equal((await call(app, 'POST', `/api/erp/docs/${tr.id}/accept`, r, {})).status, 200);
  const recipe = (await call(app, 'POST', '/api/erp/prod/recipes', b, {
    name: 'Smetana 400 g — qayta ishlash', kind: 'reprocess', productId: p.smetana,
    outputs: [
      { productId: p.jar, perUnit: 1, costValue: 800, isContainer: true },
      { productId: p.back, minPerUnit: 0.37, maxPerUnit: 0.45, costValue: 0 },
    ],
  })).body;
  await call(app, 'POST', '/api/erp/prod/shift', r, {});
  return { app, db, ids, b, r, p, recipe };
}
const pnl = (db, code) => db.prepare('SELECT COALESCE(ROUND(SUM(e.amount), 2), 0) a FROM pnl_entries e JOIN pnl_categories c ON c.id = e.category_id WHERE c.code = ?').get(code).a;
const held = (db, productId, userId) => db.prepare('SELECT ROUND(SUM(qty), 3) q, ROUND(SUM(cost), 2) c FROM stock_moves WHERE product_id = ? AND holder_id = ?').get(productId, userId);

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
  assert.deepEqual(held(db, p.jar, ids.rep), { q: 14, c: 14 * 800 });
  assert.deepEqual(held(db, p.back, ids.rep), { q: 6.8, c: 0 });
  assert.equal(held(db, p.smetana, ids.rep).q, 0);
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
