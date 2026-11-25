// Reports up to the warehouse (Yaya 2.0, stage 8; sales reports taken out). Each report returns
// { key, title, columns, rows, totals, note } so the panel table and the Excel
// export are built the same way. Columns marked cost: true (cost, profit, margin,
// value) are removed for anyone without stock.costs. Dates are local (UTC+5).
import ExcelJS from 'exceljs';
import { holderName, r2, r3 } from './stock.js';

const day = (col) => `date(${col}, '+5 hours')`;
const J = (v) => (v ? JSON.parse(v) : {});
const C = (key, label, type = 'text', extra = {}) => ({ key, label, type, ...extra });
const pct = (a, b) => (b ? r2((a / b) * 100) : null);
const sumOf = (rows, keys) => Object.fromEntries(keys.map((k) => [k, r2(rows.reduce((a, r) => a + (Number(r[k]) || 0), 0))]));

const REPORTS = {
  production_by_product: {
    title: 'Ishlab chiqarish — mahsulotlar bo\'yicha',
    run(db, { from, to }) {
      const rows = db.prepare(`SELECT p.id, p.name AS product, p.unit, r.kind, COUNT(DISTINCT t.id) AS tasks, ROUND(SUM(dl.qty), 3) AS qty,
          ROUND(SUM(l.unit_cost * dl.qty), 2) AS cost
        FROM prod_tasks t JOIN recipes r ON r.id = t.recipe_id JOIN doc_lines dl ON dl.doc_id = t.doc_id JOIN products p ON p.id = dl.product_id
        LEFT JOIN lots l ON l.doc_id = t.doc_id AND l.product_id = dl.product_id
        WHERE t.status = 'done' AND json_extract(dl.meta, '$.role') = 'out' AND ${day('t.done_at')} BETWEEN ? AND ?
        GROUP BY p.id, r.kind ORDER BY qty DESC`).all(from, to)
        .map((x) => ({ ...x, kind: { cook: 'Quyma', separation: 'Separatsiya', pour: 'Quyish', cap: 'Qopqoq', reprocess: 'Qayta ishlash' }[x.kind] ?? x.kind, unit_cost: x.qty ? r2(x.cost / x.qty) : null }));
      const milk = r3(db.prepare(`SELECT COALESCE(SUM(milk_qty), 0) AS q FROM prod_tasks WHERE status = 'done' AND ${day('done_at')} BETWEEN ? AND ?`).get(from, to).q);
      return {
        columns: [C('product', 'Mahsulot'), C('kind', 'Jarayon'), C('tasks', 'Topshiriq', 'qty'), C('qty', 'Chiqdi', 'qty'), C('unit', 'Birlik'),
          C('unit_cost', '1 birlik tannarxi', 'money', { cost: true }), C('cost', 'Jami tannarx', 'money', { cost: true })],
        rows, totals: sumOf(rows, ['tasks', 'cost']), note: `Topshiriqlarda ishlatilgan xom sut: ${milk} kg. Tannarx — hozirgi (smena yopilgach yo'qotish qo'shilgan) holatda.`,
      };
    },
  },
  production_by_worker: {
    title: "Ishlab chiqarish — xodimlar bo'yicha",
    run(db, { from, to }) {
      // One column per stage: how many tasks each person took part in there.
      const stages = db.prepare('SELECT id, name FROM warehouses WHERE is_stage = 1 ORDER BY sort, id').all();
      const blank = () => ({ tasks: 0, units: 0, milk: 0, ...Object.fromEntries(stages.map((st) => [`s${st.id}`, 0])) });
      const map = new Map();
      for (const t of db.prepare(`SELECT t.* FROM prod_tasks t WHERE t.status = 'done' AND ${day('t.done_at')} BETWEEN ? AND ?`).all(from, to)) {
        const res = J(t.result);
        const people = res.workers?.length ? res.workers : [t.user_id ?? db.prepare('SELECT user_id FROM prod_shifts WHERE id = ?').get(t.shift_id)?.user_id].filter(Boolean);
        const units = (res.outputs ?? []).reduce((a, o) => a + (o.qty ?? 0), 0);
        for (const u of people) {
          const r = map.get(u) ?? blank();
          r.tasks += 1; if (t.stage_id) r[`s${t.stage_id}`] = (r[`s${t.stage_id}`] ?? 0) + 1;
          r.units += units / people.length; r.milk += (t.milk_qty ?? 0) / people.length;
          map.set(u, r);
        }
      }
      const wages = new Map(db.prepare(`SELECT e.party_id, -SUM(e.amount) AS w FROM party_entries e JOIN docs d ON d.id = e.doc_id
        WHERE e.party_type = 'staff' AND d.type IN ('production','stage_move') AND e.kind IN ('piece','reversal') AND ${day('e.at')} BETWEEN ? AND ? GROUP BY e.party_id`).all(from, to).map((x) => [x.party_id, x.w]));
      const used = stages.filter((st) => [...map.values()].some((r) => r[`s${st.id}`] > 0));
      const rows = [...new Set([...map.keys(), ...wages.keys()])].map((id) => {
        const r = map.get(id) ?? blank();
        return { worker: holderName(db, { userId: id }), tasks: r.tasks, ...Object.fromEntries(used.map((st) => [`s${st.id}`, r[`s${st.id}`]])), milk: r3(r.milk), units: r3(r.units), wages: r2(wages.get(id) ?? 0) };
      }).sort((a, b) => b.tasks - a.tasks);
      return {
        columns: [C('worker', 'Xodim'), C('tasks', 'Topshiriq', 'qty'), ...used.map((st) => C(`s${st.id}`, st.name, 'qty')),
          C('milk', 'Sut, kg', 'qty'), C('units', 'Chiqim (ulushi)', 'qty'), C('wages', 'Ishbay haq', 'money')],
        rows, totals: sumOf(rows, ['tasks', 'milk', 'wages']), note: "Bir ishni bir necha kishi bajargan bo'lsa, chiqim, sut va ish haqi teng bo'linadi.",
      };
    },
  },
  stock_movement: {
    title: 'Ombor — harakat (boshi, kirim, chiqim, oxiri)',
    run(db, { from, to, warehouseId }) {
      const wh = warehouseId ? ' AND m.warehouse_id = ?' : '';
      const args = warehouseId ? [warehouseId] : [];
      // Transfers between places cancel out when all places are counted together.
      const notInternal = warehouseId ? '' : " AND d.type <> 'transfer'";
      const rows = db.prepare(`SELECT p.id, p.name AS product, p.unit, p.kind,
          ROUND(SUM(CASE WHEN ${day('m.at')} < ? THEN m.qty ELSE 0 END), 3) AS open_qty,
          ROUND(SUM(CASE WHEN ${day('m.at')} < ? THEN m.cost ELSE 0 END), 2) AS open_value,
          ROUND(SUM(CASE WHEN ${day('m.at')} BETWEEN ? AND ? AND m.qty > 0${notInternal.replace('d.type', 'd.type')} THEN m.qty ELSE 0 END), 3) AS in_qty,
          ROUND(SUM(CASE WHEN ${day('m.at')} BETWEEN ? AND ? AND m.qty < 0${notInternal} THEN -m.qty ELSE 0 END), 3) AS out_qty,
          ROUND(SUM(CASE WHEN ${day('m.at')} <= ? THEN m.qty ELSE 0 END), 3) AS close_qty,
          ROUND(SUM(CASE WHEN ${day('m.at')} <= ? THEN m.cost ELSE 0 END), 2) AS close_value
        FROM stock_moves m JOIN products p ON p.id = m.product_id JOIN docs d ON d.id = m.doc_id
        WHERE 1 = 1${wh} GROUP BY p.id
        HAVING ABS(open_qty) > 0.0005 OR ABS(in_qty) > 0.0005 OR ABS(out_qty) > 0.0005 OR ABS(close_qty) > 0.0005
        ORDER BY p.kind, p.name`).all(from, from, from, to, from, to, to, to, ...args);
      return {
        columns: [C('product', 'Mahsulot'), C('unit', 'Birlik'), C('open_qty', 'Boshida', 'qty'), C('open_value', 'Boshida, so\'m', 'money', { cost: true }), C('in_qty', 'Kirim', 'qty'),
          C('out_qty', 'Chiqim', 'qty'), C('close_qty', 'Oxirida', 'qty'), C('close_value', 'Oxirida, so\'m', 'money', { cost: true })],
        rows, totals: sumOf(rows, ['open_value', 'close_value']),
        note: warehouseId ? 'Tanlangan ombor bo\'yicha (topshirishlar ham kirim/chiqim).' : 'Hamma joylar birga (omborlar va xodimlar qo\'li); ichki topshirishlar hisobga kirmaydi.',
      };
    },
  },
  losses: {
    title: "Yo'qotishlar va kamomadlar",
    run(db, { from, to }) {
      const LOSS = ['stock_loss', 'writeoff', 'production_loss', 'reprocess_loss', 'container_loss', 'cost_variance'];
      const company = db.prepare(`SELECT e.at, e.amount, e.note, c.name AS category, d.type, d.number FROM pnl_entries e JOIN pnl_categories c ON c.id = e.category_id LEFT JOIN docs d ON d.id = e.doc_id
        WHERE (c.code IN (${LOSS.map(() => '?').join(',')}) OR (c.code IS NULL AND c.kind = 'expense' AND e.doc_id IN (SELECT id FROM docs WHERE type IN ('writeoff','shift_close','production'))))
          AND ${day('e.at')} BETWEEN ? AND ?`).all(...LOSS, from, to)
        .map((x) => ({ at: x.at, category: x.category, note: x.note ?? '', who: 'Kompaniya', amount: r2(x.amount) }));
      const staff = db.prepare(`SELECT e.at, e.amount, e.note, e.kind, e.party_id FROM party_entries e
        WHERE e.party_type = 'staff' AND e.kind IN ('writeoff','inventory','production','reprocess') AND e.amount > 0 AND ${day('e.at')} BETWEEN ? AND ?`).all(from, to)
        .map((x) => ({ at: x.at, category: { writeoff: 'Hisobdan chiqarish (xodim aybi)', inventory: 'Inventarizatsiya kamomadi', production: 'Ishlab chiqarish (xodim aybi)', reprocess: 'Qayta ishlash (idish)' }[x.kind],
          note: x.note ?? '', who: holderName(db, { userId: x.party_id }), amount: r2(x.amount) }));
      const rows = [...company, ...staff].sort((a, b) => b.at.localeCompare(a.at));
      const byCat = {};
      for (const r of rows) byCat[r.category] = r2((byCat[r.category] ?? 0) + r.amount);
      return {
        columns: [C('at', 'Vaqt', 'datetime'), C('category', 'Turi'), C('note', 'Izoh'), C('who', 'Kim hisobiga'), C('amount', 'Summa', 'money', { cost: true })],
        rows, totals: sumOf(rows, ['amount']), summary: Object.entries(byCat).map(([k, v]) => ({ label: k, value: v })).sort((a, b) => b.value - a.value),
        note: 'Bekor qilingan hujjatlar teskari yozuv bilan qaytariladi (manfiy summa).',
      };
    },
  },
  expiry: {
    title: 'Muddati yaqin va o\'tgan partiyalar',
    run(db, { days = 3 }) {
      const rows = db.prepare(`SELECT l.id, l.number, l.expires_at, p.name AS product, p.unit, m.warehouse_id, m.holder_id, ROUND(SUM(m.qty), 3) AS qty, ROUND(SUM(m.cost), 2) AS value
        FROM stock_moves m JOIN lots l ON l.id = m.lot_id JOIN products p ON p.id = m.product_id
        WHERE l.expires_at IS NOT NULL AND l.expires_at <= datetime('now', ?)
        GROUP BY m.lot_id, m.warehouse_id, m.holder_id HAVING SUM(m.qty) > 0.0005 ORDER BY l.expires_at`).all(`+${Number(days) || 3} days`)
        .map((x) => ({ product: x.product, place: holderName(db, x.warehouse_id ? { warehouseId: x.warehouse_id } : { userId: x.holder_id }), lot: x.number, qty: x.qty, unit: x.unit,
          expires: x.expires_at, days_left: Math.floor((Date.parse(x.expires_at) - Date.now()) / 864e5), value: x.value }));
      return {
        columns: [C('product', 'Mahsulot'), C('place', 'Qayerda'), C('lot', 'Partiya'), C('qty', 'Miqdor', 'qty'), C('unit', 'Birlik'), C('expires', 'Yaroqlilik', 'datetime'),
          C('days_left', 'Qoldi, kun', 'qty'), C('value', 'Qiymati', 'money', { cost: true })],
        rows, totals: sumOf(rows, ['value']), note: 'Manfiy "qoldi" — muddati o\'tgan.',
      };
    },
  },
  staff_summary: {
    title: 'Xodimlar — hisob-kitob',
    run(db, { from, to }) {
      const rows = db.prepare(`SELECT e.party_id,
          ROUND(SUM(CASE WHEN e.kind = 'piece' THEN -e.amount ELSE 0 END), 2) AS piece,
          ROUND(SUM(CASE WHEN e.kind = 'salary' THEN -e.amount ELSE 0 END), 2) AS salary,
          ROUND(SUM(CASE WHEN e.kind = 'bonus' THEN -e.amount ELSE 0 END), 2) AS bonus,
          ROUND(SUM(CASE WHEN e.kind = 'fine' THEN e.amount ELSE 0 END), 2) AS fines,
          ROUND(SUM(CASE WHEN e.kind IN ('writeoff','inventory','production','reprocess') THEN e.amount ELSE 0 END), 2) AS losses,
          ROUND(SUM(CASE WHEN e.kind = 'pay' THEN e.amount ELSE 0 END), 2) AS paid
        FROM party_entries e WHERE e.party_type = 'staff' AND ${day('e.at')} BETWEEN ? AND ? GROUP BY e.party_id`).all(from, to)
        .map((x) => ({ worker: holderName(db, { userId: x.party_id }), piece: x.piece, salary: x.salary, bonus: x.bonus, fines: x.fines, losses: x.losses, paid: x.paid,
          earned: r2(x.piece + x.salary + x.bonus - x.fines - x.losses),
          balance: r2(-db.prepare("SELECT COALESCE(SUM(amount), 0) AS a FROM party_entries WHERE party_type = 'staff' AND party_id = ?").get(x.party_id).a) }))
        .sort((a, b) => b.earned - a.earned);
      return {
        columns: [C('worker', 'Xodim'), C('salary', 'Oklad', 'money'), C('piece', 'Ishbay', 'money'), C('bonus', 'Bonus', 'money'), C('fines', 'Jarima', 'money'), C('losses', "Aybi bilan yo'qotish", 'money'),
          C('earned', 'Davrda haqi (sof)', 'money'), C('paid', "To'landi", 'money'), C('balance', 'Hozir qarzimiz', 'money')],
        rows, totals: sumOf(rows, ['salary', 'piece', 'bonus', 'fines', 'losses', 'earned', 'paid', 'balance']),
        note: '"Hozir qarzimiz" musbat — kompaniya xodimga qarzdor, manfiy — xodim kompaniyaga.', perm: 'finance.payroll',
      };
    },
  },
};

export const REPORT_LIST = Object.entries(REPORTS).map(([key, r]) => ({ key, title: r.title }));
// Which permission each report needs (besides reports.view).
export const REPORT_PERM = { staff_summary: 'finance.payroll', production_by_worker: 'reports.view' };

export function runReport(db, key, params, { costs = false } = {}) {
  const r = REPORTS[key];
  if (!r) return null;
  const out = r.run(db, params);
  // Without stock.costs: the cost columns, and any cost-type field a row carries even
  // when it is not shown as a column (rows are built with them for the totals).
  const COSTLY = ['cost', 'unit_cost', 'total_cost', 'profit', 'margin', 'value', 'open_value', 'close_value'];
  const hidden = new Set(costs ? [] : [...out.columns.filter((c) => c.cost).map((c) => c.key), ...COSTLY]);
  const strip = (row) => Object.fromEntries(Object.entries(row).filter(([k]) => !hidden.has(k)));
  return {
    key, title: r.title, from: params.from, to: params.to, note: out.note ?? null, chart: out.chart ?? null,
    columns: out.columns.filter((c) => !hidden.has(c.key)).map(({ cost, ...c }) => c),
    rows: out.rows.map(strip), totals: strip(out.totals ?? {}), summary: costs ? out.summary ?? null : null,
  };
}

// The same report as an Excel file.
export async function reportXlsx(rep) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(rep.title.slice(0, 30));
  ws.addRow([rep.title]).font = { bold: true, size: 14 };
  if (rep.from) ws.addRow([`Davr: ${rep.from} — ${rep.to}`]);
  ws.addRow([]);
  const head = ws.addRow(rep.columns.map((c) => c.label));
  head.font = { bold: true };
  head.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F2EE' } }; });
  for (const r of rep.rows) ws.addRow(rep.columns.map((c) => r[c.key] ?? ''));
  if (Object.keys(rep.totals).length) {
    const t = ws.addRow(rep.columns.map((c, i) => (i === 0 ? 'Jami' : rep.totals[c.key] ?? '')));
    t.font = { bold: true };
  }
  rep.columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    col.width = c.type === 'text' ? 28 : c.type === 'datetime' ? 18 : 14;
    if (c.type === 'money') col.numFmt = '#,##0';
    if (c.type === 'qty') col.numFmt = '#,##0.###';
  });
  if (rep.note) { ws.addRow([]); ws.addRow([rep.note]).font = { italic: true }; }
  return wb.xlsx.writeBuffer();
}
