import bcrypt from 'bcryptjs';
import { openDb, roleIdByCode, ensureDeviceSlots } from '../src/db/index.js';
import { buildApp } from '../src/app.js';

// A small company: admin, storekeeper, accountant, a collector and a test user.
export function setup() {
  const db = openDb(':memory:');
  db.exec(`
    INSERT INTO suppliers (id, name, phone, opening_balance) VALUES (1, 'Karimova Oydin', '901234567', 100000), (2, 'Begmatov', '931112233', 0);
    INSERT INTO products (id, name, unit) VALUES (1, 'Yog''li sut', 'kg'), (2, 'Yog''siz sut', 'kg');
    INSERT INTO supplier_products (supplier_id, product_id, price, is_default) VALUES (1, 1, 5000, 1), (1, 2, 3000, 0), (2, 1, 6000, 1);`);
  const add = (login, pass, code, extra = {}) => {
    const id = Number(db.prepare('INSERT INTO users (login, name, password_hash, role_id, is_test) VALUES (?, ?, ?, ?, ?)')
      .run(login, extra.name ?? login, bcrypt.hashSync(pass, 4), roleIdByCode(db, code), extra.isTest ? 1 : 0).lastInsertRowid);
    ensureDeviceSlots(db, id);
    return id;
  };
  const ids = {
    boss: add('boss', 'secret123', 'admin'),
    store: add('store', 'store123', 'storekeeper'),
    acc: add('acc', 'acc12345', 'viewer'),
    ali: add('901112233', '1234', 'collector', { name: 'Ali' }),
    test: add('900000000', '1111', 'collector', { name: 'Test', isTest: true }),
  };
  db.exec(`INSERT INTO employee_suppliers (employee_id, supplier_id) VALUES (${ids.ali}, 1), (${ids.ali}, 2), (${ids.test}, 1)`);
  const app = buildApp({ db, jwtSecret: 't', rateLimit: false });
  return { db, app, ids };
}

export const call = (app, method, url, headers, payload) =>
  app.inject({ method, url, headers, payload }).then((r) => ({ status: r.statusCode, body: r.headers['content-type']?.includes('json') ? r.json() : r.body, raw: r }));

export async function login(app, loginName, password, { device = `device-${loginName}`, client = 'app' } = {}) {
  const r = await call(app, 'POST', '/api/auth/login', {}, { login: loginName, password, deviceId: device, client });
  if (r.status !== 200) throw new Error(`login ${loginName}: ${r.status} ${JSON.stringify(r.body)}`);
  return { authorization: `Bearer ${r.body.token}` };
}

export const ali = (app) => login(app, '901112233', '1234');
export const boss = (app) => login(app, 'boss', 'secret123');
export const now = () => new Date().toISOString();

// Open a shift on the phone side, add pickups, optionally close it.
export async function runShift(app, h, uuid, pickups, { close = false } = {}) {
  return (await call(app, 'POST', '/api/mobile/sync', h, {
    shifts: [{ uuid, openedAt: now(), closedAt: close ? now() : null }],
    collections: pickups.map((p, i) => ({ uuid: `${uuid}-c${i}`, shiftUuid: uuid, collectedAt: now(), productId: 1, ...p })),
  })).body;
}
