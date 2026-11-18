// Production API (Yaya 2.0, stage 2), under /api/erp/prod. The technologist works
// on their own shift (prod.work); managers see everything (prod.view), approve
// over-limit tasks and shifts (prod.approve) and set recipes and limits (prod.manage).
// Sums are stripped for anyone without stock.costs, exactly as in the warehouse API.
import { audit } from '../db/index.js';
import { makeGuard } from '../auth.js';
import { StockError } from '../erp/stock.js';
import {
  approvals, approveShift, approveTask, cancelTask, closeShift, completeTask, createTask, listRecipes, listShifts, myShift, openShift,
  recipeDetail, rejectShiftApproval, rejectTaskApproval, saveRecipe, shiftDetail, taskDetail,
} from '../erp/production.js';
import { stripCosts } from './erp.js';

export default async function productionRoutes(app, { db }) {
  const need = makeGuard(app, db);
  const has = (req, p) => req.me.perms.has(p);
  const bad = (reply, msg, details) => reply.code(400).send({ error: msg, details });
  const deny = (reply) => reply.code(403).send({ error: "Ruxsat yo'q" });
  const log = (req, action, details) => audit(db, req.actor, action, details);
  const run = (reply, fn) => {
    try { return fn(); } catch (e) { if (e instanceof StockError) return bad(reply, e.message, e.details); throw e; }
  };
  app.addHook('preSerialization', async (req, reply, payload) => (req.me && !req.me.perms.has('stock.costs') ? stripCosts(payload) : payload));

  const viewAll = (req) => has(req, 'prod.view') || has(req, 'prod.approve') || has(req, 'prod.manage');
  const shiftOfTask = (id) => db.prepare('SELECT s.* FROM prod_tasks t JOIN prod_shifts s ON s.id = t.shift_id WHERE t.id = ?').get(id);

  // ---------------------------------------------------------------- recipes
  app.get('/recipes', need(), async (req, reply) => {
    if (!has(req, 'prod.work') && !viewAll(req)) return deny(reply);
    return listRecipes(db, { all: req.query.all === '1' && has(req, 'prod.manage') });
  });
  app.get('/recipes/:id', need(), async (req, reply) => {
    if (!has(req, 'prod.work') && !viewAll(req)) return deny(reply);
    return recipeDetail(db, Number(req.params.id)) ?? reply.code(404).send({ error: 'Topilmadi' });
  });
  app.post('/recipes', need('prod.manage'), async (req, reply) => run(reply, () => {
    const id = saveRecipe(db, null, req.body ?? {});
    log(req, 'recipe.create', { id, name: req.body?.name });
    return recipeDetail(db, id);
  }));
  app.put('/recipes/:id', need('prod.manage'), async (req, reply) => run(reply, () => {
    const id = saveRecipe(db, Number(req.params.id), req.body ?? {});
    log(req, 'recipe.update', { id, name: req.body?.name });
    return recipeDetail(db, id);
  }));

  // ---------------------------------------------------------------- my shift (technologist)
  app.get('/shift', need('prod.work'), async (req) => {
    const s = myShift(db, req.me.id);
    return { shift: s ? shiftDetail(db, s.id) : null };
  });
  app.post('/shift', need('prod.work'), async (req, reply) => run(reply, () => {
    const s = openShift(db, { uuid: req.body?.uuid, userId: req.me.id });
    log(req, 'prod.shift.open', { id: s.id, number: s.number });
    return { shift: shiftDetail(db, s.id) };
  }));
  app.post('/shifts/:id/close', need(), async (req, reply) => {
    const s = db.prepare('SELECT * FROM prod_shifts WHERE id = ?').get(Number(req.params.id));
    if (!s) return reply.code(404).send({ error: 'Topilmadi' });
    if (s.user_id !== req.me.id || !has(req, 'prod.work')) return deny(reply);
    return run(reply, () => {
      const r = closeShift(db, s.id, req.body ?? {}, { actor: req.actor });
      log(req, r.needApproval ? 'prod.shift.approval' : 'prod.shift.close', { id: s.id, number: s.number });
      return r;
    });
  });

  // ---------------------------------------------------------------- shifts (managers)
  app.get('/shifts', need(), async (req, reply) => {
    if (!viewAll(req)) return listShifts(db, { userId: req.me.id });
    return listShifts(db, { status: req.query.status || null, from: req.query.from || null, to: req.query.to || null, userId: Number(req.query.userId) || null });
  });
  app.get('/shifts/:id', need(), async (req, reply) => {
    const d = shiftDetail(db, Number(req.params.id));
    if (!d) return reply.code(404).send({ error: 'Topilmadi' });
    if (d.user_id !== req.me.id && !viewAll(req)) return deny(reply);
    return d;
  });
  app.post('/shifts/:id/approve', need('prod.approve'), async (req, reply) => run(reply, () => {
    const r = approveShift(db, Number(req.params.id), req.actor, req.body?.note);
    log(req, 'prod.shift.approve', { id: Number(req.params.id), note: req.body?.note });
    return r;
  }));
  app.post('/shifts/:id/reject', need('prod.approve'), async (req, reply) => run(reply, () => {
    const r = rejectShiftApproval(db, Number(req.params.id), req.actor, req.body?.note);
    log(req, 'prod.shift.reject', { id: Number(req.params.id), note: req.body?.note });
    return r;
  }));

  // ---------------------------------------------------------------- tasks
  app.post('/tasks', need('prod.work'), async (req, reply) => {
    const s = myShift(db, req.me.id);
    if (!s) return bad(reply, 'Avval smena oching');
    return run(reply, () => {
      const t = createTask(db, { ...req.body, shiftId: s.id }, { actor: req.actor });
      log(req, 'prod.task.create', { id: t.id, number: t.number });
      return taskDetail(db, t.id);
    });
  });
  app.get('/tasks/:id', need(), async (req, reply) => {
    const t = taskDetail(db, Number(req.params.id));
    if (!t) return reply.code(404).send({ error: 'Topilmadi' });
    if (shiftOfTask(t.id)?.user_id !== req.me.id && !viewAll(req)) return deny(reply);
    return t;
  });
  app.post('/tasks/:id/complete', need('prod.work'), async (req, reply) => {
    const s = shiftOfTask(Number(req.params.id));
    if (!s) return reply.code(404).send({ error: 'Topilmadi' });
    if (s.user_id !== req.me.id) return deny(reply);
    return run(reply, () => {
      const r = completeTask(db, Number(req.params.id), req.body ?? {}, { actor: req.actor });
      log(req, r.needApproval ? 'prod.task.approval' : 'prod.task.done', { id: Number(req.params.id) });
      return r;
    });
  });
  app.post('/tasks/:id/cancel', need(), async (req, reply) => {
    const s = shiftOfTask(Number(req.params.id));
    if (!s) return reply.code(404).send({ error: 'Topilmadi' });
    if (!(s.user_id === req.me.id && has(req, 'prod.work')) && !has(req, 'prod.approve')) return deny(reply);
    return run(reply, () => {
      const r = cancelTask(db, Number(req.params.id), req.actor, req.body?.reason);
      log(req, 'prod.task.cancel', { id: Number(req.params.id), reason: req.body?.reason });
      return r;
    });
  });
  app.post('/tasks/:id/approve', need('prod.approve'), async (req, reply) => run(reply, () => {
    const r = approveTask(db, Number(req.params.id), req.actor, req.body?.note);
    log(req, 'prod.task.approve', { id: Number(req.params.id), note: req.body?.note });
    return r;
  }));
  app.post('/tasks/:id/reject', need('prod.approve'), async (req, reply) => run(reply, () => {
    const r = rejectTaskApproval(db, Number(req.params.id), req.actor, req.body?.note);
    log(req, 'prod.task.reject', { id: Number(req.params.id), note: req.body?.note });
    return r;
  }));

  app.get('/approvals', need('prod.approve'), async () => approvals(db));
}
