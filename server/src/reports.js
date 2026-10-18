// All money/quantity arithmetic for reports lives here, in SQL, so every screen
// and export agrees to the last so'm.
//
// Only ACCEPTED shifts count. Open shifts are drafts, closed shifts await
// acceptance, cancelled shifts never happened. Test users never count.
// Amount per pickup = round(quantity × price stamped at acceptance).

// Uzbekistan is UTC+5 all year (no DST); report days follow local time.
export const LOCAL_DAY = "date(c.collected_at, '+5 hours')";
export const todayLocal = () => new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s ?? '');

export function parseRange(q = {}) {
  const to = isDay(q.to) ? q.to : todayLocal();
  const from = isDay(q.from) ? q.from : to;
  return from <= to ? { from, to } : { from: to, to: from };
}

export const ACCEPTED = "sh.status = 'accepted' AND u.is_test = 0";
export const BASE = `FROM collections c JOIN shifts sh ON sh.client_uuid = c.shift_uuid JOIN users u ON u.id = c.employee_id
  JOIN suppliers s ON s.id = c.supplier_id JOIN products p ON p.id = c.product_id`;
const AGG = `COUNT(*) AS pickups, ROUND(SUM(c.quantity), 2) AS quantity,
  CAST(SUM(ROUND(c.quantity * c.price)) AS INTEGER) AS amount`;

function where(q) {
  const parts = [`${LOCAL_DAY} BETWEEN @from AND @to`, ACCEPTED];
  const params = parseRange(q);
  for (const [k, col] of [['employee', 'c.employee_id'], ['supplier', 'c.supplier_id'], ['product', 'c.product_id']]) {
    const v = Number(q[k]);
    if (Number.isInteger(v) && v > 0) {
      parts.push(`${col} = @${k}`);
      params[k] = v;
    }
  }
  return { sql: parts.join(' AND '), params };
}

const withAvg = (p) => ({ ...p, avg_cost: p.quantity ? Math.round((p.amount / p.quantity) * 100) / 100 : null });

export function summary(db, q) {
  const w = where(q);
  const run = (sql) => db.prepare(sql).all(w.params);
  const totals = db.prepare(`SELECT ${AGG}, COUNT(DISTINCT c.supplier_id) AS suppliers, COUNT(DISTINCT sh.id) AS shifts
    ${BASE} WHERE ${w.sql}`).get(w.params);
  return {
    range: parseRange(q),
    totals: { pickups: totals.pickups, quantity: totals.quantity ?? 0, amount: totals.amount ?? 0, suppliers: totals.suppliers, shifts: totals.shifts },
    byProduct: run(`SELECT p.id, p.name, p.unit, ${AGG}, COUNT(DISTINCT c.supplier_id) AS suppliers,
        MIN(c.price) AS min_price, MAX(c.price) AS max_price
      ${BASE} WHERE ${w.sql} GROUP BY p.id ORDER BY quantity DESC`).map(withAvg),
    byDay: run(`SELECT ${LOCAL_DAY} AS day, p.id AS product_id, p.name AS product_name, ${AGG}
      ${BASE} WHERE ${w.sql} GROUP BY day, p.id ORDER BY day`),
    byEmployee: run(`SELECT u.id, u.name, ${AGG}, COUNT(DISTINCT c.supplier_id) AS suppliers, COUNT(DISTINCT sh.id) AS shifts
      ${BASE} WHERE ${w.sql} GROUP BY u.id ORDER BY quantity DESC`),
    bySupplier: run(`SELECT s.id, s.name, ${AGG}, MAX(c.collected_at) AS last_at
      ${BASE} WHERE ${w.sql} GROUP BY s.id ORDER BY quantity DESC`),
  };
}

// Weighted average purchase cost per product for one local day:
//   average cost = Σ round(quantity × price) / Σ quantity
// i.e. total money spent divided by total amount bought — not the plain average
// of prices, which would give a small supplier the same weight as a big one.
// Only accepted shifts count; the status block says what is still pending.
export function dailyCost(db, day) {
  const s = summary(db, { from: day, to: day });
  const shifts = db.prepare(`SELECT sh.status, COUNT(*) AS n FROM shifts sh JOIN users u ON u.id = sh.employee_id
    WHERE u.is_test = 0 AND date(sh.opened_at, '+5 hours') = ? GROUP BY sh.status`).all(day);
  const count = Object.fromEntries(shifts.map((r) => [r.status, r.n]));
  return {
    day,
    products: s.byProduct,
    overall: withAvg({ quantity: s.totals.quantity, amount: s.totals.amount }),
    shifts: { open: count.open ?? 0, closed: count.closed ?? 0, accepted: count.accepted ?? 0, cancelled: count.cancelled ?? 0 },
    final: !(count.open || count.closed),
  };
}

// Flat rows for CSV export (opens directly in Excel).
export function exportRows(db, q) {
  const w = where(q);
  return db.prepare(`SELECT c.id, sh.number || CASE WHEN sh.copy_no > 0 THEN '-copy' || CASE WHEN sh.copy_no > 1 THEN sh.copy_no ELSE '' END ELSE '' END AS shift,
      datetime(c.collected_at, '+5 hours') AS local_time, u.name AS employee,
      s.name AS supplier, p.name AS product, p.unit, c.quantity, c.price,
      CAST(ROUND(c.quantity * c.price) AS INTEGER) AS amount
    ${BASE} WHERE ${w.sql} ORDER BY c.collected_at`).all(w.params);
}

export function toCsv(rows, headers) {
  const cell = (v) => {
    const s = v == null ? '' : String(v);
    // Neutralise spreadsheet formula injection and quote when needed.
    const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
    return /[";\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const lines = [headers.map((h) => cell(h[1])).join(';')];
  for (const r of rows) lines.push(headers.map((h) => cell(r[h[0]])).join(';'));
  // BOM so Excel reads UTF-8 (Uzbek letters) correctly.
  return '﻿' + lines.join('\r\n');
}
