import { randomBytes } from 'node:crypto';

// Per-action "are you sure?" confirmation prompts. Each can be turned off in the
// settings. Default: on (ask). Used by both the app and the panel.
export const CONFIRM_KEYS = ['open', 'close', 'accept', 'cancel', 'edit', 'payment', 'delete', 'copy_cancelled', 'entity_delete'];
export const confirmFlags = (db) => Object.fromEntries(CONFIRM_KEYS.map((k) => [k, getSetting(db, `confirm_${k}`) !== '0']));

// "Difference" feature: when accepting a shift the acceptor records the real
// quantity received per product; the gap to what the collector wrote is the
// company's surplus/shortfall. `enabled` default ON (the acceptor just leaves the
// pre-filled real = written when there is no difference). `over`/`under` are the
// allowed surplus/shortfall in kg; null = no limit (acceptance never blocked).
export const diffFlags = (db) => {
  const n = (k) => { const v = getSetting(db, k); return v == null || v === '' ? null : Math.abs(Number(v)); };
  return { enabled: getSetting(db, 'diff_enabled') !== '0', over: n('diff_limit_over'), under: n('diff_limit_under') };
};

export function getSetting(db, key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
}

export function setSetting(db, key, value) {
  if (value == null || value === '') db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  else db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

// JWT secret: taken from env if given, otherwise generated once and kept in the
// database so tokens survive restarts and nothing has to be configured by hand.
export function jwtSecret(db, fromEnv) {
  if (fromEnv) return fromEnv;
  let s = getSetting(db, 'jwt_secret');
  if (!s) {
    s = randomBytes(48).toString('hex');
    setSetting(db, 'jwt_secret', s);
  }
  return s;
}
