// Reja (production plan, stage 10 part 3): for each day, how many of each finished
// product should be made. Later the plan comes from the agents' orders; for now the
// admin enters it. A past day's plan cannot be changed.
//
// The technologist sees the plan as quyma: each finished product's Tex karta names
// its quyma recipe, and its pouring / packing recipe says how much quyma one unit
// takes (e.g. 100 × "Qatiq 5% 400 g" + 150 × "Qatiq bochka 800 g" → 160 kg "5% siyro").
// The pourer sees it per product, grouped by quyma.
import { StockError, r3 } from './stock.js';
import { stageByCode } from './stages.js';

const EPS = 0.0005;
const localDay = (iso = new Date().toISOString()) => new Date(Date.parse(iso) + 5 * 3600e3).toISOString().slice(0, 10);
export const today = () => localDay();
const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v ?? '');

export function planOf(db, day) {
  const p = db.prepare('SELECT * FROM plans WHERE day = ?').get(day);
  if (!p) return null;
  return {
    ...p, editable: day >= today(),
    lines: db.prepare('SELECT pl.product_id, pr.name AS product, pr.unit, pl.qty FROM plan_lines pl JOIN products pr ON pr.id = pl.product_id WHERE pl.plan_id = ? ORDER BY pr.name').all(p.id),
  };
}
export function listPlans(db, { from, to } = {}) {
  return db.prepare('SELECT day FROM plans WHERE day BETWEEN ? AND ? ORDER BY day DESC').all(from ?? '0000', to ?? '9999').map((r) => planOf(db, r.day));
}
export function savePlan(db, day, lines, actor) {
  if (!isDay(day)) throw new StockError("Sana noto'g'ri");
  if (day < today()) throw new StockError("O'tgan kunning rejasini o'zgartirib bo'lmaydi");
  const clean = new Map();
  for (const l of Array.isArray(lines) ? lines : []) {
    const p = db.prepare("SELECT id, name, kind FROM products WHERE id = ? AND kind <> 'milk'").get(Number(l.productId));
    if (!p) throw new StockError('Mahsulot topilmadi');
    if (p.kind !== 'finished') throw new StockError(`"${p.name}" — reja faqat tayyor mahsulot uchun`);
    const q = r3(l.qty);
    if (!(q > 0)) continue;
    clean.set(p.id, r3((clean.get(p.id) ?? 0) + q));
  }
  if (!clean.size) throw new StockError('Kamida bitta mahsulot va miqdor kiriting');
  db.transaction(() => {
    let p = db.prepare('SELECT id FROM plans WHERE day = ?').get(day);
    if (!p) p = { id: Number(db.prepare('INSERT INTO plans (day, created_by) VALUES (?, ?)').run(day, actor).lastInsertRowid) };
    else db.prepare("UPDATE plans SET updated_at = datetime('now'), created_by = ? WHERE id = ?").run(actor, p.id);
    db.prepare('DELETE FROM plan_lines WHERE plan_id = ?').run(p.id);
    for (const [pid, q] of clean) db.prepare('INSERT INTO plan_lines (plan_id, product_id, qty) VALUES (?, ?, ?)').run(p.id, pid, q);
  })();
  return planOf(db, day);
}
export function deletePlan(db, day) {
  if (day < today()) throw new StockError("O'tgan kunning rejasini o'chirib bo'lmaydi");
  const p = db.prepare('SELECT id FROM plans WHERE day = ?').get(day);
  if (!p) throw new StockError('Reja topilmadi');
  db.transaction(() => { db.prepare('DELETE FROM plan_lines WHERE plan_id = ?').run(p.id); db.prepare('DELETE FROM plans WHERE id = ?').run(p.id); })();
}

// For a finished product: its quyma recipe (Tex karta, production) and how much quyma
// one unit takes (its pouring / packing recipe's quyma line; else its netto weight).
function quymaOf(db, productId) {
  const produce = stageByCode(db, 'produce');
  const row = produce && db.prepare(`SELECT r.id, r.name, r.product_id, p.name AS quyma, p.unit FROM product_stages ps JOIN recipes r ON r.id = ps.recipe_id
    JOIN products p ON p.id = r.product_id WHERE ps.product_id = ? AND ps.stage_id = ?`).get(productId, produce.id);
  if (!row) return null;
  const per = db.prepare(`SELECT l.qty FROM product_stages ps JOIN recipes r ON r.id = ps.recipe_id JOIN recipe_lines l ON l.recipe_id = r.id
    WHERE ps.product_id = ? AND r.kind IN ('pour','pack') AND l.product_id = ? LIMIT 1`).get(productId, row.product_id)?.qty
    ?? (db.prepare('SELECT netto_g FROM products WHERE id = ?').get(productId)?.netto_g ?? 0) / 1000;
  return { recipe_id: row.id, recipe: row.name, quyma_id: row.product_id, quyma: row.quyma, unit: row.unit, per_unit: per };
}

// What was made of a finished product on a day: the output of its pouring / packing
// (the first stage that makes it), from tasks done that day.
function madeOn(db, day, productId) {
  return r3(db.prepare(`SELECT COALESCE(SUM(dl.qty), 0) AS q FROM prod_tasks t JOIN doc_lines dl ON dl.doc_id = t.doc_id
    WHERE t.status = 'done' AND t.kind IN ('pour','pack') AND date(t.done_at, '+5 hours') = ? AND dl.product_id = ? AND json_extract(dl.meta, '$.role') = 'out'`).get(day, productId).q);
}

// The day's plan for the technologist (quyma) and for the pourer (products by quyma).
export function planView(db, day = today()) {
  const plan = planOf(db, day);
  if (!plan) return { day, tech: [], pour: [] };
  const groups = new Map();
  const pour = [];
  for (const l of plan.lines) {
    const q = quymaOf(db, l.product_id);
    const made = madeOn(db, day, l.product_id);
    pour.push({ product_id: l.product_id, product: l.product, unit: l.unit, plan: l.qty, made, quyma_id: q?.quyma_id ?? null, quyma: q?.quyma ?? null });
    if (!q) continue;
    const g = groups.get(q.recipe_id) ?? { recipe_id: q.recipe_id, recipe: q.recipe, quyma_id: q.quyma_id, quyma: q.quyma, unit: q.unit, qty: 0, products: [] };
    g.qty = r3(g.qty + l.qty * q.per_unit);
    g.products.push({ product_id: l.product_id, product: l.product, plan: l.qty });
    groups.set(q.recipe_id, g);
  }
  // quyma made today by the production stage
  const tech = [...groups.values()].map((g) => ({ ...g, made: r3(db.prepare(`SELECT COALESCE(SUM(dl.qty), 0) AS q FROM prod_tasks t JOIN doc_lines dl ON dl.doc_id = t.doc_id
    WHERE t.status = 'done' AND t.recipe_id = ? AND date(t.done_at, '+5 hours') = ? AND dl.product_id = ? AND json_extract(dl.meta, '$.role') = 'out'`).get(g.recipe_id, day, g.quyma_id).q) }));
  return { day, tech, pour };
}

// The plan report: for each day, each product: planned, made, the difference and %.
export function planReport(db, { from, to }) {
  return listPlans(db, { from, to }).map((p) => {
    const rows = p.lines.map((l) => {
      const made = madeOn(db, p.day, l.product_id);
      return { product_id: l.product_id, product: l.product, unit: l.unit, plan: l.qty, made, diff: r3(made - l.qty), pct: l.qty > EPS ? Math.round((made / l.qty) * 1000) / 10 : null };
    });
    const plan = r3(rows.reduce((a, r) => a + r.plan, 0));
    const made = r3(rows.reduce((a, r) => a + Math.min(r.made, r.plan), 0));
    return { day: p.day, rows, plan, made: r3(rows.reduce((a, r) => a + r.made, 0)), pct: plan > EPS ? Math.round((made / plan) * 1000) / 10 : null,
      done: rows.every((r) => r.made >= r.plan - EPS), under: rows.filter((r) => r.diff < -EPS).length, over: rows.filter((r) => r.diff > EPS).length };
  });
}
