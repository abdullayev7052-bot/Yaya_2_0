// Production API (Yaya 2.0), under /api/erp/prod. Work happens at stages: a stage's
// keepers run it (see erp/stages.js). The technologist's production stage has a
// shift (milk reconciled at its end). Managers see everything (prod.view), approve
// over-limit tasks and shifts (prod.approve) and set stages, maps and recipes
// (prod.manage). Sums are stripped for anyone without stock.costs.
import bcrypt from 'bcryptjs';
import { audit } from '../db/index.js';
import { saveSafety } from '../backup.js';
import { makeGuard } from '../auth.js';
import { StockError } from '../erp/stock.js';
import {
  approvals, approveShift, approveTask, cancelTask, closeShift, completeTask, createTask, deleteActiveWork, keepTask, listRecipes, listShifts, milkShifts, myShift, openShift,
  recipeDetail, rejectShiftApproval, rejectTaskApproval, saveRecipe, separateShift, setShiftMilk, shiftDetail, stageJournal, taskDetail,
} from '../erp/production.js';
import { getStage, isKeeper, keptWarehouses, productMap, saveStage, setProductMap, stageBoard, stageList, texRecipes } from '../erp/stages.js';
import { stripCosts } from './erp.js';
import { deletePlan, listPlans, planOf, planReport, planView, savePlan, today } from '../erp/plans.js';

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

  // ---------------------------------------------------------------- delete the current work of a stage
  // Admin only, re-confirmed with the admin's own password; a safety copy is kept 3 days.
  app.post('/delete-active', need('staff.manage'), async (req, reply) => {
    const b = req.body ?? {};
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.me.id);
    if (!row || !bcrypt.compareSync(String(b.password ?? ''), row.password_hash)) return bad(reply, "Admin paroli noto'g'ri");
    const userId = Number(b.userId) || null;
    const safety = saveSafety(db, "Amaldagi ishlab chiqarishni o'chirishdan oldin", req.actor);
    return run(reply, () => {
      const deleted = deleteActiveWork(db, req.actor, { stage: String(b.stage ?? ''), userId });
      log(req, 'prod.delete_active', { stage: b.stage, userId, deleted, safety });
      return { ok: true, deleted, safety };
    });
  });

  // ---------------------------------------------------------------- "Qo'shimcha xarajatlar": piece-wage types
  // Kept once (Quyish, Qopqoq yopish...) with the rate per unit; recipes pick them.
  app.get('/wage-types', need(), async (req) => db.prepare(`SELECT w.*, (SELECT COUNT(DISTINCT recipe_id) FROM recipe_rates WHERE wage_type_id = w.id) AS recipes
    FROM wage_types w ${req.query.all === '1' ? '' : 'WHERE w.active = 1'} ORDER BY w.active DESC, w.sort, w.name`).all());
  const wageBody = (b, reply) => {
    const name = String(b?.name ?? '').trim().slice(0, 60);
    const amount = Number(b?.amount);
    if (!name) { bad(reply, 'Nomi shart'); return null; }
    if (!(amount >= 0)) { bad(reply, "1 birlik uchun summa noto'g'ri"); return null; }
    return { name, amount };
  };
  app.post('/wage-types', need('prod.manage'), async (req, reply) => {
    const d = wageBody(req.body, reply); if (!d) return reply;
    if (db.prepare('SELECT 1 FROM wage_types WHERE lower(name) = lower(?)').get(d.name)) return bad(reply, 'Bunday nomli tur bor');
    const id = Number(db.prepare('INSERT INTO wage_types (name, amount) VALUES (?, ?)').run(d.name, d.amount).lastInsertRowid);
    log(req, 'wage_type.create', { id, ...d });
    return { id };
  });
  app.patch('/wage-types/:id', need('prod.manage'), async (req, reply) => {
    const w = db.prepare('SELECT * FROM wage_types WHERE id = ?').get(Number(req.params.id));
    if (!w) return reply.code(404).send({ error: 'Topilmadi' });
    const d = wageBody({ name: req.body?.name ?? w.name, amount: req.body?.amount ?? w.amount }, reply); if (!d) return reply;
    if (db.prepare('SELECT 1 FROM wage_types WHERE lower(name) = lower(?) AND id <> ?').get(d.name, w.id)) return bad(reply, 'Bunday nomli tur bor');
    db.prepare('UPDATE wage_types SET name = ?, amount = ?, active = COALESCE(?, active) WHERE id = ?')
      .run(d.name, d.amount, req.body?.active == null ? null : Number(!!req.body.active), w.id);
    log(req, 'wage_type.update', { id: w.id, ...d });
    return { ok: true };
  });

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
    // Today's plan: as quyma for the technologist, per product for the pourer.
    plan: planView(db),
    // My unfinished tasks (started, waiting for a manager, or sent back).
    tasks: db.prepare("SELECT id FROM prod_tasks WHERE user_id = ? AND status IN ('open','approval') ORDER BY id DESC").all(req.me.id).map((t) => taskDetail(db, t.id)),
  }));
  app.get('/map/:productId', need(), async (req) => productMap(db, Number(req.params.productId)));
  // The Tex karta editor: every stage, whether it is on, its recipe and the recipes it may use.
  app.get('/tex/:productId', need(), async (req, reply) => {
    const p = db.prepare('SELECT id, name, kind FROM products WHERE id = ?').get(Number(req.params.productId));
    if (!p) return reply.code(404).send({ error: 'Topilmadi' });
    const on = new Map(productMap(db, p.id).map((s) => [s.id, s]));
    return { product: p, stages: db.prepare('SELECT * FROM warehouses WHERE is_stage = 1 AND active = 1 ORDER BY sort, id').all().map((w) => ({
      id: w.id, name: w.name, code: w.stage_code, type: w.stage_type, on: on.has(w.id), recipe_id: on.get(w.id)?.recipe_id ?? null,
      recipes: w.stage_type === 'change' ? texRecipes(db, p.id, w) : [] })) };
  });
  app.put('/map/:productId', need('prod.manage'), async (req, reply) => run(reply, () => {
    const map = setProductMap(db, Number(req.params.productId), req.body?.stages ?? req.body?.stageIds);
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
  // "Qabul qilingan sut": the accepted collector shifts this shift used (each once).
  app.get('/milk-shifts', need(), async (req) => {
    const s = myShift(db, req.me.id);
    return milkShifts(db, s);
  });
  app.put('/shifts/:id/milk', need(), async (req, reply) => run(reply, () => {
    const d = setShiftMilk(db, Number(req.params.id), req.body?.shiftIds, req.me.id);
    log(req, 'prod.shift.milk', { id: d.id, shifts: req.body?.shiftIds });
    return { shift: d };
  }));
  // Separation, before closing: skim milk made = skim milk used; the cream is entered.
  app.post('/shifts/:id/separation', need(), async (req, reply) => run(reply, () => {
    const d = separateShift(db, Number(req.params.id), req.body ?? {}, { actor: req.actor, userId: req.me.id });
    log(req, 'prod.shift.separation', { id: d.id });
    return { shift: d };
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

  // ---------------------------------------------------------------- Reja (plan)
  const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v ?? '');
  app.get('/plans', need(), async (req) => listPlans(db, { from: isDay(req.query.from) ? req.query.from : null, to: isDay(req.query.to) ? req.query.to : null }));
  app.get('/plans/view', need(), async (req) => planView(db, isDay(req.query.day) ? req.query.day : today()));
  app.get('/plans/report', need(), async (req, reply) => {
    if (!viewAll(req)) return deny(reply);
    const to = isDay(req.query.to) ? req.query.to : today();
    const from = isDay(req.query.from) ? req.query.from : `${to.slice(0, 7)}-01`;
    return planReport(db, { from, to });
  });
  app.get('/plans/:day', need(), async (req, reply) => planOf(db, req.params.day) ?? reply.code(404).send({ error: 'Topilmadi' }));
  app.put('/plans/:day', need('prod.manage'), async (req, reply) => run(reply, () => {
    const p = savePlan(db, req.params.day, req.body?.lines, req.actor, { suggest: req.body?.suggest });
    log(req, 'plan.save', { day: req.params.day, lines: p.lines.length });
    return p;
  }));
  app.delete('/plans/:day', need('prod.manage'), async (req, reply) => run(reply, () => {
    deletePlan(db, req.params.day);
    log(req, 'plan.delete', { day: req.params.day });
    return { ok: true };
  }));
}
