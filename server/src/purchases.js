// "Purchases" view. A purchase is one household's pickup within an ACCEPTED shift
// (all its products together), numbered by the household's order in that shift:
// 24-2 is the 2nd household served in shift 24. Each shift's accepted-quantity
// difference is one extra synthetic purchase at the end (24-<n+1>): its quantity is
// the total gap (can be negative), its price and sum are 0, and it is counted in
// the totals (so the total quantity reflects the real accepted amount).
import { LOCAL_DAY, ACCEPTED, parseRange } from './reports.js';

const label = (number, copy_no) => `#${number}${copy_no ? `-copy${copy_no > 1 ? copy_no : ''}` : ''}`;
const purNo = (number, seq) => `${number}-${seq}`;

function filterClause(q, { households = true } = {}) {
  const range = parseRange(q);
  const params = { from: range.from, to: range.to };
  const conds = [`${LOCAL_DAY} BETWEEN @from AND @to`, ACCEPTED];
  const emp = Number(q.employee); if (Number.isInteger(emp) && emp > 0) { conds.push('sh.employee_id = @employee'); params.employee = emp; }
  const num = Number(q.shift); if (Number.isInteger(num) && num > 0) { conds.push('sh.number = @shift'); params.shift = num; }
  return { conds, params, range };
}

// All purchases (household visits) + the per-shift difference rows, numbered,
// newest first. supplier filter is applied after numbering so seq stays stable.
export function purchaseList(db, q) {
  const { conds, params, range } = filterClause(q);
  const rows = db.prepare(`
    WITH hh AS (
      SELECT sh.id AS shift_id, sh.number AS shift_number, sh.copy_no, sh.employee_id, c.supplier_id,
        MIN(c.collected_at) AS at, ROUND(SUM(c.quantity), 2) AS quantity,
        CAST(SUM(ROUND(c.quantity * c.price)) AS INTEGER) AS amount
      FROM collections c JOIN shifts sh ON sh.client_uuid = c.shift_uuid JOIN users u ON u.id = sh.employee_id
      WHERE ${conds.join(' AND ')}
      GROUP BY sh.id, c.supplier_id)
    SELECT hh.*, ROW_NUMBER() OVER (PARTITION BY hh.shift_id ORDER BY hh.at, hh.supplier_id) AS seq,
      s.name AS supplier, COALESCE(u.name, u.login) AS collector
    FROM hh JOIN suppliers s ON s.id = hh.supplier_id JOIN users u ON u.id = hh.employee_id
    ORDER BY hh.shift_number DESC, seq`).all(params);

  // Count of households per shift, to place each shift's difference row last.
  const perShift = new Map();
  for (const r of rows) perShift.set(r.shift_id, (perShift.get(r.shift_id) || 0) + 1);

  const supplier = Number(q.supplier);
  const wantSupplier = Number.isInteger(supplier) && supplier > 0;

  const out = rows
    .filter((r) => (wantSupplier ? r.supplier_id === supplier : true))
    .map((r) => ({
      number: purNo(r.shift_number, r.seq), shift_id: r.shift_id, shift: label(r.shift_number, r.copy_no),
      at: r.at, collector: r.collector, supplier: r.supplier, supplier_id: r.supplier_id,
      quantity: r.quantity, amount: r.amount, isDiff: false,
    }));

  // The difference rows (one per shift), unless a specific household is filtered.
  if (!wantSupplier) {
    const diffs = db.prepare(`
      SELECT sh.id AS shift_id, sh.number AS shift_number, sh.copy_no, COALESCE(u.name, u.login) AS collector, sh.accepted_at,
        ROUND(COALESCE((SELECT SUM(real_quantity) FROM shift_accepts WHERE shift_id = sh.id), 0)
          - COALESCE((SELECT SUM(quantity) FROM collections WHERE shift_uuid = sh.client_uuid), 0), 2) AS diff
      FROM shifts sh JOIN users u ON u.id = sh.employee_id
      WHERE sh.status = 'accepted' AND u.is_test = 0 AND EXISTS (SELECT 1 FROM shift_accepts WHERE shift_id = sh.id)
        AND date(sh.accepted_at, '+5 hours') BETWEEN @from AND @to ${params.employee ? 'AND sh.employee_id = @employee' : ''} ${params.shift ? 'AND sh.number = @shift' : ''}`)
      .all(params).filter((d) => d.diff !== 0);
    for (const d of diffs) {
      out.push({
        number: purNo(d.shift_number, (perShift.get(d.shift_id) || 0) + 1), shift_id: d.shift_id, shift: label(d.shift_number, d.copy_no),
        at: d.accepted_at, collector: d.collector, supplier: 'Farq (smena)', supplier_id: null,
        quantity: d.diff, amount: 0, isDiff: true,
      });
    }
    out.sort((a, b) => (a.shift_id === b.shift_id ? a.number.localeCompare(b.number, undefined, { numeric: true }) : b.shift_id - a.shift_id));
  }

  const totals = out.reduce((t, r) => ({ quantity: Math.round((t.quantity + r.quantity) * 100) / 100, amount: t.amount + r.amount, count: t.count + 1 }),
    { quantity: 0, amount: 0, count: 0 });
  return { rows: out, totals, range };
}

// Product breakdown of one household's purchase in one shift (for drill-in / bot).
export function purchaseBreakdown(db, shiftId, supplierId) {
  return db.prepare(`SELECT p.name AS product, p.unit, ROUND(SUM(c.quantity), 2) AS quantity,
      CAST(ROUND(AVG(COALESCE(c.price, 0))) AS INTEGER) AS price, CAST(SUM(ROUND(c.quantity * COALESCE(c.price, 0))) AS INTEGER) AS amount
    FROM collections c JOIN products p ON p.id = c.product_id
    WHERE c.shift_uuid = (SELECT client_uuid FROM shifts WHERE id = ?) AND c.supplier_id = ?
    GROUP BY c.product_id ORDER BY p.name`).all(shiftId, supplierId);
}

// Flat rows for CSV export.
export function purchaseRows(db, q) {
  return purchaseList(db, q).rows.map((r) => ({
    number: r.number, shift: r.shift, local_time: r.at ? `'${r.at}` : '', collector: r.collector,
    supplier: r.supplier, quantity: r.quantity, amount: r.amount,
  }));
}
