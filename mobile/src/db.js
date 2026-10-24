import * as SQLite from 'expo-sqlite';
import { randomUUID } from 'expo-crypto';

// The database lives in the app's private files directory, not in the cache
// directory, so Android's "Clear cache" never touches it. Every write below is
// synchronous and committed before the UI moves on, so killing the app at any
// moment cannot lose a saved pickup, correction or payment.
const db = SQLite.openDatabaseSync('yaya.db');

db.execSync(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS shifts (
    uuid TEXT PRIMARY KEY,
    opened_at TEXT NOT NULL,
    closed_at TEXT,
    dirty INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS collections (
    uuid TEXT PRIMARY KEY,
    shift_uuid TEXT NOT NULL,
    supplier_id INTEGER NOT NULL,
    supplier_name TEXT NOT NULL,
    product_id INTEGER NOT NULL,
    product_name TEXT NOT NULL,
    unit TEXT,
    quantity REAL NOT NULL,
    collected_at TEXT NOT NULL,
    synced_at TEXT,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_col_shift ON collections(shift_uuid);
  CREATE INDEX IF NOT EXISTS idx_col_unsynced ON collections(synced_at);
  -- Corrections to pickups (edit / delete) while the shift is still open.
  CREATE TABLE IF NOT EXISTS ops (
    uuid TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    target TEXT NOT NULL,
    quantity REAL,
    product_id INTEGER,
    reason TEXT,
    created_at TEXT NOT NULL,
    synced_at TEXT,
    error TEXT
  );
  CREATE TABLE IF NOT EXISTS payments (
    uuid TEXT PRIMARY KEY,
    supplier_id INTEGER NOT NULL,
    supplier_name TEXT NOT NULL,
    amount REAL NOT NULL,
    method TEXT NOT NULL DEFAULT 'cash',
    note TEXT,
    paid_at TEXT NOT NULL,
    synced_at TEXT,
    error TEXT
  );
`);
// Columns added after the first release; phones that already have the tables get them here.
const cols = (t) => db.getAllSync(`PRAGMA table_info(${t})`).map((c) => c.name);
if (!cols('collections').includes('voided_at')) {
  db.execSync('ALTER TABLE collections ADD COLUMN voided_at TEXT; ALTER TABLE collections ADD COLUMN edited_at TEXT;');
}
if (!cols('shifts').includes('error')) db.execSync('ALTER TABLE shifts ADD COLUMN error TEXT;');
// Version 1 "voided" pickups are simply deleted now.
db.execSync('DELETE FROM collections WHERE voided_at IS NOT NULL;');

const now = () => new Date().toISOString();

// ---- key/value (session, cached reference data, unfinished input) ----
export function getKv(key, fallback = null) {
  const row = db.getFirstSync('SELECT value FROM kv WHERE key = ?', key);
  return row ? JSON.parse(row.value) : fallback;
}
export function setKv(key, value) {
  if (value === null || value === undefined) db.runSync('DELETE FROM kv WHERE key = ?', key);
  else db.runSync('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', key, JSON.stringify(value));
}

// ---- shifts ----
export function getOpenShift() {
  return db.getFirstSync('SELECT * FROM shifts WHERE closed_at IS NULL AND error IS NULL ORDER BY opened_at DESC LIMIT 1');
}
export function allShifts() {
  return db.getAllSync('SELECT * FROM shifts ORDER BY opened_at DESC');
}
export function openShift() {
  const shift = { uuid: randomUUID(), opened_at: now() };
  db.runSync('INSERT INTO shifts (uuid, opened_at) VALUES (?, ?)', shift.uuid, shift.opened_at);
  return shift;
}
export function closeShift(uuid) {
  db.runSync('UPDATE shifts SET closed_at = ?, dirty = 1 WHERE uuid = ?', now(), uuid);
}
// A shift opened on the server (a copy of a cancelled one) becomes the phone's open shift.
export function adoptShift(s) {
  db.withTransactionSync(() => {
    db.runSync('INSERT OR IGNORE INTO shifts (uuid, opened_at, dirty) VALUES (?, ?, 0)', s.uuid, s.opened_at);
    for (const c of s.collections) {
      db.runSync(`INSERT OR IGNORE INTO collections (uuid, shift_uuid, supplier_id, supplier_name, product_id, product_name, unit, quantity, collected_at, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, c.uuid, s.uuid, c.supplier_id, c.supplier_name, c.product_id, c.product_name, c.unit ?? 'kg',
      c.quantity, c.collected_at, now());
    }
  });
}
// A closed shift reopened for editing on the server becomes the open shift here
// again: clear its closed mark and make sure its pickups are present locally.
export function reopenLocalShift(s) {
  db.withTransactionSync(() => {
    const existing = db.getFirstSync('SELECT uuid FROM shifts WHERE uuid = ?', s.uuid);
    if (existing) db.runSync('UPDATE shifts SET closed_at = NULL, dirty = 0, error = NULL WHERE uuid = ?', s.uuid);
    else db.runSync('INSERT INTO shifts (uuid, opened_at, dirty) VALUES (?, ?, 0)', s.uuid, s.opened_at);
    for (const c of s.collections ?? []) {
      db.runSync(`INSERT OR IGNORE INTO collections (uuid, shift_uuid, supplier_id, supplier_name, product_id, product_name, unit, quantity, collected_at, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, c.uuid, s.uuid, c.supplier_id, c.supplier_name, c.product_id, c.product_name, c.unit ?? 'kg',
      c.quantity, c.collected_at, now());
    }
  });
}
// A shift the server refused (e.g. another one was still waiting): drop it and its pickups.
export function discardShift(uuid) {
  db.withTransactionSync(() => {
    db.runSync('DELETE FROM collections WHERE shift_uuid = ?', uuid);
    db.runSync('DELETE FROM shifts WHERE uuid = ?', uuid);
  });
}

// ---- collections ----
// Saving the pickup and clearing the unfinished input happen in one transaction,
// so a crash can never leave both (which would invite a double entry).
export function addCollectionAndClearDraft({ shiftUuid, supplier, product, quantity }) {
  db.withTransactionSync(() => {
    db.runSync(`INSERT INTO collections
    (uuid, shift_uuid, supplier_id, supplier_name, product_id, product_name, unit, quantity, collected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    randomUUID(), shiftUuid, supplier.id, supplier.name, product.id, product.name, product.unit ?? 'kg',
    quantity, now());
    db.runSync("DELETE FROM kv WHERE key = 'draft'");
  });
}
export function shiftCollections(shiftUuid) {
  return db.getAllSync('SELECT * FROM collections WHERE shift_uuid = ? ORDER BY collected_at DESC', shiftUuid);
}

// Corrections inside the open shift. The change is made here at once and also
// queued for the server: if the pickup is still on its way up, the queued
// correction follows it and is applied there afterwards.
export function editCollection(uuid, { quantity, product }) {
  db.withTransactionSync(() => {
    db.runSync('UPDATE collections SET quantity = ?, product_id = ?, product_name = ?, unit = ?, edited_at = ? WHERE uuid = ?',
      quantity, product.id, product.name, product.unit ?? 'kg', now(), uuid);
    db.runSync('INSERT INTO ops (uuid, type, target, quantity, product_id, created_at) VALUES (?, \'edit\', ?, ?, ?, ?)',
      randomUUID(), uuid, quantity, product.id, now());
  });
}
export function deleteCollection(uuid) {
  db.withTransactionSync(() => {
    db.runSync('DELETE FROM collections WHERE uuid = ?', uuid);
    db.runSync('INSERT INTO ops (uuid, type, target, created_at) VALUES (?, \'delete\', ?, ?)', randomUUID(), uuid, now());
  });
}

// ---- payments ----
export function addPayment({ supplier, amount, method, note }) {
  db.runSync('INSERT INTO payments (uuid, supplier_id, supplier_name, amount, method, note, paid_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    randomUUID(), supplier.id, supplier.name, amount, method ?? 'cash', note ?? null, now());
}
export function recentPayments() {
  return db.getAllSync('SELECT * FROM payments ORDER BY paid_at DESC LIMIT 50');
}

// ---- sync state ----
const PENDING = {
  collections: 'synced_at IS NULL AND error IS NULL',
  ops: 'synced_at IS NULL AND error IS NULL',
  payments: 'synced_at IS NULL AND error IS NULL',
};
export function unsyncedCount() {
  return Object.entries(PENDING).reduce((n, [t, w]) => n + db.getFirstSync(`SELECT COUNT(*) AS n FROM ${t} WHERE ${w}`).n, 0)
    + db.getFirstSync('SELECT COUNT(*) AS n FROM shifts WHERE dirty = 1 AND error IS NULL').n;
}
export function errorCount() {
  return ['collections', 'ops', 'payments', 'shifts'].reduce((n, t) => n + db.getFirstSync(`SELECT COUNT(*) AS n FROM ${t} WHERE error IS NOT NULL`).n, 0);
}
export function errors() {
  return [
    ...db.getAllSync('SELECT \'shift\' AS kind, uuid, \'Smena\' AS name, error FROM shifts WHERE error IS NOT NULL'),
    ...db.getAllSync('SELECT \'pickup\' AS kind, uuid, supplier_name AS name, error FROM collections WHERE error IS NOT NULL'),
    ...db.getAllSync('SELECT \'fix\' AS kind, uuid, \'Tuzatish\' AS name, error FROM ops WHERE error IS NOT NULL'),
    ...db.getAllSync('SELECT \'payment\' AS kind, uuid, supplier_name AS name, error FROM payments WHERE error IS NOT NULL'),
  ];
}

// Human-readable list of what the server refused, so the person can see exactly
// which entry failed and why, and clear it themselves.
export function errorDetails() {
  const out = [];
  for (const x of db.getAllSync('SELECT * FROM shifts WHERE error IS NOT NULL')) {
    const n = db.getFirstSync('SELECT COUNT(*) AS n FROM collections WHERE shift_uuid = ?', x.uuid).n;
    out.push({ kind: 'shift', uuid: x.uuid, title: 'Smena ochish', detail: `${n} ta yozuv bilan`, when: x.opened_at, error: x.error });
  }
  for (const x of db.getAllSync('SELECT * FROM collections WHERE error IS NOT NULL')) {
    out.push({ kind: 'pickup', uuid: x.uuid, title: x.supplier_name, detail: `${x.product_name}: ${x.quantity} ${x.unit ?? 'kg'}`, when: x.collected_at, error: x.error });
  }
  for (const x of db.getAllSync('SELECT * FROM ops WHERE error IS NOT NULL')) {
    const c = db.getFirstSync('SELECT supplier_name, product_name FROM collections WHERE uuid = ?', x.target);
    out.push({ kind: 'fix', uuid: x.uuid, title: c ? c.supplier_name : 'Tuzatish',
      detail: x.type === 'delete' ? 'Yozuvni o\'chirish' : `Yozuvni tuzatish: ${x.quantity} ${c?.product_name ?? ''}`.trim(), when: x.created_at, error: x.error });
  }
  for (const x of db.getAllSync('SELECT * FROM payments WHERE error IS NOT NULL')) {
    out.push({ kind: 'payment', uuid: x.uuid, title: x.supplier_name, detail: `To'lov: ${x.amount} so'm`, when: x.paid_at, error: x.error });
  }
  return out;
}
// Drop one refused entry from the phone (it never reached the office).
export function discardError(kind, uuid) {
  if (kind === 'shift') discardShift(uuid);
  else if (kind === 'pickup') db.runSync('DELETE FROM collections WHERE uuid = ?', uuid);
  else if (kind === 'fix') db.runSync('DELETE FROM ops WHERE uuid = ?', uuid);
  else if (kind === 'payment') db.runSync('DELETE FROM payments WHERE uuid = ?', uuid);
}
export function discardAllErrors() {
  for (const e of errorDetails()) discardError(e.kind, e.uuid);
}

export function pendingUpload() {
  return {
    shifts: db.getAllSync('SELECT uuid, opened_at, closed_at FROM shifts WHERE dirty = 1 AND error IS NULL'),
    collections: db.getAllSync(`SELECT * FROM collections WHERE ${PENDING.collections} ORDER BY collected_at LIMIT 300`),
    ops: db.getAllSync(`SELECT * FROM ops WHERE ${PENDING.ops} ORDER BY created_at LIMIT 300`),
    payments: db.getAllSync(`SELECT * FROM payments WHERE ${PENDING.payments} LIMIT 200`),
  };
}
export function markUploaded(sentShifts, r) {
  const t = now();
  db.withTransactionSync(() => {
    // Only clear the flag if the shift was not closed while the upload was in flight.
    for (const s of sentShifts) db.runSync('UPDATE shifts SET dirty = 0 WHERE uuid = ? AND closed_at IS ?', s.uuid, s.closed_at);
    for (const x of r.shifts?.rejected ?? []) db.runSync('UPDATE shifts SET error = ? WHERE uuid = ?', x.error, x.uuid);
    const apply = (table, acc = [], rej = []) => {
      for (const u of acc) db.runSync(`UPDATE ${table} SET synced_at = ? WHERE uuid = ?`, t, u);
      for (const x of rej) db.runSync(`UPDATE ${table} SET error = ? WHERE uuid = ?`, x.error, x.uuid);
    };
    apply('collections', r.accepted, r.rejected);
    apply('ops', r.ops?.accepted, r.ops?.rejected);
    apply('payments', r.payments?.accepted, r.payments?.rejected);
  });
}
// Rejected items get another try after the admin fixes the settings.
export function retryErrors() {
  db.runSync('UPDATE shifts SET error = NULL, dirty = 1 WHERE error IS NOT NULL');
  for (const t of ['collections', 'ops', 'payments']) db.runSync(`UPDATE ${t} SET error = NULL WHERE error IS NOT NULL`);
}
// Keep a month of history on the phone; never delete anything not yet on the server.
export function pruneOld() {
  const cutoff = new Date(Date.now() - 30 * 864e5).toISOString();
  db.runSync('DELETE FROM collections WHERE synced_at IS NOT NULL AND collected_at < ?', cutoff);
  db.runSync('DELETE FROM ops WHERE synced_at IS NOT NULL AND created_at < ?', cutoff);
  db.runSync('DELETE FROM payments WHERE synced_at IS NOT NULL AND paid_at < ?', cutoff);
  db.runSync(`DELETE FROM shifts WHERE closed_at IS NOT NULL AND dirty = 0 AND closed_at < ?
    AND uuid NOT IN (SELECT shift_uuid FROM collections)`, cutoff);
}
// Another person logs in on this phone: their work must not mix with the previous user's.
export function wipeLocal() {
  db.execSync('DELETE FROM collections; DELETE FROM ops; DELETE FROM payments; DELETE FROM shifts;');
  for (const k of ['draft', 'bootstrap', 'lastSync']) setKv(k, null);
}
