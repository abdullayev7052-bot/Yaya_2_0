import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, roleIdByCode } from '../src/db/index.js';
import { upgradeToV3 } from '../src/db/legacy.js';
import { toCsv } from '../src/reports.js';
import { setup, call, login, ali, boss, runShift } from './helpers.js';

async function acceptAll(app, b) {
  for (const s of (await call(app, 'GET', '/api/admin/shifts?status=closed', b)).body) await call(app, 'POST', `/api/admin/shifts/${s.id}/accept`, b);
}

test('encrypted backup: export, wrong password refused, import restores everything', async () => {
  const { app, db } = setup();
  const h = await ali(app);
  const b = await boss(app);
  await runShift(app, h, 's1', [{ supplierId: 1, quantity: 20 }], { close: true });
  await acceptAll(app, b);
  assert.equal((await call(app, 'POST', '/api/admin/data/export', b, { password: 'wrong', backupPassword: 'zaxira-parol' })).status, 400);
  const exp = await app.inject({ method: 'POST', url: '/api/admin/data/export', headers: b, payload: { password: 'secret123', backupPassword: 'zaxira-parol' } });
  assert.equal(exp.statusCode, 200);
  const file = exp.rawPayload;
  assert.ok(!file.includes(Buffer.from('Karimova')), 'file is encrypted');

  // damage the data, then restore from the file
  db.exec('DELETE FROM payments; DELETE FROM collections; DELETE FROM shifts; UPDATE suppliers SET name = \'X\'');
  const bad = await call(app, 'POST', '/api/admin/data/import', b, { file: file.toString('base64'), backupPassword: 'nope-nope', password: 'secret123', confirm: 'TIKLASH' });
  assert.equal(bad.status, 400);
  const ok = await call(app, 'POST', '/api/admin/data/import', b, { file: file.toString('base64'), backupPassword: 'zaxira-parol', password: 'secret123', confirm: 'TIKLASH' });
  assert.equal(ok.status, 200);
  assert.equal(db.prepare('SELECT name FROM suppliers WHERE id = 1').get().name, 'Karimova Oydin');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM collections').get().n, 1);
  // a safety copy of the damaged state was kept for 3 days
  const safety = (await call(app, 'GET', '/api/admin/data/safety', b)).body;
  assert.equal(safety[0].reason, 'Importdan oldin');
});

test('full reset: password, arithmetic and the exact phrase; everything goes, one new admin remains; undone for 3 days', async () => {
  const { app, db } = setup();
  const h = await ali(app);
  const b = await boss(app);
  await runShift(app, h, 's1', [{ supplierId: 1, quantity: 20 }], { close: true });
  await acceptAll(app, b);
  const ch = (await call(app, 'GET', '/api/admin/data/challenge', b)).body;
  const [x, y, z] = ch.question.match(/\d+/g).map(Number);
  const base = { password: 'secret123', challengeId: ch.id, answer: x * y - z, confirm: "HAMMASINI O'CHIRISH", newLogin: 'rahbar', newPassword: 'yangi12345' };
  assert.equal((await call(app, 'POST', '/api/admin/data/wipe', b, { ...base, confirm: 'ha' })).status, 400);
  // a used challenge cannot be reused
  assert.equal((await call(app, 'POST', '/api/admin/data/wipe', b, base)).status, 400);
  const fresh = async () => { const c = (await call(app, 'GET', '/api/admin/data/challenge', b)).body; const [a2, b2, c2] = c.question.match(/\d+/g).map(Number); return { challengeId: c.id, answer: a2 * b2 - c2 }; };
  // the new admin's password must be real
  assert.equal((await call(app, 'POST', '/api/admin/data/wipe', b, { ...base, ...(await fresh()), newPassword: '123' })).status, 400);
  const r = await call(app, 'POST', '/api/admin/data/wipe', b, { ...base, ...(await fresh()) });
  assert.equal(r.status, 200);
  // everything is gone: people, households, products, shifts, payments, settings
  for (const t of ['collections', 'shifts', 'suppliers', 'payments', 'products', 'docs', 'stock_moves', 'cash_entries', 'recipes', 'devices']) {
    if (t === 'devices') continue;
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n, 0, `${t} empty`);
  }
  assert.deepEqual(db.prepare('SELECT login FROM users').all().map((u) => u.login), ['rahbar'], 'only the new admin');
  // the system starts as new: roles, stages, the main cashbox
  assert.ok(db.prepare("SELECT 1 FROM roles WHERE code = 'admin'").get());
  assert.equal(db.prepare('SELECT COUNT(*) n FROM warehouses WHERE is_stage = 1').get().n, 10);
  assert.ok(db.prepare('SELECT 1 FROM cashboxes WHERE is_main = 1').get());
  // the old sign-in no longer works; the new admin signs in
  assert.equal((await call(app, 'GET', '/api/auth/me', b)).status, 401);
  const nb = await login(app, 'rahbar', 'yangi12345', { client: 'panel' });
  // undo within 3 days: the safety copy is still there
  const safety = (await call(app, 'GET', '/api/admin/data/safety', nb)).body;
  assert.equal(safety[0].id, r.body.safety);
  const re = await call(app, 'POST', `/api/admin/data/safety/${r.body.safety}/restore`, nb, { password: 'yangi12345' });
  assert.equal(re.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM collections').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM suppliers').get().n, 2);
  // a collector cannot do any of this
  assert.equal((await call(app, 'GET', '/api/admin/data/challenge', await ali(app))).status, 403);
  void h;
});

test('Excel: one household with several products (first = default); export round-trips', async () => {
  const { app, db } = setup();
  const b = await boss(app);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('S');
  ws.addRow(['F.I.Sh (majburiy)', 'Telefon', 'Manzil', 'Izoh', 'Mahsulot', 'Narx (so\'m)', 'Joriy qarz (so\'m)']);
  // Two rows, same household, two products with different prices — the first is the default (★).
  ws.addRow(['Yangi Fermer', '977777777', 'Buvayda', '', 'Yog\'li sut', 5200, 50000]);
  ws.addRow(['Yangi Fermer', '977777777', '', '', 'Yog\'siz sut', 3500, '']);
  // A product without a price is an error row.
  ws.addRow(['Xato', '', '', '', 'Yog\'li sut', '', '']);
  const file = Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
  const pre = (await call(app, 'POST', '/api/admin/suppliers-import', b, { file, dryRun: true })).body;
  assert.equal(pre.summary.errorRows, 1);
  await call(app, 'POST', '/api/admin/suppliers-import', b, { file, dryRun: false });
  const s = db.prepare("SELECT id FROM suppliers WHERE name = 'Yangi Fermer'").get();
  const prods = db.prepare(`SELECT p.name, sp.price, sp.is_default FROM supplier_products sp JOIN products p ON p.id = sp.product_id
    WHERE sp.supplier_id = ? ORDER BY sp.is_default DESC, p.name`).all(s.id);
  assert.equal(prods.length, 2, 'both products imported');
  assert.equal(prods[0].name, 'Yog\'li sut');
  assert.equal(prods[0].is_default, 1, 'first product is the default');
  assert.equal(prods[0].price, 5200);
  assert.equal(prods.find((p) => p.name === 'Yog\'siz sut').price, 3500);

  const out = await app.inject({ url: '/api/admin/suppliers-export.xlsx', headers: b });
  const back = new ExcelJS.Workbook();
  await back.xlsx.load(out.rawPayload);
  const rows = [];
  back.worksheets[0].eachRow((r) => rows.push(r.values.slice(1)));
  const fermer = rows.filter((r) => r[0] === 'Yangi Fermer');
  assert.equal(fermer.length, 2, 'two product rows exported for the household');
  assert.equal(fermer[0][6], 50000, 'current debt exported on the first row');
});

test('activity log is plain Uzbek', async () => {
  const { app } = setup();
  const h = await ali(app);
  const b = await boss(app);
  await runShift(app, h, 's1', [{ supplierId: 1, quantity: 20 }], { close: true });
  await acceptAll(app, b);
  await call(app, 'POST', '/api/admin/payments', b, { supplierId: 1, amount: 150000, method: 'cash' });
  const log = (await call(app, 'GET', '/api/admin/audit', b)).body;
  const texts = log.map((l) => l.what);
  assert.ok(texts.some((t) => /#1 smena yopildi: 1 ta yetkazib berish, 20 kg/.test(t)), texts.join('\n'));
  assert.ok(texts.some((t) => /#1 smena qabul qilindi/.test(t)));
  assert.ok(texts.some((t) => /To'lov: Karimova Oydin — 150 000 so'm \(naqd\)/.test(t)));
  assert.ok(log.some((l) => l.who === 'boss'));
});

test('migrates a v3 database (separate collectors, warehouses, approved shifts) to v4', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'yaya-')), 'v3.db');
  const old = new Database(file);
  upgradeToV3(old);
  const adminRole = old.prepare("SELECT id FROM roles WHERE code = 'admin'").get().id;
  old.exec(`
    INSERT INTO users (login, password_hash, role_id) VALUES ('admin', 'h', ${adminRole});
    INSERT INTO warehouses (name) VALUES ('Mashina');
    INSERT INTO suppliers (name) VALUES ('S');
    INSERT INTO products (name) VALUES ('Sut');
    INSERT INTO supplier_products VALUES (1, 1, 5000, 1);
    INSERT INTO employees (name, phone, pin_hash, warehouse_id) VALUES ('Ali', '901112233', 'pinhash', 1);
    INSERT INTO employee_suppliers VALUES (1, 1, 0);
    INSERT INTO shifts (client_uuid, employee_id, opened_at, closed_at, status) VALUES ('a', 1, '2026-10-01T05:00:00Z', 'x', 'approved'), ('b', 1, '2026-10-02T05:00:00Z', 'y', 'rejected');
    INSERT INTO collections (client_uuid, shift_uuid, employee_id, supplier_id, product_id, quantity, price, collected_at) VALUES ('c1', 'a', 1, 1, 1, 10, 5000, '2026-10-01T06:00:00Z');
    INSERT INTO collections (client_uuid, shift_uuid, employee_id, supplier_id, product_id, quantity, price, collected_at, voided_at) VALUES ('c2', 'a', 1, 1, 1, 99, 5000, '2026-10-01T06:00:00Z', 'v');
    INSERT INTO payments (client_uuid, supplier_id, amount, paid_at, created_by, employee_id) VALUES ('p', 1, 100, 'x', 'employee:901112233', 1);`);
  old.close();
  const db = openDb(file);
  const ali = db.prepare("SELECT * FROM users WHERE login = '901112233'").get();
  assert.equal(ali.password_hash, 'pinhash', 'PIN becomes the password');
  assert.equal(ali.role_id, roleIdByCode(db, 'collector'));
  assert.deepEqual(db.prepare('SELECT number, status FROM shifts ORDER BY number').all(), [{ number: 1, status: 'accepted' }, { number: 2, status: 'cancelled' }]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM collections').get().n, 1, 'voided pickups dropped');
  assert.equal(db.prepare('SELECT employee_id FROM collections').get().employee_id, ali.id);
  assert.equal(db.prepare('SELECT employee_id FROM payments').get().employee_id, ali.id);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name = 'employees'").get().n, 0);
  // The v3 warehouses are gone; the table of that name now is the Yaya 2.0 one, empty.
  assert.ok(db.prepare('PRAGMA table_info(warehouses)').all().some((c) => c.name === 'allow_negative'));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM warehouses WHERE is_stage = 0').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM warehouses WHERE is_stage = 1').get().n, 10, 'the production stages are created');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM devices WHERE user_id = ?').get(ali.id).n, 1);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  const perms = JSON.parse(db.prepare("SELECT permissions FROM roles WHERE code = 'collector'").get().permissions);
  assert.ok(perms.includes('collect.shift') && perms.includes('collect.delete_own'));
});

test('migrates a v1 database (admins table) all the way to v4', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'yaya-')), 'v1.db');
  const old = new Database(file);
  old.exec(`CREATE TABLE admins (id INTEGER PRIMARY KEY, login TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE suppliers (id INTEGER PRIMARY KEY, ext_id TEXT UNIQUE NOT NULL, name TEXT NOT NULL, synced_at TEXT);
    INSERT INTO admins (login, password_hash) VALUES ('admin', 'h');
    INSERT INTO settings VALUES ('jwt_secret', 'keep');`);
  old.close();
  const db = openDb(file);
  assert.equal(db.prepare("SELECT role_id FROM users WHERE login = 'admin'").get().role_id, roleIdByCode(db, 'admin'));
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'jwt_secret'").get().value, 'keep');
  assert.equal(db.pragma('user_version', { simple: true }), 4);
});

test('CSV neutralises formula injection', () => {
  const out = toCsv([{ a: '=HYPERLINK("x")', b: -5 }], [['a', 'A'], ['b', 'B']]);
  assert.ok(out.includes(`"'=HYPERLINK(""x"")"`));
  assert.ok(out.endsWith(';-5'));
});

test('delete current collector shifts: accepted ones stay, phones drop theirs, late uploads are ignored', async () => {
  const { app, db } = setup();
  const h = await ali(app);
  const b = await boss(app);
  await runShift(app, h, 'acc', [{ supplierId: 1, quantity: 20 }], { close: true });
  await acceptAll(app, b);
  await runShift(app, h, 'cur', [{ supplierId: 1, quantity: 7 }]);
  assert.equal(db.prepare("SELECT status FROM shifts WHERE client_uuid = 'cur'").get().status, 'open');
  assert.equal((await call(app, 'POST', '/api/admin/shifts/delete-active', b, { password: 'nope' })).status, 400);
  const r = await call(app, 'POST', '/api/admin/shifts/delete-active', b, { password: 'secret123' });
  assert.equal(r.status, 200);
  assert.equal(r.body.deleted.length, 1);
  assert.deepEqual(db.prepare('SELECT client_uuid FROM shifts').all().map((x) => x.client_uuid), ['acc'], 'accepted shift stays');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM collections WHERE shift_uuid = 'cur'").get().n, 0);
  // the phone is told to drop its copy
  assert.deepEqual((await call(app, 'GET', '/api/mobile/bootstrap', h)).body.deletedShifts, ['cur']);
  // a late upload of the deleted shift and its entries is accepted but ignored
  const late = await runShift(app, h, 'cur', [{ supplierId: 1, quantity: 3 }, { supplierId: 1, quantity: 4 }], { close: true });
  assert.deepEqual(late.shifts.accepted, ['cur']);
  assert.equal(late.accepted.length, 2);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM shifts WHERE client_uuid = 'cur'").get().n, 0);
  // the collector can open a new shift straight away
  const next = await runShift(app, h, 'new', [{ supplierId: 1, quantity: 5 }]);
  assert.deepEqual(next.shifts.accepted, ['new']);
  // a collector cannot delete
  assert.equal((await call(app, 'POST', '/api/admin/shifts/delete-active', h, { password: '1234' })).status, 403);
});

test('reports and movements wipe: what happened goes, what the system is made of stays; every table is classified', async () => {
  const { app, db } = setup();
  const h = await ali(app);
  const b = await boss(app);
  await runShift(app, h, 'w1', [{ supplierId: 1, quantity: 20 }], { close: true });
  await acceptAll(app, b);
  db.exec('UPDATE suppliers SET opening_balance = 5000');
  const keep = { users: db.prepare('SELECT COUNT(*) n FROM users').get().n, suppliers: db.prepare('SELECT COUNT(*) n FROM suppliers').get().n,
    prices: db.prepare('SELECT COUNT(*) n FROM supplier_products').get().n, products: db.prepare('SELECT COUNT(*) n FROM products').get().n,
    warehouses: db.prepare('SELECT COUNT(*) n FROM warehouses').get().n };
  assert.ok(db.prepare('SELECT COUNT(*) n FROM stock_moves').get().n > 0);
  const ch = (await call(app, 'GET', '/api/admin/data/challenge?kind=history', b)).body;
  assert.equal(ch.phrase, 'HISOBOTLARNI TOZALASH');
  const [x, y, z] = ch.question.match(/\d+/g).map(Number);
  assert.equal((await call(app, 'POST', '/api/admin/data/wipe-history', b, { password: 'secret123', challengeId: ch.id, answer: x * y - z, confirm: "HAMMASINI O'CHIRISH" })).status, 400);
  const ch2 = (await call(app, 'GET', '/api/admin/data/challenge?kind=history', b)).body;
  const [x2, y2, z2] = ch2.question.match(/\d+/g).map(Number);
  const r = await call(app, 'POST', '/api/admin/data/wipe-history', b, { password: 'secret123', challengeId: ch2.id, answer: x2 * y2 - z2, confirm: 'HISOBOTLARNI TOZALASH' });
  assert.equal(r.status, 200);
  for (const t of ['shifts', 'collections', 'payments', 'docs', 'stock_moves', 'lots', 'party_entries', 'alerts']) assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n, 0, `${t} empty`);
  assert.equal(db.prepare('SELECT SUM(opening_balance) s FROM suppliers').get().s, 0, 'starting balances to zero');
  assert.deepEqual({ users: db.prepare('SELECT COUNT(*) n FROM users').get().n, suppliers: db.prepare('SELECT COUNT(*) n FROM suppliers').get().n,
    prices: db.prepare('SELECT COUNT(*) n FROM supplier_products').get().n, products: db.prepare('SELECT COUNT(*) n FROM products').get().n,
    warehouses: db.prepare('SELECT COUNT(*) n FROM warehouses').get().n }, keep, 'master data stays');
  // still signed in, and the collector can start again
  assert.equal((await call(app, 'GET', '/api/auth/me', b)).status, 200);
  assert.deepEqual((await runShift(app, h, 'w2', [{ supplierId: 1, quantity: 5 }])).shifts.accepted, ['w2']);
  // every table is either history or kept — a new table must be put in one list on purpose
  const { HISTORY_TABLES, KEEP_TABLES } = await import('../src/backup.js');
  const all = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((t) => t.name);
  assert.deepEqual(all.filter((t) => !HISTORY_TABLES.includes(t) && !KEEP_TABLES.includes(t)), [], 'unclassified tables');
});
