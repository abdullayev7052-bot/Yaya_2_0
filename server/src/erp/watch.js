// Background checks (every minute): products kept too long in the incubator and
// tasks running past their time limit. Each raises one alert naming the people
// responsible; it closes by itself when the cause is gone (product taken out,
// task finished or cancelled). Who sees an alert: managers (alerts.view), and in
// the app the people named in it (payload.userIds) and the warehouse's keepers.
import { addAlert, holderName } from './stock.js';
import { accrueSalaries } from './finance.js';

const EPS = 0.0005;
const minutes = (iso) => (Date.now() - Date.parse(iso.endsWith('Z') || iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`)) / 60000;
const openAlert = (db, type, key, id) => db.prepare(`SELECT id FROM alerts WHERE type = ? AND resolved_at IS NULL AND json_extract(payload, '$.${key}') = ?`).get(type, id);

// Lots in incubator warehouses longer than the product's dwell time.
export function checkDwell(db) {
  const rows = db.prepare(`SELECT m.warehouse_id, m.lot_id, m.product_id, SUM(m.qty) AS q, MAX(CASE WHEN m.qty > 0 THEN m.at END) AS since,
      p.name AS product, p.unit, p.dwell_hours, w.name AS warehouse
    FROM stock_moves m JOIN warehouses w ON w.id = m.warehouse_id JOIN products p ON p.id = m.product_id
    WHERE w.kind = 'incubator' AND m.lot_id IS NOT NULL AND p.dwell_hours > 0
    GROUP BY m.warehouse_id, m.lot_id HAVING SUM(m.qty) > ${EPS}`).all();
  const live = new Set();
  for (const r of rows) {
    const key = `${r.warehouse_id}:${r.lot_id}`;
    if (!r.since || minutes(r.since) < r.dwell_hours * 60) continue;
    live.add(key);
    if (openAlert(db, 'dwell.over', 'key', key)) continue;
    const keepers = db.prepare('SELECT user_id FROM warehouse_keepers WHERE warehouse_id = ?').all(r.warehouse_id).map((k) => k.user_id);
    const names = keepers.map((id) => holderName(db, { userId: id })).join(', ');
    addAlert(db, 'dwell.over', `"${r.warehouse}": ${r.product} (${Math.round(r.q * 1000) / 1000} ${r.unit}) ${r.dwell_hours} soatdan ortiq turibdi — olib chiqing${names ? `. Mas'ul: ${names}` : ''}`,
      { key, warehouseId: r.warehouse_id, lotId: r.lot_id, userIds: keepers });
  }
  // Taken out (or no longer overdue): close the alert.
  for (const a of db.prepare("SELECT id, json_extract(payload, '$.key') AS key FROM alerts WHERE type = 'dwell.over' AND resolved_at IS NULL").all()) {
    if (!live.has(a.key)) db.prepare("UPDATE alerts SET resolved_at = datetime('now'), resolved_by = 'system' WHERE id = ?").run(a.id);
  }
}

// Open tasks past their recipe's time limit.
export function checkLateTasks(db) {
  const rows = db.prepare(`SELECT t.id, t.number, t.created_at, r.name AS recipe, r.max_minutes, s.user_id FROM prod_tasks t
    JOIN recipes r ON r.id = t.recipe_id JOIN prod_shifts s ON s.id = t.shift_id
    WHERE t.status = 'open' AND r.max_minutes > 0`).all();
  const live = new Set();
  for (const t of rows) {
    if (minutes(t.created_at) < t.max_minutes) continue;
    live.add(t.id);
    if (openAlert(db, 'task.late', 'taskId', t.id)) continue;
    addAlert(db, 'task.late', `TQ-${t.number} (${t.recipe}) — ${holderName(db, { userId: t.user_id })}: ${t.max_minutes} daqiqadan oshdi`,
      { taskId: t.id, userIds: [t.user_id] });
  }
  for (const a of db.prepare("SELECT id, json_extract(payload, '$.taskId') AS taskId FROM alerts WHERE type = 'task.late' AND resolved_at IS NULL").all()) {
    if (!live.has(a.taskId)) db.prepare("UPDATE alerts SET resolved_at = datetime('now'), resolved_by = 'system' WHERE id = ?").run(a.id);
  }
}

export function runChecks(db) {
  try { checkDwell(db); checkLateTasks(db); accrueSalaries(db); } catch (e) { console.error('erp checks:', e.message); }
}

// Alerts for one person in the app: those naming them, those of warehouses they
// keep, and everything for managers.
export function alertsFor(db, user, perms) {
  const rows = db.prepare('SELECT id, type, text, payload, doc_id, created_at FROM alerts WHERE resolved_at IS NULL ORDER BY id DESC LIMIT 100').all()
    .map((a) => ({ ...a, payload: a.payload ? JSON.parse(a.payload) : null }));
  if (perms.has('alerts.view')) return rows;
  const keeps = new Set(db.prepare('SELECT warehouse_id FROM warehouse_keepers WHERE user_id = ?').all(user.id).map((r) => r.warehouse_id));
  return rows.filter((a) => a.payload?.userIds?.includes(user.id) || (a.payload?.warehouseId && keeps.has(a.payload.warehouseId)));
}
