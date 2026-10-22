// Supplier (household) money: what we bought (accepted shifts only), what we
// paid, manual balance corrections, and what we still owe.
//
//   balance = opening_balance + Σ round(quantity × price) over ACCEPTED shifts
//             − Σ payments + Σ manual adjustments
//
// Positive = we owe (qarzdorlik); negative = they owe us / advance (haqdorlik).
// Payments count immediately; milk counts only once its shift is accepted.
// Voided payments and test users never count. Amounts are whole so'm.
//
// An optional @asOf local date (YYYY-MM-DD) bounds every term by its business
// date, so a report for a past day shows the balance as it stood then — not now.

const NOT_TEST = 'NOT EXISTS (SELECT 1 FROM users t WHERE t.id = p.employee_id AND t.is_test = 1)';
const PURCHASED = `COALESCE((SELECT SUM(ROUND(c.quantity * c.price)) FROM collections c
  JOIN shifts sh ON sh.client_uuid = c.shift_uuid JOIN users u ON u.id = c.employee_id
  WHERE c.supplier_id = s.id AND sh.status = 'accepted' AND u.is_test = 0
    AND (@asOf IS NULL OR date(c.collected_at, '+5 hours') <= @asOf)), 0)`;
const PAID = `COALESCE((SELECT SUM(p.amount) FROM payments p
  WHERE p.supplier_id = s.id AND p.voided_at IS NULL AND ${NOT_TEST}
    AND (@asOf IS NULL OR date(p.paid_at, '+5 hours') <= @asOf)), 0)`;
const ADJUSTED = `COALESCE((SELECT SUM(a.delta) FROM adjustments a
  WHERE a.supplier_id = s.id AND (@asOf IS NULL OR date(a.created_at, '+5 hours') <= @asOf)), 0)`;

export const BALANCE_SQL = `ROUND(s.opening_balance + ${PURCHASED} - ${PAID} + ${ADJUSTED})`;

const digits = (v) => String(v ?? '').replace(/\D/g, '');
export function matchesSupplier(r, q) {
  const needle = (q ?? '').trim().toLowerCase();
  if (!needle) return true;
  const d = digits(needle);
  return r.name.toLowerCase().includes(needle) || (r.address ?? '').toLowerCase().includes(needle)
    || (d.length >= 2 && digits(r.phone).includes(d));
}

// asOf: a YYYY-MM-DD local date to value balances as of (inclusive), or null = now.
export function balances(db, { q, ids, asOf = null } = {}) {
  const rows = db.prepare(`
    SELECT s.id, s.name, s.phone, s.address, s.active, s.opening_balance,
      ${PURCHASED} AS purchased, ${PAID} AS paid, ${BALANCE_SQL} AS balance,
      (SELECT MAX(p.paid_at) FROM payments p WHERE p.supplier_id = s.id AND p.voided_at IS NULL AND ${NOT_TEST}) AS last_payment
    FROM suppliers s ORDER BY balance DESC, s.name`).all({ asOf });
  const list = rows.filter((r) => matchesSupplier(r, q) && (!ids || ids.has(r.id)));
  const totals = {
    weOwe: list.reduce((a, r) => a + Math.max(0, r.balance), 0),
    theyOwe: list.reduce((a, r) => a + Math.max(0, -r.balance), 0),
  };
  return { rows: list, totals };
}

export function supplierBalance(db, supplierId, asOf = null) {
  return db.prepare(`SELECT ${BALANCE_SQL} AS b FROM suppliers s WHERE s.id = @id`).get({ id: supplierId, asOf })?.b ?? 0;
}

// Chronological statement (akt-sverka) with a running balance: pickups, payments
// and manual balance corrections, newest last before the reverse at the end.
export function statement(db, supplierId, { limit = 500 } = {}) {
  const s = db.prepare('SELECT opening_balance FROM suppliers WHERE id = ?').get(supplierId);
  if (!s) return null;
  const pickups = db.prepare(`
    SELECT 'pickup' AS kind, c.id, c.collected_at AS at, c.quantity, c.price, p.name AS product_name, p.unit,
      CAST(ROUND(c.quantity * c.price) AS INTEGER) AS amount, u.name AS by_name, sh.id AS shift_id, sh.number AS shift_number, sh.copy_no
    FROM collections c JOIN shifts sh ON sh.client_uuid = c.shift_uuid JOIN products p ON p.id = c.product_id
    JOIN users u ON u.id = c.employee_id
    WHERE c.supplier_id = ? AND sh.status = 'accepted' AND u.is_test = 0`).all(supplierId);
  const pays = db.prepare(`
    SELECT 'payment' AS kind, id, number, paid_at AS at, amount, method, note, voided_at, void_reason,
      COALESCE((SELECT COALESCE(u.name, u.login) FROM users u WHERE 'user:' || u.login = p.created_by), created_by) AS by_name
    FROM payments p WHERE supplier_id = ? AND ${NOT_TEST}`).all(supplierId);
  const adjusts = db.prepare(`
    SELECT 'adjust' AS kind, id, created_at AS at, delta AS amount, note, NULL AS voided_at,
      COALESCE((SELECT COALESCE(u.name, u.login) FROM users u WHERE 'user:' || u.login = a.created_by), created_by) AS by_name
    FROM adjustments a WHERE supplier_id = ?`).all(supplierId);
  const entries = [...pickups, ...pays, ...adjusts].sort((a, b) => a.at.localeCompare(b.at) || a.kind.localeCompare(b.kind) || a.id - b.id);
  let running = s.opening_balance;
  for (const e of entries) {
    if (e.kind === 'pickup') running += e.amount;
    else if (e.kind === 'adjust') running += e.amount;
    else if (!e.voided_at) running -= e.amount;
    e.balance = Math.round(running);
  }
  return { opening: s.opening_balance, balance: Math.round(running), entries: entries.reverse().slice(0, limit) };
}
