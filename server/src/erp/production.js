// Production (Yaya 2.0, stage 2): recipes, the technologist's shift, tasks and
// separation. Builds on the stock engine (stock.js): every task is a "production"
// document that takes its inputs from the technologist's hands (FIFO, at lot cost)
// and puts the output lot(s) back in their hands.
//
// Cost rules (see docs/ERP_PLAN.md, section 5):
// - a cooked batch (quyma) costs what its inputs cost; separation splits the input
//   cost: fixed unit cost (capped, e.g. cream), percent, and the rest;
// - boiled milk cannot be weighed, so the milk not accounted for is explained at the
//   end of the shift. Reasons with effect "cost" raise the cost of that shift's
//   outputs, split by the milk each task used (for separation only the "rest"
//   outputs take it); "company" goes to expenses, "staff" to the person's balance.
//   A gain (more milk left than the books say) lowers the cost the same way;
// - until the shift is closed the output lots are provisional; a cost change is
//   passed on to whatever was already made from them (lot_sources);
// - every limit is proportional: set for a base amount, scaled to the real one.
//   Out of range → the task / shift waits for a manager's approval;
// - pour / cap tasks (stage 3) are written per 1 unit: the batch is the number of
//   units. Piece rates (per unit) are part of the cost and become the workers'
//   wages, split equally between everyone who did the task; cancelling the task
//   cancels the wages. The output can go straight on as a hand-over (e.g. to the
//   incubator), which the receiver accepts.
import { randomUUID } from 'node:crypto';
import {
  StockError, addAlert, addIn, cancelDocTx, chargeStaff, getDoc, holderName, insertMove, lastUnitCost, nextNumber, parseHolder, pnl,
  productBalance, r2, r3, rawMilkProduct, takeOut,
} from './stock.js';

export const RECIPE_KINDS = { cook: 'Tayyorlash (quyma)', separation: 'Separatsiya', pour: 'Quyish (idishga)', cap: 'Qopqoq yopish', reprocess: 'Qayta ishlash' };
// Which permission runs which kind of task.
export const KIND_PERM = { cook: 'prod.work', separation: 'prod.work', pour: 'prod.pour', cap: 'prod.cap', reprocess: 'prod.reprocess' };
export const PER_UNIT = new Set(['pour', 'cap', 'reprocess']);

// Reprocessing (stage 5): expected quantity of an output for `units` input units —
// a set amount per unit, or the input's netto weight in kg (e.g. 400 g of content).
export function reprocessExpect(db, r, o, units) {
  const input = product(db, r.product_id);
  const per = o.per_unit ?? (input?.netto_g ? input.netto_g / 1000 : 1);
  return {
    qty: r3(per * units),
    min: o.min_per_unit != null ? r3(o.min_per_unit * units) : null,
    max: o.max_per_unit != null ? r3(o.max_per_unit * units) : null,
  };
}

const EPS = 0.0005;
const nowIso = () => new Date().toISOString();
const J = (v) => (v ? JSON.parse(v) : null);
const product = (db, id) => db.prepare('SELECT * FROM products WHERE id = ?').get(id);

// Weight in kg of a quantity in the product's own unit (for limits and loss shares).
export function weightKg(p, qty) {
  const u = String(p?.unit ?? 'kg').toLowerCase();
  if (u === 'g' || u === 'gramm' || u === 'gr') return qty / 1000;
  if (u === 'dona') return p?.netto_g ? (qty * p.netto_g) / 1000 : 0;
  return qty; // kg, l, litr
}

// ---------------------------------------------------------------- recipes
export function recipeDetail(db, id) {
  const r = db.prepare('SELECT r.*, p.name AS product, p.unit FROM recipes r LEFT JOIN products p ON p.id = r.product_id WHERE r.id = ?').get(id);
  if (!r) return null;
  const lines = db.prepare(`SELECT l.*, p.name AS product, p.unit, p.kind AS product_kind, p.netto_g FROM recipe_lines l JOIN products p ON p.id = l.product_id
    WHERE l.recipe_id = ? ORDER BY l.sort, l.id`).all(id).map((l) => ({
    ...l,
    alts: db.prepare('SELECT a.product_id, a.qty, p.name AS product, p.unit FROM recipe_alts a JOIN products p ON p.id = a.product_id WHERE a.line_id = ?').all(l.id),
  }));
  const outputs = db.prepare(`SELECT o.*, p.name AS product, p.unit FROM recipe_outputs o JOIN products p ON p.id = o.product_id
    WHERE o.recipe_id = ? ORDER BY o.sort, o.id`).all(id);
  const rates = db.prepare('SELECT id, name, amount FROM recipe_rates WHERE recipe_id = ? ORDER BY sort, id').all(id);
  const limits = db.prepare('SELECT id, name, product_ids, out_min, out_max FROM recipe_limits WHERE recipe_id = ? ORDER BY sort, id').all(id)
    .map((x) => {
      const ids = JSON.parse(x.product_ids);
      return { ...x, product_ids: ids, products: ids.map((pid) => product(db, pid)?.name ?? `#${pid}`) };
    });
  const baseWeight = r3(lines.reduce((a, l) => a + weightKg(product(db, l.product_id), l.qty), 0));
  const baseMilk = r3(lines.filter((l) => l.product_kind === 'raw_milk').reduce((a, l) => a + l.qty, 0));
  return { ...r, kind_label: RECIPE_KINDS[r.kind] ?? r.kind, lines, outputs, rates, limits, rate_total: r2(rates.reduce((a, x) => a + x.amount, 0)), base_weight: baseWeight, base_milk: baseMilk };
}

export function listRecipes(db, { all = false, kinds = null } = {}) {
  return db.prepare(`SELECT id, kind FROM recipes ${all ? '' : 'WHERE active = 1'} ORDER BY active DESC, sort, name`).all()
    .filter((r) => !kinds || kinds.includes(r.kind)).map((r) => recipeDetail(db, r.id));
}

const num = (v) => (v == null || v === '' ? null : Number(v));
export function saveRecipe(db, id, b) {
  const name = String(b?.name ?? '').trim().slice(0, 120);
  if (!name) throw new StockError('Tarkib nomini yozing');
  const kind = RECIPE_KINDS[b.kind] ? b.kind : 'cook';
  const productId = num(b.productId);
  if (kind !== 'separation' && !product(db, productId)) throw new StockError('Chiqadigan mahsulotni tanlang');
  const maxMinutes = num(b.maxMinutes);
  // Conditional limits: "when these products are used, the output must be X–Y".
  const limits = (Array.isArray(b.limits) ? b.limits : []).map((x, i) => {
    const ids = [...new Set((Array.isArray(x?.productIds) ? x.productIds : []).map(Number))].filter((pid) => product(db, pid));
    if (!ids.length) throw new StockError(`${i + 1}-shartli limit: qaysi xomashyo ishlatilganda — tanlang`);
    const mn = num(x.outMin); const mx = num(x.outMax);
    if ((mn == null && mx == null) || (mn != null && !(mn >= 0)) || (mx != null && !(mx >= 0)) || (mn != null && mx != null && mn > mx)) {
      throw new StockError(`${i + 1}-shartli limit: chegara noto'g'ri`);
    }
    return { name: x.name ? String(x.name).trim().slice(0, 80) : null, ids, mn, mx };
  });
  if (maxMinutes != null && !(maxMinutes > 0)) throw new StockError('Muddat (daqiqa) musbat bo\'lsin');
  const rates = (Array.isArray(b.rates) ? b.rates : []).filter((x) => String(x?.name ?? '').trim()).map((x) => {
    const amount = Number(x.amount);
    if (!(amount >= 0)) throw new StockError(`${x.name}: ishbay haq noto'g'ri`);
    return { name: String(x.name).trim().slice(0, 60), amount };
  });
  const outMin = num(b.outMin); const outMax = num(b.outMax);
  if ((outMin != null && !(outMin >= 0)) || (outMax != null && !(outMax >= 0)) || (outMin != null && outMax != null && outMin > outMax)) {
    throw new StockError('Chiqish chegarasi noto\'g\'ri (eng kami ≤ eng ko\'pi)');
  }
  // Reprocessing takes the expired product itself: one unit per unit.
  const rawLines = kind === 'reprocess' ? [{ productId, qty: 1 }] : (Array.isArray(b.lines) ? b.lines : []);
  const lines = rawLines.map((l, i) => {
    const p = product(db, num(l.productId));
    if (!p) throw new StockError(`${i + 1}-qator: mahsulot topilmadi`);
    const qty = Number(l.qty);
    if (!(qty > 0)) throw new StockError(`${p.name}: miqdor musbat bo'lsin`);
    const alts = (Array.isArray(l.alts) ? l.alts : []).map((a) => {
      const ap = product(db, num(a.productId));
      if (!ap) throw new StockError(`${p.name}: alternativ mahsulot topilmadi`);
      const aq = num(a.qty);
      if (aq != null && !(aq > 0)) throw new StockError(`${ap.name}: miqdor musbat bo'lsin`);
      return { productId: ap.id, qty: aq };
    });
    return { productId: p.id, qty, alts };
  });
  if (!lines.length) throw new StockError('Kamida bitta xomashyo kiriting');
  const outputs = kind === 'reprocess' ? (Array.isArray(b.outputs) ? b.outputs : []).map((o) => {
    const p = product(db, num(o.productId));
    if (!p) throw new StockError('Chiqadigan mahsulot topilmadi');
    const value = num(o.costValue) ?? 0;
    if (!(value >= 0)) throw new StockError(`${p.name}: tannarx manfiy bo'lmasin`);
    const per = num(o.perUnit); const mn = num(o.minPerUnit); const mx = num(o.maxPerUnit);
    if ((per != null && !(per > 0)) || (mn != null && !(mn >= 0)) || (mx != null && !(mx >= 0)) || (mn != null && mx != null && mn > mx)) {
      throw new StockError(`${p.name}: miqdor yoki chegara noto'g'ri`);
    }
    return { productId: p.id, mode: 'fixed', value, perUnit: per, minPerUnit: mn, maxPerUnit: mx, container: !!o.isContainer };
  }) : kind === 'separation' ? (Array.isArray(b.outputs) ? b.outputs : []).map((o) => {
    const p = product(db, num(o.productId));
    if (!p) throw new StockError('Chiqadigan mahsulot topilmadi');
    const mode = ['fixed', 'percent', 'rest'].includes(o.costMode) ? o.costMode : 'rest';
    const value = num(o.costValue);
    if (mode !== 'rest' && !(value >= 0)) throw new StockError(`${p.name}: tannarx qiymatini kiriting`);
    if (mode === 'percent' && value > 100) throw new StockError(`${p.name}: foiz 100 dan oshmasin`);
    return { productId: p.id, mode, value: mode === 'rest' ? null : value };
  }) : [];
  if (kind === 'reprocess') {
    if (!outputs.length) throw new StockError('Nima chiqishini kiriting');
    if (outputs.filter((o) => o.container).length > 1) throw new StockError('Faqat bitta mahsulot "idish" bo\'lishi mumkin');
  }
  if (kind === 'separation') {
    if (outputs.length < 2) throw new StockError('Separatsiyada kamida ikkita chiqadigan mahsulot bo\'ladi');
    if (!outputs.some((o) => o.mode === 'rest')) throw new StockError('Bitta mahsulot "qolgan tannarx" bo\'lishi kerak (qolgan xarajat unga tushadi)');
  }
  return db.transaction(() => {
    let rid = id;
    if (rid) {
      if (!db.prepare('SELECT 1 FROM recipes WHERE id = ?').get(rid)) throw new StockError('Tarkib topilmadi');
      db.prepare('UPDATE recipes SET name = ?, kind = ?, product_id = ?, out_min = ?, out_max = ?, max_minutes = ?, note = ?, active = COALESCE(?, active), sort = COALESCE(?, sort) WHERE id = ?')
        .run(name, kind, kind !== 'separation' ? productId : null, outMin, outMax, maxMinutes, b.note ?? null, b.active == null ? null : Number(!!b.active), num(b.sort), rid);
      db.prepare('DELETE FROM recipe_lines WHERE recipe_id = ?').run(rid);
      db.prepare('DELETE FROM recipe_outputs WHERE recipe_id = ?').run(rid);
      db.prepare('DELETE FROM recipe_rates WHERE recipe_id = ?').run(rid);
      db.prepare('DELETE FROM recipe_limits WHERE recipe_id = ?').run(rid);
    } else {
      rid = Number(db.prepare('INSERT INTO recipes (name, kind, product_id, out_min, out_max, max_minutes, note, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(name, kind, kind !== 'separation' ? productId : null, outMin, outMax, maxMinutes, b.note ?? null, num(b.sort) ?? 0).lastInsertRowid);
    }
    const insR = db.prepare('INSERT INTO recipe_rates (recipe_id, name, amount, sort) VALUES (?, ?, ?, ?)');
    rates.forEach((x, i) => insR.run(rid, x.name, x.amount, i));
    const insLim = db.prepare('INSERT INTO recipe_limits (recipe_id, name, product_ids, out_min, out_max, sort) VALUES (?, ?, ?, ?, ?, ?)');
    limits.forEach((x, i) => insLim.run(rid, x.name, JSON.stringify(x.ids), x.mn, x.mx, i));
    const insL = db.prepare('INSERT INTO recipe_lines (recipe_id, product_id, qty, sort) VALUES (?, ?, ?, ?)');
    const insA = db.prepare('INSERT OR IGNORE INTO recipe_alts (line_id, product_id, qty) VALUES (?, ?, ?)');
    lines.forEach((l, i) => {
      const lid = Number(insL.run(rid, l.productId, l.qty, i).lastInsertRowid);
      for (const a of l.alts) insA.run(lid, a.productId, a.qty);
    });
    const insO = db.prepare('INSERT INTO recipe_outputs (recipe_id, product_id, cost_mode, cost_value, sort, per_unit, min_per_unit, max_per_unit, is_container) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    outputs.forEach((o, i) => insO.run(rid, o.productId, o.mode, o.value, i, o.perUnit ?? null, o.minPerUnit ?? null, o.maxPerUnit ?? null, o.container ? 1 : 0));
    return rid;
  })();
}

// ---------------------------------------------------------------- shifts
const getShift = (db, id) => db.prepare('SELECT * FROM prod_shifts WHERE id = ?').get(id);
export const myShift = (db, userId) => db.prepare("SELECT * FROM prod_shifts WHERE user_id = ? AND status IN ('open','approval') ORDER BY id DESC LIMIT 1").get(userId) ?? null;

export function openShift(db, { uuid, userId }) {
  const u = String(uuid || randomUUID()).slice(0, 80);
  const ex = db.prepare('SELECT * FROM prod_shifts WHERE uuid = ?').get(u);
  if (ex) return ex;
  if (myShift(db, userId)) throw new StockError('Sizda ochiq smena bor');
  const n = db.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM prod_shifts').get().n;
  const id = Number(db.prepare('INSERT INTO prod_shifts (uuid, number, user_id, opened_at) VALUES (?, ?, ?, ?)').run(u, n, userId, nowIso()).lastInsertRowid);
  return getShift(db, id);
}

// Milk at the end of a shift: what is in the technologist's hands, and what the
// tasks used (by recipe). The difference is what the close has to explain.
export function shiftMilk(db, shift) {
  const milkId = rawMilkProduct(db);
  const used = r3(db.prepare("SELECT COALESCE(SUM(milk_qty), 0) AS q FROM prod_tasks WHERE shift_id = ? AND status = 'done'").get(shift.id).q);
  return { product_id: milkId, product: product(db, milkId).name, in_hands: productBalance(db, { userId: shift.user_id }, milkId), used };
}

function taskRow(db, t) {
  const plan = J(t.plan) ?? {};
  const result = J(t.result);
  if (result?.outputs) result.outputs = result.outputs.map((o) => ({ ...o, product: product(db, o.productId)?.name, unit: product(db, o.productId)?.unit }));
  const recipe = t.recipe_id ? db.prepare('SELECT name FROM recipes WHERE id = ?').get(t.recipe_id)?.name : null;
  const outputs = t.doc_id ? db.prepare(`SELECT dl.product_id, p.name AS product, p.unit, dl.qty, dl.meta FROM doc_lines dl JOIN products p ON p.id = dl.product_id
    WHERE dl.doc_id = ? ORDER BY dl.sort`).all(t.doc_id).filter((l) => J(l.meta)?.role === 'out').map((l) => {
    const lot = db.prepare("SELECT l.id, l.unit_cost, l.provisional FROM lots l WHERE l.doc_id = ? AND l.product_id = ? ORDER BY l.id LIMIT 1").get(t.doc_id, l.product_id);
    return { product_id: l.product_id, product: l.product, unit: l.unit, qty: l.qty, unit_cost: lot?.unit_cost ?? null, cost: lot ? r2(lot.unit_cost * l.qty) : null, provisional: !!lot?.provisional };
  }) : [];
  return {
    id: t.id, uuid: t.uuid, number: t.number, label: `TQ-${t.number}`, shift_id: t.shift_id, recipe_id: t.recipe_id, recipe, kind: t.kind, status: t.status,
    factor: plan.factor ?? 1, plan: (plan.lines ?? []).map((l) => ({ ...l, product: product(db, l.productId)?.name, unit: product(db, l.productId)?.unit })),
    result, outputs, milk_qty: t.milk_qty, doc_id: t.doc_id, created_at: t.created_at, done_at: t.done_at,
    workers: (result?.workers ?? []).map((id) => ({ id, name: holderName(db, { userId: id }) })),
    wages: t.doc_id ? db.prepare("SELECT party_id AS user_id, -SUM(amount) AS amount FROM party_entries WHERE doc_id = ? GROUP BY party_id").all(t.doc_id)
      .filter((w) => Math.abs(w.amount) >= 0.005).map((w) => ({ ...w, name: holderName(db, { userId: w.user_id }) })) : [],
    send_to: result?.sendTo ? holderName(db, result.sendTo) : null,
    approval_note: t.approval_note, approved_by: t.approved_by, cancel_reason: t.cancel_reason,
  };
}

export function shiftDetail(db, id) {
  const s = getShift(db, id);
  if (!s) return null;
  const tasks = db.prepare('SELECT * FROM prod_tasks WHERE shift_id = ? ORDER BY id').all(id).map((t) => taskRow(db, t));
  return {
    ...s, label: `TS-${s.number}`, user_name: holderName(db, { userId: s.user_id }), close_data: J(s.close_data),
    milk: shiftMilk(db, s), tasks,
  };
}

export function listShifts(db, { status, from, to, userId } = {}) {
  const where = []; const args = [];
  if (status) { where.push('status = ?'); args.push(status); }
  if (userId) { where.push('user_id = ?'); args.push(userId); }
  if (from) { where.push("date(opened_at, '+5 hours') >= ?"); args.push(from); }
  if (to) { where.push("date(opened_at, '+5 hours') <= ?"); args.push(to); }
  return db.prepare(`SELECT * FROM prod_shifts ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT 300`).all(...args).map((s) => ({
    ...s, label: `TS-${s.number}`, user_name: holderName(db, { userId: s.user_id }), close_data: J(s.close_data),
    tasks: db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(milk_qty), 0) AS milk FROM prod_tasks WHERE shift_id = ? AND status = 'done'").get(s.id),
  }));
}

// ---------------------------------------------------------------- tasks
const getTask = (db, id) => db.prepare('SELECT * FROM prod_tasks WHERE id = ?').get(id);
export const taskDetail = (db, id) => { const t = getTask(db, id); return t ? taskRow(db, t) : null; };

// A task starts from a recipe: lines scaled by factor (or by the milk to use);
// any line may be changed for this batch, or swapped for one of its alternatives.
export function createTask(db, { uuid, shiftId, recipeId, factor, milkQty, units, lines }, { actor, allowedKinds = null }) {
  const u = String(uuid || randomUUID()).slice(0, 80);
  const ex = db.prepare('SELECT * FROM prod_tasks WHERE uuid = ?').get(u);
  if (ex) return ex;
  const s = getShift(db, shiftId);
  if (!s || s.status !== 'open') throw new StockError('Smena ochiq emas');
  const r = recipeDetail(db, Number(recipeId));
  if (!r || !r.active) throw new StockError('Tarkib topilmadi');
  if (allowedKinds && !allowedKinds.includes(r.kind)) throw new StockError('Bu turdagi topshiriq uchun ruxsatingiz yo\'q');
  let f = Number(factor) || 1;
  if (PER_UNIT.has(r.kind) && units != null) f = Number(units);
  if (milkQty != null && milkQty !== '' && !PER_UNIT.has(r.kind)) {
    if (!(r.base_milk > 0)) throw new StockError('Bu tarkibda xom sut yo\'q; miqdorni koeffitsiyent bilan bering');
    f = Number(milkQty) / r.base_milk;
  }
  if (!(f > 0)) throw new StockError('Miqdor noto\'g\'ri');
  const over = new Map((Array.isArray(lines) ? lines : []).map((l) => [Number(l.lineId), l]));
  const planLines = r.lines.map((l) => {
    const o = over.get(l.id);
    const pid = o?.productId ? Number(o.productId) : l.product_id;
    const alt = l.alts.find((a) => a.product_id === pid);
    if (pid !== l.product_id && !alt) throw new StockError(`${l.product}: faqat tarkibdagi alternativlardan biri tanlanadi`);
    const baseQty = alt?.qty ?? l.qty;
    const qty = o?.qty != null && o.qty !== '' ? r3(o.qty) : r3(baseQty * f);
    if (!(qty >= 0)) throw new StockError(`${l.product}: miqdor noto'g'ri`);
    return { lineId: l.id, productId: pid, qty };
  });
  const n = db.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM prod_tasks').get().n;
  const id = Number(db.prepare('INSERT INTO prod_tasks (uuid, number, shift_id, recipe_id, kind, plan, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(u, n, s.id, r.id, r.kind, JSON.stringify({ factor: r3(f), lines: planLines }), actor).lastInsertRowid);
  return getTask(db, id);
}

// Allowed output weight for a batch: the recipe range scaled by input weight.
// A conditional limit applies when all its products are among the inputs; with
// several, the most specific (most products) wins. Otherwise the recipe's own range.
export function matchingLimit(r, inputs) {
  const used = new Set(inputs.filter((l) => l.qty > 0).map((l) => Number(l.productId)));
  return (r.limits ?? []).filter((x) => x.product_ids.every((pid) => used.has(pid))).sort((a, b) => b.product_ids.length - a.product_ids.length)[0] ?? null;
}
export function outputRange(db, r, inputs) {
  const rule = matchingLimit(r, inputs);
  const min = rule ? rule.out_min : r.out_min;
  const max = rule ? rule.out_max : r.out_max;
  if (min == null && max == null) return null;
  const inWeight = inputs.reduce((a, l) => a + weightKg(product(db, l.productId), l.qty), 0);
  const scale = r.base_weight > 0 ? inWeight / r.base_weight : 1;
  return { min: min == null ? null : r3(min * scale), max: max == null ? null : r3(max * scale), scale: r3(scale), rule: rule ? (rule.name || rule.products.join(' + ')) : null };
}

function cleanQtyLines(db, lines, what) {
  if (!Array.isArray(lines) || !lines.length) throw new StockError(`${what}: kamida bitta qator`);
  return lines.map((l) => {
    const p = product(db, Number(l.productId));
    if (!p) throw new StockError(`${what}: mahsulot topilmadi`);
    const qty = r3(l.qty);
    if (!(qty >= 0)) throw new StockError(`${p.name}: miqdor noto'g'ri`);
    return { productId: p.id, qty };
  }).filter((l) => l.qty > 0);
}

// Finish a task: actual inputs (default: the plan) and the weighed output(s).
// Out of the scaled range → it waits for a manager (unless approve is set).
export function completeTask(db, taskId, body, { actor, approve = false }) {
  return db.transaction(() => {
    const t = getTask(db, taskId);
    if (!t) throw new StockError('Topshiriq topilmadi');
    if (t.status === 'done') return { task: taskRow(db, t) };
    const okStatus = approve ? t.status === 'approval' : t.status === 'open';
    if (!okStatus) throw new StockError(t.status === 'approval' ? 'Topshiriq rahbar tasdig\'ini kutmoqda' : 'Topshiriq yopiq');
    const s = getShift(db, t.shift_id);
    if (s.status !== 'open') throw new StockError('Smena ochiq emas');
    const b = approve ? J(t.result) : body;
    const r = recipeDetail(db, t.recipe_id);
    const plan = J(t.plan);
    const inputs = cleanQtyLines(db, b?.lines ?? plan.lines, 'Xomashyo');
    let outputs;
    let shortfall = [];
    let outsideOut = null;
    if (r.kind === 'reprocess') {
      const units = r3(inputs.reduce((a, l) => a + l.qty, 0));
      const given = new Map((b?.outputs ?? []).map((o) => [Number(o.productId), o.qty == null || o.qty === '' ? null : r3(o.qty)]));
      outputs = r.outputs.map((o) => {
        const e = reprocessExpect(db, r, o, units);
        const qty = given.get(o.product_id) ?? e.qty;
        if (!(qty >= 0)) throw new StockError(`${o.product}: miqdor noto'g'ri`);
        if (o.is_container && qty > e.qty + EPS) throw new StockError(`${o.product}: ${e.qty} tadan ko'p bo'lmaydi`);
        if (!o.is_container && ((e.min != null && qty < e.min - EPS) || (e.max != null && qty > e.max + EPS))) outsideOut ??= { product: o.product, qty, min: e.min, max: e.max };
        return { productId: o.product_id, qty, mode: 'fixed', value: o.cost_value ?? 0, container: !!o.is_container, expected: e.qty };
      });
      // Containers that did not come out must be explained (broken / lost, can be split).
      const box = outputs.find((o) => o.container);
      const missing = box ? r3(box.expected - box.qty) : 0;
      shortfall = (Array.isArray(b?.shortfall) ? b.shortfall : []).map((x) => {
        const reason = db.prepare("SELECT * FROM stock_reasons WHERE id = ? AND section = 'reprocess' AND active = 1").get(Number(x.reasonId));
        if (!reason) throw new StockError('Idish sababi topilmadi');
        return { reason, qty: r3(x.qty) };
      }).filter((x) => x.qty > 0);
      const told = r3(shortfall.reduce((a, x) => a + x.qty, 0));
      if (Math.abs(told - missing) > EPS) {
        throw new StockError(`${box ? box.expected : 0} ta chiqishi kerak edi, ${box ? box.qty : 0} ta kiritdingiz — qolgan ${missing} tasi nima bo'ldi?`, { missing, told });
      }
    } else if (r.kind !== 'separation') {
      const q = r3(b?.outputQty ?? b?.outputs?.[0]?.qty ?? (PER_UNIT.has(r.kind) ? plan.factor : null));
      if (!(q > 0)) throw new StockError(PER_UNIT.has(r.kind) ? 'Nechta chiqqanini kiriting' : 'Chiqqan mahsulot og\'irligini kiriting');
      outputs = [{ productId: r.product_id, qty: q, mode: 'rest' }];
    } else {
      const given = new Map((b?.outputs ?? []).map((o) => [Number(o.productId), r3(o.qty)]));
      outputs = r.outputs.map((o) => ({ productId: o.product_id, qty: given.get(o.product_id) ?? 0, mode: o.cost_mode, value: o.cost_value }));
      if (!outputs.some((o) => o.qty > 0)) throw new StockError('Chiqqan mahsulotlar miqdorini kiriting');
    }
    const range = outputRange(db, r, inputs);
    const outWeight = r3(outputs.reduce((a, o) => a + weightKg(product(db, o.productId), o.qty), 0));
    const outside = (r.kind !== 'reprocess' && range && ((range.min != null && outWeight < range.min - EPS) || (range.max != null && outWeight > range.max + EPS))) || !!outsideOut;
    // Who did it: everyone listed shares the piece rate equally (default: the shift owner).
    const workers = [...new Set((Array.isArray(b?.workers) && b.workers.length ? b.workers : [s.user_id]).map(Number))];
    for (const w of workers) if (!db.prepare('SELECT 1 FROM users WHERE id = ? AND active = 1').get(w)) throw new StockError('Xodim topilmadi');
    let sendTo = null;
    if (b?.sendTo) {
      sendTo = parseHolder(db, b.sendTo);
      if (!sendTo) throw new StockError('Qayerga topshirilishini tanlang');
      if (sendTo.userId === s.user_id) sendTo = null;
    }
    const stored = { lines: inputs, outputs: outputs.map((o) => ({ productId: o.productId, qty: o.qty })), outputQty: !['separation', 'reprocess'].includes(r.kind) ? outputs[0].qty : undefined,
      shortfall: shortfall.map((x) => ({ reasonId: x.reason.id, reason: x.reason.name, qty: x.qty })), workers, sendTo, note: b?.note ?? null };
    if (outside && !approve) {
      db.prepare("UPDATE prod_tasks SET status = 'approval', result = ? WHERE id = ?").run(JSON.stringify({ ...stored, range: outsideOut ?? range, outWeight }), t.id);
      addAlert(db, 'prod.limit', outsideOut
        ? `TQ-${t.number} (${r.name}): ${outsideOut.product} ${outsideOut.qty}, ruxsat ${outsideOut.min ?? '—'}–${outsideOut.max ?? '—'}. Tasdiqlang yoki rad eting.`
        : `TQ-${t.number} (${r.name}): chiqish ${outWeight} kg, ruxsat ${range.min ?? '—'}–${range.max ?? '—'} kg${range.rule ? ` (shartli limit: ${range.rule})` : ''}. Tasdiqlang yoki rad eting.`,
        { taskId: t.id, shiftId: s.id });
      return { needApproval: true, range: outsideOut ? { min: outsideOut.min, max: outsideOut.max } : range, outWeight, task: taskRow(db, getTask(db, t.id)) };
    }
    const docId = postProduction(db, t, s, r, inputs, outputs, actor, b?.note, workers, shortfall);
    if (sendTo) {
      // Straight on to the next step (incubator, finished goods, next worker): a hand-over they accept.
      stored.transferId = Number(db.prepare(`INSERT INTO docs (uuid, type, number, status, doc_date, from_user, to_wh, to_user, note, created_by, created_by_id)
        VALUES (?, 'transfer', ?, 'sent', ?, ?, ?, ?, ?, ?, ?)`).run(`task-send-${t.uuid}`, nextNumber(db, 'transfer'), nowIso(), s.user_id, sendTo.warehouseId ?? null,
        sendTo.userId ?? null, `TQ-${t.number}: ${r.name}`, actor, s.user_id).lastInsertRowid);
      const ins = db.prepare('INSERT INTO doc_lines (doc_id, product_id, qty, sort) VALUES (?, ?, ?, ?)');
      outputs.filter((o) => o.qty > 0).forEach((o, i) => ins.run(stored.transferId, o.productId, o.qty, i));
    }
    void docId;
    db.prepare("UPDATE prod_tasks SET status = 'done', result = ?, done_at = ? WHERE id = ?").run(JSON.stringify({ ...stored, range, outWeight }), nowIso(), t.id);
    if (approve) closeAlerts(db, 'taskId', t.id, actor);
    return { task: taskRow(db, getTask(db, t.id)) };
  })();
}

function postProduction(db, t, s, r, inputs, outputs, actor, note, workers = [s.user_id], shortfall = []) {
  const h = { userId: s.user_id };
  const id = Number(db.prepare(`INSERT INTO docs (uuid, type, number, status, doc_date, from_user, to_user, source, note, created_by)
    VALUES (?, 'production', ?, 'draft', ?, ?, ?, 'production', ?, ?)`).run(`task-${t.uuid}`, nextNumber(db, 'production'), nowIso(), s.user_id, s.user_id,
    `TQ-${t.number}: ${r.name}${note ? ` — ${String(note).slice(0, 200)}` : ''}`, actor).lastInsertRowid);
  const doc = getDoc(db, id);
  const ctx = { doc, at: nowIso(), touched: new Set() };
  const insLine = db.prepare('INSERT INTO doc_lines (doc_id, product_id, qty, meta, sort) VALUES (?, ?, ?, ?, ?)');
  let total = 0; let milk = 0; const taken = [];
  inputs.forEach((l, i) => {
    const lid = Number(insLine.run(id, l.productId, l.qty, JSON.stringify({ role: 'in' }), i).lastInsertRowid);
    for (const x of takeOut(db, ctx, { productId: l.productId, h, qty: l.qty, lineId: lid, kind: 'consume' })) { total += x.cost; taken.push(x); }
    if (product(db, l.productId).kind === 'raw_milk') milk += l.qty;
  });
  // Piece rates: part of the cost, owed to the workers (split equally).
  if (r.kind !== 'separation' && r.rates.length) {
    const units = r.kind === 'reprocess' ? inputs.reduce((a, l) => a + l.qty, 0) : outputs.reduce((a, o) => a + o.qty, 0);
    const wage = r2(r.rate_total * units);
    if (wage > 0) {
      total += wage;
      let left = wage;
      workers.forEach((w, i) => {
        const share = i === workers.length - 1 ? r2(left) : r2(wage / workers.length);
        left -= share;
        chargeStaff(db, ctx, w, -share, 'piece', `TQ-${t.number}: ${r.rates.map((x) => x.name).join(', ')} (${r3(units)} × ${r.rate_total}${workers.length > 1 ? ` ÷ ${workers.length}` : ''})`);
      });
    }
  }
  total = r2(total);
  // Cost of each output.
  const costs = new Map();
  const fixed = outputs.filter((o) => o.mode === 'fixed').reduce((a, o) => { const c = r2(o.qty * o.value); costs.set(o.productId, c); return a + c; }, 0);
  const pct = outputs.filter((o) => o.mode === 'percent').reduce((a, o) => { const c = r2((total * o.value) / 100); costs.set(o.productId, c); return a + c; }, 0);
  const restOuts = outputs.filter((o) => o.mode === 'rest' && o.qty > 0);
  const rest = r2(total - fixed - pct);
  const restQty = restOuts.reduce((a, o) => a + o.qty, 0);
  let left = Math.max(0, rest);
  restOuts.forEach((o, i) => {
    const c = i === restOuts.length - 1 ? r2(left) : r2((Math.max(0, rest) * o.qty) / restQty);
    left -= c; costs.set(o.productId, c);
  });
  if (r.kind === 'reprocess') {
    // Containers that did not come out: first made at their fixed cost, then written
    // off by reason (company expense or the worker's debt). The rest of the input cost
    // (the spoiled content) is the reprocessing loss; if outputs are worth more, a variance.
    const box = outputs.find((o) => o.container);
    let lost = 0;
    for (const x of shortfall) {
      const c = r2(x.qty * (box?.value ?? 0));
      lost += c;
      const effect = x.reason.effect ?? (x.reason.charge === 'staff' ? 'staff' : 'company');
      if (effect === 'staff') chargeStaff(db, ctx, s.user_id, c, 'reprocess', `TQ-${t.number}: idish ${x.reason.name}`);
      else pnl(db, ctx, x.reason.category_id ?? 'container_loss', c, `TQ-${t.number}: idish ${x.reason.name} (${x.qty})`);
    }
    const left2 = r2(rest - lost);
    pnl(db, ctx, left2 >= 0 ? 'reprocess_loss' : 'cost_variance', left2, `TQ-${t.number}: ${r.name}`);
  } else if (rest < 0 || !restOuts.length) {
    // Fixed outputs worth more than the whole batch: the gap is a cost variance.
    pnl(db, ctx, 'cost_variance', rest, `${r.name}: tannarx taqsimoti farqi`);
  }
  const outQty = outputs.reduce((a, o) => a + o.qty, 0);
  // Final only when the shift that made it closes; a pour from a finished quyma is final already.
  const provisional = !PER_UNIT.has(r.kind) || taken.some((x) => x.lotId && db.prepare('SELECT provisional FROM lots WHERE id = ?').get(x.lotId)?.provisional);
  outputs.filter((o) => o.qty > 0).forEach((o, i) => {
    const lid = Number(insLine.run(id, o.productId, o.qty, JSON.stringify({ role: 'out', mode: o.mode }), 100 + i).lastInsertRowid);
    const c = costs.get(o.productId) ?? 0;
    const lot = addIn(db, ctx, { productId: o.productId, h, qty: o.qty, cost: c, lineId: lid, kind: 'produce',
      lot: { unitCost: c / o.qty, seq: i + 1, provisional: provisional ? 1 : 0, shiftId: s.id } });
    const share = o.qty / outQty;
    const ins = db.prepare('INSERT INTO lot_sources (lot_id, source_lot_id, qty, doc_id) VALUES (?, ?, ?, ?)');
    for (const x of taken) if (x.lotId) ins.run(lot, x.lotId, r3(x.qty * share), id);
  });
  db.prepare("UPDATE docs SET status = 'posted', posted_by = ?, posted_at = ? WHERE id = ?").run(actor, nowIso(), id);
  db.prepare('UPDATE prod_tasks SET doc_id = ?, milk_qty = ? WHERE id = ?').run(id, r3(milk), t.id);
  return id;
}

export function rejectTaskApproval(db, taskId, actor, note) {
  const t = getTask(db, taskId);
  if (!t || t.status !== 'approval') throw new StockError('Tasdiq kutayotgan topshiriq emas');
  if (!note) throw new StockError('Sababini yozing');
  db.prepare("UPDATE prod_tasks SET status = 'open', approval_note = ?, approved_by = ? WHERE id = ?").run(String(note).slice(0, 300), actor, t.id);
  closeAlerts(db, 'taskId', t.id, actor);
  return taskDetail(db, t.id);
}

export function approveTask(db, taskId, actor, note) {
  const t = getTask(db, taskId);
  if (!t || t.status !== 'approval') throw new StockError('Tasdiq kutayotgan topshiriq emas');
  db.prepare('UPDATE prod_tasks SET approval_note = ?, approved_by = ? WHERE id = ?').run(note ? String(note).slice(0, 300) : null, actor, t.id);
  return completeTask(db, t.id, null, { actor, approve: true });
}

// Cancel a task: an unfinished one just closes; a finished one is reversed while
// its shift is still open and nothing made from it has moved on.
export function cancelTask(db, taskId, actor, reason) {
  if (!reason) throw new StockError('Bekor qilish sababini yozing');
  return db.transaction(() => {
    const t = getTask(db, taskId);
    if (!t) throw new StockError('Topshiriq topilmadi');
    if (t.status === 'cancelled') throw new StockError('Topshiriq allaqachon bekor qilingan');
    if (t.status === 'done') {
      if (getShift(db, t.shift_id).status !== 'open') throw new StockError('Smena yopilgan; topshiriqni bekor qilib bo\'lmaydi');
      if (db.prepare('SELECT 1 FROM lot_sources ls JOIN lots l ON l.id = ls.source_lot_id WHERE l.doc_id = ? LIMIT 1').get(t.doc_id)) {
        throw new StockError('Bu topshiriqdan chiqqan mahsulot keyingi ishlab chiqarishda ishlatilgan');
      }
      const sent = J(t.result)?.transferId ? getDoc(db, J(t.result).transferId) : null;
      if (sent?.status === 'posted') throw new StockError('Mahsulot keyingi bosqichda qabul qilingan; avval u yerdan qaytaring');
      if (sent?.status === 'sent') db.prepare("UPDATE docs SET status = 'cancelled', cancelled_by = ?, cancelled_at = ?, cancel_reason = ? WHERE id = ?").run(actor, nowIso(), 'Topshiriq bekor qilindi', sent.id);
      cancelDocTx(db, getDoc(db, t.doc_id), actor, reason);
      db.prepare('DELETE FROM lot_sources WHERE doc_id = ?').run(t.doc_id);
    }
    db.prepare("UPDATE prod_tasks SET status = 'cancelled', cancel_reason = ?, milk_qty = 0 WHERE id = ?").run(String(reason).slice(0, 300), t.id);
    closeAlerts(db, 'taskId', t.id, actor);
    return taskDetail(db, t.id);
  })();
}

function closeAlerts(db, key, id, actor) {
  db.prepare(`UPDATE alerts SET resolved_at = datetime('now'), resolved_by = ? WHERE type = 'prod.limit' AND resolved_at IS NULL
    AND json_extract(payload, '$.${key}') = ?`).run(actor, id);
}

// ---------------------------------------------------------------- cost spread
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

// Spread an amount over the shift's finished tasks by the milk each used; within a
// task, over its "rest" outputs by quantity (fixed-cost outputs like cream keep their cost).
function spreadOverShift(db, ctx, shift, amount) {
  if (Math.abs(amount) < 0.005) return;
  const tasks = db.prepare("SELECT * FROM prod_tasks WHERE shift_id = ? AND status = 'done' AND milk_qty > 0").all(shift.id);
  const milk = tasks.reduce((a, t) => a + t.milk_qty, 0);
  if (!(milk > 0)) { pnl(db, ctx, 'production_loss', amount, `TS-${shift.number}: sut yo'qotishi (topshiriqsiz)`); return; }
  let left = amount;
  tasks.forEach((t, i) => {
    const share = i === tasks.length - 1 ? r2(left) : r2((amount * t.milk_qty) / milk);
    left -= share;
    const outs = db.prepare(`SELECT l.id, l.qty0, dl.meta FROM lots l JOIN doc_lines dl ON dl.doc_id = l.doc_id AND dl.product_id = l.product_id
      WHERE l.doc_id = ? ORDER BY l.id`).all(t.doc_id).filter((o) => (J(o.meta)?.mode ?? 'rest') === 'rest' && J(o.meta)?.role === 'out');
    const q = outs.reduce((a, o) => a + (o.qty0 ?? 0), 0);
    if (!outs.length || !(q > 0)) { pnl(db, ctx, 'production_loss', share, `TQ-${t.number}`); return; }
    let l2 = share;
    outs.forEach((o, j) => {
      const c = j === outs.length - 1 ? r2(l2) : r2((share * o.qty0) / q);
      l2 -= c;
      revalueLot(db, ctx, o.id, c);
    });
  });
}

// ---------------------------------------------------------------- closing a shift
// returned: milk handed back to a warehouse (a normal hand-over the keeper accepts);
// losses: [{ reasonId, qty }] explaining the rest. More left than the books say is a gain.
export function closeShift(db, shiftId, body, { actor, approve = false }) {
  return db.transaction(() => {
    const s = getShift(db, shiftId);
    if (!s) throw new StockError('Smena topilmadi');
    const okStatus = approve ? s.status === 'approval' : s.status === 'open';
    if (!okStatus) throw new StockError(s.status === 'approval' ? 'Smena rahbar tasdig\'ini kutmoqda' : 'Smena yopilgan');
    const b = approve ? J(s.close_data) : (body ?? {});
    if (db.prepare("SELECT 1 FROM prod_tasks WHERE shift_id = ? AND status IN ('open','approval')").get(s.id)) {
      throw new StockError('Avval ochiq topshiriqlarni yakunlang yoki bekor qiling');
    }
    const milk = shiftMilk(db, s);
    const returned = r3(b.returned ?? 0);
    if (!(returned >= 0)) throw new StockError('Qaytarilgan miqdor noto\'g\'ri');
    const returnTo = Number(b.returnTo?.warehouseId ?? b.returnTo);
    if (returned > 0 && !db.prepare('SELECT 1 FROM warehouses WHERE id = ? AND active = 1').get(returnTo)) throw new StockError('Sut qaysi omborga qaytishini tanlang');
    const losses = (Array.isArray(b.losses) ? b.losses : []).map((l) => {
      const reason = db.prepare("SELECT * FROM stock_reasons WHERE id = ? AND section = 'tech' AND active = 1").get(Number(l.reasonId));
      if (!reason) throw new StockError('Yo\'qotish sababi topilmadi');
      const qty = r3(l.qty);
      if (!(qty >= 0)) throw new StockError(`${reason.name}: miqdor noto'g'ri`);
      return { reason, qty };
    }).filter((l) => l.qty > 0);
    const lossSum = r3(losses.reduce((a, l) => a + l.qty, 0));
    const diff = r3(milk.in_hands - returned - lossSum);
    if (diff > EPS) throw new StockError(`${diff} kg sut hisobsiz qoldi — qayerga ketganini kiriting`, { unexplained: diff, inHands: milk.in_hands, used: milk.used });
    const gain = diff < -EPS ? -diff : 0;
    // Proportional limits: limit_qty per limit_base kg of milk used.
    const over = losses.filter((l) => l.reason.limit_qty != null && l.reason.limit_base > 0)
      .map((l) => ({ reason: l.reason.name, qty: l.qty, allowed: r3((l.reason.limit_qty * milk.used) / l.reason.limit_base) }))
      .filter((x) => x.qty > x.allowed + EPS);
    const data = { returned, returnTo: returned > 0 ? returnTo : null, losses: losses.map((l) => ({ reasonId: l.reason.id, reason: l.reason.name, qty: l.qty })), gain, milk, over };
    if (over.length && !approve) {
      db.prepare("UPDATE prod_shifts SET status = 'approval', close_data = ? WHERE id = ?").run(JSON.stringify(data), s.id);
      addAlert(db, 'prod.limit', `TS-${s.number} (${holderName(db, { userId: s.user_id })}): ${over.map((o) => `${o.reason} ${o.qty} kg (ruxsat ${o.allowed} kg)`).join(', ')}. Tasdiqlang yoki rad eting.`,
        { shiftId: s.id });
      return { needApproval: true, over, shift: shiftDetail(db, s.id) };
    }

    const h = { userId: s.user_id };
    const docId = Number(db.prepare(`INSERT INTO docs (uuid, type, number, status, doc_date, from_user, source, note, created_by)
      VALUES (?, 'shift_close', ?, 'draft', ?, ?, 'prod_shift', ?, ?)`).run(`pshift-${s.uuid}`, nextNumber(db, 'shift_close'), nowIso(), s.user_id, `TS-${s.number}`, actor).lastInsertRowid);
    const ctx = { doc: getDoc(db, docId), at: nowIso(), touched: new Set() };
    const insLine = db.prepare('INSERT INTO doc_lines (doc_id, product_id, qty, meta, sort) VALUES (?, ?, ?, ?, ?)');
    // The shift's average milk cost (what the tasks paid for milk).
    const avg = db.prepare(`SELECT SUM(-m.cost) AS c, SUM(-m.qty) AS q FROM stock_moves m JOIN prod_tasks t ON t.doc_id = m.doc_id
      WHERE t.shift_id = ? AND t.status = 'done' AND m.product_id = ? AND m.qty < 0`).get(s.id, milk.product_id);
    const unit = avg?.q > 0 ? avg.c / avg.q : lastUnitCost(db, milk.product_id);
    let spread = 0;
    if (gain > 0) {
      const lid = Number(insLine.run(docId, milk.product_id, gain, JSON.stringify({ role: 'gain' }), 0).lastInsertRowid);
      const c = r2(gain * unit);
      addIn(db, ctx, { productId: milk.product_id, h, qty: gain, cost: c, lineId: lid, kind: 'surplus', lot: { unitCost: unit, seq: 1 } });
      spread -= c;
    }
    losses.forEach((l, i) => {
      const lid = Number(insLine.run(docId, milk.product_id, l.qty, JSON.stringify({ role: 'loss', reasonId: l.reason.id, reason: l.reason.name }), i + 1).lastInsertRowid);
      const c = r2(takeOut(db, ctx, { productId: milk.product_id, h, qty: l.qty, lineId: lid, kind: 'loss' }).reduce((a, x) => a + x.cost, 0));
      const effect = l.reason.effect ?? (l.reason.charge === 'staff' ? 'staff' : 'company');
      if (effect === 'cost') spread += c;
      else if (effect === 'staff') chargeStaff(db, ctx, s.user_id, c, 'production', l.reason.name);
      else pnl(db, ctx, l.reason.category_id ?? 'production_loss', c, `TS-${s.number}: ${l.reason.name}`);
    });
    spreadOverShift(db, ctx, s, r2(spread));
    db.prepare("UPDATE docs SET status = 'posted', posted_by = ?, posted_at = ? WHERE id = ?").run(actor, nowIso(), docId);
    db.prepare('UPDATE lots SET provisional = 0 WHERE shift_id = ?').run(s.id);
    let transferId = null;
    if (returned > 0) {
      transferId = Number(db.prepare(`INSERT INTO docs (uuid, type, number, status, doc_date, from_user, to_wh, note, created_by, created_by_id)
        VALUES (?, 'transfer', ?, 'sent', ?, ?, ?, ?, ?, ?)`).run(`pshift-ret-${s.uuid}`, nextNumber(db, 'transfer'), nowIso(), s.user_id, returnTo,
        `TS-${s.number}: qolgan sut`, actor, s.user_id).lastInsertRowid);
      db.prepare('INSERT INTO doc_lines (doc_id, product_id, qty, sort) VALUES (?, ?, ?, 0)').run(transferId, milk.product_id, returned);
    }
    db.prepare("UPDATE prod_shifts SET status = 'closed', closed_at = ?, close_data = ?, close_doc_id = ? WHERE id = ?")
      .run(nowIso(), JSON.stringify({ ...data, spread_cost: r2(spread), unit_cost: r2(unit), transferId }), docId, s.id);
    if (approve) closeAlerts(db, 'shiftId', s.id, actor);
    return { shift: shiftDetail(db, s.id) };
  })();
}

export function approveShift(db, shiftId, actor, note) {
  const s = getShift(db, shiftId);
  if (!s || s.status !== 'approval') throw new StockError('Tasdiq kutayotgan smena emas');
  db.prepare('UPDATE prod_shifts SET approval_note = ?, approved_by = ? WHERE id = ?').run(note ? String(note).slice(0, 300) : null, actor, s.id);
  return closeShift(db, s.id, null, { actor, approve: true });
}

export function rejectShiftApproval(db, shiftId, actor, note) {
  const s = getShift(db, shiftId);
  if (!s || s.status !== 'approval') throw new StockError('Tasdiq kutayotgan smena emas');
  if (!note) throw new StockError('Sababini yozing');
  db.prepare("UPDATE prod_shifts SET status = 'open', approval_note = ?, approved_by = ? WHERE id = ?").run(String(note).slice(0, 300), actor, s.id);
  closeAlerts(db, 'shiftId', s.id, actor);
  return shiftDetail(db, s.id);
}

// Everything waiting for a manager.
export function approvals(db) {
  return {
    tasks: db.prepare("SELECT * FROM prod_tasks WHERE status = 'approval' ORDER BY id").all().map((t) => ({
      ...taskRow(db, t), user_name: holderName(db, { userId: getShift(db, t.shift_id).user_id }),
    })),
    shifts: db.prepare("SELECT id FROM prod_shifts WHERE status = 'approval' ORDER BY id").all().map((s) => shiftDetail(db, s.id)),
  };
}
