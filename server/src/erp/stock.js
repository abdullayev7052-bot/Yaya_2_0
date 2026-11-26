// Stock engine: documents, lots (FIFO) and the stock ledger. See schema.js.
//
// Rules kept here (not in the routes), so every entry point behaves the same:
// - quantities are rounded to 3 decimals (gram precision for kg), money to 2;
// - an outgoing quantity takes the oldest lots at that holder first (FIFO), at the
//   lot's own unit cost; a fully used lot takes its whole remaining cost, so no
//   rounding crumbs stay behind;
// - a holder may go below zero only if it is a warehouse with allow_negative (stage
//   warehouses do); the shortage is booked at the product's last known unit cost and
//   settled by the next receipt. What was made from that shortage is linked to it
//   (neg_links), so the gap between the real and the estimated cost is passed on to
//   those lots — every product ends at its real cost (FIFO); only a gap nobody can
//   carry goes to "tannarx farqi";
// - goods are always in a warehouse (or a stage); "in a person's hands" is gone
//   (stage 10). Old documents that named a person still read correctly;
// - a posted document never changes; cancelling it writes the exact opposite moves
//   (and reverses its money entries), and is refused if that would leave a lot
//   below zero where that is not allowed.
import { randomUUID } from 'node:crypto';
import { getSetting, setSetting } from '../settings.js';

export class StockError extends Error {
  constructor(message, details) {
    super(message);
    this.details = details;
  }
}

export const r3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;
export const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const EPS = 0.0005;
const nowIso = () => new Date().toISOString();

export const DOC_TYPES = {
  opening: { label: 'Boshlang\'ich qoldiq', prefix: 'BQ' },
  milk_in: { label: 'Sut kirimi (smena)', prefix: 'SK' },
  transfer: { label: 'Topshirish', prefix: 'T' },
  inventory: { label: 'Inventarizatsiya', prefix: 'INV' },
  writeoff: { label: 'Hisobdan chiqarish', prefix: 'HC' },
  production: { label: 'Ishlab chiqarish', prefix: 'IC' },
  shift_close: { label: 'Texnolog smenasi yakuni', prefix: 'TS' },
  stage_move: { label: 'Bosqich amali', prefix: 'BA' },
  sale: { label: 'Sotuv', prefix: 'S' },
  return: { label: 'Qaytarish', prefix: 'Q' },
  payment: { label: "Mijozdan to'lov", prefix: 'TL' },
  purchase: { label: 'Xarid (kirim)', prefix: 'XK' },
  vendor_pay: { label: "Yetkazib beruvchiga to'lov", prefix: 'YT' },
  expense: { label: 'Xarajat', prefix: 'XR' },
  income: { label: 'Boshqa kirim', prefix: 'KR' },
  cash_move: { label: 'Kassadan kassaga', prefix: 'KO' },
  cash_open: { label: "Kassa boshlang'ich qoldig'i", prefix: 'KB' },
  salary: { label: 'Oylik hisoblandi', prefix: 'OY' },
  bonus: { label: 'Bonus', prefix: 'BN' },
  fine: { label: 'Jarima', prefix: 'JR' },
  staff_pay: { label: "Xodimga to'lov", prefix: 'IP' },
  staff_open: { label: "Xodim boshlang'ich balansi", prefix: 'XB' },
  cash_count: { label: 'Kassa sanog\'i', prefix: 'KS' },
};
// Types a person creates directly; the others come from shifts and production.
const MANUAL_TYPES = new Set(['opening', 'transfer', 'inventory', 'writeoff']);
export const docLabel = (d) => `${DOC_TYPES[d.type]?.prefix ?? d.type}-${d.number}`;

// ---------------------------------------------------------------- holders
// A holder is { warehouseId } or { userId }.
export const holderKey = (h) => (h.warehouseId ? `w${h.warehouseId}` : `u${h.userId}`);
const holderCond = (h, alias = '') => (h.warehouseId ? [`${alias}warehouse_id = ?`, h.warehouseId] : [`${alias}holder_id = ?`, h.userId]);
export const fromOf = (d) => (d.from_wh ? { warehouseId: d.from_wh } : d.from_user ? { userId: d.from_user } : null);
export const toOf = (d) => (d.to_wh ? { warehouseId: d.to_wh } : d.to_user ? { userId: d.to_user } : null);

export function holderName(db, h) {
  if (!h) return null;
  if (h.warehouseId) return db.prepare('SELECT name FROM warehouses WHERE id = ?').get(h.warehouseId)?.name ?? `Ombor #${h.warehouseId}`;
  return db.prepare('SELECT COALESCE(name, login) AS n FROM users WHERE id = ?').get(h.userId)?.n ?? `Xodim #${h.userId}`;
}

// Parse { warehouseId } / { userId } from client input; null when absent or unknown.
export function parseHolder(db, v) {
  if (!v || typeof v !== 'object') return null;
  const w = Number(v.warehouseId); const u = Number(v.userId);
  if (Number.isInteger(w) && w > 0) return db.prepare('SELECT 1 FROM warehouses WHERE id = ? AND active = 1').get(w) ? { warehouseId: w } : null;
  if (Number.isInteger(u) && u > 0) return db.prepare('SELECT 1 FROM users WHERE id = ? AND active = 1').get(u) ? { userId: u } : null;
  return null;
}

export const allowNegative = (db, h) => !!(h.warehouseId && db.prepare('SELECT allow_negative FROM warehouses WHERE id = ?').get(h.warehouseId)?.allow_negative);
const productName = (db, id) => db.prepare('SELECT name FROM products WHERE id = ?').get(id)?.name ?? `#${id}`;

// ---------------------------------------------------------------- balances
export function productBalance(db, h, productId) {
  const [cond, v] = holderCond(h);
  return r3(db.prepare(`SELECT COALESCE(SUM(qty), 0) AS q FROM stock_moves WHERE ${cond} AND product_id = ?`).get(v, productId).q);
}

// Lots at a holder, oldest first; the "no lot" (negative / unknown) row first.
export function lotBalances(db, h, productId) {
  const [cond, v] = holderCond(h, 'm.');
  return db.prepare(`
    SELECT m.lot_id, ROUND(SUM(m.qty), 3) AS qty, ROUND(SUM(m.cost), 2) AS cost, l.number, l.unit_cost, l.produced_at, l.expires_at, l.provisional
    FROM stock_moves m LEFT JOIN lots l ON l.id = m.lot_id
    WHERE ${cond} AND m.product_id = ?
    GROUP BY m.lot_id
    HAVING ABS(SUM(m.qty)) > ${EPS}
    ORDER BY (m.lot_id IS NOT NULL), l.produced_at, l.id`).all(v, productId);
}

export function lastUnitCost(db, productId) {
  return db.prepare('SELECT unit_cost FROM lots WHERE product_id = ? ORDER BY produced_at DESC, id DESC LIMIT 1').get(productId)?.unit_cost ?? 0;
}

// ---------------------------------------------------------------- low-level moves
export function insertMove(db, ctx, { lineId = null, productId, lotId = null, h, qty, cost, kind = null }) {
  db.prepare(`INSERT INTO stock_moves (doc_id, line_id, product_id, lot_id, warehouse_id, holder_id, qty, cost, at, kind)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(ctx.doc.id, lineId, productId, lotId, h.warehouseId ?? null, h.userId ?? null, r3(qty), r2(cost), ctx.at, kind);
  if (h.warehouseId) ctx.touched.add(`${h.warehouseId}:${productId}`);
}

export function newLot(db, ctx, { productId, qty, unitCost, expiresAt, producedAt, seq, provisional = 0, shiftId = null }) {
  const p = db.prepare('SELECT shelf_life_hours FROM products WHERE id = ?').get(productId);
  const produced = producedAt ?? ctx.at;
  const expires = expiresAt ?? (p?.shelf_life_hours ? new Date(Date.parse(produced) + p.shelf_life_hours * 3600e3).toISOString() : null);
  return Number(db.prepare('INSERT INTO lots (product_id, number, unit_cost, produced_at, expires_at, doc_id, qty0, provisional, shift_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(productId, `${docLabel(ctx.doc)}/${seq}`, unitCost, produced, expires, ctx.doc.id, qty ?? null, provisional ? 1 : 0, shiftId).lastInsertRowid);
}

export function pnl(db, ctx, code, amount, note = null) {
  if (Math.abs(amount) < 0.005) return;
  const cat = typeof code === 'number' ? code : db.prepare('SELECT id FROM pnl_categories WHERE code = ?').get(code)?.id;
  db.prepare('INSERT INTO pnl_entries (category_id, amount, doc_id, note, at) VALUES (?, ?, ?, ?, ?)').run(cat, r2(amount), ctx.doc.id, note, ctx.at);
}

export function chargeStaff(db, ctx, userId, amount, kind, note = null) {
  if (Math.abs(amount) < 0.005) return;
  db.prepare("INSERT INTO party_entries (party_type, party_id, amount, kind, doc_id, note, at) VALUES ('staff', ?, ?, ?, ?, ?, ?)")
    .run(userId, r2(amount), kind, ctx.doc.id, note, ctx.at);
}

// Take qty of a product out of a holder, oldest lots first. Returns what was taken.
export function takeOut(db, ctx, { productId, h, qty, lineId = null, kind = null, allowNeg = false }) {
  let need = r3(qty);
  const taken = [];
  const lots = lotBalances(db, h, productId);
  for (const l of lots) {
    if (need <= EPS) break;
    if (l.qty <= EPS) continue;
    const q = r3(Math.min(need, l.qty));
    const exhausted = Math.abs(q - l.qty) <= EPS;
    const unit = l.lot_id ? l.unit_cost : l.cost / l.qty;
    const cost = exhausted ? l.cost : r2(q * unit);
    insertMove(db, ctx, { lineId, productId, lotId: l.lot_id, h, qty: -q, cost: -cost, kind });
    taken.push({ lotId: l.lot_id, qty: q, cost, h });
    need = r3(need - q);
  }
  if (need > EPS) {
    if (!allowNeg && !allowNegative(db, h)) {
      const have = productBalance(db, h, productId);
      throw new StockError(`${productName(db, productId)}: "${holderName(db, h)}" da yetarli emas (bor: ${Math.max(0, r3(have + r3(qty) - need))}, kerak: ${r3(qty)})`,
        { productId, holder: h, available: r3(r3(qty) - need), required: r3(qty) });
    }
    const cost = r2(need * lastUnitCost(db, productId));
    insertMove(db, ctx, { lineId, productId, lotId: null, h, qty: -need, cost: -cost, kind });
    taken.push({ lotId: null, qty: need, cost, h, productId });
  }
  return taken;
}

// Put qty into a holder: an existing lot (moved from elsewhere) or a new one.
// A receipt into a warehouse that is below zero for this product settles that first.
export function addIn(db, ctx, { productId, h, qty, cost, lotId, lot, lineId = null, kind = null }) {
  let id = lotId ?? null;
  if (lotId === undefined && lot) id = newLot(db, ctx, { productId, qty, ...lot });
  insertMove(db, ctx, { lineId, productId, lotId: id, h, qty, cost, kind });
  if (id != null && h.warehouseId) settleNegative(db, ctx, h, productId, id);
  return id;
}

function settleNegative(db, ctx, h, productId, lotId) {
  const [cond, v] = holderCond(h);
  const neg = db.prepare(`SELECT ROUND(SUM(qty), 3) AS q, ROUND(SUM(cost), 2) AS c FROM stock_moves WHERE ${cond} AND product_id = ? AND lot_id IS NULL`).get(v, productId);
  if (!neg?.q || neg.q >= -EPS) return;
  const lot = db.prepare(`SELECT ROUND(SUM(m.qty), 3) AS q, l.unit_cost FROM stock_moves m JOIN lots l ON l.id = m.lot_id
    WHERE ${cond.replace(/^/, 'm.')} AND m.lot_id = ?`).get(v, lotId);
  const s = r3(Math.min(-neg.q, lot?.q ?? 0));
  if (s <= EPS) return;
  const whole = Math.abs(s + neg.q) <= EPS;
  const estCost = whole ? -neg.c : r2(s * (neg.c / neg.q));
  const realCost = r2(s * lot.unit_cost);
  insertMove(db, ctx, { productId, lotId, h, qty: -s, cost: -realCost, kind: 'settle' });
  insertMove(db, ctx, { productId, lotId: null, h, qty: s, cost: estCost, kind: 'settle' });
  // The lots made from the shortage take the gap (oldest shortage first).
  let left = s; let gap = r2(realCost - estCost);
  if (h.warehouseId) {
    for (const link of db.prepare(`SELECT * FROM neg_links WHERE warehouse_id = ? AND product_id = ? AND open_qty > ${EPS} ORDER BY id`).all(h.warehouseId, productId)) {
      if (left <= EPS) break;
      const q = r3(Math.min(left, link.open_qty));
      const d = r2(q * lot.unit_cost - (q * link.est_cost) / link.qty);
      if (link.lot_id) {
        revalueLot(db, ctx, link.lot_id, d);
        gap = r2(gap - d);
        // From now on the settling lot is a source of what was made: a later change
        // to its cost (e.g. the shift's boiling loss) reaches that lot too.
        db.prepare('INSERT INTO lot_sources (lot_id, source_lot_id, qty, doc_id) VALUES (?, ?, ?, ?)').run(link.lot_id, lotId, q, ctx.doc.id);
      }
      db.prepare('UPDATE neg_links SET open_qty = ? WHERE id = ?').run(r3(link.open_qty - q), link.id);
      if (link.lot_id && !db.prepare(`SELECT 1 FROM neg_links WHERE lot_id = ? AND open_qty > ${EPS}`).get(link.lot_id)) {
        db.prepare('UPDATE lots SET provisional = 0 WHERE id = ? AND (shift_id IS NULL OR shift_id NOT IN (SELECT id FROM prod_shifts WHERE status <> ?))').run(link.lot_id, 'closed');
      }
      left = r3(left - q);
    }
  }
  pnl(db, ctx, 'cost_variance', gap, `${productName(db, productId)}: manfiy qoldiq yopildi`);
}

// Something was made (lot `lotId`, or a share of it) from stock taken below zero:
// remember it, so the real cost reaches that lot when the shortage is settled.
export function linkNegative(db, ctx, chunk, lotId, share = 1) {
  if (chunk.lotId || !chunk.h?.warehouseId || !(chunk.qty > EPS)) return;
  const q = r3(chunk.qty * share);
  if (!(q > EPS)) return;
  db.prepare('INSERT INTO neg_links (warehouse_id, product_id, qty, open_qty, est_cost, lot_id, doc_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(chunk.h.warehouseId, chunk.productId, q, q, r2(chunk.cost * share), lotId, ctx.doc.id);
  db.prepare('UPDATE lots SET provisional = 1 WHERE id = ?').run(lotId);
}

// Change a lot's cost by `amount`: the part still on hand is revalued where it is,
// the part already used is passed to the lots made from it, and the part that left
// the company (sold, written off) becomes a cost variance.
export function revalueLot(db, ctx, lotId, amount, depth = 0) {
  if (Math.abs(amount) < 0.005 || depth > 20) return;
  const lot = db.prepare('SELECT * FROM lots WHERE id = ?').get(lotId);
  const qty0 = lot.qty0 ?? db.prepare('SELECT COALESCE(MAX(qty), 0) AS q FROM stock_moves WHERE lot_id = ? AND doc_id = ?').get(lotId, lot.doc_id).q;
  if (!(qty0 > EPS)) { pnl(db, ctx, 'cost_variance', amount, `Partiya ${lot.number}`); return; }
  const per = amount / qty0;
  const onHand = db.prepare(`SELECT warehouse_id, holder_id, SUM(qty) AS q FROM stock_moves WHERE lot_id = ? GROUP BY warehouse_id, holder_id HAVING SUM(qty) > ${EPS}`).all(lotId);
  const children = db.prepare('SELECT lot_id, SUM(qty) AS q FROM lot_sources WHERE source_lot_id = ? GROUP BY lot_id').all(lotId);
  let rest = amount;
  for (const x of onHand) {
    const c = r2(per * x.q);
    insertMove(db, ctx, { productId: lot.product_id, lotId, h: x.warehouse_id ? { warehouseId: x.warehouse_id } : { userId: x.holder_id }, qty: 0, cost: c, kind: 'reval' });
    rest -= c;
  }
  for (const ch of children) {
    const c = r2(per * ch.q);
    revalueLot(db, ctx, ch.lot_id, c, depth + 1);
    rest -= c;
  }
  if (Math.abs(rest) >= 0.005) pnl(db, ctx, 'cost_variance', rest, `Partiya ${lot.number}: chiqib ketgan qismi`);
  db.prepare('UPDATE lots SET unit_cost = unit_cost + ? WHERE id = ?').run(per, lotId);
}

// Move qty from one holder to another, keeping lot identity and cost.
export function moveStock(db, ctx, { productId, from, to, qty, lineId = null, kind = null }) {
  const taken = takeOut(db, ctx, { productId, h: from, qty, lineId, kind });
  for (const t of taken) addIn(db, ctx, { productId, h: to, qty: t.qty, cost: t.cost, lotId: t.lotId, lineId, kind });
  return taken;
}

// After posting: warn about warehouses that went below zero (if they ask for it).
export function negativeAlerts(db, ctx) {
  for (const key of ctx.touched) {
    const [wh, productId] = key.split(':').map(Number);
    const w = db.prepare('SELECT name, warn_negative FROM warehouses WHERE id = ?').get(wh);
    if (!w?.warn_negative) continue;
    const q = productBalance(db, { warehouseId: wh }, productId);
    if (q < -EPS) {
      addAlert(db, 'stock.negative', `"${w.name}": ${productName(db, productId)} manfiy qoldiqqa tushdi (${q})`, { warehouseId: wh, productId, qty: q }, ctx.doc.id);
    }
  }
}

// "Waiting for a manager" alerts of a document end when the document is decided.
function closeDocAlerts(db, docId, actor) {
  db.prepare("UPDATE alerts SET resolved_at = datetime('now'), resolved_by = ? WHERE doc_id = ? AND type = 'stock.shortage' AND resolved_at IS NULL").run(actor, docId);
}

export function addAlert(db, type, text, payload, docId = null) {
  db.prepare('INSERT INTO alerts (type, text, payload, doc_id) VALUES (?, ?, ?, ?)').run(type, text, payload == null ? null : JSON.stringify(payload), docId);
}

// ---------------------------------------------------------------- documents
export const getDoc = (db, id) => db.prepare('SELECT * FROM docs WHERE id = ?').get(id);
const linesOf = (db, id) => db.prepare('SELECT * FROM doc_lines WHERE doc_id = ? ORDER BY sort, id').all(id);
const meta = (v) => (v ? JSON.parse(v) : {});

function cleanLines(db, lines, { needCost = false, allowZero = false } = {}) {
  if (!Array.isArray(lines) || !lines.length) throw new StockError('Kamida bitta mahsulot kiriting');
  if (lines.length > 2000) throw new StockError('Juda ko\'p qator');
  return lines.map((l, i) => {
    const productId = Number(l?.productId);
    const p = Number.isInteger(productId) && db.prepare('SELECT id, name, has_variants FROM products WHERE id = ?').get(productId);
    if (!p) throw new StockError(`${i + 1}-qator: mahsulot topilmadi`);
    if (p.has_variants) throw new StockError(`${p.name}: variantini tanlang (masalan "${p.name} / ...")`);
    const qty = r3(l.qty);
    if (!Number.isFinite(qty) || qty < 0 || (!allowZero && qty <= 0)) throw new StockError(`${p.name}: miqdor noto'g'ri`);
    let unitCost = null;
    if (l.unitCost != null && l.unitCost !== '') {
      unitCost = Number(l.unitCost);
      if (!Number.isFinite(unitCost) || unitCost < 0) throw new StockError(`${p.name}: tannarx noto'g'ri`);
    } else if (needCost) unitCost = 0;
    const expiresAt = l.expiresAt && !Number.isNaN(Date.parse(l.expiresAt)) ? new Date(l.expiresAt).toISOString() : null;
    return { productId, qty, unitCost, expiresAt, meta: l.meta ?? null };
  });
}

export function nextNumber(db, type) {
  return (db.prepare('SELECT COALESCE(MAX(number), 0) AS n FROM docs WHERE type = ?').get(type).n) + 1;
}

// Create a document (and post it, unless it is a draft or a hand-over waiting to be
// accepted). Idempotent by uuid: a re-send returns the existing document.
export function createDoc(db, input, { actor, userId = null }) {
  const type = String(input?.type ?? '');
  if (!MANUAL_TYPES.has(type)) throw new StockError('Hujjat turi noto\'g\'ri');
  const uuid = String(input.uuid || randomUUID()).slice(0, 80);
  const existing = db.prepare('SELECT * FROM docs WHERE uuid = ?').get(uuid);
  if (existing) {
    if (existing.type !== type) throw new StockError('Bu UUID boshqa hujjatda ishlatilgan');
    return existing;
  }
  const from = parseHolder(db, input.from);
  const to = parseHolder(db, input.to);
  if (from?.userId || to?.userId) throw new StockError("Mahsulot faqat ombor yoki bosqichda turadi — xodim qo'liga topshirish yo'q");
  const date = input.date && !Number.isNaN(Date.parse(input.date)) ? new Date(input.date).toISOString() : nowIso();
  const doc = { type, mode: null, reason_id: null, charge_user: null };
  let lines;
  let status = 'draft';
  if (type === 'opening') {
    if (!to?.warehouseId) throw new StockError('Omborni tanlang');
    lines = cleanLines(db, input.lines, { needCost: true });
  } else if (type === 'transfer') {
    if (!from || !to) throw new StockError('Kimdan va kimga topshirilishini tanlang');
    if (holderKey(from) === holderKey(to)) throw new StockError('O\'ziga topshirib bo\'lmaydi');
    lines = cleanLines(db, input.lines);
    status = 'sent';
  } else if (type === 'writeoff') {
    if (!from) throw new StockError('Qayerdan hisobdan chiqarilishini tanlang');
    const reason = db.prepare("SELECT * FROM stock_reasons WHERE id = ? AND active = 1 AND section = 'warehouse'").get(Number(input.reasonId));
    if (!reason) throw new StockError('Sababni tanlang');
    doc.reason_id = reason.id;
    const charge = Number(input.chargeUserId);
    if (Number.isInteger(charge) && charge > 0) {
      if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(charge)) throw new StockError('Xodim topilmadi');
      doc.charge_user = charge;
    } else if (reason.charge === 'staff') {
      // "Xodim aybi bilan": the holder pays if goods were in their hands, otherwise someone must be chosen.
      if (!from.userId) throw new StockError('Qaysi xodim hisobiga yozilishini tanlang');
      doc.charge_user = from.userId;
    }
    lines = cleanLines(db, input.lines);
  } else if (type === 'inventory') {
    if (!to?.warehouseId) throw new StockError('Omborni tanlang');
    doc.mode = input.mode === 'full' ? 'full' : 'partial';
    lines = cleanLines(db, input.lines, { allowZero: true });
    const charge = Number(input.chargeUserId);
    if (Number.isInteger(charge) && charge > 0) doc.charge_user = charge;
  }
  const note = input.note == null ? null : String(input.note).slice(0, 500);
  const run = db.transaction(() => {
    const id = Number(db.prepare(`INSERT INTO docs (uuid, type, number, status, doc_date, from_wh, from_user, to_wh, to_user, mode, reason_id, charge_user, note, created_by, created_by_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(uuid, type, nextNumber(db, type), status, date,
      from?.warehouseId ?? null, from?.userId ?? null, to?.warehouseId ?? null, to?.userId ?? null,
      doc.mode, doc.reason_id, doc.charge_user, note, actor, userId).lastInsertRowid);
    const ins = db.prepare('INSERT INTO doc_lines (doc_id, product_id, qty, unit_cost, expires_at, meta, sort) VALUES (?, ?, ?, ?, ?, ?, ?)');
    lines.forEach((l, i) => ins.run(id, l.productId, l.qty, l.unitCost, l.expiresAt, l.meta ? JSON.stringify(l.meta) : null, i));
    // Inventory counts start as drafts unless asked to post; the rest post right away unless asked not to.
    const shouldPost = status === 'draft' && (type === 'inventory' ? input.post === true : input.post !== false);
    if (shouldPost) postDocTx(db, id, actor, input.charges === undefined ? {} : { charges: input.charges });
    return id;
  });
  return getDoc(db, run());
}

// Replace the lines of a draft (inventory counts are typically saved several times).
export function updateDraft(db, id, input) {
  const d = getDoc(db, id);
  if (!d) throw new StockError('Hujjat topilmadi');
  if (d.status !== 'draft') throw new StockError('Faqat qoralamani o\'zgartirish mumkin');
  const lines = cleanLines(db, input.lines, { allowZero: d.type === 'inventory', needCost: d.type === 'opening' });
  db.transaction(() => {
    db.prepare('DELETE FROM doc_lines WHERE doc_id = ?').run(id);
    const ins = db.prepare('INSERT INTO doc_lines (doc_id, product_id, qty, unit_cost, expires_at, sort) VALUES (?, ?, ?, ?, ?, ?)');
    lines.forEach((l, i) => ins.run(id, l.productId, l.qty, l.unitCost, l.expiresAt, i));
    if (input.note !== undefined) db.prepare('UPDATE docs SET note = ? WHERE id = ?').run(input.note == null ? null : String(input.note).slice(0, 500), id);
    if (input.mode !== undefined && d.type === 'inventory') db.prepare('UPDATE docs SET mode = ? WHERE id = ?').run(input.mode === 'full' ? 'full' : 'partial', id);
  })();
  return getDoc(db, id);
}

// opts.charges (inventory only): who pays the shortage, [{ userId, amount }]; what is
// left goes to the company. A shortage is never booked silently: posting an
// inventory with a shortage and no decision is refused with the amounts, so the
// screen can ask. [] = all to the company.
export function postDoc(db, id, actor, opts = {}) {
  db.transaction(() => postDocTx(db, id, actor, opts))();
  return getDoc(db, id);
}

// What posting an inventory draft would do (book, counted, difference, value),
// without changing anything: it is posted inside a transaction that is rolled back.
const PREVIEW = Symbol('preview');
export function inventoryPreview(db, id) {
  const d = getDoc(db, id);
  if (!d || d.type !== 'inventory') throw new StockError('Inventarizatsiya topilmadi');
  if (d.status !== 'draft') throw new StockError('Faqat qoralama uchun');
  let out;
  try {
    db.transaction(() => {
      const r = postDocTx(db, id, 'preview', { charges: [] });
      out = { ...r, lines: docDetail(db, id).lines.filter((l) => Math.abs(l.diff ?? 0) > EPS) };
      throw PREVIEW;
    })();
  } catch (e) { if (e !== PREVIEW) throw e; }
  return out;
}

function cleanCharges(db, charges, loss) {
  if (!Array.isArray(charges)) throw new StockError("Xodimlar hisobi noto'g'ri");
  const out = new Map();
  for (const c of charges) {
    const userId = Number(c?.userId); const amount = r2(c?.amount);
    if (!Number.isInteger(userId) || !db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) throw new StockError('Xodim topilmadi');
    if (!Number.isFinite(amount) || amount < 0) throw new StockError("Summa noto'g'ri");
    out.set(userId, r2((out.get(userId) ?? 0) + amount));
  }
  const total = r2([...out.values()].reduce((a, x) => a + x, 0));
  if (total > r2(loss) + 0.01) throw new StockError(`Xodimlarga yozilgan summa (${total}) kamomaddan (${r2(loss)}) ko'p`, { loss: r2(loss) });
  return { list: [...out].map(([userId, amount]) => ({ userId, amount })), total };
}

function postDocTx(db, id, actor, opts = {}) {
  const d = getDoc(db, id);
  if (!d) throw new StockError('Hujjat topilmadi');
  const okFrom = d.type === 'transfer' ? 'sent' : 'draft';
  if (d.status !== okFrom) throw new StockError(d.status === 'posted' ? 'Hujjat allaqachon o\'tkazilgan' : 'Bu hujjatni o\'tkazib bo\'lmaydi');
  const at = d.type === 'opening' || d.type === 'inventory' ? d.doc_date : nowIso();
  const ctx = { doc: d, at, touched: new Set() };
  const lines = linesOf(db, id);
  let result = {};

  if (d.type === 'opening' || d.type === 'milk_in') {
    const to = toOf(d);
    lines.forEach((l, i) => {
      const cost = l.meta && meta(l.meta).cost != null ? meta(l.meta).cost : r2(l.qty * (l.unit_cost ?? 0));
      addIn(db, ctx, { productId: l.product_id, h: to, qty: l.qty, cost, lineId: l.id,
        lot: { unitCost: l.qty > 0 ? cost / l.qty : 0, expiresAt: l.expires_at, producedAt: d.type === 'opening' ? d.doc_date : at, seq: i + 1 } });
    });
  } else if (d.type === 'transfer') {
    const from = fromOf(d); const to = toOf(d);
    for (const l of lines) moveStock(db, ctx, { productId: l.product_id, from, to, qty: l.qty, lineId: l.id });
  } else if (d.type === 'writeoff') {
    const from = fromOf(d);
    const reason = db.prepare('SELECT * FROM stock_reasons WHERE id = ?').get(d.reason_id);
    let total = 0;
    for (const l of lines) total += takeOut(db, ctx, { productId: l.product_id, h: from, qty: l.qty, lineId: l.id }).reduce((a, t) => a + t.cost, 0);
    if (d.charge_user) chargeStaff(db, ctx, d.charge_user, total, 'writeoff', reason?.name);
    else pnl(db, ctx, reason?.category_id ?? 'writeoff', total, reason?.name);
  } else if (d.type === 'inventory') {
    const wh = toOf(d);
    const counted = new Map(lines.map((l) => [l.product_id, l]));
    if (d.mode === 'full') {
      // Everything in the warehouse that was not counted is counted as zero.
      const present = db.prepare(`SELECT product_id FROM stock_moves WHERE warehouse_id = ? GROUP BY product_id HAVING ABS(SUM(qty)) > ${EPS}`).all(wh.warehouseId);
      for (const p of present) {
        if (counted.has(p.product_id)) continue;
        const lid = Number(db.prepare('INSERT INTO doc_lines (doc_id, product_id, qty, sort) VALUES (?, ?, 0, ?)').run(id, p.product_id, 9999).lastInsertRowid);
        counted.set(p.product_id, { id: lid, product_id: p.product_id, qty: 0 });
      }
    }
    let loss = 0; let surplus = 0; let seq = 0;
    for (const l of counted.values()) {
      const book = productBalance(db, wh, l.product_id);
      const diff = r3(l.qty - book);
      db.prepare('UPDATE doc_lines SET meta = ? WHERE id = ?').run(JSON.stringify({ book, diff }), l.id);
      if (diff > EPS) {
        const unit = lastUnitCost(db, l.product_id);
        const cost = r2(diff * unit);
        addIn(db, ctx, { productId: l.product_id, h: wh, qty: diff, cost, lineId: l.id, kind: 'surplus', lot: { unitCost: unit, seq: ++seq } });
        surplus += cost;
      } else if (diff < -EPS) {
        loss += takeOut(db, ctx, { productId: l.product_id, h: wh, qty: -diff, lineId: l.id, kind: 'shortage' }).reduce((a, t) => a + t.cost, 0);
      }
    }
    loss = r2(loss); surplus = r2(surplus);
    if (loss > 0.004) {
      let charges = opts.charges;
      if (charges === undefined && d.charge_user) charges = [{ userId: d.charge_user, amount: loss }];
      if (charges === undefined) {
        throw new StockError('Kamomad chiqdi: kim hisobiga yozilishini tanlang', { needDecision: true, loss, surplus });
      }
      const { list, total } = cleanCharges(db, charges, loss);
      for (const c of list) chargeStaff(db, ctx, c.userId, c.amount, 'inventory', 'Inventarizatsiya kamomadi');
      pnl(db, ctx, 'stock_loss', loss - total);
      if (list.length) db.prepare('UPDATE docs SET meta = ? WHERE id = ?').run(JSON.stringify({ ...meta(d.meta), charges: list }), id);
    }
    pnl(db, ctx, 'stock_surplus', surplus);
    result = { loss, surplus };
  }
  db.prepare("UPDATE docs SET status = 'posted', posted_by = ?, posted_at = ? WHERE id = ?").run(actor, nowIso(), id);
  closeDocAlerts(db, id, actor);
  negativeAlerts(db, ctx);
  return result;
}

// Receiver declines a hand-over: nothing moves, the sender keeps the goods.
export function rejectDoc(db, id, actor, reason) {
  const d = getDoc(db, id);
  if (!d) throw new StockError('Hujjat topilmadi');
  if (d.status !== 'sent') throw new StockError('Faqat qabul kutayotgan topshirishni rad etish mumkin');
  if (!reason) throw new StockError('Sababini yozing');
  db.prepare("UPDATE docs SET status = 'rejected', rejected_by = ?, rejected_at = ?, reject_reason = ? WHERE id = ?").run(actor, nowIso(), String(reason).slice(0, 300), id);
  return getDoc(db, id);
}

// Cancel: a draft or a not-yet-accepted hand-over simply closes; a posted
// document is reversed exactly (stock, staff charges, profit and loss).
export function cancelDoc(db, id, actor, reason) {
  const d = getDoc(db, id);
  if (!d) throw new StockError('Hujjat topilmadi');
  if (d.source === 'shift') throw new StockError('Sut kirimi smenadan avtomatik yaratilgan; uni bekor qilib bo\'lmaydi');
  if (d.source === 'production') throw new StockError('Ishlab chiqarish hujjati topshiriq orqali bekor qilinadi');
  if (d.source === 'prod_shift') throw new StockError('Texnolog smenasi yakunini bekor qilib bo\'lmaydi');
  if (d.status === 'cancelled' || d.status === 'rejected') throw new StockError('Hujjat allaqachon yopilgan');
  if (!reason) throw new StockError('Bekor qilish sababini yozing');
  db.transaction(() => cancelDocTx(db, d, actor, reason))();
  return getDoc(db, id);
}

// Reverse a document inside the caller's transaction (also used by production).
export function cancelDocTx(db, d, actor, reason) {
  const id = d.id;
  {
    if (d.status === 'posted') {
      const ctx = { doc: d, at: nowIso(), touched: new Set() };
      const moves = db.prepare('SELECT * FROM stock_moves WHERE doc_id = ? ORDER BY id').all(id);
      for (const m of moves) {
        insertMove(db, ctx, { lineId: m.line_id, productId: m.product_id, lotId: m.lot_id,
          h: m.warehouse_id ? { warehouseId: m.warehouse_id } : { userId: m.holder_id }, qty: -m.qty, cost: -m.cost, kind: 'reversal' });
      }
      // No lot may end up below zero where that is not allowed (it was already used further down the chain).
      const seen = new Set();
      for (const m of moves) {
        const h = m.warehouse_id ? { warehouseId: m.warehouse_id } : { userId: m.holder_id };
        const key = `${holderKey(h)}:${m.product_id}:${m.lot_id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const [cond, v] = holderCond(h);
        const q = db.prepare(`SELECT ROUND(COALESCE(SUM(qty), 0), 3) AS q FROM stock_moves WHERE ${cond} AND product_id = ? AND lot_id IS ?`).get(v, m.product_id, m.lot_id).q;
        if (q < -EPS && !allowNegative(db, h)) {
          throw new StockError(`Bekor qilib bo'lmaydi: ${productName(db, m.product_id)} "${holderName(db, h)}" dan allaqachon boshqa joyga ketgan`);
        }
      }
      db.prepare(`INSERT INTO party_entries (party_type, party_id, amount, kind, doc_id, note, at)
        SELECT party_type, party_id, -amount, 'reversal', doc_id, 'Bekor qilindi', ? FROM party_entries WHERE doc_id = ? AND kind <> 'reversal'`).run(ctx.at, id);
      db.prepare(`INSERT INTO pnl_entries (category_id, amount, doc_id, note, at)
        SELECT category_id, -amount, doc_id, 'Bekor qilindi', ? FROM pnl_entries WHERE doc_id = ?`).run(ctx.at, id);
      db.prepare(`INSERT INTO cash_entries (cashbox_id, amount, method_id, doc_id, kind, note, at)
        SELECT cashbox_id, -amount, method_id, doc_id, 'reversal', 'Bekor qilindi', ? FROM cash_entries WHERE doc_id = ? AND COALESCE(kind, '') <> 'reversal'`).run(ctx.at, id);
      negativeAlerts(db, ctx);
    }
    closeDocAlerts(db, id, actor);
    db.prepare("UPDATE docs SET status = 'cancelled', cancelled_by = ?, cancelled_at = ?, cancel_reason = ? WHERE id = ?").run(actor, nowIso(), String(reason).slice(0, 300), id);
  }
}

// ---------------------------------------------------------------- milk from shifts
// The warehouse accepted milk goes to: the setting, else the first raw-milk
// warehouse, else one is created.
export function milkWarehouse(db) {
  const set = Number(getSetting(db, 'erp_milk_warehouse'));
  if (set && db.prepare('SELECT 1 FROM warehouses WHERE id = ? AND active = 1').get(set)) return set;
  let w = db.prepare("SELECT id FROM warehouses WHERE kind = 'raw_milk' AND active = 1 ORDER BY sort, id LIMIT 1").get()?.id;
  if (!w) w = Number(db.prepare("INSERT INTO warehouses (name, kind) VALUES ('Sut ombori', 'raw_milk')").run().lastInsertRowid);
  setSetting(db, 'erp_milk_warehouse', w);
  return w;
}

// The warehouse product all collected milk becomes ("Yog'li sut", a main raw material).
export function rawMilkProduct(db) {
  const set = Number(getSetting(db, 'erp_milk_product'));
  if (set && db.prepare('SELECT 1 FROM products WHERE id = ?').get(set)) return set;
  const old = db.prepare("SELECT id FROM products WHERE kind = 'raw_milk' ORDER BY active DESC, id LIMIT 1").get()?.id;
  const id = old ?? Number(db.prepare("INSERT INTO products (name, unit, kind) VALUES ('Yog''li sut', 'kg', 'main_raw')").run().lastInsertRowid);
  if (old) db.prepare("UPDATE products SET kind = 'main_raw' WHERE id = ?").run(old);
  setSetting(db, 'erp_milk_product', id);
  return id;
}

// Called inside the shift-accept transaction. Whatever the collector brought
// (Yog'li sut, Yog'siz sut...) enters "Sut ombori" as ONE product, "Yog'li sut":
// quantity = the accepted (real) quantities added up, cost = what the households are
// owed for this shift. So the unit cost is this shift's real average: a real quantity
// below what was written raises it (the company paid for the full amount), a surplus
// lowers it.
export function receiveShiftMilk(db, shiftId, actor) {
  const s = db.prepare('SELECT sh.*, u.is_test FROM shifts sh JOIN users u ON u.id = sh.employee_id WHERE sh.id = ?').get(shiftId);
  if (!s || s.is_test) return null;
  const uuid = `shift-${s.client_uuid}`;
  if (db.prepare('SELECT 1 FROM docs WHERE uuid = ?').get(uuid)) return null;
  const rows = db.prepare(`SELECT c.product_id, p.name, ROUND(SUM(c.quantity), 3) AS qty, SUM(ROUND(c.quantity * c.price)) AS amount
    FROM collections c JOIN products p ON p.id = c.product_id WHERE c.shift_uuid = ? GROUP BY c.product_id`).all(s.client_uuid);
  const real = new Map(db.prepare('SELECT product_id, real_quantity FROM shift_accepts WHERE shift_id = ?').all(s.id).map((r) => [r.product_id, r.real_quantity]));
  const parts = rows.map((r) => ({ productId: r.product_id, name: r.name, written: r.qty, qty: r3(real.get(r.product_id) ?? r.qty), cost: r2(r.amount ?? 0) }));
  const qty = r3(parts.reduce((a, x) => a + x.qty, 0));
  const cost = r2(parts.reduce((a, x) => a + x.cost, 0));
  if (qty <= EPS) return null;
  const wh = milkWarehouse(db);
  const id = Number(db.prepare(`INSERT INTO docs (uuid, type, number, status, doc_date, to_wh, source, note, created_by)
    VALUES (?, 'milk_in', ?, 'draft', ?, ?, 'shift', ?, ?)`).run(uuid, nextNumber(db, 'milk_in'), nowIso(), wh, `Smena #${s.number}${s.copy_no ? `-${s.copy_no}` : ''}`, actor).lastInsertRowid);
  db.prepare('INSERT INTO doc_lines (doc_id, product_id, qty, unit_cost, meta, sort) VALUES (?, ?, ?, ?, ?, 0)')
    .run(id, rawMilkProduct(db), qty, cost / qty, JSON.stringify({ cost, shiftId: s.id, parts }));
  postDocTx(db, id, actor);
  return id;
}

// ---------------------------------------------------------------- reading
export function docDetail(db, id) {
  const d = getDoc(db, id);
  if (!d) return null;
  const lines = db.prepare(`SELECT dl.*, p.name AS product, p.unit FROM doc_lines dl JOIN products p ON p.id = dl.product_id WHERE dl.doc_id = ? ORDER BY dl.sort, dl.id`).all(id)
    .map((l) => {
      const m = meta(l.meta);
      const cost = db.prepare("SELECT ROUND(SUM(ABS(cost)), 2) AS c FROM stock_moves WHERE line_id = ? AND qty < 0 AND COALESCE(kind, '') NOT IN ('reversal','settle')").get(l.id)?.c
        ?? db.prepare("SELECT ROUND(SUM(cost), 2) AS c FROM stock_moves WHERE line_id = ? AND qty > 0 AND COALESCE(kind, '') NOT IN ('reversal','settle')").get(l.id)?.c;
      return { id: l.id, product_id: l.product_id, product: l.product, unit: l.unit, qty: l.qty, unit_cost: l.unit_cost, expires_at: l.expires_at, book: m.book, diff: m.diff, cost: cost ?? null };
    });
  return {
    ...summarize(db, d),
    lines,
    total_cost: r2(lines.reduce((a, l) => a + (l.cost ?? 0), 0)),
    reason: d.reason_id ? db.prepare('SELECT name FROM stock_reasons WHERE id = ?').get(d.reason_id)?.name : null,
    charge_user_name: d.charge_user ? holderName(db, { userId: d.charge_user }) : null,
    charges: (meta(d.meta).charges ?? []).map((c) => ({ ...c, name: holderName(db, { userId: c.userId }) })),
  };
}

function summarize(db, d) {
  const from = fromOf(d); const to = toOf(d);
  return {
    id: d.id, uuid: d.uuid, type: d.type, type_label: DOC_TYPES[d.type]?.label ?? d.type, number: d.number, label: docLabel(d), status: d.status,
    doc_date: d.doc_date, mode: d.mode, note: d.note, source: d.source,
    from, to, from_name: holderName(db, from), to_name: holderName(db, to),
    created_by: d.created_by, created_at: d.created_at, posted_by: d.posted_by, posted_at: d.posted_at,
    rejected_at: d.rejected_at, reject_reason: d.reject_reason, cancelled_at: d.cancelled_at, cancel_reason: d.cancel_reason,
  };
}

export function listDocs(db, { type, status, holder, from, to, limit = 300 } = {}) {
  const where = []; const args = [];
  if (type) { where.push('type = ?'); args.push(type); }
  if (status) { where.push('status = ?'); args.push(status); }
  if (holder?.warehouseId) { where.push('(from_wh = ? OR to_wh = ?)'); args.push(holder.warehouseId, holder.warehouseId); }
  if (holder?.userId) { where.push('(from_user = ? OR to_user = ? OR created_by_id = ?)'); args.push(holder.userId, holder.userId, holder.userId); }
  if (from) { where.push("date(doc_date, '+5 hours') >= ?"); args.push(from); }
  if (to) { where.push("date(doc_date, '+5 hours') <= ?"); args.push(to); }
  const rows = db.prepare(`SELECT * FROM docs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY doc_date DESC, id DESC LIMIT ?`).all(...args, Math.min(limit, 1000));
  return rows.map((d) => ({
    ...summarize(db, d),
    lines: db.prepare('SELECT COUNT(*) AS n FROM doc_lines WHERE doc_id = ?').get(d.id).n,
    total_cost: r2(db.prepare("SELECT COALESCE(SUM(ABS(cost)), 0) AS c FROM stock_moves WHERE doc_id = ? AND qty < 0 AND COALESCE(kind, '') NOT IN ('reversal','settle')").get(d.id).c
      || db.prepare("SELECT COALESCE(SUM(cost), 0) AS c FROM stock_moves WHERE doc_id = ? AND qty > 0 AND COALESCE(kind, '') NOT IN ('reversal','settle')").get(d.id).c),
  }));
}

// Hand-overs waiting for this user: addressed to them or to a warehouse they keep.
export function inbox(db, userId) {
  const rows = db.prepare(`SELECT * FROM docs WHERE status = 'sent' AND (to_user = ? OR to_wh IN (SELECT warehouse_id FROM warehouse_keepers WHERE user_id = ?))
    ORDER BY doc_date`).all(userId, userId);
  return rows.map((d) => docDetail(db, d.id));
}

// Stock on hand: per holder and product, with value and the nearest expiry.
export function stockReport(db, { holder = null, productId = null, kind = null, includeZero = false } = {}) {
  const where = []; const args = [];
  if (holder?.warehouseId) { where.push('m.warehouse_id = ?'); args.push(holder.warehouseId); }
  if (holder?.userId) { where.push('m.holder_id = ?'); args.push(holder.userId); }
  if (productId) { where.push('m.product_id = ?'); args.push(productId); }
  if (kind) { where.push('p.kind = ?'); args.push(kind); }
  const rows = db.prepare(`
    SELECT m.warehouse_id, m.holder_id, m.product_id, p.name AS product, p.unit, p.kind, p.netto_g, p.brutto_g, p.volume, p.volume_unit,
      ROUND(SUM(m.qty), 3) AS qty, ROUND(SUM(m.cost), 2) AS cost
    FROM stock_moves m JOIN products p ON p.id = m.product_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    GROUP BY m.warehouse_id, m.holder_id, m.product_id
    ${includeZero ? '' : `HAVING ABS(SUM(m.qty)) > ${EPS}`}
    ORDER BY m.warehouse_id IS NULL, m.warehouse_id, m.holder_id, p.name`).all(...args);
  return rows.map((r) => {
    const h = r.warehouse_id ? { warehouseId: r.warehouse_id } : { userId: r.holder_id };
    const lots = lotBalances(db, h, r.product_id).filter((l) => l.qty > EPS);
    const expiries = lots.map((l) => l.expires_at).filter(Boolean).sort();
    return {
      holder: h, holder_name: holderName(db, h), product_id: r.product_id, product: r.product, unit: r.unit, kind: r.kind,
      qty: r.qty, cost: r.cost, unit_cost: r.qty > EPS ? r2(r.cost / r.qty) : null,
      lots: lots.length, nearest_expiry: expiries[0] ?? null,
      provisional: lots.some((l) => l.provisional) || undefined,
      weight_kg: r.netto_g ? r3((r.qty * r.netto_g) / 1000) : null,
      volume: r.volume ? r3(r.qty * r.volume) : null, volume_unit: r.volume_unit,
    };
  });
}

// Lots of one product at one holder (for the detail view).
export function lotReport(db, h, productId) {
  return lotBalances(db, h, productId).map((l) => ({
    lot_id: l.lot_id, number: l.number ?? '—', qty: l.qty, cost: l.cost, unit_cost: l.lot_id ? l.unit_cost : null, provisional: !!l.provisional,
    produced_at: l.produced_at, expires_at: l.expires_at,
  }));
}

// Moves of a product (stock card), newest first.
export function stockCard(db, { productId, holder = null, limit = 300 }) {
  const where = ['m.product_id = ?']; const args = [productId];
  if (holder?.warehouseId) { where.push('m.warehouse_id = ?'); args.push(holder.warehouseId); }
  if (holder?.userId) { where.push('m.holder_id = ?'); args.push(holder.userId); }
  return db.prepare(`SELECT m.*, d.type, d.number, l.number AS lot_number FROM stock_moves m JOIN docs d ON d.id = m.doc_id LEFT JOIN lots l ON l.id = m.lot_id
    WHERE ${where.join(' AND ')} ORDER BY m.at DESC, m.id DESC LIMIT ?`).all(...args, limit)
    .map((m) => {
      const h = m.warehouse_id ? { warehouseId: m.warehouse_id } : { userId: m.holder_id };
      return { id: m.id, at: m.at, doc_id: m.doc_id, doc: docLabel(m), doc_type: DOC_TYPES[m.type]?.label ?? m.type, holder: h, holder_name: holderName(db, h),
        lot: m.lot_number, qty: m.qty, cost: m.cost, kind: m.kind };
    });
}

// Money a staff member owes the company (positive) or is owed (negative), from
// the warehouse side (spills, shortages). Salary comes in a later stage.
export function staffBalance(db, userId) {
  return r2(db.prepare("SELECT COALESCE(SUM(amount), 0) AS a FROM party_entries WHERE party_type = 'staff' AND party_id = ?").get(userId).a);
}
