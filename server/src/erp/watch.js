// Background checks (every minute): tasks running past their time limit (the
// incubator's hourly timer was taken out in stage 10). Each raises one alert naming the people
// responsible; it closes by itself when the cause is gone (product taken out,
// task finished or cancelled). Who sees an alert: managers (alerts.view), and in
// the app the people named in it (payload.userIds) and the warehouse's keepers.
import { addAlert, holderName } from './stock.js';
import { accrueSalaries } from './finance.js';

const EPS = 0.0005;
const minutes = (iso) => (Date.now() - Date.parse(iso.endsWith('Z') || iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`)) / 60000;
const openAlert = (db, type, key, id) => db.prepare(`SELECT id FROM alerts WHERE type = ? AND resolved_at IS NULL AND json_extract(payload, '$.${key}') = ?`).get(type, id);

// Open tasks past their recipe's time limit.
export function checkLateTasks(db) {
  const rows = db.prepare(`SELECT t.id, t.number, t.created_at, r.name AS recipe, r.max_minutes, COALESCE(t.user_id, s.user_id) AS user_id FROM prod_tasks t
    JOIN recipes r ON r.id = t.recipe_id LEFT JOIN prod_shifts s ON s.id = t.shift_id
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
  try { checkLateTasks(db); accrueSalaries(db); } catch (e) { console.error('erp checks:', e.message); }
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
