// Reports API (Yaya 2.0, stage 8), under /api/erp/reports. Needs reports.view;
// cost / profit columns only with stock.costs; the staff report also needs
// finance.payroll. Every report is available as an Excel file too.
import { makeGuard } from '../auth.js';
import { REPORT_LIST, REPORT_PERM, reportXlsx, runReport } from '../erp/reports.js';
import { r2, r3 } from '../erp/stock.js';

const today = () => new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);
const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v ?? '');

export default async function reportsRoutes(app, { db }) {
  const need = makeGuard(app, db);
  const allowed = (req, key) => !REPORT_PERM[key] || req.me.perms.has(REPORT_PERM[key]);
  const params = (q) => ({
    from: isDay(q.from) ? q.from : `${today().slice(0, 7)}-01`, to: isDay(q.to) ? q.to : today(),
    warehouseId: Number(q.warehouseId) || null, days: Number(q.days) || 3,
  });

  app.get('/', need('reports.view'), async (req) => REPORT_LIST.filter((r) => allowed(req, r.key)));

  // Daily figures for the Bosh panel chart: milk collected and production.
  app.get('/trend', need('reports.view'), async (req) => {
    const days = Math.min(90, Math.max(7, Number(req.query.days) || 14));
    const from = new Date(Date.now() + 5 * 3600e3 - (days - 1) * 864e5).toISOString().slice(0, 10);
    const local = (c) => `date(${c}, '+5 hours')`;
    const milk = db.prepare(`SELECT ${local('c.collected_at')} AS d, SUM(c.quantity) AS q FROM collections c JOIN shifts s ON s.client_uuid = c.shift_uuid
      WHERE s.status = 'accepted' AND ${local('c.collected_at')} >= ? GROUP BY d`).all(from);
    const prod = db.prepare(`SELECT ${local('done_at')} AS d, COUNT(*) AS n, SUM(milk_qty) AS milk FROM prod_tasks WHERE status = 'done' AND ${local('done_at')} >= ? GROUP BY d`).all(from);
    const out = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(Date.parse(from) + i * 864e5).toISOString().slice(0, 10);
      out.push({ day: d, milk: r3(milk.find((x) => x.d === d)?.q ?? 0), tasks: prod.find((x) => x.d === d)?.n ?? 0, milk_used: r3(prod.find((x) => x.d === d)?.milk ?? 0) });
    }
    return out;
  });

  app.get('/:key', need('reports.view'), async (req, reply) => {
    if (!allowed(req, req.params.key)) return reply.code(403).send({ error: "Ruxsat yo'q" });
    const rep = runReport(db, req.params.key, params(req.query), { costs: req.me.perms.has('stock.costs') });
    return rep ?? reply.code(404).send({ error: 'Topilmadi' });
  });
  app.get('/:key/xlsx', need('reports.view'), async (req, reply) => {
    if (!allowed(req, req.params.key)) return reply.code(403).send({ error: "Ruxsat yo'q" });
    if (!req.me.perms.has('reports.export')) return reply.code(403).send({ error: "Excel'ga yuklash uchun ruxsat yo'q" });
    const rep = runReport(db, req.params.key, params(req.query), { costs: req.me.perms.has('stock.costs') });
    if (!rep) return reply.code(404).send({ error: 'Topilmadi' });
    reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    reply.header('Content-Disposition', `attachment; filename="${req.params.key}-${rep.from ?? ''}-${rep.to ?? ''}.xlsx"`);
    return Buffer.from(await reportXlsx(rep));
  });
}
