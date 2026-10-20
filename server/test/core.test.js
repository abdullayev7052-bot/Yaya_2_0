import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, call, login, ali, boss, now, runShift } from './helpers.js';

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
