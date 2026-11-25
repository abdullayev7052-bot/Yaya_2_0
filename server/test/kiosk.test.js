import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, call, login, boss } from './helpers.js';

const K = '/api/kiosk';
const kh = (token) => ({ 'x-kiosk-token': token });

test('monoblock: paired once with a one-time code; people sign in with name + PIN, no device slot; revoking stops it', async () => {
  const { app, db, ids } = setup();
  const b = await boss(app);
  // only people marked "uses the monoblock" appear there (the accountant is not)
  db.prepare('UPDATE users SET kiosk = 1 WHERE id IN (?, ?)').run(ids.store, ids.ali);
  const id = (await call(app, 'POST', `${K}/admin`, b, { name: 'Sex monobloki', idleMinutes: 3, users: [ids.store, ids.ali, ids.acc] })).body.id;
  const code = (await call(app, 'POST', `${K}/admin/${id}/code`, b)).body.code;
  assert.match(code, /^\d{6}$/);
  assert.equal((await call(app, 'POST', `${K}/pair`, {}, { code: '000000' === code ? '111111' : '000000' })).status, 400);
  const paired = (await call(app, 'POST', `${K}/pair`, {}, { code })).body;
  assert.equal(paired.kiosk.idleMinutes, 3);
  const token = paired.token;
  assert.equal((await call(app, 'POST', `${K}/pair`, {}, { code })).status, 400, 'the code works once');

  const staff = (await call(app, 'GET', `${K}/staff`, kh(token))).body.staff;
  assert.deepEqual(staff.map((u) => u.id).sort(), [ids.store, ids.ali].sort(), 'only the people listed');
  assert.equal((await call(app, 'GET', `${K}/staff`, kh('wrong'))).status, 401);

  // no PIN yet
  assert.equal((await call(app, 'POST', `${K}/login`, kh(token), { userId: ids.store, pin: '1234' })).status, 403);
  assert.equal((await call(app, 'PUT', `${K}/admin/pin/${ids.store}`, b, { pin: '12' })).status, 400);
  await call(app, 'PUT', `${K}/admin/pin/${ids.store}`, b, { pin: '4321' });
  // someone not on this monoblock
  assert.equal((await call(app, 'POST', `${K}/login`, kh(token), { userId: ids.acc, pin: '4321' })).status, 403);
  const ok = await call(app, 'POST', `${K}/login`, kh(token), { userId: ids.store, pin: '4321' });
  assert.equal(ok.status, 200);
  const h = { authorization: `Bearer ${ok.body.token}` };
  assert.equal((await call(app, 'GET', '/api/erp/stock/mine', h)).status, 200, 'works without a device slot');
  // the person's own phone login still works too (the monoblock took no slot)
  assert.ok(await login(app, 'store', 'store123'));

  // five wrong PINs lock this person on this monoblock for a while
  for (let i = 0; i < 5; i++) assert.equal((await call(app, 'POST', `${K}/login`, kh(token), { userId: ids.store, pin: '0000' })).status, 401);
  assert.equal((await call(app, 'POST', `${K}/login`, kh(token), { userId: ids.store, pin: '4321' })).status, 429);

  // switching the monoblock off ends its sessions; unpairing kills its secret
  await call(app, 'PATCH', `${K}/admin/${id}`, b, { active: false });
  assert.equal((await call(app, 'GET', '/api/erp/stock/mine', h)).status, 401);
  await call(app, 'PATCH', `${K}/admin/${id}`, b, { active: true, unpair: true });
  assert.equal((await call(app, 'GET', `${K}/staff`, kh(token))).status, 401);
});

test('a person sets their own PIN from the phone with their password', async () => {
  const { app, db, ids } = setup();
  const s = await login(app, 'store', 'store123');
  // not marked for the monoblock: no PIN needed
  assert.equal((await call(app, 'PUT', `${K}/my-pin`, s, { pin: '5678', password: 'store123' })).status, 403);
  db.prepare('UPDATE users SET kiosk = 1 WHERE id = ?').run(ids.store);
  assert.equal((await call(app, 'PUT', `${K}/my-pin`, s, { pin: '5678', password: 'wrong' })).status, 400);
  assert.equal((await call(app, 'PUT', `${K}/my-pin`, s, { pin: '56', password: 'store123' })).status, 400);
  assert.equal((await call(app, 'PUT', `${K}/my-pin`, s, { pin: '5678', password: 'store123' })).status, 200);
});
