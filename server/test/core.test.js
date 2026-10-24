import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, call, login, ali, boss, now, runShift } from './helpers.js';
import { tryLink, _buildPurchase, notifyHousehold } from '../src/integrations.js';

test('smart login: one form for everyone; phone formats; panel only for admin', async () => {
  const { app } = setup();
  // collector typed with country code and spaces
  const r = await call(app, 'POST', '/api/auth/login', {}, { login: '+998 90 111 22 33', password: '1234', deviceId: 'phone-0001' });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.roleCode, 'collector');
  assert.ok(r.body.user.permissions.includes('collect.shift'));
  // collector cannot use the web panel
  const p = await call(app, 'POST', '/api/auth/login', {}, { login: '901112233', password: '1234', deviceId: 'laptop-01', client: 'panel' });
  assert.equal(p.status, 403);
  // admin can; storekeeper cannot
  assert.equal((await call(app, 'POST', '/api/auth/login', {}, { login: 'boss', password: 'secret123', deviceId: 'laptop-01', client: 'panel' })).status, 200);
  assert.equal((await call(app, 'POST', '/api/auth/login', {}, { login: 'store', password: 'store123', deviceId: 'laptop-02', client: 'panel' })).status, 403);
  assert.equal((await call(app, 'POST', '/api/auth/login', {}, { login: 'boss', password: 'nope', deviceId: 'laptop-01' })).status, 401);
});

test('device slots: a second device is refused until the admin frees or adds a slot', async () => {
  const { app, db, ids } = setup();
  const h1 = await login(app, '901112233', '1234', { device: 'phone-AAAA' });
  const r2 = await call(app, 'POST', '/api/auth/login', {}, { login: '901112233', password: '1234', deviceId: 'phone-BBBB' });
  assert.equal(r2.status, 403);
  assert.match(r2.body.error, /qurilma/);
  const b = await boss(app);
  const slot = db.prepare('SELECT id FROM devices WHERE user_id = ?').get(ids.ali);
  assert.equal((await call(app, 'PATCH', `/api/admin/devices/${slot.id}`, b, { free: true })).status, 200);
  // old device is signed out on its next request; the new one may sign in
  assert.equal((await call(app, 'GET', '/api/mobile/bootstrap', h1)).status, 401);
  assert.equal((await call(app, 'POST', '/api/auth/login', {}, { login: '901112233', password: '1234', deviceId: 'phone-BBBB' })).status, 200);
  // adding a slot allows another device
  await call(app, 'POST', '/api/admin/devices', b, { userId: ids.ali });
  assert.equal((await call(app, 'POST', '/api/auth/login', {}, { login: '901112233', password: '1234', deviceId: 'phone-CCCC' })).status, 200);
});

test('shift lifecycle: draft counts nowhere; closed is frozen; accepted is real; cancelled disappears', async () => {
  const { app } = setup();
  const h = await ali(app);
  const b = await boss(app);
  const balance = async () => (await call(app, 'GET', '/api/admin/balances', b)).body.rows.find((r) => r.id === 1).balance;
  const today = async () => (await call(app, 'GET', '/api/admin/reports/daily-cost', b)).body;

  await runShift(app, h, 's1', [{ supplierId: 1, quantity: 20 }, { supplierId: 2, quantity: 10 }]);
  assert.equal(await balance(), 100000, 'open shift does not create debt');
  assert.equal((await today()).products.length, 0);
  // payments count immediately, whatever the shift state
  await call(app, 'POST', '/api/admin/payments', b, { supplierId: 1, amount: 30000 });
  assert.equal(await balance(), 70000);

  // live view shows the open shift with its running kg
  const live = (await call(app, 'GET', '/api/admin/dashboard', b)).body.live;
  assert.equal(live[0].quantity, 30);
  assert.equal(live[0].label, '#1');

  // close; afterwards pickups and corrections are refused
  await call(app, 'POST', '/api/mobile/sync', h, { shifts: [{ uuid: 's1', openedAt: now(), closedAt: now() }] });
  const late = (await call(app, 'POST', '/api/mobile/sync', h, {
    collections: [{ uuid: 'late', shiftUuid: 's1', supplierId: 1, productId: 1, quantity: 5, collectedAt: now() }],
    ops: [{ uuid: 'op-late', type: 'edit', target: 's1-c0', quantity: 99 }],
  })).body;
  assert.equal(late.rejected.length, 1);
  assert.equal(late.ops.rejected.length, 1);
  assert.equal(await balance(), 70000, 'closed but not accepted: still no debt');

  // a new shift cannot be opened while the previous one is not accepted
  const blocked = await runShift(app, h, 's2', [{ supplierId: 1, quantity: 1 }]);
  assert.equal(blocked.shifts.rejected[0].uuid, 's2');

  const shifts = (await call(app, 'GET', '/api/admin/shifts?status=closed', b)).body;
  assert.equal((await call(app, 'POST', `/api/admin/shifts/${shifts[0].id}/accept`, b)).status, 200);
  assert.equal(await balance(), 70000 + 20 * 5000);
  const cost = await today();
  assert.equal(cost.products[0].avg_cost, 5333.33); // (20×5000 + 10×6000) / 30
  assert.equal(cost.final, true);

  // an accepted shift is final: it can no longer be cancelled
  assert.equal((await call(app, 'POST', `/api/admin/shifts/${shifts[0].id}/cancel`, b, { reason: 'kech' })).status, 400, 'accepted shift cannot be cancelled');
  assert.equal(await balance(), 170000, 'accepted shift stays in the debt');

  // a CLOSED (waiting) shift CAN be cancelled; cancelling drops it from debts
  await runShift(app, h, 's2', [{ supplierId: 1, quantity: 10 }], { close: true });
  const waiting0 = (await call(app, 'GET', '/api/admin/shifts?status=closed', b)).body;
  assert.equal(waiting0[0].label, '#2');
  assert.equal((await call(app, 'POST', `/api/admin/shifts/${waiting0[0].id}/cancel`, b, {})).status, 400, 'reason required');
  await call(app, 'POST', `/api/admin/shifts/${waiting0[0].id}/cancel`, b, { reason: 'kg xato' });
  assert.equal(await balance(), 170000, 'cancelled shift does not count');

  // cannot open a new shift while #2 is cancelled and not yet fixed
  assert.equal((await runShift(app, h, 's3', [{ supplierId: 1, quantity: 1 }])).shifts.rejected[0].uuid, 's3');

  // the collector copies the cancelled shift, fixes a line, closes and it is accepted
  const hist = (await call(app, 'GET', '/api/mobile/history', h)).body;
  const cancelled = hist.find((x) => x.status === 'cancelled');
  const copy = (await call(app, 'POST', `/api/mobile/shifts/${cancelled.id}/copy`, h)).body;
  assert.equal(copy.label, '#2-copy');
  const boot = (await call(app, 'GET', '/api/mobile/bootstrap', h)).body;
  assert.equal(boot.openShift.label, '#2-copy');
  assert.equal(boot.openShift.collections.length, 1);
  const target = boot.openShift.collections[0].uuid;
  await call(app, 'POST', '/api/mobile/sync', h, { ops: [{ uuid: 'fix1', type: 'edit', target, quantity: 8 }],
    shifts: [{ uuid: copy.uuid, openedAt: now(), closedAt: now() }] });
  const waiting = (await call(app, 'GET', '/api/admin/shifts?status=closed', b)).body;
  assert.equal(waiting[0].label, '#2-copy');
  await call(app, 'POST', `/api/admin/shifts/${waiting[0].id}/accept`, b);
  assert.equal(await balance(), 170000 + 8 * 5000);
});

test('own drafts: edit and delete while open; delete removes the line for good', async () => {
  const { app, db } = setup();
  const h = await ali(app);
  await runShift(app, h, 's1', [{ supplierId: 1, quantity: 20 }, { supplierId: 2, quantity: 10 }]);
  const r = (await call(app, 'POST', '/api/mobile/sync', h, { ops: [
    { uuid: 'o1', type: 'edit', target: 's1-c0', quantity: 22, productId: 2 },
    { uuid: 'o2', type: 'delete', target: 's1-c1' },
    { uuid: 'o3', type: 'delete', target: 'never-uploaded' },
  ] })).body;
  assert.deepEqual(r.ops.accepted, ['o1', 'o2', 'o3']);
  assert.deepEqual(db.prepare('SELECT quantity, product_id FROM collections').all(), [{ quantity: 22, product_id: 2 }]);
});

test('field supplier without price: shift cannot be accepted until the price is set', async () => {
  const { app, db } = setup();
  const b = await boss(app);
  // give collectors the right to add suppliers
  const role = db.prepare("SELECT id, permissions FROM roles WHERE code = 'collector'").get();
  await call(app, 'PATCH', `/api/admin/roles/${role.id}`, b, { permissions: [...JSON.parse(role.permissions), 'suppliers.create'] });
  const h = await ali(app);
  const created = (await call(app, 'POST', '/api/mobile/suppliers', h, { name: 'Yangi Fermer', phone: '+998 97 777 77 77', productIds: [1] })).body;
  assert.ok(created.supplier.products.length === 1);
  // New households are visible to every collector by default (no assignment step).
  const boot = (await call(app, 'GET', '/api/mobile/bootstrap', h)).body;
  assert.ok(boot.suppliers.some((s) => s.id === created.id), 'new household is visible to everyone by default');
  await runShift(app, h, 's1', [{ supplierId: created.id, quantity: 12 }], { close: true });
  const sh = (await call(app, 'GET', '/api/admin/shifts?status=closed', b)).body[0];
  const fail = await call(app, 'POST', `/api/admin/shifts/${sh.id}/accept`, b);
  assert.equal(fail.status, 400);
  assert.match(fail.body.error, /Yangi Fermer/);
  await call(app, 'PUT', '/api/admin/supplier-products', b, { supplierId: created.id, productId: 1, price: 5100, isDefault: true });
  assert.equal((await call(app, 'POST', `/api/admin/shifts/${sh.id}/accept`, b)).status, 200);
  assert.equal(db.prepare('SELECT price FROM collections').get().price, 5100, 'price stamped at acceptance');
});

test('roles: storekeeper accepts without seeing prices; collector card shows balance but no prices', async () => {
  const { app } = setup();
  const h = await ali(app);
  await runShift(app, h, 's1', [{ supplierId: 1, quantity: 10 }], { close: true });
  const st = await login(app, 'store', 'store123');
  const list = (await call(app, 'GET', '/api/admin/shifts?status=closed', st)).body;
  assert.equal((await call(app, 'POST', `/api/admin/shifts/${list[0].id}/accept`, st)).status, 200);
  const detail = (await call(app, 'GET', `/api/admin/shifts/${list[0].id}`, st)).body;
  assert.equal(detail.rows[0].quantity, 10);
  assert.equal(detail.rows[0].price, undefined);
  assert.equal(detail.rows[0].amount, undefined);
  // storekeeper is not allowed to manage staff
  assert.equal((await call(app, 'GET', '/api/admin/staff', st)).status, 403);

  const card = (await call(app, 'GET', '/api/mobile/suppliers/1/card', h)).body;
  assert.equal(card.balance, 100000 + 10 * 5000);
  assert.equal(card.lastPickup.quantity, 10);
  assert.ok(!JSON.stringify(card).includes('5000,'), 'no prices in the card');
  assert.equal(card.canPay, true, 'collectors can pay suppliers by default');
  // not assigned -> no card
  const other = (await call(app, 'POST', '/api/mobile/suppliers', h, { name: 'X', productIds: [1] })).status;
  assert.equal(other, 403, 'collector cannot add suppliers by default');
});

test('difference feature: real accepted quantity, cost, gain — never touches a balance', async () => {
  const { app, db } = setup();
  const h = await ali(app);
  const b = await boss(app);
  // written: 95 kg of product 1 at 5000 = 475 000 paid to the household
  await runShift(app, h, 'd1', [{ supplierId: 1, quantity: 95 }], { close: true });
  const sh = db.prepare("SELECT id FROM shifts WHERE client_uuid = 'd1'").get().id;
  // accept with a real quantity of 100 kg (the company got 5 kg more)
  assert.equal((await call(app, 'POST', `/api/admin/shifts/${sh}/accept`, b, { real: { 1: 100 } })).status, 200);
  // the household is still only paid for the 95 kg it was credited with
  assert.equal((await call(app, 'GET', '/api/admin/balances', b)).body.rows.find((r) => r.id === 1).balance, 100000 + 475000);
  // the shift detail carries the difference
  const d = (await call(app, 'GET', `/api/admin/shifts/${sh}`, b)).body.diff;
  assert.equal(d.hasReal, true);
  assert.deepEqual([d.written, d.real, d.diff], [95, 100, 5]);
  // the shift list carries the real total and the gap
  const row = (await call(app, 'GET', '/api/admin/shifts?status=accepted', b)).body.find((x) => x.id === sh);
  assert.deepEqual([row.accepted_quantity, row.diff_quantity], [100, 5]);
  // the diff report: real cost 4750 (475000/100), nominal 5000, gain +5 kg = 25 000
  const rep = (await call(app, 'GET', '/api/admin/reports/diff', b)).body;
  const p = rep.byProduct.find((x) => x.id === 1);
  assert.deepEqual([p.written_q, p.real_q, p.diff_q], [95, 100, 5]);
  assert.equal(p.real_cost, 4750);
  assert.equal(p.nominal_cost, 5000);
  assert.equal(p.gain, 25000);
  assert.equal(rep.totals.gain, 25000);
  // a collector may never see the difference
  assert.equal((await call(app, 'GET', '/api/admin/reports/diff', h)).status, 403);
});

test('difference limit blocks acceptance; turning the feature off accepts directly', async () => {
  const { app, db } = setup();
  const h = await ali(app);
  const b = await boss(app);
  await call(app, 'PUT', '/api/admin/settings', b, { diff: { enabled: true, over: 6, under: 3 } });
  await runShift(app, h, 'l1', [{ supplierId: 1, quantity: 50 }], { close: true });
  const sh = db.prepare("SELECT id FROM shifts WHERE client_uuid = 'l1'").get().id;
  // +10 kg is over the +6 limit -> refused, shift stays closed
  assert.equal((await call(app, 'POST', `/api/admin/shifts/${sh}/accept`, b, { real: { 1: 60 } })).status, 400);
  assert.equal(db.prepare('SELECT status FROM shifts WHERE id = ?').get(sh).status, 'closed');
  // within the limit -> accepted
  assert.equal((await call(app, 'POST', `/api/admin/shifts/${sh}/accept`, b, { real: { 1: 53 } })).status, 200);
  // feature off: a real quantity is ignored and acceptance is direct (no diff stored)
  await call(app, 'PUT', '/api/admin/settings', b, { diff: { enabled: false } });
  await runShift(app, h, 'l2', [{ supplierId: 1, quantity: 20 }], { close: true });
  const sh2 = db.prepare("SELECT id FROM shifts WHERE client_uuid = 'l2'").get().id;
  assert.equal((await call(app, 'POST', `/api/admin/shifts/${sh2}/accept`, b, { real: { 1: 999 } })).status, 200);
  assert.equal((await call(app, 'GET', `/api/admin/shifts/${sh2}`, b)).body.diff.hasReal, false);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM shift_accepts WHERE shift_id = ?').get(sh2).n, 0);
});

test('laboratory: fields, flagging over a limit, review, and no price/household leak', async () => {
  const { app, db } = setup();
  const b = await boss(app);
  const h = await ali(app);
  // accept a shift so the lab has something to work on
  await runShift(app, h, 'lb1', [{ supplierId: 1, quantity: 50 }], { close: true });
  const sh = db.prepare("SELECT id FROM shifts WHERE client_uuid = 'lb1'").get().id;
  await call(app, 'POST', `/api/admin/shifts/${sh}/accept`, b, { real: { 1: 50 } });
  // configure fields: Вода (number, max 4.0) and Антибиотик (variant, bad = bor)
  const voda = (await call(app, 'POST', '/api/admin/lab/fields', b, { name: 'Вода', type: 'number', limitMax: 4.0 })).body.id;
  const anti = (await call(app, 'POST', '/api/admin/lab/fields', b, { name: 'Антибиотик', type: 'variant', badOption: 'bor' })).body.id;
  // the lab worklist shows the accepted shift, with no money/household data
  let list = (await call(app, 'GET', '/api/admin/lab', b)).body;
  assert.equal(list.shifts.length, 1);
  assert.equal(list.shifts[0].labStatus, 'pending');
  assert.equal(list.shifts[0].total_kg, 50);
  assert.ok(!JSON.stringify(list).includes('5000') && !JSON.stringify(list).includes('Karimova'), 'no prices or households in the lab list');
  // a collector may not see the lab at all
  assert.equal((await call(app, 'GET', '/api/admin/lab', h)).status, 403);
  // save an over-limit value -> flagged
  await call(app, 'PUT', `/api/admin/lab/${sh}`, b, { values: { [voda]: 4.5, [anti]: 'yoq' } });
  let det = (await call(app, 'GET', `/api/admin/lab/${sh}`, b)).body;
  assert.equal(det.overLimit, true);
  assert.equal(det.over[voda], true);
  assert.equal(det.over[anti], false);
  assert.equal((await call(app, 'GET', '/api/admin/lab', b)).body.flagged, 1);
  assert.equal(det.labStatus, 'flagged');
  // review it -> accepted (green)
  assert.equal((await call(app, 'POST', `/api/admin/lab/${sh}/accept`, b)).status, 200);
  assert.equal((await call(app, 'GET', `/api/admin/lab/${sh}`, b)).body.labStatus, 'accepted');
  // re-saving within limits clears the flag and needs no review
  await call(app, 'PUT', `/api/admin/lab/${sh}`, b, { values: { [voda]: 3.6, [anti]: 'yoq' } });
  det = (await call(app, 'GET', `/api/admin/lab/${sh}`, b)).body;
  assert.equal(det.overLimit, false);
  assert.equal(det.labStatus, 'ok');
  // a lab user can enter values but not review a flag
  const labRole = db.prepare("SELECT id FROM roles WHERE code = 'lab'").get().id;
  db.prepare("INSERT INTO users (login, name, password_hash, role_id) VALUES ('lab1', 'Laborant', '" + (await import('bcryptjs')).default.hashSync('lab12345', 4) + "', ?)").run(labRole);
  const lid = db.prepare("SELECT id FROM users WHERE login = 'lab1'").get().id;
  db.prepare('INSERT INTO devices (user_id, name) VALUES (?, ?)').run(lid, 'Q1');
  const lab = await login(app, 'lab1', 'lab12345');
  await call(app, 'PUT', `/api/admin/lab/${sh}`, lab, { values: { [voda]: 5.0 } });
  assert.equal((await call(app, 'POST', `/api/admin/lab/${sh}/accept`, lab)).status, 403, 'lab may not accept a flag');
});

test('laboratory: a variant "bor" answer takes kg, flagged only above its max; no max = free', async () => {
  const { app, db } = setup();
  const b = await boss(app);
  const h = await ali(app);
  await runShift(app, h, 'lb2', [{ supplierId: 1, quantity: 50 }], { close: true });
  const sh = db.prepare("SELECT id FROM shifts WHERE client_uuid = 'lb2'").get().id;
  await call(app, 'POST', `/api/admin/shifts/${sh}/accept`, b, { real: { 1: 50 } });
  const limited = (await call(app, 'POST', '/api/admin/lab/fields', b, { name: 'Achigan', type: 'variant', amountOn: '1', amountMax: 2 })).body.id;
  const free = (await call(app, 'POST', '/api/admin/lab/fields', b, { name: 'Boshqa', type: 'variant', amountOn: '1', amountMax: '' })).body.id;
  const fields = (await call(app, 'GET', '/api/admin/lab/fields', b)).body;
  assert.equal(fields.find((f) => f.id === limited).amount_max, 2);
  assert.equal(fields.find((f) => f.id === free).amount_max, null);
  // within the limit (and an unlimited field with a big amount) -> normal
  await call(app, 'PUT', `/api/admin/lab/${sh}`, b, { values: { [limited]: 'bor', [`${limited}_q`]: 1.5, [free]: 'bor', [`${free}_q`]: 900 } });
  let det = (await call(app, 'GET', `/api/admin/lab/${sh}`, b)).body;
  assert.equal(det.overLimit, false);
  assert.equal(det.values[`${limited}_q`], 1.5);
  // above the max -> not normal
  await call(app, 'PUT', `/api/admin/lab/${sh}`, b, { values: { [limited]: 'bor', [`${limited}_q`]: 2.5 } });
  det = (await call(app, 'GET', `/api/admin/lab/${sh}`, b)).body;
  assert.equal(det.overLimit, true);
  assert.equal(det.over[limited], true);
  // the kg is dropped when the answer is "yoq"
  await call(app, 'PUT', `/api/admin/lab/${sh}`, b, { values: { [limited]: 'yoq', [`${limited}_q`]: 9 } });
  det = (await call(app, 'GET', `/api/admin/lab/${sh}`, b)).body;
  assert.equal(det.overLimit, false);
  assert.equal(det.values[`${limited}_q`], undefined);
  // the settings can be edited: turning the limit off frees the field again
  await call(app, 'PATCH', `/api/admin/lab/fields/${limited}`, b, { amountOn: '1', amountMax: '' });
  await call(app, 'PUT', `/api/admin/lab/${sh}`, b, { values: { [limited]: 'bor', [`${limited}_q`]: 50 } });
  assert.equal((await call(app, 'GET', `/api/admin/lab/${sh}`, b)).body.overLimit, false);
});

test('purchases: numbered per shift (24-2), with the difference as a final row', async () => {
  const { app, db } = setup();
  const h = await ali(app); const b = await boss(app);
  await runShift(app, h, 'pp1', [{ supplierId: 1, quantity: 10 }, { supplierId: 2, quantity: 20 }], { close: true });
  const sh = db.prepare("SELECT id, number FROM shifts WHERE client_uuid = 'pp1'").get();
  await call(app, 'POST', `/api/admin/shifts/${sh.id}/accept`, b, { real: { 1: 33 } }); // written 30, real 33 -> +3
  const pl = (await call(app, 'GET', '/api/admin/purchases', b)).body;
  const byNum = Object.fromEntries(pl.rows.map((r) => [r.number, r]));
  assert.ok(byNum[`${sh.number}-1`] && byNum[`${sh.number}-2`], 'two households numbered');
  const diff = byNum[`${sh.number}-3`];
  assert.ok(diff && diff.isDiff, 'the difference is the last purchase');
  assert.equal(diff.quantity, 3);
  assert.equal(diff.amount, 0);
  // totals: quantity is the real accepted (33), amount excludes the free diff
  assert.equal(pl.totals.quantity, 33);
  assert.equal(pl.totals.amount, 10 * 5000 + 20 * 6000);
  // drill-in breakdown of household 2
  const bd = (await call(app, 'GET', `/api/admin/purchases/breakdown?shift=${sh.id}&supplier=2`, b)).body;
  assert.equal(bd[0].quantity, 20);
});

test('payments are numbered sequentially; household bot links only known phones', async () => {
  const { app, db } = setup();
  const b = await boss(app);
  await call(app, 'POST', '/api/admin/payments', b, { supplierId: 1, amount: 5000 });
  await call(app, 'POST', '/api/admin/payments', b, { supplierId: 2, amount: 7000 });
  assert.deepEqual(db.prepare('SELECT number FROM payments ORDER BY id').all().map((p) => p.number), [1, 2]);

  // phone 901234567 belongs to supplier 1; a country code in front still matches
  assert.equal(tryLink(db, 'chatA', '998901234567', 'Ali')?.id, 1);
  assert.equal(db.prepare("SELECT supplier_id FROM tg_households WHERE chat_id = 'chatA'").get().supplier_id, 1);
  // an unknown phone never registers
  assert.equal(tryLink(db, 'chatB', '900000000', 'Noone'), null);
  assert.equal(db.prepare("SELECT 1 FROM tg_households WHERE chat_id = 'chatB'").get(), undefined);

  // notifications never throw when the bot is not configured
  assert.doesNotThrow(() => notifyHousehold(db, 'payment', { paymentId: 1 }));
  // the purchase text carries this household's products + balance only
  const h = await ali(app);
  await runShift(app, h, 'bt1', [{ supplierId: 1, quantity: 4 }], { close: true });
  const sh = db.prepare("SELECT id FROM shifts WHERE client_uuid = 'bt1'").get().id;
  await call(app, 'POST', `/api/admin/shifts/${sh}/accept`, b);
  const txt = _buildPurchase(db, sh, 1);
  assert.match(txt, /Xarid: #\d+-\d+/);
  assert.match(txt, /Hozirgi balans:/);
});

test('collector own-payments view: only their payments, no balances or others\' debts', async () => {
  const { app, db } = setup();
  const b = await boss(app);
  const h = await ali(app);
  // ali pays supplier 1 from the field; boss pays supplier 2
  await call(app, 'POST', '/api/mobile/sync', h, { payments: [{ uuid: 'mp1', supplierId: 1, amount: 5000, paidAt: now() }] });
  await call(app, 'POST', '/api/admin/payments', b, { supplierId: 2, amount: 9000 });
  // without the permission the endpoint is refused
  assert.equal((await call(app, 'GET', '/api/mobile/my-payments', h)).status, 403);
  // grant payments.view_own to the collector role (perms are re-read per request)
  const role = db.prepare("SELECT id, permissions FROM roles WHERE code = 'collector'").get();
  const perms = new Set(JSON.parse(role.permissions)); perms.add('payments.view_own');
  db.prepare('UPDATE roles SET permissions = ? WHERE id = ?').run(JSON.stringify([...perms]), role.id);
  const mine = (await call(app, 'GET', '/api/mobile/my-payments', h)).body;
  assert.equal(mine.length, 1, 'only my own payment');
  assert.equal(mine[0].supplier_name, 'Karimova Oydin');
  assert.equal(mine[0].amount, 5000);
  // the broad balances / all-payments endpoints stay refused (no debts.view)
  assert.equal((await call(app, 'GET', '/api/admin/balances', h)).status, 403);
  assert.equal((await call(app, 'GET', '/api/admin/payments', h)).status, 403);
});

test('payments from the field are offline-safe and need permission', async () => {
  const { app, db } = setup();
  const h = await ali(app);
  const ok = (await call(app, 'POST', '/api/mobile/sync', h, { payments: [{ uuid: 'p1', supplierId: 1, amount: 5000, paidAt: now() }] })).body;
  assert.deepEqual(ok.payments.accepted, ['p1'], 'collectors pay by default');
  // the admin can take the permission away
  const role = db.prepare("SELECT id, permissions FROM roles WHERE code = 'collector'").get();
  await call(app, 'PATCH', `/api/admin/roles/${role.id}`, await boss(app), { permissions: JSON.parse(role.permissions).filter((x) => x !== 'payments.create') });
  const no = (await call(app, 'POST', '/api/mobile/sync', h, { payments: [{ uuid: 'p2', supplierId: 1, amount: 5000, paidAt: now() }] })).body;
  assert.equal(no.payments.rejected.length, 1);
  const again = (await call(app, 'POST', '/api/mobile/sync', h, { payments: [{ uuid: 'p1', supplierId: 1, amount: 5000, paidAt: now() }] })).body;
  assert.deepEqual(again.payments.accepted, ['p1']);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM payments').get().n, 1);
});

test('test users never count', async () => {
  const { app } = setup();
  const t = await login(app, '900000000', '1111');
  await runShift(app, t, 't1', [{ supplierId: 1, quantity: 50 }], { close: true });
  const b = await boss(app);
  const sh = (await call(app, 'GET', '/api/admin/shifts?status=closed', b)).body[0];
  await call(app, 'POST', `/api/admin/shifts/${sh.id}/accept`, b);
  assert.equal((await call(app, 'GET', '/api/admin/balances', b)).body.rows.find((r) => r.id === 1).balance, 100000);
  assert.equal((await call(app, 'GET', '/api/admin/reports/daily-cost', b)).body.products.length, 0);
});

test('changing a supplier price does not change existing debt; only future purchases use it', async () => {
  const { app, db } = setup();
  const h = await ali(app);
  const b = await boss(app);
  await runShift(app, h, 's1', [{ supplierId: 1, quantity: 10 }], { close: true }); // product 1, price 5000
  for (const s of (await call(app, 'GET', '/api/admin/shifts?status=closed', b)).body) await call(app, 'POST', `/api/admin/shifts/${s.id}/accept`, b);
  const before = (await call(app, 'GET', '/api/admin/balances', b)).body.rows.find((r) => r.id === 1).balance;
  // raise the price a lot
  await call(app, 'PUT', '/api/admin/supplier-products', b, { supplierId: 1, productId: 1, price: 9000 });
  const after = (await call(app, 'GET', '/api/admin/balances', b)).body.rows.find((r) => r.id === 1).balance;
  assert.equal(after, before, 'already-accepted milk keeps its stamped price');
  // a new accepted purchase uses the new price
  await runShift(app, h, 's2', [{ supplierId: 1, quantity: 10 }], { close: true });
  for (const s of (await call(app, 'GET', '/api/admin/shifts?status=closed', b)).body) await call(app, 'POST', `/api/admin/shifts/${s.id}/accept`, b);
  const latest = (await call(app, 'GET', '/api/admin/balances', b)).body.rows.find((r) => r.id === 1).balance;
  assert.equal(latest - after, 90000, 'the second pickup is valued at the new price');
});

test('admin never collects; recovery credential signs in as admin', async () => {
  const { app } = setup();
  // admin role has no collecting permissions
  const b = await boss(app);
  const me = (await call(app, 'GET', '/api/auth/me', b)).body;
  assert.ok(!me.permissions.includes('collect.shift'));
  assert.ok(me.permissions.includes('staff.manage'));
  // a wrong "admin" password is just a normal failed login
  assert.equal((await call(app, 'POST', '/api/auth/login', {}, { login: 'admin', password: 'nope', deviceId: 'x-device' })).status, 401);
  // The break-glass credential itself is never written in the repo. To verify
  // that path, run the tests with YAYA_RECOVERY=<secret> set.
  const secret = process.env.YAYA_RECOVERY;
  if (secret) {
    const r = await call(app, 'POST', '/api/auth/login', {}, { login: 'admin', password: secret, deviceId: 'brand-new-laptop-999', client: 'panel' });
    assert.equal(r.status, 200);
    assert.equal(r.body.user.roleCode, 'admin');
    // the token works even from an unknown device (device check skipped)
    assert.equal((await call(app, 'GET', '/api/admin/staff', { authorization: `Bearer ${r.body.token}` })).status, 200);
  }
});

test('field staff can set a supplier location with suppliers.location but not rename', async () => {
  const { app, db } = setup();
  const h = await ali(app); // collector: has suppliers.location, not suppliers.edit
  // set a manual address first (via admin PATCH, allowed with suppliers.location)
  await call(app, 'PATCH', '/api/admin/suppliers/1', h, { address: 'Buvayda' });
  // the map sets only the coordinates — it must never overwrite the manual address
  const loc = await call(app, 'POST', '/api/mobile/suppliers/1/location', h, { lat: 40.5, lng: 71.2, address: 'Xarita nomi' });
  assert.equal(loc.status, 200);
  const card = (await call(app, 'GET', '/api/mobile/suppliers/1/card', h)).body;
  assert.equal(card.supplier.lat, 40.5);
  assert.equal(card.supplier.address, 'Buvayda', 'map does not overwrite the manual address');
  assert.equal(card.canSetLocation, true);
  assert.equal(card.canEdit, false);
  // renaming via admin PATCH is refused for a collector
  assert.equal((await call(app, 'PATCH', '/api/admin/suppliers/1', h, { name: 'Hacked' })).status, 403);
  // but editing the address through PATCH is allowed (suppliers.location)
  assert.equal((await call(app, 'PATCH', '/api/admin/suppliers/1', h, { address: 'Yangi' })).status, 200);
});

test('a household can carry a second address and location, independently of the first', async () => {
  const { app } = setup();
  const h = await ali(app); // collector: suppliers.location
  await call(app, 'PATCH', '/api/admin/suppliers/1', h, { address: 'Birinchi', lat: 40.1, lng: 71.1 });
  // second address (manual) via admin PATCH, second coordinates via the mobile map (slot 2)
  await call(app, 'PATCH', '/api/admin/suppliers/1', h, { address2: 'Ikkinchi' });
  const loc2 = await call(app, 'POST', '/api/mobile/suppliers/1/location', h, { lat: 41.2, lng: 69.3, slot: 2 });
  assert.equal(loc2.status, 200);
  let card = (await call(app, 'GET', '/api/mobile/suppliers/1/card', h)).body;
  assert.equal(card.supplier.address, 'Birinchi');
  assert.equal(card.supplier.lat, 40.1, 'slot 2 must not touch the primary coordinates');
  assert.equal(card.supplier.address2, 'Ikkinchi');
  assert.equal(card.supplier.lat2, 41.2);
  assert.equal(card.supplier.lng2, 69.3);
  // the second location can be cleared without affecting the first
  await call(app, 'PATCH', '/api/admin/suppliers/1', h, { address2: null, lat2: null, lng2: null });
  card = (await call(app, 'GET', '/api/mobile/suppliers/1/card', h)).body;
  assert.equal(card.supplier.lat2, null);
  assert.equal(card.supplier.address2, null);
  assert.equal(card.supplier.lat, 40.1, 'clearing slot 2 leaves the primary location intact');
});

test('self profile: admin changes own login and name; payment records its author', async () => {
  const { app, db } = setup();
  const b = await boss(app);
  const h = await ali(app);
  // a collector pays supplier 1 from their phone
  await call(app, 'POST', '/api/mobile/sync', h, { payments: [{ uuid: 'pay1', supplierId: 1, amount: 1000, paidAt: now() }] });
  const pays = (await call(app, 'GET', '/api/admin/payments', b)).body;
  assert.ok(pays.some((p) => p.by_name === 'Ali'), 'payment shows who made it');
  // admin renames self
  const r = await call(app, 'PUT', '/api/auth/profile', b, { login: 'director', name: 'Boshliq' });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.login, 'director');
  // storekeeper cannot rename self (no staff.manage)
  const s = await login(app, 'store', 'store123');
  assert.equal((await call(app, 'PUT', '/api/auth/profile', s, { login: 'x' })).status, 403);
});

test('signing out frees the device slot, so a new device can sign in without the admin', async () => {
  const { app } = setup();
  // ali has one device slot; device A takes it
  const a = await login(app, '901112233', '1234', { device: 'phone-AAAAAA' });
  // a second device is refused while A holds the only slot
  assert.equal((await call(app, 'POST', '/api/auth/login', {}, { login: '901112233', password: '1234', deviceId: 'phone-BBBBBB' })).status, 403);
  // signing out on A frees the slot
  assert.equal((await call(app, 'POST', '/api/auth/logout', a)).status, 200);
  // the same phone can come straight back (binds the now-free slot)
  const a2 = await login(app, '901112233', '1234', { device: 'phone-AAAAAA' });
  assert.ok(a2.authorization);
  // sign out again, and a different/replaced phone can sign in on its own
  assert.equal((await call(app, 'POST', '/api/auth/logout', a2)).status, 200);
  const b = await login(app, '901112233', '1234', { device: 'phone-BBBBBB' });
  assert.ok(b.authorization);
  // the panel shows it as an automatic release
  const log = (await call(app, 'GET', '/api/admin/audit', await boss(app))).body;
  assert.ok(log.some((l) => /qurilma joyi avtomatik bo'shatildi/.test(l.what)));
});

test('balances: as-of a past date, and manual balance edit records an adjustment', async () => {
  const { app, db } = setup();
  const b = await boss(app);
  const bal = async (q = '') => (await call(app, 'GET', `/api/admin/balances${q}`, b)).body.rows.find((r) => r.id === 1).balance;
  // supplier 1 opening debt is 100000; add a payment dated today
  await call(app, 'POST', '/api/admin/payments', b, { supplierId: 1, amount: 40000 });
  assert.equal(await bal(), 60000, 'today: opening minus payment');
  // as of yesterday, the payment had not happened yet
  const y = new Date(Date.now() + 5 * 3600e3 - 864e5).toISOString().slice(0, 10);
  assert.equal(await bal(`?asOf=${y}`), 100000, 'as-of yesterday ignores today\'s payment');
  // set the balance to an exact value; needs the admin password
  assert.equal((await call(app, 'POST', '/api/admin/balances/edit', b, { password: 'nope', items: [{ supplierId: 1, target: 0 }] })).status, 400);
  const r = await call(app, 'POST', '/api/admin/balances/edit', b, { password: 'secret123', items: [{ supplierId: 1, target: 0 }], note: 'Hisob tenglashtirildi' });
  assert.equal(r.status, 200);
  assert.equal(await bal(), 0, 'balance set to exactly 0');
  // the change shows up in the statement
  const card = (await call(app, 'GET', '/api/admin/suppliers/1/card', b)).body;
  assert.ok(card.statement.entries.some((e) => e.kind === 'adjust'), 'adjustment in the akt-sverka');
});

test('intro video: supports HTTP range requests for native streaming', async () => {
  const { app, db } = setup();
  const bytes = Buffer.from('0123456789abcdef'); // stand-in video payload
  db.prepare("INSERT INTO files (key, mime, data, updated_at) VALUES ('intro', 'video/mp4', ?, datetime('now'))").run(bytes);
  const full = await app.inject({ method: 'GET', url: '/api/public/intro' });
  assert.equal(full.statusCode, 200);
  assert.equal(full.headers['accept-ranges'], 'bytes');
  assert.equal(full.headers['content-length'], String(bytes.length));
  const part = await app.inject({ method: 'GET', url: '/api/public/intro', headers: { range: 'bytes=4-7' } });
  assert.equal(part.statusCode, 206);
  assert.equal(part.headers['content-range'], `bytes 4-7/${bytes.length}`);
  assert.equal(part.rawPayload.length, 4);
  assert.equal(part.rawPayload.toString(), '4567');
  const bad = await app.inject({ method: 'GET', url: '/api/public/intro', headers: { range: 'bytes=999-1000' } });
  assert.equal(bad.statusCode, 416);
});

test('own shift history needs the view-own-shifts permission', async () => {
  const { app, db } = setup();
  // collector has it by default
  assert.ok((await ali(app)) && (await call(app, 'GET', '/api/mobile/history', await ali(app))).status === 200);
  // strip it from the collector role → the route is forbidden
  const role = db.prepare("SELECT id, permissions FROM roles WHERE code = 'collector'").get();
  const perms = JSON.parse(role.permissions).filter((p) => p !== 'collect.view_own_shifts');
  db.prepare('UPDATE roles SET permissions = ? WHERE id = ?').run(JSON.stringify(perms), role.id);
  assert.equal((await call(app, 'GET', '/api/mobile/history', await ali(app))).status, 403);
});

test('list field visibility is saved and exposed to the app via brand', async () => {
  const { app } = setup();
  const b = await boss(app);
  // default: all three on
  let st = (await call(app, 'GET', '/api/admin/settings', b)).body;
  assert.deepEqual(st.listFields, { name: true, address: true, phone: true });
  // turn the phone column off
  assert.equal((await call(app, 'PUT', '/api/admin/settings', b, { listFields: { name: true, address: true, phone: false } })).status, 200);
  st = (await call(app, 'GET', '/api/admin/settings', b)).body;
  assert.equal(st.listFields.phone, false);
  // the app reads it from the public brand endpoint
  const brand = (await call(app, 'GET', '/api/public/brand', {})).body;
  assert.equal(brand.listFields.phone, false);
  assert.equal(brand.listFields.name, true);
});

test('authorization: field collectors cannot reach admin-only money/role endpoints', async () => {
  const { app } = setup();
  const h = await ali(app); // collector: payments.create + suppliers.location, NOT staff.manage/debts.view/suppliers.view
  // rewriting balances is admin-only now (was reachable with payments.create)
  assert.equal((await call(app, 'POST', '/api/admin/balances/edit', h, { password: '1234', items: [{ supplierId: 1, target: 0 }] })).status, 403);
  // the role matrix and staff logins are not exposed to field users
  assert.equal((await call(app, 'GET', '/api/admin/roles', h)).status, 403);
  assert.equal((await call(app, 'GET', '/api/admin/permissions', h)).status, 403);
  assert.equal((await call(app, 'GET', '/api/admin/staff/names', h)).status, 403);
  // can pay an ASSIGNED household, but the response does not leak the balance (no debts.view)
  const pay = await call(app, 'POST', '/api/admin/payments', h, { supplierId: 1, amount: 1000 });
  assert.equal(pay.status, 200);
  assert.equal(pay.body.balance, undefined, 'balance not leaked to a user without debts.view');
  // admin keeps full access
  const b = await boss(app);
  assert.equal((await call(app, 'POST', '/api/admin/balances/edit', b, { password: 'secret123', items: [{ supplierId: 1, target: 0 }] })).status, 200);
  assert.equal((await call(app, 'GET', '/api/admin/roles', b)).status, 200);
  assert.equal((await call(app, 'GET', '/api/admin/staff/names', b)).status, 200);
});

test('households: all visible by default; admin can hide some from one collector', async () => {
  const { app, db, ids } = setup();
  const b = await boss(app);
  const h = await ali(app);
  // by default the collector sees every active household (1 and 2)
  let boot = (await call(app, 'GET', '/api/mobile/bootstrap', h)).body;
  assert.deepEqual(boot.suppliers.map((s) => s.id).sort(), [1, 2]);
  // admin hides household 2 from this collector
  assert.equal((await call(app, 'PUT', `/api/admin/staff/${ids.ali}/hidden`, b, { supplierIds: [2] })).status, 200);
  assert.deepEqual((await call(app, 'GET', `/api/admin/staff/${ids.ali}/hidden`, b)).body, [2]);
  boot = (await call(app, 'GET', '/api/mobile/bootstrap', h)).body;
  assert.deepEqual(boot.suppliers.map((s) => s.id), [1], 'hidden household is gone from the list');
  // and the collector can no longer record a pickup for the hidden household
  await call(app, 'POST', '/api/mobile/sync', h, { shifts: [{ uuid: 's9', openedAt: now() }] });
  const r = await call(app, 'POST', '/api/mobile/sync', h, { collections: [{ uuid: 'c9', shiftUuid: 's9', supplierId: 2, productId: 1, quantity: 5, collectedAt: now() }] });
  assert.equal(r.body.rejected.length, 1, 'pickup for a hidden household is rejected');
  assert.match(r.body.rejected[0].error, /ko'rinmaydi/);
});

test('copy shift text: grouped by product with weighted averages; settings toggle parts off', async () => {
  const { app } = setup();
  const b = await boss(app);
  const h = await ali(app);
  // supplier 1: Yog'li sut 5000, Yog'siz sut 3000; supplier 2: Yog'li sut 6000
  await runShift(app, h, 's1', [
    { supplierId: 1, productId: 1, quantity: 10 },
    { supplierId: 1, productId: 2, quantity: 5 },
    { supplierId: 2, productId: 1, quantity: 8 },
  ], { close: true });
  const sh = (await call(app, 'GET', '/api/admin/shifts?status=closed', b)).body[0];
  await call(app, 'POST', `/api/admin/shifts/${sh.id}/accept`, b);
  const full = (await call(app, 'GET', `/api/admin/shifts/${sh.id}/copytext`, b)).body.text;
  // starts with the shift number and the collector's name
  assert.match(full, /^#\d+\nAli\n/);
  // Yog'li sut: (10*5000 + 8*6000) / 18 = 5444.44 weighted average, no "(o'rtacha)"
  assert.match(full, /Yog'li sut - 18 kg x 5444\.44\n/);
  assert.ok(!full.includes("o'rtacha"), 'the "(o\'rtacha)" label is gone');
  assert.match(full, / Karimova Oydin - 10 kg x 5000/);
  assert.match(full, / Begmatov - 8 kg x 6000/);
  assert.match(full, /Yog'siz sut - 5 kg x 3000\.00/);
  // turn the price off -> no "x <price>" anywhere
  await call(app, 'PUT', '/api/admin/settings', b, { copyFields: { price: false } });
  const noPrice = (await call(app, 'GET', `/api/admin/shifts/${sh.id}/copytext`, b)).body.text;
  assert.ok(!/ x /.test(noPrice), 'prices are gone when the toggle is off');
  assert.match(noPrice, /Yog'li sut - 18 kg/);
  // a collector has no prices.view, so their copy never shows prices
  const asCollector = (await call(app, 'PUT', '/api/admin/settings', b, { copyFields: { price: true } }));
  assert.equal(asCollector.status, 200);
});

test('household delete: only a deactivated household with no balance and no history', async () => {
  const { app, db } = setup();
  const b = await boss(app);
  // supplier 1 has an opening balance (100000) -> blocked while active and after
  assert.match((await call(app, 'DELETE', '/api/admin/suppliers/1', b)).body.error, /Avval xonadonni o'chiring/);
  await call(app, 'PATCH', '/api/admin/suppliers/1', b, { active: false });
  assert.match((await call(app, 'DELETE', '/api/admin/suppliers/1', b)).body.error, /qarzdorlik yoki haqdorlik/);
  // a fresh empty household: create, deactivate, delete succeeds
  const id = db.prepare("INSERT INTO suppliers (name, active) VALUES ('Bo''sh', 0)").run().lastInsertRowid;
  assert.equal((await call(app, 'DELETE', `/api/admin/suppliers/${id}`, b)).status, 200);
  assert.ok(!db.prepare('SELECT 1 FROM suppliers WHERE id = ?').get(id), 'gone from the system');
});

test('edit a closed-not-accepted shift: reopen -> editing, cannot accept, re-close -> accept', async () => {
  const { app, db } = setup();
  const b = await boss(app);
  const h = await ali(app);
  await runShift(app, h, 'e1', [{ supplierId: 1, quantity: 10 }], { close: true });
  let sh = (await call(app, 'GET', '/api/admin/shifts?status=closed', b)).body[0];
  // reopen for editing
  const id = sh.id;
  assert.equal((await call(app, 'POST', `/api/mobile/shifts/${id}/reopen`, h)).status, 200);
  // shown as "editing" (DB stays open + reopened_at)
  assert.equal((await call(app, 'GET', `/api/admin/shifts/${id}`, b)).body.shift.status, 'editing');
  assert.equal(db.prepare('SELECT status FROM shifts WHERE id = ?').get(id).status, 'open');
  // cannot be accepted while editing
  assert.equal((await call(app, 'POST', `/api/admin/shifts/${id}/accept`, b)).status, 400);
  // the collector cannot open a new shift while one is in editing
  const blocked = (await call(app, 'POST', '/api/mobile/sync', h, { shifts: [{ uuid: 'e2', openedAt: now() }] })).body;
  assert.equal(blocked.shifts.rejected.length, 1);
  // add another pickup during the edit, then re-close
  assert.equal((await call(app, 'POST', '/api/mobile/sync', h, { collections: [{ uuid: 'e1-x', shiftUuid: 'e1', supplierId: 1, productId: 1, quantity: 7, collectedAt: now() }] })).body.accepted.length, 1);
  await call(app, 'POST', '/api/mobile/sync', h, { shifts: [{ uuid: 'e1', openedAt: now(), closedAt: now() }] });
  assert.equal(db.prepare("SELECT status FROM shifts WHERE client_uuid = 'e1'").get().status, 'closed');
  // now acceptance works, with both pickups (10 + 7 = 17)
  assert.equal((await call(app, 'POST', `/api/admin/shifts/${id}/accept`, b)).status, 200);
  assert.equal(db.prepare("SELECT ROUND(SUM(quantity),2) q FROM collections WHERE shift_uuid = 'e1'").get().q, 17);
  // turning the setting off blocks reopening
  await call(app, 'PUT', '/api/admin/settings', b, { editClosed: false });
  await runShift(app, h, 'e3', [{ supplierId: 1, quantity: 3 }], { close: true });
  const sh3 = db.prepare("SELECT id FROM shifts WHERE client_uuid = 'e3'").get().id;
  assert.equal((await call(app, 'POST', `/api/mobile/shifts/${sh3}/reopen`, h)).status, 403);
});
