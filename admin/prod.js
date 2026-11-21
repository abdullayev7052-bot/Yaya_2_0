'use strict';

// "Ishlab chiqarish" section of the panel: technologist shifts and tasks,
// approvals of over-limit work, recipes (tarkiblar) with alternatives and
// separation rules, and the loss reasons of each section with their limits.
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
  return `<div class="card"><h2>Smena yakuni — sut hisobi</h2>
    <p>Qo'lda: <b>${fmtNum(c.milk?.in_hands, 3)} kg</b> · topshiriqlarda ishlatildi: <b>${fmtNum(c.milk?.used, 3)} kg</b></p>
    <table><tbody>
      <tr><td>Omborga qaytarildi</td><td class="num">${fmtNum(c.returned, 3)} kg</td></tr>
      ${(c.losses ?? []).map((l) => `<tr><td>${esc(l.reason)}</td><td class="num err">−${fmtNum(l.qty, 3)} kg</td></tr>`).join('')}
      ${c.gain ? `<tr><td>Yutish (hisobdagidan ko'p qoldi)</td><td class="num" style="color:var(--ok)">+${fmtNum(c.gain, 3)} kg</td></tr>` : ''}
    </tbody></table>
    ${(c.over ?? []).length ? `<p class="warn">Limitdan oshgan: ${c.over.map((o) => `${esc(o.reason)} ${fmtNum(o.qty, 3)} kg (ruxsat ${fmtNum(o.allowed, 3)} kg)`).join(', ')}</p>` : ''}
    ${costs() && c.spread != null ? `<p>Tannarxga taqsimlangan: <b style="color:${c.spread > 0 ? 'var(--err)' : 'var(--ok)'}">${c.spread > 0 ? '+' : ''}${fmtMoney(c.spread)}</b> so'm · smenadagi sutning o'rtacha 1 kg tannarxi ${money2(c.unit)}</p>` : ''}
    ${s.approval_note ? `<p class="muted">Rahbar izohi: ${esc(s.approval_note)}</p>` : ''}</div>`;
}

views.prod = async (v) => {
  const q = hashParams();
  const f = { status: q.get('status') || '', from: q.get('from') || addDays(todayLocal(), -6), to: q.get('to') || todayLocal() };
  const list = await prodApi('GET', `/shifts?${new URLSearchParams(Object.entries(f).filter(([, x]) => x))}`);
  v.innerHTML = `<div class="card"><div class="presets">${[['', 'Hammasi'], ['open', 'Ochiq'], ['approval', 'Tasdiq kutmoqda'], ['closed', 'Yopilgan']]
      .map(([k, t]) => `<button class="ghost small ${k === f.status ? 'on' : ''}" data-st="${k}">${t}</button>`).join('')}</div>
    <div class="row" style="margin-top:8px"><label>Dan <input type="date" id="from" value="${f.from}"></label><label>Gacha <input type="date" id="to" value="${f.to}"></label></div></div>
    <div class="card table-wrap"><table><thead><tr><th>Smena</th><th>Texnolog</th><th>Holati</th><th>Ochildi</th><th>Yopildi</th><th class="num">Topshiriq</th><th class="num">Sut ishlatildi, kg</th></tr></thead><tbody>
    ${list.map((s) => `<tr><td><a href="#prod-shift?id=${s.id}">${esc(s.label)}</a></td><td>${esc(s.user_name)}</td><td>${badge(PSHIFT, s.status)}</td>
      <td>${fmtDate(s.opened_at)}</td><td>${fmtDate(s.closed_at)}</td><td class="num">${s.tasks.n}</td><td class="num">${fmtNum(s.tasks.milk, 3)}</td></tr>`).join('')
      || '<tr><td colspan="7" class="muted">Smena yo\'q. Texnolog ilovada "Ishlab chiqarish" bo\'limidan smena ochadi.</td></tr>'}
    </tbody></table></div>`;
  $$('[data-st]', v).forEach((b) => { b.onclick = () => setHash('prod', { ...f, status: b.dataset.st }); });
  $('#from', v).onchange = (e) => setHash('prod', { ...f, from: e.target.value });
  $('#to', v).onchange = (e) => setHash('prod', { ...f, to: e.target.value });
};

views['prod-shift'] = async (v) => {
  const s = await prodApi('GET', `/shifts/${hashParams().get('id')}`);
  v.innerHTML = `<p><a href="#prod">← Smenalar</a></p>
    <div class="card"><div class="row" style="justify-content:space-between;align-items:center">
      <h2 style="margin:0">${esc(s.label)} · ${esc(s.user_name)} ${badge(PSHIFT, s.status)}</h2>
      <div>${s.status === 'approval' && can('prod.approve') ? `<button data-sapprove="${s.id}">Tasdiqlash</button> <button class="ghost" data-sreject="${s.id}">Rad etish</button>` : ''}</div></div>
      <p class="muted" style="margin:8px 0 0">Ochildi ${fmtDate(s.opened_at)}${s.closed_at ? ` · yopildi ${fmtDate(s.closed_at)}` : ''}</p>
      ${s.status !== 'closed' ? `<p>Hozir qo'lida: <b>${fmtNum(s.milk.in_hands, 3)} kg</b> ${esc(s.milk.product)} · topshiriqlarda ishlatildi <b>${fmtNum(s.milk.used, 3)} kg</b>.
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
      ${(s.close_data?.over ?? []).map((o) => `<div class="warn">${esc(o.reason)}: ${fmtNum(o.qty, 3)} kg — ruxsat ${fmtNum(o.allowed, 3)} kg</div>`).join('')}
      <div class="muted">Ishlatilgan sut ${fmtNum(s.close_data?.milk?.used, 3)} kg · qaytarildi ${fmtNum(s.close_data?.returned, 3)} kg</div></div>`).join('') || '<p class="muted">Yo\'q</p>'}</div>`;
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
      <p class="muted" style="margin:8px 0 0">${['pour', 'cap'].includes(r.kind) ? '1 dona uchun' : `Jami ${fmtNum(r.base_weight, 4)} kg`}${r.rates.length ? ` · ishbay: ${r.rates.map((x) => `${esc(x.name)} ${fmtNum(x.amount)}`).join(', ')} so'm/birlik` : ''}${r.max_minutes ? ` · muddat ${fmtNum(r.max_minutes)} daqiqa` : ''}${r.out_min != null || r.out_max != null ? ` · chiqishi ${fmtNum(r.out_min, 3)}–${fmtNum(r.out_max, 3)} kg (partiyaga nisbatan o'zgaradi)` : ''}
        ${r.kind === 'reprocess' ? `<br>Chiqadi: ${r.outputs.map((o) => `${esc(o.product)} — ${o.per_unit != null ? fmtNum(o.per_unit, 4) : 'netto'}${o.min_per_unit != null || o.max_per_unit != null ? ` (${fmtNum(o.min_per_unit, 4)}–${fmtNum(o.max_per_unit, 4)})` : ''}, ${fmtMoney(o.cost_value)} so'm${o.is_container ? ', idish' : ''}`).join('; ')}` : ''}
        ${r.kind === 'separation' ? `<br>Chiqadi: ${r.outputs.map((o) => `${esc(o.product)} — ${MODE[o.cost_mode]}${o.cost_value != null ? ` ${fmtNum(o.cost_value)}${o.cost_mode === 'percent' ? '%' : ''}` : ''}`).join('; ')}` : ''}</p></div>`).join('')
      || '<p class="muted">Tarkib yo\'q.</p>'}`;
};

views['prod-recipe'] = async (v) => {
  const id = Number(hashParams().get('id')) || null;
  const [r, products] = await Promise.all([id ? prodApi('GET', `/recipes/${id}`) : null, api('GET', '/products', null, '/api/erp')]);
  const lines = (r?.lines ?? []).map((l) => ({ productId: l.product_id, qty: l.qty, alts: l.alts.map((a) => ({ productId: a.product_id, qty: a.qty ?? '' })) }));
  if (!lines.length) lines.push({ productId: '', qty: '', alts: [] });
  const outputs = (r?.outputs ?? []).map((o) => ({ productId: o.product_id, costMode: o.cost_mode, costValue: o.cost_value ?? '' }));
  const rates = (r?.rates ?? []).map((x) => ({ name: x.name, amount: x.amount }));
  // Reprocessing outputs: per input unit (blank = the input's netto weight), range, fixed cost, container.
  const rout = r?.kind === 'reprocess' ? r.outputs.map((o) => ({ productId: o.product_id, perUnit: o.per_unit ?? '', minPerUnit: o.min_per_unit ?? '', maxPerUnit: o.max_per_unit ?? '', costValue: o.cost_value ?? 0, isContainer: !!o.is_container })) : [];
  const popts = (sel, filter = () => true) => `<option value="">— mahsulot —</option>${products.filter(filter).map((p) => `<option value="${p.id}" ${String(p.id) === String(sel) ? 'selected' : ''}>${esc(p.name)} (${esc(p.unit)})</option>`).join('')}`;
  v.innerHTML = `<p><a href="#prod-recipes">← Tarkiblar</a></p>
    <form class="card" id="rf" style="display:grid;gap:12px">
      <h2>${r ? 'Tarkibni tahrirlash' : 'Yangi tarkib'}</h2>
      <div class="row"><label>Nomi<input name="name" required value="${esc(r?.name ?? '')}"></label>
        <label>Turi<select name="kind">${[['cook', 'Tayyorlash — quyma (texnolog)'], ['separation', 'Separatsiya (texnolog)'], ['pour', 'Quyish — idishga (quyuvchi)'], ['cap', 'Qopqoq yopish (qopqoq yopuvchi)'], ['reprocess', "Qayta ishlash — muddati o'tgan (qayta ishlovchi)"]]
          .map(([k, t]) => `<option value="${k}" ${(r?.kind ?? 'cook') === k ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label id="prodWrap"><span id="prodLabel">Chiqadigan mahsulot</span><select name="productId">${popts(r?.product_id, (p) => p.kind !== 'milk')}</select></label></div>
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
      <div class="card" style="margin:0" id="rateWrap"><h2>Ishbay haq (1 birlik uchun)</h2>
        <p class="muted">Masalan "Quyish" 170 so'm. Bir nechta xodim birga bajarsa, teng bo'linadi (2 kishi — 85 dan). Tannarxga qo'shiladi; topshiriq bekor qilinsa haq ham bekor bo'ladi.</p>
        <table><tbody id="rates"></tbody></table><button type="button" class="ghost small" id="addRate">+ Amal</button></div>
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
  const drawRates = () => {
    $('#rates', v).innerHTML = rates.map((x, i) => `<tr data-r="${i}"><td><input data-k="name" value="${esc(x.name)}" placeholder="Amal (Quyish, Qopqoq yopish...)"></td>
      <td><input data-k="amount" type="number" step="0.01" min="0" value="${esc(x.amount)}" placeholder="so'm" style="width:120px"></td><td><button type="button" class="ghost small" data-rdel>✕</button></td></tr>`).join('');
  };
  drawRates();
  $('#addRate', v).onclick = () => { rates.push({ name: '', amount: '' }); drawRates(); };
  $('#rates', v).oninput = (e) => { const tr = e.target.closest('tr[data-r]'); if (tr && e.target.dataset.k) rates[tr.dataset.r][e.target.dataset.k] = e.target.value; };
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
    const unit = kind === 'pour' || kind === 'cap' || kind === 'reprocess';
    $('#prodWrap', v).hidden = sep; $('#outWrap', v).hidden = !sep;
    $('#rateWrap', v).hidden = sep;
    $('#rangeRow', v).hidden = unit; $('#rangeHint', v).hidden = unit; $('#unitHint', v).hidden = !unit;
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
  $('#lines', v).onchange = $('#lines', v).oninput;
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
      name: f.name.value, kind: f.kind.value, productId: f.productId.value || null, outMin: f.outMin.value, outMax: f.outMax.value, note: f.note.value || null,
      lines: lines.filter((l) => l.productId).map((l) => ({ productId: Number(l.productId), qty: Number(l.qty), alts: l.alts.filter((a) => a.productId).map((a) => ({ productId: Number(a.productId), qty: a.qty === '' ? null : Number(a.qty) })) })),
      outputs: f.kind.value === 'reprocess'
        ? rout.filter((o) => o.productId).map((o) => ({ productId: Number(o.productId), perUnit: o.perUnit === '' ? null : Number(o.perUnit), minPerUnit: o.minPerUnit === '' ? null : Number(o.minPerUnit),
          maxPerUnit: o.maxPerUnit === '' ? null : Number(o.maxPerUnit), costValue: Number(o.costValue) || 0, isContainer: !!o.isContainer }))
        : outputs.filter((o) => o.productId).map((o) => ({ productId: Number(o.productId), costMode: o.costMode, costValue: o.costValue === '' ? null : Number(o.costValue) })),
      rates: rates.filter((x) => String(x.name).trim()).map((x) => ({ name: x.name, amount: Number(x.amount) || 0 })),
      maxMinutes: f.maxMinutes.value === '' ? null : Number(f.maxMinutes.value),
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

PAGES.push(
  ['prod', 'Smenalar va topshiriqlar', ['prod.view', 'prod.approve', 'prod.manage'], 'prod'],
  ['prod-approvals', 'Tasdiqlash', 'prod.approve', 'prod'],
  ['prod-recipes', 'Tarkiblar', ['prod.manage', 'prod.view'], 'prod'],
  ['prod-reasons', 'Yo\'qotish sabablari', 'prod.manage', 'prod'],
);
Object.assign(PAGE_PARENT, { 'prod-shift': 'prod', 'prod-recipe': 'prod-recipes' });
if (me) show();
