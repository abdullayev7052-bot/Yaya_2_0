import bcrypt from 'bcryptjs';
import { randomInt, randomUUID } from 'node:crypto';
import { audit, ensureDeviceSlots, roleIdByCode } from '../db/index.js';
import { makeGuard, normalizeLogin } from '../auth.js';
import { PERMISSIONS, PERMISSION_KEYS } from '../permissions.js';
import { summary, exportRows, toCsv, parseRange, dailyCost, todayLocal } from '../reports.js';
import { balances, statement, supplierBalance } from '../ledger.js';
import { templateXlsx, importSuppliers, exportSuppliersXlsx } from '../importer.js';
import { getSetting, setSetting } from '../settings.js';
import { ShiftError, acceptShift, cancelShift, copyShift, listShifts, shiftDetail, shiftLabel } from '../shifts.js';
import { decrypt, encrypt, listSafety, loadSafety, restore, saveSafety, snapshot, wipeHistory } from '../backup.js';
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
const WIPE_PHRASE = 'TARIXNI TOZALASH';

// Management API, used by the web panel (admin) and by the mobile app for
// everyone else, each within their role's permissions.
export default async function adminRoutes(app, { db }) {
  const need = makeGuard(app, db);
  const str = (v, max = 200) => (v == null ? null : String(v).trim().slice(0, max) || null);
  const bad = (reply, msg) => reply.code(400).send({ error: msg });
  const num = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
  const has = (req, p) => req.me.perms.has(p);
  const log = (req, action, details) => audit(db, req.actor, action, details);
  const shiftErr = (reply, e) => {
    if (e instanceof ShiftError) return reply.code(400).send({ error: e.message, details: e.details });
    throw e;
  };
  const checkPassword = (req, password) => {
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.me.id);
    return bcrypt.compareSync(String(password ?? ''), row.password_hash);
  };

  app.addHook('preSerialization', async (req, reply, payload) =>
    (req.me && !req.me.perms.has('prices.view') ? stripMoney(payload) : payload));

  // ---------------------------------------------------------------- roles
  app.get('/permissions', need(), async () => PERMISSIONS);

  app.get('/roles', need(), async () => db.prepare(`SELECT r.*, (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id) AS users
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
    SELECT u.id, u.login, u.name, u.phone, u.role_id, r.name AS role_name, u.is_test, u.active, u.created_at,
      (SELECT COUNT(*) FROM employee_suppliers es WHERE es.employee_id = u.id) AS supplier_count,
      (SELECT COUNT(*) FROM devices d WHERE d.user_id = u.id) AS device_slots,
      (SELECT COUNT(*) FROM devices d WHERE d.user_id = u.id AND d.device_id IS NOT NULL) AS devices_bound,
      (SELECT MAX(last_seen_at) FROM devices d WHERE d.user_id = u.id) AS last_seen_at
    FROM users u LEFT JOIN roles r ON r.id = u.role_id ORDER BY u.is_test, u.active DESC, u.name, u.login`).all());

  // Light list for filters and pickers.
  app.get('/staff/names', need(), async () => db.prepare(`SELECT u.id, u.name, u.login, u.is_test FROM users u WHERE u.active = 1
    ORDER BY u.is_test, u.name`).all());

  app.post('/staff', need('staff.manage'), async (req, reply) => {
    const b = req.body ?? {};
    const login = normalizeLogin(b.login);
    const roleId = num(b.roleId);
    if (!/^[a-z0-9_.-]{3,32}$/.test(login)) return bad(reply, 'Login 3–32 belgi: kichik harf, raqam, _ . - (telefon raqam ham bo\'ladi)');
    if (!b.password || String(b.password).length < 6) return bad(reply, 'Parol kamida 6 belgi bo\'lsin');
    if (!roleId || !roleExists(roleId)) return bad(reply, 'Rolni tanlang');
    if (db.prepare('SELECT 1 FROM users WHERE login = ?').get(login)) return bad(reply, 'Bu login band');
    const id = Number(db.prepare('INSERT INTO users (login, name, phone, password_hash, role_id, is_test) VALUES (?, ?, ?, ?, ?, ?)')
      .run(login, str(b.name), str(b.phone, 30)?.replace(/[^\d+]/g, '') || null, bcrypt.hashSync(String(b.password), 10), roleId, Number(!!b.isTest)).lastInsertRowid);
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
    log(req, 'user.update', { id, login: login ?? target.login, name: b.name ?? target.name, roleId, active: b.active, passwordChanged: !!b.password });
    return { ok: true };
  });

  app.get('/staff/:id/suppliers', need('staff.manage'), async (req) =>
    db.prepare('SELECT supplier_id FROM employee_suppliers WHERE employee_id = ? ORDER BY sort_order').all(req.params.id).map((x) => x.supplier_id));

  app.put('/staff/:id/suppliers', need('staff.manage'), async (req) => {
    const ids = (req.body?.supplierIds ?? []).map(Number).filter(Number.isInteger);
    db.transaction(() => {
      db.prepare('DELETE FROM employee_suppliers WHERE employee_id = ?').run(req.params.id);
      const ins = db.prepare('INSERT OR IGNORE INTO employee_suppliers (employee_id, supplier_id, sort_order) VALUES (?, ?, ?)');
      ids.forEach((sid, i) => ins.run(req.params.id, sid, i));
    })();
    const u = db.prepare('SELECT name, login FROM users WHERE id = ?').get(req.params.id);
    log(req, 'user.assign', { id: Number(req.params.id), name: u?.name || u?.login, count: ids.length });
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
    const id = Number(db.prepare('INSERT INTO suppliers (name, phone, address, note, created_by) VALUES (?, ?, ?, ?, ?)')
      .run(name, str(b.phone, 30)?.replace(/[^\d+]/g, '') || null, str(b.address), str(b.note), req.actor).lastInsertRowid);
    if (b.openingBalance != null && has(req, 'payments.create')) {
      db.prepare('UPDATE suppliers SET opening_balance = ? WHERE id = ?').run(Number(b.openingBalance) || 0, id);
    }
    log(req, 'suppliers.create', { id, name });
    return { id };
  });

  app.patch('/suppliers/:id', need('suppliers.edit'), async (req, reply) => {
    const b = req.body ?? {};
    const s = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(req.params.id);
    if (!s) return reply.code(404).send({ error: 'Topilmadi' });
    if (b.name !== undefined && !str(b.name)) return bad(reply, 'Ism bo\'sh bo\'lmasin');
    db.prepare(`UPDATE suppliers SET name = COALESCE(?, name), phone = CASE WHEN ? THEN ? ELSE phone END,
      address = CASE WHEN ? THEN ? ELSE address END, note = CASE WHEN ? THEN ? ELSE note END, active = COALESCE(?, active) WHERE id = ?`)
      .run(str(b.name, 120), Number(b.phone !== undefined), str(b.phone, 30)?.replace(/[^\d+]/g, '') || null,
        Number(b.address !== undefined), str(b.address), Number(b.note !== undefined), str(b.note),
        b.active == null ? null : Number(!!b.active), s.id);
    log(req, 'suppliers.update', { id: s.id, name: b.name ?? s.name, active: b.active });
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

  app.get('/products', need(), async () => db.prepare('SELECT * FROM products ORDER BY active DESC, name').all());
  app.post('/products', need('catalog.manage'), async (req, reply) => {
    const name = str(req.body?.name, 60);
    if (!name) return bad(reply, 'Nomi shart');
    const id = db.prepare('INSERT INTO products (name, unit) VALUES (?, ?)').run(name, str(req.body?.unit, 10) ?? 'kg').lastInsertRowid;
    log(req, 'products.create', { id, name });
    return { id };
  });
  app.patch('/products/:id', need('catalog.manage'), async (req, reply) => {
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
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
    return listShifts(db, { ...range, status, employee: num(q.employee) });
  });

  app.get('/shifts/:id', need('shifts.view_all'), async (req, reply) => shiftDetail(db, req.params.id) ?? reply.code(404).send({ error: 'Topilmadi' }));

  app.post('/shifts/:id/accept', need('shifts.accept'), async (req, reply) => {
    try {
      const s = acceptShift(db, Number(req.params.id), req.actor);
      const u = db.prepare('SELECT name FROM users WHERE id = ?').get(s.employee_id);
      log(req, 'shift.accept', { shift: shiftLabel(s), employee: u?.name });
      return { ok: true };
    } catch (e) { return shiftErr(reply, e); }
  });

  app.post('/shifts/:id/cancel', need('shifts.cancel'), async (req, reply) => {
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
  app.get('/balances', need('debts.view'), async (req) => balances(db, { q: req.query.q }));

  app.get('/payments', need('debts.view'), async (req) => {
    const { from, to } = parseRange(req.query);
    return db.prepare(`SELECT p.*, s.name AS supplier_name FROM payments p JOIN suppliers s ON s.id = p.supplier_id
      WHERE date(p.paid_at, '+5 hours') BETWEEN @from AND @to AND (@supplier IS NULL OR p.supplier_id = @supplier)
        AND (@voided = 1 OR p.voided_at IS NULL)
      ORDER BY p.paid_at DESC LIMIT 2000`).all({ from, to, supplier: num(req.query.supplier), voided: req.query.voided === '1' ? 1 : 0 });
  });

  app.post('/payments', need('payments.create'), async (req, reply) => {
    const supplierId = num(req.body?.supplierId);
    const amount = Math.round(Number(req.body?.amount));
    const method = METHODS.includes(req.body?.method) ? req.body.method : 'cash';
    const s = supplierId && db.prepare('SELECT name FROM suppliers WHERE id = ?').get(supplierId);
    if (!s) return bad(reply, 'Yetkazib beruvchini tanlang');
    if (!(amount > 0) || amount > 1e11) return bad(reply, 'Summa noto\'g\'ri');
    const paidAt = req.body?.paidAt && !Number.isNaN(Date.parse(req.body.paidAt)) ? new Date(req.body.paidAt).toISOString() : new Date().toISOString();
    const id = db.prepare(`INSERT INTO payments (client_uuid, supplier_id, amount, method, note, paid_at, created_by, employee_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(req.body?.uuid ? String(req.body.uuid) : randomUUID(), supplierId, amount, method,
      str(req.body?.note, 300), paidAt, req.actor, req.me.is_test ? req.me.id : null).lastInsertRowid;
    log(req, 'payment.create', { id, supplierId, supplier: s.name, amount, method });
    return { id, balance: supplierBalance(db, supplierId) };
  });

  app.post('/payments/:id/void', need('payments.void'), async (req, reply) => {
    const reason = str(req.body?.reason, 300);
    if (!reason) return bad(reply, 'Sababini yozing');
    const p = db.prepare('SELECT * FROM payments WHERE id = ? AND voided_at IS NULL').get(req.params.id);
    if (!p) return reply.code(404).send({ error: 'Topilmadi yoki allaqachon bekor qilingan' });
    db.prepare("UPDATE payments SET voided_at = datetime('now'), void_reason = ?, voided_by = ? WHERE id = ?").run(reason, req.actor, p.id);
    log(req, 'payment.void', { id: p.id, amount: p.amount, reason });
    return { ok: true };
  });

  // ---------------------------------------------------------------- reports
  app.get('/reports/summary', need('reports.view'), async (req) => summary(db, req.query));
  app.get('/reports/daily-cost', need('reports.view'), async (req) =>
    dailyCost(db, /^\d{4}-\d{2}-\d{2}$/.test(req.query.day ?? '') ? req.query.day : todayLocal()));

  app.get('/reports/export.csv', need('reports.export'), async (req, reply) => {
    const { from, to } = parseRange(req.query);
    const cols = [['id', 'ID'], ['shift', 'Smena'], ['local_time', 'Vaqt'], ['employee', 'Sut yig\'uvchi'], ['supplier', 'Yetkazib beruvchi'],
      ['product', 'Mahsulot'], ['unit', 'Birlik'], ['quantity', 'Miqdor']];
    if (has(req, 'prices.view')) cols.push(['price', 'Narx'], ['amount', 'Summa']);
    const csv = toCsv(exportRows(db, req.query), cols);
    log(req, 'report.export', { from, to });
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="yaya_${from}_${to}.csv"`);
    return csv;
  });

  // Day overview: accepted shifts are the truth; open shifts are shown live.
  app.get('/dashboard', need('reports.view'), async (req) => {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(req.query.day ?? '') ? req.query.day : todayLocal();
    const d30 = new Date(Date.parse(day) - 29 * 864e5).toISOString().slice(0, 10);
    const out = {
      day,
      cost: dailyCost(db, day),
      day_summary: summary(db, { from: day, to: day }),
      month: summary(db, { from: d30, to: day }),
      accepted: listShifts(db, { from: day, to: day, status: 'accepted' }).filter((s) => !s.is_test),
      live: has(req, 'shifts.view_all') ? listShifts(db, { status: 'open' }).filter((s) => !s.is_test) : [],
      waiting: has(req, 'shifts.view_all') ? listShifts(db, { status: 'closed' }).filter((s) => !s.is_test) : [],
    };
    if (has(req, 'debts.view')) out.debt = balances(db).totals;
    return out;
  });

  // ---------------------------------------------------------------- branding
  app.get('/settings', need('settings.manage'), async () => ({ companyName: getSetting(db, 'company_name') ?? '' }));
  app.put('/settings', need('settings.manage'), async (req) => {
    if (req.body?.companyName !== undefined) setSetting(db, 'company_name', str(req.body.companyName, 60));
    setSetting(db, 'brand_version', Date.now());
    log(req, 'settings.update', { companyName: req.body?.companyName });
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
    const safety = saveSafety(db, 'Tarixni tozalashdan oldin', req.actor);
    wipeHistory(db, { resetOpening: !!b.resetOpening });
    log(req, 'data.wipe', { safety, resetOpening: !!b.resetOpening });
    return { ok: true, safety };
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
