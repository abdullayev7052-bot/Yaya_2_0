// Production API (Yaya 2.0), under /api/erp/prod. Work happens at stages: a stage's
// keepers run it (see erp/stages.js). The technologist's production stage has a
// shift (milk reconciled at its end). Managers see everything (prod.view), approve
// over-limit tasks and shifts (prod.approve) and set stages, maps and recipes
// (prod.manage). Sums are stripped for anyone without stock.costs.
import { audit } from '../db/index.js';
import { makeGuard } from '../auth.js';
import { StockError } from '../erp/stock.js';
import {
  approvals, approveShift, approveTask, cancelTask, closeShift, completeTask, createTask, keepTask, listRecipes, listShifts, myShift, openShift,
  recipeDetail, rejectShiftApproval, rejectTaskApproval, saveRecipe, shiftDetail, stageJournal, taskDetail,
} from '../erp/production.js';
import { getStage, isKeeper, keptWarehouses, productMap, saveStage, setProductMap, stageBoard, stageList } from '../erp/stages.js';
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
  const manager = (req) => has(req, 'prod.manage') || has(req, 'stock.manage');
  // A stage is run by its keepers (and managers).
  const runs = (req, stageId) => manager(req) || isKeeper(db, req.me.id, Number(stageId));
  const myStages = (req) => keptWarehouses(db, req.me.id).filter((id) => getStage(db, id));
  const taskOf = (id) => db.prepare('SELECT * FROM prod_tasks WHERE id = ?').get(Number(id));

  // ---------------------------------------------------------------- stages and maps
  app.get('/stages', need(), async (req) => stageList(db, { all: req.query.all === '1' && manager(req) }));
  app.post('/stages', need('prod.manage'), async (req, reply) => run(reply, () => {
    const id = saveStage(db, null, req.body ?? {});
    log(req, 'stage.create', { id, name: req.body?.name });
    return stageList(db, { all: true }).find((s) => s.id === id);
  }));
  app.put('/stages/:id', need('prod.manage'), async (req, reply) => run(reply, () => {
    const id = saveStage(db, Number(req.params.id), req.body ?? {});
    log(req, 'stage.update', { id, name: req.body?.name });
    return stageList(db, { all: true }).find((s) => s.id === id);
  }));
  // My stages with what is in them and what is waiting (managers: all with ?all=1).
  app.get('/board', need(), async (req) => ({
    stages: stageBoard(db, req.me.id, { all: req.query.all === '1' && viewAll(req) }),
    shift: (() => { const s = myShift(db, req.me.id); return s ? shiftDetail(db, s.id) : null; })(),
    // My unfinished tasks (started, waiting for a manager, or sent back).
    tasks: db.prepare("SELECT id FROM prod_tasks WHERE user_id = ? AND status IN ('open','approval') ORDER BY id DESC").all(req.me.id).map((t) => taskDetail(db, t.id)),
  }));
  app.get('/map/:productId', need(), async (req) => productMap(db, Number(req.params.productId)));
  app.put('/map/:productId', need('prod.manage'), async (req, reply) => run(reply, () => {
    const map = setProductMap(db, Number(req.params.productId), req.body?.stageIds);
    log(req, 'product.map', { productId: Number(req.params.productId), stages: map.map((s) => s.name) });
    return map;
  }));
  app.get('/journal', need(), async (req, reply) => {
    const stageId = Number(req.query.stageId) || null;
    if (!viewAll(req) && !(stageId && runs(req, stageId))) return stageJournal(db, { userId: req.me.id, from: req.query.from || null, to: req.query.to || null });
    return stageJournal(db, { stageId, userId: Number(req.query.userId) || null, from: req.query.from || null, to: req.query.to || null });
  });

  // ---------------------------------------------------------------- recipes
  app.get('/recipes', need(), async (req, reply) => {
    if (viewAll(req) && req.query.mine !== '1') return listRecipes(db, { all: req.query.all === '1' && has(req, 'prod.manage') });
    return listRecipes(db, { stageIds: myStages(req) });
  });
  app.get('/recipes/:id', need(), async (req, reply) => recipeDetail(db, Number(req.params.id)) ?? reply.code(404).send({ error: 'Topilmadi' }));
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

  // ---------------------------------------------------------------- the technologist's shift
  app.get('/shift', need(), async (req) => {
    const s = myShift(db, req.me.id);
    return { shift: s ? shiftDetail(db, s.id) : null };
  });
  app.post('/shift', need(), async (req, reply) => run(reply, () => {
    const s = openShift(db, { uuid: req.body?.uuid, userId: req.me.id });
    log(req, 'prod.shift.open', { id: s.id, number: s.number });
    return { shift: shiftDetail(db, s.id) };
  }));
  app.post('/shifts/:id/close', need(), async (req, reply) => {
    const s = db.prepare('SELECT * FROM prod_shifts WHERE id = ?').get(Number(req.params.id));
    if (!s) return reply.code(404).send({ error: 'Topilmadi' });
    if (s.user_id !== req.me.id) return deny(reply);
    return run(reply, () => {
      const r = closeShift(db, s.id, req.body ?? {}, { actor: req.actor });
      log(req, r.needApproval ? 'prod.shift.approval' : 'prod.shift.close', { id: s.id, number: s.number });
      return r;
    });
  });

  // ---------------------------------------------------------------- shifts (managers)
  app.get('/shifts', need(), async (req) => {
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
  // A 'change' stage: start from its recipe, then complete with the real quantities.
  app.post('/tasks', need(), async (req, reply) => {
    const r = db.prepare('SELECT stage_id FROM recipes WHERE id = ?').get(Number(req.body?.recipeId));
    const stageId = Number(req.body?.stageId) || r?.stage_id;
    if (!stageId) return bad(reply, 'Bosqichni tanlang');
    if (!runs(req, stageId)) return reply.code(403).send({ error: 'Siz bu bosqichga mas\'ul emassiz' });
    return run(reply, () => {
      const t = createTask(db, { ...req.body, stageId }, { actor: req.actor, userId: req.me.id });
      log(req, 'prod.task.create', { id: t.id, number: t.number, stageId });
      return taskDetail(db, t.id);
    });
  });
  // A 'keep' stage: one step (move qty on from the previous stage).
  app.post('/moves', need(), async (req, reply) => {
    const stageId = Number(req.body?.stageId);
    if (!runs(req, stageId)) return reply.code(403).send({ error: 'Siz bu bosqichga mas\'ul emassiz' });
    return run(reply, () => {
      const r = keepTask(db, req.body ?? {}, { actor: req.actor, userId: req.me.id });
      log(req, 'prod.move', { id: r.task.id, stageId, productId: req.body?.productId, qty: req.body?.qty });
      return r;
    });
  });
  app.get('/tasks/:id', need(), async (req, reply) => {
    const t = taskDetail(db, Number(req.params.id));
    if (!t) return reply.code(404).send({ error: 'Topilmadi' });
    if (t.user_id !== req.me.id && !viewAll(req) && !(t.stage_id && runs(req, t.stage_id))) return deny(reply);
    return t;
  });
  app.post('/tasks/:id/complete', need(), async (req, reply) => {
    const t = taskOf(req.params.id);
    if (!t) return reply.code(404).send({ error: 'Topilmadi' });
    if (t.user_id !== req.me.id && !manager(req)) return deny(reply);
    return run(reply, () => {
      const r = completeTask(db, t.id, req.body ?? {}, { actor: req.actor });
      log(req, r.needApproval ? 'prod.task.approval' : 'prod.task.done', { id: t.id });
      return r;
    });
  });
  app.post('/tasks/:id/cancel', need(), async (req, reply) => {
    const t = taskOf(req.params.id);
    if (!t) return reply.code(404).send({ error: 'Topilmadi' });
    if (t.user_id !== req.me.id && !has(req, 'prod.approve')) return deny(reply);
    return run(reply, () => {
      const r = cancelTask(db, t.id, req.actor, req.body?.reason);
      log(req, 'prod.task.cancel', { id: t.id, reason: req.body?.reason });
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
