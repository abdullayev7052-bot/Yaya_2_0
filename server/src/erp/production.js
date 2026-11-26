// Production (Yaya 2.0): recipes, stage tasks, the technologist's shift and
// separation. Builds on the stock engine (stock.js) and the stages (stages.js).
//
// Stage model (stage 10, docs/STAGE10.md):
// - work happens at a stage (a warehouse shown as "Bosqich"), by its keepers;
// - a 'change' stage runs a recipe: inputs come from the previous stage on the
//   product's map (e.g. the quyma from "Ishlab chiqarish") and from the warehouses
//   the worker keeps (milk, starter, jars...); the output goes into the stage's own
//   warehouse. One active recipe per product per stage;
// - a 'keep' stage moves the same product on from the previous stage (incubator,
//   cold room, capping, finished goods), optionally paying a piece rate per unit;
// - "Who did it": the person doing it is ticked by default; the piece wage is split
//   equally between everyone ticked. Wages are part of the product's cost;
// - taking more than the previous stage holds sends it below zero (alert); the real
//   goods settle it later at their real cost (stock.js neg_links).
//
// Cost rules:
// - a cooked batch (quyma) costs what its inputs cost; separation splits the input
//   cost: fixed unit cost (e.g. cream), percent, and the rest;
// - the technologist's milk is reconciled at the end of the shift: the milk left in
//   the raw-milk warehouse is counted, losses are explained by reason; with
//   separation, the milk it used is what remains unexplained. Reasons with effect
//   "cost" raise the cost of that shift's outputs (by the milk each task used; for
//   separation only the "rest" outputs); "company" goes to expenses, "staff" to the
//   person's balance; a gain lowers the cost the same way;
// - separation outputs (cream, skim milk) may be used during the shift before they
//   are known: the raw-material warehouse goes below zero at the last known cost,
//   and the separation entered at the end settles it at the real cost;
// - until the shift is closed its output lots (and what was made from them) are
//   provisional; a later cost change is passed on to whatever was made from them;
// - every limit is proportional: set for a base amount, scaled to the real one.
//   Out of range → the task / shift waits for a manager's approval.
import { randomUUID } from 'node:crypto';
import {
  StockError, addAlert, addIn, allowNegative, cancelDocTx, chargeStaff, getDoc, holderName, insertMove, linkNegative, milkWarehouse, nextNumber, pnl,
  negativeAlerts, productBalance, r2, r3, rawMilkProduct, revalueLot, takeOut,
} from './stock.js';
import { getStage, keptWarehouses, prevStage, stageByCode, texRecipe } from './stages.js';

export { revalueLot };
export const RECIPE_KINDS = { cook: 'Tayyorlash (quyma)', separation: 'Separatsiya', pour: 'Quyish (idishga)', pack: 'Qadoqlash', cap: 'Qopqoq yopish (eski)', reprocess: 'Qayta ishlash' };
export const PER_UNIT = new Set(['pour', 'pack', 'cap', 'reprocess']);

// Reprocessing: expected quantity of an output for `units` input units — a set
// amount per unit, or the input's netto weight in kg (e.g. 400 g of content).
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
const variantsOf = (db, id) => db.prepare('SELECT id, name, variant FROM products WHERE parent_id = ? AND active = 1 ORDER BY variant, id').all(id);

// Weight in kg of a quantity in the product's own unit (for limits and loss shares).
export function weightKg(p, qty) {
  const u = String(p?.unit ?? 'kg').toLowerCase();
  if (u === 'g' || u === 'gramm' || u === 'gr') return qty / 1000;
  if (u === 'dona') return p?.netto_g ? (qty * p.netto_g) / 1000 : 0;
  return qty; // kg, l, litr
}

// ---------------------------------------------------------------- recipes
export function recipeDetail(db, id) {
  const r = db.prepare('SELECT r.*, p.name AS product, p.unit, w.name AS stage FROM recipes r LEFT JOIN products p ON p.id = r.product_id LEFT JOIN warehouses w ON w.id = r.stage_id WHERE r.id = ?').get(id);
  if (!r) return null;
  const lines = db.prepare(`SELECT l.*, p.name AS product, p.unit, p.kind AS product_kind, p.netto_g, p.has_variants FROM recipe_lines l JOIN products p ON p.id = l.product_id
    WHERE l.recipe_id = ? ORDER BY l.sort, l.id`).all(id).map((l) => ({
    ...l,
    variants: l.has_variants ? variantsOf(db, l.product_id) : [],
    alts: db.prepare('SELECT a.product_id, a.qty, p.name AS product, p.unit, p.has_variants FROM recipe_alts a JOIN products p ON p.id = a.product_id WHERE a.line_id = ?').all(l.id)
      .map((a) => ({ ...a, variants: a.has_variants ? variantsOf(db, a.product_id) : [] })),
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
  // The recipe's main raw materials (milk, skim milk): the others scale with their total.
  const baseMilk = r3(lines.filter((l) => l.product_kind === 'main_raw').reduce((a, l) => a + l.qty, 0));
  return { ...r, kind_label: RECIPE_KINDS[r.kind] ?? r.kind, lines, outputs, rates, limits, rate_total: r2(rates.reduce((a, x) => a + x.amount, 0)), base_weight: baseWeight, base_milk: baseMilk };
}

export function listRecipes(db, { all = false, kinds = null, stageIds = null } = {}) {
  return db.prepare(`SELECT id, kind, stage_id FROM recipes ${all ? '' : 'WHERE active = 1'} ORDER BY active DESC, sort, name`).all()
    .filter((r) => (!kinds || kinds.includes(r.kind)) && (!stageIds || stageIds.includes(r.stage_id))).map((r) => recipeDetail(db, r.id));
}

const num = (v) => (v == null || v === '' ? null : Number(v));
const DEFAULT_STAGE = { cook: 'produce', separation: 'produce', pour: 'pour', pack: 'pack', reprocess: 'reprocess_bad' };
export function saveRecipe(db, id, b) {
  const name = String(b?.name ?? '').trim().slice(0, 120);
  if (!name) throw new StockError('Tarkib nomini yozing');
  const kind = RECIPE_KINDS[b.kind] && b.kind !== 'cap' ? b.kind : 'cook';
  const productId = num(b.productId);
  // Pouring / packing recipes may be for any product: the finished product's Tex karta binds them.
  const generic = ['pour', 'pack'].includes(kind) && productId == null;
  if (kind !== 'separation' && !generic && !product(db, productId)) throw new StockError('Chiqadigan mahsulotni tanlang');
  if (kind !== 'separation' && !generic && product(db, productId).has_variants) throw new StockError('Chiqadigan mahsulot sifatida variantni tanlang');
  let stageId = num(b.stageId);
  if (stageId && !getStage(db, stageId)) throw new StockError('Bosqich topilmadi');
  if (!stageId) stageId = stageByCode(db, DEFAULT_STAGE[kind])?.id ?? null;
  const st = stageId ? getStage(db, stageId) : null;
  if (st && st.stage_type !== 'change') throw new StockError(`"${st.name}" — o'zgarmas bosqich; unda tarkib bo'lmaydi`);
  // One product, one recipe per stage: the worker never has to choose.
  if (kind !== 'separation' && !generic && stageId && (b.active === undefined || b.active)
    && db.prepare('SELECT 1 FROM recipes WHERE stage_id = ? AND product_id = ? AND active = 1 AND id <> ?').get(stageId, productId, id ?? 0)) {
    throw new StockError(`"${product(db, productId).name}" uchun "${st.name}" bosqichida tarkib allaqachon bor (bitta mahsulotga bitta tarkib)`);
  }
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
  // Piece wages only for pouring, packing (and capping, a stage rate) — never in production.
  if (rates.some((x) => x.amount > 0) && ['cook', 'separation'].includes(kind)) throw new StockError("Ishlab chiqarish (quyma) tarkibida ishbay haq bo'lmaydi");
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
  if (kind === 'cook' && !lines.some((l) => product(db, l.productId)?.kind === 'main_raw')) {
    throw new StockError("Tayyorlash tarkibida kamida bitta asosiy xomashyo (Yog'li sut yoki Yog'siz sut) bo'lishi shart");
  }
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
      db.prepare('UPDATE recipes SET name = ?, kind = ?, product_id = ?, stage_id = ?, out_min = ?, out_max = ?, max_minutes = ?, note = ?, active = COALESCE(?, active), sort = COALESCE(?, sort) WHERE id = ?')
        .run(name, kind, kind !== 'separation' && !generic ? productId : null, stageId, outMin, outMax, maxMinutes, b.note ?? null, b.active == null ? null : Number(!!b.active), num(b.sort), rid);
      db.prepare('DELETE FROM recipe_lines WHERE recipe_id = ?').run(rid);
      db.prepare('DELETE FROM recipe_outputs WHERE recipe_id = ?').run(rid);
      db.prepare('DELETE FROM recipe_rates WHERE recipe_id = ?').run(rid);
      db.prepare('DELETE FROM recipe_limits WHERE recipe_id = ?').run(rid);
    } else {
      rid = Number(db.prepare('INSERT INTO recipes (name, kind, product_id, stage_id, out_min, out_max, max_minutes, note, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(name, kind, kind !== 'separation' && !generic ? productId : null, stageId, outMin, outMax, maxMinutes, b.note ?? null, num(b.sort) ?? 0).lastInsertRowid);
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

// ---------------------------------------------------------------- shifts (technologist)
const getShift = (db, id) => (id ? db.prepare('SELECT * FROM prod_shifts WHERE id = ?').get(id) : null);
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
function ensureShift(db, userId) {
  const s = myShift(db, userId);
  if (s) { if (s.status !== 'open') throw new StockError('Smena rahbar tasdig\'ini kutmoqda'); return s; }
  return openShift(db, { userId });
}

// Where separation outputs (cream, skim milk) are kept: a raw-material warehouse
// the technologist keeps, else the first one, else the raw-milk warehouse.
export function sepWarehouse(db, userId) {
  const kept = keptWarehouses(db, userId);
  const raws = db.prepare("SELECT id FROM warehouses WHERE kind = 'raw' AND active = 1 AND is_stage = 0 ORDER BY sort, id").all().map((r) => r.id);
  return raws.find((id) => kept.includes(id)) ?? raws[0] ?? milkWarehouse(db);
}
const sepProducts = (db) => new Set(db.prepare("SELECT DISTINCT o.product_id FROM recipe_outputs o JOIN recipes r ON r.id = o.recipe_id WHERE r.kind = 'separation' AND r.active = 1").all().map((x) => x.product_id));

// The milk of a shift: what the tasks used, and what the raw-milk warehouse holds now.
export function shiftMilk(db, shift) {
  const milkId = rawMilkProduct(db);
  const used = r3(db.prepare("SELECT COALESCE(SUM(milk_qty), 0) AS q FROM prod_tasks WHERE shift_id = ? AND status = 'done'").get(shift.id).q);
  const wh = milkWarehouse(db);
  return { product_id: milkId, product: product(db, milkId).name, warehouse_id: wh, warehouse: holderName(db, { warehouseId: wh }), book: productBalance(db, { warehouseId: wh }, milkId), used };
}
// Separation outputs now (skim milk may be below zero during the shift).
export function shiftSeparation(db, userId) {
  const wh = sepWarehouse(db, userId);
  const recipe = db.prepare("SELECT id FROM recipes WHERE kind = 'separation' AND active = 1 ORDER BY sort, id LIMIT 1").get();
  if (!recipe) return null;
  const r = recipeDetail(db, recipe.id);
  return {
    recipe_id: r.id, recipe: r.name, warehouse_id: wh, warehouse: holderName(db, { warehouseId: wh }),
    outputs: r.outputs.map((o) => ({ product_id: o.product_id, product: o.product, unit: o.unit, mode: o.cost_mode, book: productBalance(db, { warehouseId: wh }, o.product_id) })),
  };
}

// ---------------------------------------------------------------- the technologist's milk
// Received milk: the technologist picks the accepted collector shifts whose milk this
// shift used (their milk is already in "Sut ombori"). A collector shift is counted
// in one technologist shift only. Their real quantities make "Qabul qilingan sut",
// and their cost becomes the cost of the milk this shift used.
const milkDocsOf = (db, ids) => (ids.length ? db.prepare(`SELECT s.id AS shift_id, d.id AS doc_id FROM shifts s JOIN docs d ON d.uuid = 'shift-' || s.client_uuid
  WHERE s.id IN (${ids.map(() => '?').join(',')}) AND d.type = 'milk_in' AND d.status = 'posted'`).all(...ids) : []);
export function milkShifts(db, prodShift) {
  const selected = new Set(J(prodShift?.milk_shifts) ?? []);
  const usedBy = new Map(db.prepare('SELECT shift_id, prod_shift_id FROM prod_shift_milk').all().map((r) => [r.shift_id, r.prod_shift_id]));
  // also chosen by another shift that is still open
  for (const o of db.prepare("SELECT id, milk_shifts FROM prod_shifts WHERE status <> 'closed' AND id <> ?").all(prodShift?.id ?? 0)) for (const id of J(o.milk_shifts) ?? []) if (!usedBy.has(id)) usedBy.set(id, o.id);
  return db.prepare(`SELECT s.id, s.number, s.copy_no, s.accepted_at, COALESCE(u.name, u.login) AS collector, dl.qty, ROUND(dl.qty * dl.unit_cost, 2) AS cost
    FROM shifts s JOIN users u ON u.id = s.employee_id JOIN docs d ON d.uuid = 'shift-' || s.client_uuid JOIN doc_lines dl ON dl.doc_id = d.id
    WHERE d.type = 'milk_in' AND d.status = 'posted' ORDER BY s.accepted_at DESC, s.id DESC LIMIT 80`).all()
    .map((r) => ({ ...r, label: `#${r.number}${r.copy_no ? `-${r.copy_no}` : ''}`, qty: r3(r.qty), selected: selected.has(r.id),
      used: usedBy.has(r.id) && usedBy.get(r.id) !== prodShift?.id }));
}
export function setShiftMilk(db, shiftId, ids, userId) {
  const s = getShift(db, shiftId);
  if (!s || s.user_id !== userId) throw new StockError('Smena topilmadi');
  if (s.status !== 'open') throw new StockError('Smena ochiq emas');
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(Number))];
  const avail = new Map(milkShifts(db, s).map((r) => [r.id, r]));
  for (const id of list) {
    const r = avail.get(id);
    if (!r) throw new StockError('Smena topilmadi (yoki suti omborga tushmagan)');
    if (r.used) throw new StockError(`${r.label} smenasi boshqa ishlab chiqarish smenasida hisoblangan`);
  }
  db.prepare('UPDATE prod_shifts SET milk_shifts = ? WHERE id = ?').run(JSON.stringify(list), s.id);
  return shiftDetail(db, s.id);
}

// Everything the end of the shift needs: received, used (milk directly, skim milk),
// cream from separation, total, and the loss = received − total.
export function shiftSummary(db, s) {
  const milkId = rawMilkProduct(db);
  const sepR = db.prepare("SELECT id FROM recipes WHERE kind = 'separation' AND active = 1 ORDER BY sort, id LIMIT 1").get();
  const sep = sepR ? recipeDetail(db, sepR.id) : null;
  const restIds = new Set((sep?.outputs ?? []).filter((o) => o.cost_mode === 'rest').map((o) => o.product_id));
  const used = new Map(db.prepare(`SELECT m.product_id, SUM(-m.qty) AS q FROM stock_moves m JOIN prod_tasks t ON t.doc_id = m.doc_id
    WHERE t.shift_id = ? AND t.status = 'done' AND t.kind <> 'separation' AND m.qty < 0 AND m.kind = 'consume' GROUP BY m.product_id`).all(s.id).map((r) => [r.product_id, r.q]));
  const sepTask = db.prepare("SELECT * FROM prod_tasks WHERE shift_id = ? AND kind = 'separation' AND status = 'done' ORDER BY id DESC LIMIT 1").get(s.id);
  const sepOut = sepTask ? db.prepare(`SELECT dl.product_id, dl.qty, dl.meta FROM doc_lines dl WHERE dl.doc_id = ?`).all(sepTask.doc_id).filter((l) => J(l.meta)?.role === 'out') : [];
  const sepMilk = sepTask ? r3(db.prepare("SELECT COALESCE(SUM(-qty), 0) AS q FROM stock_moves WHERE doc_id = ? AND product_id = ? AND qty < 0 AND kind = 'consume'").get(sepTask.doc_id, milkId).q) : 0;
  const ids = J(s.milk_shifts) ?? [];
  const received = r3(ids.length ? db.prepare(`SELECT COALESCE(SUM(dl.qty), 0) AS q FROM doc_lines dl JOIN docs d ON d.id = dl.doc_id JOIN shifts sh ON d.uuid = 'shift-' || sh.client_uuid
    WHERE sh.id IN (${ids.map(() => '?').join(',')}) AND d.type = 'milk_in'`).get(...ids).q : 0);
  const milkDirect = r3(used.get(milkId) ?? 0);
  const skimUsed = r3([...restIds].reduce((a, id) => a + (used.get(id) ?? 0), 0));
  const cream = r3(sepOut.filter((l) => !restIds.has(l.product_id)).reduce((a, l) => a + l.qty, 0));
  const total = r3(milkDirect + (sepTask ? sepMilk : skimUsed));
  return {
    milk_shifts: ids, received, milk_direct: milkDirect, skim_used: skimUsed, cream: sepTask ? cream : null, sep_milk: sepMilk, total,
    loss_qty: r3(received - total), separated: !!sepTask, need_separation: skimUsed > EPS && !sepTask, separation_recipe: sep
      ? { id: sep.id, name: sep.name, outputs: sep.outputs.map((o) => ({ product_id: o.product_id, product: o.product, unit: o.unit, mode: o.cost_mode,
        qty: o.cost_mode === 'rest' ? r3(used.get(o.product_id) ?? 0) : null })) } : null,
  };
}

// Separation (before closing): the skim milk made is exactly the skim milk the shift
// used (it was taken below zero); the cream is entered. Separation never loses
// anything: the milk it takes = skim milk + cream. Posted at FIFO now; the shift
// close gives the milk its real cost.
export function separateShift(db, shiftId, body, { actor, userId }) {
  return db.transaction(() => {
    const s = getShift(db, shiftId);
    if (!s || s.user_id !== userId) throw new StockError('Smena topilmadi');
    if (s.status !== 'open') throw new StockError('Smena ochiq emas');
    const sum = shiftSummary(db, s);
    if (sum.separated) throw new StockError('Bu smenada separatsiya allaqachon kiritilgan');
    if (!sum.separation_recipe) throw new StockError('Separatsiya tarkibi yo\'q (panel → Tarkiblar)');
    const given = new Map((body?.outputs ?? []).filter((o) => o.qty != null && o.qty !== '').map((o) => [Number(o.productId), r3(o.qty)]));
    const r = recipeDetail(db, sum.separation_recipe.id);
    const outputs = r.outputs.map((o) => ({ productId: o.product_id, mode: o.cost_mode, value: o.cost_value,
      qty: o.cost_mode === 'rest' ? r3(sum.separation_recipe.outputs.find((x) => x.product_id === o.product_id)?.qty ?? 0) : (given.get(o.product_id) ?? 0) }));
    for (const o of outputs) if (!(o.qty >= 0)) throw new StockError('Miqdor noto\'g\'ri');
    const milkQty = r3(outputs.reduce((a, o) => a + o.qty, 0));
    if (!(milkQty > EPS)) throw new StockError('Separatsiyadan chiqqan miqdorni kiriting (toza qaymoq)');
    const milkId = rawMilkProduct(db);
    const stage = stageByCode(db, 'produce');
    const n = db.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM prod_tasks').get().n;
    const tid = Number(db.prepare("INSERT INTO prod_tasks (uuid, number, shift_id, stage_id, user_id, recipe_id, kind, plan, created_by) VALUES (?, ?, ?, ?, ?, ?, 'separation', ?, ?)")
      .run(`sep-${s.uuid}`, n, s.id, stage?.id ?? null, s.user_id, r.id, JSON.stringify({ factor: 1, lines: [{ productId: milkId, qty: milkQty }] }), actor).lastInsertRowid);
    const t = getTask(db, tid);
    postProduction(db, t, s, r, [{ productId: milkId, qty: milkQty }], outputs, actor, 'Separatsiya', [s.user_id], [], { sources: [{ h: { warehouseId: milkWarehouse(db) } }] });
    db.prepare("UPDATE prod_tasks SET status = 'done', result = ?, done_at = ? WHERE id = ?")
      .run(JSON.stringify({ lines: [{ productId: milkId, qty: milkQty }], outputs: outputs.map((o) => ({ productId: o.productId, qty: o.qty })), workers: [s.user_id] }), nowIso(), tid);
    return shiftDetail(db, s.id);
  })();
}

function taskRow(db, t) {
  const plan = J(t.plan) ?? {};
  const out = plan.productId ? product(db, plan.productId) : null;
  const result = J(t.result);
  if (result?.outputs) result.outputs = result.outputs.map((o) => ({ ...o, product: product(db, o.productId)?.name, unit: product(db, o.productId)?.unit }));
  const recipe = t.recipe_id ? db.prepare('SELECT name FROM recipes WHERE id = ?').get(t.recipe_id)?.name : null;
  const outputs = t.doc_id ? db.prepare(`SELECT dl.product_id, p.name AS product, p.unit, dl.qty, dl.meta FROM doc_lines dl JOIN products p ON p.id = dl.product_id
    WHERE dl.doc_id = ? ORDER BY dl.sort`).all(t.doc_id).filter((l) => J(l.meta)?.role === 'out').map((l) => {
    const lots = db.prepare('SELECT l.unit_cost, l.qty0, l.provisional FROM lots l WHERE l.doc_id = ? AND l.product_id = ? ORDER BY l.id').all(t.doc_id, l.product_id);
    const cost = r2(lots.reduce((a, x) => a + x.unit_cost * (x.qty0 ?? 0), 0));
    return { product_id: l.product_id, product: l.product, unit: l.unit, qty: l.qty, unit_cost: l.qty ? r2(cost / l.qty) : null, cost, provisional: lots.some((x) => x.provisional) };
  }) : [];
  const stage = t.stage_id ? db.prepare('SELECT name, stage_type FROM warehouses WHERE id = ?').get(t.stage_id) : null;
  return {
    id: t.id, uuid: t.uuid, number: t.number, label: `TQ-${t.number}`, shift_id: t.shift_id, stage_id: t.stage_id, stage: stage?.name ?? null, stage_type: stage?.stage_type ?? null,
    user_id: t.user_id, user_name: t.user_id ? holderName(db, { userId: t.user_id }) : null,
    recipe_id: t.recipe_id, recipe, kind: t.kind, status: t.status, product_id: plan.productId ?? null, product: out?.name ?? null, product_unit: out?.unit ?? null,
    factor: plan.factor ?? 1, plan: (plan.lines ?? []).map((l) => ({ ...l, product: product(db, l.productId)?.name, unit: product(db, l.productId)?.unit })),
    result, outputs, milk_qty: t.milk_qty, doc_id: t.doc_id, created_at: t.created_at, done_at: t.done_at,
    workers: (result?.workers ?? []).map((id) => ({ id, name: holderName(db, { userId: id }) })),
    wages: t.doc_id ? db.prepare("SELECT party_id AS user_id, -SUM(amount) AS amount FROM party_entries WHERE doc_id = ? AND party_type = 'staff' AND kind IN ('piece','reversal') GROUP BY party_id").all(t.doc_id)
      .filter((w) => Math.abs(w.amount) >= 0.005).map((w) => ({ ...w, name: holderName(db, { userId: w.user_id }) })) : [],
    approval_note: t.approval_note, approved_by: t.approved_by, cancel_reason: t.cancel_reason,
  };
}

export function shiftDetail(db, id) {
  const s = getShift(db, id);
  if (!s) return null;
  const tasks = db.prepare('SELECT * FROM prod_tasks WHERE shift_id = ? ORDER BY id').all(id).map((t) => taskRow(db, t));
  return {
    ...s, label: `TS-${s.number}`, user_name: holderName(db, { userId: s.user_id }), close_data: J(s.close_data),
    milk: shiftMilk(db, s), separation: s.status === 'closed' ? null : shiftSeparation(db, s.user_id), summary: shiftSummary(db, s), tasks,
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

// The stage journal: every task done at a stage, newest first, with who did it.
export function stageJournal(db, { stageId = null, userId = null, from = null, to = null, limit = 300 } = {}) {
  const where = ["status <> 'open'"]; const args = [];
  if (stageId) { where.push('stage_id = ?'); args.push(stageId); }
  if (userId) { where.push('user_id = ?'); args.push(userId); }
  if (from) { where.push("date(COALESCE(done_at, created_at), '+5 hours') >= ?"); args.push(from); }
  if (to) { where.push("date(COALESCE(done_at, created_at), '+5 hours') <= ?"); args.push(to); }
  return db.prepare(`SELECT * FROM prod_tasks WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`).all(...args, Math.min(limit, 1000)).map((t) => taskRow(db, t));
}

// ---------------------------------------------------------------- tasks
const getTask = (db, id) => db.prepare('SELECT * FROM prod_tasks WHERE id = ?').get(id);
export const taskDetail = (db, id) => { const t = getTask(db, id); return t ? taskRow(db, t) : null; };

// A task at a 'change' stage starts from the stage's recipe: lines scaled by factor
// (or by the milk to use, or the number of units); any line may be changed for this
// batch, swapped for one of its alternatives, or given its variant. The technologist's
// tasks (the production stage) belong to their shift, opened on the first task.
export function createTask(db, { uuid, stageId, recipeId, productId, factor, milkQty, units, lines }, { actor, userId }) {
  const u = String(uuid || randomUUID()).slice(0, 80);
  const ex = db.prepare('SELECT * FROM prod_tasks WHERE uuid = ?').get(u);
  if (ex) return ex;
  // Pouring / packing / reprocessing a finished product: its Tex karta names the recipe.
  let outProduct = null;
  if (productId && stageId) {
    const p = product(db, Number(productId));
    if (!p) throw new StockError('Mahsulot topilmadi');
    recipeId = texRecipe(db, p.id, Number(stageId));
    if (!recipeId) throw new StockError(`"${p.name}" Tex kartasida bu bosqich uchun tarkib tanlanmagan`);
    outProduct = p.id;
  }
  const r = recipeDetail(db, Number(recipeId));
  if (!r || !r.active) throw new StockError('Tarkib topilmadi');
  const st = getStage(db, stageId ?? r.stage_id);
  if (!st || st.stage_type !== 'change') throw new StockError('Bosqich topilmadi');
  if (r.stage_id !== st.id) throw new StockError(`"${r.name}" — "${st.name}" bosqichining tarkibi emas`);
  if (!r.product_id && r.kind !== 'separation' && !outProduct) throw new StockError(`"${r.name}" umumiy tarkib — qaysi tayyor mahsulot chiqishini tanlang`);
  if (r.kind === 'reprocess') outProduct = null;
  const shift = st.stage_code === 'produce' ? ensureShift(db, userId) : null;
  let f = Number(factor) || 1;
  if (PER_UNIT.has(r.kind) && units != null) f = Number(units);
  if (milkQty != null && milkQty !== '' && !PER_UNIT.has(r.kind)) {
    if (!(r.base_milk > 0)) throw new StockError('Bu tarkibda asosiy xomashyo yo\'q; miqdorni koeffitsiyent bilan bering');
    f = Number(milkQty) / r.base_milk;
  }
  if (!(f > 0)) throw new StockError('Miqdor noto\'g\'ri');
  const over = new Map((Array.isArray(lines) ? lines : []).map((l) => [Number(l.lineId), l]));
  const planLines = r.lines.map((l) => {
    const o = over.get(l.id);
    const pid = o?.productId ? Number(o.productId) : l.product_id;
    const { alt } = allowedChoice(db, l, pid);
    const baseQty = alt?.qty ?? l.qty;
    const qty = o?.qty != null && o.qty !== '' ? r3(o.qty) : r3(baseQty * f);
    if (!(qty >= 0)) throw new StockError(`${l.product}: miqdor noto'g'ri`);
    return { lineId: l.id, productId: pid, qty };
  });
  const n = db.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM prod_tasks').get().n;
  const id = Number(db.prepare('INSERT INTO prod_tasks (uuid, number, shift_id, stage_id, user_id, recipe_id, kind, plan, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(u, n, shift?.id ?? null, st.id, userId, r.id, r.kind, JSON.stringify({ factor: r3(f), lines: planLines, productId: outProduct ?? r.product_id ?? null }), actor).lastInsertRowid);
  return getTask(db, id);
}

// A recipe line may take: its product, one of its alternatives, or a variant of
// either ("Zakvaska" → "Zakvaska / 499").
function allowedChoice(db, line, pid) {
  if (pid === line.product_id) return { alt: null };
  const alt = line.alts.find((a) => a.product_id === pid);
  if (alt) return { alt };
  const p = product(db, pid);
  if (p?.parent_id === line.product_id) return { alt: null };
  const altParent = p?.parent_id ? line.alts.find((a) => a.product_id === p.parent_id) : null;
  if (altParent) return { alt: altParent };
  throw new StockError(`${line.product}: faqat tarkibdagi mahsulot, uning alternativi yoki varianti tanlanadi`);
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

// Where an input comes from, in order: the previous stage on the map (of the input
// itself, then of what the recipe makes), the raw-milk warehouse for milk, the
// warehouses the worker keeps, then the stage's own warehouse. The first with enough is used; with not enough
// anywhere, a previous stage goes below zero; separation outputs may go below zero
// during the technologist's shift; otherwise the shortage is refused.
function inputSource(db, { t, r, productId, qty }) {
  const out = J(t.plan)?.productId ?? r.product_id;
  const prevs = [prevStage(db, productId, t.stage_id), out ? prevStage(db, out, t.stage_id) : null].filter(Boolean);
  const list = [...new Set(prevs)];
  const add = (id) => { if (id && !list.includes(id)) list.push(id); };
  if (product(db, productId)?.kind === 'main_raw') { add(milkWarehouse(db)); add(sepWarehouse(db, t.user_id)); }
  for (const w of keptWarehouses(db, t.user_id)) if (w !== t.stage_id && !db.prepare('SELECT is_stage FROM warehouses WHERE id = ?').get(w)?.is_stage) add(w);
  for (const w of keptWarehouses(db, t.user_id)) if (w !== t.stage_id) add(w);
  // Materials kept at the stage itself come last.
  add(t.stage_id);
  for (const id of list) if (productBalance(db, { warehouseId: id }, productId) >= qty - EPS) return { h: { warehouseId: id } };
  for (const id of prevs) if (allowNegative(db, { warehouseId: id })) return { h: { warehouseId: id } };
  if (t.shift_id && sepProducts(db).has(productId)) return { h: { warehouseId: sepWarehouse(db, t.user_id) }, allowNeg: true };
  for (const id of list) if (productBalance(db, { warehouseId: id }, productId) > EPS) return { h: { warehouseId: id } };
  if (!list.length) throw new StockError(`${product(db, productId)?.name}: siz mas'ul bo'lgan omborlarda yo'q`);
  return { h: { warehouseId: list[0] } };
}

// "Zakvaska" in the plan becomes the variant with the most stock where the worker
// takes from (the app normally asks which one).
function resolveVariant(db, t, r, l) {
  const p = product(db, l.productId);
  if (!p?.has_variants) return l;
  const vs = variantsOf(db, p.id).map((v) => {
    const prevs = [prevStage(db, v.id, t.stage_id)].filter(Boolean);
    const places = [...prevs, ...keptWarehouses(db, t.user_id)];
    return { id: v.id, q: Math.max(0, ...places.map((w) => productBalance(db, { warehouseId: w }, v.id))) };
  }).sort((a, b) => b.q - a.q);
  if (!vs.length || !(vs[0].q > EPS)) throw new StockError(`${p.name}: variantini tanlang (omborda hech bir varianti yo'q)`);
  return { ...l, productId: vs[0].id };
}

function cleanQtyLines(db, lines, what) {
  if (!Array.isArray(lines) || !lines.length) throw new StockError(`${what}: kamida bitta qator`);
  return lines.map((l) => {
    const p = product(db, Number(l.productId));
    if (!p) throw new StockError(`${what}: mahsulot topilmadi`);
    const qty = r3(l.qty);
    if (!(qty >= 0)) throw new StockError(`${p.name}: miqdor noto'g'ri`);
    return { productId: p.id, qty, lineId: l.lineId };
  }).filter((l) => l.qty > 0);
}

// Who did it: the people ticked (default: the person doing it); each must be active.
function cleanWorkers(db, list, fallback) {
  const workers = [...new Set((Array.isArray(list) && list.length ? list : [fallback]).map(Number))];
  for (const w of workers) if (!db.prepare('SELECT 1 FROM users WHERE id = ? AND active = 1').get(w)) throw new StockError('Xodim topilmadi');
  return workers;
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
    if (s && s.status !== 'open') throw new StockError('Smena ochiq emas');
    const b = approve ? J(t.result) : body;
    const r = recipeDetail(db, t.recipe_id);
    const plan = J(t.plan);
    const inputs = cleanQtyLines(db, b?.lines ?? plan.lines, 'Xomashyo').map((l) => resolveVariant(db, t, r, l));
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
      outputs = [{ productId: plan.productId ?? r.product_id, qty: q, mode: 'rest' }];
    } else {
      const given = new Map((b?.outputs ?? []).map((o) => [Number(o.productId), r3(o.qty)]));
      outputs = r.outputs.map((o) => ({ productId: o.product_id, qty: given.get(o.product_id) ?? 0, mode: o.cost_mode, value: o.cost_value }));
      if (!outputs.some((o) => o.qty > 0)) throw new StockError('Chiqqan mahsulotlar miqdorini kiriting');
    }
    const range = outputRange(db, r, inputs);
    const outWeight = r3(outputs.reduce((a, o) => a + weightKg(product(db, o.productId), o.qty), 0));
    const outside = (r.kind !== 'reprocess' && range && ((range.min != null && outWeight < range.min - EPS) || (range.max != null && outWeight > range.max + EPS))) || !!outsideOut;
    // "Who did it with you" only where a piece wage is paid (never in production).
    const workers = r.rates.some((x) => x.amount > 0) ? cleanWorkers(db, b?.workers, t.user_id) : [t.user_id];
    const stored = { lines: inputs, outputs: outputs.map((o) => ({ productId: o.productId, qty: o.qty })), outputQty: !['separation', 'reprocess'].includes(r.kind) ? outputs[0].qty : undefined,
      shortfall: shortfall.map((x) => ({ reasonId: x.reason.id, reason: x.reason.name, qty: x.qty })), workers, note: b?.note ?? null };
    if (outside && !approve) {
      db.prepare("UPDATE prod_tasks SET status = 'approval', result = ? WHERE id = ?").run(JSON.stringify({ ...stored, range: outsideOut ?? range, outWeight }), t.id);
      addAlert(db, 'prod.limit', outsideOut
        ? `TQ-${t.number} (${r.name}): ${outsideOut.product} ${outsideOut.qty}, ruxsat ${outsideOut.min ?? '—'}–${outsideOut.max ?? '—'}. Tasdiqlang yoki rad eting.`
        : `TQ-${t.number} (${r.name}): chiqish ${outWeight} kg, ruxsat ${range.min ?? '—'}–${range.max ?? '—'} kg${range.rule ? ` (shartli limit: ${range.rule})` : ''}. Tasdiqlang yoki rad eting.`,
        { taskId: t.id, shiftId: s?.id ?? null, userIds: [t.user_id] });
      return { needApproval: true, range: outsideOut ? { min: outsideOut.min, max: outsideOut.max } : range, outWeight, task: taskRow(db, getTask(db, t.id)) };
    }
    postProduction(db, t, s, r, inputs, outputs, actor, b?.note, workers, shortfall);
    db.prepare("UPDATE prod_tasks SET status = 'done', result = ?, done_at = ? WHERE id = ?").run(JSON.stringify({ ...stored, range, outWeight }), nowIso(), t.id);
    if (approve) closeAlerts(db, 'taskId', t.id, actor);
    return { task: taskRow(db, getTask(db, t.id)) };
  })();
}

// Where the output goes: the stage's own warehouse; separation outputs to the
// raw-material warehouse (they are raw materials for the next batches); a
// reprocessed container back to the container warehouse.
function outputPlace(db, t, r, o) {
  if (r.kind === 'separation') return { warehouseId: sepWarehouse(db, t.user_id) };
  if (r.kind === 'reprocess' && o.container) {
    const pack = db.prepare("SELECT id FROM warehouses WHERE kind = 'pack' AND active = 1 AND is_stage = 0 ORDER BY sort, id LIMIT 1").get();
    if (pack) return { warehouseId: pack.id };
  }
  return { warehouseId: t.stage_id };
}

function postProduction(db, t, s, r, inputs, outputs, actor, note, workers, shortfall = [], { sources = null } = {}) {
  const id = Number(db.prepare(`INSERT INTO docs (uuid, type, number, status, doc_date, from_wh, to_wh, source, note, created_by, created_by_id)
    VALUES (?, 'production', ?, 'draft', ?, ?, ?, 'production', ?, ?, ?)`).run(`task-${t.uuid}`, nextNumber(db, 'production'), nowIso(), t.stage_id, t.stage_id,
    `TQ-${t.number}: ${r.name}${note ? ` — ${String(note).slice(0, 200)}` : ''}`, actor, t.user_id).lastInsertRowid);
  const doc = getDoc(db, id);
  const ctx = { doc, at: nowIso(), touched: new Set() };
  const insLine = db.prepare('INSERT INTO doc_lines (doc_id, product_id, qty, meta, sort) VALUES (?, ?, ?, ?, ?)');
  let total = 0; let milk = 0; const taken = [];
  inputs.forEach((l, i) => {
    const src = sources?.[i] ?? inputSource(db, { t, r, productId: l.productId, qty: l.qty });
    const lid = Number(insLine.run(id, l.productId, l.qty, JSON.stringify({ role: 'in', from: src.h.warehouseId }), i).lastInsertRowid);
    for (const x of takeOut(db, ctx, { productId: l.productId, h: src.h, qty: l.qty, lineId: lid, kind: 'consume', allowNeg: !!src.allowNeg })) { total += x.cost; taken.push({ ...x, productId: l.productId }); }
    if (product(db, l.productId).kind === 'main_raw') milk += l.qty;
  });
  // Piece rates: part of the cost, owed to the workers (split equally).
  if (r.kind !== 'separation' && r.rates.length) {
    const units = r.kind === 'reprocess' ? inputs.reduce((a, l) => a + l.qty, 0) : outputs.reduce((a, o) => a + o.qty, 0);
    total += payWorkers(db, ctx, workers, r2(r.rate_total * units), `TQ-${t.number}: ${r.rates.map((x) => x.name).join(', ')} (${r3(units)} × ${r.rate_total})`);
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
      if (effect === 'staff') chargeStaff(db, ctx, t.user_id, c, 'reprocess', `TQ-${t.number}: idish ${x.reason.name}`);
      else pnl(db, ctx, x.reason.category_id ?? 'container_loss', c, `TQ-${t.number}: idish ${x.reason.name} (${x.qty})`);
    }
    const left2 = r2(rest - lost);
    pnl(db, ctx, left2 >= 0 ? 'reprocess_loss' : 'cost_variance', left2, `TQ-${t.number}: ${r.name}`);
  } else if (rest < 0 || !restOuts.length) {
    // Fixed outputs worth more than the whole batch: the gap is a cost variance.
    pnl(db, ctx, 'cost_variance', rest, `${r.name}: tannarx taqsimoti farqi`);
  }
  const outQty = outputs.reduce((a, o) => a + o.qty, 0);
  // Final only when the technologist's shift closes (and nothing came from below zero).
  const provisional = !!s || taken.some((x) => !x.lotId || db.prepare('SELECT provisional FROM lots WHERE id = ?').get(x.lotId)?.provisional);
  outputs.filter((o) => o.qty > 0).forEach((o, i) => {
    const dest = outputPlace(db, t, r, o);
    const lid = Number(insLine.run(id, o.productId, o.qty, JSON.stringify({ role: 'out', mode: o.mode, to: dest.warehouseId }), 100 + i).lastInsertRowid);
    const c = costs.get(o.productId) ?? 0;
    const lot = addIn(db, ctx, { productId: o.productId, h: dest, qty: o.qty, cost: c, lineId: lid, kind: 'produce',
      lot: { unitCost: c / o.qty, seq: i + 1, provisional: provisional ? 1 : 0, shiftId: s?.id ?? null } });
    const share = o.qty / outQty;
    const ins = db.prepare('INSERT INTO lot_sources (lot_id, source_lot_id, qty, doc_id) VALUES (?, ?, ?, ?)');
    for (const x of taken) {
      if (x.lotId) ins.run(lot, x.lotId, r3(x.qty * share), id);
      else linkNegative(db, ctx, x, lot, share);
    }
  });
  db.prepare("UPDATE docs SET status = 'posted', posted_by = ?, posted_at = ? WHERE id = ?").run(actor, nowIso(), id);
  // Separation outputs below zero during the shift are expected (settled at its end).
  if (!t.shift_id) negativeAlerts(db, ctx);
  db.prepare('UPDATE prod_tasks SET doc_id = ?, milk_qty = ? WHERE id = ?').run(id, r3(milk), t.id);
  return id;
}

// Piece wage split equally between the workers (the last takes the rounding).
function payWorkers(db, ctx, workers, wage, note) {
  if (!(wage > 0)) return 0;
  let left = wage;
  workers.forEach((w, i) => {
    const share = i === workers.length - 1 ? r2(left) : r2(wage / workers.length);
    left -= share;
    chargeStaff(db, ctx, w, -share, 'piece', `${note}${workers.length > 1 ? ` ÷ ${workers.length}` : ''}`);
  });
  return wage;
}

// A 'keep' stage (incubator, cold room, capping, finished goods...): move qty of a
// product on from the previous stage on its map into this stage. Less than is there
// leaves the rest behind; more sends the previous stage below zero (alert). The
// stage's piece rate (if any) is paid to the people ticked and added to the cost.
export function keepTask(db, { uuid, stageId, productId, qty, workers, note }, { actor, userId }) {
  return db.transaction(() => {
    const u = String(uuid || randomUUID()).slice(0, 80);
    const ex = db.prepare('SELECT * FROM prod_tasks WHERE uuid = ?').get(u);
    if (ex) return { task: taskRow(db, ex) };
    const st = getStage(db, stageId);
    if (!st || st.stage_type !== 'keep') throw new StockError('Bosqich topilmadi');
    const p = product(db, Number(productId));
    if (!p) throw new StockError('Mahsulot topilmadi');
    const q = r3(qty);
    if (!(q > 0)) throw new StockError('Miqdorni kiriting');
    let from = prevStage(db, p.id, st.id);
    if (!from) {
      // Not on the map (or the first stage): from a warehouse this person keeps that has it.
      from = keptWarehouses(db, userId).find((w) => w !== st.id && productBalance(db, { warehouseId: w }, p.id) > EPS) ?? null;
      if (!from) throw new StockError(`"${p.name}" mahsuloti xaritasida "${st.name}"dan oldingi bosqich yo'q`);
    }
    const ws = cleanWorkers(db, workers, userId);
    const n = db.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM prod_tasks').get().n;
    const tid = Number(db.prepare("INSERT INTO prod_tasks (uuid, number, stage_id, user_id, kind, plan, created_by) VALUES (?, ?, ?, ?, 'keep', ?, ?)")
      .run(u, n, st.id, userId, JSON.stringify({ productId: p.id, qty: q }), actor).lastInsertRowid);
    const docId = Number(db.prepare(`INSERT INTO docs (uuid, type, number, status, doc_date, from_wh, to_wh, source, note, created_by, created_by_id)
      VALUES (?, 'stage_move', ?, 'draft', ?, ?, ?, 'production', ?, ?, ?)`).run(`task-${u}`, nextNumber(db, 'stage_move'), nowIso(), from, st.id,
      `TQ-${n}: ${st.name}${note ? ` — ${String(note).slice(0, 200)}` : ''}`, actor, userId).lastInsertRowid);
    const ctx = { doc: getDoc(db, docId), at: nowIso(), touched: new Set() };
    const ins = db.prepare('INSERT INTO doc_lines (doc_id, product_id, qty, meta, sort) VALUES (?, ?, ?, ?, ?)');
    const lin = Number(ins.run(docId, p.id, q, JSON.stringify({ role: 'in', from }), 0).lastInsertRowid);
    const lout = Number(ins.run(docId, p.id, q, JSON.stringify({ role: 'out', mode: 'rest', to: st.id }), 100).lastInsertRowid);
    const taken = takeOut(db, ctx, { productId: p.id, h: { warehouseId: from }, qty: q, lineId: lin, kind: 'consume' });
    const wage = payWorkers(db, ctx, ws, r2((st.piece_rate ?? 0) * q), `TQ-${n}: ${st.name} (${q} × ${st.piece_rate ?? 0})`);
    let wleft = wage;
    taken.forEach((x, i) => {
      const w = i === taken.length - 1 ? r2(wleft) : r2((wage * x.qty) / q);
      wleft -= w;
      const src = x.lotId ? db.prepare('SELECT * FROM lots WHERE id = ?').get(x.lotId) : null;
      const cost = r2(x.cost + w);
      const lot = addIn(db, ctx, { productId: p.id, h: { warehouseId: st.id }, qty: x.qty, cost, lineId: lout, kind: 'produce',
        lot: { unitCost: cost / x.qty, seq: i + 1, producedAt: src?.produced_at, expiresAt: src?.expires_at, provisional: src ? src.provisional : 1 } });
      if (x.lotId) db.prepare('INSERT INTO lot_sources (lot_id, source_lot_id, qty, doc_id) VALUES (?, ?, ?, ?)').run(lot, x.lotId, x.qty, docId);
      else linkNegative(db, ctx, x, lot);
    });
    db.prepare("UPDATE docs SET status = 'posted', posted_by = ?, posted_at = ? WHERE id = ?").run(actor, nowIso(), docId);
    negativeAlerts(db, ctx);
    db.prepare("UPDATE prod_tasks SET status = 'done', doc_id = ?, result = ?, done_at = ? WHERE id = ?")
      .run(docId, JSON.stringify({ productId: p.id, qty: q, workers: ws, from, outputs: [{ productId: p.id, qty: q }] }), nowIso(), tid);
    return { task: taskRow(db, getTask(db, tid)) };
  })();
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
// nothing made by it has moved on (and, for the technologist, while the shift is open).
export function cancelTask(db, taskId, actor, reason) {
  if (!reason) throw new StockError('Bekor qilish sababini yozing');
  return db.transaction(() => {
    const t = getTask(db, taskId);
    if (!t) throw new StockError('Topshiriq topilmadi');
    if (t.status === 'cancelled') throw new StockError('Topshiriq allaqachon bekor qilingan');
    if (t.status === 'done') {
      if (t.shift_id && getShift(db, t.shift_id).status !== 'open') throw new StockError('Smena yopilgan; topshiriqni bekor qilib bo\'lmaydi');
      const lots = db.prepare('SELECT id FROM lots WHERE doc_id = ?').all(t.doc_id).map((l) => l.id);
      if (lots.length && db.prepare(`SELECT 1 FROM stock_moves WHERE lot_id IN (${lots.map(() => '?').join(',')}) AND doc_id <> ? LIMIT 1`).get(...lots, t.doc_id)) {
        throw new StockError('Bu topshiriqdan chiqqan mahsulot keyingi bosqichga o\'tgan yoki ishlatilgan');
      }
      cancelDocTx(db, getDoc(db, t.doc_id), actor, reason);
      db.prepare('DELETE FROM lot_sources WHERE doc_id = ?').run(t.doc_id);
      db.prepare('DELETE FROM neg_links WHERE doc_id = ?').run(t.doc_id);
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

// ---------------------------------------------------------------- closing a shift
// Add an amount to a task's "rest" outputs (by quantity; fixed-cost outputs like
// cream keep their cost), passing it on to whatever was made from them.
function revalueRest(db, ctx, docId, amount, label) {
  if (Math.abs(amount) < 0.005) return;
  const outs = db.prepare(`SELECT l.id, l.qty0, dl.meta FROM lots l JOIN doc_lines dl ON dl.doc_id = l.doc_id AND dl.product_id = l.product_id
    WHERE l.doc_id = ? ORDER BY l.id`).all(docId).filter((o) => (J(o.meta)?.mode ?? 'rest') === 'rest' && J(o.meta)?.role === 'out');
  const q = outs.reduce((a, o) => a + (o.qty0 ?? 0), 0);
  if (!outs.length || !(q > 0)) { pnl(db, ctx, 'production_loss', amount, label); return; }
  let left = amount;
  outs.forEach((o, j) => {
    const c = j === outs.length - 1 ? r2(left) : r2((amount * o.qty0) / q);
    left -= c;
    revalueLot(db, ctx, o.id, c);
  });
}

// body: losses: [{ reasonId, qty }] — the loss (received − used − cream) explained
// in full. Then:
// 1. the loss milk leaves "Sut ombori";
// 2. the milk this shift used takes the real cost of the chosen collector shifts:
//    what was taken at FIFO goes back, the chosen shifts' milk goes out instead,
//    and the difference reaches the products (and the loss);
// 3. losses with effect "cost" are spread over the products by the value of the
//    main raw materials (milk, skim milk) each one used — the milk gets dearer, so
//    do the products; "company" is an expense, "staff" the person's debt.
export function closeShift(db, shiftId, body, { actor, approve = false }) {
  return db.transaction(() => {
    const s = getShift(db, shiftId);
    if (!s) throw new StockError('Smena topilmadi');
    const okStatus = approve ? s.status === 'approval' : s.status === 'open';
    if (!okStatus) throw new StockError(s.status === 'approval' ? 'Smena rahbar tasdig\'ini kutmoqda' : 'Smena yopilgan');
    const b = approve ? J(s.close_data)?.body : (body ?? {});
    if (db.prepare("SELECT 1 FROM prod_tasks WHERE shift_id = ? AND status IN ('open','approval')").get(s.id)) {
      throw new StockError('Avval ochiq topshiriqlarni yakunlang yoki bekor qiling');
    }
    const sum = shiftSummary(db, s);
    if (sum.need_separation) throw new StockError(`Avval separatsiyani kiriting: smenada ${sum.skim_used} kg yog'siz sut ishlatilgan`);
    if (sum.total > EPS && !sum.milk_shifts.length) throw new StockError("Qabul qilingan sutni tanlang (sut yig'uvchilar smenalari)");
    if (sum.loss_qty < -EPS) throw new StockError(`Tanlangan smenalardagi sut (${sum.received} kg) sarflangandan (${sum.total} kg) kam — yana smena tanlang`, { received: sum.received, total: sum.total });
    const losses = (Array.isArray(b.losses) ? b.losses : []).map((l) => {
      const reason = db.prepare("SELECT * FROM stock_reasons WHERE id = ? AND section = 'tech' AND active = 1").get(Number(l.reasonId));
      if (!reason) throw new StockError('Yo\'qotish sababi topilmadi');
      const qty = r3(l.qty);
      if (!(qty >= 0)) throw new StockError(`${reason.name}: miqdor noto'g'ri`);
      return { reason, qty };
    }).filter((l) => l.qty > 0);
    const lossSum = r3(losses.reduce((a, l) => a + l.qty, 0));
    if (Math.abs(lossSum - Math.max(0, sum.loss_qty)) > EPS) {
      throw new StockError(`Yo'qotish ${Math.max(0, sum.loss_qty)} kg — sabablari bo'yicha to'liq kiriting (hozir ${lossSum} kg)`, { loss: sum.loss_qty, entered: lossSum });
    }
    // Proportional limits: limit_qty per limit_base kg of milk used.
    const over = losses.filter((l) => l.reason.limit_qty != null && l.reason.limit_base > 0)
      .map((l) => ({ reason: l.reason.name, qty: l.qty, allowed: r3((l.reason.limit_qty * sum.total) / l.reason.limit_base) }))
      .filter((x) => x.qty > x.allowed + EPS);
    const data = { body: b, ...sum, losses: losses.map((l) => ({ reasonId: l.reason.id, reason: l.reason.name, qty: l.qty })), over };
    if (over.length && !approve) {
      db.prepare("UPDATE prod_shifts SET status = 'approval', close_data = ? WHERE id = ?").run(JSON.stringify(data), s.id);
      addAlert(db, 'prod.limit', `TS-${s.number} (${holderName(db, { userId: s.user_id })}): ${over.map((o) => `${o.reason} ${o.qty} kg (ruxsat ${o.allowed} kg)`).join(', ')}. Tasdiqlang yoki rad eting.`,
        { shiftId: s.id });
      return { needApproval: true, over, shift: shiftDetail(db, s.id) };
    }

    const milkId = rawMilkProduct(db);
    const milkH = { warehouseId: milkWarehouse(db) };
    const docId = Number(db.prepare(`INSERT INTO docs (uuid, type, number, status, doc_date, from_wh, source, note, created_by, created_by_id)
      VALUES (?, 'shift_close', ?, 'draft', ?, ?, 'prod_shift', ?, ?, ?)`).run(`pshift-${s.uuid}`, nextNumber(db, 'shift_close'), nowIso(), milkH.warehouseId, `TS-${s.number}`, actor, s.user_id).lastInsertRowid);
    const ctx = { doc: getDoc(db, docId), at: nowIso(), touched: new Set() };
    const insLine = db.prepare('INSERT INTO doc_lines (doc_id, product_id, qty, meta, sort) VALUES (?, ?, ?, ?, ?)');
    // 1. the loss milk leaves the milk warehouse (FIFO for now)
    const lossLines = losses.map((l, i) => {
      const lid = Number(insLine.run(docId, milkId, l.qty, JSON.stringify({ role: 'loss', reasonId: l.reason.id, reason: l.reason.name }), i + 1).lastInsertRowid);
      const c = r2(takeOut(db, ctx, { productId: milkId, h: milkH, qty: l.qty, lineId: lid, kind: 'loss' }).reduce((a, x) => a + x.cost, 0));
      return { ...l, lineId: lid, cost: c };
    });
    // 2. the shift's milk at the chosen collector shifts' cost
    const taskDocs = db.prepare("SELECT doc_id FROM prod_tasks WHERE shift_id = ? AND status = 'done' AND doc_id IS NOT NULL").all(s.id).map((t) => t.doc_id);
    const docs = [...taskDocs, docId];
    const consumed = db.prepare(`SELECT * FROM stock_moves WHERE warehouse_id = ? AND product_id = ? AND qty < 0 AND kind IN ('consume','loss')
      AND doc_id IN (${docs.map(() => '?').join(',')})`).all(milkH.warehouseId, milkId, ...docs);
    const T = r3(consumed.reduce((a, m) => a - m.qty, 0));
    const Cold = r2(consumed.reduce((a, m) => a - m.cost, 0));
    let unitNew = T > 0 ? Cold / T : 0;
    if (T > EPS && sum.milk_shifts.length) {
      for (const m of consumed) insertMove(db, ctx, { productId: milkId, lotId: m.lot_id, h: milkH, qty: -m.qty, cost: -m.cost, kind: 'swap' });
      const lots = db.prepare(`SELECT l.id, l.unit_cost FROM lots l WHERE l.product_id = ? AND l.doc_id IN (${milkDocsOf(db, sum.milk_shifts).map((d) => d.doc_id).join(',') || '0'}) ORDER BY l.produced_at, l.id`).all(milkId);
      let left = T; let Cnew = 0;
      for (const l of lots) {
        if (left <= EPS) break;
        const bal = db.prepare('SELECT ROUND(COALESCE(SUM(qty), 0), 3) q, ROUND(COALESCE(SUM(cost), 0), 2) c FROM stock_moves WHERE lot_id = ? AND warehouse_id = ?').get(l.id, milkH.warehouseId);
        if (bal.q <= EPS) continue;
        const q = r3(Math.min(left, bal.q));
        const c = Math.abs(q - bal.q) <= EPS ? bal.c : r2(q * l.unit_cost);
        insertMove(db, ctx, { productId: milkId, lotId: l.id, h: milkH, qty: -q, cost: -c, kind: 'swap' });
        Cnew += c; left = r3(left - q);
      }
      if (left > EPS) Cnew += takeOut(db, ctx, { productId: milkId, h: milkH, qty: left, kind: 'swap' }).reduce((a, x) => a + x.cost, 0);
      unitNew = Cnew / T;
      // the difference reaches whoever used the milk
      const byDoc = new Map();
      for (const m of consumed) {
        const d = r2(-m.qty * unitNew + m.cost);
        if (m.doc_id === docId) { const ll = lossLines.find((x) => x.lineId === m.line_id); if (ll) ll.cost = r2(ll.cost + d); continue; }
        byDoc.set(m.doc_id, r2((byDoc.get(m.doc_id) ?? 0) + d));
      }
      for (const [d, amount] of byDoc) revalueRest(db, ctx, d, amount, `TS-${s.number}: sut tannarxi`);
    }
    // 3. the loss
    let spread = 0;
    for (const l of lossLines) {
      const effect = l.reason.effect ?? (l.reason.charge === 'staff' ? 'staff' : 'company');
      if (effect === 'cost') spread += l.cost;
      else if (effect === 'staff') chargeStaff(db, ctx, s.user_id, l.cost, 'production', l.reason.name);
      else pnl(db, ctx, l.reason.category_id ?? 'production_loss', l.cost, `TS-${s.number}: ${l.reason.name}`);
    }
    spread = r2(spread);
    if (Math.abs(spread) >= 0.005) {
      // by the value of the main raw materials each product used (milk at its real cost now, skim milk at its own)
      const tasks = db.prepare("SELECT * FROM prod_tasks WHERE shift_id = ? AND status = 'done' AND kind <> 'separation' AND doc_id IS NOT NULL").all(s.id);
      const value = (t) => db.prepare(`SELECT m.product_id, m.lot_id, -m.qty AS q, -m.cost AS c FROM stock_moves m JOIN products p ON p.id = m.product_id
        WHERE m.doc_id = ? AND m.qty < 0 AND m.kind = 'consume' AND p.kind = 'main_raw'`).all(t.doc_id)
        .reduce((a, m) => a + (m.product_id === milkId ? m.q * unitNew : (m.lot_id ? m.q * (db.prepare('SELECT unit_cost FROM lots WHERE id = ?').get(m.lot_id)?.unit_cost ?? 0) : m.q * (db.prepare(
          `SELECT unit_cost FROM lots WHERE product_id = ? ORDER BY produced_at DESC, id DESC LIMIT 1`).get(m.product_id)?.unit_cost ?? m.c / m.q))), 0);
      const vals = tasks.map((t) => ({ t, v: value(t) })).filter((x) => x.v > 0.005);
      const V = vals.reduce((a, x) => a + x.v, 0);
      if (!(V > 0)) pnl(db, ctx, 'production_loss', spread, `TS-${s.number}: sut yo'qotishi (topshiriqsiz)`);
      else {
        let left = spread;
        vals.forEach((x, i) => {
          const share = i === vals.length - 1 ? r2(left) : r2((spread * x.v) / V);
          left -= share;
          revalueRest(db, ctx, x.t.doc_id, share, `TQ-${x.t.number}`);
        });
      }
    }
    db.prepare("UPDATE docs SET status = 'posted', posted_by = ?, posted_at = ? WHERE id = ?").run(actor, nowIso(), docId);
    const insUsed = db.prepare('INSERT OR REPLACE INTO prod_shift_milk (shift_id, prod_shift_id) VALUES (?, ?)');
    for (const id of sum.milk_shifts) insUsed.run(id, s.id);
    // The shift's lots — and everything made from them — are final now (unless they
    // still wait for a shortage to be settled).
    db.prepare(`WITH RECURSIVE d(id) AS (SELECT id FROM lots WHERE shift_id = ? UNION SELECT ls.lot_id FROM lot_sources ls JOIN d ON ls.source_lot_id = d.id)
      UPDATE lots SET provisional = 0 WHERE id IN (SELECT id FROM d) AND id NOT IN (SELECT lot_id FROM neg_links WHERE open_qty > ${EPS} AND lot_id IS NOT NULL)`).run(s.id);
    db.prepare("UPDATE prod_shifts SET status = 'closed', closed_at = ?, close_data = ?, close_doc_id = ? WHERE id = ?")
      .run(nowIso(), JSON.stringify({ ...data, spread_cost: spread, unit_cost: r2(unitNew) }), docId, s.id);
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
    tasks: db.prepare("SELECT * FROM prod_tasks WHERE status = 'approval' ORDER BY id").all().map((t) => taskRow(db, t)),
    shifts: db.prepare("SELECT id FROM prod_shifts WHERE status = 'approval' ORDER BY id").all().map((s) => shiftDetail(db, s.id)),
  };
}
