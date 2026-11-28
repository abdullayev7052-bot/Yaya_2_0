import bcrypt from 'bcryptjs';
import ExcelJS from 'exceljs';
import { randomInt, randomUUID } from 'node:crypto';
import { audit, ensureDeviceSlots, resetAll, roleIdByCode } from '../db/index.js';
import { makeGuard, normalizeLogin } from '../auth.js';
import { PERMISSIONS, PERMISSION_KEYS } from '../permissions.js';
import { summary, exportRows, toCsv, parseRange, dailyCost, todayLocal, diffReport } from '../reports.js';
import { balances, statement, supplierBalance } from '../ledger.js';
import { templateXlsx, importSuppliers, exportSuppliersXlsx } from '../importer.js';
import { CONFIRM_KEYS, confirmFlags, diffFlags, getSetting, setSetting } from '../settings.js';
import { ShiftError, acceptShift, cancelShift, copyShift, listShifts, shiftCopyText, shiftDetail, shiftLabel } from '../shifts.js';
import { purchaseList, purchaseBreakdown, purchaseRows } from '../purchases.js';
import { intg, setIntg, reloadBots, sendBackup, checkToken, notifyHousehold } from '../integrations.js';
import { decrypt, encrypt, listSafety, loadSafety, restore, saveSafety, snapshot } from '../backup.js';
import { bookHouseholdPayment, voidHouseholdPayment } from '../erp/finance.js';
import { actorName, describe } from '../auditText.js';

// Fields that reveal money. Stripped from every response for users without
// prices.view, so hiding prices cannot be bypassed by the client.
const MONEY_KEYS = new Set(['price', 'amount', 'avg_cost', 'min_price', 'max_price', 'current_price', 'purchased']);
function stripMoney(v) {
  if (Array.isArray(v)) return v.map(stripMoney);
  if (v && typeof v === 'object' && !(v instanceof Buffer)) {
    const out = {};
    for (const [k, x] of Object.entries(v)) if (!MONEY_KEYS.has(k)) out[k] = stripMoney(x);
    return out;
  }
  return v;
}

const METHODS = ['cash', 'card', 'transfer'];
const WIPE_PHRASE = "HAMMASINI O'CHIRISH";

// Management API, used by the web panel (admin) and by the mobile app for
// everyone else, each within their role's permissions.
export default async function adminRoutes(app, { db }) {
  const need = makeGuard(app, db);
  const str = (v, max = 200) => (v == null ? null : String(v).trim().slice(0, max) || null);
  const bad = (reply, msg) => reply.code(400).send({ error: msg });
  const num = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
  // A map coordinate: a finite number in range, or null to clear it.
  const coord = (v) => (v == null || v === '' ? null : (Number.isFinite(Number(v)) && Math.abs(Number(v)) <= 180 ? Number(v) : null));
  const has = (req, p) => req.me.perms.has(p);
  const log = (req, action, details) => audit(db, req.actor, action, details);
  // Admin can switch off cancelling shifts everywhere (default on).
  const cancelAllowed = () => getSetting(db, 'cancel_enabled') !== '0';
  const asOfParam = (q) => (/^\d{4}-\d{2}-\d{2}$/.test(q.asOf ?? '') && q.asOf < todayLocal() ? q.asOf : null);
  const shiftErr = (reply, e) => {
    if (e instanceof ShiftError) return reply.code(400).send({ error: e.message, details: e.details });
    throw e;
  };
  const checkPassword = (req, password) => {
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.me.id);
    return bcrypt.compareSync(String(password ?? ''), row.password_hash);
  };
  // Like need(), but the caller only needs ANY ONE of the listed permissions.
  const needAny = (...perms) => ({
    preHandler: [need().preHandler, async (req, reply) => {
      if (!perms.some((p) => req.me.perms.has(p))) return reply.code(403).send({ error: 'Bu amal uchun ruxsatingiz yo\'q' });
    }],
  });
  // True if the caller may act on this household: either they can see all
  // households (office roles), or it is not hidden from them (field collector).
  const assigned = (req, supplierId) => has(req, 'suppliers.view')
    || !db.prepare('SELECT 1 FROM employee_hidden_suppliers WHERE employee_id = ? AND supplier_id = ?').get(req.me.id, supplierId);

  app.addHook('preSerialization', async (req, reply, payload) =>
    (req.me && !req.me.perms.has('prices.view') ? stripMoney(payload) : payload));

  // ---------------------------------------------------------------- roles
  app.get('/permissions', need('staff.manage'), async () => PERMISSIONS);

  app.get('/roles', need('staff.manage'), async () => db.prepare(`SELECT r.*, (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id) AS users
    FROM roles r ORDER BY r.locked DESC, r.id`).all()
    .map((r) => ({ ...r, permissions: r.code === 'admin' ? PERMISSIONS.map((p) => p.key) : JSON.parse(r.permissions) })));

  const cleanPerms = (list) => [...new Set((Array.isArray(list) ? list : []).filter((k) => PERMISSION_KEYS.has(k)))];

  app.post('/roles', need('staff.manage'), async (req, reply) => {
    const name = str(req.body?.name, 60);
    if (!name) return bad(reply, 'Nomi shart');
    const id = db.prepare('INSERT INTO roles (name, permissions) VALUES (?, ?)').run(name, JSON.stringify(cleanPerms(req.body?.permissions))).lastInsertRowid;
    log(req, 'role.create', { id, name });
    return { id };
  });

  app.patch('/roles/:id', need('staff.manage'), async (req, reply) => {
    const r = db.prepare('SELECT * FROM roles WHERE id = ?').get(req.params.id);
    if (!r) return reply.code(404).send({ error: 'Topilmadi' });
    if (r.locked) return bad(reply, 'Admin roli o\'zgartirilmaydi — u doim barcha ruxsatlarga ega');
    const name = req.body?.name === undefined ? r.name : str(req.body.name, 60);
    if (!name) return bad(reply, 'Nomi shart');
    const perms = req.body?.permissions === undefined ? JSON.parse(r.permissions) : cleanPerms(req.body.permissions);
    db.prepare('UPDATE roles SET name = ?, permissions = ? WHERE id = ?').run(name, JSON.stringify(perms), r.id);
    log(req, 'role.update', { id: r.id, name, permissions: perms });
    return { ok: true };
  });

  app.delete('/roles/:id', need('staff.manage'), async (req, reply) => {
    const r = db.prepare('SELECT r.*, (SELECT COUNT(*) FROM users WHERE role_id = r.id) AS used FROM roles r WHERE id = ?').get(req.params.id);
    if (!r) return reply.code(404).send({ error: 'Topilmadi' });
    if (r.code) return bad(reply, 'Tayyor rollarni o\'chirib bo\'lmaydi');
    if (r.used) return bad(reply, 'Bu rol kimgadir biriktirilgan. Avval ularni boshqa rolga o\'tkazing.');
    db.prepare('DELETE FROM roles WHERE id = ?').run(r.id);
    log(req, 'role.delete', { id: r.id, name: r.name });
    return { ok: true };
  });

  // ---------------------------------------------------------------- staff (all users)
  const adminRole = () => roleIdByCode(db, 'admin');
  const activeAdmins = () => db.prepare('SELECT COUNT(*) n FROM users WHERE role_id = ? AND active = 1').get(adminRole()).n;
  const roleExists = (id) => !!db.prepare('SELECT 1 FROM roles WHERE id = ?').get(id);

  app.get('/staff', need('staff.manage'), async () => db.prepare(`
    SELECT u.id, u.login, u.name, u.phone, u.role_id, r.name AS role_name, u.is_test, u.active, u.created_at, u.kiosk, u.pin_hash IS NOT NULL AS has_pin,
      (SELECT COUNT(*) FROM employee_hidden_suppliers eh WHERE eh.employee_id = u.id) AS hidden_count,
      (SELECT COUNT(*) FROM devices d WHERE d.user_id = u.id) AS device_slots,
      (SELECT COUNT(*) FROM devices d WHERE d.user_id = u.id AND d.device_id IS NOT NULL) AS devices_bound,
      (SELECT MAX(last_seen_at) FROM devices d WHERE d.user_id = u.id) AS last_seen_at
    FROM users u LEFT JOIN roles r ON r.id = u.role_id ORDER BY u.is_test, u.active DESC, u.name, u.login`).all());

  // Light list for filters and pickers. Only roles that actually use the filters
  // (reports, shifts) or manage staff can read it, so logins are not exposed to
  // every signed-in field user.
  app.get('/staff/names', needAny('staff.manage', 'shifts.view_all', 'reports.view'), async () => db.prepare(`SELECT u.id, u.name, u.login, u.is_test FROM users u WHERE u.active = 1
    ORDER BY u.is_test, u.name`).all());

  app.post('/staff', need('staff.manage'), async (req, reply) => {
    const b = req.body ?? {};
    const login = normalizeLogin(b.login);
    const roleId = num(b.roleId);
    if (!/^[a-z0-9_.-]{3,32}$/.test(login)) return bad(reply, 'Login 3–32 belgi: kichik harf, raqam, _ . - (telefon raqam ham bo\'ladi)');
    if (!b.password || String(b.password).length < 6) return bad(reply, 'Parol kamida 6 belgi bo\'lsin');
    if (!roleId || !roleExists(roleId)) return bad(reply, 'Rolni tanlang');
    if (db.prepare('SELECT 1 FROM users WHERE login = ?').get(login)) return bad(reply, 'Bu login band');
    // "Uses the monoblock": only then is a PIN asked for and the person shown there.
    const id = Number(db.prepare('INSERT INTO users (login, name, phone, password_hash, role_id, is_test, kiosk) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(login, str(b.name), str(b.phone, 30)?.replace(/[^\d+]/g, '') || null, bcrypt.hashSync(String(b.password), 10), roleId, Number(!!b.isTest), Number(!!b.kiosk)).lastInsertRowid);
    ensureDeviceSlots(db, id);
    log(req, 'user.create', { id, login, name: b.name, roleId });
    return { id };
  });

  app.patch('/staff/:id', need('staff.manage'), async (req, reply) => {
    const id = Number(req.params.id);
    const b = req.body ?? {};
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!target) return reply.code(404).send({ error: 'Topilmadi' });
    const roleId = b.roleId == null ? null : num(b.roleId);
    if (b.roleId != null && (!roleId || !roleExists(roleId))) return bad(reply, 'Rol noto\'g\'ri');
    if (b.password && String(b.password).length < 6) return bad(reply, 'Parol kamida 6 belgi bo\'lsin');
    let login = null;
    if (b.login != null && b.login !== target.login) {
      login = normalizeLogin(b.login);
      if (!/^[a-z0-9_.-]{3,32}$/.test(login)) return bad(reply, 'Login noto\'g\'ri');
      if (db.prepare('SELECT 1 FROM users WHERE login = ? AND id != ?').get(login, id)) return bad(reply, 'Bu login band');
    }
    // Never lock everyone out: the last active admin keeps the admin role.
    const losesAdmin = target.role_id === adminRole() && target.active && ((roleId && roleId !== adminRole()) || b.active === false);
    if (losesAdmin && activeAdmins() <= 1) return bad(reply, 'Kamida bitta faol admin qolishi kerak');
    db.prepare(`UPDATE users SET login = COALESCE(?, login), name = COALESCE(?, name), phone = COALESCE(?, phone), role_id = COALESCE(?, role_id),
      password_hash = COALESCE(?, password_hash), active = COALESCE(?, active), is_test = COALESCE(?, is_test) WHERE id = ?`)
      .run(login, str(b.name), b.phone == null ? null : str(b.phone, 30)?.replace(/[^\d+]/g, '') ?? '', roleId,
        b.password ? bcrypt.hashSync(String(b.password), 10) : null, b.active == null ? null : Number(!!b.active),
        b.isTest == null ? null : Number(!!b.isTest), id);
    // Off the monoblock: the PIN goes too.
    if (b.kiosk != null) db.prepare(`UPDATE users SET kiosk = ?${b.kiosk ? '' : ', pin_hash = NULL'} WHERE id = ?`).run(Number(!!b.kiosk), id);
    log(req, 'user.update', { id, login: login ?? target.login, name: b.name ?? target.name, roleId, active: b.active, passwordChanged: !!b.password });
    return { ok: true };
  });

  // Permanently remove a deactivated staff member from the system. Only possible
  // when they have no history (shifts, pickups, payments) that must be kept.
  app.delete('/staff/:id', need('staff.manage'), async (req, reply) => {
    const id = Number(req.params.id);
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!u) return reply.code(404).send({ error: 'Topilmadi' });
    if (u.active) return bad(reply, 'Avval xodimni o\'chiring (nofaol qiling), keyin butunlay o\'chirish mumkin');
    if (u.role_id === adminRole() && activeAdmins() <= 1) return bad(reply, 'Oxirgi adminni o\'chirib bo\'lmaydi');
    const refs = db.prepare(`SELECT
        (SELECT COUNT(*) FROM shifts WHERE employee_id = @id) +
        (SELECT COUNT(*) FROM collections WHERE employee_id = @id) +
        (SELECT COUNT(*) FROM payments WHERE employee_id = @id) AS n`).get({ id }).n;
    if (refs > 0) return bad(reply, 'Bu xodimda smena yoki to\'lov tarixi bor — butunlay o\'chirib bo\'lmaydi. Nofaol holatda qoladi.');
    db.transaction(() => {
      db.prepare('DELETE FROM employee_suppliers WHERE employee_id = ?').run(id);
      db.prepare('DELETE FROM employee_hidden_suppliers WHERE employee_id = ?').run(id);
      db.prepare('DELETE FROM devices WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM users WHERE id = ?').run(id);
    })();
    log(req, 'user.delete', { id, login: u.login, name: u.name });
    return { ok: true };
  });

  // Every household is visible to every collector by default; this returns the
  // households HIDDEN from one employee (the exceptions the admin set).
  app.get('/staff/:id/hidden', need('staff.manage'), async (req) =>
    db.prepare('SELECT supplier_id FROM employee_hidden_suppliers WHERE employee_id = ?').all(req.params.id).map((x) => x.supplier_id));

  app.put('/staff/:id/hidden', need('staff.manage'), async (req) => {
    const ids = (req.body?.supplierIds ?? []).map(Number).filter(Number.isInteger);
    db.transaction(() => {
      db.prepare('DELETE FROM employee_hidden_suppliers WHERE employee_id = ?').run(req.params.id);
      const ins = db.prepare('INSERT OR IGNORE INTO employee_hidden_suppliers (employee_id, supplier_id) VALUES (?, ?)');
      ids.forEach((sid) => ins.run(req.params.id, sid));
    })();
    const u = db.prepare('SELECT name, login FROM users WHERE id = ?').get(req.params.id);
    log(req, 'user.hidden', { id: Number(req.params.id), name: u?.name || u?.login, count: ids.length });
    return { ok: true };
  });

  // ---------------------------------------------------------------- devices
  app.get('/devices', need('staff.manage'), async () => db.prepare(`SELECT d.*, u.login, u.name AS user_name FROM devices d
    JOIN users u ON u.id = d.user_id ORDER BY u.name, u.login, d.id`).all());

  app.post('/devices', need('staff.manage'), async (req, reply) => {
    const userId = num(req.body?.userId);
    const u = userId && db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!u) return bad(reply, 'Xodimni tanlang');
    const n = db.prepare('SELECT COUNT(*) n FROM devices WHERE user_id = ?').get(userId).n;
    if (n >= 10) return bad(reply, 'Bitta xodimga 10 tadan ortiq qurilma ochib bo\'lmaydi');
    const id = db.prepare('INSERT INTO devices (user_id, name) VALUES (?, ?)').run(userId, str(req.body?.name, 60) ?? `Qurilma ${n + 1}`).lastInsertRowid;
    log(req, 'device.add', { user: u.name || u.login });
    return { id };
  });

  app.patch('/devices/:id', need('staff.manage'), async (req, reply) => {
    const d = db.prepare('SELECT d.*, u.login, u.name AS user_name FROM devices d JOIN users u ON u.id = d.user_id WHERE d.id = ?').get(req.params.id);
    if (!d) return reply.code(404).send({ error: 'Topilmadi' });
    if (req.body?.name !== undefined) db.prepare('UPDATE devices SET name = ? WHERE id = ?').run(str(req.body.name, 60) ?? d.name, d.id);
    // Freeing a slot signs that device out on its next request.
    if (req.body?.free) {
      db.prepare('UPDATE devices SET device_id = NULL, device_label = NULL, bound_at = NULL WHERE id = ?').run(d.id);
      log(req, 'device.free', { user: d.user_name || d.login, slot: d.name });
    }
    return { ok: true };
  });

  app.delete('/devices/:id', need('staff.manage'), async (req, reply) => {
    const d = db.prepare('SELECT d.*, u.login, u.name AS user_name FROM devices d JOIN users u ON u.id = d.user_id WHERE d.id = ?').get(req.params.id);
    if (!d) return reply.code(404).send({ error: 'Topilmadi' });
    db.prepare('DELETE FROM devices WHERE id = ?').run(d.id);
    log(req, 'device.delete', { user: d.user_name || d.login });
    return { ok: true };
  });

  // ---------------------------------------------------------------- suppliers & products
  app.get('/suppliers', need('suppliers.view'), async () => db.prepare(`SELECT s.*,
      (SELECT GROUP_CONCAT(COALESCE(u.name, u.login), ', ') FROM employee_suppliers es JOIN users u ON u.id = es.employee_id WHERE es.supplier_id = s.id) AS collectors
    FROM suppliers s ORDER BY s.active DESC, s.name`).all());

  app.post('/suppliers', need('suppliers.create'), async (req, reply) => {
    const b = req.body ?? {};
    const name = str(b.name, 120);
    if (!name) return bad(reply, 'Ism shart');
    const id = Number(db.prepare('INSERT INTO suppliers (name, phone, address, address2, note, lat, lng, lat2, lng2, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(name, str(b.phone, 30)?.replace(/[^\d+]/g, '') || null, str(b.address), str(b.address2), str(b.note), coord(b.lat), coord(b.lng), coord(b.lat2), coord(b.lng2), req.actor).lastInsertRowid);
    if (b.openingBalance != null && has(req, 'payments.create')) {
      db.prepare('UPDATE suppliers SET opening_balance = ? WHERE id = ?').run(Number(b.openingBalance) || 0, id);
    }
    log(req, 'suppliers.create', { id, name });
    return { id };
  });

  // Field-level: name/phone/note/active need suppliers.edit; address and the map
  // point need suppliers.location (so a collector can mark where a supplier is
  // without being able to rename them). The guard only checks the token here.
  app.patch('/suppliers/:id', need(), async (req, reply) => {
    const b = req.body ?? {};
    const s = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(req.params.id);
    if (!s) return reply.code(404).send({ error: 'Topilmadi' });
    const touchesIdentity = ['name', 'phone', 'note', 'active'].some((k) => b[k] !== undefined);
    const touchesLocation = ['address', 'lat', 'lng', 'address2', 'lat2', 'lng2'].some((k) => b[k] !== undefined);
    if (touchesIdentity && !has(req, 'suppliers.edit')) return reply.code(403).send({ error: 'Ma\'lumotlarni o\'zgartirishga ruxsatingiz yo\'q' });
    if (touchesLocation && !has(req, 'suppliers.location') && !has(req, 'suppliers.edit')) {
      return reply.code(403).send({ error: 'Manzil/joylashuvni o\'zgartirishga ruxsatingiz yo\'q' });
    }
    // A field user with only suppliers.location may edit the location of their own
    // assigned households, not everyone's (office roles with suppliers.edit can).
    if (touchesLocation && !has(req, 'suppliers.edit') && !assigned(req, s.id)) {
      return reply.code(403).send({ error: 'Bu xonadon sizga biriktirilmagan' });
    }
    if (b.name !== undefined && !str(b.name)) return bad(reply, 'Ism bo\'sh bo\'lmasin');
    db.prepare(`UPDATE suppliers SET name = COALESCE(?, name), phone = CASE WHEN ? THEN ? ELSE phone END,
      note = CASE WHEN ? THEN ? ELSE note END, active = COALESCE(?, active),
      address = CASE WHEN ? THEN ? ELSE address END, lat = CASE WHEN ? THEN ? ELSE lat END, lng = CASE WHEN ? THEN ? ELSE lng END,
      address2 = CASE WHEN ? THEN ? ELSE address2 END, lat2 = CASE WHEN ? THEN ? ELSE lat2 END, lng2 = CASE WHEN ? THEN ? ELSE lng2 END WHERE id = ?`)
      .run(touchesIdentity ? str(b.name, 120) : null, Number(b.phone !== undefined), str(b.phone, 30)?.replace(/[^\d+]/g, '') || null,
        Number(b.note !== undefined), str(b.note), touchesIdentity && b.active != null ? Number(!!b.active) : null,
        Number(b.address !== undefined), str(b.address), Number(b.lat !== undefined), coord(b.lat), Number(b.lng !== undefined), coord(b.lng),
        Number(b.address2 !== undefined), str(b.address2), Number(b.lat2 !== undefined), coord(b.lat2), Number(b.lng2 !== undefined), coord(b.lng2), s.id);
    if (touchesLocation) log(req, 'suppliers.location', { id: s.id, name: s.name });
    if (touchesIdentity) log(req, 'suppliers.update', { id: s.id, name: b.name ?? s.name, active: b.active });
    return { ok: true };
  });

  // Permanently remove a deactivated household. The only hard rule is a zero
  // balance (no qarzdorlik/haqdorlik) — money must be settled first. A household
  // with no history is removed cleanly; one WITH history needs force: true, which
  // also deletes its milk/payment history (so past reports change). The panel asks
  // a stronger confirmation before sending force.
  app.delete('/suppliers/:id', need('suppliers.edit'), async (req, reply) => {
    const id = Number(req.params.id);
    const s = db.prepare('SELECT id, name, active FROM suppliers WHERE id = ?').get(id);
    if (!s) return reply.code(404).send({ error: 'Topilmadi' });
    if (s.active) return bad(reply, 'Avval xonadonni o\'chiring (nofaol qiling), keyin butunlay o\'chirib bo\'ladi.');
    if (supplierBalance(db, id) !== 0) return bad(reply, 'Bu xonadonda qarzdorlik yoki haqdorlik bor — avval hisob-kitobni 0 qiling.');
    const hasHistory = db.prepare('SELECT 1 FROM collections WHERE supplier_id = ? LIMIT 1').get(id)
      || db.prepare('SELECT 1 FROM payments WHERE supplier_id = ? LIMIT 1').get(id)
      || db.prepare('SELECT 1 FROM adjustments WHERE supplier_id = ? LIMIT 1').get(id);
    const force = req.body?.force === true || req.query?.force === '1';
    if (hasHistory && !force) return reply.code(409).send({ error: 'Bu xonadonda sut yoki to\'lov tarixi bor. Tarix bilan birga butunlay o\'chirish uchun tasdiqlang.', hasHistory: true });
    db.transaction(() => {
      if (hasHistory) {
        db.prepare('DELETE FROM collections WHERE supplier_id = ?').run(id);
        db.prepare('DELETE FROM payments WHERE supplier_id = ?').run(id);
        db.prepare('DELETE FROM adjustments WHERE supplier_id = ?').run(id);
      }
      db.prepare('DELETE FROM supplier_products WHERE supplier_id = ?').run(id);
      db.prepare('DELETE FROM employee_suppliers WHERE supplier_id = ?').run(id);
      db.prepare('DELETE FROM employee_hidden_suppliers WHERE supplier_id = ?').run(id);
      db.prepare('DELETE FROM suppliers WHERE id = ?').run(id);
    })();
    log(req, 'suppliers.delete', { id, name: s.name, withHistory: !!hasHistory });
    return { ok: true };
  });

  app.get('/suppliers/:id/card', need('suppliers.view'), async (req, reply) => {
    const id = Number(req.params.id);
    const s = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id);
    if (!s) return reply.code(404).send({ error: 'Topilmadi' });
    const to = todayLocal();
    const from = new Date(Date.parse(to) - 59 * 864e5).toISOString().slice(0, 10);
    const card = {
      supplier: s,
      products: db.prepare(`SELECT p.id, p.name, p.unit, sp.price, sp.is_default FROM supplier_products sp
        JOIN products p ON p.id = sp.product_id WHERE sp.supplier_id = ? ORDER BY sp.is_default DESC, p.name`).all(id),
      collectors: db.prepare(`SELECT u.id, u.name, u.login FROM employee_suppliers es JOIN users u ON u.id = es.employee_id
        WHERE es.supplier_id = ? ORDER BY u.name`).all(id),
      last60: summary(db, { from, to, supplier: id }),
      allTime: summary(db, { from: '2000-01-01', to, supplier: id }).totals,
      balance: has(req, 'debts.view') ? supplierBalance(db, id) : undefined,
    };
    if (has(req, 'debts.view')) card.statement = statement(db, id);
    return card;
  });

  app.get('/suppliers-import/template.xlsx', need('suppliers.import'), async (req, reply) => {
    reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    reply.header('Content-Disposition', 'attachment; filename="yaya_yetkazib_beruvchilar_shablon.xlsx"');
    return Buffer.from(await templateXlsx(db));
  });

  app.get('/suppliers-export.xlsx', need('suppliers.import'), async (req, reply) => {
    log(req, 'suppliers.export');
    reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    reply.header('Content-Disposition', `attachment; filename="yaya_yetkazib_beruvchilar_${todayLocal()}.xlsx"`);
    const showMoney = has(req, 'prices.view');
    return Buffer.from(await exportSuppliersXlsx(db, (id) => (showMoney ? supplierBalance(db, id) : null)));
  });

  app.post('/suppliers-import', { ...need('suppliers.import', 'prices.manage'), bodyLimit: 12 * 1024 * 1024 }, async (req, reply) => {
    const b64 = String(req.body?.file ?? '').replace(/^data:.*?;base64,/, '');
    if (!b64) return bad(reply, 'Fayl yuborilmadi');
    const buf = Buffer.from(b64, 'base64');
    if (buf.length > 8 * 1024 * 1024) return bad(reply, 'Fayl 8 MB dan katta');
    try {
      const r = await importSuppliers(db, buf, { dryRun: req.body?.dryRun !== false });
      if (!r.dryRun) log(req, 'suppliers.import', r.summary);
      return r;
    } catch (err) {
      return bad(reply, err.message);
    }
  });

  // Milk collection only deals with what collectors bring (Yog'li / Yog'siz sut);
  // warehouse products (Xom sut, raw materials, containers...) live in the Ombor section.
  app.get('/products', need(), async () => db.prepare("SELECT * FROM products WHERE kind = 'milk' ORDER BY active DESC, name").all());
  app.post('/products', need('catalog.manage'), async (req, reply) => {
    const name = str(req.body?.name, 60);
    if (!name) return bad(reply, 'Nomi shart');
    const id = db.prepare('INSERT INTO products (name, unit) VALUES (?, ?)').run(name, str(req.body?.unit, 10) ?? 'kg').lastInsertRowid;
    log(req, 'products.create', { id, name });
    return { id };
  });
  app.patch('/products/:id', need('catalog.manage'), async (req, reply) => {
    const p = db.prepare("SELECT * FROM products WHERE id = ? AND kind = 'milk'").get(req.params.id);
    if (!p) return reply.code(404).send({ error: 'Topilmadi' });
    db.prepare('UPDATE products SET name = COALESCE(?, name), unit = COALESCE(?, unit), active = COALESCE(?, active) WHERE id = ?')
      .run(str(req.body?.name, 60), str(req.body?.unit, 10), req.body?.active == null ? null : Number(!!req.body.active), p.id);
    log(req, 'products.update', { id: p.id, name: req.body?.name ?? p.name });
    return { ok: true };
  });

  // ---------------------------------------------------------------- prices
  app.get('/supplier-products', need('suppliers.view'), async () => db.prepare(`
    SELECT sp.*, s.name AS supplier_name, p.name AS product_name, p.unit
    FROM supplier_products sp JOIN suppliers s ON s.id = sp.supplier_id JOIN products p ON p.id = sp.product_id
    ORDER BY s.name, sp.is_default DESC, p.name`).all());

  app.put('/supplier-products', need('prices.manage'), async (req, reply) => {
    const { supplierId, productId, isDefault } = req.body ?? {};
    const price = Number(req.body?.price);
    if (!supplierId || !productId || !Number.isFinite(price) || price < 0 || price > 1e9) return bad(reply, 'Narx noto\'g\'ri');
    if (!db.prepare("SELECT 1 FROM products WHERE id = ? AND kind = 'milk'").get(productId)) return bad(reply, 'Narx faqat yig\'uvchilar suti uchun belgilanadi');
    db.transaction(() => {
      if (isDefault) db.prepare('UPDATE supplier_products SET is_default = 0 WHERE supplier_id = ?').run(supplierId);
      db.prepare(`INSERT INTO supplier_products (supplier_id, product_id, price, is_default) VALUES (?, ?, ?, ?)
        ON CONFLICT(supplier_id, product_id) DO UPDATE SET price = excluded.price, is_default = excluded.is_default`)
        .run(supplierId, productId, price, isDefault ? 1 : 0);
      if (!db.prepare('SELECT 1 FROM supplier_products WHERE supplier_id = ? AND is_default = 1').get(supplierId)) {
        db.prepare('UPDATE supplier_products SET is_default = 1 WHERE supplier_id = ? AND product_id = ?').run(supplierId, productId);
      }
    })();
    const names = db.prepare('SELECT s.name AS supplier, p.name AS product FROM suppliers s, products p WHERE s.id = ? AND p.id = ?').get(supplierId, productId);
    log(req, 'price.set', { supplierId, productId, price, ...names });
    return { ok: true };
  });

  app.delete('/supplier-products/:supplierId/:productId', need('prices.manage'), async (req) => {
    const { supplierId, productId } = req.params;
    const names = db.prepare('SELECT s.name AS supplier, p.name AS product FROM suppliers s, products p WHERE s.id = ? AND p.id = ?').get(supplierId, productId);
    db.transaction(() => {
      db.prepare('DELETE FROM supplier_products WHERE supplier_id = ? AND product_id = ?').run(supplierId, productId);
      if (!db.prepare('SELECT 1 FROM supplier_products WHERE supplier_id = ? AND is_default = 1').get(supplierId)) {
        db.prepare('UPDATE supplier_products SET is_default = 1 WHERE rowid = (SELECT MIN(rowid) FROM supplier_products WHERE supplier_id = ?)').run(supplierId);
      }
    })();
    log(req, 'price.remove', { ...names });
    return { ok: true };
  });

  // ---------------------------------------------------------------- shifts
  app.get('/shifts', need('shifts.view_all'), async (req) => {
    const q = req.query;
    const status = ['open', 'closed', 'accepted', 'cancelled'].includes(q.status) ? q.status : null;
    // Open and waiting shifts are shown whatever the date, so nothing is missed.
    const range = status === 'open' || status === 'closed' ? { from: null, to: null } : parseRange(q);
    const list = listShifts(db, { ...range, status, employee: num(q.employee) });
    if (!has(req, 'diff.view')) for (const s of list) { delete s.accepted_quantity; delete s.diff_quantity; }
    return list;
  });

  app.get('/shifts/:id', need('shifts.view_all'), async (req, reply) => {
    const d = shiftDetail(db, req.params.id);
    if (!d) return reply.code(404).send({ error: 'Topilmadi' });
    // The accepted-quantity difference is only for those allowed to see it; the
    // acceptor also gets the feature flag and limits so the app can enforce them.
    if (!has(req, 'diff.view')) delete d.diff;
    else d.diff = { ...d.diff, ...diffFlags(db) };
    return d;
  });

  // Plain-text summary of a shift for the clipboard (grouped by product). What it
  // includes is controlled by the "Nusxalash sozlamalari" settings; prices are
  // dropped for callers without prices.view regardless.
  app.get('/shifts/:id/copytext', need('shifts.view_all'), async (req) => ({
    text: shiftCopyText(db, req.params.id, {
      prices: has(req, 'prices.view'),
      showProduct: getSetting(db, 'copy_show_product') !== '0',
      showHousehold: getSetting(db, 'copy_show_household') !== '0',
      showPrice: getSetting(db, 'copy_show_price') !== '0',
      showQty: getSetting(db, 'copy_show_qty') !== '0',
      showDiff: has(req, 'diff.view'),
    }),
  }));

  app.post('/shifts/:id/accept', need('shifts.accept'), async (req, reply) => {
    try {
      // Optional per-product real quantities for the difference feature.
      const real = req.body && typeof req.body.real === 'object' ? req.body.real : {};
      const s = acceptShift(db, Number(req.params.id), req.actor, { real });
      const u = db.prepare('SELECT name FROM users WHERE id = ?').get(s.employee_id);
      log(req, 'shift.accept', { shift: shiftLabel(s), employee: u?.name });
      notifyHousehold(db, 'purchase', { shiftId: s.id });
      return { ok: true };
    } catch (e) { return shiftErr(reply, e); }
  });

  app.post('/shifts/:id/cancel', need('shifts.cancel'), async (req, reply) => {
    if (!cancelAllowed()) return reply.code(403).send({ error: 'Bekor qilish o\'chirilgan' });
    try {
      const s = cancelShift(db, Number(req.params.id), req.actor, str(req.body?.reason, 300));
      const u = db.prepare('SELECT name FROM users WHERE id = ?').get(s.employee_id);
      log(req, 'shift.cancel', { shift: shiftLabel(s), employee: u?.name, reason: s.cancel_reason });
      return { ok: true };
    } catch (e) { return shiftErr(reply, e); }
  });

  app.post('/shifts/:id/copy', need('shifts.copy'), async (req, reply) => {
    try {
      const from = db.prepare('SELECT * FROM shifts WHERE id = ?').get(req.params.id);
      const s = copyShift(db, Number(req.params.id), req.actor);
      log(req, 'shift.copy', { from: from && shiftLabel(from), to: shiftLabel(s) });
      return { id: s.id, label: shiftLabel(s) };
    } catch (e) { return shiftErr(reply, e); }
  });

  // ---------------------------------------------------------------- payments & debts
  app.get('/balances', need('debts.view'), async (req) => balances(db, { q: req.query.q, asOf: asOfParam(req.query) }));

  // Edit balances: set one or more households to an exact balance. Each becomes a
  // signed adjustment (target − current) so the whole history stays intact. Admin
  // only (staff.manage) and re-confirmed with the admin's own password, because it
  // rewrites money directly.
  app.post('/balances/edit', need('staff.manage'), async (req, reply) => {
    const b = req.body ?? {};
    if (!checkPassword(req, b.password)) return bad(reply, 'Parol noto\'g\'ri');
    const items = Array.isArray(b.items) ? b.items : [];
    const note = str(b.note, 300);
    const clean = items.map((x) => ({ supplierId: num(x.supplierId), target: Math.round(Number(x.target)) }))
      .filter((x) => x.supplierId && Number.isFinite(x.target));
    if (!clean.length) return bad(reply, 'Hech bir xonadon tanlanmadi');
    const batch = randomUUID();
    const done = db.transaction(() => {
      const ins = db.prepare('INSERT INTO adjustments (supplier_id, delta, note, batch_id, created_by) VALUES (?, ?, ?, ?, ?)');
      const out = [];
      for (const it of clean) {
        const cur = supplierBalance(db, it.supplierId);
        const delta = it.target - cur;
        if (delta === 0) continue;
        ins.run(it.supplierId, delta, note, batch, req.actor);
        out.push({ supplierId: it.supplierId, from: cur, to: it.target });
      }
      return out;
    })();
    log(req, 'balance.edit', { count: done.length, note });
    for (const d of done) notifyHousehold(db, 'balance', { supplierId: d.supplierId, note });
    return { ok: true, changed: done.length };
  });

  // ---------------------------------------------------------------- integrations (Telegram bots)
  app.get('/integrations', need('integrations.manage'), async () => {
    const s = intg(db);
    const hh = db.prepare('SELECT COUNT(*) AS n FROM tg_households').get().n;
    return { ...s, hh_linked: hh };
  });
  app.put('/integrations', need('integrations.manage'), async (req) => {
    setIntg(db, req.body ?? {});
    reloadBots(db);
    log(req, 'integrations.update', { keys: Object.keys(req.body ?? {}) });
    return { ok: true };
  });
  // Validate a token with Telegram's getMe, so the admin sees it works.
  app.post('/integrations/check', need('integrations.manage'), async (req) => {
    const r = await checkToken(str(req.body?.token, 100));
    return r?.ok ? { ok: true, username: r.result?.username } : { ok: false, error: r?.description || r?.error || 'Token noto\'g\'ri' };
  });
  app.post('/integrations/backup/now', need('integrations.manage'), async (req) => {
    const r = await sendBackup(db, { manual: true });
    log(req, 'integrations.backup.manual', { ok: r.ok });
    return r;
  });

  app.get('/balances-export.xlsx', need('debts.view'), async (req, reply) => {
    const rows = balances(db, { q: req.query.q, asOf: asOfParam(req.query) }).rows;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Qarzlar');
    ws.columns = [
      { header: 'Xonadon', key: 'name', width: 28 }, { header: 'Telefon', key: 'phone', width: 16 },
      { header: 'Manzil', key: 'address', width: 24 },
      { header: 'Qarzdorlik (so\'m)', key: 'owe', width: 18 }, { header: 'Haqdorlik (so\'m)', key: 'credit', width: 18 },
      { header: 'Balans (so\'m)', key: 'balance', width: 16 },
    ];
    ws.getRow(1).font = { bold: true };
    for (const r of rows) {
      ws.addRow({ name: r.name, phone: r.phone ?? '', address: r.address ?? '',
        owe: Math.max(0, r.balance), credit: Math.max(0, -r.balance), balance: r.balance });
    }
    log(req, 'report.export', { from: 'balances', to: asOfParam(req.query) ?? todayLocal() });
    reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    reply.header('Content-Disposition', 'attachment; filename="yaya_qarzlar.xlsx"');
    return Buffer.from(await wb.xlsx.writeBuffer());
  });

  app.get('/payments', need('debts.view'), async (req) => {
    const { from, to } = parseRange(req.query);
    const p = { from, to, supplier: num(req.query.supplier), voided: req.query.voided === '1' ? 1 : 0 };
    const pays = db.prepare(`SELECT p.id, p.number, 'payment' AS kind, p.supplier_id, s.name AS supplier_name, p.amount, p.method, p.note,
        p.paid_at AS at, p.voided_at, p.void_reason,
        (SELECT COALESCE(u.name, u.login) FROM users u WHERE 'user:' || u.login = p.created_by) AS by_name
      FROM payments p JOIN suppliers s ON s.id = p.supplier_id
      WHERE date(p.paid_at, '+5 hours') BETWEEN @from AND @to AND (@supplier IS NULL OR p.supplier_id = @supplier)
        AND (@voided = 1 OR p.voided_at IS NULL)`).all(p);
    // Manual balance corrections appear in the same history as "Balans tahrirlandi".
    const adj = db.prepare(`SELECT a.id, 'adjust' AS kind, a.supplier_id, s.name AS supplier_name, a.delta AS amount, NULL AS method, a.note,
        a.created_at AS at, NULL AS voided_at, NULL AS void_reason,
        (SELECT COALESCE(u.name, u.login) FROM users u WHERE 'user:' || u.login = a.created_by) AS by_name
      FROM adjustments a JOIN suppliers s ON s.id = a.supplier_id
      WHERE date(a.created_at, '+5 hours') BETWEEN @from AND @to AND (@supplier IS NULL OR a.supplier_id = @supplier)`).all(p);
    return [...pays, ...adj].sort((x, y) => String(y.at).localeCompare(String(x.at))).slice(0, 2000);
  });

  app.post('/payments', need('payments.create'), async (req, reply) => {
    const supplierId = num(req.body?.supplierId);
    const amount = Math.round(Number(req.body?.amount));
    const method = METHODS.includes(req.body?.method) ? req.body.method : 'cash';
    const s = supplierId && db.prepare('SELECT name FROM suppliers WHERE id = ?').get(supplierId);
    if (!s) return bad(reply, 'Xonadonni tanlang');
    if (!assigned(req, supplierId)) return reply.code(403).send({ error: 'Bu xonadon sizga biriktirilmagan' });
    if (!(amount > 0) || amount > 1e11) return bad(reply, 'Summa noto\'g\'ri');
    const paidAt = req.body?.paidAt && !Number.isNaN(Date.parse(req.body.paidAt)) ? new Date(req.body.paidAt).toISOString() : new Date().toISOString();
    const id = db.prepare(`INSERT INTO payments (client_uuid, supplier_id, amount, method, note, paid_at, created_by, employee_id, number)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(number), 0) + 1 FROM payments))`).run(req.body?.uuid ? String(req.body.uuid) : randomUUID(), supplierId, amount, method,
      str(req.body?.note, 300), paidAt, req.actor, req.me.is_test ? req.me.id : null).lastInsertRowid;
    // The money leaves a cashbox (chosen, the payer's own, or the main one).
    const cashboxId = bookHouseholdPayment(db, Number(id), req.me, req.body?.cashboxId);
    log(req, 'payment.create', { id, supplierId, supplier: s.name, amount, method, cashboxId });
    notifyHousehold(db, 'payment', { paymentId: id });
    // The new balance is money: only return it to callers allowed to see debts.
    return { id, ...(has(req, 'debts.view') ? { balance: supplierBalance(db, supplierId) } : {}) };
  });

  app.post('/payments/:id/void', need('payments.void'), async (req, reply) => {
    const reason = str(req.body?.reason, 300);
    if (!reason) return bad(reply, 'Sababini yozing');
    const p = db.prepare('SELECT * FROM payments WHERE id = ? AND voided_at IS NULL').get(req.params.id);
    if (!p) return reply.code(404).send({ error: 'Topilmadi yoki allaqachon bekor qilingan' });
    db.prepare("UPDATE payments SET voided_at = datetime('now'), void_reason = ?, voided_by = ? WHERE id = ?").run(reason, req.actor, p.id);
    voidHouseholdPayment(db, p.id);
    log(req, 'payment.void', { id: p.id, amount: p.amount, reason });
    notifyHousehold(db, 'void', { paymentId: p.id });
    return { ok: true };
  });

  // ---------------------------------------------------------------- reports
  // ---------------------------------------------------------------- purchases
  // Numbered purchases (24-2 = 2nd household in shift 24), accepted shifts only,
  // plus each shift's difference as a final row. Filters: date, collector, household, shift.
  app.get('/purchases', need('reports.view'), async (req) => purchaseList(db, req.query));
  app.get('/purchases/breakdown', need('reports.view'), async (req, reply) => {
    const shiftId = num(req.query.shift); const supplierId = num(req.query.supplier);
    if (!shiftId || !supplierId) return bad(reply, 'shift va supplier shart');
    return purchaseBreakdown(db, shiftId, supplierId);
  });
  app.get('/purchases/export.csv', need('reports.export'), async (req, reply) => {
    const cols = [['number', 'Xarid'], ['shift', 'Smena'], ['local_time', 'Vaqt'], ['collector', 'Sut yig\'uvchi'], ['supplier', 'Xonadon'], ['quantity', 'Miqdor (kg)']];
    if (has(req, 'prices.view')) cols.push(['amount', 'Summa']);
    const csv = toCsv(purchaseRows(db, req.query), cols);
    const r = parseRange(req.query);
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="yaya_xaridlar_${r.from}_${r.to}.csv"`);
    return csv;
  });

  app.get('/reports/summary', need('reports.view'), async (req) => summary(db, req.query));
  // Accepted-quantity difference report: real vs. written, real cost, and how much
  // the company gained/lost from the gaps — by product, collector and shift.
  app.get('/reports/diff', need('diff.view'), async (req) => diffReport(db, req.query));
  app.get('/reports/daily-cost', need('reports.view'), async (req) =>
    dailyCost(db, /^\d{4}-\d{2}-\d{2}$/.test(req.query.day ?? '') ? req.query.day : todayLocal()));

  app.get('/reports/export.csv', need('reports.export'), async (req, reply) => {
    const { from, to } = parseRange(req.query);
    const cols = [['id', 'ID'], ['shift', 'Smena'], ['local_time', 'Vaqt'], ['employee', 'Sut yig\'uvchi'], ['supplier', 'Xonadon'],
      ['product', 'Mahsulot'], ['unit', 'Birlik'], ['quantity', 'Miqdor']];
    if (has(req, 'prices.view')) cols.push(['price', 'Narx'], ['amount', 'Summa']);
    const csv = toCsv(exportRows(db, req.query), cols);
    log(req, 'report.export', { from, to });
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="yaya_${from}_${to}.csv"`);
    return csv;
  });

  // Day overview: accepted shifts are the truth; open shifts are shown live.
  // Dashboard for a day OR a range (from/to), optionally filtered to one product.
  // Debt totals are valued AS OF the end of the range, not as of now.
  app.get('/dashboard', need('reports.view'), async (req) => {
    const { from, to } = parseRange(req.query);
    const product = num(req.query.product);
    const q = { from, to, ...(product ? { product } : {}) };
    const out = {
      from, to, product: product ?? null,
      summary: summary(db, q),
      diff: has(req, 'diff.view') ? diffReport(db, q) : null,
      accepted: listShifts(db, { from, to, status: 'accepted' }).filter((s) => !s.is_test)
        .map((s) => (has(req, 'diff.view') ? s : (delete s.accepted_quantity, delete s.diff_quantity, s))),
      live: has(req, 'shifts.view_all') ? listShifts(db, { status: 'open' }).filter((s) => !s.is_test) : [],
      waiting: has(req, 'shifts.view_all') ? listShifts(db, { status: 'closed' }).filter((s) => !s.is_test) : [],
    };
    // When viewing today, "as of now"; for a past range, as of that day's end.
    if (has(req, 'debts.view')) out.debt = balances(db, { asOf: to >= todayLocal() ? null : to }).totals;
    return out;
  });

  // ---------------------------------------------------------------- branding
  app.get('/settings', need('settings.manage'), async () => ({
    companyName: getSetting(db, 'company_name') ?? '',
    greeting: getSetting(db, 'greeting') ?? '',
    hasIntro: !!db.prepare("SELECT 1 FROM files WHERE key = 'intro'").get(),
    introMime: db.prepare("SELECT mime FROM files WHERE key = 'intro'").get()?.mime ?? null,
    // Location (map) and cancelling default ON; stored only when turned off.
    locationEnabled: getSetting(db, 'location_enabled') !== '0',
    cancelEnabled: getSetting(db, 'cancel_enabled') !== '0',
    // Which fields show in the collector's shift household list. All on by default.
    listFields: {
      name: getSetting(db, 'list_show_name') !== '0',
      address: getSetting(db, 'list_show_address') !== '0',
      phone: getSetting(db, 'list_show_phone') !== '0',
    },
    // What the "Nusxalash" (copy shift) text includes. All on by default.
    copyFields: {
      product: getSetting(db, 'copy_show_product') !== '0',
      household: getSetting(db, 'copy_show_household') !== '0',
      price: getSetting(db, 'copy_show_price') !== '0',
      qty: getSetting(db, 'copy_show_qty') !== '0',
    },
    // Per-action confirmation prompts (on = ask "are you sure?").
    confirms: confirmFlags(db),
    // Editing a closed-but-not-accepted shift (default on).
    editClosed: getSetting(db, 'edit_closed_enabled') !== '0',
    // Accepted-quantity difference feature (default on) + optional limits (kg).
    diff: diffFlags(db),
  }));
  app.put('/settings', need('settings.manage'), async (req) => {
    if (req.body?.companyName !== undefined) setSetting(db, 'company_name', str(req.body.companyName, 60));
    // Greeting shown on the collector's start screen; {ism} is replaced by the name.
    if (req.body?.greeting !== undefined) setSetting(db, 'greeting', str(req.body.greeting, 120));
    // location_enabled: map mode — nearest-first list and route from the phone's
    // location. Off = households show only their address. Locations are kept either way.
    if (req.body?.locationEnabled !== undefined) setSetting(db, 'location_enabled', req.body.locationEnabled ? '1' : '0');
    // cancel_enabled: when off, no "Bekor qilish" anywhere — only accepting shifts.
    if (req.body?.cancelEnabled !== undefined) setSetting(db, 'cancel_enabled', req.body.cancelEnabled ? '1' : '0');
    // listFields: which columns show in the collector's shift household list.
    if (req.body?.listFields) {
      const lf = req.body.listFields;
      if (lf.name !== undefined) setSetting(db, 'list_show_name', lf.name ? '1' : '0');
      if (lf.address !== undefined) setSetting(db, 'list_show_address', lf.address ? '1' : '0');
      if (lf.phone !== undefined) setSetting(db, 'list_show_phone', lf.phone ? '1' : '0');
    }
    // copyFields: what the "Nusxalash" shift summary includes.
    if (req.body?.copyFields) {
      const cf = req.body.copyFields;
      if (cf.product !== undefined) setSetting(db, 'copy_show_product', cf.product ? '1' : '0');
      if (cf.household !== undefined) setSetting(db, 'copy_show_household', cf.household ? '1' : '0');
      if (cf.price !== undefined) setSetting(db, 'copy_show_price', cf.price ? '1' : '0');
      if (cf.qty !== undefined) setSetting(db, 'copy_show_qty', cf.qty ? '1' : '0');
    }
    // confirms: per-action "are you sure?" prompts.
    if (req.body?.confirms) for (const k of CONFIRM_KEYS) if (req.body.confirms[k] !== undefined) setSetting(db, `confirm_${k}`, req.body.confirms[k] ? '1' : '0');
    if (req.body?.editClosed !== undefined) setSetting(db, 'edit_closed_enabled', req.body.editClosed ? '1' : '0');
    // diff: accepted-quantity difference feature on/off + surplus/shortfall limits.
    if (req.body?.diff) {
      const d = req.body.diff;
      if (d.enabled !== undefined) setSetting(db, 'diff_enabled', d.enabled ? '1' : '0');
      const lim = (v) => (v == null || v === '' || !(Number(v) > 0) ? '' : Math.abs(Number(v)));
      if (d.over !== undefined) setSetting(db, 'diff_limit_over', lim(d.over));
      if (d.under !== undefined) setSetting(db, 'diff_limit_under', lim(d.under));
    }
    setSetting(db, 'brand_version', Date.now());
    log(req, 'settings.update', { companyName: req.body?.companyName });
    return { ok: true };
  });

  // Short, silent entry animation (video/gif) shown when the app opens. Uploaded
  // from the admin's device as a data URL; stored like the logo.
  app.put('/settings/intro', { ...need('settings.manage'), bodyLimit: 12 * 1024 * 1024 }, async (req, reply) => {
    const m = /^data:(video\/mp4|video\/webm);base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body?.dataUrl ?? ''));
    if (!m) return bad(reply, 'Fayl mp4 yoki webm video bo\'lishi kerak');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 10 * 1024 * 1024) return bad(reply, 'Fayl 10 MB dan katta — qisqaroq/kichikroq video tanlang');
    db.prepare(`INSERT INTO files (key, mime, data, updated_at) VALUES ('intro', ?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_at = excluded.updated_at`).run(m[1], buf);
    setSetting(db, 'brand_version', Date.now());
    log(req, 'intro.update', { bytes: buf.length });
    return { ok: true };
  });
  app.delete('/settings/intro', need('settings.manage'), async (req) => {
    db.prepare("DELETE FROM files WHERE key = 'intro'").run();
    setSetting(db, 'brand_version', Date.now());
    log(req, 'intro.remove');
    return { ok: true };
  });

  // Logo arrives as a PNG data URL, already squared and resized in the browser.
  app.put('/settings/logo', { ...need('settings.manage'), bodyLimit: 3 * 1024 * 1024 }, async (req, reply) => {
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body?.dataUrl ?? ''));
    if (!m) return bad(reply, 'Rasm PNG formatida bo\'lishi kerak');
    const buf = Buffer.from(m[1], 'base64');
    if (!buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return bad(reply, 'Fayl PNG emas');
    if (buf.length > 2 * 1024 * 1024) return bad(reply, 'Rasm 2 MB dan katta');
    db.prepare(`INSERT INTO files (key, mime, data, updated_at) VALUES ('logo', 'image/png', ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_at = excluded.updated_at`).run(buf);
    setSetting(db, 'brand_version', Date.now());
    log(req, 'logo.update', { bytes: buf.length });
    return { ok: true };
  });

  app.delete('/settings/logo', need('settings.manage'), async (req) => {
    db.prepare("DELETE FROM files WHERE key = 'logo'").run();
    setSetting(db, 'brand_version', Date.now());
    log(req, 'logo.remove');
    return { ok: true };
  });

  // ---------------------------------------------------------------- data: backup, restore, wipe
  // Simple arithmetic question, so a script cannot fire the wipe blindly.
  const challenges = new Map();
  app.get('/data/challenge', need('data.backup'), async () => {
    for (const [k, v] of challenges) if (v.exp < Date.now()) challenges.delete(k);
    const a = randomInt(11, 49);
    const b = randomInt(3, 9);
    const c = randomInt(2, 19);
    const id = randomUUID();
    challenges.set(id, { answer: a * b - c, exp: Date.now() + 5 * 60e3 });
    return { id, question: `${a} × ${b} − ${c} = ?`, phrase: WIPE_PHRASE };
  });
  const passChallenge = (id, answer) => {
    const ch = challenges.get(String(id));
    challenges.delete(String(id));
    return !!ch && ch.exp > Date.now() && Number(answer) === ch.answer;
  };

  app.post('/data/export', need('data.backup'), async (req, reply) => {
    if (!checkPassword(req, req.body?.password)) return bad(reply, 'Admin paroli noto\'g\'ri');
    const pass = String(req.body?.backupPassword ?? '');
    if (pass.length < 8) return bad(reply, 'Zaxira paroli kamida 8 belgi bo\'lsin');
    const file = encrypt(snapshot(db), pass);
    log(req, 'data.export', { bytes: file.length });
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Disposition', `attachment; filename="yaya_zaxira_${todayLocal()}.yaya"`);
    return file;
  });

  app.post('/data/import', { ...need('data.backup'), bodyLimit: 150 * 1024 * 1024 }, async (req, reply) => {
    const b = req.body ?? {};
    if (!checkPassword(req, b.password)) return bad(reply, 'Admin paroli noto\'g\'ri');
    if (b.confirm !== 'TIKLASH') return bad(reply, 'Tasdiqlash so\'zi noto\'g\'ri');
    let snap;
    try {
      snap = decrypt(Buffer.from(String(b.file ?? '').replace(/^data:.*?;base64,/, ''), 'base64'), String(b.backupPassword ?? ''));
    } catch (e) { return bad(reply, e.message); }
    const safety = saveSafety(db, 'Importdan oldin', req.actor);
    try {
      restore(db, snap);
    } catch (e) { return bad(reply, e.message); }
    audit(db, req.actor, 'data.import', { safety, exportedAt: snap.exportedAt });
    return { ok: true, safety, exportedAt: snap.exportedAt };
  });

  app.post('/data/wipe', need('data.backup'), async (req, reply) => {
    const b = req.body ?? {};
    if (!checkPassword(req, b.password)) return bad(reply, 'Admin paroli noto\'g\'ri');
    if (!passChallenge(b.challengeId, b.answer)) return bad(reply, 'Misol javobi noto\'g\'ri yoki eskirgan. Qaytadan urinib ko\'ring.');
    if (b.confirm !== WIPE_PHRASE) return bad(reply, `Tasdiqlash uchun aynan "${WIPE_PHRASE}" deb yozing`);
    // The one admin who remains afterwards: a new login and password.
    const login = normalizeLogin(b.newLogin);
    if (!/^[a-z0-9_.-]{3,32}$/.test(login)) return bad(reply, "Yangi admin logini 3–32 belgi: kichik harf, raqam, _ . -");
    if (String(b.newPassword ?? '').length < 6) return bad(reply, "Yangi admin paroli kamida 6 belgi bo'lsin");
    const safety = saveSafety(db, "Butun tizimni tozalashdan oldin", req.actor);
    resetAll(db, { login, password: String(b.newPassword) });
    audit(db, req.actor, 'data.reset', { safety, newAdmin: login });
    return { ok: true, safety, login };
  });

  app.get('/data/safety', need('data.backup'), async () => listSafety(db));

  app.post('/data/safety/:id/restore', need('data.backup'), async (req, reply) => {
    if (!checkPassword(req, req.body?.password)) return bad(reply, 'Admin paroli noto\'g\'ri');
    try {
      const snap = loadSafety(db, Number(req.params.id));
      const before = saveSafety(db, 'Tiklashdan oldin', req.actor);
      restore(db, snap);
      audit(db, req.actor, 'data.restore', { id: Number(req.params.id), before });
      return { ok: true };
    } catch (e) { return bad(reply, e.message); }
  });

  // ---------------------------------------------------------------- test mode & audit
  app.delete('/test-data', need('tester.use', 'staff.manage'), async (req) => {
    const r = db.transaction(() => {
      const testShifts = "SELECT client_uuid FROM shifts WHERE employee_id IN (SELECT id FROM users WHERE is_test = 1)";
      const c = db.prepare(`DELETE FROM collections WHERE shift_uuid IN (${testShifts})`).run().changes;
      db.prepare('DELETE FROM payments WHERE employee_id IN (SELECT id FROM users WHERE is_test = 1)').run();
      db.prepare('DELETE FROM shifts WHERE employee_id IN (SELECT id FROM users WHERE is_test = 1)').run();
      return c;
    })();
    log(req, 'test-data.clear', { collections: r });
    return { deleted: r };
  });

  app.get('/audit', need('audit.view'), async (req) => {
    const limit = Math.min(Number(req.query.limit) || 300, 5000);
    return db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit)
      .map((a) => ({ id: a.id, at: a.at, who: actorName(db, a.actor), what: describe(a.action, a.details), action: a.action }));
  });

  app.get('/audit/export.csv', need('audit.view'), async (req, reply) => {
    const rows = db.prepare('SELECT * FROM audit_log ORDER BY id').all()
      .map((a) => ({ at: a.at, who: actorName(db, a.actor), what: describe(a.action, a.details), action: a.action, details: a.details }));
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="yaya_jurnal_${todayLocal()}.csv"`);
    return toCsv(rows, [['at', 'Vaqt (UTC)'], ['who', 'Kim'], ['what', 'Nima bo\'ldi'], ['action', 'Kod'], ['details', 'Tafsilot']]);
  });
}
