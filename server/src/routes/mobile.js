import { audit } from '../db/index.js';
import { makeGuard } from '../auth.js';
import { getSetting } from '../settings.js';
import { supplierBalance } from '../ledger.js';
import { ShiftError, blockingShift, closeShift, copyShift, displayStatus, ensureShift, reopenShift, shiftLabel, shiftTotals } from '../shifts.js';

// API for the field part of the mobile app (collecting milk). Everything a
// collector does offline is uploaded through /sync and is idempotent by
// client-generated UUIDs. Management screens use the /api/admin routes with
// the same token, gated by permissions.
export default async function mobileRoutes(app, { db }) {
  const need = makeGuard(app, db);
  const str = (v, max = 200) => (v == null ? null : String(v).trim().slice(0, max) || null);

  // Every household is visible to every collector, except those explicitly
  // hidden from them in the panel.
  const isHidden = (userId, supplierId) =>
    !!db.prepare('SELECT 1 FROM employee_hidden_suppliers WHERE employee_id = ? AND supplier_id = ?').get(userId, supplierId);

  const assignedSuppliers = (userId) => {
    const suppliers = db.prepare(`
      SELECT s.id, s.name, s.phone, s.address, s.lat, s.lng, s.address2, s.lat2, s.lng2
      FROM suppliers s
      WHERE s.active = 1
        AND s.id NOT IN (SELECT supplier_id FROM employee_hidden_suppliers WHERE employee_id = ?)
      ORDER BY s.name`).all(userId);
    const productsOf = db.prepare(`SELECT p.id, p.name, p.unit, sp.is_default FROM supplier_products sp
      JOIN products p ON p.id = sp.product_id AND p.active = 1 WHERE sp.supplier_id = ? ORDER BY sp.is_default DESC, p.name`);
    for (const s of suppliers) s.products = productsOf.all(s.id).map((p) => ({ id: p.id, name: p.name, unit: p.unit, isDefault: !!p.is_default }));
    return suppliers;
  };

  const myShifts = (userId, limit = 20) => db.prepare(`SELECT id, client_uuid AS uuid, number, copy_no, status, reopened_at, opened_at, closed_at,
      cancel_reason, accepted_at, cancelled_at FROM shifts WHERE employee_id = ? ORDER BY opened_at DESC LIMIT ?`).all(userId, limit)
    .map((s) => ({ ...s, status: displayStatus(s), label: shiftLabel(s), ...shiftTotals(db, s.uuid) }));

  // Everything the phone needs to work offline. Prices are never sent here.
  app.get('/bootstrap', need(), async (req) => {
    const me = req.me;
    const collects = me.perms.has('collect.shift');
    const out = {
      user: { id: me.id, login: me.login, name: me.name, role: me.role_name, isTest: !!me.is_test, permissions: [...me.perms] },
      brand: {
        companyName: getSetting(db, 'company_name') ?? '',
        greeting: getSetting(db, 'greeting') ?? '',
        hasIntro: !!db.prepare("SELECT 1 FROM files WHERE key = 'intro'").get(),
        version: getSetting(db, 'brand_version') ?? '0',
      },
      products: db.prepare('SELECT id, name, unit FROM products WHERE active = 1 ORDER BY name').all(),
      suppliers: collects ? assignedSuppliers(me.id) : [],
      shifts: collects ? myShifts(me.id) : [],
      serverTime: new Date().toISOString(),
    };
    // A shift opened on the server (a copy of a cancelled one, or one reopened for
    // editing) is handed to the phone as its open shift.
    const open = collects && db.prepare("SELECT * FROM shifts WHERE employee_id = ? AND status IN ('open', 'editing') ORDER BY opened_at DESC LIMIT 1").get(me.id);
    if (open) {
      out.openShift = {
        uuid: open.client_uuid, label: shiftLabel(open), opened_at: open.opened_at,
        collections: db.prepare(`SELECT c.client_uuid AS uuid, c.supplier_id, s.name AS supplier_name, c.product_id, p.name AS product_name,
            p.unit, c.quantity, c.collected_at FROM collections c JOIN suppliers s ON s.id = c.supplier_id JOIN products p ON p.id = c.product_id
          WHERE c.shift_uuid = ? ORDER BY c.collected_at`).all(open.client_uuid),
      };
    }
    return out;
  });

  app.get('/history', need('collect.view_own_shifts'), async (req) => myShifts(req.me.id, 60));

  // Copy one of my own cancelled shifts into a new open draft.
  app.post('/shifts/:id/copy', need('collect.copy_cancelled'), async (req, reply) => {
    const s = db.prepare('SELECT * FROM shifts WHERE id = ?').get(req.params.id);
    if (!s || s.employee_id !== req.me.id) return reply.code(404).send({ error: 'Smena topilmadi' });
    try {
      const copy = copyShift(db, s.id, req.actor);
      audit(db, req.actor, 'shift.copy', { from: shiftLabel(s), to: shiftLabel(copy) });
      return { id: copy.id, uuid: copy.client_uuid, label: shiftLabel(copy) };
    } catch (e) {
      if (e instanceof ShiftError) return reply.code(400).send({ error: e.message });
      throw e;
    }
  });

  // Re-open a closed-but-not-accepted shift for editing (a mistaken close). Only
  // the owner, only while the admin allows it. The phone then adopts it as open.
  app.post('/shifts/:id/reopen', need('collect.edit_own'), async (req, reply) => {
    if (getSetting(db, 'edit_closed_enabled') === '0') return reply.code(403).send({ error: 'Yopilgan smenani tahrirlash o\'chirib qo\'yilgan' });
    const s = db.prepare('SELECT * FROM shifts WHERE id = ?').get(req.params.id);
    if (!s || s.employee_id !== req.me.id) return reply.code(404).send({ error: 'Smena topilmadi' });
    try {
      const e = reopenShift(db, s.id, req.actor);
      audit(db, req.actor, 'shift.edit', { shift: shiftLabel(e) });
      return { id: e.id, uuid: e.client_uuid, label: shiftLabel(e) };
    } catch (err) {
      if (err instanceof ShiftError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  // Supplier card for the field: kg history and the current balance; no prices.
  app.get('/suppliers/:id/card', need(), async (req, reply) => {
    const id = Number(req.params.id);
    const me = req.me;
    if (!(me.perms.has('suppliers.view') || (me.perms.has('suppliers.card_own') && !isHidden(me.id, id)))) {
      return reply.code(403).send({ error: 'Bu xonadon kartochkasiga ruxsat yo\'q' });
    }
    const s = db.prepare('SELECT id, name, phone, address, note, lat, lng, address2, lat2, lng2, active FROM suppliers WHERE id = ?').get(id);
    if (!s) return reply.code(404).send({ error: 'Topilmadi' });
    const pickups = db.prepare(`SELECT c.collected_at, c.quantity, p.name AS product_name, p.unit, sh.status, sh.number, sh.copy_no, u.name AS by_name
      FROM collections c JOIN shifts sh ON sh.client_uuid = c.shift_uuid JOIN products p ON p.id = c.product_id JOIN users u ON u.id = c.employee_id
      WHERE c.supplier_id = ? AND sh.status IN ('accepted', 'closed', 'open') ORDER BY c.collected_at DESC LIMIT 40`).all(id)
      .map((r) => ({ ...r, shift: shiftLabel(r), counted: r.status === 'accepted' }));
    const payments = db.prepare(`SELECT paid_at, amount, method, note, voided_at,
        (SELECT COALESCE(u.name, u.login) FROM users u WHERE 'user:' || u.login = payments.created_by) AS by_name
      FROM payments WHERE supplier_id = ? ORDER BY paid_at DESC LIMIT 20`).all(id);
    // Products the household supplies. Prices are only included for users allowed
    // to see them (admin/accountant); collectors get names only.
    const seePrices = me.perms.has('prices.view');
    const products = db.prepare(`SELECT p.id, p.name, p.unit, sp.price, sp.is_default FROM supplier_products sp
      JOIN products p ON p.id = sp.product_id AND p.active = 1 WHERE sp.supplier_id = ? ORDER BY sp.is_default DESC, p.name`).all(id)
      .map((p) => ({ id: p.id, name: p.name, unit: p.unit, isDefault: !!p.is_default, ...(seePrices ? { price: p.price } : {}) }));
    return {
      supplier: s,
      products,
      balance: supplierBalance(db, id),
      lastPickup: pickups.find((p) => p.counted) ?? pickups[0] ?? null,
      pickups,
      payments,
      canPay: me.perms.has('payments.create'),
      canEdit: me.perms.has('suppliers.edit'),
      canManagePrices: me.perms.has('prices.manage'),
      seePrices,
      canSetLocation: me.perms.has('suppliers.location') || me.perms.has('suppliers.edit'),
    };
  });

  // Set or edit a supplier's address and map point from the field.
  app.post('/suppliers/:id/location', need('suppliers.location'), async (req, reply) => {
    const id = Number(req.params.id);
    const me = req.me;
    if (!(me.perms.has('suppliers.view') || !isHidden(me.id, id))) return reply.code(403).send({ error: 'Bu xonadonga ruxsat yo\'q' });
    const s = db.prepare('SELECT id, name FROM suppliers WHERE id = ?').get(id);
    if (!s) return reply.code(404).send({ error: 'Topilmadi' });
    const b = req.body ?? {};
    const inRange = (v) => v == null || v === '' ? null : (Number.isFinite(Number(v)) && Math.abs(Number(v)) <= 180 ? Number(v) : NaN);
    const lat = inRange(b.lat);
    const lng = inRange(b.lng);
    if (Number.isNaN(lat) || Number.isNaN(lng)) return reply.code(400).send({ error: 'Koordinata noto\'g\'ri' });
    // slot 2 = the optional additional location. Only the coordinates are stored;
    // the address is a manual field, never overwritten by the map's name.
    const slot = Number(b.slot) === 2 ? 2 : 1;
    if (slot === 2) db.prepare('UPDATE suppliers SET lat2 = ?, lng2 = ? WHERE id = ?').run(lat, lng, id);
    else db.prepare('UPDATE suppliers SET lat = ?, lng = ? WHERE id = ?').run(lat, lng, id);
    audit(db, req.actor, 'suppliers.location', { id, name: s.name, fromApp: true });
    return { ok: true };
  });

  // New supplier met in the field. Online only. The admin sets the price later;
  // a shift with this supplier cannot be accepted until then.
  app.post('/suppliers', need('suppliers.create'), async (req, reply) => {
    const name = str(req.body?.name, 120);
    if (!name) return reply.code(400).send({ error: 'Ism shart' });
    const phone = str(req.body?.phone, 30)?.replace(/[^\d+]/g, '') || null;
    const productIds = (req.body?.productIds ?? []).map(Number).filter((n) => db.prepare('SELECT 1 FROM products WHERE id = ? AND active = 1').get(n));
    if (!productIds.length) return reply.code(400).send({ error: 'Kamida bitta mahsulotni tanlang' });
    const id = db.transaction(() => {
      const coord = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) || Math.abs(Number(v)) > 180 ? null : Number(v));
      const sid = Number(db.prepare('INSERT INTO suppliers (name, phone, address, note, lat, lng, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(name, phone, str(req.body?.address), str(req.body?.note), coord(req.body?.lat), coord(req.body?.lng), req.actor).lastInsertRowid);
      productIds.forEach((pid, i) => db.prepare('INSERT INTO supplier_products (supplier_id, product_id, price, is_default) VALUES (?, ?, NULL, ?)').run(sid, pid, i === 0 ? 1 : 0));
      // New households are visible to everyone by default — no assignment needed.
      return sid;
    })();
    audit(db, req.actor, 'suppliers.create', { id, name, phone, fromApp: true });
    return { id, supplier: assignedSuppliers(req.me.id).find((s) => s.id === id) ?? { id, name, phone } };
  });

  const str_ = { type: 'string', maxLength: 200 };
  app.post('/sync', {
    ...need(),
    schema: { body: { type: 'object', properties: {
      shifts: { type: 'array', maxItems: 100, items: { type: 'object', required: ['uuid', 'openedAt'],
        properties: { uuid: str_, openedAt: str_, closedAt: { type: ['string', 'null'] } } } },
      collections: { type: 'array', maxItems: 1000, items: { type: 'object',
        required: ['uuid', 'shiftUuid', 'supplierId', 'productId', 'quantity', 'collectedAt'],
        properties: { uuid: str_, shiftUuid: str_, supplierId: { type: 'integer' }, productId: { type: 'integer' },
          quantity: { type: 'number', exclusiveMinimum: 0, maximum: 100000 }, collectedAt: str_ } } },
      // Corrections to drafts already on the server.
      ops: { type: 'array', maxItems: 500, items: { type: 'object', required: ['uuid', 'type', 'target'],
        properties: { uuid: str_, type: { enum: ['edit', 'delete'] }, target: str_,
          quantity: { type: 'number', exclusiveMinimum: 0, maximum: 100000 }, productId: { type: 'integer' } } } },
      payments: { type: 'array', maxItems: 500, items: { type: 'object', required: ['uuid', 'supplierId', 'amount', 'paidAt'],
        properties: { uuid: str_, supplierId: { type: 'integer' }, amount: { type: 'number', exclusiveMinimum: 0, maximum: 1e11 },
          method: { enum: ['cash', 'card', 'transfer'] }, note: str_, paidAt: str_ } } },
    } } },
  }, async (req) => {
    const me = req.me;
    const can = (p) => me.perms.has(p);
    const actor = req.actor;
    const out = { accepted: [], rejected: [], shifts: { accepted: [], rejected: [] }, ops: { accepted: [], rejected: [] }, payments: { accepted: [], rejected: [] } };
    const shiftOf = db.prepare('SELECT * FROM shifts WHERE client_uuid = ?');
    // A household is usable unless it is hidden from this employee.
    const visible = (sid) => can('suppliers.view') || !isHidden(me.id, sid);
    const linked = db.prepare('SELECT 1 FROM supplier_products WHERE supplier_id = ? AND product_id = ?');

    db.transaction(() => {
      // 1. shifts (closing happens last, after their pickups are in)
      for (const s of req.body.shifts ?? []) {
        if (!can('collect.shift')) { out.shifts.rejected.push({ uuid: s.uuid, error: 'Smena ochishga ruxsat yo\'q' }); continue; }
        const existing = shiftOf.get(s.uuid);
        if (!existing) {
          const blocking = blockingShift(db, me.id);
          if (blocking) { out.shifts.rejected.push({ uuid: s.uuid, error: `${shiftLabel(blocking)} smena hali ${blocking.status === 'open' ? 'ochiq' : 'qabul qilinmagan'}` }); continue; }
        }
        try {
          ensureShift(db, me.id, s);
          out.shifts.accepted.push(s.uuid);
        } catch (e) {
          out.shifts.rejected.push({ uuid: s.uuid, error: e.message });
        }
      }

      // 2. pickups go only into my own OPEN shift
      for (const c of req.body.collections ?? []) {
        if (db.prepare('SELECT 1 FROM collections WHERE client_uuid = ?').get(c.uuid)) { out.accepted.push(c.uuid); continue; }
        const reject = (error) => out.rejected.push({ uuid: c.uuid, error });
        const sh = shiftOf.get(c.shiftUuid);
        if (!can('collect.shift')) { reject('Sut qabul qilishga ruxsat yo\'q'); continue; }
        if (!sh || sh.employee_id !== me.id) { reject('Smena topilmadi'); continue; }
        if (sh.status !== 'open' && sh.status !== 'editing') { reject(`${shiftLabel(sh)} smena yopilgan — o'zgartirib bo'lmaydi`); continue; }
        if (!visible(c.supplierId)) { reject('Bu xonadon sizga ko\'rinmaydi'); continue; }
        if (!linked.get(c.supplierId, c.productId)) { reject('Bu mahsulot xonadonga biriktirilmagan'); continue; }
        db.prepare(`INSERT INTO collections (client_uuid, shift_uuid, employee_id, supplier_id, product_id, quantity, collected_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(c.uuid, c.shiftUuid, me.id, c.supplierId, c.productId, c.quantity, c.collectedAt);
        out.accepted.push(c.uuid);
      }

      // 3. corrections, only inside an open shift
      for (const op of req.body.ops ?? []) {
        const reject = (error) => out.ops.rejected.push({ uuid: op.uuid, error });
        if (db.prepare('SELECT 1 FROM applied_ops WHERE uuid = ?').get(op.uuid)) { out.ops.accepted.push(op.uuid); continue; }
        const c = db.prepare('SELECT c.*, sh.status FROM collections c JOIN shifts sh ON sh.client_uuid = c.shift_uuid WHERE c.client_uuid = ? AND c.employee_id = ?')
          .get(op.target, me.id);
        if (!c) {
          // Deleting something the server never had is already done.
          if (op.type === 'delete') { db.prepare('INSERT INTO applied_ops (uuid) VALUES (?)').run(op.uuid); out.ops.accepted.push(op.uuid); } else reject('Yozuv topilmadi');
          continue;
        }
        if (c.status !== 'open' && c.status !== 'editing') { reject('Smena yopilgan — o\'zgartirib bo\'lmaydi'); continue; }
        if (op.type === 'delete') {
          if (!can('collect.delete_own')) { reject('O\'chirishga ruxsat yo\'q'); continue; }
          db.prepare('DELETE FROM collections WHERE id = ?').run(c.id);
        } else {
          if (!can('collect.edit_own')) { reject('Tahrirlashga ruxsat yo\'q'); continue; }
          const productId = op.productId ?? c.product_id;
          if (!linked.get(c.supplier_id, productId)) { reject('Bu mahsulot xonadonga biriktirilmagan'); continue; }
          db.prepare("UPDATE collections SET quantity = ?, product_id = ?, edited_at = datetime('now'), edited_by = ? WHERE id = ?")
            .run(op.quantity ?? c.quantity, productId, actor, c.id);
        }
        db.prepare('INSERT INTO applied_ops (uuid) VALUES (?)').run(op.uuid);
        audit(db, actor, `collection.${op.type}`, { shift: c.shift_uuid, quantity: op.quantity, was: c.quantity });
        out.ops.accepted.push(op.uuid);
      }

      // 4. close shifts now that their pickups are in
      for (const s of req.body.shifts ?? []) {
        if (!s.closedAt || !out.shifts.accepted.includes(s.uuid)) continue;
        const sh = shiftOf.get(s.uuid);
        if (sh?.status === 'open') {
          const closed = closeShift(db, sh, s.closedAt);
          audit(db, actor, 'shift.close', { shift: shiftLabel(closed), ...shiftTotals(db, closed.client_uuid) });
        }
      }

      // 5. payments count immediately
      for (const p of req.body.payments ?? []) {
        if (db.prepare('SELECT 1 FROM payments WHERE client_uuid = ?').get(p.uuid)) { out.payments.accepted.push(p.uuid); continue; }
        if (!can('payments.create')) { out.payments.rejected.push({ uuid: p.uuid, error: 'To\'lov qilishga ruxsat yo\'q' }); continue; }
        if (!visible(p.supplierId)) { out.payments.rejected.push({ uuid: p.uuid, error: 'Bu xonadon sizga ko\'rinmaydi' }); continue; }
        db.prepare(`INSERT INTO payments (client_uuid, supplier_id, amount, method, note, paid_at, created_by, employee_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(p.uuid, p.supplierId, Math.round(p.amount), p.method ?? 'cash',
          p.note ? String(p.note).slice(0, 300) : null, p.paidAt, actor, me.id);
        audit(db, actor, 'payment.create', { supplierId: p.supplierId, amount: Math.round(p.amount), method: p.method ?? 'cash', fromApp: true });
        out.payments.accepted.push(p.uuid);
      }
    })();
    return out;
  });
}
