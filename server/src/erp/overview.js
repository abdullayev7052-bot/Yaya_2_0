// The panel's home page: one view over the whole chain — milk collection,
// warehouses, production, alerts and the money side of losses. Each block is
// included only for people allowed to see that part.
import { dailyCost, todayLocal } from '../reports.js';
import { r2, r3 } from './stock.js';

const EPS = 0.0005;

export function overview(db, perms, day = todayLocal()) {
  const can = (p) => perms.has(p);
  const out = { day };

  if (can('reports.view')) {
    const d = dailyCost(db, day);
    out.milk = {
      quantity: r3(d.overall.quantity ?? 0), amount: can('prices.view') ? d.overall.amount ?? 0 : undefined,
      shifts: d.shifts, products: d.products.map((p) => ({ name: p.name, quantity: p.quantity })),
    };
  }

  if (can('stock.view_all')) {
    const rows = db.prepare(`SELECT p.kind, m.product_id, p.name, p.unit, m.warehouse_id, m.holder_id, SUM(m.qty) AS q, SUM(m.cost) AS c
      FROM stock_moves m JOIN products p ON p.id = m.product_id GROUP BY m.product_id, m.warehouse_id, m.holder_id HAVING ABS(SUM(m.qty)) > ${EPS}`).all();
    const byKind = {};
    for (const r of rows) {
      const k = (byKind[r.kind] ??= { qty: 0, cost: 0, items: 0 });
      k.qty += r.q; k.cost += r.c; k.items += 1;
    }
    for (const k of Object.values(byKind)) { k.qty = r3(k.qty); k.cost = r2(k.cost); }
    out.stock = {
      value: r2(rows.reduce((a, r) => a + r.c, 0)),
      raw_milk: r3(rows.filter((r) => r.kind === 'raw_milk').reduce((a, r) => a + r.q, 0)),
      by_kind: byKind,
      negative: rows.filter((r) => r.q < -EPS).length,
      in_hands: rows.filter((r) => r.holder_id && r.q > EPS).length,
      expiring: db.prepare(`SELECT COUNT(*) AS n FROM (SELECT m.lot_id FROM stock_moves m JOIN lots l ON l.id = m.lot_id
        WHERE l.expires_at IS NOT NULL AND l.expires_at <= datetime('now', '+2 days') GROUP BY m.lot_id HAVING SUM(m.qty) > ${EPS})`).get().n,
      waiting_handovers: db.prepare("SELECT COUNT(*) AS n FROM docs WHERE type = 'transfer' AND status = 'sent'").get().n,
      draft_counts: db.prepare("SELECT COUNT(*) AS n FROM docs WHERE type = 'inventory' AND status = 'draft'").get().n,
    };
  }

  if (can('prod.view') || can('prod.approve') || can('prod.manage')) {
    const tasks = db.prepare(`SELECT p.name, p.unit, SUM(dl.qty) AS q FROM prod_tasks t JOIN doc_lines dl ON dl.doc_id = t.doc_id JOIN products p ON p.id = dl.product_id
      WHERE t.status = 'done' AND date(t.done_at, '+5 hours') = ? AND json_extract(dl.meta, '$.role') = 'out' GROUP BY p.id ORDER BY q DESC`).all(day);
    out.production = {
      open_shifts: db.prepare("SELECT COUNT(*) AS n FROM prod_shifts WHERE status = 'open'").get().n,
      approvals: db.prepare("SELECT (SELECT COUNT(*) FROM prod_tasks WHERE status = 'approval') + (SELECT COUNT(*) FROM prod_shifts WHERE status = 'approval') AS n").get().n,
      tasks_done: db.prepare("SELECT COUNT(*) AS n FROM prod_tasks WHERE status = 'done' AND date(done_at, '+5 hours') = ?").get(day).n,
      milk_used: r3(db.prepare("SELECT COALESCE(SUM(milk_qty), 0) AS q FROM prod_tasks WHERE status = 'done' AND date(done_at, '+5 hours') = ?").get(day).q),
      output: tasks.map((t) => ({ name: t.name, unit: t.unit, qty: r3(t.q) })),
    };
  }

  if (can('alerts.view')) {
    out.alerts = {
      open: db.prepare('SELECT COUNT(*) AS n FROM alerts WHERE resolved_at IS NULL').get().n,
      latest: db.prepare('SELECT id, type, text, doc_id, created_at FROM alerts WHERE resolved_at IS NULL ORDER BY id DESC LIMIT 6').all(),
    };
  }

  if (can('stock.costs')) {
    // This month's warehouse and production losses / gains by category.
    const month = day.slice(0, 7);
    out.pnl = db.prepare(`SELECT c.name, c.kind, ROUND(SUM(e.amount), 2) AS amount FROM pnl_entries e JOIN pnl_categories c ON c.id = e.category_id
      WHERE strftime('%Y-%m', e.at, '+5 hours') = ? GROUP BY c.id HAVING ABS(SUM(e.amount)) >= 0.01 ORDER BY ABS(SUM(e.amount)) DESC`).all(month);
  }
  return out;
}
