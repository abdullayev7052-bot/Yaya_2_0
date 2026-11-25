// Stages and the production map (Yaya 2.0, stage 10). See docs/STAGE10.md.
//
// - A stage is a warehouse (is_stage = 1) shown as "Bosqich". Its keepers run it.
//   Type 'change': the product changes (a recipe: materials, limits, piece rate).
//   Type 'keep': the same product moves on (an optional piece rate per unit).
// - Each product has a map: the stages it passes, in the stages' order. A stage that
//   is off for the product is skipped.
// - Every stage action takes from the previous stage on the map and puts the result
//   in its own warehouse. Taking more than the books say is there sends the previous
//   stage below zero (with an alert); the real goods settle it later at real cost.
// - There is no "in my hands": goods are always in a warehouse or a stage.
import { STAGE_TYPES } from './schema.js';
import { StockError, getDoc, holderName, moveStock, nextNumber, productBalance, r3, stockReport } from './stock.js';

const EPS = 0.0005;
const nowIso = () => new Date().toISOString();

export const getStage = (db, id) => db.prepare('SELECT * FROM warehouses WHERE id = ? AND is_stage = 1').get(Number(id)) ?? null;
export const stageByCode = (db, code) => db.prepare('SELECT * FROM warehouses WHERE stage_code = ? AND is_stage = 1').get(code) ?? null;
export const keptWarehouses = (db, userId) => db.prepare('SELECT warehouse_id FROM warehouse_keepers WHERE user_id = ?').all(userId).map((r) => r.warehouse_id);
export const isKeeper = (db, userId, whId) => !!db.prepare('SELECT 1 FROM warehouse_keepers WHERE user_id = ? AND warehouse_id = ?').get(userId, whId);

export function stageRow(db, w) {
  return {
    id: w.id, name: w.name, code: w.stage_code, type: w.stage_type, type_label: STAGE_TYPES[w.stage_type] ?? w.stage_type, piece_rate: w.piece_rate,
    sort: w.sort, active: w.active,
    keepers: db.prepare('SELECT u.id, COALESCE(u.name, u.login) AS name FROM warehouse_keepers k JOIN users u ON u.id = k.user_id WHERE k.warehouse_id = ? ORDER BY name').all(w.id),
    recipes: db.prepare('SELECT id, name, kind, product_id, active FROM recipes WHERE stage_id = ? ORDER BY active DESC, sort, name').all(w.id),
    products: db.prepare('SELECT COUNT(*) AS n FROM product_stages WHERE stage_id = ?').get(w.id).n,
  };
}
export const stageList = (db, { all = false } = {}) => db.prepare(`SELECT * FROM warehouses WHERE is_stage = 1 ${all ? '' : 'AND active = 1'} ORDER BY sort, id`).all()
  .map((w) => stageRow(db, w));

// Create or change a stage: name, type, piece rate (for 'keep'), keepers, and its
// place: after = the stage it follows (0 = first).
export function saveStage(db, id, b) {
  const name = b.name === undefined ? undefined : String(b.name ?? '').trim().slice(0, 80);
  if (name !== undefined && !name) throw new StockError('Bosqich nomini yozing');
  const type = b.type === undefined ? undefined : b.type;
  if (type !== undefined && !STAGE_TYPES[type]) throw new StockError("Bosqich turi noto'g'ri");
  const rate = b.pieceRate === undefined ? undefined : (b.pieceRate === '' || b.pieceRate == null ? null : Number(b.pieceRate));
  if (rate !== undefined && rate != null && !(rate >= 0)) throw new StockError("Ishbay haq noto'g'ri");
  return db.transaction(() => {
    let sid = id;
    if (!sid) {
      if (!name || !type) throw new StockError('Nomi va turini kiriting');
      sid = Number(db.prepare("INSERT INTO warehouses (name, kind, is_stage, stage_type, piece_rate, allow_negative, warn_negative, sort) VALUES (?, 'stage', 1, ?, ?, 1, 1, 9999)")
        .run(name, type, type === 'keep' ? rate ?? null : null).lastInsertRowid);
    } else {
      const w = getStage(db, sid);
      if (!w) throw new StockError('Bosqich topilmadi');
      const t = type ?? w.stage_type;
      db.prepare('UPDATE warehouses SET name = COALESCE(?, name), stage_type = ?, piece_rate = ?, active = COALESCE(?, active) WHERE id = ?')
        .run(name ?? null, t, t === 'keep' ? (rate === undefined ? w.piece_rate : rate) : null, b.active == null ? null : Number(!!b.active), sid);
    }
    if (Array.isArray(b.keepers)) {
      db.prepare('DELETE FROM warehouse_keepers WHERE warehouse_id = ?').run(sid);
      const ins = db.prepare('INSERT OR IGNORE INTO warehouse_keepers (warehouse_id, user_id) SELECT ?, id FROM users WHERE id = ?');
      for (const u of b.keepers) ins.run(sid, Number(u));
    }
    if (Array.isArray(b.recipeIds)) {
      db.prepare('UPDATE recipes SET stage_id = NULL WHERE stage_id = ?').run(sid);
      for (const r of b.recipeIds) db.prepare('UPDATE recipes SET stage_id = ? WHERE id = ?').run(sid, Number(r));
    }
    if (b.after !== undefined || !id) placeStage(db, sid, b.after === undefined ? null : Number(b.after));
    return sid;
  })();
}

// Put a stage right after another (0 / null = at the start; undefined target = keep
// at the end) and renumber the order 10, 20, 30...
function placeStage(db, sid, after) {
  const ids = db.prepare('SELECT id FROM warehouses WHERE is_stage = 1 AND id <> ? ORDER BY sort, id').all(sid).map((r) => r.id);
  let at = ids.length;
  if (after === 0) at = 0;
  else if (after) { const i = ids.indexOf(after); if (i >= 0) at = i + 1; }
  ids.splice(at, 0, sid);
  ids.forEach((x, i) => db.prepare('UPDATE warehouses SET sort = ? WHERE id = ?').run((i + 1) * 10, x));
}

// ---------------------------------------------------------------- the production map
export function productMap(db, productId) {
  return db.prepare(`SELECT w.id, w.name, w.stage_code AS code, w.stage_type AS type FROM product_stages ps JOIN warehouses w ON w.id = ps.stage_id
    WHERE ps.product_id = ? AND w.is_stage = 1 AND w.active = 1 ORDER BY w.sort, w.id`).all(productId);
}
export function setProductMap(db, productId, stageIds) {
  if (!db.prepare('SELECT 1 FROM products WHERE id = ?').get(productId)) throw new StockError('Mahsulot topilmadi');
  const ids = [...new Set((Array.isArray(stageIds) ? stageIds : []).map(Number))].filter((id) => getStage(db, id));
  db.transaction(() => {
    db.prepare('DELETE FROM product_stages WHERE product_id = ?').run(productId);
    for (const id of ids) db.prepare('INSERT INTO product_stages (product_id, stage_id) VALUES (?, ?)').run(productId, id);
  })();
  return productMap(db, productId);
}
// The stage before / after `stageId` on the product's map (null when there is none,
// or when the stage is off for this product).
export function prevStage(db, productId, stageId) {
  const map = productMap(db, productId);
  const i = map.findIndex((s) => s.id === Number(stageId));
  return i > 0 ? map[i - 1].id : null;
}
export function nextStage(db, productId, stageId) {
  const map = productMap(db, productId);
  const i = map.findIndex((s) => s.id === Number(stageId));
  return i >= 0 && i < map.length - 1 ? map[i + 1].id : null;
}

// ---------------------------------------------------------------- what is waiting at a stage
// keep: every product whose map has this stage and whose previous stage holds some.
// change: every recipe of the stage, with how much of its main input is waiting.
export function stageWaiting(db, stage) {
  if (stage.stage_type === 'keep') {
    return db.prepare(`SELECT p.id, p.name, p.unit FROM product_stages ps JOIN products p ON p.id = ps.product_id WHERE ps.stage_id = ? AND p.active = 1 ORDER BY p.name`).all(stage.id)
      .map((p) => {
        const from = prevStage(db, p.id, stage.id);
        const qty = from ? productBalance(db, { warehouseId: from }, p.id) : 0;
        return { product_id: p.id, product: p.name, unit: p.unit, from, from_name: from ? holderName(db, { warehouseId: from }) : null, qty };
      }).filter((x) => x.from && x.qty > EPS);
  }
  return db.prepare('SELECT * FROM recipes WHERE stage_id = ? AND active = 1 ORDER BY sort, name').all(stage.id).map((r) => {
    const out = r.product_id ? db.prepare('SELECT name, unit FROM products WHERE id = ?').get(r.product_id) : null;
    // The main input: a recipe line that sits in a previous stage.
    const lines = db.prepare('SELECT l.product_id, p.name, p.unit FROM recipe_lines l JOIN products p ON p.id = l.product_id WHERE l.recipe_id = ? ORDER BY l.sort, l.id').all(r.id);
    let waiting = null;
    for (const l of lines) {
      const from = prevStage(db, l.product_id, stage.id) ?? (r.product_id ? prevStage(db, r.product_id, stage.id) : null);
      if (!from) continue;
      const q = productBalance(db, { warehouseId: from }, l.product_id);
      waiting = { product_id: l.product_id, product: l.name, unit: l.unit, from, from_name: holderName(db, { warehouseId: from }), qty: q };
      break;
    }
    return { recipe_id: r.id, recipe: r.name, kind: r.kind, product_id: r.product_id, product: out?.name ?? null, unit: out?.unit ?? null, waiting };
  });
}

// The stages a person runs (managers: all), each with what is in it and what waits.
export function stageBoard(db, userId, { all = false } = {}) {
  const mine = new Set(keptWarehouses(db, userId));
  return db.prepare('SELECT * FROM warehouses WHERE is_stage = 1 AND active = 1 ORDER BY sort, id').all()
    .filter((w) => all || mine.has(w.id))
    .map((w) => ({
      ...stageRow(db, w), mine: mine.has(w.id),
      contents: stockReport(db, { holder: { warehouseId: w.id } }),
      waiting: stageWaiting(db, w),
    }));
}

// ---------------------------------------------------------------- "in my hands" goes
// Goods a person still holds (from before stage 10) move once, as a posted hand-over,
// to the stage that matches their role (or a warehouse they keep, or production).
export function moveHandsToStages(db) {
  // Hand-overs to or from a person still waiting to be accepted cannot happen any more:
  // they close (nothing had moved yet).
  db.prepare(`UPDATE docs SET status = 'cancelled', cancelled_by = 'system', cancelled_at = ?, cancel_reason = ?
    WHERE status = 'sent' AND (from_user IS NOT NULL OR to_user IS NOT NULL)`).run(nowIso(), "Xodim qo'liga topshirish olib tashlandi");
  const rows = db.prepare(`SELECT holder_id, product_id, ROUND(SUM(qty), 3) AS q FROM stock_moves WHERE holder_id IS NOT NULL
    GROUP BY holder_id, product_id HAVING SUM(qty) > ${EPS}`).all();
  if (!rows.length) return 0;
  const byRole = { technologist: 'produce', pourer: 'pour', capper: 'cap', reprocessor: 'reprocess_bad' };
  const produce = stageByCode(db, 'produce');
  const target = (userId) => {
    const role = db.prepare('SELECT r.code FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?').get(userId)?.code;
    const st = byRole[role] ? stageByCode(db, byRole[role]) : null;
    return st?.id ?? keptWarehouses(db, userId)[0] ?? produce?.id;
  };
  const byUser = new Map();
  for (const r of rows) { if (!byUser.has(r.holder_id)) byUser.set(r.holder_id, []); byUser.get(r.holder_id).push(r); }
  db.transaction(() => {
    for (const [userId, list] of byUser) {
      const to = target(userId);
      if (!to) continue;
      const id = Number(db.prepare(`INSERT INTO docs (uuid, type, number, status, doc_date, from_user, to_wh, note, created_by)
        VALUES (?, 'transfer', ?, 'draft', ?, ?, ?, ?, 'system')`).run(`hands-${userId}-${Date.now()}`, nextNumber(db, 'transfer'), nowIso(), userId, to,
        "Xodim qo'lidagi qoldiq bosqichga o'tkazildi").lastInsertRowid);
      const ctx = { doc: getDoc(db, id), at: nowIso(), touched: new Set() };
      list.forEach((r, i) => {
        const lid = Number(db.prepare('INSERT INTO doc_lines (doc_id, product_id, qty, sort) VALUES (?, ?, ?, ?)').run(id, r.product_id, r3(r.q), i).lastInsertRowid);
        moveStock(db, ctx, { productId: r.product_id, from: { userId }, to: { warehouseId: to }, qty: r3(r.q), lineId: lid });
      });
      db.prepare("UPDATE docs SET status = 'posted', posted_by = 'system', posted_at = ? WHERE id = ?").run(nowIso(), id);
    }
  })();
  return rows.length;
}
