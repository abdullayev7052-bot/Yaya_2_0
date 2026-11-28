// Warehouse API (Yaya 2.0): nomenclature, warehouses, stock, documents, alerts,
// Excel import. Used by the panel (admin) and by the workplace app (staff), each
// within their permissions. Costs and sums are removed from every answer for users
// without stock.costs, so ordinary staff never receive them.
import { audit } from '../db/index.js';
import { makeGuard } from '../auth.js';
import { getSetting, setSetting } from '../settings.js';
import { PRODUCT_KINDS, REASON_EFFECTS, REASON_SECTIONS, SHAPES, STAGE_TYPES, WAREHOUSE_KINDS } from '../erp/schema.js';
import {
  DOC_TYPES, StockError, addAlert, cancelDoc, createDoc, docDetail, inbox, inventoryPreview, listDocs, lotReport, milkWarehouse, parseHolder, postDoc,
  rejectDoc, staffBalance, stockCard, stockReport, updateDraft,
} from '../erp/stock.js';
import { erpImport, erpTemplate, importKinds, templateFile } from '../erp/importer.js';
import { overview } from '../erp/overview.js';
import { alertsFor } from '../erp/watch.js';

const COST_KEYS = new Set(['cost', 'unit_cost', 'total_cost', 'amount', 'balance', 'loss', 'surplus', 'spread', 'spread_cost']);
export function stripCosts(v) {
  if (Array.isArray(v)) return v.map(stripCosts);
  if (v && typeof v === 'object' && !(v instanceof Buffer)) {
    const out = {};
    for (const [k, x] of Object.entries(v)) if (!COST_KEYS.has(k)) out[k] = stripCosts(x);
    return out;
  }
  return v;
}

export default async function erpRoutes(app, { db }) {
  const need = makeGuard(app, db);
  const str = (v, max = 200) => (v == null ? null : String(v).trim().slice(0, max) || null);
  const bad = (reply, msg, details) => reply.code(400).send({ error: msg, details });
  const has = (req, p) => req.me.perms.has(p);
  const log = (req, action, details) => audit(db, req.actor, action, details);
  const optNum = (v) => (v == null || v === '' ? null : (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : NaN));
  const flag = (v, dflt) => (v == null ? dflt : Number(!!v));
  const stockErr = (reply, e) => {
    if (e instanceof StockError) return bad(reply, e.message, e.details);
    throw e;
  };

  app.addHook('preSerialization', async (req, reply, payload) => (req.me && !req.me.perms.has('stock.costs') ? stripCosts(payload) : payload));

  // Warehouses this user is responsible for.
  const keeperOf = (userId) => db.prepare('SELECT warehouse_id FROM warehouse_keepers WHERE user_id = ?').all(userId).map((r) => r.warehouse_id);
  // May the user act for this place (hand out its goods, count it)? A warehouse or
  // stage they keep, or anything with stock.manage. (Nothing is "in hands" any more.)
  const canActFor = (req, h) => !!h && (has(req, 'stock.manage') || (h.userId === req.me.id) || (h.warehouseId && keeperOf(req.me.id).includes(h.warehouseId)));
  const canSee = (req, h) => has(req, 'stock.view_all') || canActFor(req, h);

  // ---------------------------------------------------------------- reference data
  app.get('/meta', need(), async (req) => ({
    productKinds: PRODUCT_KINDS,
    warehouseKinds: WAREHOUSE_KINDS,
    shapes: SHAPES,
    docTypes: Object.fromEntries(Object.entries(DOC_TYPES).map(([k, v]) => [k, v.label])),
    units: db.prepare('SELECT * FROM units WHERE active = 1 ORDER BY id').all(),
    warehouses: db.prepare('SELECT id, name, kind, is_stage, stage_type FROM warehouses WHERE active = 1 ORDER BY is_stage, sort, name').all(),
    stageTypes: STAGE_TYPES,
    staff: db.prepare('SELECT id, COALESCE(name, login) AS name FROM users WHERE active = 1 AND is_test = 0 ORDER BY name').all(),
    reasons: db.prepare("SELECT id, name, charge FROM stock_reasons WHERE active = 1 AND section = 'warehouse' ORDER BY sort, id").all(),
    techReasons: db.prepare("SELECT id, name, COALESCE(effect, 'company') AS effect, limit_qty, limit_base FROM stock_reasons WHERE active = 1 AND section = 'tech' ORDER BY sort, id").all(),
    reasonSections: REASON_SECTIONS, reasonEffects: REASON_EFFECTS,
    myWarehouses: keeperOf(req.me.id),
    milkWarehouseId: Number(getSetting(db, 'erp_milk_warehouse')) || null,
  }));

  // The panel's home: the whole chain at a glance (each block only with its permission).
  app.get('/overview', need(), async (req, reply) => {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(req.query.day ?? '') ? req.query.day : undefined;
    return overview(db, req.me.perms, day);
  });

  // ---------------------------------------------------------------- units
  app.get('/units', need(), async () => db.prepare('SELECT * FROM units ORDER BY active DESC, id').all());
  app.post('/units', need('catalog.manage'), async (req, reply) => {
    const name = str(req.body?.name, 30);
    if (!name) return bad(reply, 'Nomi shart');
    if (db.prepare('SELECT 1 FROM units WHERE lower(name) = lower(?)').get(name)) return bad(reply, 'Bunday birlik bor');
    const decimals = Math.min(3, Math.max(0, Number(req.body?.decimals ?? 3) | 0));
    const id = db.prepare('INSERT INTO units (name, short, decimals) VALUES (?, ?, ?)').run(name, str(req.body?.short, 10) ?? name, decimals).lastInsertRowid;
    log(req, 'units.create', { name });
    return { id };
  });
  app.patch('/units/:id', need('catalog.manage'), async (req, reply) => {
    const u = db.prepare('SELECT * FROM units WHERE id = ?').get(req.params.id);
    if (!u) return reply.code(404).send({ error: 'Topilmadi' });
    db.prepare('UPDATE units SET name = COALESCE(?, name), short = COALESCE(?, short), decimals = COALESCE(?, decimals), active = COALESCE(?, active) WHERE id = ?')
      .run(str(req.body?.name, 30), str(req.body?.short, 10), req.body?.decimals == null ? null : Math.min(3, Math.max(0, Number(req.body.decimals) | 0)),
        req.body?.active == null ? null : Number(!!req.body.active), u.id);
    return { ok: true };
  });

  // ---------------------------------------------------------------- products (nomenclature)
  const PRODUCT_FIELDS = ['sku', 'barcode', 'category', 'volume_unit', 'note'];
  const PRODUCT_NUMS = ['netto_g', 'brutto_g', 'volume', 'shelf_life_hours', 'dwell_hours'];
  app.get('/products', need(), async (req) => {
    const where = []; const args = [];
    if (req.query.kind) { where.push('kind = ?'); args.push(String(req.query.kind)); }
    if (req.query.active !== 'all') where.push('active = 1');
    // ?stock=1: only products that can hold stock (no variant parents).
    if (req.query.stock === '1') where.push('has_variants = 0');
    return db.prepare(`SELECT * FROM products ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY active DESC, kind, name`).all(...args)
      .map((p) => ({ ...p, kind_label: PRODUCT_KINDS[p.kind] ?? p.kind,
        stages: db.prepare('SELECT stage_id FROM product_stages WHERE product_id = ?').all(p.id).map((x) => x.stage_id) }));
  });
  const productData = (body, reply) => {
    const d = {};
    if (body.kind !== undefined) {
      if (!PRODUCT_KINDS[body.kind]) return bad(reply, 'Mahsulot turi noto\'g\'ri');
      d.kind = body.kind;
    }
    if (body.shape !== undefined) {
      if (body.shape && !SHAPES[body.shape]) return bad(reply, 'Shakl noto\'g\'ri');
      d.shape = body.shape || null;
    }
    if (body.unit !== undefined) d.unit = str(body.unit, 10) ?? 'kg';
    // "Sotuv uchun mavjud" (also sold by weight) and "Xomashyo" (also used as a raw material).
    if (body.forSale !== undefined) d.for_sale = Number(!!body.forSale);
    if (body.asRaw !== undefined) d.as_raw = Number(!!body.asRaw);
    for (const k of PRODUCT_FIELDS) if (body[k] !== undefined) d[k] = str(body[k], k === 'note' ? 300 : 60);
    for (const k of PRODUCT_NUMS) {
      if (body[k] === undefined) continue;
      const n = optNum(body[k]);
      if (Number.isNaN(n)) return bad(reply, `${k}: musbat son bo'lsin`);
      d[k] = n;
    }
    return d;
  };
  // Variants: asked once, when the product is created ("Zakvaska" with 499, 505...).
  // Each variant is a product of its own ("Zakvaska / 499", own stock and cost) with
  // the parent's unit and settings. More variants can be added later; a product
  // cannot become (or stop being) variant-based afterwards.
  const cleanVariants = (list) => [...new Set((Array.isArray(list) ? list : String(list ?? '').split(','))
    .map((v) => String(v ?? '').trim().slice(0, 40)).filter(Boolean))];
  const insertVariants = (parent, variants) => {
    const ids = [];
    for (const v of variants) {
      const vname = `${parent.name} / ${v}`;
      if (db.prepare('SELECT 1 FROM products WHERE lower(name) = lower(?)').get(vname)) continue;
      ids.push(Number(db.prepare(`INSERT INTO products (name, kind, unit, category, netto_g, brutto_g, volume, volume_unit, shape, shelf_life_hours, note, parent_id, variant)
        SELECT ?, kind, unit, category, netto_g, brutto_g, volume, volume_unit, shape, shelf_life_hours, note, id, ? FROM products WHERE id = ?`).run(vname, v, parent.id).lastInsertRowid));
    }
    return ids;
  };
  app.post('/products', need('catalog.manage'), async (req, reply) => {
    const name = str(req.body?.name, 120);
    if (!name) return bad(reply, 'Nomi shart');
    if (db.prepare('SELECT 1 FROM products WHERE lower(name) = lower(?)').get(name)) return bad(reply, 'Bunday nomli mahsulot bor');
    const d = productData({ kind: 'finished', ...req.body }, reply);
    if (reply.sent) return reply;
    const variants = req.body?.hasVariants ? cleanVariants(req.body.variants) : [];
    if (req.body?.hasVariants && !variants.length) return bad(reply, 'Variantlarni kiriting (masalan: 499, 505)');
    if (variants.length) d.has_variants = 1;
    const cols = ['name', ...Object.keys(d)];
    const id = db.transaction(() => {
      const pid = Number(db.prepare(`INSERT INTO products (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(name, ...Object.values(d)).lastInsertRowid);
      if (variants.length) insertVariants({ id: pid, name }, variants);
      return pid;
    })();
    log(req, 'products.create', { id, name, variants });
    return { id };
  });
  app.post('/products/:id/variants', need('catalog.manage'), async (req, reply) => {
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    if (!p) return reply.code(404).send({ error: 'Topilmadi' });
    if (!p.has_variants) return bad(reply, "Bu mahsulot variantli emas (bu faqat yaratishda tanlanadi)");
    const variants = cleanVariants(req.body?.variants);
    if (!variants.length) return bad(reply, 'Variantlarni kiriting');
    const ids = db.transaction(() => insertVariants(p, variants))();
    log(req, 'products.variants', { id: p.id, variants });
    return { ids };
  });
  app.patch('/products/:id', need('catalog.manage'), async (req, reply) => {
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    if (!p) return reply.code(404).send({ error: 'Topilmadi' });
    const d = productData(req.body ?? {}, reply);
    if (reply.sent) return reply;
    if (req.body?.name !== undefined) {
      const name = str(req.body.name, 120);
      if (!name) return bad(reply, 'Nomi shart');
      if (db.prepare('SELECT 1 FROM products WHERE lower(name) = lower(?) AND id <> ?').get(name, p.id)) return bad(reply, 'Bunday nomli mahsulot bor');
      d.name = name;
    }
    if (req.body?.active !== undefined) d.active = Number(!!req.body.active);
    if (p.parent_id && (d.unit !== undefined || d.kind !== undefined)) return bad(reply, "Variantning birligi va turi asosiy mahsulotniki bilan bir xil");
    db.transaction(() => {
      if (Object.keys(d).length) db.prepare(`UPDATE products SET ${Object.keys(d).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(d), p.id);
      // A parent's name, unit and kind carry over to its variants.
      if (p.has_variants) {
        if (d.name) for (const v of db.prepare('SELECT id, variant FROM products WHERE parent_id = ?').all(p.id)) db.prepare('UPDATE products SET name = ? WHERE id = ?').run(`${d.name} / ${v.variant}`, v.id);
        if (d.unit !== undefined || d.kind !== undefined) db.prepare('UPDATE products SET unit = COALESCE(?, unit), kind = COALESCE(?, kind) WHERE parent_id = ?').run(d.unit ?? null, d.kind ?? null, p.id);
      }
    })();
    log(req, 'products.update', { id: p.id, name: d.name ?? p.name });
    return { ok: true };
  });

  // Delete a product for good (Ombor → Mahsulotlar). Only when nothing would be
  // left pointing at it: no stock in any warehouse or stage, no documents or
  // movements in its history, not used in a recipe, not the collectors' milk.
  // A variant parent goes together with its variants. Returns the reasons it
  // can't be deleted, or [] when it can.
  const deleteBlockers = (p) => {
    const ids = [p.id, ...db.prepare('SELECT id FROM products WHERE parent_id = ?').all(p.id).map((x) => x.id)];
    const inList = `(${ids.map(() => '?').join(',')})`;
    const why = [];
    if (p.kind === 'milk') why.push("Yig'uvchilar suti — Sut yig'ish bo'limida boshqariladi");
    if (ids.map(String).includes(db.prepare("SELECT value FROM settings WHERE key = 'erp_milk_product'").get()?.value)) why.push("Bu Sut omboriga kiradigan asosiy sut (Yog'li sut)");
    const left = db.prepare(`SELECT w.name, ROUND(SUM(m.qty), 3) AS qty FROM stock_moves m JOIN warehouses w ON w.id = m.warehouse_id
      WHERE m.product_id IN ${inList} GROUP BY m.warehouse_id HAVING ABS(SUM(m.qty)) > 0.0005`).all(...ids);
    if (left.length) why.push(`Omborda qoldig'i bor: ${left.map((x) => `${x.name} — ${fmtQ(x.qty)}`).join(', ')}`);
    const held = db.prepare(`SELECT ROUND(SUM(qty), 3) AS q FROM stock_moves WHERE product_id IN ${inList} AND holder_id IS NOT NULL`).get(...ids).q;
    if (held && Math.abs(held) > 0.0005) why.push(`Xodim qo'lida: ${fmtQ(held)}`);
    if (!left.length && (db.prepare(`SELECT 1 FROM doc_lines WHERE product_id IN ${inList} LIMIT 1`).get(...ids)
      || db.prepare(`SELECT 1 FROM stock_moves WHERE product_id IN ${inList} LIMIT 1`).get(...ids)
      || db.prepare(`SELECT 1 FROM collections WHERE product_id IN ${inList} LIMIT 1`).get(...ids))) {
      why.push("Hujjatlar tarixida bor (kirim, chiqim, ishlab chiqarish) — hisobotlar buzilmasligi uchun o'chirib bo'lmaydi; \"Faol\" belgisini olib qo'ying");
    }
    const recs = db.prepare(`SELECT DISTINCT r.name FROM recipes r WHERE r.product_id IN ${inList}
      OR r.id IN (SELECT recipe_id FROM recipe_lines WHERE product_id IN ${inList})
      OR r.id IN (SELECT recipe_id FROM recipe_outputs WHERE product_id IN ${inList})
      OR r.id IN (SELECT l.recipe_id FROM recipe_alts a JOIN recipe_lines l ON l.id = a.line_id WHERE a.product_id IN ${inList})`).all(...ids, ...ids, ...ids, ...ids);
    if (recs.length) why.push(`Tarkiblarda ishlatilgan: ${recs.map((r) => r.name).join(', ')} — avval tarkibdan olib tashlang`);
    return { ids, why };
  };
  const fmtQ = (n) => String(Math.round(n * 1000) / 1000);
  app.delete('/products/:id', need('catalog.manage'), async (req, reply) => {
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    if (!p) return reply.code(404).send({ error: 'Topilmadi' });
    const { ids, why } = deleteBlockers(p);
    if (why.length) return bad(reply, `"${p.name}" ni o'chirib bo'lmaydi: ${why.join('; ')}`);
    const inList = `(${ids.map(() => '?').join(',')})`;
    db.transaction(() => {
      for (const t of ['plan_lines', 'product_prices', 'product_stages', 'supplier_products']) db.prepare(`DELETE FROM ${t} WHERE product_id IN ${inList}`).run(...ids);
      db.prepare(`DELETE FROM products WHERE id IN ${inList}`).run(...ids);
    })();
    log(req, 'products.delete', { id: p.id, name: p.name, variants: ids.length - 1 });
    return { ok: true };
  });

  // ---------------------------------------------------------------- warehouses
  const warehouseRow = (w) => ({
    ...w, kind_label: w.is_stage ? 'Bosqich' : WAREHOUSE_KINDS[w.kind] ?? w.kind, stage_type_label: w.is_stage ? STAGE_TYPES[w.stage_type] : null,
    keepers: db.prepare('SELECT u.id, COALESCE(u.name, u.login) AS name FROM warehouse_keepers k JOIN users u ON u.id = k.user_id WHERE k.warehouse_id = ? ORDER BY name').all(w.id),
  });
  app.get('/warehouses', need(), async (req) => db.prepare('SELECT * FROM warehouses ORDER BY active DESC, is_stage, sort, name').all()
    .filter((w) => canSee(req, { warehouseId: w.id }) || w.active).map(warehouseRow));

  const setKeepers = (id, list) => {
    if (!Array.isArray(list)) return;
    db.prepare('DELETE FROM warehouse_keepers WHERE warehouse_id = ?').run(id);
    const ins = db.prepare('INSERT OR IGNORE INTO warehouse_keepers (warehouse_id, user_id) SELECT ?, id FROM users WHERE id = ?');
    for (const u of list) ins.run(id, Number(u));
  };
  app.post('/warehouses', need('stock.manage'), async (req, reply) => {
    const name = str(req.body?.name, 80);
    if (!name) return bad(reply, 'Nomi shart');
    const kind = req.body?.kind ?? 'general';
    if (!WAREHOUSE_KINDS[kind]) return bad(reply, 'Ombor turi noto\'g\'ri');
    const id = Number(db.prepare('INSERT INTO warehouses (name, kind, allow_negative, warn_negative, note, sort) VALUES (?, ?, ?, ?, ?, ?)')
      .run(name, kind, flag(req.body?.allowNegative, 0), flag(req.body?.warnNegative, 1), str(req.body?.note, 300), Number(req.body?.sort) || 0).lastInsertRowid);
    setKeepers(id, req.body?.keepers);
    log(req, 'warehouse.create', { id, name });
    return { id };
  });
  app.patch('/warehouses/:id', need('stock.manage'), async (req, reply) => {
    const w = db.prepare('SELECT * FROM warehouses WHERE id = ?').get(req.params.id);
    if (!w) return reply.code(404).send({ error: 'Topilmadi' });
    const b = req.body ?? {};
    if (b.kind !== undefined && !WAREHOUSE_KINDS[b.kind]) return bad(reply, 'Ombor turi noto\'g\'ri');
    if (b.active === false && db.prepare('SELECT 1 FROM stock_moves WHERE warehouse_id = ? GROUP BY product_id HAVING ABS(SUM(qty)) > 0.0005 LIMIT 1').get(w.id)) {
      return bad(reply, 'Omborda qoldiq bor. Avval qoldiqni boshqa omborga o\'tkazing.');
    }
    db.prepare(`UPDATE warehouses SET name = COALESCE(?, name), kind = COALESCE(?, kind), allow_negative = COALESCE(?, allow_negative),
      warn_negative = COALESCE(?, warn_negative), note = COALESCE(?, note), sort = COALESCE(?, sort), active = COALESCE(?, active) WHERE id = ?`)
      .run(str(b.name, 80), b.kind ?? null, b.allowNegative == null ? null : Number(!!b.allowNegative), b.warnNegative == null ? null : Number(!!b.warnNegative),
        b.note === undefined ? null : (str(b.note, 300) ?? ''), b.sort == null ? null : Number(b.sort) || 0, b.active == null ? null : Number(!!b.active), w.id);
    setKeepers(w.id, b.keepers);
    log(req, 'warehouse.update', { id: w.id, name: b.name ?? w.name });
    return { ok: true };
  });

  // Where accepted milk from shifts goes.
  app.put('/settings/milk-warehouse', need('stock.manage'), async (req, reply) => {
    const id = Number(req.body?.warehouseId);
    if (!db.prepare('SELECT 1 FROM warehouses WHERE id = ? AND active = 1').get(id)) return bad(reply, 'Ombor topilmadi');
    setSetting(db, 'erp_milk_warehouse', id);
    return { ok: true, warehouseId: milkWarehouse(db) };
  });

  // ---------------------------------------------------------------- reasons and categories
  // Loss reasons, per section (each section sees only its own): name, effect
  // (cost / company / staff), expense category, and a proportional limit.
  app.get('/reasons', need(), async (req) => db.prepare(`SELECT r.*, c.name AS category FROM stock_reasons r LEFT JOIN pnl_categories c ON c.id = r.category_id
    ${req.query.section ? 'WHERE r.section = ?' : ''} ORDER BY r.section, r.active DESC, r.sort, r.id`).all(...(req.query.section ? [String(req.query.section)] : []))
    .map((r) => ({ ...r, effect: r.effect ?? (r.charge === 'staff' ? 'staff' : 'company'), section_label: REASON_SECTIONS[r.section] ?? r.section })));
  const reasonPerm = (req, section) => has(req, section === 'warehouse' ? 'stock.manage' : 'prod.manage') || has(req, 'stock.manage');
  const reasonData = (b, reply, current = {}) => {
    const d = {};
    if (b.section !== undefined) { if (!REASON_SECTIONS[b.section]) return bad(reply, "Bo'lim noto'g'ri"); d.section = b.section; }
    const effect = b.effect ?? (b.charge ? (b.charge === 'staff' ? 'staff' : 'company') : undefined);
    if (effect !== undefined) {
      if (!REASON_EFFECTS[effect]) return bad(reply, "Ta'sir noto'g'ri");
      if (effect === 'cost' && (d.section ?? current.section ?? 'warehouse') === 'warehouse') return bad(reply, "Ombor sababi tannarxga yozilmaydi");
      d.effect = effect; d.charge = effect === 'staff' ? 'staff' : 'company';
    }
    for (const k of ['limitQty', 'limitBase']) {
      if (b[k] === undefined) continue;
      const n = optNum(b[k]);
      if (Number.isNaN(n)) return bad(reply, 'Limit musbat son bo\'lsin');
      d[k === 'limitQty' ? 'limit_qty' : 'limit_base'] = n;
    }
    if (b.categoryId !== undefined && Number(b.categoryId)) d.category_id = Number(b.categoryId);
    if (b.active !== undefined) d.active = Number(!!b.active);
    if (b.sort !== undefined) d.sort = Number(b.sort) || 0;
    return d;
  };
  app.post('/reasons', need(), async (req, reply) => {
    const name = str(req.body?.name, 60);
    if (!name) return bad(reply, 'Nomi shart');
    const section = req.body?.section ?? 'warehouse';
    if (!reasonPerm(req, section)) return reply.code(403).send({ error: "Ruxsat yo'q" });
    const d = reasonData({ section, ...req.body }, reply);
    if (reply.sent) return reply;
    d.name = name;
    if (!d.category_id) d.category_id = db.prepare('SELECT id FROM pnl_categories WHERE code = ?').get(section === 'warehouse' ? 'writeoff' : 'production_loss').id;
    const id = db.prepare(`INSERT INTO stock_reasons (${Object.keys(d).join(', ')}) VALUES (${Object.keys(d).map(() => '?').join(', ')})`).run(...Object.values(d)).lastInsertRowid;
    log(req, 'reason.create', { id, name, section });
    return { id };
  });
  app.patch('/reasons/:id', need(), async (req, reply) => {
    const r = db.prepare('SELECT * FROM stock_reasons WHERE id = ?').get(req.params.id);
    if (!r) return reply.code(404).send({ error: 'Topilmadi' });
    if (!reasonPerm(req, r.section)) return reply.code(403).send({ error: "Ruxsat yo'q" });
    const d = reasonData(req.body ?? {}, reply, r);
    if (reply.sent) return reply;
    if (req.body?.name !== undefined) { const n = str(req.body.name, 60); if (!n) return bad(reply, 'Nomi shart'); d.name = n; }
    if (Object.keys(d).length) db.prepare(`UPDATE stock_reasons SET ${Object.keys(d).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(d), r.id);
    log(req, 'reason.update', { id: r.id, name: d.name ?? r.name });
    return { ok: true };
  });
  app.get('/pnl-categories', need('stock.costs'), async () => db.prepare('SELECT * FROM pnl_categories ORDER BY kind, system DESC, name').all());
  app.post('/pnl-categories', need('stock.manage'), async (req, reply) => {
    const name = str(req.body?.name, 80);
    if (!name) return bad(reply, 'Nomi shart');
    const id = db.prepare('INSERT INTO pnl_categories (name, kind) VALUES (?, ?)').run(name, req.body?.kind === 'income' ? 'income' : 'expense').lastInsertRowid;
    return { id };
  });
  // System categories can be renamed (e.g. "Qayta ishlashda yo'qotilgan tannarx"), never deleted.
  app.patch('/pnl-categories/:id', need('stock.manage'), async (req, reply) => {
    const c = db.prepare('SELECT * FROM pnl_categories WHERE id = ?').get(req.params.id);
    if (!c) return reply.code(404).send({ error: 'Topilmadi' });
    db.prepare('UPDATE pnl_categories SET name = COALESCE(?, name), active = COALESCE(?, active) WHERE id = ?')
      .run(str(req.body?.name, 80), c.system || req.body?.active == null ? null : Number(!!req.body.active), c.id);
    return { ok: true };
  });

  // ---------------------------------------------------------------- stock
  const holderQuery = (q) => parseHolder(db, { warehouseId: q.warehouseId, userId: q.userId });
  app.get('/stock', need(), async (req, reply) => {
    const h = holderQuery(req.query);
    if ((req.query.warehouseId || req.query.userId) && !h) return bad(reply, 'Joy topilmadi');
    if (h && !canSee(req, h)) return reply.code(403).send({ error: 'Bu joy qoldig\'ini ko\'rishga ruxsatingiz yo\'q' });
    let rows = stockReport(db, { holder: h, productId: Number(req.query.productId) || null, kind: req.query.kind || null });
    if (!h && !has(req, 'stock.view_all')) rows = rows.filter((r) => canActFor(req, r.holder));
    const totals = { cost: rows.reduce((a, r) => a + r.cost, 0) };
    return { rows, totals };
  });
  // What I am holding and what is in the warehouses I keep, plus hand-overs waiting for me.
  app.get('/stock/mine', need(), async (req) => ({
    mine: [],
    warehouses: keeperOf(req.me.id).map((id) => {
      const w = db.prepare('SELECT name, is_stage, active FROM warehouses WHERE id = ?').get(id);
      return { id, name: w?.name, is_stage: !!w?.is_stage, active: w?.active, rows: stockReport(db, { holder: { warehouseId: id } }) };
    }).filter((w) => w.active),
    inbox: inbox(db, req.me.id),
    balance: staffBalance(db, req.me.id),
  }));
  app.get('/stock/lots', need(), async (req, reply) => {
    const h = holderQuery(req.query);
    if (!h || !Number(req.query.productId)) return bad(reply, 'Joy va mahsulotni tanlang');
    if (!canSee(req, h)) return reply.code(403).send({ error: 'Ruxsat yo\'q' });
    return lotReport(db, h, Number(req.query.productId));
  });
  app.get('/stock/card', need('stock.view_all'), async (req, reply) => {
    const productId = Number(req.query.productId);
    if (!productId) return bad(reply, 'Mahsulotni tanlang');
    return stockCard(db, { productId, holder: holderQuery(req.query) });
  });

  // ---------------------------------------------------------------- documents
  app.get('/docs', need(), async (req) => {
    const h = holderQuery(req.query);
    const q = { type: req.query.type || null, status: req.query.status || null, from: req.query.from || null, to: req.query.to || null };
    if (has(req, 'stock.view_all')) return listDocs(db, { ...q, holder: h });
    // Others: documents about themselves or the warehouses they keep.
    const mine = [{ userId: req.me.id }, ...keeperOf(req.me.id).map((id) => ({ warehouseId: id }))];
    const seen = new Map();
    for (const x of mine) for (const d of listDocs(db, { ...q, holder: x })) seen.set(d.id, d);
    return [...seen.values()].sort((a, b) => b.doc_date.localeCompare(a.doc_date) || b.id - a.id);
  });
  app.get('/docs/:id', need(), async (req, reply) => {
    const d = docDetail(db, Number(req.params.id));
    if (!d) return reply.code(404).send({ error: 'Topilmadi' });
    if (!has(req, 'stock.view_all') && !canActFor(req, d.from) && !canActFor(req, d.to) && d.created_by !== req.actor) {
      return reply.code(403).send({ error: 'Ruxsat yo\'q' });
    }
    return d;
  });
  app.get('/inbox', need(), async (req) => inbox(db, req.me.id));

  const TYPE_PERM = { opening: 'stock.opening', transfer: 'stock.transfer', writeoff: 'stock.writeoff', inventory: 'stock.inventory' };
  app.post('/docs', need(), async (req, reply) => {
    const b = req.body ?? {};
    const perm = TYPE_PERM[b.type];
    if (!perm) return bad(reply, 'Hujjat turi noto\'g\'ri');
    if (!has(req, perm)) return reply.code(403).send({ error: 'Bu amal uchun ruxsatingiz yo\'q' });
    // Handing out / writing off / counting is done for a place the user answers for.
    if (b.type === 'transfer' || b.type === 'writeoff') {
      const from = parseHolder(db, b.from);
      if (from && !canActFor(req, from)) return reply.code(403).send({ error: 'Bu joy nomidan ishlay olmaysiz' });
    }
    if (b.type === 'inventory') {
      const to = parseHolder(db, b.to);
      if (to && !canActFor(req, to)) return reply.code(403).send({ error: 'Bu omborda inventarizatsiya qila olmaysiz' });
      if (b.charges !== undefined && !has(req, 'stock.costs')) return reply.code(403).send({ error: "Kamomadni taqsimlash uchun ruxsat yo'q" });
    }
    try {
      const d = createDoc(db, b, { actor: req.actor, userId: req.me.id });
      log(req, `doc.${d.type}`, { id: d.id, number: d.number, status: d.status });
      return docDetail(db, d.id);
    } catch (e) { return stockErr(reply, e); }
  });
  const loadDoc = (req, reply) => {
    const d = db.prepare('SELECT * FROM docs WHERE id = ?').get(Number(req.params.id));
    if (!d) { reply.code(404).send({ error: 'Topilmadi' }); return null; }
    return d;
  };
  app.put('/docs/:id', need(), async (req, reply) => {
    const d = loadDoc(req, reply); if (!d) return reply;
    if (d.created_by !== req.actor && !has(req, 'stock.manage')) return reply.code(403).send({ error: 'Faqat yaratgan xodim o\'zgartira oladi' });
    try { updateDraft(db, d.id, req.body ?? {}); return docDetail(db, d.id); } catch (e) { return stockErr(reply, e); }
  });
  app.post('/docs/:id/post', need(), async (req, reply) => {
    const d = loadDoc(req, reply); if (!d) return reply;
    if (d.status !== 'draft') return bad(reply, 'Faqat qoralamani o\'tkazish mumkin');
    const perm = TYPE_PERM[d.type];
    if (!perm || !has(req, perm)) return reply.code(403).send({ error: 'Ruxsat yo\'q' });
    if (d.type === 'inventory' && !canActFor(req, { warehouseId: d.to_wh })) return reply.code(403).send({ error: 'Ruxsat yo\'q' });
    // Who pays an inventory shortage (company / staff / split) is decided with the sums,
    // so only someone who sees costs decides it; others save the count as a draft.
    const charges = req.body?.charges;
    if (charges !== undefined && !has(req, 'stock.costs')) return reply.code(403).send({ error: "Kamomadni taqsimlash uchun ruxsat yo'q" });
    try {
      postDoc(db, d.id, req.actor, charges === undefined ? {} : { charges });
      log(req, 'doc.post', { id: d.id, charges });
      return docDetail(db, d.id);
    } catch (e) {
      // A storekeeper's count with a shortage waits for a manager: tell them once.
      if (e instanceof StockError && e.details?.needDecision
        && !db.prepare("SELECT 1 FROM alerts WHERE doc_id = ? AND type = 'stock.shortage' AND resolved_at IS NULL").get(d.id)) {
        addAlert(db, 'stock.shortage', `INV-${d.number}: inventarizatsiyada kamomad — kim hisobiga ekanini hal qilib o'tkazing`, { warehouseId: d.to_wh }, d.id);
      }
      return stockErr(reply, e);
    }
  });
  // What posting an inventory count would change (differences; the value only with stock.costs).
  app.get('/docs/:id/preview', need('stock.inventory'), async (req, reply) => {
    const d = loadDoc(req, reply); if (!d) return reply;
    if (!canActFor(req, { warehouseId: d.to_wh })) return reply.code(403).send({ error: "Ruxsat yo'q" });
    try { return inventoryPreview(db, d.id); } catch (e) { return stockErr(reply, e); }
  });
  // The receiver accepts a hand-over: only now does it move.
  const isReceiver = (req, d) => (d.to_user === req.me.id) || (d.to_wh && keeperOf(req.me.id).includes(d.to_wh)) || has(req, 'stock.manage');
  app.post('/docs/:id/accept', need('stock.transfer'), async (req, reply) => {
    const d = loadDoc(req, reply); if (!d) return reply;
    if (d.type !== 'transfer' || d.status !== 'sent') return bad(reply, 'Qabul kutayotgan topshirish emas');
    if (!isReceiver(req, d)) return reply.code(403).send({ error: 'Bu topshirish sizga emas' });
    try { postDoc(db, d.id, req.actor); log(req, 'doc.accept', { id: d.id }); return docDetail(db, d.id); } catch (e) { return stockErr(reply, e); }
  });
  app.post('/docs/:id/reject', need('stock.transfer'), async (req, reply) => {
    const d = loadDoc(req, reply); if (!d) return reply;
    if (!isReceiver(req, d)) return reply.code(403).send({ error: 'Bu topshirish sizga emas' });
    try { rejectDoc(db, d.id, req.actor, str(req.body?.reason, 300)); log(req, 'doc.reject', { id: d.id }); return docDetail(db, d.id); } catch (e) { return stockErr(reply, e); }
  });
  // Cancel: the author may withdraw a draft or a not-yet-accepted hand-over;
  // reversing a posted document needs stock.cancel.
  app.post('/docs/:id/cancel', need(), async (req, reply) => {
    const d = loadDoc(req, reply); if (!d) return reply;
    const own = d.created_by === req.actor && (d.status === 'draft' || d.status === 'sent');
    if (!own && !has(req, 'stock.cancel')) return reply.code(403).send({ error: 'Bekor qilishga ruxsatingiz yo\'q' });
    try { cancelDoc(db, d.id, req.actor, str(req.body?.reason, 300)); log(req, 'doc.cancel', { id: d.id }); return docDetail(db, d.id); } catch (e) { return stockErr(reply, e); }
  });

  // ---------------------------------------------------------------- staff balance (warehouse side)
  app.get('/staff-balance/:id', need('stock.costs'), async (req) => ({
    balance: staffBalance(db, Number(req.params.id)),
    entries: db.prepare("SELECT * FROM party_entries WHERE party_type = 'staff' AND party_id = ? ORDER BY at DESC, id DESC LIMIT 300").all(Number(req.params.id)),
  }));

  // ---------------------------------------------------------------- alerts
  // The app's alert banner: alerts naming me or my warehouses (managers: all).
  app.get('/alerts/mine', need(), async (req) => alertsFor(db, req.me, req.me.perms));
  app.get('/alerts', need('alerts.view'), async (req) => db.prepare(`SELECT * FROM alerts ${req.query.all ? '' : 'WHERE resolved_at IS NULL'} ORDER BY created_at DESC, id DESC LIMIT 300`).all()
    .map((a) => ({ ...a, payload: a.payload ? JSON.parse(a.payload) : null })));
  app.post('/alerts/:id/resolve', need('alerts.view'), async (req) => {
    db.prepare("UPDATE alerts SET resolved_at = datetime('now'), resolved_by = ? WHERE id = ? AND resolved_at IS NULL").run(req.actor, Number(req.params.id));
    return { ok: true };
  });

  // ---------------------------------------------------------------- Excel
  const importPerm = (kind) => (kind === 'products' ? 'catalog.manage' : 'stock.opening');
  app.get('/import/:kind/template.xlsx', need(), async (req, reply) => {
    const kind = req.params.kind;
    if (!importKinds.includes(kind)) return reply.code(404).send({ error: 'Topilmadi' });
    if (!has(req, importPerm(kind))) return reply.code(403).send({ error: 'Ruxsat yo\'q' });
    reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    reply.header('Content-Disposition', `attachment; filename="${templateFile(kind)}"`);
    return Buffer.from(await erpTemplate(db, kind));
  });
  app.post('/import/:kind', { ...need(), bodyLimit: 12 * 1024 * 1024 }, async (req, reply) => {
    const kind = req.params.kind;
    if (!importKinds.includes(kind)) return reply.code(404).send({ error: 'Topilmadi' });
    if (!has(req, importPerm(kind))) return reply.code(403).send({ error: 'Ruxsat yo\'q' });
    const b64 = String(req.body?.file ?? '').replace(/^data:.*?;base64,/, '');
    if (!b64) return bad(reply, 'Fayl yuborilmadi');
    const buf = Buffer.from(b64, 'base64');
    if (buf.length > 8 * 1024 * 1024) return bad(reply, 'Fayl 8 MB dan katta');
    try {
      const r = await erpImport(db, kind, buf, { dryRun: req.body?.dryRun !== false, actor: req.actor, userId: req.me.id });
      if (!r.dryRun) log(req, `import.${kind}`, r.summary);
      return r;
    } catch (e) {
      if (e instanceof StockError) return stockErr(reply, e);
      return bad(reply, e.message);
    }
  });
}
