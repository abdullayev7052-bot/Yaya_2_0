'use strict';

// "Ishlab chiqarish" section of the panel: stages (bosqichlar) and each product's
// production map, the stage journal, technologist shifts and tasks, approvals of
// over-limit work, recipes (tarkiblar) with alternatives and separation rules, and
// the loss reasons of each section with their limits.
// Talks to /api/erp/prod and /api/erp. Loaded after app.js and stock.js.

const prodApi = (method, path, body) => api(method, path, body, '/api/erp/prod');
const PSHIFT = { open: ['Ochiq', 'pending'], approval: ['Tasdiq kutmoqda', 'pending'], closed: ['Yopilgan', 'sent'] };
const PTASK = { open: ['Jarayonda', 'pending'], approval: ['Tasdiq kutmoqda', 'pending'], done: ['Bajarildi', 'sent'], cancelled: ['Bekor qilingan', 'error'] };
const badge = (map, s) => `<span class="badge ${map[s]?.[1] ?? ''}">${map[s]?.[0] ?? esc(s)}</span>`;
const MODE = { fixed: 'Qat\'iy 1 kg tannarxi', percent: 'Umumiy tannarxdan foiz', rest: 'Qolgan tannarx' };
const provisionalMark = (x) => (x.provisional ? ' <span class="muted" title="Smena yopilgach aniq bo\'ladi">(taxminiy)</span>' : '');
const money2 = (n) => (n == null ? '—' : fmtNum(n, 2));

function taskTable(tasks, { actions = false } = {}) {
  if (!tasks.length) return '<p class="muted">Topshiriq yo\'q</p>';
  return `<div class="table-wrap"><table><thead><tr><th>Topshiriq</th><th>Tarkib</th><th>Holati</th><th>Ishlatildi</th><th>Chiqdi</th>${costs() ? '<th class="num">Tannarx</th>' : ''}${actions ? '<th></th>' : ''}</tr></thead><tbody>
    ${tasks.map((t) => {
      const used = t.result?.lines ?? t.plan.map((l) => ({ productId: l.productId, qty: l.qty }));
      const names = Object.fromEntries(t.plan.map((l) => [l.productId, `${l.product} (${l.unit})`]));
      return `<tr><td><b>${esc(t.label)}</b><div class="muted">${fmtDate(t.done_at || t.created_at)}${t.user_name ? ` · ${esc(t.user_name)}` : ''}</div></td>
        <td>${esc(t.recipe ?? '')}<div class="muted">×${fmtNum(t.factor, 3)}</div></td>
        <td>${badge(PTASK, t.status)}${t.approval_note ? `<div class="muted">${esc(t.approval_note)}</div>` : ''}${t.cancel_reason ? `<div class="err">${esc(t.cancel_reason)}</div>` : ''}
          ${t.result?.range ? `<div class="muted">Ruxsat: ${fmtNum(t.result.range.min, 3)}–${fmtNum(t.result.range.max, 3)} kg · chiqdi ${fmtNum(t.result.outWeight, 3)} kg</div>` : ''}</td>
        <td>${used.map((l) => `${esc(names[l.productId] ?? `#${l.productId}`)}: ${fmtNum(l.qty, 3)}`).join('<br>')}</td>
        <td>${t.workers?.length > 1 || t.wages?.length ? `<div class="muted">${(t.wages?.length ? t.wages : t.workers).map((w) => `${esc(w.name)}${costs() && w.amount != null ? `: ${fmtMoney(w.amount)}` : ''}`).join(', ')}</div>` : ''}
          ${t.send_to ? `<div class="muted">→ ${esc(t.send_to)}</div>` : ''}
          ${t.result?.shortfall?.length ? `<div class="warn">Idish chiqmadi: ${t.result.shortfall.map((x) => `${esc(x.reason)} ${fmtNum(x.qty, 3)}`).join(', ')}</div>` : ''}
          ${t.outputs.length ? t.outputs.map((o) => `${esc(o.product)}: <b>${fmtNum(o.qty, 3)} ${esc(o.unit)}</b>`).join('<br>') : (t.result?.outputs ?? []).map((o) => `${esc(o.product ?? '')}: <b>${fmtNum(o.qty, 3)} ${esc(o.unit ?? '')}</b>`).join('<br>')}</td>
        ${costs() ? `<td class="num">${t.outputs.map((o) => `${money2(o.unit_cost)} / birlik${provisionalMark(o)}<br><b>${fmtMoney(o.cost)}</b>`).join('<br>')}</td>` : ''}
        ${actions ? `<td>${t.status === 'approval' && can('prod.approve') ? `<button class="small" data-tapprove="${t.id}">Tasdiqlash</button> <button class="ghost small" data-treject="${t.id}">Rad etish</button>` : ''}</td>` : ''}</tr>`;
    }).join('')}</tbody></table></div>`;
}

function bindApprovals(v) {
  $$('[data-tapprove]', v).forEach((b) => { b.onclick = () => openForm({ title: 'Topshiriqni tasdiqlash', submit: 'Tasdiqlash',
    intro: '<p class="muted">Limitdan chiqqan og\'irlik qabul qilinadi va topshiriq o\'tkaziladi.</p>',
    fields: [{ name: 'note', label: 'Izoh (ixtiyoriy)' }], onSubmit: (d) => prodApi('POST', `/tasks/${b.dataset.tapprove}/approve`, d) }); });
  $$('[data-treject]', v).forEach((b) => { b.onclick = () => openForm({ title: 'Rad etish', submit: 'Rad etish', danger: true,
    intro: '<p class="muted">Topshiriq texnologga qaytadi: qayta tortib kiritadi yoki bekor qiladi.</p>',
    fields: [{ name: 'note', label: 'Sabab', required: true }], onSubmit: (d) => prodApi('POST', `/tasks/${b.dataset.treject}/reject`, d) }); });
  $$('[data-sapprove]', v).forEach((b) => { b.onclick = () => openForm({ title: 'Smena yakunini tasdiqlash', submit: 'Tasdiqlash',
    intro: '<p class="muted">Yo\'qotish limitdan oshgan. Tasdiqlansa smena yopiladi va yo\'qotish tannarxga / xarajatga yoziladi.</p>',
    fields: [{ name: 'note', label: 'Izoh (ixtiyoriy)' }], onSubmit: (d) => prodApi('POST', `/shifts/${b.dataset.sapprove}/approve`, d) }); });
  $$('[data-sreject]', v).forEach((b) => { b.onclick = () => openForm({ title: 'Rad etish', submit: 'Rad etish', danger: true,
    intro: '<p class="muted">Smena texnologga qaytadi: yo\'qotishlarni qayta kiritadi.</p>',
    fields: [{ name: 'note', label: 'Sabab', required: true }], onSubmit: (d) => prodApi('POST', `/shifts/${b.dataset.sreject}/reject`, d) }); });
}

function closeBlock(s) {
  const c = s.close_data;
  if (!c) return '';
  const row = (k, val, cls = '') => `<tr><td>${k}</td><td class="num ${cls}">${val}</td></tr>`;
  return `<div class="card"><h2>Smena yakuni — sut hisobi</h2>
    <table><tbody>
      ${c.received != null ? row(`Qabul qilingan sut <span class="muted">(${(c.milk_shifts ?? []).length} ta yig'uvchi smenasi)</span>`, `${fmtNum(c.received, 3)} kg`) : ''}
      ${c.milk_direct != null ? row("Sarflandi: yog'li sut", `${fmtNum(c.milk_direct, 3)} kg`) : ''}
      ${c.skim_used != null ? row("Sarflandi: yog'siz sut", `${fmtNum(c.skim_used, 3)} kg`) : ''}
      ${c.cream != null ? row('Toza qaymoq (separatsiya)', `${fmtNum(c.cream, 3)} kg`) : ''}
      ${c.total != null ? row('<b>Jami</b>', `<b>${fmtNum(c.total, 3)} kg</b>`) : ''}
      ${(c.losses ?? []).map((l) => row(esc(l.reason), `−${fmtNum(l.qty, 3)} kg`, 'err')).join('')}
    </tbody></table>
    ${(c.over ?? []).length ? `<p class="warn">Limitdan oshgan: ${c.over.map((o) => `${esc(o.reason)} ${fmtNum(o.qty, 3)} (ruxsat ${typeof o.allowed === 'number' ? fmtNum(o.allowed, 3) : esc(o.allowed)})`).join(', ')}</p>` : ''}
    ${costs() && c.unit_cost != null ? `<p>Sutning haqiqiy 1 kg tannarxi (tanlangan smenalar bo'yicha): <b>${money2(c.unit_cost)}</b>${c.spread_cost ? ` · yo'qotishdan mahsulotlarga qo'shildi: <b style="color:var(--err)">${fmtMoney(c.spread_cost)}</b> so'm (asosiy xomashyo qiymati ulushiga ko'ra)` : ''}</p>` : ''}
    ${s.approval_note ? `<p class="muted">Rahbar izohi: ${esc(s.approval_note)}</p>` : ''}</div>`;
}

// "Smenalar": the work of each stage. Texnolog — the technologist's shifts; Quyish,
// Qopqoq yopish, Qayta ishlash (Yaroqli / Yaroqsiz) — the tasks done there.
// Filtered by dates and by the worker.
const SHIFT_STAGES = [['produce', 'Texnolog'], ['pour', 'Quyish'], ['cap', 'Qopqoq yopish'], ['reprocess', 'Qayta ishlash']];
views.prod = async (v) => {
  const q = hashParams();
  const f = { stage: q.get('stage') || 'produce', sub: q.get('sub') || 'reprocess_ok', status: q.get('status') || '', userId: q.get('userId') || '',
    from: q.get('from') || addDays(todayLocal(), -6), to: q.get('to') || todayLocal() };
  const code = f.stage === 'reprocess' ? f.sub : f.stage;
  const [stages, staff] = await Promise.all([prodApi('GET', '/stages'), api('GET', '/staff/names').catch(() => [])]);
  const st = stages.find((x) => x.code === code);
  const tech = f.stage === 'produce';
  const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, x]) => x));
  const list = tech
    ? await prodApi('GET', `/shifts?${qs({ status: f.status, userId: f.userId, from: f.from, to: f.to })}`)
    : st ? await prodApi('GET', `/journal?${qs({ stageId: st.id, userId: f.userId, from: f.from, to: f.to })}`) : [];
  const go = (patch) => setHash('prod', { ...f, ...patch });
  v.innerHTML = `<div class="card">
      <div class="presets">${SHIFT_STAGES.map(([k, t]) => `<button class="ghost small ${k === f.stage ? 'on' : ''}" data-stage="${k}">${t}</button>`).join('')}</div>
      ${f.stage === 'reprocess' ? `<div class="presets" style="margin-top:8px">${[['reprocess_ok', 'Yaroqli'], ['reprocess_bad', 'Yaroqsiz']]
        .map(([k, t]) => `<button class="ghost small ${k === f.sub ? 'on' : ''}" data-sub="${k}">${t}</button>`).join('')}</div>` : ''}
      ${tech ? `<div class="presets" style="margin-top:8px">${[['', 'Hammasi'], ['open', 'Ochiq'], ['approval', 'Tasdiq kutmoqda'], ['closed', 'Yopilgan']]
        .map(([k, t]) => `<button class="ghost small ${k === f.status ? 'on' : ''}" data-st="${k}">${t}</button>`).join('')}</div>` : ''}
      <div class="row" style="margin-top:8px"><label>Dan <input type="date" id="from" value="${f.from}"></label><label>Gacha <input type="date" id="to" value="${f.to}"></label>
        <label>Xodim <select id="emp"><option value="">Hammasi</option>${staff.map((u) => `<option value="${u.id}" ${String(u.id) === f.userId ? 'selected' : ''}>${esc(u.name || u.login)}</option>`).join('')}</select></label></div></div>
    ${tech ? `<div class="card table-wrap"><table><thead><tr><th>Smena</th><th>Texnolog</th><th>Holati</th><th>Ochildi</th><th>Yopildi</th><th class="num">Topshiriq</th><th class="num">Sut ishlatildi, kg</th></tr></thead><tbody>
      ${list.map((s) => `<tr><td><a href="#prod-shift?id=${s.id}">${esc(s.label)}</a></td><td>${esc(s.user_name)}</td><td>${badge(PSHIFT, s.status)}</td>
        <td>${fmtDate(s.opened_at)}</td><td>${fmtDate(s.closed_at)}</td><td class="num">${s.tasks.n}</td><td class="num">${fmtNum(s.tasks.milk, 3)}</td></tr>`).join('')
        || '<tr><td colspan="7" class="muted">Smena yo\'q. Texnolog ilovada "Ishlab chiqarish" bo\'limidan smena ochadi.</td></tr>'}
      </tbody></table></div>`
    : `<div class="card table-wrap">${st ? '' : `<p class="warn">"${esc(code)}" bosqichi topilmadi (Bosqichlar va xarita).</p>`}
      <p class="muted" style="margin-top:0">${st ? `${esc(st.name)}: bu bosqichda smena ochilmaydi — har bir bajarilgan ish (topshiriq) shu yerda, kim bajargani bilan.` : ''}
        ${list.length ? ` Jami: <b>${list.length}</b> ta topshiriq, chiqdi <b>${fmtNum(list.filter((t) => t.status === 'done').reduce((a, t) => a + (t.outputs?.[0]?.qty ?? 0), 0), 3)}</b>.` : ''}</p>
      <table><thead><tr><th>Vaqt</th><th>Topshiriq</th><th>Kim bajardi</th><th>Nima</th><th>Qatnashganlar</th><th>Holati</th></tr></thead><tbody>
      ${list.map((t) => `<tr><td>${fmtDate(t.done_at || t.created_at)}</td><td>${esc(t.label ?? '')}</td><td>${esc(t.user_name ?? '')}</td>
        <td>${esc(t.recipe ?? '')} ${(t.outputs.length ? t.outputs : (t.result?.outputs ?? [])).map((o) => `${esc(o.product ?? '')}: <b>${fmtNum(o.qty, 3)} ${esc(o.unit ?? '')}</b>`).join(', ')}</td>
        <td class="muted">${(t.wages?.length ? t.wages : t.workers).map((w) => `${esc(w.name)}${costs() && w.amount != null ? ` (${fmtMoney(w.amount)})` : ''}`).join(', ')}</td>
        <td>${badge(PTASK, t.status)}${t.cancel_reason ? `<div class="err">${esc(t.cancel_reason)}</div>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Bu davrda ish yo\'q</td></tr>'}
      </tbody></table></div>`}
    ${can('staff.manage') ? `<div class="card"><h3>🗑 Amaldagi ishni o'chirish</h3>
      <p class="muted"><b>Texnolog</b> — yopilmagan (ochiq yoki tasdiq kutayotgan) smenalar: topshiriqlari bekor qilinadi (xomashyo omborga qaytadi),
        tanlangan yig'uvchi smenalari bo'shaydi, smena o'chadi. <b>Quyish, Qopqoq yopish, Qayta ishlash</b> va boshqa bosqichlar — tugallanmagan va bugungi topshiriqlar bekor qilinadi.
        Mahsulot keyingi bosqichga o'tib bo'lgan bo'lsa, hech narsa o'chmaydi — avval keyingi bosqichdagini o'chiring. Tiklash nusxasi 3 kun saqlanadi.</p>
      <form id="delWork" class="row">
        <label>Bosqich <select name="stage" data-plain>${[['produce', 'Texnolog (Ishlab chiqarish)'], ['pour', 'Quyuvchi (Quyish)'], ['cap', 'Qopqoq yopuvchi (Qopqoq yopish)'], ['pack', 'Qadoqlash'],
          ['reprocess_ok', 'Qayta ishlash — Yaroqli'], ['reprocess_bad', 'Qayta ishlash — Yaroqsiz']].map(([k, t]) => `<option value="${k}" ${k === code ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label>Xodim <select name="userId"><option value="">Hammasi</option>${staff.map((u) => `<option value="${u.id}" ${String(u.id) === f.userId ? 'selected' : ''}>${esc(u.name || u.login)}</option>`).join('')}</select></label>
        <label>Admin paroli <input name="password" type="password" required autocomplete="current-password"></label>
        <button class="danger">O'chirish</button></form></div>` : ''}`;
  $('#delWork', v) && ($('#delWork', v).onsubmit = async (e) => {
    e.preventDefault();
    const fm = e.target;
    if (!confirm(`"${fm.stage.selectedOptions[0].text}" — amaldagi ish o'chirilsinmi?`)) return;
    try {
      const r = await prodApi('POST', '/delete-active', { stage: fm.stage.value, userId: fm.userId.value || null, password: fm.password.value });
      flash(r.deleted.length ? `O'chirildi: ${r.deleted.join(', ')}. Tiklash nusxasi #${r.safety}.` : "O'chiriladigan ish yo'q");
      route();
    } catch (err) { flash(err.message, 'err'); }
  });
  $$('[data-stage]', v).forEach((b) => { b.onclick = () => go({ stage: b.dataset.stage, status: '' }); });
  $$('[data-sub]', v).forEach((b) => { b.onclick = () => go({ sub: b.dataset.sub }); });
  $$('[data-st]', v).forEach((b) => { b.onclick = () => go({ status: b.dataset.st }); });
  $('#from', v).onchange = (e) => go({ from: e.target.value });
  $('#to', v).onchange = (e) => go({ to: e.target.value });
  $('#emp', v).onchange = (e) => go({ userId: e.target.value });
};

views['prod-shift'] = async (v) => {
  const s = await prodApi('GET', `/shifts/${hashParams().get('id')}`);
  v.innerHTML = `<p><a href="#prod">← Smenalar</a></p>
    <div class="card"><div class="row" style="justify-content:space-between;align-items:center">
      <h2 style="margin:0">${esc(s.label)} · ${esc(s.user_name)} ${badge(PSHIFT, s.status)}</h2>
      <div>${s.status === 'approval' && can('prod.approve') ? `<button data-sapprove="${s.id}">Tasdiqlash</button> <button class="ghost" data-sreject="${s.id}">Rad etish</button>` : ''}</div></div>
      <p class="muted" style="margin:8px 0 0">Ochildi ${fmtDate(s.opened_at)}${s.closed_at ? ` · yopildi ${fmtDate(s.closed_at)}` : ''}</p>
      ${s.status !== 'closed' ? `<p>"${esc(s.milk.warehouse)}"da hisobda: <b>${fmtNum(s.milk.book, 3)} kg</b> ${esc(s.milk.product)} · topshiriqlarda ishlatildi <b>${fmtNum(s.milk.used, 3)} kg</b>.
        ${(s.separation?.outputs ?? []).filter((o) => o.book < 0).map((o) => `<br><span class="warn">${esc(o.product)}: ${fmtNum(o.book, 3)} — separatsiya smena oxirida kiritiladi</span>`).join('')}
        <span class="muted">Smena yopilmaguncha tannarxlar taxminiy.</span></p>` : ''}</div>
    ${closeBlock(s)}
    <div class="card"><h2>Topshiriqlar</h2>${taskTable(s.tasks, { actions: true })}</div>`;
  bindApprovals(v);
};

views['prod-approvals'] = async (v) => {
  const a = await prodApi('GET', '/approvals');
  v.innerHTML = `<div class="card"><h2>Limitdan chiqqan topshiriqlar</h2>${a.tasks.length ? taskTable(a.tasks, { actions: true }) : '<p class="muted">Yo\'q</p>'}</div>
    <div class="card"><h2>Yo'qotishi limitdan oshgan smenalar</h2>
    ${a.shifts.map((s) => `<div style="border-bottom:1px solid var(--line);padding:8px 0"><div class="row" style="justify-content:space-between;align-items:center">
      <b><a href="#prod-shift?id=${s.id}">${esc(s.label)}</a> · ${esc(s.user_name)}</b>
      <div><button class="small" data-sapprove="${s.id}">Tasdiqlash</button> <button class="ghost small" data-sreject="${s.id}">Rad etish</button></div></div>
      ${(s.close_data?.over ?? []).map((o) => `<div class="warn">${esc(o.reason)}: ${fmtNum(o.qty, 3)} — ruxsat ${typeof o.allowed === 'number' ? fmtNum(o.allowed, 3) : esc(o.allowed)}</div>`).join('')}
      <div class="muted">Ishlatilgan sut ${fmtNum(s.close_data?.milk?.used, 3)} kg · o'lchab qolgan ${fmtNum(s.close_data?.counted, 3)} kg${s.close_data?.sepMilk ? ` · separatsiya ${fmtNum(s.close_data.sepMilk, 3)} kg` : ''}</div></div>`).join('') || '<p class="muted">Yo\'q</p>'}</div>`;
  bindApprovals(v);
};

// ------------------------------------------------------------------ recipes
views['prod-recipes'] = async (v) => {
  const list = await prodApi('GET', `/recipes${can('prod.manage') ? '?all=1' : ''}`);
  v.innerHTML = `<div class="row" style="margin-bottom:12px;justify-content:space-between"><p class="muted" style="margin:0;flex:1">Tarkib — bitta asosiy partiya uchun nima va qancha ketadi. Texnolog mahsulotni tanlasa tarkib avtomatik keladi;
      partiya uchun miqdorni o'zgartirishi yoki alternativni tanlashi mumkin (asl tarkib o'zgarmaydi).</p>
      ${can('prod.manage') ? '<a class="btnlike" href="#prod-recipe">+ Tarkib</a>' : ''}</div>
    ${list.map((r) => `<div class="card ${r.active ? '' : 'muted'}"><div class="row" style="justify-content:space-between;align-items:center">
      <h2 style="margin:0">${esc(r.name)} <span class="muted" style="font-size:14px">${esc(r.kind_label)}${r.kind === 'separation' ? '' : ` → ${esc(r.product ?? '')}`}${r.active ? '' : ' · nofaol'}</span></h2>
      ${can('prod.manage') ? `<a href="#prod-recipe?id=${r.id}">Tahrirlash</a>` : ''}</div>
      <table style="margin-top:8px"><tbody>${r.lines.map((l) => `<tr><td>${esc(l.product)}</td><td class="num">${fmtNum(l.qty, 4)} ${esc(l.unit)}</td>
        <td class="muted">${l.alts.length ? `alternativ: ${l.alts.map((a) => esc(a.product)).join(', ')}` : ''}</td></tr>`).join('')}</tbody></table>
      <p class="muted" style="margin:8px 0 0">${r.stage ? `Bosqich: <b>${esc(r.stage)}</b> · ` : ''}${['pour', 'pack', 'cap'].includes(r.kind) ? '1 dona uchun' : `Jami ${fmtNum(r.base_weight, 4)} kg`}${r.rates.length ? ` · ishbay: ${r.rates.map((x) => `${esc(x.name)} ${fmtNum(x.amount)}`).join(', ')} so'm/birlik` : ''}${r.max_minutes ? ` · muddat ${fmtNum(r.max_minutes)} daqiqa` : ''}${r.out_min != null || r.out_max != null ? ` · chiqishi ${fmtNum(r.out_min, 3)}–${fmtNum(r.out_max, 3)} kg (partiyaga nisbatan o'zgaradi)` : ''}
        ${r.limits?.length ? `<br>Shartli limit: ${r.limits.map((x) => `${esc(x.name || x.products.join(' + '))} → ${fmtNum(x.out_min, 3)}–${fmtNum(x.out_max, 3)} kg`).join('; ')}` : ''}
        ${r.kind === 'reprocess' ? `<br>Chiqadi: ${r.outputs.map((o) => `${esc(o.product)} — ${o.per_unit != null ? fmtNum(o.per_unit, 4) : 'netto'}${o.min_per_unit != null || o.max_per_unit != null ? ` (${fmtNum(o.min_per_unit, 4)}–${fmtNum(o.max_per_unit, 4)})` : ''}, ${fmtMoney(o.cost_value)} so'm${o.is_container ? ', idish' : ''}`).join('; ')}` : ''}
        ${r.kind === 'separation' ? `<br>Chiqadi: ${r.outputs.map((o) => `${esc(o.product)} — ${MODE[o.cost_mode]}${o.cost_value != null ? ` ${fmtNum(o.cost_value)}${o.cost_mode === 'percent' ? '%' : ''}` : ''}`).join('; ')}` : ''}</p></div>`).join('')
      || '<p class="muted">Tarkib yo\'q.</p>'}`;
};

views['prod-recipe'] = async (v) => {
  const id = Number(hashParams().get('id')) || null;
  const [r, products, stages, wageTypes] = await Promise.all([id ? prodApi('GET', `/recipes/${id}`) : null, api('GET', '/products', null, '/api/erp'), prodApi('GET', '/stages'), prodApi('GET', '/wage-types')]);
  const changeStages = stages.filter((s) => s.type === 'change');
  const lines = (r?.lines ?? []).map((l) => ({ productId: l.product_id, qty: l.qty, alts: l.alts.map((a) => ({ productId: a.product_id, qty: a.qty ?? '' })) }));
  if (!lines.length) lines.push({ productId: '', qty: '', alts: [] });
  const outputs = (r?.outputs ?? []).map((o) => ({ productId: o.product_id, costMode: o.cost_mode, costValue: o.cost_value ?? '' }));
  const rates = (r?.rates ?? []).map((x) => ({ wageTypeId: x.wage_type_id ?? '', name: x.name, amount: x.amount }));
  // Conditional limits: when these products are used, the output must be min–max (for the base batch).
  const limits = (r?.limits ?? []).map((x) => ({ name: x.name ?? '', productIds: x.product_ids, outMin: x.out_min ?? '', outMax: x.out_max ?? '' }));
  // Reprocessing outputs: per input unit (blank = the input's netto weight), range, fixed cost, container.
  const rout = r?.kind === 'reprocess' ? r.outputs.map((o) => ({ productId: o.product_id, perUnit: o.per_unit ?? '', minPerUnit: o.min_per_unit ?? '', maxPerUnit: o.max_per_unit ?? '', costValue: o.cost_value ?? 0, isContainer: !!o.is_container })) : [];
  const popts = (sel, filter = () => true) => `<option value="">— mahsulot —</option>${products.filter(filter).map((p) => `<option value="${p.id}" ${String(p.id) === String(sel) ? 'selected' : ''}>${esc(p.name)} (${esc(p.unit)})</option>`).join('')}`;
  v.innerHTML = `<p><a href="#prod-recipes">← Tarkiblar</a></p>
    <form class="card" id="rf" style="display:grid;gap:12px">
      <h2>${r ? 'Tarkibni tahrirlash' : 'Yangi tarkib'}</h2>
      <div class="row"><label>Nomi<input name="name" required value="${esc(r?.name ?? '')}"></label>
        <label>Turi<select name="kind">${[['cook', 'Tayyorlash — quyma (kg)'], ['separation', 'Separatsiya'], ['pour', 'Quyish — idishga (1 dona uchun)'], ['pack', 'Qadoqlash (1 dona uchun)'], ['reprocess', "Qayta ishlash — muddati o'tgan (1 dona uchun)"]]
          .map(([k, t]) => `<option value="${k}" ${(r?.kind ?? 'cook') === k ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label>Bosqich<select name="stageId"><option value="">— turiga qarab —</option>${changeStages.map((s) => `<option value="${s.id}" ${r?.stage_id === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
        <label id="prodWrap"><span id="prodLabel">Chiqadigan mahsulot</span><select name="productId">${popts(r?.product_id, (p) => p.kind !== 'milk' && !p.has_variants).replace('— mahsulot —', '— umumiy (Tex kartada bog\'lanadi) —')}</select></label></div>
      <div class="card" style="margin:0" id="reprocWrap"><h2>1 dona qayta ishlanganda nima chiqadi</h2>
        <p class="muted">Masalan "Smetana 400 g": <b>idish</b> — 1 dona, tannarxi qat'iy 800 so'm, "idish" belgilanadi (kam chiqsa sababi so'raladi va xarajatga yoziladi);
          <b>Vozvrat qatiq</b> — miqdori bo'sh (mahsulotning netto vaznidan: 0,4 kg), chegara 0,37–0,45 kg, tannarxi 0.
          Qolgan tannarx "Qayta ishlashda yo'qotilgan tannarx" xarajatiga yoziladi.</p>
        <div class="table-wrap"><table><thead><tr><th>Mahsulot</th><th>1 donadan</th><th>Eng kami</th><th>Eng ko'pi</th><th>1 birlik tannarxi</th><th>Idish</th><th></th></tr></thead><tbody id="rout"></tbody></table></div>
        <button type="button" class="ghost small" id="addRout">+ Mahsulot</button></div>
      <div class="card" style="margin:0" id="linesCard"><h2 id="linesTitle">Nima ketadi (asosiy partiya)</h2><p class="muted" id="unitHint" hidden>Quyish va qopqoq yopishda tarkib <b>1 dona</b> uchun yoziladi: masalan 0,4 kg quyma + 1 idish + 1 etiketka. Qopqoqda birinchi qator — mahsulotning o'zi (1 dona) + 1 qopqoq.</p><div class="table-wrap"><table><thead><tr><th>Mahsulot</th><th>Miqdor</th><th>Alternativlar (bir bosishda almashtiriladi)</th><th></th></tr></thead><tbody id="lines"></tbody></table></div>
        <button type="button" class="ghost small" id="addLine">+ Qator</button></div>
      <div class="row" id="rangeRow"><label>Chiqishi eng kami, kg<input name="outMin" type="number" step="0.001" min="0" value="${r?.out_min ?? ''}"></label>
        <label>Chiqishi eng ko'pi, kg<input name="outMax" type="number" step="0.001" min="0" value="${r?.out_max ?? ''}"></label></div>
      <div class="card" style="margin:0" id="limWrap"><h2>Shartli limitlar</h2>
        <p class="muted">"Shu xomashyolar ishlatilsa, chiqishi X–Y bo'lsin" — asosiy partiya uchun yoziladi, partiyaga qarab o'zgaradi.
          Masalan B zakvaska ishlatilsa 315–330 kg. Bir nechtasi mos kelsa, eng ko'p xomashyo sanalgani olinadi; birortasi mos kelmasa — yuqoridagi umumiy chegara.</p>
        <div id="lims"></div><button type="button" class="ghost small" id="addLim">+ Shartli limit</button></div>
      <div class="card" style="margin:0" id="rateWrap"><h2>Ishbay haq (1 birlik uchun)</h2>
        <p class="muted">Masalan "Quyish" 170 so'm. Bir nechta xodim birga bajarsa, teng bo'linadi (2 kishi — 85 dan). Tannarxga qo'shiladi; topshiriq bekor qilinsa haq ham bekor bo'ladi.</p>
        <table><tbody id="rates"></tbody></table><button type="button" class="ghost small" id="addRate">+ Amal</button></div>
      <label style="display:flex;gap:8px;align-items:center;color:var(--text)"><input type="checkbox" name="suggest" ${r?.suggest === 0 ? '' : 'checked'}> Ishlab chiqarishda tavsiya ko'rsatilsin — xodim ekranida xira raqamlar (miqdorlar tarkibga ko'ra taklif qilinadi)</label>
      <label style="max-width:320px">Topshiriq muddati, daqiqa<input name="maxMinutes" type="number" step="1" min="0" value="${r?.max_minutes ?? ''}"></label>
      <p class="muted" style="margin:0">Topshiriq shu vaqtdan uzoq davom etsa, xodim ismi bilan ogohlantirish chiqadi. Bo'sh — muddat yo'q.</p>
      <p class="muted" style="margin:0" id="rangeHint">Masalan "5%": 320 kg sut + 6 kg qaymoq + 4,2 g zakvaska = 326,0042 kg; chiqishi 320–335 kg. Yarim partiyada tizim o'zi 160–167,5 kg deb biladi.
        Texnolog tortgan og'irlik shu oraliqdan chiqsa, topshiriq rahbar tasdig'iga ketadi.</p>
      <div class="card" style="margin:0" id="outWrap"><h2>Chiqadigan mahsulotlar va tannarx taqsimoti</h2>
        <p class="muted">Qat'iy — 1 kg uchun belgilangan tannarx (masalan qaymoq 42 000, undan oshmaydi). Qolgan tannarx — qolgan barcha xarajat shu mahsulotga tushadi.</p>
        <table><tbody id="outs"></tbody></table><button type="button" class="ghost small" id="addOut">+ Mahsulot</button></div>
      <label>Izoh<input name="note" value="${esc(r?.note ?? '')}"></label>
      ${r ? `<label style="display:flex;gap:8px;color:var(--text)"><input type="checkbox" name="active" ${r.active ? 'checked' : ''}> Faol</label>` : ''}
      <p class="err" id="rErr"></p>
      <div class="actions" style="display:flex;gap:8px;justify-content:flex-end"><a class="btnlike" href="#prod-recipes">Bekor</a><button>Saqlash</button></div>
    </form>`;
  const form = $('#rf', v);
  const drawLines = () => {
    $('#lines', v).innerHTML = lines.map((l, i) => `<tr data-i="${i}"><td><select data-k="productId" style="min-width:200px">${popts(l.productId)}</select></td>
      <td><input data-k="qty" type="number" step="0.0001" min="0" value="${esc(l.qty)}" style="width:110px"></td>
      <td>${l.alts.map((a, j) => `<div class="row" style="gap:4px;margin-bottom:4px"><select data-alt="${j}" data-ak="productId">${popts(a.productId)}</select>
        <input data-alt="${j}" data-ak="qty" type="number" step="0.0001" min="0" placeholder="miqdori (bo'sh = bir xil)" value="${esc(a.qty)}" style="width:150px">
        <button type="button" class="ghost small" data-altdel="${j}">✕</button></div>`).join('')}<button type="button" class="ghost small" data-altadd>+ alternativ</button></td>
      <td><button type="button" class="ghost small" data-del>✕</button></td></tr>`).join('');
  };
  const drawOuts = () => {
    $('#outs', v).innerHTML = outputs.map((o, i) => `<tr data-o="${i}"><td><select data-k="productId">${popts(o.productId, (p) => p.kind !== 'milk')}</select></td>
      <td><select data-k="costMode">${Object.entries(MODE).map(([k, t]) => `<option value="${k}" ${o.costMode === k ? 'selected' : ''}>${t}</option>`).join('')}</select></td>
      <td><input data-k="costValue" type="number" step="0.01" min="0" value="${esc(o.costValue)}" placeholder="${o.costMode === 'percent' ? '%' : 'so\'m / kg'}" ${o.costMode === 'rest' ? 'disabled' : ''} style="width:120px"></td>
      <td><button type="button" class="ghost small" data-odel>✕</button></td></tr>`).join('');
  };
  const drawLims = () => {
    // Only this recipe's inputs and their alternatives (plus anything already chosen).
    const ids = new Set([...lines.flatMap((l) => [l.productId, ...l.alts.map((a) => a.productId)]), ...limits.flatMap((x) => x.productIds)].map(Number).filter(Boolean));
    const opts = products.filter((p) => ids.has(Number(p.id)));
    $('#lims', v).innerHTML = limits.map((x, i) => `<div class="row" data-li="${i}" style="border-bottom:1px solid var(--line);padding:6px 0;align-items:end">
      <label>Nomi<input data-k="name" value="${esc(x.name)}" placeholder="masalan: B zakvaska bilan"></label>
      <label style="flex:2">Shu xomashyolar ishlatilsa<select data-k="productIds" multiple size="3">${opts.map((p) => `<option value="${p.id}" ${x.productIds.includes(p.id) ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
      <label>Eng kami, kg<input data-k="outMin" type="number" step="0.001" min="0" value="${esc(x.outMin)}" style="width:100px"></label>
      <label>Eng ko'pi, kg<input data-k="outMax" type="number" step="0.001" min="0" value="${esc(x.outMax)}" style="width:100px"></label>
      <button type="button" class="ghost small" data-lidel>✕</button></div>`).join('');
  };
  drawLims();
  $('#addLim', v).onclick = () => { limits.push({ name: '', productIds: [], outMin: '', outMax: '' }); drawLims(); };
  $('#lims', v).oninput = (e) => {
    const row = e.target.closest('[data-li]'); const k = e.target.dataset.k; if (!row || !k) return;
    limits[row.dataset.li][k] = k === 'productIds' ? [...e.target.selectedOptions].map((o) => Number(o.value)) : e.target.value;
  };
  $('#lims', v).onchange = $('#lims', v).oninput;
  $('#lims', v).onclick = (e) => { const row = e.target.closest('[data-li]'); if (row && e.target.hasAttribute('data-lidel')) { limits.splice(Number(row.dataset.li), 1); drawLims(); } };
  const drawRates = () => {
    // picked from "Qo'shimcha xarajatlar" — the rate comes from the type
    $('#rates', v).innerHTML = rates.map((x, i) => `<tr data-r="${i}"><td><select data-k="wageTypeId"><option value="">— ishbay haq turini tanlang —</option>${wageTypes.map((w) => `<option value="${w.id}" ${String(w.id) === String(x.wageTypeId) ? 'selected' : ''}>${esc(w.name)} — ${fmtNum(w.amount)} so'm</option>`).join('')}</select></td>
      <td><button type="button" class="ghost small" data-rdel>✕</button></td></tr>`).join('')
      + (wageTypes.length ? '' : `<tr><td class="muted">Ishbay haq turlari yo'q — avval <a href="#prod-wages">Qo'shimcha xarajatlar</a>da qo'shing</td></tr>`);
  };
  drawRates();
  $('#addRate', v).onclick = () => { rates.push({ wageTypeId: '', name: '', amount: '' }); drawRates(); };
  $('#rates', v).oninput = (e) => { const tr = e.target.closest('tr[data-r]'); if (tr && e.target.dataset.k) rates[tr.dataset.r][e.target.dataset.k] = e.target.value; };
  $('#rates', v).onchange = $('#rates', v).oninput;
  $('#rates', v).onclick = (e) => { const tr = e.target.closest('tr[data-r]'); if (tr && e.target.hasAttribute('data-rdel')) { rates.splice(Number(tr.dataset.r), 1); drawRates(); } };
  const drawRout = () => {
    $('#rout', v).innerHTML = rout.map((o, i) => `<tr data-ro="${i}"><td><select data-k="productId">${popts(o.productId, (p) => p.kind !== 'milk')}</select></td>
      <td><input data-k="perUnit" type="number" step="0.0001" min="0" value="${esc(o.perUnit)}" placeholder="netto" style="width:90px"></td>
      <td><input data-k="minPerUnit" type="number" step="0.0001" min="0" value="${esc(o.minPerUnit)}" style="width:80px"></td>
      <td><input data-k="maxPerUnit" type="number" step="0.0001" min="0" value="${esc(o.maxPerUnit)}" style="width:80px"></td>
      <td><input data-k="costValue" type="number" step="0.01" min="0" value="${esc(o.costValue)}" style="width:100px"></td>
      <td><input data-k="isContainer" type="checkbox" ${o.isContainer ? 'checked' : ''}></td><td><button type="button" class="ghost small" data-rodel>✕</button></td></tr>`).join('');
  };
  drawRout();
  $('#addRout', v).onclick = () => { rout.push({ productId: '', perUnit: '', minPerUnit: '', maxPerUnit: '', costValue: 0, isContainer: false }); drawRout(); };
  $('#rout', v).oninput = (e) => {
    const tr = e.target.closest('tr[data-ro]'); const k = e.target.dataset.k; if (!tr || !k) return;
    rout[tr.dataset.ro][k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
  };
  $('#rout', v).onchange = $('#rout', v).oninput;
  $('#rout', v).onclick = (e) => { const tr = e.target.closest('tr[data-ro]'); if (tr && e.target.hasAttribute('data-rodel')) { rout.splice(Number(tr.dataset.ro), 1); drawRout(); } };
  const kindView = () => {
    const kind = form.elements.kind.value;
    const rep = kind === 'reprocess';
    $('#reprocWrap', v).hidden = !rep; $('#linesCard', v).hidden = rep;
    $('#prodLabel', v).textContent = rep ? 'Qaysi mahsulot qayta ishlanadi' : 'Chiqadigan mahsulot';
    if (rep && !rout.length) { rout.push({ productId: '', perUnit: 1, minPerUnit: '', maxPerUnit: '', costValue: 800, isContainer: true }, { productId: '', perUnit: '', minPerUnit: '', maxPerUnit: '', costValue: 0, isContainer: false }); drawRout(); }
    const sep = kind === 'separation';
    const unit = ['pour', 'pack', 'cap', 'reprocess'].includes(kind);
    $('#prodWrap', v).hidden = sep; $('#outWrap', v).hidden = !sep;
    // Production (quyma, separation) never pays a piece wage: only pouring, packing, capping.
    $('#rateWrap', v).hidden = sep || kind === 'cook';
    $('#rangeRow', v).hidden = unit; $('#rangeHint', v).hidden = unit; $('#unitHint', v).hidden = !unit; $('#limWrap', v).hidden = unit;
    $('#linesTitle', v).textContent = unit ? 'Nima ketadi (1 dona uchun)' : 'Nima ketadi (asosiy partiya)';
    if (sep && !outputs.length) { outputs.push({ productId: '', costMode: 'fixed', costValue: '' }, { productId: '', costMode: 'rest', costValue: '' }); drawOuts(); }
  };
  drawLines(); drawOuts(); kindView();
  form.elements.kind.onchange = kindView;
  $('#addLine', v).onclick = () => { lines.push({ productId: '', qty: '', alts: [] }); drawLines(); };
  $('#addOut', v).onclick = () => { outputs.push({ productId: '', costMode: 'rest', costValue: '' }); drawOuts(); };
  $('#lines', v).oninput = (e) => {
    const tr = e.target.closest('tr[data-i]'); if (!tr) return;
    const l = lines[tr.dataset.i];
    if (e.target.dataset.k) l[e.target.dataset.k] = e.target.value;
    if (e.target.dataset.ak) l.alts[e.target.dataset.alt][e.target.dataset.ak] = e.target.value;
  };
  $('#lines', v).onchange = (e) => { $('#lines', v).oninput(e); if (e.target.matches('select')) drawLims(); };
  $('#lines', v).onclick = (e) => {
    const tr = e.target.closest('tr[data-i]'); if (!tr) return;
    const l = lines[tr.dataset.i];
    if (e.target.hasAttribute('data-del')) { lines.splice(Number(tr.dataset.i), 1); drawLines(); }
    if (e.target.hasAttribute('data-altadd')) { l.alts.push({ productId: '', qty: '' }); drawLines(); }
    if (e.target.dataset.altdel != null) { l.alts.splice(Number(e.target.dataset.altdel), 1); drawLines(); }
  };
  $('#outs', v).oninput = (e) => {
    const tr = e.target.closest('tr[data-o]'); if (!tr || !e.target.dataset.k) return;
    outputs[tr.dataset.o][e.target.dataset.k] = e.target.value;
    if (e.target.dataset.k === 'costMode') drawOuts();
  };
  $('#outs', v).onchange = $('#outs', v).oninput;
  $('#outs', v).onclick = (e) => { const tr = e.target.closest('tr[data-o]'); if (tr && e.target.hasAttribute('data-odel')) { outputs.splice(Number(tr.dataset.o), 1); drawOuts(); } };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = form.elements;
    const body = {
      name: f.name.value, kind: f.kind.value, stageId: f.stageId.value ? Number(f.stageId.value) : null, productId: f.productId.value || null, outMin: f.outMin.value, outMax: f.outMax.value, note: f.note.value || null,
      lines: lines.filter((l) => l.productId).map((l) => ({ productId: Number(l.productId), qty: Number(l.qty), alts: l.alts.filter((a) => a.productId).map((a) => ({ productId: Number(a.productId), qty: a.qty === '' ? null : Number(a.qty) })) })),
      outputs: f.kind.value === 'reprocess'
        ? rout.filter((o) => o.productId).map((o) => ({ productId: Number(o.productId), perUnit: o.perUnit === '' ? null : Number(o.perUnit), minPerUnit: o.minPerUnit === '' ? null : Number(o.minPerUnit),
          maxPerUnit: o.maxPerUnit === '' ? null : Number(o.maxPerUnit), costValue: Number(o.costValue) || 0, isContainer: !!o.isContainer }))
        : outputs.filter((o) => o.productId).map((o) => ({ productId: Number(o.productId), costMode: o.costMode, costValue: o.costValue === '' ? null : Number(o.costValue) })),
      rates: ['cook', 'separation'].includes(f.kind.value) ? [] : rates.filter((x) => x.wageTypeId).map((x) => ({ wageTypeId: Number(x.wageTypeId) })),
      limits: ['cook', 'separation'].includes(f.kind.value) ? limits.filter((x) => x.productIds.length).map((x) => ({ name: x.name || null, productIds: x.productIds,
        outMin: x.outMin === '' ? null : Number(x.outMin), outMax: x.outMax === '' ? null : Number(x.outMax) })) : [],
      maxMinutes: f.maxMinutes.value === '' ? null : Number(f.maxMinutes.value),
      suggest: f.suggest.checked,
      ...(f.active ? { active: f.active.checked } : {}),
    };
    try {
      await (id ? prodApi('PUT', `/recipes/${id}`, body) : prodApi('POST', '/recipes', body));
      flash('Tarkib saqlandi');
      setHash('prod-recipes', {});
    } catch (ex) { $('#rErr', v).textContent = ex.message; }
  };
};

// ------------------------------------------------------------------ loss reasons
views['prod-reasons'] = async (v) => {
  const section = hashParams().get('section') || 'tech';
  const [list, m, cats] = await Promise.all([api('GET', `/reasons?section=${section}`, null, '/api/erp'), loadMeta(), costs() ? api('GET', '/pnl-categories', null, '/api/erp') : []]);
  const sections = Object.entries(m.reasonSections).filter(([k]) => k !== 'warehouse');
  v.innerHTML = `<div class="presets" style="margin-bottom:12px">${sections.map(([k, t]) => `<button class="ghost small ${k === section ? 'on' : ''}" data-sec="${k}">${t}</button>`).join('')}</div>
    <div class="card"><p class="muted">Har bir bo'limning sabablari faqat o'sha bo'limda ko'rinadi (texnolog sabablari quyuvchiga ko'rinmaydi).
      <b>Tannarxga</b> — shu smenada chiqqan mahsulotlar qimmatlashadi (ishlatilgan sutga qarab bo'linadi). <b>Kompaniya xarajatiga</b> va <b>xodim hisobiga</b> partiya tannarxiga ta'sir qilmaydi.
      Limit nisbatda ishlaydi: "1000 kg ga 100 kg" — 500 kg sut ishlatilgan smenada 50 kg gacha.</p>
      <table><thead><tr><th>Sabab</th><th>Ta'siri</th><th>Limit</th><th></th></tr></thead><tbody>
      ${list.map((r) => `<tr class="${r.active ? '' : 'voided'}"><td>${esc(r.name)}</td><td>${esc(m.reasonEffects[r.effect] ?? r.effect)}${r.effect === 'company' && r.category ? ` <span class="muted">(${esc(r.category)})</span>` : ''}</td>
        <td>${r.limit_qty != null && r.limit_base ? `${fmtNum(r.limit_qty, 3)} kg / ${fmtNum(r.limit_base, 3)} kg` : '<span class="muted">—</span>'}</td>
        <td>${can('prod.manage') ? `<button class="ghost small" data-edit="${r.id}">Tahrirlash</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Sabab yo\'q</td></tr>'}
      </tbody></table>${can('prod.manage') ? '<button class="small" id="newR" style="margin-top:8px">+ Sabab</button>' : ''}</div>`;
  $$('[data-sec]', v).forEach((b) => { b.onclick = () => setHash('prod-reasons', { section: b.dataset.sec }); });
  const edit = (r = null) => openForm({
    title: r ? 'Sababni tahrirlash' : 'Yangi sabab',
    fields: [
      { name: 'name', label: 'Nomi', value: r?.name, required: true },
      { name: 'effect', label: 'Ta\'siri', type: 'select', options: Object.entries(m.reasonEffects), value: r?.effect ?? 'cost' },
      ...(cats.length ? [{ name: 'categoryId', label: 'Xarajat moddasi (kompaniya xarajati bo\'lsa)', type: 'select', options: cats.filter((c) => c.kind === 'expense').map((c) => [c.id, c.name]), value: r?.category_id }] : []),
      { name: 'limitQty', label: 'Limit: eng ko\'pi, kg', type: 'number', step: '0.001', min: 0, value: r?.limit_qty ?? '', hint: 'Bo\'sh qolsa limit yo\'q' },
      { name: 'limitBase', label: '... shuncha kg ishlatilgan sutga', type: 'number', step: '0.001', min: 0, value: r?.limit_base ?? '', hint: 'Masalan 100 kg / 1000 kg' },
      ...(r ? [{ name: 'active', label: 'Faol', type: 'checkbox', value: !!r.active }] : []),
    ],
    onSubmit: (d) => {
      const body = { ...d, section, limitQty: d.limitQty === '' ? null : Number(d.limitQty), limitBase: d.limitBase === '' ? null : Number(d.limitBase) };
      return r ? api('PATCH', `/reasons/${r.id}`, body, '/api/erp') : api('POST', '/reasons', body, '/api/erp');
    },
  });
  $('#newR', v)?.addEventListener('click', () => edit());
  $$('[data-edit]', v).forEach((b) => { b.onclick = () => edit(list.find((x) => x.id === Number(b.dataset.edit))); });
};

// ------------------------------------------------------------------ Qo'shimcha xarajatlar (piece-wage types)
// Kept once with the rate per unit (Quyish, Qopqoq yopish...). Recipes pick them;
// changing a rate here changes it in every recipe that uses the type. The worker's
// statement shows which task and product each wage came from.
views['prod-wages'] = async (v) => {
  const list = await prodApi('GET', '/wage-types?all=1');
  v.innerHTML = `<div class="card"><h2>Ishbay haq turlari</h2>
    <p class="muted">Tannarxga qo'shiladigan qo'shimcha xarajat — 1 birlik (dona) uchun xodimga yoziladi. Tarkibda tur tanlanadi, summani har safar yozish shart emas.
      Bir nechta xodim birga bajarsa, teng bo'linadi. Xodimning akt sverkasida qaysi topshiriq va mahsulotdan olgani ko'rinadi.</p>
    <table><thead><tr><th>Nomi</th><th class="num">1 birlik uchun, so'm</th><th class="num">Tarkiblarda</th><th></th></tr></thead><tbody>
    ${list.map((w) => `<tr class="${w.active ? '' : 'voided'}"><td><b>${esc(w.name)}</b></td><td class="num">${fmtNum(w.amount)}</td><td class="num">${w.recipes || ''}</td>
      <td><button class="ghost small" data-edit="${w.id}">Tahrirlash</button></td></tr>`).join('') || '<tr><td colspan="4" class="muted">Hali tur yo\'q</td></tr>'}
    </tbody></table><button class="small" id="newW" style="margin-top:8px">+ Tur</button></div>`;
  const edit = (w = null) => openForm({
    title: w ? 'Ishbay haq turi' : 'Yangi ishbay haq turi',
    fields: [
      { name: 'name', label: 'Nomi (masalan Quyish, Qopqoq yopish)', value: w?.name, required: true },
      { name: 'amount', label: '1 birlik uchun, so\'m', type: 'number', step: '0.01', min: 0, value: w?.amount ?? '', required: true },
      ...(w ? [{ name: 'active', label: 'Faol', type: 'checkbox', value: !!w.active }] : []),
    ],
    onSubmit: (d) => { const body = { ...d, amount: Number(d.amount) }; return w ? prodApi('PATCH', `/wage-types/${w.id}`, body) : prodApi('POST', '/wage-types', body); },
  });
  $('#newW', v).onclick = () => edit();
  $$('[data-edit]', v).forEach((b) => { b.onclick = () => edit(list.find((x) => x.id === Number(b.dataset.edit))); });
};

// ------------------------------------------------------------------ stages and maps
views['prod-stages'] = async (v) => {
  const [stages, meta, products] = await Promise.all([prodApi('GET', '/stages?all=1'), loadMeta(), api('GET', '/products?stock=1', null, '/api/erp')]);
  const manage = can('prod.manage');
  const finished = products.filter((p) => p.kind === 'finished' && !p.parent_id);
  const live = stages.filter((s) => s.active);
  v.innerHTML = `<div class="card"><div class="row" style="justify-content:space-between;align-items:center"><h2 style="margin:0">Bosqichlar</h2>
      ${manage ? '<button id="newSt">+ Bosqich</button>' : ''}</div>
    <p class="muted">Har bir bosqich — ombor ("Bosqich" sifatida Omborlar ro'yxatida ham bor). Bosqichdagi mas'ullar uni boshqaradi: oldingi bosqichdan oladi,
      miqdorni kiritadi, "kim bilan qildingiz"ni belgilaydi. <b>O'zgaradigan</b> bosqichda mahsulot boshqasiga aylanadi (tarkib, xomashyo, chegaralar, ishbay haq);
      <b>O'zgarmas</b> bosqichda o'sha mahsulot keyingi joyga o'tadi (ishbay haq bo'lishi yoki bo'lmasligi mumkin).
      Oldingi bosqichda yo'q miqdor kiritilsa — u manfiyga tushadi va ogohlantirish chiqadi; keyin kelgan mahsulot uni haqiqiy tannarxda yopadi.</p>
    <div class="table-wrap"><table><thead><tr><th>#</th><th>Bosqich</th><th>Turi</th><th class="num">Ishbay, so'm</th><th>Mas'ullar</th><th></th></tr></thead><tbody>
    ${stages.map((s, i) => `<tr class="${s.active ? '' : 'voided'}"><td>${i + 1}</td><td><b>${esc(s.name)}</b></td><td>${esc(s.type_label)}</td>
      <td class="num">${s.type === 'keep' && s.piece_rate ? fmtNum(s.piece_rate) : ''}</td>
      <td>${s.keepers.map((k) => esc(k.name)).join(', ') || '<span class="warn">belgilanmagan</span>'}</td>
      <td style="white-space:nowrap">${manage ? `<button class="ghost small" data-up="${s.id}" ${i ? '' : 'disabled'}>↑</button><button class="ghost small" data-down="${s.id}" ${i < stages.length - 1 ? '' : 'disabled'}>↓</button>
        <button class="ghost small" data-st="${s.id}">Tahrirlash</button>` : ''}</td></tr>`).join('')}
    </tbody></table></div></div>
    <div class="card"><h2>Tex kartalar (tayyor mahsulotlar)</h2>
      <p class="muted">Har bir <b>tayyor</b> mahsulot qaysi bosqichlardan o'tishi va har bir o'zgaradigan bosqichda qaysi tarkib ishlashi.
        "Ishlab chiqarish" yoqilsa — mahsulotning <b>quymasi</b> (quyma tarkibi) tanlanadi: bir quymadan bir nechta tayyor mahsulot chiqishi mumkin.
        "Quyish" / "Qadoqlash" yoqilsa — o'sha tarkib tanlanadi. O'chiq bosqichdan mahsulot o'tmaydi — keyingisiga sakraydi.</p>
      <div class="table-wrap"><table><thead><tr><th>Mahsulot</th><th>Bosqichlar</th><th></th></tr></thead><tbody>
      ${finished.map((p) => `<tr><td><b>${esc(p.name)}</b></td><td class="muted">${p.stages.length ? live.filter((s) => p.stages.includes(s.id)).map((s) => esc(s.name)).join(' → ') : '<span class="warn">Tex karta yo\'q</span>'}</td>
        <td>${manage ? `<button class="ghost small" data-tex="${p.id}">Tex karta</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">Tayyor mahsulot yo\'q</td></tr>'}
      </tbody></table></div></div>`;
  const stEdit = (s = null) => {
    const dlg = $('#dlg'); const keep = new Set((s?.keepers ?? []).map((k) => k.id));
    dlg.innerHTML = `<form method="dialog"><h2>${s ? 'Bosqichni tahrirlash' : 'Yangi bosqich'}</h2>
      <label>Nomi<input name="name" required value="${esc(s?.name ?? '')}"></label>
      <label>Turi<select name="type">${optionsHtml(Object.entries(meta.stageTypes), s?.type ?? 'keep')}</select></label>
      <label id="rateL">Ishbay haq, 1 dona uchun (bo'sh — hisoblanmaydi)<input name="pieceRate" type="number" min="0" step="0.01" value="${s?.piece_rate ?? ''}"></label>
      ${s ? '' : `<label>Qayerga qo'yiladi<select name="after"><option value="0">Eng boshiga</option>${stages.map((x) => `<option value="${x.id}" ${x === stages[stages.length - 1] ? 'selected' : ''}>"${esc(x.name)}"dan keyin</option>`).join('')}</select></label>`}
      <div><div class="muted" style="font-size:13px">Mas'ullar (shu bosqichni boshqaradi)</div><div class="checks">${meta.staff.map((u) => `<label><input type="checkbox" name="k" value="${u.id}" ${keep.has(u.id) ? 'checked' : ''}> ${esc(u.name)}</label>`).join('')}</div></div>
      ${s ? `<label style="display:flex;gap:8px;color:var(--text)"><input type="checkbox" name="active" ${s.active ? 'checked' : ''}> Faol</label>` : ''}
      <p class="err" id="dlgErr"></p><div class="actions"><button type="button" class="ghost" value="cancel">Bekor</button><button value="ok">Saqlash</button></div></form>`;
    const form = $('form', dlg);
    const rateView = () => { $('#rateL', dlg).hidden = form.elements.type.value !== 'keep'; };
    form.elements.type.onchange = rateView; rateView();
    $('button[value=cancel]', dlg).onclick = () => dlg.close();
    form.onsubmit = async (e) => {
      e.preventDefault();
      const f = form.elements;
      const body = { name: f.name.value, type: f.type.value, pieceRate: f.pieceRate.value, keepers: $$('input[name=k]:checked', form).map((x) => Number(x.value)),
        ...(s ? { active: f.active.checked } : { after: Number(f.after.value) }) };
      try { await (s ? prodApi('PUT', `/stages/${s.id}`, body) : prodApi('POST', '/stages', body)); dlg.close(); erpMeta = null; route(); } catch (ex) { $('#dlgErr').textContent = ex.message; }
    };
    dlg.showModal();
  };
  $('#newSt', v)?.addEventListener('click', () => stEdit());
  $$('[data-st]', v).forEach((b) => { b.onclick = () => stEdit(stages.find((s) => s.id === Number(b.dataset.st))); });
  const move = (id, dir) => act(async () => {
    const i = stages.findIndex((s) => s.id === id);
    const j = i + dir;
    if (j < 0 || j >= stages.length) return;
    // "after" = the stage it should follow once moved.
    const after = dir < 0 ? (j === 0 ? 0 : stages[j - 1].id) : stages[j].id;
    await prodApi('PUT', `/stages/${id}`, { after });
    route();
  });
  $$('[data-up]', v).forEach((b) => { b.onclick = move(Number(b.dataset.up), -1); });
  $$('[data-down]', v).forEach((b) => { b.onclick = move(Number(b.dataset.down), 1); });
  $$('[data-tex]', v).forEach((b) => { b.onclick = act(() => texCard(Number(b.dataset.tex))); });
};

// The Tex karta of a finished product: stages on / off; a recipe for each 'change' stage.
async function texCard(productId) {
  const t = await prodApi('GET', `/tex/${productId}`);
  const dlg = $('#dlg');
  const HINT = { produce: 'Quyma mahsuloti (quyma tarkibi)', pour: 'Quyish tarkibi', pack: 'Qadoqlash tarkibi', reprocess_bad: 'Qayta ishlash tarkibi', reprocess_ok: 'Qayta ishlash tarkibi' };
  dlg.innerHTML = `<form method="dialog" style="min-width:min(560px,90vw)"><h2>Tex karta — ${esc(t.product.name)}</h2>
    <div style="display:grid;gap:6px">${t.stages.map((s) => `<div class="row" data-s="${s.id}" style="align-items:center;border-bottom:1px solid var(--line);padding:6px 0">
      <label style="display:flex;gap:8px;color:var(--text);flex:1;align-items:center"><input type="checkbox" data-on ${s.on ? 'checked' : ''}> <b>${esc(s.name)}</b></label>
      ${s.type === 'change' ? `<label style="flex:2">${esc(HINT[s.code] ?? 'Tarkib')}<select data-recipe><option value="">— tanlang —</option>${s.recipes.map((r) => `<option value="${r.id}" ${r.id === s.recipe_id ? 'selected' : ''}>${esc(r.name)}${r.product ? ` → ${esc(r.product)}` : r.product_id ? '' : ' (umumiy)'}</option>`).join('')}</select></label>` : '<span class="muted" style="flex:2">tarkibsiz</span>'}
    </div>`).join('')}</div>
    <p class="muted">Quyuvchi qaysi mahsulotni quyishni tanlaydi (keyinchalik buyurtma asosidagi reja ko'rsatadi).</p>
    <p class="err" id="dlgErr"></p><div class="actions"><button type="button" class="ghost" value="cancel">Bekor</button><button value="ok">Saqlash</button></div></form>`;
  const form = $('form', dlg);
  const sync = () => $$('[data-s]', form).forEach((row) => { const sel = $('[data-recipe]', row); if (sel) sel.disabled = !$('[data-on]', row).checked; });
  form.onchange = sync; sync();
  $('button[value=cancel]', dlg).onclick = () => dlg.close();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const stages = $$('[data-s]', form).filter((row) => $('[data-on]', row).checked)
      .map((row) => ({ stageId: Number(row.dataset.s), recipeId: $('[data-recipe]', row)?.value ? Number($('[data-recipe]', row).value) : null }));
    try { await prodApi('PUT', `/map/${productId}`, { stages }); dlg.close(); flash('Tex karta saqlandi'); route(); } catch (ex) { $('#dlgErr').textContent = ex.message; }
  };
  dlg.showModal();
}

// ------------------------------------------------------------------ Reja (plan)
views['prod-plans'] = async (v) => {
  const q = hashParams();
  const today = todayLocal();
  const day = q.get('day') || today;
  const [plans, plan, products] = await Promise.all([prodApi('GET', `/plans?from=${addDays(today, -30)}&to=${addDays(today, 60)}`),
    prodApi('GET', `/plans/${day}`).catch(() => null), api('GET', '/products', null, '/api/erp')]);
  const finished = products.filter((x) => x.kind === 'finished' && !x.has_variants && x.active);
  const editable = day >= today && can('prod.manage');
  const dmy = (d) => d.split('-').reverse().join('.');
  const lines = (plan?.lines ?? []).map((l) => ({ productId: l.product_id, qty: l.qty, name: l.product }));
  if (!lines.length && editable) lines.push({ productId: '', qty: '' });
  v.innerHTML = `<div class="grid2">
    <div class="card"><div class="row" style="justify-content:space-between;align-items:center"><h2 style="margin:0">Rejalar</h2>
        ${can('prod.manage') ? `<label style="flex:none">Yangi kun<input type="date" id="newDay" min="${today}"></label>` : ''}</div>
      <p class="muted">Reja faqat tayyor mahsulot soni bilan kiritiladi. Texnologga u quyma (kg) bo'lib, quyuvchiga mahsulot bo'yicha ko'rinadi.
        O'tgan kunning rejasini o'zgartirib bo'lmaydi. Keyinchalik reja agentlar buyurtmasidan to'ladi.</p>
      <table><tbody>${plans.map((x) => `<tr><td><a href="#prod-plans?day=${x.day}"><b>${dmy(x.day)}</b></a>${x.day === today ? ' <span class="badge sent">bugun</span>' : ''}${x.day === day ? ' ◀' : ''}</td>
        <td class="muted">${x.lines.length} ta mahsulot · ${fmtNum(x.lines.reduce((a, l) => a + l.qty, 0))} dona</td><td>${x.editable ? '' : '<span class="muted">yopiq</span>'}</td></tr>`).join('') || '<tr><td class="muted">Reja yo&#39;q</td></tr>'}</tbody></table></div>
    <div class="card"><h2>${dmy(day)} — reja</h2>
      <div id="pl"></div>
      ${editable ? `<button class="ghost small" id="addL" style="margin-top:8px">+ Mahsulot</button>
        <label style="display:flex;gap:8px;align-items:center;color:var(--text);margin-top:10px"><input type="checkbox" id="pSuggest" ${plan?.suggest === 0 ? '' : 'checked'}> Reja ishlab chiqarishda tavsiya bo'lib chiqsin — texnolog / quyuvchi ekranida rejaga ko'ra xira raqamlar</label>
        <div class="row" style="margin-top:12px"><button id="saveP">Saqlash</button>${plan ? '<button class="ghost" id="delP">O&#39;chirish</button>' : ''}</div>` : (plan ? '' : '<p class="muted">Bu kun uchun reja yo&#39;q</p>')}
      <p class="err" id="pErr"></p>
      <div id="tv"></div></div></div>`;
  const draw = () => {
    $('#pl', v).innerHTML = lines.length ? `<table><thead><tr><th>Tayyor mahsulot</th><th class="num">Soni</th><th></th></tr></thead><tbody>${lines.map((l, i) => `<tr data-i="${i}">
      <td>${editable ? `<select data-k="productId"><option value="">— tanlang —</option>${finished.map((x) => `<option value="${x.id}" ${String(x.id) === String(l.productId) ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>` : esc(l.name ?? '')}</td>
      <td class="num">${editable ? `<input data-k="qty" type="number" min="0" step="1" value="${esc(l.qty)}" style="width:110px">` : fmtNum(l.qty)}</td>
      <td>${editable ? '<button class="ghost small" data-del>✕</button>' : ''}</td></tr>`).join('')}</tbody></table>` : '';
  };
  draw();
  // how the technologist sees it (quyma)
  if (plan) prodApi('GET', `/plans/view?day=${day}`).then((pv) => {
    $('#tv', v).innerHTML = pv.tech.length ? `<h2 style="margin-top:16px">Texnolog uchun (quyma)</h2><table><tbody>${pv.tech.map((t) => `<tr><td>${esc(t.quyma)}<div class="muted">${t.products.map((x) => `${esc(x.product)} ${fmtNum(x.plan)}`).join(', ')}</div></td>
      <td class="num"><b>${fmtNum(t.qty, 3)} ${esc(t.unit)}</b>${t.made ? `<div class="muted">chiqdi ${fmtNum(t.made, 3)}</div>` : ''}</td></tr>`).join('')}</tbody></table>
      ${pv.pour.some((x) => !x.quyma) ? `<p class="warn">Tex kartasida quyma tanlanmagan: ${pv.pour.filter((x) => !x.quyma).map((x) => esc(x.product)).join(', ')}</p>` : ''}` : '';
  }).catch(() => {});
  $('#newDay', v)?.addEventListener('change', (e) => { if (e.target.value) setHash('prod-plans', { day: e.target.value }); });
  if (!editable) return;
  $('#pl', v).oninput = (e) => { const tr = e.target.closest('tr[data-i]'); if (tr && e.target.dataset.k) lines[tr.dataset.i][e.target.dataset.k] = e.target.value; };
  $('#pl', v).onchange = $('#pl', v).oninput;
  $('#pl', v).onclick = (e) => { const tr = e.target.closest('tr[data-i]'); if (tr && e.target.hasAttribute('data-del')) { lines.splice(Number(tr.dataset.i), 1); draw(); } };
  $('#addL', v).onclick = () => { lines.push({ productId: '', qty: '' }); draw(); };
  $('#saveP', v).onclick = act(async () => {
    try { await prodApi('PUT', `/plans/${day}`, { suggest: $('#pSuggest', v).checked, lines: lines.filter((l) => l.productId && Number(l.qty) > 0).map((l) => ({ productId: Number(l.productId), qty: Number(l.qty) })) }); flash('Reja saqlandi'); route(); }
    catch (ex) { $('#pErr', v).textContent = ex.message; }
  });
  $('#delP', v)?.addEventListener('click', act(async () => { if (!confirm("Shu kunning rejasi o'chirilsinmi?")) return; await prodApi('DELETE', `/plans/${day}`); flash("O'chirildi"); setHash('prod-plans', {}); }));
};

views['prod-plan-report'] = async (v) => {
  const q = hashParams();
  const f = { from: q.get('from') || addDays(todayLocal(), -13), to: q.get('to') || todayLocal() };
  const days = await prodApi('GET', `/plans/report?from=${f.from}&to=${f.to}`);
  const color = (pct) => (pct == null ? 'inherit' : pct >= 100 ? 'var(--ok)' : pct >= 80 ? 'var(--warn)' : 'var(--err)');
  const tot = { plan: days.reduce((a, d) => a + d.plan, 0), made: days.reduce((a, d) => a + d.rows.reduce((x, r) => x + Math.min(r.made, r.plan), 0), 0) };
  v.innerHTML = `<div class="card"><div class="row"><label>Dan<input type="date" id="from" value="${f.from}"></label><label>Gacha<input type="date" id="to" value="${f.to}"></label></div></div>
    <div class="tiles"><div class="tile"><div class="k">Rejalar</div><div class="v">${days.length}</div><div class="s">${days.filter((d) => d.done).length} tasi to'liq bajarilgan</div></div>
      <div class="tile"><div class="k">Bajarilish</div><div class="v" style="color:${color(tot.plan ? (tot.made / tot.plan) * 100 : null)}">${tot.plan ? fmtNum((tot.made / tot.plan) * 100, 1) : '—'}%</div><div class="s">reja: ${fmtNum(tot.plan)} dona</div></div></div>
    ${days.map((d) => `<div class="card"><div class="row" style="justify-content:space-between;align-items:center"><h2 style="margin:0">${d.day.split('-').reverse().join('.')}</h2>
        <b style="font-size:20px;color:${color(d.pct)}">${d.pct ?? '—'}%${d.done ? ' ✓' : ''}</b></div>
      <p class="muted">Rejadan kam: ${d.under} ta mahsulot · ko'p: ${d.over} ta · chiqdi ${fmtNum(d.made)} / ${fmtNum(d.plan)} dona</p>
      <table><thead><tr><th>Mahsulot</th><th class="num">Reja</th><th class="num">Chiqdi</th><th class="num">Farq</th><th class="num">%</th></tr></thead><tbody>
      ${d.rows.map((r) => `<tr><td>${esc(r.product)}</td><td class="num">${fmtNum(r.plan)}</td><td class="num">${fmtNum(r.made)}</td>
        <td class="num" style="color:${r.diff < 0 ? 'var(--err)' : r.diff > 0 ? 'var(--ok)' : 'inherit'}">${r.diff > 0 ? '+' : ''}${fmtNum(r.diff)}</td><td class="num" style="color:${color(r.pct)}">${r.pct ?? '—'}%</td></tr>`).join('')}
      </tbody></table></div>`).join('') || '<div class="card"><p class="muted">Bu davrda reja yo&#39;q</p></div>'}
    <p class="muted">"Chiqdi" — o'sha kuni quyish / qadoqlashdan chiqqan tayyor mahsulot soni.</p>`;
  $('#from', v).onchange = (e) => setHash('prod-plan-report', { ...f, from: e.target.value });
  $('#to', v).onchange = (e) => setHash('prod-plan-report', { ...f, to: e.target.value });
};

views['prod-journal'] = async (v) => {
  const q = hashParams();
  const f = { stageId: q.get('stageId') || '', from: q.get('from') || addDays(todayLocal(), -2), to: q.get('to') || todayLocal() };
  const [stages, list] = await Promise.all([prodApi('GET', '/stages'), prodApi('GET', `/journal?${new URLSearchParams(Object.entries(f).filter(([, x]) => x))}`)]);
  v.innerHTML = `<div class="card"><div class="row"><label>Bosqich<select id="st"><option value="">Hammasi</option>${optionsHtml(stages.map((s) => [s.id, s.name]), f.stageId)}</select></label>
      <label>Dan<input type="date" id="from" value="${f.from}"></label><label>Gacha<input type="date" id="to" value="${f.to}"></label></div>
      <p class="muted">Har bir amal: qaysi bosqichda, kim (qaysi profildan) bajardi, kimlar qatnashdi va nima o'tdi.</p></div>
    <div class="card table-wrap"><table><thead><tr><th>Vaqt</th><th>Bosqich</th><th>Kim bajardi</th><th>Nima</th><th>Qatnashganlar</th><th>Holati</th></tr></thead><tbody>
    ${list.map((t) => `<tr><td>${fmtDate(t.done_at || t.created_at)}</td><td>${esc(t.stage ?? '—')}</td><td>${esc(t.user_name ?? '')}</td>
      <td>${esc(t.recipe ?? '')} ${(t.outputs.length ? t.outputs : (t.result?.outputs ?? [])).map((o) => `${esc(o.product ?? '')}: <b>${fmtNum(o.qty, 3)} ${esc(o.unit ?? '')}</b>`).join(', ')}</td>
      <td class="muted">${(t.wages?.length ? t.wages : t.workers).map((w) => `${esc(w.name)}${costs() && w.amount != null ? ` (${fmtMoney(w.amount)})` : ''}`).join(', ')}</td>
      <td>${badge(PTASK, t.status)}${t.cancel_reason ? `<div class="err">${esc(t.cancel_reason)}</div>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Yo\'q</td></tr>'}
    </tbody></table></div>`;
  const go = () => setHash('prod-journal', { stageId: $('#st', v).value, from: $('#from', v).value, to: $('#to', v).value });
  $$('select, input', v).forEach((el) => { el.onchange = go; });
};

PAGES.push(
  ['prod-plans', 'Reja', ['prod.manage', 'prod.view'], 'prod'],
  ['prod-plan-report', 'Reja hisoboti', ['prod.manage', 'prod.view'], 'prod'],
  ['prod-stages', 'Bosqichlar va xarita', ['prod.manage', 'prod.view'], 'prod'],
  ['prod-journal', 'Jurnal', ['prod.view', 'prod.approve', 'prod.manage'], 'prod'],
  ['prod', 'Smenalar', ['prod.view', 'prod.approve', 'prod.manage'], 'prod'],
  ['prod-approvals', 'Tasdiqlash', 'prod.approve', 'prod'],
  ['prod-recipes', 'Tarkiblar', ['prod.manage', 'prod.view'], 'prod'],
  ['prod-reasons', 'Yo\'qotish sabablari', 'prod.manage', 'prod'],
  ['prod-wages', "Qo'shimcha xarajatlar", 'prod.manage', 'prod'],
);
Object.assign(PAGE_PARENT, { 'prod-shift': 'prod', 'prod-recipe': 'prod-recipes' });
if (me) show();
