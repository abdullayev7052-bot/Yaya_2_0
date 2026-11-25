// Excel templates and bulk import for the warehouse: products (nomenclature) and
// opening stock. Every import is checked first (dryRun) and only then written.
import ExcelJS from 'exceljs';
import { randomUUID } from 'node:crypto';
import { PRODUCT_KINDS, SHAPES } from './schema.js';
import { createDoc, r3 } from './stock.js';

const KINDS = {
  products: {
    sheet: 'Mahsulotlar',
    file: 'yaya_mahsulotlar_shablon.xlsx',
    columns: [
      { key: 'name', header: 'Nomi (majburiy)', width: 34 },
      { key: 'kind', header: 'Turi', width: 20 },
      { key: 'unit', header: 'Birlik', width: 9 },
      { key: 'sku', header: 'Artikul', width: 12 },
      { key: 'barcode', header: 'Shtrix-kod', width: 16 },
      { key: 'category', header: 'Turkum', width: 16 },
      { key: 'netto_g', header: 'Netto (g)', width: 10 },
      { key: 'brutto_g', header: 'Brutto (g)', width: 10 },
      { key: 'volume', header: 'Hajm', width: 9 },
      { key: 'volume_unit', header: 'Hajm birligi', width: 12 },
      { key: 'shape', header: 'Shakl', width: 14 },
      { key: 'shelf_life_hours', header: 'Yaroqlilik (soat)', width: 16 },
      { key: 'variants', header: 'Variantlar (vergul bilan)', width: 24 },
    ],
    samples: [
      { name: 'Smetana 20% 400 g', kind: 'Tayyor mahsulot', unit: 'dona', netto_g: 400, brutto_g: 425, volume: 0.0005, volume_unit: 'm3', shape: 'Dumaloq', shelf_life_hours: 168 },
      { name: 'Zakvaska', kind: 'Xomashyo', unit: 'g', variants: '499, 505' },
      { name: 'V idish smetana 20% 400 g', kind: 'Idish / tara', unit: 'dona', brutto_g: 25, shape: 'Dumaloq' },
      { name: 'Tomizg\'i', kind: 'Xomashyo', unit: 'kg' },
    ],
    help: [
      'Bitta qator = bitta mahsulot. Nomi majburiy; tizimda shu nomli mahsulot bo\'lsa — u yangilanadi, bo\'lmasa — yangisi yaratiladi.',
      `Turi: ${Object.values(PRODUCT_KINDS).join(', ')}. Bo'sh qolsa — "Tayyor mahsulot".`,
      'Birlik: kg, g, l, dona va h.k. Bo\'sh qolsa — kg.',
      'Netto — ichidagi mahsulot vazni, brutto — idishi bilan birga (gramm). Qayta ishlashda netto ishlatiladi.',
      `Hajm — 1 birlikning hajmi (son), Hajm birligi — m3, m2, l... Shakl: ${Object.values(SHAPES).join(', ')}.`,
      'Yaroqlilik — ishlab chiqarilgandan necha soat yaroqli. Turish vaqti — issiqxona/omborda necha soat turishi kerak.',
    ],
  },
  opening: {
    sheet: 'Qoldiqlar',
    file: 'yaya_boshlangich_qoldiq_shablon.xlsx',
    columns: [
      { key: 'warehouse', header: 'Ombor (majburiy)', width: 26 },
      { key: 'product', header: 'Mahsulot (majburiy)', width: 34 },
      { key: 'qty', header: 'Miqdor (majburiy)', width: 16 },
      { key: 'unit_cost', header: 'Tannarx (1 birlik, so\'m)', width: 22 },
      { key: 'expires', header: 'Yaroqlilik sanasi', width: 18 },
    ],
    samples: [
      { warehouse: 'Tayyor mahsulot ombori', product: 'Smetana 20% 400 g', qty: 120, unit_cost: 7000, expires: '2026-12-01' },
      { warehouse: 'Idish ombori', product: 'V idish smetana 20% 400 g', qty: 5000, unit_cost: 800 },
    ],
    help: [
      'Bitta qator = bitta ombordagi bitta mahsulot (bir mahsulotning bir nechta partiyasi bo\'lsa — har biri alohida qatorda).',
      'Ombor va mahsulot nomi tizimdagi nom bilan bir xil bo\'lsin (avval omborlarni va mahsulotlarni kiriting).',
      'Tannarx — 1 birlik uchun so\'mda. Bo\'sh qolsa 0 deb olinadi.',
      'Yaroqlilik sanasi — YYYY-MM-DD ko\'rinishida. Bo\'sh qolsa, mahsulotning yaroqlilik muddatidan hisoblanadi.',
      'Har bir ombor uchun bitta "Boshlang\'ich qoldiq" hujjati yaratiladi.',
    ],
  },
};

export const importKinds = Object.keys(KINDS);
export const templateFile = (kind) => KINDS[kind]?.file;

export async function erpTemplate(db, kind) {
  const k = KINDS[kind];
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Yaya';
  const ws = wb.addWorksheet(k.sheet);
  ws.columns = k.columns.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F3EE' } };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  for (const r of k.samples) ws.addRow(r);
  const help = wb.addWorksheet('Yo\'riqnoma');
  help.columns = [{ width: 120 }];
  help.addRow(['Qanday to\'ldiriladi:']).font = { bold: true };
  k.help.forEach((t, i) => help.addRow([`${i + 1}. ${t}`]));
  help.addRow(['Namuna qatorlarni o\'chirib, o\'z ma\'lumotlaringizni yozing. Import oldidan tizim tekshiradi va natijani ko\'rsatadi.']);
  if (kind === 'opening') {
    help.addRow([`Omborlar: ${db.prepare('SELECT name FROM warehouses WHERE active = 1 ORDER BY sort, name').all().map((w) => w.name).join(', ') || '(hali yo\'q)'}`]);
  }
  return wb.xlsx.writeBuffer();
}

const text = (v) => {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((t) => t.text).join('').trim();
    if (v.text) return String(v.text).trim();
    if (v.result != null) return String(v.result).trim();
  }
  return String(v).trim();
};
const number = (v) => {
  if (v == null || v === '') return null;
  if (typeof v === 'object' && v.result != null) v = v.result;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/\s/g, '').replace(',', '.');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
};
const norm = (s) => text(s).toLowerCase().replace(/\s+/g, ' ');
const fromLabel = (map, v) => {
  const t = norm(v);
  if (!t) return null;
  return Object.entries(map).find(([code, label]) => code === t || label.toLowerCase() === t || label.toLowerCase().startsWith(t))?.[0] ?? undefined;
};

async function readRows(kind, buffer) {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buffer); } catch { throw new Error('Faylni o\'qib bo\'lmadi. Shablondagi .xlsx formatda saqlang.'); }
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('Faylda varaq yo\'q');
  const cols = KINDS[kind].columns;
  const header = {};
  ws.getRow(1).eachCell((cell, col) => {
    const h = norm(cell.value);
    const c = cols.find((x) => h.startsWith(x.header.toLowerCase().split(' (')[0]));
    if (c) header[col] = c.key;
  });
  const required = cols.filter((c) => c.header.includes('majburiy'));
  const missing = required.filter((c) => !Object.values(header).includes(c.key));
  if (missing.length) throw new Error(`Ustun topilmadi: ${missing.map((c) => c.header).join(', ')}. Shablondan foydalaning.`);
  const rows = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const r = { row: n };
    let any = false;
    for (const [col, key] of Object.entries(header)) {
      r[key] = row.getCell(Number(col)).value;
      if (text(r[key])) any = true;
    }
    if (any) rows.push(r);
  });
  if (rows.length > 5000) throw new Error('Bir martada 5000 qatordan ko\'p bo\'lmasin');
  return rows;
}

function checkProducts(db, rows) {
  const out = []; const errors = [];
  const seen = new Set();
  for (const r of rows) {
    const name = text(r.name).slice(0, 120);
    if (!name) { errors.push({ row: r.row, error: 'Nomi bo\'sh' }); continue; }
    if (seen.has(name.toLowerCase())) { errors.push({ row: r.row, error: `"${name}" ikki marta yozilgan` }); continue; }
    seen.add(name.toLowerCase());
    const kind = fromLabel(PRODUCT_KINDS, r.kind);
    if (kind === undefined) { errors.push({ row: r.row, error: `Turi noma'lum: "${text(r.kind)}"` }); continue; }
    const shape = fromLabel(SHAPES, r.shape);
    if (shape === undefined) { errors.push({ row: r.row, error: `Shakl noma'lum: "${text(r.shape)}"` }); continue; }
    const nums = {};
    let bad = null;
    for (const k of ['netto_g', 'brutto_g', 'volume', 'shelf_life_hours']) {
      const n = number(r[k]);
      if (Number.isNaN(n) || (n != null && n < 0)) { bad = k; break; }
      nums[k] = n;
    }
    if (bad) { errors.push({ row: r.row, error: `${KINDS.products.columns.find((c) => c.key === bad).header}: son emas` }); continue; }
    const existing = db.prepare('SELECT id, has_variants FROM products WHERE lower(name) = lower(?)').get(name);
    // Variants ("499, 505"): a new product becomes their parent; an existing one must
    // already be variant-based (that is chosen once, when the product is created).
    const variants = [...new Set(text(r.variants).split(',').map((v) => v.trim().slice(0, 40)).filter(Boolean))];
    if (variants.length && existing && !existing.has_variants) { errors.push({ row: r.row, error: `"${name}" variantli emas — variantni faqat yangi mahsulotga qo'shish mumkin` }); continue; }
    out.push({ variants,
      row: r.row, action: existing ? 'update' : 'create', id: existing?.id ?? null, name,
      kind: kind ?? (existing ? null : 'finished'), unit: text(r.unit).slice(0, 10) || null, sku: text(r.sku).slice(0, 40) || null,
      barcode: text(r.barcode).slice(0, 40) || null, category: text(r.category).slice(0, 60) || null,
      volume_unit: text(r.volume_unit).slice(0, 10) || null, shape, ...nums,
    });
  }
  return { out, errors };
}

function checkOpening(db, rows) {
  const out = []; const errors = [];
  for (const r of rows) {
    const wName = text(r.warehouse); const pName = text(r.product);
    const w = wName && db.prepare('SELECT id, name FROM warehouses WHERE lower(name) = lower(?) AND active = 1').get(wName);
    if (!w) { errors.push({ row: r.row, error: `Ombor topilmadi: "${wName}"` }); continue; }
    const p = pName && db.prepare('SELECT id, name, unit FROM products WHERE lower(name) = lower(?)').get(pName);
    if (!p) { errors.push({ row: r.row, error: `Mahsulot topilmadi: "${pName}"` }); continue; }
    const qty = number(r.qty);
    if (qty == null || Number.isNaN(qty) || qty <= 0) { errors.push({ row: r.row, error: 'Miqdor musbat son bo\'lsin' }); continue; }
    const cost = number(r.unit_cost);
    if (Number.isNaN(cost) || (cost != null && cost < 0)) { errors.push({ row: r.row, error: 'Tannarx son bo\'lsin' }); continue; }
    const exp = text(r.expires);
    if (exp && Number.isNaN(Date.parse(exp))) { errors.push({ row: r.row, error: `Sana noto'g'ri: "${exp}"` }); continue; }
    out.push({ row: r.row, warehouseId: w.id, warehouse: w.name, productId: p.id, product: p.name, unit: p.unit, qty: r3(qty), unitCost: cost ?? 0, expiresAt: exp || null });
  }
  return { out, errors };
}

export async function erpImport(db, kind, buffer, { dryRun = true, actor, userId }) {
  const rows = await readRows(kind, buffer);
  const { out, errors } = kind === 'products' ? checkProducts(db, rows) : checkOpening(db, rows);
  const summary = kind === 'products'
    ? { rows: rows.length, create: out.filter((x) => x.action === 'create').length, update: out.filter((x) => x.action === 'update').length, errors: errors.length }
    : { rows: rows.length, lines: out.length, warehouses: new Set(out.map((x) => x.warehouseId)).size, errors: errors.length };
  if (dryRun || errors.length) return { dryRun: true, ok: !errors.length, summary, errors, preview: out.slice(0, 200) };

  const docs = [];
  db.transaction(() => {
    if (kind === 'products') {
      const ins = db.prepare(`INSERT INTO products (name, kind, unit, sku, barcode, category, netto_g, brutto_g, volume, volume_unit, shape, shelf_life_hours, has_variants)
        VALUES (@name, @kind, COALESCE(@unit, 'kg'), @sku, @barcode, @category, @netto_g, @brutto_g, @volume, @volume_unit, @shape, @shelf_life_hours, @has_variants)`);
      const insV = db.prepare(`INSERT INTO products (name, kind, unit, category, netto_g, brutto_g, volume, volume_unit, shape, shelf_life_hours, parent_id, variant)
        SELECT ?, kind, unit, category, netto_g, brutto_g, volume, volume_unit, shape, shelf_life_hours, id, ? FROM products WHERE id = ?`);
      const upd = db.prepare(`UPDATE products SET kind = COALESCE(@kind, kind), unit = COALESCE(@unit, unit), sku = COALESCE(@sku, sku), barcode = COALESCE(@barcode, barcode),
        category = COALESCE(@category, category), netto_g = COALESCE(@netto_g, netto_g), brutto_g = COALESCE(@brutto_g, brutto_g), volume = COALESCE(@volume, volume),
        volume_unit = COALESCE(@volume_unit, volume_unit), shape = COALESCE(@shape, shape), shelf_life_hours = COALESCE(@shelf_life_hours, shelf_life_hours) WHERE id = @id`);
      for (const p of out) {
        const { row, action, variants, ...data } = p;
        void row;
        let id = data.id;
        if (action === 'create') { const { id: _x, ...d } = data; void _x; id = Number(ins.run({ ...d, has_variants: variants.length ? 1 : 0 }).lastInsertRowid); } else upd.run(data);
        for (const v of variants) {
          const vname = `${data.name} / ${v}`;
          if (!db.prepare('SELECT 1 FROM products WHERE lower(name) = lower(?)').get(vname)) insV.run(vname, v, id);
        }
      }
    } else {
      const byWh = new Map();
      for (const l of out) {
        if (!byWh.has(l.warehouseId)) byWh.set(l.warehouseId, []);
        byWh.get(l.warehouseId).push({ productId: l.productId, qty: l.qty, unitCost: l.unitCost, expiresAt: l.expiresAt });
      }
      for (const [warehouseId, lines] of byWh) {
        docs.push(createDoc(db, { uuid: randomUUID(), type: 'opening', to: { warehouseId }, lines, note: 'Excel import' }, { actor, userId }).id);
      }
    }
  })();
  return { dryRun: false, ok: true, summary, errors: [], docs };
}
