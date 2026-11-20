import { test } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import { setup, call, login, boss } from './helpers.js';
import { roleIdByCode, ensureDeviceSlots } from '../src/db/index.js';
import { runChecks } from '../src/erp/watch.js';
import { setupErp } from '../src/erp/schema.js';

// Pouring line: quyma → jars (incubator) → caps → finished goods.
async function line() {
  const { app, db, ids } = setup();
  const add = (loginName, code, name) => {
    const id = Number(db.prepare('INSERT INTO users (login, name, password_hash, role_id) VALUES (?, ?, ?, ?)')
      .run(loginName, name, bcrypt.hashSync('pass1234', 4), roleIdByCode(db, code)).lastInsertRowid);
    ensureDeviceSlots(db, id);
    return id;
  };
  ids.p1 = add('pour1', 'pourer', 'Malika');
  ids.p2 = add('pour2', 'pourer', 'Gulnora');
  ids.p3 = add('pour3', 'pourer', 'Sevara');
  ids.cap = add('cap1', 'capper', 'Bobur');
  ids.keeper = add('keeper', 'storekeeper', 'Issiqxona Aziz');
  const b = await boss(app);
  const P = async (body) => (await call(app, 'POST', '/api/erp/products', b, body)).body.id;
  const W = async (body) => (await call(app, 'POST', '/api/erp/warehouses', b, body)).body.id;
  const p = {
    siyro: await P({ name: '5% siyro', kind: 'semi', unit: 'kg' }),
    jar: await P({ name: 'V idish 400 g', kind: 'pack', unit: 'dona' }),
    label: await P({ name: 'Etiketka 5% qatiq', kind: 'label', unit: 'dona' }),
    lid: await P({ name: 'Qopqoq 95 mm', kind: 'pack', unit: 'dona' }),
    qatiq: await P({ name: '5% qatiq 400 g', kind: 'finished', unit: 'dona', netto_g: 400, dwell_hours: 6, shelf_life_hours: 168 }),
  };
  const store = await W({ name: 'Xomashyo ombori', kind: 'raw' });
  const inc = await W({ name: 'Issiqxona', kind: 'incubator', keepers: [ids.keeper] });
  const fin = await W({ name: 'Tayyor mahsulot ombori', kind: 'finished', keepers: [ids.keeper] });
  await call(app, 'POST', '/api/erp/docs', b, { type: 'opening', to: { warehouseId: store }, lines: [
    { productId: p.siyro, qty: 41, unitCost: 6000 }, { productId: p.jar, qty: 200, unitCost: 800 }, { productId: p.label, qty: 200, unitCost: 50 }, { productId: p.lid, qty: 200, unitCost: 100 }] });
  const give = async (to, lines) => {
    const d = (await call(app, 'POST', '/api/erp/docs', b, { type: 'transfer', from: { warehouseId: store }, to: { userId: to }, lines })).body;
    assert.equal((await call(app, 'POST', `/api/erp/docs/${d.id}/accept`, b, {})).status, 200);
  };
  await give(ids.p1, [{ productId: p.siyro, qty: 41 }, { productId: p.jar, qty: 110 }, { productId: p.label, qty: 110 }]);
  await give(ids.cap, [{ productId: p.lid, qty: 110 }]);
  const pour = (await call(app, 'POST', '/api/erp/prod/recipes', b, {
    name: '5% qatiq 400 g — quyish', kind: 'pour', productId: p.qatiq, maxMinutes: 30,
    lines: [{ productId: p.siyro, qty: 0.4 }, { productId: p.jar, qty: 1 }, { productId: p.label, qty: 1 }], rates: [{ name: 'Quyish', amount: 170 }],
  })).body;
  const cap = (await call(app, 'POST', '/api/erp/prod/recipes', b, {
    name: '5% qatiq 400 g — qopqoq', kind: 'cap', productId: p.qatiq,
    lines: [{ productId: p.qatiq, qty: 1 }, { productId: p.lid, qty: 1 }], rates: [{ name: 'Qopqoq yopish', amount: 90 }],
  })).body;
  return { app, db, ids, b, p, store, inc, fin, pour, cap };
}
const bal = async (app, b, id) => (await call(app, 'GET', `/api/erp/staff-balance/${id}`, b)).body.balance;
const holding = (db, productId, h) => db.prepare(`SELECT ROUND(SUM(qty), 3) q, ROUND(SUM(cost), 2) c FROM stock_moves WHERE product_id = ? AND ${h.warehouseId ? 'warehouse_id' : 'holder_id'} = ?`)
  .get(productId, h.warehouseId ?? h.userId);

test('pouring: 100 jars from 40 kg, two pourers share the piece rate, output goes to the incubator; capping adds lid and rate', async () => {
  const { app, db, ids, b, p, inc, fin, pour, cap } = await line();
  const m1 = await login(app, 'pour1', 'pass1234');
  // a pourer only sees and runs pouring recipes
  const visible = (await call(app, 'GET', '/api/erp/prod/recipes', m1)).body;
  assert.deepEqual(visible.map((r) => r.kind), ['pour']);
  await call(app, 'POST', '/api/erp/prod/shift', m1, {});
  assert.equal((await call(app, 'POST', '/api/erp/prod/tasks', m1, { recipeId: cap.id, units: 10 })).status, 400, 'not a capper');
  const t = (await call(app, 'POST', '/api/erp/prod/tasks', m1, { recipeId: pour.id, units: 100 })).body;
  assert.deepEqual(t.plan.map((l) => l.qty), [40, 100, 100]);
  const done = await call(app, 'POST', `/api/erp/prod/tasks/${t.id}/complete`, m1, { outputQty: 100, workers: [ids.p1, ids.p2], sendTo: { warehouseId: inc } });
  assert.equal(done.status, 200);
  assert.equal(done.body.task.workers.length, 2);
  assert.equal(done.body.task.wages[0]?.amount, undefined, 'workers never see sums');
  // cost per jar = 0.4 kg × 6000 + jar 800 + label 50 + pouring 170
  const unit = 0.4 * 6000 + 800 + 50 + 170;
  assert.equal((await call(app, 'GET', `/api/erp/prod/tasks/${t.id}`, b)).body.outputs[0].unit_cost, unit);
  assert.equal(await bal(app, b, ids.p1), -8500, 'the company owes each pourer 85 × 100');
  assert.equal(await bal(app, b, ids.p2), -8500);
  // the jars wait for the incubator keeper; 1 kg of quyma is left with the pourer
  const handover = db.prepare("SELECT * FROM docs WHERE type = 'transfer' AND status = 'sent' AND to_wh = ?").get(inc);
  assert.ok(handover);
  assert.equal(holding(db, p.siyro, { userId: ids.p1 }).q, 1);
  const keeper = await login(app, 'keeper', 'pass1234');
  assert.equal((await call(app, 'POST', `/api/erp/docs/${handover.id}/accept`, keeper, {})).status, 200);
  assert.equal(holding(db, p.qatiq, { warehouseId: inc }).q, 100);

  // 7 hours later (dwell time 6 h): an alert naming the keeper, shown to the keeper, not to the pourer
  db.prepare("UPDATE stock_moves SET at = datetime('now', '-7 hours') WHERE warehouse_id = ? AND product_id = ?").run(inc, p.qatiq);
  runChecks(db);
  const dwell = db.prepare("SELECT * FROM alerts WHERE type = 'dwell.over' AND resolved_at IS NULL").get();
  assert.match(dwell.text, /Issiqxona Aziz/);
  assert.equal((await call(app, 'GET', '/api/erp/alerts/mine', keeper)).body.length, 1);
  assert.equal((await call(app, 'GET', '/api/erp/alerts/mine', m1)).body.length, 0);

  // the capper takes them out of the incubator: the alert closes by itself
  const out = (await call(app, 'POST', '/api/erp/docs', keeper, { type: 'transfer', from: { warehouseId: inc }, to: { userId: ids.cap }, lines: [{ productId: p.qatiq, qty: 100 }] })).body;
  const c = await login(app, 'cap1', 'pass1234');
  assert.equal((await call(app, 'POST', `/api/erp/docs/${out.id}/accept`, c, {})).status, 200);
  runChecks(db);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM alerts WHERE type = 'dwell.over' AND resolved_at IS NULL").get().n, 0);

  await call(app, 'POST', '/api/erp/prod/shift', c, {});
  const ct = (await call(app, 'POST', '/api/erp/prod/tasks', c, { recipeId: cap.id, units: 100 })).body;
  assert.equal((await call(app, 'POST', `/api/erp/prod/tasks/${ct.id}/complete`, c, { sendTo: { warehouseId: fin } })).status, 200);
  assert.equal(await bal(app, b, ids.cap), -9000);
  const toFin = db.prepare("SELECT * FROM docs WHERE type = 'transfer' AND status = 'sent' AND to_wh = ?").get(fin);
  await call(app, 'POST', `/api/erp/docs/${toFin.id}/accept`, keeper, {});
  const f = holding(db, p.qatiq, { warehouseId: fin });
  assert.equal(f.q, 100);
  assert.equal(f.c, 100 * (unit + 100 + 90), 'final cost = pouring cost + lid + capping rate');
});

test('three pourers split 170 as 56.67 / 56.67 / 56.66; cancelling the task cancels the wages and the waiting hand-over', async () => {
  const { app, b, ids, inc, pour, db } = await line();
  const m1 = await login(app, 'pour1', 'pass1234');
  await call(app, 'POST', '/api/erp/prod/shift', m1, {});
  const t = (await call(app, 'POST', '/api/erp/prod/tasks', m1, { recipeId: pour.id, units: 1 })).body;
  await call(app, 'POST', `/api/erp/prod/tasks/${t.id}/complete`, m1, { workers: [ids.p1, ids.p2, ids.p3], sendTo: { warehouseId: inc } });
  assert.deepEqual([await bal(app, b, ids.p1), await bal(app, b, ids.p2), await bal(app, b, ids.p3)], [-56.67, -56.67, -56.66]);
  assert.equal((await call(app, 'POST', `/api/erp/prod/tasks/${t.id}/cancel`, m1, { reason: 'Noto\'g\'ri mahsulot' })).status, 200);
  assert.deepEqual([await bal(app, b, ids.p1), await bal(app, b, ids.p2), await bal(app, b, ids.p3)], [0, 0, 0]);
  assert.equal(db.prepare("SELECT status FROM docs WHERE type = 'transfer' AND to_wh = ? ORDER BY id DESC").get(inc).status, 'cancelled');
});

test('a task past its time limit raises an alert with the worker\'s name; it closes when the task is done', async () => {
  const { app, db, pour } = await line();
  const m1 = await login(app, 'pour1', 'pass1234');
  await call(app, 'POST', '/api/erp/prod/shift', m1, {});
  const t = (await call(app, 'POST', '/api/erp/prod/tasks', m1, { recipeId: pour.id, units: 10 })).body;
  runChecks(db);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM alerts WHERE type = 'task.late'").get().n, 0);
  db.prepare("UPDATE prod_tasks SET created_at = datetime('now', '-40 minutes') WHERE id = ?").run(t.id);
  runChecks(db);
  runChecks(db);
  const late = db.prepare("SELECT * FROM alerts WHERE type = 'task.late'").all();
  assert.equal(late.length, 1, 'raised once');
  assert.match(late[0].text, /Malika/);
  assert.equal((await call(app, 'GET', '/api/erp/alerts/mine', m1)).body.length, 1);
  await call(app, 'POST', `/api/erp/prod/tasks/${t.id}/complete`, m1, {});
  runChecks(db);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM alerts WHERE type = 'task.late' AND resolved_at IS NULL").get().n, 0);
});

test('a stage-2 database gets the new recipe kinds without losing recipes', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT, unit TEXT DEFAULT 'kg', active INTEGER DEFAULT 1);
    CREATE TABLE users (id INTEGER PRIMARY KEY, login TEXT);
    CREATE TABLE recipes (id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'cook' CHECK (kind IN ('cook','separation')),
      product_id INTEGER REFERENCES products(id), out_min REAL, out_max REAL, note TEXT, sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO products (id, name) VALUES (1, '5% siyro');
    INSERT INTO recipes (id, name, product_id) VALUES (7, '5%', 1);`);
  const addColumn = (t, c, d) => { try { db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`); } catch { /* there */ } };
  setupErp(db, addColumn);
  assert.equal(db.prepare('SELECT name FROM recipes WHERE id = 7').get().name, '5%');
  db.prepare("INSERT INTO recipes (name, kind, product_id, max_minutes) VALUES ('quyish', 'pour', 1, 30)").run();
  assert.equal(db.prepare("SELECT COUNT(*) n FROM recipes WHERE kind = 'pour'").get().n, 1);
});
