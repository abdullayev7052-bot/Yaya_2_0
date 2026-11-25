// Shared monoblock (kiosk) API (Yaya 2.0, stage 7), under /api/kiosk.
//
// The monoblock is paired once: the admin creates it in the panel and gets a
// one-time 6-digit code (valid 15 minutes); the monoblock sends the code and gets
// its own secret, sent afterwards in the X-Kiosk-Token header. Only the secret's
// SHA-256 is stored. People sign in on it by picking their name and typing a
// 4-digit PIN; five wrong PINs lock that person on that monoblock for 5 minutes.
import bcrypt from 'bcryptjs';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { audit } from '../db/index.js';
import { loadUser, makeGuard, publicUser } from '../auth.js';
import { createLoginGuard } from '../ratelimit.js';

export const KIOSK_TOKEN_TTL = '12h';
const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const PIN_RE = /^\d{4}$/;

export default async function kioskRoutes(app, { db }) {
  const need = makeGuard(app, db);
  const pinGuard = createLoginGuard({ max: 5, windowMs: 5 * 60 * 1000 });
  const pairGuard = createLoginGuard({ max: 10, windowMs: 15 * 60 * 1000 });
  const bad = (reply, msg, code = 400) => reply.code(code).send({ error: msg });
  const kioskOf = (req) => {
    const t = req.headers['x-kiosk-token'];
    if (!t) return null;
    const k = db.prepare('SELECT * FROM kiosks WHERE token_hash = ? AND active = 1').get(sha(t));
    if (k) db.prepare("UPDATE kiosks SET last_seen_at = datetime('now') WHERE id = ?").run(k.id);
    return k ?? null;
  };
  // People allowed on this monoblock: those marked "uses the monoblock" — of them, the
  // ones listed for this monoblock, or all when none are listed.
  const staffOf = (k) => {
    const listed = db.prepare('SELECT user_id FROM kiosk_users WHERE kiosk_id = ?').all(k.id).map((r) => r.user_id);
    return db.prepare(`SELECT u.id, COALESCE(u.name, u.login) AS name, r.name AS role, u.pin_hash IS NOT NULL AS has_pin FROM users u LEFT JOIN roles r ON r.id = u.role_id
      WHERE u.active = 1 AND u.is_test = 0 AND u.kiosk = 1 ORDER BY name`).all().filter((u) => !listed.length || listed.includes(u.id))
      .map((u) => ({ id: u.id, name: u.name, role: u.role, hasPin: !!u.has_pin }));
  };

  // ---------------------------------------------------------------- on the monoblock
  app.post('/pair', async (req, reply) => {
    const code = String(req.body?.code ?? '').replace(/\D/g, '');
    const key = `${req.ip}|pair`;
    const wait = pairGuard.blocked(key);
    if (wait) return bad(reply, `Juda ko'p urinish. ${wait} daqiqadan keyin qayta urinib ko'ring.`, 429);
    const k = code.length === 6 && db.prepare("SELECT * FROM kiosks WHERE pair_code = ? AND pair_expires > datetime('now') AND active = 1").get(code);
    if (!k) { pairGuard.fail(key); return bad(reply, "Kod noto'g'ri yoki muddati o'tgan. Paneldan yangi kod oling."); }
    const token = randomBytes(32).toString('hex');
    db.prepare('UPDATE kiosks SET token_hash = ?, pair_code = NULL, pair_expires = NULL WHERE id = ?').run(sha(token), k.id);
    pairGuard.reset(key);
    audit(db, `kiosk:${k.id}`, 'kiosk.paired', { name: k.name });
    return { token, kiosk: { id: k.id, name: k.name, idleMinutes: k.idle_minutes } };
  });

  app.get('/staff', async (req, reply) => {
    const k = kioskOf(req);
    if (!k) return bad(reply, 'Monoblok ulanmagan yoki o\'chirilgan', 401);
    return { kiosk: { id: k.id, name: k.name, idleMinutes: k.idle_minutes }, staff: staffOf(k) };
  });

  app.post('/login', async (req, reply) => {
    const k = kioskOf(req);
    if (!k) return bad(reply, 'Monoblok ulanmagan yoki o\'chirilgan', 401);
    const userId = Number(req.body?.userId);
    const person = staffOf(k).find((u) => u.id === userId);
    if (!person) return bad(reply, 'Bu monoblokda bunday xodim yo\'q', 403);
    const key = `${k.id}|${userId}`;
    const wait = pinGuard.blocked(key);
    if (wait) return bad(reply, `PIN ko'p marta xato kiritildi. ${wait} daqiqadan keyin qayta urinib ko'ring.`, 429);
    const row = db.prepare('SELECT pin_hash FROM users WHERE id = ?').get(userId);
    if (!row?.pin_hash) return bad(reply, "PIN o'rnatilmagan. Telefoningizdagi ilovada (Profil) yoki admin orqali PIN o'rnating.", 403);
    if (!bcrypt.compareSync(String(req.body?.pin ?? ''), row.pin_hash)) {
      pinGuard.fail(key);
      audit(db, `kiosk:${k.id}`, 'kiosk.pin_fail', { user: person.name });
      return bad(reply, "PIN noto'g'ri", 401);
    }
    pinGuard.reset(key);
    const u = loadUser(db, userId);
    audit(db, `user:${u.login}`, 'auth.kiosk', { kiosk: k.name });
    const token = app.jwt.sign({ uid: u.id, did: `kiosk:${k.id}`, aud: 'app', ksk: k.id }, { expiresIn: KIOSK_TOKEN_TTL });
    return { token, user: publicUser(u), kiosk: { id: k.id, name: k.name, idleMinutes: k.idle_minutes } };
  });

  // Alerts everyone at the monoblock should see (incubator dwell, late tasks — they name people).
  app.get('/alerts', async (req, reply) => {
    const k = kioskOf(req);
    if (!k) return bad(reply, 'Monoblok ulanmagan', 401);
    return db.prepare("SELECT id, type, text, created_at FROM alerts WHERE resolved_at IS NULL AND type IN ('dwell.over','task.late') ORDER BY id DESC LIMIT 20").all();
  });

  // No two people on the monoblock may share a PIN (PINs are hashed, so each is checked).
  const pinTaken = (pin, userId) => db.prepare('SELECT id, pin_hash FROM users WHERE pin_hash IS NOT NULL AND id <> ? AND active = 1').all(userId)
    .some((u) => bcrypt.compareSync(pin, u.pin_hash));
  const PIN_TAKEN = "Bu PIN boshqa xodimda bor — boshqa 4 ta raqam tanlang";

  // ---------------------------------------------------------------- PIN for oneself (from the phone)
  app.put('/my-pin', need(), async (req, reply) => {
    const pin = String(req.body?.pin ?? '');
    if (!PIN_RE.test(pin)) return bad(reply, "PIN 4 ta raqam bo'lsin");
    if (!db.prepare('SELECT kiosk FROM users WHERE id = ?').get(req.me.id)?.kiosk) return bad(reply, "Siz monoblokdan foydalanmaysiz — PIN kerak emas", 403);
    if (pinTaken(pin, req.me.id)) return bad(reply, PIN_TAKEN);
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.me.id);
    if (!bcrypt.compareSync(String(req.body?.password ?? ''), row.password_hash)) return bad(reply, "Parol noto'g'ri");
    db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(bcrypt.hashSync(pin, 8), req.me.id);
    audit(db, req.actor, 'kiosk.pin_set', { self: true });
    return { ok: true };
  });

  // ---------------------------------------------------------------- managing monoblocks (panel)
  const kioskRow = (k) => ({
    id: k.id, name: k.name, idle_minutes: k.idle_minutes, active: k.active, paired: !!k.token_hash, last_seen_at: k.last_seen_at,
    pair_code: k.pair_code && k.pair_expires > new Date().toISOString().replace('T', ' ').slice(0, 19) ? k.pair_code : null, pair_expires: k.pair_expires,
    users: db.prepare('SELECT u.id, COALESCE(u.name, u.login) AS name FROM kiosk_users ku JOIN users u ON u.id = ku.user_id WHERE ku.kiosk_id = ?').all(k.id),
  });
  app.get('/admin', need('staff.manage'), async () => ({
    kiosks: db.prepare('SELECT * FROM kiosks ORDER BY active DESC, name').all().map(kioskRow),
    staff: db.prepare('SELECT u.id, COALESCE(u.name, u.login) AS name, r.name AS role, u.pin_hash IS NOT NULL AS has_pin, u.active, u.kiosk FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.is_test = 0 ORDER BY u.active DESC, u.kiosk DESC, name').all()
      .map((u) => ({ ...u, has_pin: !!u.has_pin })),
  }));
  const setUsers = (id, list) => {
    if (!Array.isArray(list)) return;
    db.prepare('DELETE FROM kiosk_users WHERE kiosk_id = ?').run(id);
    for (const u of list) db.prepare('INSERT OR IGNORE INTO kiosk_users (kiosk_id, user_id) SELECT ?, id FROM users WHERE id = ?').run(id, Number(u));
  };
  const idle = (v) => Math.max(1, Math.min(60, Number(v) || 2));
  app.post('/admin', need('staff.manage'), async (req, reply) => {
    const name = String(req.body?.name ?? '').trim().slice(0, 60);
    if (!name) return bad(reply, 'Nomini yozing');
    const id = Number(db.prepare('INSERT INTO kiosks (name, idle_minutes) VALUES (?, ?)').run(name, idle(req.body?.idleMinutes)).lastInsertRowid);
    setUsers(id, req.body?.users);
    audit(db, req.actor, 'kiosk.create', { name });
    return { id };
  });
  app.patch('/admin/:id', need('staff.manage'), async (req, reply) => {
    const k = db.prepare('SELECT * FROM kiosks WHERE id = ?').get(Number(req.params.id));
    if (!k) return bad(reply, 'Topilmadi', 404);
    const b = req.body ?? {};
    db.prepare('UPDATE kiosks SET name = COALESCE(?, name), idle_minutes = COALESCE(?, idle_minutes), active = COALESCE(?, active) WHERE id = ?')
      .run(b.name ? String(b.name).trim().slice(0, 60) : null, b.idleMinutes == null ? null : idle(b.idleMinutes), b.active == null ? null : Number(!!b.active), k.id);
    setUsers(k.id, b.users);
    // Unpairing: the monoblock's secret stops working at once.
    if (b.unpair) db.prepare('UPDATE kiosks SET token_hash = NULL WHERE id = ?').run(k.id);
    audit(db, req.actor, 'kiosk.update', { name: k.name, unpair: !!b.unpair });
    return { ok: true };
  });
  // A fresh one-time pairing code (15 minutes). Pairing again replaces the old secret.
  app.post('/admin/:id/code', need('staff.manage'), async (req, reply) => {
    const k = db.prepare('SELECT * FROM kiosks WHERE id = ? AND active = 1').get(Number(req.params.id));
    if (!k) return bad(reply, 'Topilmadi', 404);
    let code;
    do { code = String(randomInt(0, 1e6)).padStart(6, '0'); } while (db.prepare('SELECT 1 FROM kiosks WHERE pair_code = ?').get(code));
    db.prepare("UPDATE kiosks SET pair_code = ?, pair_expires = datetime('now', '+15 minutes') WHERE id = ?").run(code, k.id);
    audit(db, req.actor, 'kiosk.code', { name: k.name });
    return { code, expiresInMinutes: 15 };
  });
  // The admin sets or clears someone's PIN.
  app.put('/admin/pin/:userId', need('staff.manage'), async (req, reply) => {
    const pin = req.body?.pin == null || req.body.pin === '' ? null : String(req.body.pin);
    if (pin != null && !PIN_RE.test(pin)) return bad(reply, "PIN 4 ta raqam bo'lsin");
    const u = db.prepare('SELECT id, login, kiosk FROM users WHERE id = ?').get(Number(req.params.userId));
    if (!u) return bad(reply, 'Xodim topilmadi', 404);
    if (pin && !u.kiosk) return bad(reply, "Bu xodim monoblokdan foydalanmaydi (Xodimlar → \"Monoblokdan foydalanadi\")");
    if (pin && pinTaken(pin, u.id)) return bad(reply, PIN_TAKEN);
    db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(pin ? bcrypt.hashSync(pin, 8) : null, u.id);
    audit(db, req.actor, 'kiosk.pin_set', { user: u.login, cleared: !pin });
    return { ok: true };
  });
}
