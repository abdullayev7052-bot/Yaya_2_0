import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { SCHEMA_VERSION } from './db/index.js';

// Full-data backups.
//  * snapshot(db): every table as plain rows (binary columns base64-tagged).
//  * Export file (.yaya): gzip(JSON) encrypted with AES-256-GCM using a key
//    derived (scrypt) from a password the admin chooses. Without that password
//    the file is unreadable, wherever it is stored.
//  * Automatic safety copies (before wipe / import) are kept in the database
//    for 3 days so a mistake can be undone.

const MAGIC = Buffer.from('YAYA-BACKUP-1\n');
const SKIP = new Set(['backups']);
export const SAFETY_DAYS = 3;

const tables = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
  .map((t) => t.name).filter((t) => !SKIP.has(t));

export function snapshot(db) {
  const data = {};
  for (const t of tables(db)) {
    data[t] = db.prepare(`SELECT * FROM ${t}`).all().map((row) => {
      for (const [k, v] of Object.entries(row)) if (Buffer.isBuffer(v)) row[k] = { __b64: v.toString('base64') };
      return row;
    });
  }
  return { app: 'yaya', schema: SCHEMA_VERSION, exportedAt: new Date().toISOString(), tables: data };
}

const revive = (v) => (v && typeof v === 'object' && typeof v.__b64 === 'string' ? Buffer.from(v.__b64, 'base64') : v);

// Replace all data with the snapshot's. Columns are matched by name, so a
// snapshot from the same schema restores exactly.
export function restore(db, snap) {
  if (snap?.app !== 'yaya' || typeof snap.tables !== 'object') throw new Error('Bu Yaya zaxira fayli emas');
  if (snap.schema > SCHEMA_VERSION) throw new Error(`Zaxira yangiroq versiyadan (${snap.schema}). Avval serverni yangilang.`);
  if (snap.schema < SCHEMA_VERSION) throw new Error(`Zaxira eski versiyadan (${snap.schema}); bu server ${SCHEMA_VERSION}-versiya.`);
  const present = tables(db);
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      for (const t of present) db.exec(`DELETE FROM ${t}`);
      for (const t of present) {
        const rows = snap.tables[t];
        if (!Array.isArray(rows) || !rows.length) continue;
        const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name).filter((c) => c in rows[0]);
        const ins = db.prepare(`INSERT INTO ${t} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
        for (const r of rows) ins.run(...cols.map((c) => revive(r[c])));
      }
      const broken = db.pragma('foreign_key_check');
      if (broken.length) throw new Error(`Zaxira ichidagi bog'lanishlar buzilgan (${broken.length} ta)`);
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

export function encrypt(snap, password) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(password, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(gzipSync(Buffer.from(JSON.stringify(snap)))), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), body]);
}

export function decrypt(buf, password) {
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Bu Yaya zaxira fayli emas');
  let o = MAGIC.length;
  const salt = buf.subarray(o, (o += 16));
  const iv = buf.subarray(o, (o += 12));
  const tag = buf.subarray(o, (o += 16));
  const key = scryptSync(password, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  try {
    return JSON.parse(gunzipSync(Buffer.concat([d.update(buf.subarray(o)), d.final()])).toString('utf8'));
  } catch {
    throw new Error('Zaxira paroli noto\'g\'ri yoki fayl buzilgan');
  }
}

// ---- automatic safety copies (kept 3 days) ----
export function pruneSafety(db) {
  db.prepare("DELETE FROM backups WHERE expires_at < datetime('now')").run();
}

export function saveSafety(db, reason, actor) {
  pruneSafety(db);
  const data = gzipSync(Buffer.from(JSON.stringify(snapshot(db))));
  return db.prepare(`INSERT INTO backups (reason, created_by, expires_at, data) VALUES (?, ?, datetime('now', '+${SAFETY_DAYS} days'), ?)`)
    .run(reason, actor, data).lastInsertRowid;
}

export const listSafety = (db) => {
  pruneSafety(db);
  return db.prepare('SELECT id, reason, created_by, created_at, expires_at, length(data) AS bytes FROM backups ORDER BY id DESC').all();
};

export function loadSafety(db, id) {
  pruneSafety(db);
  const row = db.prepare('SELECT data FROM backups WHERE id = ?').get(id);
  if (!row) throw new Error('Zaxira topilmadi yoki 3 kunlik muddati o\'tgan');
  return JSON.parse(gunzipSync(row.data).toString('utf8'));
}

// "Clear all history": transactions go, master data (people, suppliers,
// prices, products, settings) stays.
export function wipeHistory(db, { resetOpening = false } = {}) {
  db.transaction(() => {
    for (const t of ['collections', 'payments', 'adjustments', 'applied_ops', 'events']) db.exec(`DELETE FROM ${t}`);
    db.exec('DELETE FROM shifts');
    if (resetOpening) db.exec('UPDATE suppliers SET opening_balance = 0');
  })();
}
