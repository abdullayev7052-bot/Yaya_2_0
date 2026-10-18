import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { BUILTIN_ROLES, V3_TO_V4, PERMISSION_KEYS } from '../permissions.js';
import { upgradeToV3 } from './legacy.js';

export const SCHEMA_VERSION = 4;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE,                       -- set for built-in roles only
  name TEXT NOT NULL,
  permissions TEXT NOT NULL DEFAULT '[]', -- JSON array of permission keys
  locked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Every staff member: owner, manager, storekeeper, accountant, milk collector.
-- is_test users (the in-panel app tester) never count in reports or debts.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  login TEXT UNIQUE NOT NULL,
  name TEXT,
  phone TEXT,
  password_hash TEXT NOT NULL,
  role_id INTEGER REFERENCES roles(id),
  is_test INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Device slots: a user can sign in only on as many devices as they have slots.
-- A slot is bound to a device id on first sign-in; the admin can free it.
CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT,
  device_id TEXT,
  device_label TEXT,
  bound_at TEXT,
  last_seen_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS files (
  key TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  data BLOB NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- opening_balance: what we owed the supplier when entered into Yaya
-- (positive = we owe them, negative = they owe us).
CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  address TEXT,
  note TEXT,
  opening_balance REAL NOT NULL DEFAULT 0,
  lat REAL,
  lng REAL,
  active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'kg',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- price may be empty for a supplier added in the field; a shift cannot be
-- accepted until every supplier in it has a price.
CREATE TABLE IF NOT EXISTS supplier_products (
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  price REAL CHECK (price IS NULL OR price >= 0),
  is_default INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (supplier_id, product_id)
);

-- Which collector (user) is responsible for which suppliers.
CREATE TABLE IF NOT EXISTS employee_suppliers (
  employee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (employee_id, supplier_id)
);

-- A shift is a draft while open: nothing in it counts anywhere. Closing it
-- freezes its contents; accepting it makes it real (stock, debts, cost).
-- open -> closed -> accepted | cancelled. A cancelled shift can be copied into
-- a new open shift with the same number and the next copy_no.
CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY,
  client_uuid TEXT UNIQUE NOT NULL,
  number INTEGER NOT NULL,
  copy_no INTEGER NOT NULL DEFAULT 0,
  copied_from INTEGER REFERENCES shifts(id),
  employee_id INTEGER NOT NULL REFERENCES users(id),
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','accepted','cancelled')),
  accepted_by TEXT,
  accepted_at TEXT,
  cancelled_by TEXT,
  cancelled_at TEXT,
  cancel_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_shifts_employee ON shifts(employee_id, status);
CREATE INDEX IF NOT EXISTS idx_shifts_status ON shifts(status, opened_at);

-- One pickup. price is stamped when the shift is accepted.
CREATE TABLE IF NOT EXISTS collections (
  id INTEGER PRIMARY KEY,
  client_uuid TEXT UNIQUE NOT NULL,
  shift_uuid TEXT NOT NULL REFERENCES shifts(client_uuid),
  employee_id INTEGER NOT NULL REFERENCES users(id),
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity REAL NOT NULL CHECK (quantity > 0),
  price REAL,
  collected_at TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  edited_at TEXT,
  edited_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_collections_time ON collections(collected_at);
CREATE INDEX IF NOT EXISTS idx_collections_supplier ON collections(supplier_id, collected_at);
CREATE INDEX IF NOT EXISTS idx_collections_shift ON collections(shift_uuid);

-- Money paid to a supplier. Counts immediately, whatever the shift state.
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  client_uuid TEXT UNIQUE NOT NULL,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  amount REAL NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL DEFAULT 'cash' CHECK (method IN ('cash','card','transfer')),
  note TEXT,
  paid_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  employee_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  voided_at TEXT,
  void_reason TEXT,
  voided_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_payments_supplier ON payments(supplier_id, paid_at);

-- Offline corrections from phones already applied (makes re-sends harmless).
CREATE TABLE IF NOT EXISTS applied_ops (
  uuid TEXT PRIMARY KEY,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Business events (shift closed/accepted/cancelled...). Prepared for Telegram
-- notifications: a sender will deliver rows with delivered_at IS NULL.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at TEXT
);

-- Encrypted-at-rest is not needed here (server disk); these are automatic
-- safety copies taken before destructive actions, kept for 3 days.
CREATE TABLE IF NOT EXISTS backups (
  id INTEGER PRIMARY KEY,
  reason TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  data BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  details TEXT
);
`;

const tableExists = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);

function seedRoles(db) {
  const ins = db.prepare('INSERT OR IGNORE INTO roles (code, name, permissions, locked) VALUES (?, ?, ?, ?)');
  for (const r of BUILTIN_ROLES) ins.run(r.code, r.name, JSON.stringify(r.perms), r.locked);
}

export const roleIdByCode = (db, code) => db.prepare('SELECT id FROM roles WHERE code = ?').get(code)?.id;

// Admins get 3 device slots (phone, laptop, spare), everyone else 1.
export function ensureDeviceSlots(db, userId) {
  if (db.prepare('SELECT 1 FROM devices WHERE user_id = ?').get(userId)) return;
  const u = db.prepare('SELECT u.role_id, r.code FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id = ?').get(userId);
  const n = u?.code === 'admin' ? 3 : 1;
  for (let i = 1; i <= n; i++) db.prepare('INSERT INTO devices (user_id, name) VALUES (?, ?)').run(userId, `Qurilma ${i}`);
}

// v3 -> v4: panel users and collectors become one users table; warehouses go;
// shifts get numbers and the draft/accept lifecycle; FKs point to users.
function migrateV3toV4(db) {
  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    // 1. roles: translate permission keys; admin-level panel access stays with admin only
    for (const r of db.prepare('SELECT * FROM roles').all()) {
      const old = JSON.parse(r.permissions || '[]');
      // Built-in roles also receive the new defaults; customisations are kept.
      const defaults = BUILTIN_ROLES.find((b) => b.code && b.code === r.code)?.perms ?? [];
      const next = new Set([...old.flatMap((k) => V3_TO_V4[k] ?? []), ...defaults].filter((k) => PERMISSION_KEYS.has(k)));
      db.prepare('UPDATE roles SET permissions = ? WHERE id = ?').run(JSON.stringify([...next]), r.id);
    }
    db.prepare("UPDATE roles SET name = 'Buxgalter' WHERE code = 'viewer' AND name = 'Kuzatuvchi (buxgalter)'").run();

    // 2. unified users
    db.exec(`ALTER TABLE users RENAME TO users_v3`);
    db.exec(SCHEMA.slice(SCHEMA.indexOf('CREATE TABLE IF NOT EXISTS users'), SCHEMA.indexOf('-- Device slots')));
    db.exec(`INSERT INTO users (id, login, name, password_hash, role_id, active, created_at)
      SELECT id, login, name, password_hash, role_id, active, created_at FROM users_v3`);
    const map = new Map();
    const collector = roleIdByCode(db, 'collector');
    for (const e of db.prepare('SELECT * FROM employees ORDER BY id').all()) {
      let login = e.phone;
      while (db.prepare('SELECT 1 FROM users WHERE login = ?').get(login)) login += '_1';
      const id = db.prepare(`INSERT INTO users (login, name, phone, password_hash, role_id, is_test, active, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(login, e.name, e.phone, e.pin_hash, e.role_id ?? collector, e.is_test, e.active, e.created_at).lastInsertRowid;
      map.set(e.id, Number(id));
    }
    const m = (id) => (id == null ? null : map.get(id) ?? null);

    // 3. rebuild dependent tables
    const rows = (t) => (tableExists(db, t) ? db.prepare(`SELECT * FROM ${t}`).all() : []);
    const oldAssign = rows('employee_suppliers');
    const oldShifts = rows('shifts').sort((a, b) => a.opened_at.localeCompare(b.opened_at) || a.id - b.id);
    const oldCols = rows('collections');
    const oldPays = rows('payments');
    const oldSp = rows('supplier_products');
    const oldSuppliers = rows('suppliers');
    for (const t of ['employee_suppliers', 'collections', 'shifts', 'payments', 'supplier_products', 'suppliers', 'employees', 'warehouses', 'users_v3']) {
      if (tableExists(db, t)) db.exec(`DROP TABLE ${t}`);
    }
    db.exec(SCHEMA);
    for (const s of oldSuppliers) {
      db.prepare(`INSERT INTO suppliers (id, name, phone, address, note, opening_balance, lat, lng, active, created_at)
        VALUES (@id, @name, @phone, @address, @note, @opening_balance, @lat, @lng, @active, @created_at)`).run({ lat: null, lng: null, ...s });
    }
    for (const sp of oldSp) db.prepare('INSERT INTO supplier_products VALUES (?, ?, ?, ?)').run(sp.supplier_id, sp.product_id, sp.price, sp.is_default);
    for (const a of oldAssign) if (m(a.employee_id)) db.prepare('INSERT OR IGNORE INTO employee_suppliers VALUES (?, ?, ?)').run(m(a.employee_id), a.supplier_id, a.sort_order);
    const status = { open: 'open', closed: 'closed', approved: 'accepted', rejected: 'cancelled' };
    oldShifts.forEach((s, i) => {
      if (!m(s.employee_id)) return;
      db.prepare(`INSERT INTO shifts (id, client_uuid, number, employee_id, opened_at, closed_at, status, accepted_by, accepted_at, cancelled_by, cancelled_at, cancel_reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(s.id, s.client_uuid, i + 1, m(s.employee_id), s.opened_at, s.closed_at, status[s.status] ?? 'closed',
        s.status === 'approved' ? s.reviewed_by : null, s.status === 'approved' ? s.reviewed_at : null,
        s.status === 'rejected' ? s.reviewed_by : null, s.status === 'rejected' ? s.reviewed_at : null, s.status === 'rejected' ? s.review_note : null);
    });
    const shiftSet = new Set(db.prepare('SELECT client_uuid FROM shifts').all().map((x) => x.client_uuid));
    for (const c of oldCols) {
      // Voided pickups were mistakes; pickups without a known shift cannot be placed.
      if (c.voided_at || !m(c.employee_id) || !shiftSet.has(c.shift_uuid)) continue;
      db.prepare(`INSERT INTO collections (id, client_uuid, shift_uuid, employee_id, supplier_id, product_id, quantity, price, collected_at, received_at, edited_at, edited_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(c.id, c.client_uuid, c.shift_uuid, m(c.employee_id), c.supplier_id, c.product_id, c.quantity, c.price,
        c.collected_at, c.received_at, c.edited_at, c.edited_by);
    }
    for (const p of oldPays) {
      db.prepare(`INSERT INTO payments (id, client_uuid, supplier_id, amount, method, note, paid_at, created_by, employee_id, created_at, voided_at, void_reason, voided_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(p.id, p.client_uuid, p.supplier_id, p.amount, p.method, p.note, p.paid_at, p.created_by,
        m(p.employee_id), p.created_at, p.voided_at, p.void_reason, p.voided_by);
    }
    for (const u of db.prepare('SELECT id FROM users').all()) ensureDeviceSlots(db, u.id);
  })();
  db.pragma('foreign_keys = ON');
}

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const version = db.pragma('user_version', { simple: true });
  const fresh = !tableExists(db, 'users') && !tableExists(db, 'admins') && !tableExists(db, 'suppliers');
  if (!fresh && version < 4) {
    if (version < 3) upgradeToV3(db);
    migrateV3toV4(db);
  }
  db.exec(SCHEMA);
  seedRoles(db);
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
  return db;
}

export function audit(db, actor, action, details) {
  db.prepare('INSERT INTO audit_log (actor, action, details) VALUES (?, ?, ?)')
    .run(actor, action, details == null ? null : JSON.stringify(details));
}

export function emitEvent(db, type, payload) {
  db.prepare('INSERT INTO events (type, payload) VALUES (?, ?)').run(type, JSON.stringify(payload));
}
