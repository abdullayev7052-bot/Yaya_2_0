'use strict';

// "Savdo" section of the panel: sales / returns / payments with receipts,
// customers with their statement, prices (base, customer type, customer) and the
// sales settings (return types → warehouses, payment methods, cashboxes, receipt).
// Talks to /api/erp/sales. Loaded after app.js and stock.js.

const salesApi = (method, path, body) => api(method, path, body, '/api/erp/sales');
const SDOC = { sale: 'Sotuv', return: 'Qaytarish', payment: "To'lov" };
const sBadge = (d) => (d.status === 'cancelled' ? '<span class="badge error">Bekor qilingan</span>' : '');

function printReceipt(html) {
  const w = window.open('', '_blank', 'width=420,height=700');
  if (!w) { flash('Brauzer yangi oynani ochishga ruxsat bermadi', 'err'); return; }
  w.document.write(html.replace('</body>', '<script>window.onload = () => setTimeout(() => window.print(), 300);<\/script></body>'));
  w.document.close();
}

views.sales = async (v) => {
  const q = hashParams();
  const f = { type: q.get('type') || '', from: q.get('from') || todayLocal(), to: q.get('to') || todayLocal() };
  const list = await salesApi('GET', `/docs?${new URLSearchParams(Object.entries(f).filter(([, x]) => x))}`);
  const live = list.filter((d) => d.status !== 'cancelled');
  const sum = (t, k) => live.filter((d) => d.type === t).reduce((a, d) => a + (d[k] ?? 0), 0);
  v.innerHTML = `<div class="card"><div class="presets">${[['', 'Hammasi'], ['sale', 'Sotuvlar'], ['return', 'Qaytarishlar'], ['payment', "To'lovlar"]]
      .map(([k, t]) => `<button class="ghost small ${k === f.type ? 'on' : ''}" data-t="${k}">${t}</button>`).join('')}</div>
    <div class="row" style="margin-top:8px"><label>Dan <input type="date" id="from" value="${f.from}"></label><label>Gacha <input type="date" id="to" value="${f.to}"></label></div></div>
    <div class="tiles">
      <div class="tile"><div class="k">Sotuv</div><div class="v">${fmtMoney(sum('sale', 'total'))}</div><div class="s">${live.filter((d) => d.type === 'sale').length} ta chek</div></div>
      <div class="tile"><div class="k">Pul tushdi</div><div class="v">${fmtMoney(sum('sale', 'paid') + sum('payment', 'total'))}</div><div class="s">sotuvda + qarz to'lovlari</div></div>
      <div class="tile"><div class="k">Qaytarish</div><div class="v">${fmtMoney(sum('return', 'total'))}</div><div class="s">${live.filter((d) => d.type === 'return').length} ta</div></div>
      ${costs() ? `<div class="tile"><div class="k">Yalpi foyda (sotuv − tannarx)</div><div class="v">${fmtMoney(sum('sale', 'total') - sum('sale', 'total_cost'))}</div><div class="s">qaytarishlarsiz</div></div>` : ''}
    </div>
    <div class="card table-wrap"><table><thead><tr><th>Chek</th><th>Turi</th><th>Vaqt</th><th>Mijoz</th><th>Sotuvchi</th><th class="num">Summa</th><th class="num">To'landi</th><th class="num">Qarz (keyin)</th>${costs() ? '<th class="num">Tannarx</th>' : ''}</tr></thead><tbody>
    ${list.map((d) => `<tr class="${d.status === 'cancelled' ? 'voided' : ''}"><td><a href="#sale?id=${d.id}">${esc(d.label)}</a> ${sBadge(d)}</td>
      <td>${esc(d.type_label)}${d.return_type ? ` <span class="muted">(${esc(d.return_type)})</span>` : ''}</td><td>${fmtDate(d.doc_date)}</td>
      <td>${d.customer ? `<a href="#customer?id=${d.customer.id}">${esc(d.customer.name)}</a>` : ''}</td><td>${esc(d.seller)}</td>
      <td class="num">${fmtMoney(d.total)}</td><td class="num">${d.type === 'return' ? '' : fmtMoney(d.paid)}</td><td class="num">${fmtMoney(d.debt_after)}</td>
      ${costs() ? `<td class="num">${d.type === 'payment' ? '' : fmtMoney(d.total_cost)}</td>` : ''}</tr>`).join('') || '<tr><td colspan="9" class="muted">Bu davrda hujjat yo\'q</td></tr>'}
    </tbody></table></div>`;
  $$('[data-t]', v).forEach((b) => { b.onclick = () => setHash('sales', { ...f, type: b.dataset.t }); });
  $('#from', v).onchange = (e) => setHash('sales', { ...f, from: e.target.value });
  $('#to', v).onchange = (e) => setHash('sales', { ...f, to: e.target.value });
};

views.sale = async (v) => {
  const d = await salesApi('GET', `/docs/${hashParams().get('id')}`);
  v.innerHTML = `<p><a href="#sales">← Savdo</a></p>
    <div class="card"><div class="row" style="justify-content:space-between;align-items:center">
      <h2 style="margin:0">${esc(d.type_label)} ${esc(d.label)} ${sBadge(d)}</h2>
      <div class="row"><button class="ghost" id="print">Chekni chop etish</button>${d.status !== 'cancelled' && can('sales.cancel') ? '<button class="danger" id="cancel">Bekor qilish</button>' : ''}</div></div>
      <div class="grid2" style="margin:12px 0 0">
        <div><div class="muted">Vaqt</div>${fmtDate(d.doc_date)}</div>
        <div><div class="muted">Mijoz</div>${d.customer ? `<a href="#customer?id=${d.customer.id}">${esc(d.customer.name)}</a>` : ''}</div>
        <div><div class="muted">Sotuvchi</div>${esc(d.seller)}</div>
        ${d.from_name ? `<div><div class="muted">Qayerdan</div>${esc(d.from_name)}</div>` : ''}
        ${d.to_name ? `<div><div class="muted">Qaysi omborga</div>${esc(d.to_name)}</div>` : ''}
        ${d.return_type ? `<div><div class="muted">Qaytarish turi</div>${esc(d.return_type)}${d.expired && !d.credited ? ' — qarzdan ayrilmadi (mijoz siyosati)' : ''}</div>` : ''}
        ${d.method ? `<div><div class="muted">To'lov turi</div>${esc(d.method)}</div>` : ''}
        <div><div class="muted">Qarz: oldin → keyin</div>${fmtMoney(d.debt_before)} → <b>${fmtMoney(d.debt_after)}</b></div>
        ${d.cancel_reason ? `<div><div class="muted">Bekor qilish sababi</div>${esc(d.cancel_reason)}</div>` : ''}
        ${d.note ? `<div><div class="muted">Izoh</div>${esc(d.note)}</div>` : ''}
      </div></div>
    ${d.lines.length ? `<div class="card table-wrap"><table><thead><tr><th>Mahsulot</th><th class="num">Miqdor</th><th class="num">Narx</th><th class="num">Summa</th>${costs() ? '<th class="num">Tannarx</th><th class="num">Foyda</th>' : ''}</tr></thead><tbody>
      ${d.lines.map((l) => `<tr><td>${esc(l.product)}</td><td class="num">${fmtNum(l.qty, 3)} ${esc(l.unit)}</td><td class="num">${fmtMoney(l.price)}</td><td class="num">${fmtMoney(l.sum)}</td>
        ${costs() ? `<td class="num">${fmtMoney(l.cost)}</td><td class="num">${d.type === 'sale' ? fmtMoney(l.sum - l.cost) : ''}</td>` : ''}</tr>`).join('')}
      <tr><td><b>Jami</b></td><td class="num">${fmtNum(d.total_qty, 3)}</td><td></td><td class="num"><b>${fmtMoney(d.total)}</b></td>
        ${costs() ? `<td class="num">${fmtMoney(d.total_cost)}</td><td class="num">${d.type === 'sale' ? `<b>${fmtMoney(d.total - d.total_cost)}</b>` : ''}</td>` : ''}</tr>
    </tbody></table>${d.cost_mode ? `<p class="muted">Qaytgan mahsulot tannarxi: ${d.cost_mode === 'avg' ? "o'rtacha" : 'oxirgi partiya'} bo'yicha.</p>` : ''}</div>` : ''}`;
  $('#print', v).onclick = act(async () => printReceipt((await salesApi('GET', `/docs/${d.id}/receipt`)).html));
  $('#cancel', v)?.addEventListener('click', () => openForm({ title: `${d.label} ni bekor qilish`, danger: true, submit: 'Bekor qilish',
    intro: "<p class=\"muted\">Hujjat to'liq teskari yoziladi: ombor qoldig'i, mijoz qarzi, kassa va foyda-zarar qaytadi.</p>",
    fields: [{ name: 'reason', label: 'Sabab', required: true }], onSubmit: (x) => salesApi('POST', `/docs/${d.id}/cancel`, x) }));
};

// ------------------------------------------------------------------ customers
async function customerForm(c = null) {
  const m = await salesApi('GET', '/meta');
  openForm({
    title: c ? 'Mijozni tahrirlash' : 'Yangi mijoz',
    fields: [
      { name: 'name', label: 'Nomi', value: c?.name, required: true },
      { name: 'phone', label: 'Telefon', value: c?.phone },
      { name: 'typeId', label: 'Mijoz turi', type: 'select', options: [['', '—'], ...m.customerTypes.filter((t) => t.active).map((t) => [t.id, t.name])], value: c?.type_id ?? '' },
      { name: 'address', label: 'Manzil', value: c?.address },
      { name: 'openingBalance', label: "Boshlang'ich qarz (mijoz bizga qarzdor — musbat)", type: 'number', step: '0.01', value: c?.opening_balance ?? 0 },
      { name: 'expiredPolicy', label: "Muddati o'tgan mahsulot qaytsa", type: 'select', options: [['reduce', 'Qarzidan ayriladi'], ['keep', 'Qarzidan ayrilmaydi']], value: c?.expired_policy ?? 'reduce' },
      { name: 'note', label: 'Izoh', value: c?.note },
      ...(c ? [{ name: 'active', label: 'Faol', type: 'checkbox', value: !!c.active }] : []),
    ],
    onSubmit: (d) => (c ? salesApi('PUT', `/customers/${c.id}`, d) : salesApi('POST', '/customers', d)),
  });
}

views.customers = async (v) => {
  const qs = hashParams().get('q') || '';
  const list = await salesApi('GET', `/customers${can('customers.manage') ? '?all=1' : ''}`);
  const shown = list.filter((c) => !qs || `${c.name} ${c.phone ?? ''}`.toLowerCase().includes(qs.toLowerCase()));
  const debt = list.filter((c) => c.balance > 0).reduce((a, c) => a + c.balance, 0);
  v.innerHTML = `<div class="row" style="margin-bottom:12px"><label>Qidirish<input id="q" value="${esc(qs)}" placeholder="Ism yoki telefon"></label>
      <div style="flex:2;text-align:right">${can('customers.manage') || can('sales.sell') ? '<button id="newC">+ Mijoz</button>' : ''}</div></div>
    <div class="tiles"><div class="tile"><div class="k">Mijozlar qarzi (jami)</div><div class="v">${fmtMoney(debt)}</div><div class="s">${list.filter((c) => c.balance > 0.005).length} ta qarzdor</div></div></div>
    <div class="card table-wrap"><table><thead><tr><th>Mijoz</th><th>Turi</th><th>Telefon</th><th>Muddati o'tgan qaytsa</th><th class="num">Qarz</th></tr></thead><tbody>
    ${shown.map((c) => `<tr class="${c.active ? '' : 'voided'}"><td><a href="#customer?id=${c.id}">${esc(c.name)}</a></td><td>${esc(c.type_name ?? '')}</td><td>${esc(c.phone ?? '')}</td>
      <td class="muted">${c.expired_policy === 'keep' ? 'ayrilmaydi' : 'qarzdan ayriladi'}</td>
      <td class="num" style="color:${c.balance > 0 ? 'var(--err)' : c.balance < 0 ? 'var(--ok)' : 'inherit'}">${fmtMoney(c.balance)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Mijoz yo\'q</td></tr>'}
    </tbody></table><p class="muted">Qarz musbat — mijoz bizga qarzdor; manfiy — biz mijozga qarzdormiz (oldindan to'lagan).</p></div>`;
  $('#q', v).onchange = (e) => setHash('customers', { q: e.target.value });
  $('#newC', v)?.addEventListener('click', act(() => customerForm()));
};

views.customer = async (v) => {
  const c = await salesApi('GET', `/customers/${hashParams().get('id')}`);
  const KIND = { sale: 'Sotuv', payment: "To'lov", return: 'Qaytarish', reversal: 'Bekor qilindi' };
  v.innerHTML = `<p><a href="#customers">← Mijozlar</a></p>
    <div class="card"><div class="row" style="justify-content:space-between;align-items:center"><h2 style="margin:0">${esc(c.name)}</h2>
      <div class="row">${can('sales.sell') ? "<button id=\"pay\">To'lov qabul qilish</button>" : ''}${can('customers.manage') ? '<button class="ghost" id="edit">Tahrirlash</button>' : ''}</div></div>
      <div class="grid2" style="margin:12px 0 0"><div><div class="muted">Qarz</div><b style="font-size:22px;color:${c.balance > 0 ? 'var(--err)' : 'inherit'}">${fmtMoney(c.balance)}</b></div>
        <div><div class="muted">Turi</div>${esc(c.type_name ?? '—')}</div><div><div class="muted">Telefon</div>${esc(c.phone ?? '—')}</div>
        <div><div class="muted">Muddati o'tgan qaytsa</div>${c.expired_policy === 'keep' ? 'qarzidan ayrilmaydi' : 'qarzidan ayriladi'}</div>
        <div><div class="muted">Boshlang'ich qarz</div>${fmtMoney(c.opening_balance)}</div>${c.address ? `<div><div class="muted">Manzil</div>${esc(c.address)}</div>` : ''}</div></div>
    <div class="card table-wrap"><h2>Akt-sverka</h2><table><thead><tr><th>Vaqt</th><th>Hujjat</th><th class="num">Summa</th><th class="num">Qarz</th></tr></thead><tbody>
      ${c.entries.map((e) => `<tr><td>${fmtDate(e.at)}</td><td>${e.doc_id ? `<a href="#sale?id=${e.doc_id}">${esc(KIND[e.kind] ?? e.kind)}</a>` : esc(KIND[e.kind] ?? e.kind)}${e.note ? ` <span class="muted">${esc(e.note)}</span>` : ''}</td>
        <td class="num" style="color:${e.amount > 0 ? 'var(--err)' : 'var(--ok)'}">${e.amount > 0 ? '+' : ''}${fmtMoney(e.amount)}</td><td class="num">${fmtMoney(e.balance)}</td></tr>`).join('')}
      <tr><td colspan="3" class="muted">Boshlang'ich qarz</td><td class="num">${fmtMoney(c.opening_balance)}</td></tr></tbody></table></div>`;
  $('#edit', v)?.addEventListener('click', act(() => customerForm(c)));
  $('#pay', v)?.addEventListener('click', act(async () => {
    const m = await salesApi('GET', '/meta');
    openForm({ title: `${c.name}: to'lov`, submit: 'Qabul qilish',
      fields: [{ name: 'amount', label: 'Summa', type: 'number', step: '0.01', min: 0, required: true },
        { name: 'methodId', label: "To'lov turi", type: 'select', options: m.methods.filter((x) => x.active).map((x) => [x.id, x.name]) }],
      onSubmit: async (d) => { const r = await salesApi('POST', '/payments', { ...d, customerId: c.id, uuid: crypto.randomUUID?.() }); flash(`${r.label} qabul qilindi`); } });
  }));
};

// ------------------------------------------------------------------ prices
views.prices = async (v) => {
  const [products, grid, m, customers] = await Promise.all([api('GET', '/products', null, '/api/erp'), salesApi('GET', '/prices'), salesApi('GET', '/meta'), salesApi('GET', '/customers')]);
  const sellable = products.filter((p) => ['finished', 'returned', 'recycled', 'other'].includes(p.kind));
  const map = new Map(grid.map((g) => [`${g.product_id}|${g.scope}`, g.price]));
  const types = m.customerTypes.filter((t) => t.active);
  const custPrices = grid.filter((g) => g.scope.startsWith('c:'));
  const edit = can('sales.prices');
  const cell = (pid, scope) => `<td><input type="number" step="0.01" min="0" data-p="${pid}" data-s="${scope}" value="${map.get(`${pid}|${scope}`) ?? ''}" ${edit ? '' : 'disabled'} style="width:110px"></td>`;
  v.innerHTML = `<div class="card"><p class="muted">Narx tartibi: avval <b>mijozning o'z narxi</b>, bo'lmasa <b>mijoz turi narxi</b>, bo'lmasa <b>umumiy narx</b>. Bo'sh katak — shu daraja uchun narx yo'q. O'zgarish darhol saqlanadi.</p>
    <div class="table-wrap"><table><thead><tr><th>Mahsulot</th><th>Umumiy</th>${types.map((t) => `<th>${esc(t.name)}</th>`).join('')}</tr></thead><tbody>
    ${sellable.map((p) => `<tr><td>${esc(p.name)} <span class="muted">(${esc(p.unit)})</span></td>${cell(p.id, 'base')}${types.map((t) => cell(p.id, `t:${t.id}`)).join('')}</tr>`).join('') || '<tr><td colspan="9" class="muted">Sotiladigan mahsulot yo\'q (Ombor → Mahsulotlar, turi "Tayyor mahsulot")</td></tr>'}
    </tbody></table></div></div>
    <div class="card"><h2>Mijozlarning o'z narxlari</h2>
      <table><tbody>${custPrices.map((g) => `<tr><td>${esc(customers.find((c) => `c:${c.id}` === g.scope)?.name ?? g.scope)}</td><td>${esc(products.find((p) => p.id === g.product_id)?.name ?? '')}</td>
        <td><input type="number" step="0.01" min="0" data-p="${g.product_id}" data-s="${g.scope}" value="${g.price}" ${edit ? '' : 'disabled'} style="width:110px"></td></tr>`).join('') || '<tr><td class="muted">Yo\'q</td></tr>'}</tbody></table>
      ${edit ? `<div class="row" style="margin-top:8px"><label>Mijoz<select id="nc">${customers.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label>
        <label>Mahsulot<select id="np">${sellable.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label>
        <label>Narx<input id="nv" type="number" step="0.01" min="0"></label><button id="add">Qo'shish</button></div>` : ''}</div>`;
  $$('input[data-p]', v).forEach((inp) => {
    inp.onchange = act(async () => {
      await salesApi('PUT', '/prices', { productId: Number(inp.dataset.p), scope: inp.dataset.s, price: inp.value === '' ? null : Number(inp.value) });
      flash('Narx saqlandi');
    });
  });
  $('#add', v)?.addEventListener('click', act(async () => {
    await salesApi('PUT', '/prices', { productId: Number($('#np', v).value), scope: `c:${$('#nc', v).value}`, price: Number($('#nv', v).value) });
    route();
  }));
};

// ------------------------------------------------------------------ settings
views['sales-settings'] = async (v) => {
  const [m, whs, boxes, staff] = await Promise.all([salesApi('GET', '/meta'), api('GET', '/warehouses', null, '/api/erp'), salesApi('GET', '/cashboxes').catch(() => []), loadMeta().then((x) => x.staff)]);
  const manage = can('sales.manage');
  v.innerHTML = `<div class="grid2">
    <div class="card"><h2>Qaytarish turlari</h2><p class="muted">Har bir tur mahsulotni o'z omboriga tushiradi. "Muddati o'tgan" belgilansa, pul mijozning siyosatiga qarab qarzdan ayriladi yoki ayrilmaydi.</p>
      <table><tbody>${m.returnTypes.map((r) => `<tr class="${r.active ? '' : 'voided'}"><td>${esc(r.name)}</td><td>→ ${esc(r.warehouse ?? '—')}</td><td class="muted">${r.expired ? "muddati o'tgan" : ''}</td>
        <td>${manage ? `<button class="ghost small" data-rt="${r.id}">Tahrirlash</button>` : ''}</td></tr>`).join('') || '<tr><td class="muted">Yo\'q</td></tr>'}</tbody></table>
      ${manage ? '<button class="small" id="newRt" style="margin-top:8px">+ Qaytarish turi</button>' : ''}</div>
    <div class="card"><h2>Mijoz turlari</h2><table><tbody>${m.customerTypes.map((t) => `<tr class="${t.active ? '' : 'voided'}"><td>${esc(t.name)}</td><td>${can('customers.manage') ? `<button class="ghost small" data-ct="${t.id}">Tahrirlash</button>` : ''}</td></tr>`).join('')}</tbody></table>
      ${can('customers.manage') ? '<button class="small" id="newCt" style="margin-top:8px">+ Mijoz turi</button>' : ''}</div>
    <div class="card"><h2>To'lov turlari</h2><table><tbody>${m.methods.map((x) => `<tr class="${x.active ? '' : 'voided'}"><td>${esc(x.name)}</td><td>${manage ? `<button class="ghost small" data-pm="${x.id}">Tahrirlash</button>` : ''}</td></tr>`).join('')}</tbody></table>
      ${manage ? '<button class="small" id="newPm" style="margin-top:8px">+ To\'lov turi</button>' : ''}</div>
    <div class="card"><h2>Kassalar</h2><p class="muted">Sotuvchi sotsa, pul uning o'z kassasiga tushadi (birinchi sotuvda o'zi yaratiladi). Asosiy kassaga o'tkazish — moliya bosqichida.</p>
      <table><tbody>${boxes.map((c) => `<tr class="${c.active ? '' : 'voided'}"><td>${esc(c.name)}${c.is_main ? ' <span class="muted">(asosiy)</span>' : ''}</td><td class="muted">${c.keepers.map((k) => esc(k.name)).join(', ')}</td>
        ${costs() ? `<td class="num">${fmtMoney(c.balance)}</td>` : ''}<td>${manage ? `<button class="ghost small" data-cb="${c.id}">Tahrirlash</button>` : ''}</td></tr>`).join('')}</tbody></table>
      ${manage ? '<button class="small" id="newCb" style="margin-top:8px">+ Kassa</button>' : ''}</div>
    <div class="card"><h2>Chek va qaytarish</h2>
      <label style="display:flex;gap:8px;color:var(--text)"><input type="checkbox" id="rw" ${m.receiptShowWeight ? 'checked' : ''} ${manage ? '' : 'disabled'}> Chekda umumiy vazn va hajmni ko'rsatish</label>
      <label style="max-width:320px;margin-top:8px">"O'rtacha" qaytarish tannarxi — oxirgi necha kun sotuvidan<input type="number" id="days" min="1" max="365" value="${m.returnAvgDays}" ${manage ? '' : 'disabled'}></label></div>
  </div>`;
  const whOpts = whs.filter((w) => w.active).map((w) => [w.id, w.name]);
  const rtForm = (r = null) => openForm({ title: r ? 'Qaytarish turi' : 'Yangi qaytarish turi',
    fields: [{ name: 'name', label: 'Nomi', value: r?.name, required: true }, { name: 'warehouseId', label: 'Qaysi omborga tushadi', type: 'select', options: whOpts, value: r?.warehouse_id },
      { name: 'expired', label: "Muddati o'tgan mahsulot (pul mijoz siyosatiga qarab)", type: 'checkbox', value: !!r?.expired },
      ...(r ? [{ name: 'active', label: 'Faol', type: 'checkbox', value: !!r.active }] : [])],
    onSubmit: (d) => (r ? salesApi('PATCH', `/return-types/${r.id}`, d) : salesApi('POST', '/return-types', d)) });
  $('#newRt', v)?.addEventListener('click', () => rtForm());
  $$('[data-rt]', v).forEach((b) => { b.onclick = () => rtForm(m.returnTypes.find((x) => x.id === Number(b.dataset.rt))); });
  const simple = (path, label, x = null) => openForm({ title: x ? label : `Yangi: ${label.toLowerCase()}`,
    fields: [{ name: 'name', label: 'Nomi', value: x?.name, required: true }, ...(x ? [{ name: 'active', label: 'Faol', type: 'checkbox', value: !!x.active }] : [])],
    onSubmit: (d) => (x ? salesApi('PATCH', `${path}/${x.id}`, d) : salesApi('POST', path, d)) });
  $('#newCt', v)?.addEventListener('click', () => simple('/customer-types', 'Mijoz turi'));
  $$('[data-ct]', v).forEach((b) => { b.onclick = () => simple('/customer-types', 'Mijoz turi', m.customerTypes.find((x) => x.id === Number(b.dataset.ct))); });
  $('#newPm', v)?.addEventListener('click', () => simple('/methods', "To'lov turi"));
  $$('[data-pm]', v).forEach((b) => { b.onclick = () => simple('/methods', "To'lov turi", m.methods.find((x) => x.id === Number(b.dataset.pm))); });
  const cbForm = (c = null) => {
    const dlg = $('#dlg'); const keep = new Set((c?.keepers ?? []).map((k) => k.id));
    dlg.innerHTML = `<form method="dialog"><h2>${c ? 'Kassa' : 'Yangi kassa'}</h2><label>Nomi<input name="name" required value="${esc(c?.name ?? '')}"></label>
      <div><div class="muted" style="font-size:13px">Mas'ullar</div><div class="checks">${staff.map((u) => `<label><input type="checkbox" name="k" value="${u.id}" ${keep.has(u.id) ? 'checked' : ''}> ${esc(u.name)}</label>`).join('')}</div></div>
      ${c ? `<label style="display:flex;gap:8px;color:var(--text)"><input type="checkbox" name="active" ${c.active ? 'checked' : ''}> Faol</label>` : ''}
      <p class="err" id="dlgErr"></p><div class="actions"><button type="button" class="ghost" value="cancel">Bekor</button><button value="ok">Saqlash</button></div></form>`;
    const form = $('form', dlg); $('button[value=cancel]', dlg).onclick = () => dlg.close();
    form.onsubmit = async (e) => { e.preventDefault();
      const body = { name: form.elements.name.value, keepers: $$('input[name=k]:checked', form).map((x) => Number(x.value)), ...(c ? { active: form.elements.active.checked } : {}) };
      try { await (c ? salesApi('PATCH', `/cashboxes/${c.id}`, body) : salesApi('POST', '/cashboxes', body)); dlg.close(); route(); } catch (ex) { $('#dlgErr').textContent = ex.message; } };
    dlg.showModal();
  };
  $('#newCb', v)?.addEventListener('click', () => cbForm());
  $$('[data-cb]', v).forEach((b) => { b.onclick = () => cbForm(boxes.find((x) => x.id === Number(b.dataset.cb))); });
  $('#rw', v).onchange = act(async (e) => { await salesApi('PUT', '/settings', { receiptShowWeight: e.target.checked }); flash('Saqlandi'); });
  $('#days', v).onchange = act(async (e) => { await salesApi('PUT', '/settings', { returnAvgDays: Number(e.target.value) }); flash('Saqlandi'); });
};

GROUPS.splice(GROUPS.findIndex((g) => g[0] === 'reports'), 0, ['sales', 'Savdo']);
PAGES.push(
  ['sales', 'Sotuvlar', 'sales.view_all', 'sales'],
  ['customers', 'Mijozlar', ['customers.manage', 'sales.view_all'], 'sales'],
  ['prices', 'Narxlar', ['sales.prices', 'sales.view_all'], 'sales'],
  ['sales-settings', 'Sozlamalar', ['sales.manage', 'customers.manage'], 'sales'],
);
Object.assign(PAGE_PARENT, { sale: 'sales', customer: 'customers' });
