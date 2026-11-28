import { randomUUID } from 'node:crypto';
import { receiveShiftMilk } from './erp/stock.js';
import { emitEvent } from './db/index.js';
import { diffFlags } from './settings.js';

// Shift lifecycle. A shift is a draft while open; closing freezes it; accepting
// makes it real (prices are stamped, debts and cost reports include it);
// cancelling removes it from everything. A cancelled shift can be copied into a
// new open draft with the same number and a "-copy" suffix.

export const shiftLabel = (s) => `#${s.number}${s.copy_no ? `-copy${s.copy_no > 1 ? s.copy_no : ''}` : ''}`;
// A shift reopened for editing stays 'open' in the DB (the status column's allowed
// set) but is shown as 'editing' so the UI can mark it "Tahrir".
export const displayStatus = (s) => (s.status === 'open' && s.reopened_at ? 'editing' : s.status);

export class ShiftError extends Error {
  constructor(message, details) {
    super(message);
    this.details = details;
  }
}

const now = () => new Date().toISOString();
const nextNumber = (db) => (db.prepare('SELECT MAX(number) AS n FROM shifts').get().n ?? 0) + 1;

// A collector cannot start a new shift while any of their shift numbers is
// unresolved: still open/closed (waiting acceptance) OR cancelled and not yet
// replaced by an accepted copy. Returns the shift to show (an active one first,
// else the cancelled one), or null when everything is resolved.
export const blockingShift = (db, userId) => {
  const unresolved = db.prepare(`SELECT number FROM shifts WHERE employee_id = ? GROUP BY number
    HAVING MAX(status = 'accepted') = 0 AND MAX(status IN ('open', 'editing', 'closed', 'cancelled')) = 1`).all(userId).map((r) => r.number);
  if (!unresolved.length) return null;
  return db.prepare(`SELECT * FROM shifts WHERE employee_id = ? AND number IN (${unresolved.join(',')})
    ORDER BY (status IN ('open', 'editing', 'closed')) DESC, opened_at DESC LIMIT 1`).get(userId);
};

// Only an open/editing/closed shift blocks copying (the cancelled one being copied
// is expected). Used so a collector can fix a cancelled shift but not run two at once.
export const activeShift = (db, userId) => db.prepare(`SELECT * FROM shifts WHERE employee_id = ? AND status IN ('open', 'editing', 'closed')
  ORDER BY opened_at DESC LIMIT 1`).get(userId);

export function shiftTotals(db, uuid) {
  return db.prepare(`SELECT COUNT(*) AS pickups, ROUND(COALESCE(SUM(quantity), 0), 2) AS quantity,
    COUNT(DISTINCT supplier_id) AS suppliers FROM collections WHERE shift_uuid = ?`).get(uuid);
}

// Plain-text summary of a shift to copy to the clipboard. Starts with the shift
// number and the collector's name, then grouped by product:
//   #5
//   Barkamol
//   Yog'li sut - 98.5 kg x 4961.93
//    Yoqutxon - 65 kg x 5200
// Each part (product header, per-household line, quantity, price) can be turned
// off. Prices use the stamped price (accepted) or the current price otherwise.
export function shiftCopyText(db, shiftId, opts = {}) {
  const { prices = true, showProduct = true, showHousehold = true, showPrice = true, showQty = true, showDiff = false } = opts;
  const price = showPrice && prices;
  const head = db.prepare(`SELECT sh.id, sh.client_uuid, sh.number, sh.copy_no, COALESCE(u.name, u.login) AS who
    FROM shifts sh JOIN users u ON u.id = sh.employee_id WHERE sh.id = ?`).get(shiftId);
  const rows = db.prepare(`
    SELECT s.name AS supplier, p.id AS product_id, p.name AS product, p.unit,
      ROUND(SUM(c.quantity), 2) AS qty,
      CAST(ROUND(AVG(COALESCE(c.price, sp.price))) AS INTEGER) AS unit_price
    FROM collections c
    JOIN shifts sh ON sh.client_uuid = c.shift_uuid
    JOIN suppliers s ON s.id = c.supplier_id
    JOIN products p ON p.id = c.product_id
    LEFT JOIN supplier_products sp ON sp.supplier_id = c.supplier_id AND sp.product_id = c.product_id
    WHERE sh.id = ?
    GROUP BY c.supplier_id, c.product_id
    ORDER BY p.name, s.name`).all(shiftId);
  const q = (n) => String(Math.round(Number(n) * 100) / 100);
  const avg2 = (n) => (Math.round(Number(n) * 100) / 100).toFixed(2);
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.product_id)) groups.set(r.product_id, { name: r.product, unit: r.unit, rows: [], qty: 0, amount: 0 });
    const g = groups.get(r.product_id);
    g.rows.push(r);
    g.qty = Math.round((g.qty + r.qty) * 100) / 100;
    g.amount += Math.round(r.qty * (r.unit_price ?? 0));
  }
  const lines = [];
  if (head) { lines.push(shiftLabel(head)); lines.push(head.who); }
  for (const g of groups.values()) {
    if (showProduct) {
      let line = g.name;
      if (showQty) line += ` - ${q(g.qty)} ${g.unit}`;
      if (price && g.qty) line += ` x ${avg2(g.amount / g.qty)}`;
      lines.push(line);
    }
    if (showHousehold) {
      for (const r of g.rows) {
        let line = ` ${r.supplier}`;
        if (showQty) line += ` - ${q(r.qty)} ${r.unit}`;
        if (price && r.unit_price != null) line += ` x ${r.unit_price}`;
        lines.push(line);
      }
    }
  }
  // The accepted-quantity difference, when recorded and the caller may see it.
  if (showDiff && head) {
    const d = shiftDiff(db, head);
    if (d.hasReal) {
      const sign = (n) => (n > 0 ? `+${q(n)}` : q(n));
      lines.push(`Jami: ${q(d.written)} kg`);
      lines.push(`Qabul: ${q(d.real)} kg`);
      lines.push(`Farq: ${sign(d.diff)} kg`);
    }
  }
  return lines.join('\n');
}

function eventPayload(db, s) {
  const u = db.prepare('SELECT name, login FROM users WHERE id = ?').get(s.employee_id);
  const byProduct = db.prepare(`SELECT p.name, p.unit, ROUND(SUM(c.quantity), 2) AS quantity FROM collections c
    JOIN products p ON p.id = c.product_id WHERE c.shift_uuid = ? GROUP BY p.id`).all(s.client_uuid);
  return { shift: shiftLabel(s), shiftId: s.id, employee: u?.name || u?.login, ...shiftTotals(db, s.client_uuid), byProduct };
}

// Phone upload: create the shift on first sight (number assigned here).
export function ensureShift(db, userId, { uuid, openedAt }) {
  const s = db.prepare('SELECT * FROM shifts WHERE client_uuid = ?').get(uuid);
  if (s) {
    if (s.employee_id !== userId) throw new ShiftError('Bu smena boshqa xodimniki');
    return s;
  }
  db.prepare('INSERT INTO shifts (client_uuid, number, employee_id, opened_at) VALUES (?, ?, ?, ?)')
    .run(uuid, nextNumber(db), userId, openedAt);
  return db.prepare('SELECT * FROM shifts WHERE client_uuid = ?').get(uuid);
}

export function closeShift(db, s, closedAt) {
  // A shift is closed from the open draft, or re-closed after an edit (editing).
  if (s.status !== 'open' && s.status !== 'editing') return s;
  db.prepare("UPDATE shifts SET status = 'closed', closed_at = ? WHERE id = ?").run(closedAt ?? now(), s.id);
  const next = db.prepare('SELECT * FROM shifts WHERE id = ?').get(s.id);
  emitEvent(db, 'shift.closed', eventPayload(db, next));
  return next;
}

// Re-open a closed-but-not-accepted shift for editing (a collector who closed it
// by mistake). It goes to the "editing" state: it is editable again, blocks a new
// shift, and cannot be accepted until the collector re-closes it.
export function reopenShift(db, id, actor) {
  const s = db.prepare('SELECT * FROM shifts WHERE id = ?').get(id);
  if (!s) throw new ShiftError('Smena topilmadi');
  if (s.status !== 'closed') throw new ShiftError('Faqat yopilgan (hali qabul qilinmagan) smenani tahrirlash mumkin');
  // Back to the open (editable) state, but marked as reopened so the UI can show
  // it as "Tahrir". Status stays within the table's allowed set.
  db.prepare("UPDATE shifts SET status = 'open', closed_at = NULL, reopened_at = ? WHERE id = ?").run(now(), s.id);
  const next = db.prepare('SELECT * FROM shifts WHERE id = ?').get(s.id);
  emitEvent(db, 'shift.edit', { ...eventPayload(db, next), by: actor });
  return next;
}

// Written quantity per product for a shift (what the collector entered).
const writtenByProduct = (db, uuid) => db.prepare(`SELECT c.product_id, p.name AS product, p.unit,
    ROUND(SUM(c.quantity), 2) AS written FROM collections c JOIN products p ON p.id = c.product_id
    WHERE c.shift_uuid = ? GROUP BY c.product_id ORDER BY p.name`).all(uuid);

// The accepted-quantity difference for one shift: per product, what the collector
// wrote vs. the real quantity the acceptor recorded, and the gap. hasReal is false
// when no real quantities were recorded (feature off, or not yet accepted), in
// which case real == written and every diff is 0.
export function shiftDiff(db, s) {
  const written = writtenByProduct(db, s.client_uuid);
  const accepts = Object.fromEntries(db.prepare('SELECT product_id, real_quantity FROM shift_accepts WHERE shift_id = ?')
    .all(s.id).map((r) => [r.product_id, r.real_quantity]));
  const hasReal = Object.keys(accepts).length > 0;
  const r2 = (n) => Math.round(n * 100) / 100;
  const products = written.map((w) => {
    const real = accepts[w.product_id] ?? w.written;
    return { product_id: w.product_id, name: w.product, unit: w.unit, written: w.written, real: r2(real), diff: r2(real - w.written) };
  });
  const totals = products.reduce((a, p) => ({ written: r2(a.written + p.written), real: r2(a.real + p.real), diff: r2(a.diff + p.diff) }),
    { written: 0, real: 0, diff: 0 });
  return { hasReal, products, ...totals };
}

// Accepting stamps today's agreed price on every pickup. If a supplier has no
// price for the product yet (e.g. added in the field), acceptance is refused.
// When the "difference" feature is on, the acceptor may pass real quantities per
// product (opts.real = { [productId]: kg }); the gap to the written total is
// checked against the configured limit and stored — it never changes any balance.
export function acceptShift(db, id, actor, opts = {}) {
  const s = db.prepare('SELECT * FROM shifts WHERE id = ?').get(id);
  if (!s) throw new ShiftError('Smena topilmadi');
  if (s.status !== 'closed') throw new ShiftError(s.status === 'open' ? 'Smena hali yopilmagan' : 'Faqat yopilgan (kutayotgan) smenani qabul qilish mumkin');
  const rows = db.prepare(`SELECT c.id, c.supplier_id, c.product_id, sp.price, s.name AS supplier, p.name AS product
    FROM collections c JOIN suppliers s ON s.id = c.supplier_id JOIN products p ON p.id = c.product_id
    LEFT JOIN supplier_products sp ON sp.supplier_id = c.supplier_id AND sp.product_id = c.product_id
    WHERE c.shift_uuid = ?`).all(s.client_uuid);
  const missing = [...new Set(rows.filter((r) => r.price == null).map((r) => `${r.supplier} — ${r.product}`))];
  if (missing.length) throw new ShiftError(`Narx belgilanmagan: ${missing.join(', ')}. Avval narxni belgilang.`, { missing });

  const flags = diffFlags(db);
  const real = (opts && typeof opts.real === 'object' && opts.real) || {};
  const accepts = [];
  if (flags.enabled) {
    for (const w of writtenByProduct(db, s.client_uuid)) {
      const given = real[w.product_id] ?? real[String(w.product_id)];
      const qty = given == null || given === '' ? w.written : Math.round(Number(given) * 100) / 100;
      if (!Number.isFinite(qty) || qty < 0) throw new ShiftError(`${w.product}: real miqdor noto'g'ri`);
      const d = Math.round((qty - w.written) * 100) / 100;
      if (flags.over != null && d > flags.over) throw new ShiftError(`${w.product}: farq +${d} kg, ruxsat +${flags.over} kg dan oshdi`, { limit: true });
      if (flags.under != null && d < -flags.under) throw new ShiftError(`${w.product}: farq ${d} kg, ruxsat −${flags.under} kg dan oshdi`, { limit: true });
      accepts.push({ product_id: w.product_id, qty });
    }
  }

  db.transaction(() => {
    const stamp = db.prepare('UPDATE collections SET price = ? WHERE id = ?');
    for (const r of rows) stamp.run(r.price, r.id);
    db.prepare("UPDATE shifts SET status = 'accepted', accepted_by = ?, accepted_at = ? WHERE id = ?").run(actor, now(), s.id);
    db.prepare('DELETE FROM shift_accepts WHERE shift_id = ?').run(s.id);
    if (flags.enabled) {
      const ins = db.prepare('INSERT INTO shift_accepts (shift_id, product_id, real_quantity) VALUES (?, ?, ?)');
      for (const a of accepts) ins.run(s.id, a.product_id, a.qty);
    }
    // Yaya 2.0: the accepted milk enters the raw-milk warehouse in the same transaction.
    receiveShiftMilk(db, s.id, actor);
  })();
  const next = db.prepare('SELECT * FROM shifts WHERE id = ?').get(s.id);
  emitEvent(db, 'shift.accepted', { ...eventPayload(db, next), by: actor });
  return next;
}

export function cancelShift(db, id, actor, reason) {
  const s = db.prepare('SELECT * FROM shifts WHERE id = ?').get(id);
  if (!s) throw new ShiftError('Smena topilmadi');
  if (s.status !== 'closed') {
    throw new ShiftError(s.status === 'accepted'
      ? 'Qabul qilingan smenani bekor qilib bo\'lmaydi'
      : 'Faqat kutayotgan (yopilgan) smenani bekor qilish mumkin');
  }
  if (!reason) throw new ShiftError('Bekor qilish sababini yozing');
  db.prepare("UPDATE shifts SET status = 'cancelled', cancelled_by = ?, cancelled_at = ?, cancel_reason = ? WHERE id = ?")
    .run(actor, now(), reason, s.id);
  const next = db.prepare('SELECT * FROM shifts WHERE id = ?').get(s.id);
  emitEvent(db, 'shift.cancelled', { ...eventPayload(db, next), by: actor, reason, wasAccepted: s.status === 'accepted' });
  return next;
}

// Copy a cancelled shift into a new open draft for the same collector, so they
// only fix what was wrong instead of entering everything again.
export function copyShift(db, id, actor) {
  const s = db.prepare('SELECT * FROM shifts WHERE id = ?').get(id);
  if (!s) throw new ShiftError('Smena topilmadi');
  if (s.status !== 'cancelled') throw new ShiftError('Faqat bekor qilingan smenani nusxalash mumkin');
  const active = activeShift(db, s.employee_id);
  if (active) throw new ShiftError(`Bu xodimda ${shiftLabel(active)} smena hali ${active.status === 'open' ? 'ochiq' : 'qabul qilinmagan'}`);
  const copyNo = (db.prepare('SELECT MAX(copy_no) AS n FROM shifts WHERE number = ?').get(s.number).n ?? 0) + 1;
  const uuid = randomUUID();
  db.transaction(() => {
    db.prepare('INSERT INTO shifts (client_uuid, number, copy_no, copied_from, employee_id, opened_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(uuid, s.number, copyNo, s.id, s.employee_id, now());
    const ins = db.prepare(`INSERT INTO collections (client_uuid, shift_uuid, employee_id, supplier_id, product_id, quantity, collected_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const c of db.prepare('SELECT * FROM collections WHERE shift_uuid = ? ORDER BY collected_at').all(s.client_uuid)) {
      ins.run(randomUUID(), uuid, c.employee_id, c.supplier_id, c.product_id, c.quantity, c.collected_at);
    }
  })();
  const next = db.prepare('SELECT * FROM shifts WHERE client_uuid = ?').get(uuid);
  emitEvent(db, 'shift.copied', { from: shiftLabel(s), to: shiftLabel(next), by: actor });
  return next;
}

// Delete the collectors' current shifts: every shift whose number is not settled
// by an accepted shift (open, editing, waiting, cancelled and its copies), with all
// its entries. Accepted shifts — real milk in the warehouse, debts to households —
// are never touched. Optional: only one collector's. Returns the labels deleted.
export function deleteActiveShifts(db, actor, { employee = null } = {}) {
  const groups = db.prepare(`SELECT employee_id, number FROM shifts ${employee ? 'WHERE employee_id = ?' : ''}
    GROUP BY employee_id, number HAVING MAX(status = 'accepted') = 0`).all(...(employee ? [employee] : []));
  const done = [];
  db.transaction(() => {
    const pick = db.prepare('SELECT * FROM shifts WHERE employee_id = ? AND number = ? ORDER BY id DESC');
    for (const g of groups) {
      for (const s of pick.all(g.employee_id, g.number)) {
        db.prepare('UPDATE shifts SET copied_from = NULL WHERE copied_from = ?').run(s.id);
        db.prepare('DELETE FROM collections WHERE shift_uuid = ?').run(s.client_uuid);
        db.prepare('DELETE FROM shift_accepts WHERE shift_id = ?').run(s.id);
        db.prepare('DELETE FROM shifts WHERE id = ?').run(s.id);
        db.prepare('INSERT OR REPLACE INTO deleted_shifts (client_uuid, employee_id, label, deleted_by) VALUES (?, ?, ?, ?)')
          .run(s.client_uuid, s.employee_id, shiftLabel(s), actor);
        done.push(shiftLabel(s));
      }
    }
  })();
  if (done.length) emitEvent(db, 'shift.deleted', { shifts: done, by: actor });
  return done;
}

// Shift list with totals, for reviewers and the live view.
export function listShifts(db, { from, to, status, employee, limit = 500 }) {
  return db.prepare(`
    SELECT sh.id, sh.client_uuid, sh.number, sh.copy_no, sh.opened_at, sh.closed_at, sh.status, sh.reopened_at,
      sh.accepted_by, sh.accepted_at, sh.cancelled_by, sh.cancelled_at, sh.cancel_reason,
      u.id AS employee_id, u.name AS employee_name, u.is_test,
      COUNT(c.id) AS pickups, ROUND(COALESCE(SUM(c.quantity), 0), 2) AS quantity,
      CAST(COALESCE(SUM(ROUND(c.quantity * c.price)), 0) AS INTEGER) AS amount,
      COUNT(DISTINCT c.supplier_id) AS suppliers, MAX(c.collected_at) AS last_at, sa.real_q AS accepted_quantity
    FROM shifts sh JOIN users u ON u.id = sh.employee_id
    LEFT JOIN collections c ON c.shift_uuid = sh.client_uuid
    LEFT JOIN (SELECT shift_id, ROUND(SUM(real_quantity), 2) AS real_q FROM shift_accepts GROUP BY shift_id) sa ON sa.shift_id = sh.id
    WHERE (@from IS NULL OR date(sh.opened_at, '+5 hours') BETWEEN @from AND @to)
      AND (@status IS NULL OR sh.status = @status) AND (@employee IS NULL OR sh.employee_id = @employee)
    GROUP BY sh.id ORDER BY sh.opened_at DESC LIMIT ${Number(limit) || 500}`)
    .all({ from: from ?? null, to: to ?? null, status: status ?? null, employee: employee ?? null })
    .map((r) => ({
      ...r, amount: r.status === 'accepted' ? r.amount : null, status: displayStatus(r), label: shiftLabel(r),
      // Accepted real total and its gap to the written total (difference feature).
      accepted_quantity: r.status === 'accepted' && r.accepted_quantity != null ? r.accepted_quantity : null,
      diff_quantity: r.status === 'accepted' && r.accepted_quantity != null ? Math.round((r.accepted_quantity - r.quantity) * 100) / 100 : null,
    }));
}

export function shiftDetail(db, id) {
  const s = db.prepare(`SELECT sh.*, u.name AS employee_name FROM shifts sh JOIN users u ON u.id = sh.employee_id WHERE sh.id = ?`).get(id);
  if (!s) return null;
  const rows = db.prepare(`SELECT c.id, c.client_uuid, c.collected_at, c.quantity, c.price, c.edited_at,
      CASE WHEN c.price IS NULL THEN NULL ELSE CAST(ROUND(c.quantity * c.price) AS INTEGER) END AS amount,
      s.id AS supplier_id, s.name AS supplier_name, p.name AS product_name, p.unit,
      (SELECT sp.price FROM supplier_products sp WHERE sp.supplier_id = c.supplier_id AND sp.product_id = c.product_id) AS current_price
    FROM collections c JOIN suppliers s ON s.id = c.supplier_id JOIN products p ON p.id = c.product_id
    WHERE c.shift_uuid = ? ORDER BY c.collected_at`).all(s.client_uuid);
  const byProduct = {};
  for (const r of rows) {
    const k = r.product_name;
    byProduct[k] ??= { name: r.product_name, unit: r.unit, quantity: 0, pickups: 0 };
    byProduct[k].quantity = Math.round((byProduct[k].quantity + r.quantity) * 100) / 100;
    byProduct[k].pickups++;
  }
  return { shift: { ...s, status: displayStatus(s), label: shiftLabel(s) }, rows, byProduct: Object.values(byProduct), diff: shiftDiff(db, s) };
}
