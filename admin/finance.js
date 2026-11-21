'use strict';

// "Moliya" section of the panel: cashboxes and their statements, expenses / other
// income / transfers, vendors with purchases and payments, payroll (salary, bonus,
// fine, payout) and profit and loss. Talks to /api/erp/finance.

const finApi = (method, path, body) => api(method, path, body, '/api/erp/finance');
const uuid = () => crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
const signed = (v) => { const n = Math.abs(v) < 0.005 ? 0 : v; return `<span style="color:${n > 0 ? 'var(--ok)' : n < 0 ? 'var(--err)' : 'inherit'}">${n > 0 ? '+' : ''}${fmtMoney(n)}</span>`; };
async function finMeta() {
  const [boxes, cats, methods] = await Promise.all([finApi('GET', '/cashboxes'), api('GET', '/pnl-categories', null, '/api/erp'), api('GET', '/meta', null, '/api/erp/sales').then((m) => m.methods)]);
  return { boxes: boxes.filter((b) => b.active), cats: cats.filter((c) => c.active !== 0), methods: methods.filter((m) => m.active) };
}
const boxOpts = (m) => m.boxes.map((b) => [b.id, `${b.name} (${fmtMoney(b.balance)})`]);
const methodField = (m) => ({ name: 'methodId', label: "To'lov turi", type: 'select', options: m.methods.map((x) => [x.id, x.name]) });

async function cashForm(kind, preset = {}) {
  const m = await finMeta();
  const T = { expense: ['Xarajat', '/expenses'], income: ['Boshqa kirim', '/incomes'], move: ["Kassadan kassaga o'tkazma", '/cash-moves'], open: ["Kassa boshlang'ich qoldig'i", '/cash-openings'] }[kind];
  const fields = kind === 'move'
    ? [{ name: 'fromId', label: 'Qaysi kassadan', type: 'select', options: boxOpts(m), value: preset.cashboxId }, { name: 'toId', label: 'Qaysi kassaga', type: 'select', options: boxOpts(m), value: m.boxes.find((b) => b.is_main)?.id }]
    : [{ name: 'cashboxId', label: 'Kassa', type: 'select', options: boxOpts(m), value: preset.cashboxId }];
  if (kind === 'expense' || kind === 'income') fields.push({ name: 'categoryId', label: kind === 'expense' ? 'Xarajat moddasi' : 'Daromad moddasi', type: 'select', options: m.cats.filter((c) => c.kind === kind).map((c) => [c.id, c.name]) });
  fields.push({ name: 'amount', label: kind === 'open' ? 'Summa (kassada hozir bor pul)' : 'Summa', type: 'number', step: '0.01', required: true });
  if (kind !== 'open' && kind !== 'move') fields.push(methodField(m));
  fields.push({ name: 'note', label: 'Izoh', required: kind === 'expense' });
  openForm({ title: T[0], fields, submit: 'Saqlash', onSubmit: async (d) => { const r = await finApi('POST', T[1], { ...d, uuid: uuid() }); flash(`${r.label} saqlandi`); } });
}

views.finance = async (v) => {
  const [sum, boxes] = await Promise.all([finApi('GET', '/summary'), finApi('GET', '/cashboxes')]);
  const c = can('finance.cash');
  v.innerHTML = `<div class="tiles">
      <div class="tile"><div class="k">Kassalarda jami</div><div class="v">${fmtMoney(sum.cash)}</div></div>
      <div class="tile"><div class="k">Mijozlar bizga qarz</div><div class="v">${fmtMoney(sum.customers_owe)}</div><div class="s"><a href="#customers">mijozlar</a></div></div>
      <div class="tile"><div class="k">Biz yetkazib beruvchilarga qarz</div><div class="v">${fmtMoney(sum.we_owe_vendors)}</div><div class="s"><a href="#vendors">batafsil</a></div></div>
      <div class="tile"><div class="k">Biz xodimlarga qarz (oylik, ishbay)</div><div class="v">${fmtMoney(sum.we_owe_staff)}</div><div class="s">xodimlar bizga: ${fmtMoney(sum.staff_owe)}</div></div>
    </div>
    ${c ? `<div class="row" style="margin-bottom:12px"><button data-k="expense">− Xarajat</button><button data-k="income" class="ghost">+ Boshqa kirim</button>
      <button data-k="move" class="ghost">⇄ Kassadan kassaga</button><button data-k="open" class="ghost">Boshlang'ich qoldiq</button></div>` : ''}
    <div class="card table-wrap"><table><thead><tr><th>Kassa</th><th>Mas'ullar</th><th class="num">Qoldiq</th></tr></thead><tbody>
      ${boxes.map((b) => `<tr class="${b.active ? '' : 'voided'}"><td><a href="#cashbox?id=${b.id}">${esc(b.name)}</a>${b.is_main ? ' <span class="muted">(asosiy)</span>' : ''}</td>
        <td class="muted">${b.keepers.map((k) => esc(k.name)).join(', ')}</td><td class="num"><b>${fmtMoney(b.balance)}</b></td></tr>`).join('')}
    </tbody></table><p class="muted">Sotuvchi sotsa pul uning o'z kassasiga tushadi; u ilovadan yoki shu yerdan "Kassadan kassaga" bilan asosiy kassaga topshiradi.
      Kassalar ro'yxati va mas'ullar — Savdo → Sozlamalar.</p></div>`;
  $$('[data-k]', v).forEach((b) => { b.onclick = act(() => cashForm(b.dataset.k)); });
};

views.cashbox = async (v) => {
  const q = hashParams();
  const f = { from: q.get('from') || addDays(todayLocal(), -30), to: q.get('to') || todayLocal() };
  const id = q.get('id');
  const c = await finApi('GET', `/cashboxes/${id}?from=${f.from}&to=${f.to}`);
  const TYPE = { sale: 'Sotuv', payment: "Mijoz to'lovi", expense: 'Xarajat', income: 'Boshqa kirim', cash_move: "O'tkazma", cash_open: "Boshlang'ich", purchase: 'Xarid', vendor_pay: "Yetkazib beruvchiga", staff_pay: "Xodimga to'lov" };
  v.innerHTML = `<p><a href="#finance">← Kassalar</a></p>
    <div class="card"><div class="row" style="justify-content:space-between;align-items:center"><h2 style="margin:0">${esc(c.name)}</h2>
      ${can('finance.cash') ? `<div class="row"><button data-k="expense" class="small">− Xarajat</button><button data-k="income" class="ghost small">+ Kirim</button><button data-k="move" class="ghost small">⇄ O'tkazma</button></div>` : ''}</div>
      <div class="row" style="margin-top:8px"><label>Dan<input type="date" id="from" value="${f.from}"></label><label>Gacha<input type="date" id="to" value="${f.to}"></label></div></div>
    <div class="tiles"><div class="tile"><div class="k">Davr boshida</div><div class="v">${fmtMoney(c.before)}</div></div><div class="tile"><div class="k">Kirim</div><div class="v" style="color:var(--ok)">${fmtMoney(c.in)}</div></div>
      <div class="tile"><div class="k">Chiqim</div><div class="v" style="color:var(--err)">${fmtMoney(c.out)}</div></div><div class="tile"><div class="k">Davr oxirida</div><div class="v">${fmtMoney(c.after)}</div></div></div>
    <div class="card table-wrap"><table><thead><tr><th>Vaqt</th><th>Amal</th><th>To'lov turi</th><th>Izoh</th><th class="num">Summa</th><th class="num">Qoldiq</th></tr></thead><tbody>
      ${c.entries.map((e) => `<tr><td>${fmtDate(e.at)}</td><td>${esc(TYPE[e.type] ?? e.type ?? '')}${e.kind === 'reversal' ? ' <span class="muted">(bekor)</span>' : ''}</td><td>${esc(e.method ?? '')}</td>
        <td class="muted">${esc(e.note ?? '')}</td><td class="num">${signed(e.amount)}</td><td class="num">${fmtMoney(e.balance)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Bu davrda harakat yo\'q</td></tr>'}
    </tbody></table></div>`;
  $('#from', v).onchange = (e) => setHash('cashbox', { id, ...f, from: e.target.value });
  $('#to', v).onchange = (e) => setHash('cashbox', { id, ...f, to: e.target.value });
  $$('[data-k]', v).forEach((b) => { b.onclick = act(() => cashForm(b.dataset.k, { cashboxId: Number(id) })); });
};

views['fin-docs'] = async (v) => {
  const q = hashParams();
  const f = { type: q.get('type') || '', from: q.get('from') || addDays(todayLocal(), -30), to: q.get('to') || todayLocal() };
  const list = await finApi('GET', `/docs?${new URLSearchParams(Object.entries(f).filter(([, x]) => x))}`);
  const TYPES = [['', 'Hammasi'], ['expense', 'Xarajat'], ['income', 'Kirim'], ['cash_move', "O'tkazma"], ['purchase', 'Xarid'], ['vendor_pay', "Yetk. to'lov"], ['salary', 'Oylik'], ['bonus', 'Bonus'], ['fine', 'Jarima'], ['staff_pay', "Xodimga to'lov"]];
  v.innerHTML = `<div class="card"><div class="presets">${TYPES.map(([k, t]) => `<button class="ghost small ${k === f.type ? 'on' : ''}" data-t="${k}">${t}</button>`).join('')}</div>
    <div class="row" style="margin-top:8px"><label>Dan<input type="date" id="from" value="${f.from}"></label><label>Gacha<input type="date" id="to" value="${f.to}"></label></div></div>
    <div class="card table-wrap"><table><thead><tr><th>Hujjat</th><th>Turi</th><th>Vaqt</th><th>Kim / nima</th><th>Kassa</th><th class="num">Summa</th><th>Izoh</th><th></th></tr></thead><tbody>
    ${list.map((d) => `<tr class="${d.status === 'cancelled' ? 'voided' : ''}"><td>${esc(d.label)}</td><td>${esc(d.type_label)}</td><td>${fmtDate(d.doc_date)}</td>
      <td>${esc(d.staff ?? d.vendor ?? d.category ?? (d.from ? `${d.from} → ${d.to}` : ''))}</td><td>${esc(d.cashbox ?? '')}</td><td class="num">${fmtMoney(d.amount)}</td>
      <td class="muted">${esc(d.note ?? '')}${d.cancel_reason ? ` · bekor: ${esc(d.cancel_reason)}` : ''}</td>
      <td>${d.status !== 'cancelled' ? `<button class="ghost small" data-cancel="${d.id}">Bekor</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">Hujjat yo\'q</td></tr>'}
    </tbody></table></div>`;
  $$('[data-t]', v).forEach((b) => { b.onclick = () => setHash('fin-docs', { ...f, type: b.dataset.t }); });
  $('#from', v).onchange = (e) => setHash('fin-docs', { ...f, from: e.target.value });
  $('#to', v).onchange = (e) => setHash('fin-docs', { ...f, to: e.target.value });
  $$('[data-cancel]', v).forEach((b) => { b.onclick = () => openForm({ title: 'Bekor qilish', danger: true, submit: 'Bekor qilish',
    intro: '<p class="muted">Hujjat to\'liq teskari yoziladi: kassa, balanslar, ombor va foyda-zarar qaytadi.</p>',
    fields: [{ name: 'reason', label: 'Sabab', required: true }], onSubmit: (d) => finApi('POST', `/docs/${b.dataset.cancel}/cancel`, d) }); });
};

// ------------------------------------------------------------------ vendors
function vendorForm(x = null) {
  openForm({ title: x ? 'Yetkazib beruvchi' : 'Yangi yetkazib beruvchi',
    fields: [{ name: 'name', label: 'Nomi', value: x?.name, required: true }, { name: 'phone', label: 'Telefon', value: x?.phone },
      { name: 'openingBalance', label: "Boshlang'ich qarz (biz unga qarzdor — musbat)", type: 'number', step: '0.01', value: x?.opening_balance ?? 0 },
      { name: 'note', label: 'Izoh', value: x?.note }, ...(x ? [{ name: 'active', label: 'Faol', type: 'checkbox', value: !!x.active }] : [])],
    onSubmit: (d) => (x ? finApi('PUT', `/vendors/${x.id}`, d) : finApi('POST', '/vendors', d)) });
}
async function purchaseForm(vendorId) {
  const [m, whs, products] = await Promise.all([finMeta(), api('GET', '/warehouses', null, '/api/erp'), api('GET', '/products', null, '/api/erp')]);
  const lines = [{ productId: '', qty: '', price: '' }];
  const dlg = $('#dlg');
  const pOpts = (sel) => `<option value="">— mahsulot —</option>${products.filter((p) => p.kind !== 'milk').map((p) => `<option value="${p.id}" ${String(p.id) === String(sel) ? 'selected' : ''}>${esc(p.name)} (${esc(p.unit)})</option>`).join('')}`;
  dlg.innerHTML = `<form method="dialog" style="width:min(720px, calc(100vw - 32px))"><h2>Xarid (kirim)</h2>
    <label>Qaysi omborga<select name="wh">${whs.filter((w) => w.active).map((w) => `<option value="${w.id}">${esc(w.name)}</option>`).join('')}</select></label>
    <div class="table-wrap"><table><thead><tr><th>Mahsulot</th><th>Miqdor</th><th>1 birlik narxi</th><th class="num">Summa</th><th></th></tr></thead><tbody id="pl"></tbody></table></div>
    <button type="button" class="ghost small" id="addL" style="justify-self:start">+ Qator</button>
    <p>Jami: <b id="tot">0</b></p>
    <div class="row"><label>Hozir to'landi<input name="paid" type="number" step="0.01" min="0" value="0"></label><label>Kassadan<select name="box">${boxOpts(m).map(([id, t]) => `<option value="${id}">${esc(t)}</option>`).join('')}</select></label></div>
    <label>Izoh<input name="note"></label><p class="err" id="dlgErr"></p>
    <div class="actions"><button type="button" class="ghost" value="cancel">Bekor</button><button value="ok">Saqlash</button></div></form>`;
  const form = $('form', dlg);
  const draw = () => {
    $('#pl', dlg).innerHTML = lines.map((l, i) => `<tr data-i="${i}"><td><select data-k="productId">${pOpts(l.productId)}</select></td>
      <td><input data-k="qty" type="number" step="0.001" min="0" value="${esc(l.qty)}" style="width:90px"></td><td><input data-k="price" type="number" step="0.01" min="0" value="${esc(l.price)}" style="width:110px"></td>
      <td class="num">${fmtMoney((Number(l.qty) || 0) * (Number(l.price) || 0))}</td><td><button type="button" class="ghost small" data-del>✕</button></td></tr>`).join('');
    $('#tot', dlg).textContent = fmtMoney(lines.reduce((a, l) => a + (Number(l.qty) || 0) * (Number(l.price) || 0), 0));
  };
  draw();
  $('#pl', dlg).onchange = (e) => { const tr = e.target.closest('tr'); if (tr && e.target.dataset.k) { lines[tr.dataset.i][e.target.dataset.k] = e.target.value; draw(); } };
  $('#pl', dlg).onclick = (e) => { const tr = e.target.closest('tr'); if (tr && e.target.hasAttribute('data-del')) { lines.splice(Number(tr.dataset.i), 1); if (!lines.length) lines.push({ productId: '', qty: '', price: '' }); draw(); } };
  $('#addL', dlg).onclick = () => { lines.push({ productId: '', qty: '', price: '' }); draw(); };
  $('button[value=cancel]', dlg).onclick = () => dlg.close();
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await finApi('POST', '/purchases', { uuid: uuid(), vendorId, warehouseId: Number(form.elements.wh.value), paid: Number(form.elements.paid.value) || 0, cashboxId: Number(form.elements.box.value),
        note: form.elements.note.value || null, lines: lines.filter((l) => l.productId).map((l) => ({ productId: Number(l.productId), qty: Number(l.qty), price: Number(l.price) })) });
      dlg.close(); flash(`${r.label} saqlandi`); route();
    } catch (ex) { $('#dlgErr').textContent = ex.message; }
  };
  dlg.showModal();
}

views.vendors = async (v) => {
  const list = await finApi('GET', '/vendors?all=1');
  v.innerHTML = `<div class="row" style="margin-bottom:12px;justify-content:space-between"><p class="muted" style="margin:0">Xomashyo, idish, xizmat yetkazib beruvchilar. Qarz musbat — biz ularga qarzdormiz.</p>
      ${can('finance.vendors') ? '<button id="newV">+ Yetkazib beruvchi</button>' : ''}</div>
    <div class="card table-wrap"><table><thead><tr><th>Nomi</th><th>Telefon</th><th class="num">Biz qarzdormiz</th></tr></thead><tbody>
    ${list.map((x) => `<tr class="${x.active ? '' : 'voided'}"><td><a href="#vendor?id=${x.id}">${esc(x.name)}</a></td><td>${esc(x.phone ?? '')}</td><td class="num">${fmtMoney(x.balance)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">Yo\'q</td></tr>'}
    </tbody></table></div>`;
  $('#newV', v)?.addEventListener('click', () => vendorForm());
};

views.vendor = async (v) => {
  const x = await finApi('GET', `/vendors/${hashParams().get('id')}`);
  const KIND = { purchase: 'Xarid', payment: "To'lov", reversal: 'Bekor qilindi' };
  v.innerHTML = `<p><a href="#vendors">← Yetkazib beruvchilar</a></p>
    <div class="card"><div class="row" style="justify-content:space-between;align-items:center"><h2 style="margin:0">${esc(x.name)}</h2>
      ${can('finance.vendors') ? '<div class="row"><button id="buy">Xarid (kirim)</button><button class="ghost" id="pay">To\'lov</button><button class="ghost" id="edit">Tahrirlash</button></div>' : ''}</div>
      <p>Biz qarzdormiz: <b style="font-size:20px">${fmtMoney(x.balance)}</b> · boshlang'ich ${fmtMoney(x.opening)}</p></div>
    <div class="card table-wrap"><h2>Akt-sverka</h2><table><thead><tr><th>Vaqt</th><th>Amal</th><th class="num">Summa</th><th class="num">Qarz</th></tr></thead><tbody>
      ${x.entries.map((e) => `<tr><td>${fmtDate(e.at)}</td><td>${esc(KIND[e.kind] ?? e.kind)}</td><td class="num">${e.amount > 0 ? '+' : ''}${fmtMoney(e.amount)}</td><td class="num">${fmtMoney(e.balance)}</td></tr>`).join('')}
      <tr><td colspan="3" class="muted">Boshlang'ich qarz</td><td class="num">${fmtMoney(x.opening)}</td></tr></tbody></table></div>
    <div class="card table-wrap"><h2>Hujjatlar</h2><table><tbody>${x.docs.map((d) => `<tr class="${d.status === 'cancelled' ? 'voided' : ''}"><td>${esc(d.label)}</td><td>${esc(d.type_label)}</td><td>${fmtDate(d.doc_date)}</td>
      <td>${d.lines.map((l) => `${esc(l.product)} ${fmtNum(l.qty, 3)} × ${fmtMoney(l.price)}`).join('<br>')}</td><td class="num">${fmtMoney(d.amount)}</td></tr>`).join('') || '<tr><td class="muted">Yo\'q</td></tr>'}</tbody></table></div>`;
  $('#edit', v)?.addEventListener('click', () => vendorForm(x));
  $('#buy', v)?.addEventListener('click', act(() => purchaseForm(x.id)));
  $('#pay', v)?.addEventListener('click', act(async () => {
    const m = await finMeta();
    openForm({ title: `${x.name}: to'lov`, submit: "To'lash", fields: [{ name: 'cashboxId', label: 'Kassadan', type: 'select', options: boxOpts(m) },
      { name: 'amount', label: 'Summa', type: 'number', step: '0.01', min: 0, required: true, value: x.balance > 0 ? x.balance : '' }, methodField(m), { name: 'note', label: 'Izoh' }],
      onSubmit: async (d) => { const r = await finApi('POST', '/vendor-payments', { ...d, vendorId: x.id, uuid: uuid() }); flash(`${r.label} saqlandi`); } });
  }));
};

// ------------------------------------------------------------------ payroll
async function staffAction(kind, u) {
  const m = kind === 'pay' ? await finMeta() : null;
  const T = {
    salary: ['Oklad', null], bonus: ['Bonus', '/bonuses'], fine: ['Jarima', '/fines'], pay: ["Xodimga to'lov", '/staff-payments'], open: ["Boshlang'ich balans", '/staff-openings'],
  }[kind];
  if (kind === 'salary') {
    openForm({ title: `${u.name}: oklad`, intro: '<p class="muted">Har oy shu kuni xodim shu summaga haqdor bo\'ladi (avtomatik). Yangi oklad bugundan hisoblanadi — o\'tgan oylar uchun yozilmaydi. Bo\'sh — oklad yo\'q.</p>',
      fields: [{ name: 'salary', label: 'Oylik oklad', type: 'number', step: '0.01', min: 0, value: u.salary ?? '' }, { name: 'salaryDay', label: 'Har oyning nechanchi kuni (1–28)', type: 'number', min: 1, value: u.salary_day ?? 1 }],
      onSubmit: (d) => finApi('PUT', `/staff/${u.id}/salary`, { salary: d.salary === '' ? null : Number(d.salary), salaryDay: Number(d.salaryDay) }) });
    return;
  }
  const fields = [];
  if (kind === 'pay') fields.push({ name: 'cashboxId', label: 'Kassadan', type: 'select', options: boxOpts(m) });
  fields.push({ name: 'amount', label: kind === 'open' ? "Summa (musbat — xodim qarzdor, manfiy — kompaniya qarzdor)" : 'Summa', type: 'number', step: '0.01', required: true,
    value: kind === 'pay' && u.balance < 0 ? -u.balance : '' });
  if (kind === 'pay') fields.push(methodField(m));
  fields.push({ name: 'note', label: kind === 'fine' ? 'Sabab (masalan "ishga kelmagan, 1 kun")' : kind === 'bonus' ? 'Sabab' : 'Izoh', required: kind === 'fine' || kind === 'bonus' });
  openForm({ title: `${u.name}: ${T[0].toLowerCase()}`, fields, onSubmit: async (d) => { const r = await finApi('POST', T[1], { ...d, userId: u.id, uuid: uuid() }); flash(`${r.label} saqlandi`); } });
}

views.payroll = async (v) => {
  const list = await finApi('GET', '/staff');
  const p = can('finance.payroll');
  v.innerHTML = `<div class="card"><p class="muted" style="margin:0">Balans manfiy — kompaniya xodimga qarzdor (oklad, ishbay haq, bonus); musbat — xodim kompaniyaga qarzdor (jarima, uning aybi bilan yo'qolgan mahsulot, avans).
      Oklad har oy belgilangan kuni avtomatik yoziladi. Kelmagan kunni hozircha "Jarima" bilan ayiring.</p></div>
    <div class="card table-wrap"><table><thead><tr><th>Xodim</th><th>Rol</th><th class="num">Oklad</th><th class="num">Kuni</th><th class="num">Balans</th>${p ? '<th></th>' : ''}</tr></thead><tbody>
    ${list.map((u) => `<tr class="${u.active ? '' : 'voided'}"><td><a href="#staff-fin?id=${u.id}">${esc(u.name)}</a></td><td class="muted">${esc(u.role ?? '')}</td>
      <td class="num">${u.salary ? fmtMoney(u.salary) : '—'}</td><td class="num">${u.salary_day ?? ''}</td><td class="num">${signed(-u.balance)}</td>
      ${p ? `<td style="white-space:nowrap"><button class="ghost small" data-a="salary" data-u="${u.id}">Oklad</button> <button class="ghost small" data-a="bonus" data-u="${u.id}">Bonus</button>
        <button class="ghost small" data-a="fine" data-u="${u.id}">Jarima</button> <button class="small" data-a="pay" data-u="${u.id}">To'lash</button></td>` : ''}</tr>`).join('')}
    </tbody></table><p class="muted">Jadvalda balans kompaniya nuqtai nazaridan: yashil — xodimga to'lanishi kerak.</p></div>`;
  $$('[data-a]', v).forEach((b) => { b.onclick = act(() => staffAction(b.dataset.a, list.find((u) => u.id === Number(b.dataset.u)))); });
};

views['staff-fin'] = async (v) => {
  const u = await finApi('GET', `/staff/${hashParams().get('id')}`);
  const KIND = { salary: 'Oylik', bonus: 'Bonus', fine: 'Jarima', pay: "To'landi", opening: "Boshlang'ich", piece: 'Ishbay haq', writeoff: 'Xodim aybi bilan', inventory: 'Inventarizatsiya kamomadi', production: 'Ishlab chiqarish', reprocess: 'Qayta ishlash', reversal: 'Bekor qilindi' };
  v.innerHTML = `<p><a href="#payroll">← Oylik</a></p>
    <div class="card"><div class="row" style="justify-content:space-between;align-items:center"><h2 style="margin:0">${esc(u.name)}</h2>
      ${can('finance.payroll') ? '<div class="row"><button class="ghost small" data-a="bonus">Bonus</button><button class="ghost small" data-a="fine">Jarima</button><button class="small" data-a="pay">To\'lash</button><button class="ghost small" data-a="open">Boshlang\'ich balans</button></div>' : ''}</div>
      <p>${u.balance < 0 ? `Kompaniya xodimga qarzdor: <b style="font-size:20px;color:var(--ok)">${fmtMoney(-u.balance)}</b>` : u.balance > 0 ? `Xodim kompaniyaga qarzdor: <b style="font-size:20px;color:var(--err)">${fmtMoney(u.balance)}</b>` : 'Hisob-kitob yopiq'}
        · oklad ${u.salary ? `${fmtMoney(u.salary)}, har oyning ${u.salary_day}-kuni` : 'yo\'q'}</p></div>
    <div class="card table-wrap"><h2>Hisob varag'i</h2><table><thead><tr><th>Vaqt</th><th>Amal</th><th>Izoh</th><th class="num">Summa</th><th class="num">Balans</th></tr></thead><tbody>
      ${u.entries.map((e) => `<tr><td>${fmtDate(e.at)}</td><td>${esc(KIND[e.kind] ?? e.kind)}</td><td class="muted">${esc(e.note ?? '')}</td><td class="num">${signed(-e.amount)}</td><td class="num">${signed(-e.balance)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Yozuv yo\'q</td></tr>'}
    </tbody></table><p class="muted">Yashil — xodimga yozildi (haqi), qizil — xodimdan ayrildi yoki unga to'landi.</p></div>`;
  $$('[data-a]', v).forEach((b) => { b.onclick = act(async () => staffAction(b.dataset.a, { ...(await finApi('GET', `/staff/${u.id}`)), id: u.id })); });
};

// ------------------------------------------------------------------ profit and loss
views.pnl = async (v) => {
  const q = hashParams();
  const f = { from: q.get('from') || `${todayLocal().slice(0, 7)}-01`, to: q.get('to') || todayLocal() };
  const r = await finApi('GET', `/pnl?from=${f.from}&to=${f.to}`);
  const rows = (kind) => r.rows.filter((x) => x.kind === kind).map((x) => `<tr><td>${esc(x.name)}</td><td class="num">${fmtMoney(x.amount)}</td></tr>`).join('') || '<tr><td class="muted">Yo\'q</td></tr>';
  v.innerHTML = `<div class="card"><div class="row"><label>Dan<input type="date" id="from" value="${f.from}"></label><label>Gacha<input type="date" id="to" value="${f.to}"></label></div></div>
    <div class="tiles"><div class="tile"><div class="k">Daromadlar</div><div class="v" style="color:var(--ok)">${fmtMoney(r.income)}</div></div>
      <div class="tile"><div class="k">Xarajatlar</div><div class="v" style="color:var(--err)">${fmtMoney(r.expense)}</div></div>
      <div class="tile"><div class="k">Sof foyda</div><div class="v">${signed(r.net)}</div></div></div>
    <div class="grid2"><div class="card"><h2>Daromadlar</h2><table><tbody>${rows('income')}</tbody></table></div><div class="card"><h2>Xarajatlar</h2><table><tbody>${rows('expense')}</tbody></table></div></div>
    <p class="muted">Sotilgan mahsulot tannarxi (sut, xomashyo, idish, ishbay haq) "Sotilgan mahsulot tannarxi" qatorida. Xonadonlarga to'lovlar sut kirimida tannarxga kiradi.
      Moddalar nomini Ombor → Sozlamalar → "Daromad va xarajat moddalari"da o'zgartirasiz va yangisini qo'shasiz.</p>`;
  $('#from', v).onchange = (e) => setHash('pnl', { ...f, from: e.target.value });
  $('#to', v).onchange = (e) => setHash('pnl', { ...f, to: e.target.value });
};

GROUPS.splice(GROUPS.findIndex((g) => g[0] === 'reports'), 0, ['finance', 'Moliya']);
PAGES.push(
  ['finance', 'Kassalar', ['finance.view', 'finance.cash'], 'finance'],
  ['fin-docs', 'Hujjatlar', 'finance.view', 'finance'],
  ['vendors', 'Yetkazib beruvchilar', ['finance.vendors', 'finance.view'], 'finance'],
  ['payroll', 'Oylik', ['finance.payroll', 'finance.view'], 'finance'],
  ['pnl', 'Foyda-zarar', 'finance.view', 'finance'],
);
Object.assign(PAGE_PARENT, { cashbox: 'finance', vendor: 'vendors', 'staff-fin': 'payroll' });
