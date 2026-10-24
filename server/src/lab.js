// Laboratory reports. A laborant records quality values (fat, water, acidity,
// antibiotic yes/no, …) against each ACCEPTED shift. The fields and their limits
// are configured in the panel. A value outside its limit flags the shift red
// until someone with lab.accept reviews and accepts it. Nothing about price,
// households or amounts is ever exposed here — only the shift number, the
// collector and the total real accepted kg.

const labelOf = (s) => `#${s.number}${s.copy_no ? `-copy${s.copy_no > 1 ? s.copy_no : ''}` : ''}`;

export const labFields = (db, { all = false } = {}) =>
  db.prepare(`SELECT id, name, type, limit_min, limit_max, bad_option, amount_on, amount_max, sort, active
    FROM lab_fields ${all ? '' : 'WHERE active = 1'} ORDER BY sort, id`).all();

// A variant field with "amount" on stores the kg next to its answer, under "<id>_q".
export const amountKey = (id) => `${id}_q`;

// Is one recorded value outside its field's limit? For a variant with an amount
// limit, "bor" is fine up to that many kg and flagged above it (no limit = free).
export function fieldOver(field, value, amount) {
  if (value == null || value === '') return false;
  if (field.type === 'variant') {
    if (String(value) === 'bor' && field.amount_on && field.amount_max != null) {
      const a = Number(amount);
      return Number.isFinite(a) && a > field.amount_max;
    }
    return field.bad_option != null && String(value) === field.bad_option;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) return false;
  if (field.limit_max != null && n > field.limit_max) return true;
  if (field.limit_min != null && n < field.limit_min) return true;
  return false;
}

// Per-field over flags + overall, for a set of values against the active fields.
export function evalReport(fields, vals) {
  const over = {};
  let any = false;
  for (const f of fields) { const o = fieldOver(f, vals[f.id], vals[amountKey(f.id)]); over[f.id] = o; if (o) any = true; }
  return { over, overLimit: any };
}

const statusOf = (rep) => (!rep ? 'pending' : rep.over_limit ? (rep.accepted_at ? 'accepted' : 'flagged') : 'ok');

// The lab-visible summary of accepted shifts: number, collector, total real kg,
// accepted time (sum of accepted real quantities, else the written total).
const SHIFT_LAB = `
  SELECT sh.id, sh.number, sh.copy_no, COALESCE(u.name, u.login) AS collector, sh.accepted_at,
    ROUND(COALESCE(sa.real_q, cq.q, 0), 2) AS total_kg
  FROM shifts sh JOIN users u ON u.id = sh.employee_id
  LEFT JOIN (SELECT shift_id, SUM(real_quantity) real_q FROM shift_accepts GROUP BY shift_id) sa ON sa.shift_id = sh.id
  LEFT JOIN (SELECT shift_uuid, SUM(quantity) q FROM collections GROUP BY shift_uuid) cq ON cq.shift_uuid = sh.client_uuid`;

export function labList(db, { days = 30 } = {}) {
  const rows = db.prepare(`${SHIFT_LAB}
    WHERE sh.status = 'accepted' AND u.is_test = 0 AND date(sh.accepted_at, '+5 hours') >= date('now', '+5 hours', ?)
    ORDER BY sh.accepted_at DESC LIMIT 300`).all(`-${Number(days) || 30} days`);
  const reports = Object.fromEntries(db.prepare('SELECT shift_id, over_limit, accepted_at FROM lab_reports').all().map((r) => [r.shift_id, r]));
  const out = rows.map((sh) => ({ ...sh, label: labelOf(sh), labStatus: statusOf(reports[sh.id]) }));
  return { shifts: out, flagged: out.filter((x) => x.labStatus === 'flagged').length };
}

export function labDetail(db, shiftId) {
  const sh = db.prepare(`${SHIFT_LAB} WHERE sh.id = ? AND sh.status = 'accepted'`).get(shiftId);
  if (!sh) return null;
  const fields = labFields(db);
  const rep = db.prepare('SELECT vals, over_limit, created_by, created_at, updated_at, accepted_by, accepted_at FROM lab_reports WHERE shift_id = ?').get(shiftId);
  const vals = rep ? JSON.parse(rep.vals) : {};
  const { over, overLimit } = evalReport(fields, vals);
  // Resolve a 'user:login' actor to a display name.
  const nameOf = (actor) => (actor
    ? (db.prepare("SELECT COALESCE(u.name, u.login) AS n FROM users u WHERE 'user:' || u.login = ?").get(actor)?.n ?? String(actor).replace(/^user:/, ''))
    : null);
  return {
    shift: { ...sh, label: labelOf(sh) },
    fields, values: vals, over, overLimit,
    labStatus: statusOf(rep),
    report: rep ? {
      created_by: nameOf(rep.created_by), created_at: rep.created_at, updated_at: rep.updated_at,
      accepted_by: nameOf(rep.accepted_by), accepted_at: rep.accepted_at,
    } : null,
  };
}

export function saveLab(db, shiftId, vals, actor) {
  const sh = db.prepare("SELECT id FROM shifts WHERE id = ? AND status = 'accepted'").get(shiftId);
  if (!sh) throw new Error('Smena topilmadi yoki qabul qilinmagan');
  const fields = labFields(db);
  const clean = {};
  for (const f of fields) {
    const v = vals?.[f.id] ?? vals?.[String(f.id)];
    if (v == null || v === '') continue;
    if (f.type === 'variant') {
      if (v === 'bor' || v === 'yoq') clean[f.id] = v;
      // The kg only makes sense for "bor".
      const q = Number(vals?.[amountKey(f.id)]);
      if (v === 'bor' && f.amount_on && Number.isFinite(q) && q >= 0 && vals?.[amountKey(f.id)] !== '' && vals?.[amountKey(f.id)] != null) {
        clean[amountKey(f.id)] = Math.round(q * 1000) / 1000;
      }
    } else { const n = Number(v); if (Number.isFinite(n)) clean[f.id] = Math.round(n * 1000) / 1000; }
  }
  const { overLimit } = evalReport(fields, clean);
  const exists = db.prepare('SELECT shift_id FROM lab_reports WHERE shift_id = ?').get(shiftId);
  if (exists) {
    // Editing the data clears any prior acceptance — a still-flagged report must be reviewed again.
    db.prepare("UPDATE lab_reports SET vals = ?, over_limit = ?, updated_at = datetime('now'), accepted_by = NULL, accepted_at = NULL WHERE shift_id = ?")
      .run(JSON.stringify(clean), overLimit ? 1 : 0, shiftId);
  } else {
    db.prepare('INSERT INTO lab_reports (shift_id, vals, over_limit, created_by) VALUES (?, ?, ?, ?)')
      .run(shiftId, JSON.stringify(clean), overLimit ? 1 : 0, actor);
  }
  return { overLimit };
}

export function acceptLab(db, shiftId, actor) {
  const rep = db.prepare('SELECT over_limit, accepted_at FROM lab_reports WHERE shift_id = ?').get(shiftId);
  if (!rep) throw new Error('Laboratoriya ma\'lumoti kiritilmagan');
  if (!rep.over_limit) throw new Error('Bu smenada limitdan o\'tgan qiymat yo\'q — qabul qilish shart emas');
  db.prepare("UPDATE lab_reports SET accepted_by = ?, accepted_at = datetime('now') WHERE shift_id = ?").run(actor, shiftId);
}

// v2.8 deployed — laboratory section live.
