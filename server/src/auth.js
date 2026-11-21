import bcrypt from 'bcryptjs';
import { audit, ensureDeviceSlots } from './db/index.js';
import { createLoginGuard } from './ratelimit.js';
import { permsOf } from './permissions.js';

// One sign-in for everybody. Who you are (and so what you see) is decided by
// the account, not by a "collector/manager" switch on the login screen.
// Every token is tied to a device slot: if the admin frees the slot, the token
// stops working on the next request.

export const APP_TOKEN_TTL = '365d'; // phones stay signed in until logout (app lock protects them)
export const PANEL_TOKEN_TTL = '12h';
// The break-glass recovery token bypasses device slots, so it is short-lived
// regardless of client — it is a last resort, not a standing login.
export const RECOVERY_TOKEN_TTL = '12h';

// Break-glass recovery: a single fixed credential (login "admin" + a secret the
// developer keeps off-site) that always signs in as the primary admin, even if
// every password is forgotten or the admin login was renamed. Only the bcrypt
// hash lives here, so the secret itself never appears in the code or the repo.
// It bypasses the device-slot limit and is logged as a recovery sign-in.
const RECOVERY_LOGIN = 'admin';
const RECOVERY_HASH = '$2a$10$XJ8Gr2GiutxxxOEHQ9wO9.12Zq2v.Xiw5jY6SHmANjv0iY8MT81Tm';
export const isRecovery = (login, password) =>
  normalizeLogin(login) === RECOVERY_LOGIN && bcrypt.compareSync(String(password ?? ''), RECOVERY_HASH);
// The admin account the recovery credential acts as: the "admin" login if it
// still exists, otherwise the oldest active admin-role user.
export function recoveryUser(db) {
  const byLogin = db.prepare(`SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
    WHERE u.login = 'admin' AND r.code = 'admin' AND u.active = 1`).get();
  const row = byLogin ?? db.prepare(`SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
    WHERE r.code = 'admin' AND u.active = 1 ORDER BY u.id LIMIT 1`).get();
  return row ? loadUser(db, row.id) : null;
}

// "+998 90 123-45-67" and "901234567" are the same login.
export function normalizeLogin(v) {
  const s = String(v ?? '').trim();
  if (/^[+\d\s()-]+$/.test(s)) {
    const d = s.replace(/\D/g, '');
    return d.length === 12 && d.startsWith('998') ? d.slice(3) : d;
  }
  return s.toLowerCase();
}

export function loadUser(db, id) {
  const u = db.prepare(`SELECT u.id, u.login, u.name, u.phone, u.active, u.is_test, u.role_id, r.name AS role_name, r.code AS role_code
    FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id = ?`).get(id);
  if (u) u.perms = permsOf(db, u.role_id);
  return u;
}

export const publicUser = (u) => ({
  id: u.id, login: u.login, name: u.name, role: u.role_name, roleCode: u.role_code, isTest: !!u.is_test, permissions: [...u.perms],
});

export function makeGuard(app, db) {
  // Returns route options whose preHandler checks token, device and permissions.
  return function need(...perms) {
    return {
      preHandler: async (req, reply) => {
        try {
          await req.jwtVerify();
        } catch {
          return reply.code(401).send({ error: 'Avtorizatsiya kerak' });
        }
        const { uid, did, aud, rec, ksk } = req.user ?? {};
        const u = uid && loadUser(db, uid);
        if (!u || !u.active) return reply.code(401).send({ error: 'Hisobingiz o\'chirilgan yoki topilmadi' });
        if (ksk) {
          // Signed in on a shared monoblock with a PIN: the monoblock must still be active
          // and the person still allowed on it (no personal device slot is used).
          const k = db.prepare('SELECT id FROM kiosks WHERE id = ? AND active = 1 AND token_hash IS NOT NULL').get(ksk);
          const listed = db.prepare('SELECT COUNT(*) AS n FROM kiosk_users WHERE kiosk_id = ?').get(ksk)?.n;
          const allowed = !listed || db.prepare('SELECT 1 FROM kiosk_users WHERE kiosk_id = ? AND user_id = ?').get(ksk, u.id);
          if (!k || !allowed) return reply.code(401).send({ error: "Monoblokdan foydalanishga ruxsat yo'q" });
        } else if (!u.is_test && !rec) {
          const slot = db.prepare('SELECT id FROM devices WHERE user_id = ? AND device_id = ?').get(u.id, did ?? '');
          if (!slot) return reply.code(401).send({ error: 'Bu qurilmaga ruxsat bekor qilingan. Qayta kiring yoki adminga murojaat qiling.' });
          db.prepare("UPDATE devices SET last_seen_at = datetime('now') WHERE id = ?").run(slot.id);
        }
        if (aud === 'panel' && !u.perms.has('panel.access')) return reply.code(403).send({ error: 'Veb panelga ruxsatingiz yo\'q' });
        if (!perms.every((p) => u.perms.has(p))) return reply.code(403).send({ error: 'Bu amal uchun ruxsatingiz yo\'q' });
        req.me = { ...u, aud };
        req.actor = `user:${u.login}`;
      },
    };
  };
}

export default async function authRoutes(app, { db }) {
  const guard = createLoginGuard();
  const need = makeGuard(app, db);

  app.post('/login', {
    schema: { body: { type: 'object', required: ['login', 'password', 'deviceId'], properties: {
      login: { type: 'string', maxLength: 64 }, password: { type: 'string', maxLength: 200 },
      deviceId: { type: 'string', minLength: 8, maxLength: 100 }, deviceLabel: { type: 'string', maxLength: 100 },
      client: { enum: ['app', 'panel'] } } } },
  }, async (req, reply) => {
    const login = normalizeLogin(req.body.login);
    const key = `${req.ip}|${login}`;
    const wait = guard.blocked(key);
    if (wait) return reply.code(429).send({ error: `Juda ko'p urinish. ${wait} daqiqadan keyin qayta urinib ko'ring.` });
    const client = req.body.client ?? 'app';
    // Break-glass recovery: the fixed credential signs in as the primary admin,
    // skipping the password, device-slot and panel checks. A last resort.
    if (isRecovery(req.body.login, req.body.password)) {
      const admin = recoveryUser(db);
      if (!admin) return reply.code(500).send({ error: 'Admin hisobi topilmadi' });
      guard.reset(key);
      audit(db, `user:${admin.login}`, 'auth.recovery', { client });
      const t = app.jwt.sign({ uid: admin.id, did: 'recovery', aud: client, rec: 1 }, { expiresIn: RECOVERY_TOKEN_TTL });
      return { token: t, user: publicUser(admin) };
    }
    const row = db.prepare('SELECT * FROM users WHERE (login = ? OR lower(login) = ?) AND active = 1').get(req.body.login.trim(), login);
    if (!row || !bcrypt.compareSync(req.body.password, row.password_hash)) {
      guard.fail(key);
      audit(db, `ip:${req.ip}`, 'auth.fail', { login });
      return reply.code(401).send({ error: 'Login yoki parol noto\'g\'ri' });
    }
    const u = loadUser(db, row.id);
    if (client === 'panel' && !u.perms.has('panel.access')) {
      return reply.code(403).send({ error: 'Veb panel faqat admin uchun. Mobil ilovadan foydalaning.' });
    }
    const deviceId = req.body.deviceId;
    const label = (req.body.deviceLabel ?? '').slice(0, 100) || (client === 'panel' ? 'Brauzer' : 'Telefon');
    if (!u.is_test) {
      ensureDeviceSlots(db, u.id);
      let slot = db.prepare('SELECT * FROM devices WHERE user_id = ? AND device_id = ?').get(u.id, deviceId);
      if (!slot) {
        slot = db.prepare('SELECT * FROM devices WHERE user_id = ? AND device_id IS NULL ORDER BY id LIMIT 1').get(u.id);
        if (!slot) {
          audit(db, `user:${u.login}`, 'auth.device_denied', { device: label });
          return reply.code(403).send({ error: 'Bu hisob uchun bo\'sh qurilma joyi yo\'q. Admin "Qurilmalar" bo\'limida joy ochishi kerak.' });
        }
        db.prepare("UPDATE devices SET device_id = ?, device_label = ?, bound_at = datetime('now') WHERE id = ?").run(deviceId, label, slot.id);
        audit(db, `user:${u.login}`, 'device.bound', { slot: slot.name, device: label });
      }
      db.prepare("UPDATE devices SET last_seen_at = datetime('now'), device_label = ? WHERE id = ?").run(label, slot.id);
    }
    guard.reset(key);
    audit(db, `user:${u.login}`, 'auth.login', { client, device: label });
    const token = app.jwt.sign({ uid: u.id, did: deviceId, aud: client }, { expiresIn: client === 'panel' ? PANEL_TOKEN_TTL : APP_TOKEN_TTL });
    return { token, user: publicUser(u) };
  });

  app.get('/me', need(), async (req) => publicUser(req.me));

  // Signing out releases this phone's device slot, so the person can sign back in
  // from the same (or a replaced) phone with no admin needed to free it.
  app.post('/logout', need(), async (req) => {
    const { did } = req.user ?? {};
    if (did && did !== 'recovery' && !req.me.is_test) {
      const slot = db.prepare('SELECT id, name FROM devices WHERE user_id = ? AND device_id = ?').get(req.me.id, did);
      if (slot) {
        db.prepare('UPDATE devices SET device_id = NULL, device_label = NULL, bound_at = NULL WHERE id = ?').run(slot.id);
        audit(db, req.actor, 'device.logout', { slot: slot.name });
      }
    }
    return { ok: true };
  });

  app.put('/password', need(), async (req, reply) => {
    const { current, next } = req.body ?? {};
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.me.id);
    if (!bcrypt.compareSync(String(current ?? ''), row.password_hash)) return reply.code(400).send({ error: 'Joriy parol noto\'g\'ri' });
    if (!next || String(next).length < 6) return reply.code(400).send({ error: 'Yangi parol kamida 6 belgi bo\'lsin' });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(String(next), 10), row.id);
    audit(db, req.actor, 'password.change');
    return { ok: true };
  });

  // Change your own name and login. Only staff managers (the admin) may rename
  // themselves; everyone else changes just their password above.
  app.put('/profile', need('staff.manage'), async (req, reply) => {
    const b = req.body ?? {};
    const me = db.prepare('SELECT * FROM users WHERE id = ?').get(req.me.id);
    let login = null;
    if (b.login != null && normalizeLogin(b.login) !== me.login) {
      login = normalizeLogin(b.login);
      if (!/^[a-z0-9_.-]{3,32}$/.test(login)) return reply.code(400).send({ error: 'Login 3–32 belgi: kichik harf, raqam, _ . -' });
      if (db.prepare('SELECT 1 FROM users WHERE login = ? AND id != ?').get(login, me.id)) return reply.code(400).send({ error: 'Bu login band' });
    }
    const name = b.name == null ? null : String(b.name).trim().slice(0, 120) || null;
    db.prepare('UPDATE users SET login = COALESCE(?, login), name = COALESCE(?, name) WHERE id = ?').run(login, name, me.id);
    audit(db, req.actor, 'user.update', { id: me.id, login: login ?? me.login, name: name ?? me.name, self: true });
    const fresh = loadUser(db, me.id);
    return { ok: true, user: publicUser(fresh) };
  });
}
