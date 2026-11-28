'use strict';

// Ombor (warehouse) section of the panel: stock on hand, documents, warehouses,
// nomenclature, alerts, reference lists and Excel import. Talks to /api/erp.
// Loaded after app.js and uses its helpers (api, openForm, flash, esc, fmt*...).
// Sums are shown only with stock.costs; the server strips them for everyone else anyway.

const erp = (method, path, body) => api(method, path, body, '/api/erp');
const costs = () => can('stock.costs');
const fmtQty = (n) => fmtNum(n, 3);
const DOC_STATUS = {
  draft: ['Qoralama', 'pending'], sent: ['Qabul kutmoqda', 'pending'], posted: ['O\'tkazilgan', 'sent'],
  rejected: ['Rad etilgan', 'error'], cancelled: ['Bekor qilingan', 'error'],
};
const docBadge = (s) => `<span class="badge ${DOC_STATUS[s]?.[1] ?? ''}">${DOC_STATUS[s]?.[0] ?? esc(s)}</span>`;
const STOCK_TABS = [
  ['qoldiq', 'Qoldiqlar'], ['hujjat', 'Hujjatlar'], ['ombor', 'Omborlar'], ['turlar', 'Ombor turlari'], ['mahsulot', 'Mahsulotlar'],
  ['ogoh', 'Ogohlantirishlar'], ['sozlama', 'Sozlamalar'], ['import', 'Excel import'],
];

let erpMeta = null;
async function loadMeta(force = false) {
  if (!erpMeta || force) erpMeta = await erp('GET', '/meta');
  return erpMeta;
}
const holderValue = (h) => (h?.warehouseId ? `w:${h.warehouseId}` : h?.userId ? `u:${h.userId}` : '');
const parseHolderValue = (v) => {
  const [t, id] = String(v || '').split(':');
  if (t === 'w') return { warehouseId: Number(id) };
  if (t === 'u') return { userId: Number(id) };
  return null;
};
// Places: warehouses and stages (nothing is "in a person's hands" any more).
const holderOptions = (m, { empty = null } = {}) => [
  ...(empty ? [`<option value="">${esc(empty)}</option>`] : []),
  `<optgroup label="Omborlar">${m.warehouses.filter((w) => !w.is_stage).map((w) => `<option value="w:${w.id}">${esc(w.name)}</option>`).join('')}</optgroup>`,
  `<optgroup label="Bosqichlar">${m.warehouses.filter((w) => w.is_stage).map((w) => `<option value="w:${w.id}">${esc(w.name)}</option>`).join('')}</optgroup>`,
].join('');
const optionsHtml = (list, value) => list.map(([v, t]) => `<option value="${esc(v)}" ${String(v) === String(value ?? '') ? 'selected' : ''}>${esc(t)}</option>`).join('');

function tabsHtml(active) {
  return `<div class="presets" style="margin-bottom:16px">${STOCK_TABS.map(([k, t]) => `<button class="ghost small ${k === active ? 'on' : ''}" data-tab="${k}">${t}</button>`).join('')}</div>`;
}

// ------------------------------------------------------------------ line editor dialog
// One dialog for every document type. opts: { type, doc (existing draft), title }.
async function openDocForm(type, { doc = null, preset = {} } = {}) {
  const m = await loadMeta(true);
  const products = await erp('GET', '/products?stock=1');
  const dlg = $('#dlg');
  const t = { opening: 'Boshlang\'ich qoldiq', transfer: 'Topshirish', writeoff: 'Hisobdan chiqarish', inventory: 'Inventarizatsiya' }[type];
  const lines = (doc?.lines ?? preset.lines ?? []).filter((l) => !(type === 'inventory' && l.sort === 9999)).map((l) => ({
    productId: l.product_id ?? l.productId, qty: l.qty, unitCost: l.unit_cost ?? l.unitCost ?? '', expiresAt: (l.expires_at ?? '').slice(0, 10),
  }));
  if (!lines.length) lines.push({ productId: '', qty: '', unitCost: '', expiresAt: '' });
  const prodOpts = (sel) => `<option value="">— mahsulot —</option>${products.map((p) => `<option value="${p.id}" ${String(p.id) === String(sel) ? 'selected' : ''}>${esc(p.name)} (${esc(p.unit)})</option>`).join('')}`;
  const withCost = type === 'opening';
  const head = () => {
    if (type === 'opening') return `<label>Ombor<select name="to" required><option value="auto">Turiga qarab — har bir mahsulot o'z omboriga</option>${holderOptions(m, { staff: false })}</select></label>
      <label>Sana<input type="date" name="date" value="${todayLocal()}"></label>`;
    if (type === 'transfer') return `<div class="row"><label>Kimdan<select name="from" required>${holderOptions(m)}</select></label>
      <label>Kimga<select name="to" required>${holderOptions(m)}</select></label></div>
      <p class="muted" style="margin:0">Qabul qiluvchi tasdiqlamaguncha mahsulot topshiruvchida qoladi.</p>`;
    if (type === 'writeoff') return `<label>Qayerdan<select name="from" required>${holderOptions(m)}</select></label>
      <div class="row"><label>Sabab<select name="reasonId" required>${m.reasons.map((r) => `<option value="${r.id}" data-charge="${r.charge}">${esc(r.name)}${r.charge === 'staff' ? ' — xodim hisobiga' : ''}</option>`).join('')}</select></label>
      <label>Kim hisobiga (xodim aybi bo'lsa)<select name="chargeUserId"><option value="">— kompaniya —</option>${m.staff.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select></label></div>`;
    return `<div class="row"><label>Ombor<select name="to" required ${doc ? 'disabled' : ''}>${holderOptions(m, { staff: false })}</select></label>
      <label>Turi<select name="mode">${optionsHtml([['partial', 'Qisman — faqat sanalganlar'], ['full', 'To\'liq — sanalmaganlar 0 bo\'ladi']], doc?.mode ?? 'partial')}</select></label></div>
      <p class="muted" style="margin:0">Sanoq qoralama bo'lib saqlanadi. O'tkazishdan oldin farqlar ko'rsatiladi; kamomad bo'lsa kim hisobiga ekanligi so'raladi.</p>
      <button type="button" class="ghost small" id="fillBook" style="justify-self:start">Hisobdagi qoldiqni yuklash</button>`;
  };
  dlg.innerHTML = `<form method="dialog" style="width:min(760px, calc(100vw - 32px))">
    <h2>${esc(t)}${doc ? ` — ${esc(doc.label)}` : ''}</h2>
    ${head()}
    <div class="table-wrap"><table><thead><tr><th>Mahsulot</th><th>${type === 'inventory' ? 'Sanalgan' : 'Miqdor'}</th>${withCost ? '<th>1 birlik tannarxi</th><th>Yaroqlilik</th>' : ''}<th></th></tr></thead><tbody id="lines"></tbody></table></div>
    <button type="button" class="ghost small" id="addLine" style="justify-self:start">+ Qator</button>
    <label>Izoh<input name="note" value="${esc(doc?.note ?? '')}"></label>
    <p class="err" id="dlgErr"></p>
    <div class="actions"><button type="button" class="ghost" value="cancel">Bekor</button>
      ${type === 'inventory' ? '<button type="button" class="ghost" id="saveDraft">Qoralama saqlash</button>' : ''}
      <button value="ok">${type === 'transfer' ? 'Topshirish' : type === 'inventory' ? 'Farqlarni ko\'rish va o\'tkazish' : 'O\'tkazish'}</button></div>
  </form>`;
  dlg.style.width = 'min(800px, calc(100vw - 32px))';
  const form = $('form', dlg);
  if (doc?.to) form.elements.to.value = holderValue(doc.to);
  if (preset.from && form.elements.from) form.elements.from.value = holderValue(preset.from);
  if (preset.to && form.elements.to) form.elements.to.value = holderValue(preset.to);
  const body = $('#lines', dlg);
  const draw = () => {
    body.innerHTML = lines.map((l, i) => `<tr data-i="${i}">
      <td><select data-k="productId" style="min-width:220px">${prodOpts(l.productId)}</select></td>
      <td><input data-k="qty" type="number" step="0.001" min="0" value="${esc(l.qty)}" style="width:110px"></td>
      ${withCost ? `<td><input data-k="unitCost" type="number" step="0.01" min="0" value="${esc(l.unitCost)}" style="width:120px"></td>
        <td><input data-k="expiresAt" type="date" value="${esc(l.expiresAt)}"></td>` : ''}
      <td><button type="button" class="ghost small" data-del="${i}">✕</button></td></tr>`).join('');
  };
  draw();
  body.oninput = (e) => {
    const tr = e.target.closest('tr'); const k = e.target.dataset.k;
    if (tr && k) lines[tr.dataset.i][k] = e.target.value;
  };
  body.onchange = body.oninput;
  body.onclick = (e) => {
    const i = e.target.dataset.del;
    if (i == null) return;
    lines.splice(Number(i), 1);
    if (!lines.length) lines.push({ productId: '', qty: '', unitCost: '', expiresAt: '' });
    draw();
  };
  $('#addLine', dlg).onclick = () => { lines.push({ productId: '', qty: '', unitCost: '', expiresAt: '' }); draw(); };
  $('button[value=cancel]', dlg).onclick = () => dlg.close();
  const fill = $('#fillBook', dlg);
  if (fill) fill.onclick = act(async () => {
    const h = parseHolderValue(form.elements.to.value);
    const r = await erp('GET', `/stock?warehouseId=${h.warehouseId}`);
    lines.splice(0, lines.length, ...r.rows.map((x) => ({ productId: x.product_id, qty: x.qty, unitCost: '', expiresAt: '' })));
    if (!lines.length) lines.push({ productId: '', qty: '', unitCost: '', expiresAt: '' });
    draw();
  });
  const payload = () => {
    const f = form.elements;
    const clean = lines.filter((l) => l.productId).map((l) => ({
      productId: Number(l.productId), qty: Number(l.qty),
      ...(withCost ? { unitCost: l.unitCost === '' ? null : Number(l.unitCost), expiresAt: l.expiresAt || null } : {}),
    }));
    const p = { type, lines: clean, note: f.note.value || null };
    if (f.from) p.from = parseHolderValue(f.from.value);
    if (f.to) p.to = f.to.value === 'auto' ? 'auto' : parseHolderValue(f.to.value);
    if (f.date?.value) p.date = `${f.date.value}T08:00:00+05:00`;
    if (f.reasonId) p.reasonId = Number(f.reasonId.value);
    if (f.chargeUserId?.value) p.chargeUserId = Number(f.chargeUserId.value);
    if (f.mode) p.mode = f.mode.value;
    return p;
  };
  const saveInventory = async () => {
    const p = payload();
    if (doc) return erp('PUT', `/docs/${doc.id}`, { lines: p.lines, note: p.note, mode: p.mode });
    return erp('POST', '/docs', { ...p, uuid: crypto.randomUUID?.() });
  };
  const err = (e) => { $('#dlgErr').textContent = e.message; };
  const draftBtn = $('#saveDraft', dlg);
  if (draftBtn) draftBtn.onclick = async () => {
    try { const d = await saveInventory(); dlg.close(); flash(`${d.label} qoralama saqlandi`); setHash('stock-doc', { id: d.id }); } catch (e) { err(e); }
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      if (type === 'inventory') {
        const d = await saveInventory();
        dlg.close();
        await inventoryPost(d.id);
        return;
      }
      const d = await erp('POST', '/docs', { ...payload(), uuid: crypto.randomUUID?.() });
      dlg.close();
      flash(d.status === 'sent' ? `${d.label} yuborildi — qabul kutilmoqda` : `${d.label} o'tkazildi`);
      setHash('stock-doc', { id: d.id });
    } catch (ex) { err(ex); }
  };
  dlg.showModal();
}

// Inventory: show the differences first, then post; a shortage asks who pays.
async function inventoryPost(id) {
  const pv = await erp('GET', `/docs/${id}/preview`);
  const dlg = $('#dlg');
  const m = await loadMeta();
  const rows = pv.lines.map((l) => `<tr><td>${esc(l.product)}</td><td class="num">${fmtQty(l.book)}</td><td class="num">${fmtQty(l.qty)}</td>
    <td class="num" style="color:${l.diff < 0 ? 'var(--err)' : 'var(--ok)'}">${l.diff > 0 ? '+' : ''}${fmtQty(l.diff)}</td>
    ${costs() ? `<td class="num">${fmtMoney(l.diff < 0 ? -l.cost : l.cost)}</td>` : ''}</tr>`).join('');
  const loss = pv.loss ?? 0;
  const needSplit = costs() && loss > 0;
  dlg.innerHTML = `<form method="dialog">
    <h2>Inventarizatsiya natijasi</h2>
    ${pv.lines.length ? `<div class="table-wrap"><table><thead><tr><th>Mahsulot</th><th class="num">Hisobda</th><th class="num">Sanalgan</th><th class="num">Farq</th>${costs() ? '<th class="num">Summa</th>' : ''}</tr></thead><tbody>${rows}</tbody></table></div>` : '<p>Farq yo\'q — hisob va sanoq bir xil.</p>'}
    ${costs() ? `<p>Kamomad: <b class="err">${fmtMoney(loss)}</b> · Ortiqcha: <b style="color:var(--ok)">${fmtMoney(pv.surplus ?? 0)}</b></p>` : ''}
    ${needSplit ? `<fieldset style="border:1px solid var(--line);border-radius:8px;display:grid;gap:8px"><legend>Kamomad kim hisobiga?</legend>
      <label style="display:flex;gap:8px;color:var(--text)"><input type="radio" name="who" value="company" checked> Hammasi kompaniya hisobiga</label>
      <label style="display:flex;gap:8px;color:var(--text)"><input type="radio" name="who" value="staff"> Xodim(lar) hisobiga — summalarni bo'lish</label>
      <div id="split" hidden style="display:grid;gap:6px"></div>
      <button type="button" class="ghost small" id="addSplit" hidden style="justify-self:start">+ Xodim</button>
      <p class="muted" id="rest" style="margin:0"></p></fieldset>` : ''}
    ${!costs() && pv.lines.some((l) => l.diff < 0) ? '<p class="warn">Kamomad bor. Uni summalarni ko\'radigan rahbar o\'tkazadi; sanoq qoralama bo\'lib qoladi.</p>' : ''}
    <p class="err" id="dlgErr"></p>
    <div class="actions"><button type="button" class="ghost" value="cancel">Yopish</button>
      ${!costs() && pv.lines.some((l) => l.diff < 0) ? '' : '<button value="ok">O\'tkazish</button>'}</div>
  </form>`;
  const form = $('form', dlg);
  $('button[value=cancel]', dlg).onclick = () => { dlg.close(); setHash('stock-doc', { id }); route(); };
  const split = [];
  const drawSplit = () => {
    const box = $('#split', dlg); if (!box) return;
    box.innerHTML = split.map((s, i) => `<div class="row" data-i="${i}"><label>Xodim<select data-k="userId">${m.staff.map((u) => `<option value="${u.id}" ${String(u.id) === String(s.userId) ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></label>
      <label>Summa<input data-k="amount" type="number" step="0.01" min="0" value="${esc(s.amount)}"></label><button type="button" class="ghost small" data-del="${i}">✕</button></div>`).join('');
    const total = split.reduce((a, s) => a + (Number(s.amount) || 0), 0);
    $('#rest', dlg).textContent = `Xodimlarga: ${fmtMoney(total)} · Kompaniyaga qoladi: ${fmtMoney(Math.max(0, loss - total))}`;
  };
  if (needSplit) {
    form.onchange = (e) => {
      if (e.target.name === 'who') {
        const staff = e.target.value === 'staff';
        $('#split', dlg).hidden = !staff; $('#addSplit', dlg).hidden = !staff;
        if (staff && !split.length) split.push({ userId: m.staff[0]?.id, amount: loss });
        drawSplit();
      }
    };
    $('#split', dlg).oninput = (e) => {
      const row = e.target.closest('[data-i]'); const k = e.target.dataset.k;
      if (row && k) { split[row.dataset.i][k] = e.target.value; const total = split.reduce((a, s) => a + (Number(s.amount) || 0), 0); $('#rest', dlg).textContent = `Xodimlarga: ${fmtMoney(total)} · Kompaniyaga qoladi: ${fmtMoney(Math.max(0, loss - total))}`; }
    };
    $('#split', dlg).onchange = $('#split', dlg).oninput;
    $('#split', dlg).onclick = (e) => { if (e.target.dataset.del != null) { split.splice(Number(e.target.dataset.del), 1); drawSplit(); } };
    $('#addSplit', dlg).onclick = () => { split.push({ userId: m.staff[0]?.id, amount: 0 }); drawSplit(); };
  }
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const who = form.elements.who?.value;
      const body = costs() ? { charges: who === 'staff' ? split.map((s) => ({ userId: Number(s.userId), amount: Number(s.amount) || 0 })) : [] } : {};
      const d = await erp('POST', `/docs/${id}/post`, body);
      dlg.close();
      flash(`${d.label} o'tkazildi`);
      setHash('stock-doc', { id });
      route();
    } catch (ex) { $('#dlgErr').textContent = ex.message; }
  };
  dlg.showModal();
}

// ------------------------------------------------------------------ tabs
const stockTabs = {
  async qoldiq(box) {
    const p = hashParams();
    const m = await loadMeta(true);
    const place = p.get('place') || '';
    const kind = p.get('kind') || '';
    const h = parseHolderValue(place);
    const q = new URLSearchParams();
    if (h?.warehouseId) q.set('warehouseId', h.warehouseId);
    if (h?.userId) q.set('userId', h.userId);
    if (kind) q.set('kind', kind);
    const r = await erp('GET', `/stock?${q}`);
    const btn = (type, label, perm) => (can(perm) ? `<button class="small" data-new="${type}">${label}</button>` : '');
    box.innerHTML = `
      <div class="row" style="margin-bottom:12px">
        <label>Joy<select id="place">${holderOptions(m, { empty: 'Hammasi' })}</select></label>
        <label>Mahsulot turi<select id="kind"><option value="">Hammasi</option>${optionsHtml(Object.entries(m.productKinds), kind)}</select></label>
        <div class="row" style="flex:2;justify-content:flex-end">
          ${btn('opening', '+ Boshlang\'ich qoldiq', 'stock.opening')}
          ${btn('writeoff', '+ Hisobdan chiqarish', 'stock.writeoff')} ${btn('inventory', '+ Inventarizatsiya', 'stock.inventory')}
        </div>
      </div>
      ${costs() ? `<div class="tiles"><div class="tile"><div class="k">Qoldiq qiymati (tannarxda)</div><div class="v">${fmtMoney(r.totals.cost)}</div><div class="s">${r.rows.length} ta qator</div></div></div>` : ''}
      <div class="card table-wrap"><table><thead><tr><th>Joy</th><th>Mahsulot</th><th>Turi</th><th class="num">Miqdor</th><th class="num">Vazn, kg</th><th>Eng yaqin muddat</th>
        ${costs() ? '<th class="num">1 birlik</th><th class="num">Summa</th>' : ''}</tr></thead><tbody>
        ${r.rows.map((x) => `<tr data-lots="${holderValue(x.holder)}|${x.product_id}" style="cursor:pointer">
          <td>${esc(x.holder_name)}${x.holder.userId ? ' <span class="muted">(qo\'lida)</span>' : ''}</td><td>${esc(x.product)}</td><td class="muted">${esc(m.productKinds[x.kind] ?? x.kind)}</td>
          <td class="num" style="${x.qty < 0 ? 'color:var(--err)' : ''}">${fmtQty(x.qty)} ${esc(x.unit)}</td><td class="num">${x.weight_kg == null ? '' : fmtQty(x.weight_kg)}</td>
          <td>${x.nearest_expiry ? fmtDate(x.nearest_expiry).slice(0, 10) : ''}</td>
          ${costs() ? `<td class="num">${fmtMoney(x.unit_cost)}</td><td class="num">${fmtMoney(x.cost)}</td>` : ''}</tr>`).join('')
          || `<tr><td colspan="8" class="muted">Qoldiq yo'q. Boshlang'ich qoldiqni kiriting yoki Excel'dan import qiling.</td></tr>`}
      </tbody></table></div>`;
    $('#place', box).value = place;
    $('#place', box).onchange = (e) => setHash('stock', { tab: 'qoldiq', place: e.target.value, kind });
    $('#kind', box).onchange = (e) => setHash('stock', { tab: 'qoldiq', place, kind: e.target.value });
    $$('[data-new]', box).forEach((b) => { b.onclick = act(() => openDocForm(b.dataset.new, { preset: h ? { from: h, to: h } : {} })); });
    $$('[data-lots]', box).forEach((tr) => {
      tr.onclick = act(async () => {
        const [hv, pid] = tr.dataset.lots.split('|');
        const hh = parseHolderValue(hv);
        const lots = await erp('GET', `/stock/lots?${hh.warehouseId ? `warehouseId=${hh.warehouseId}` : `userId=${hh.userId}`}&productId=${pid}`);
        const dlg = $('#dlg');
        dlg.innerHTML = `<form method="dialog"><h2>Partiyalar — ${esc(tr.children[1].textContent)}</h2>
          <p class="muted" style="margin:0">${esc(tr.children[0].textContent)}. Chiqimda eng eski partiya birinchi ketadi (FIFO).</p>
          <div class="table-wrap"><table><thead><tr><th>Partiya</th><th>Kirgan</th><th>Yaroqlilik</th><th class="num">Miqdor</th>${costs() ? '<th class="num">1 birlik</th><th class="num">Summa</th>' : ''}</tr></thead><tbody>
          ${lots.map((l) => `<tr><td>${esc(l.number)}</td><td>${fmtDate(l.produced_at)}</td><td>${l.expires_at ? fmtDate(l.expires_at).slice(0, 10) : ''}</td><td class="num">${fmtQty(l.qty)}</td>
            ${costs() ? `<td class="num">${fmtMoney(l.unit_cost)}</td><td class="num">${fmtMoney(l.cost)}</td>` : ''}</tr>`).join('')}</tbody></table></div>
          <div class="actions">${can('stock.view_all') ? `<a class="btnlike" href="#stock?tab=karta&product=${pid}">Harakatlar tarixi</a>` : ''}<button value="cancel">Yopish</button></div></form>`;
        dlg.showModal();
      });
    });
  },

  async karta(box) {
    const p = hashParams();
    const pid = p.get('product');
    const rows = await erp('GET', `/stock/card?productId=${pid}`);
    box.innerHTML = `<div class="card table-wrap"><h2>Harakatlar tarixi</h2><table><thead><tr><th>Vaqt</th><th>Hujjat</th><th>Joy</th><th>Partiya</th><th class="num">Miqdor</th>${costs() ? '<th class="num">Summa</th>' : ''}</tr></thead><tbody>
      ${rows.map((x) => `<tr><td>${fmtDate(x.at)}</td><td><a href="#stock-doc?id=${x.doc_id}">${esc(x.doc)}</a> <span class="muted">${esc(x.doc_type)}</span></td><td>${esc(x.holder_name)}</td><td>${esc(x.lot ?? '—')}</td>
        <td class="num" style="color:${x.qty < 0 ? 'var(--err)' : 'var(--ok)'}">${x.qty > 0 ? '+' : ''}${fmtQty(x.qty)}</td>${costs() ? `<td class="num">${fmtMoney(x.cost)}</td>` : ''}</tr>`).join('') || '<tr><td colspan="6" class="muted">Harakat yo\'q</td></tr>'}
      </tbody></table></div>`;
  },

  async hujjat(box) {
    const p = hashParams();
    const m = await loadMeta();
    const f = { type: p.get('type') || '', status: p.get('status') || '', from: p.get('from') || addDays(todayLocal(), -30), to: p.get('to') || todayLocal() };
    const list = await erp('GET', `/docs?${new URLSearchParams(Object.entries(f).filter(([, v]) => v))}`);
    box.innerHTML = `
      <div class="row" style="margin-bottom:12px">
        <label>Turi<select id="type"><option value="">Hammasi</option>${optionsHtml(Object.entries(m.docTypes), f.type)}</select></label>
        <label>Holati<select id="status"><option value="">Hammasi</option>${optionsHtml(Object.entries(DOC_STATUS).map(([k, v]) => [k, v[0]]), f.status)}</select></label>
        <label>Dan<input type="date" id="from" value="${f.from}"></label><label>Gacha<input type="date" id="to" value="${f.to}"></label>
      </div>
      <div class="card table-wrap"><table><thead><tr><th>Raqam</th><th>Turi</th><th>Sana</th><th>Kimdan</th><th>Kimga</th><th>Holati</th><th class="num">Qator</th>${costs() ? '<th class="num">Summa</th>' : ''}<th>Kim</th></tr></thead><tbody>
      ${list.map((d) => `<tr><td><a href="#stock-doc?id=${d.id}">${esc(d.label)}</a></td><td>${esc(d.type_label)}</td><td>${fmtDate(d.doc_date)}</td>
        <td>${esc(d.from_name ?? '')}</td><td>${esc(d.to_name ?? '')}</td><td>${docBadge(d.status)}</td><td class="num">${d.lines}</td>
        ${costs() ? `<td class="num">${fmtMoney(d.total_cost)}</td>` : ''}<td class="muted">${esc(String(d.created_by ?? '').replace(/^user:/, ''))}</td></tr>`).join('') || '<tr><td colspan="9" class="muted">Hujjat yo\'q</td></tr>'}
      </tbody></table></div>`;
    const go = () => setHash('stock', { tab: 'hujjat', type: $('#type', box).value, status: $('#status', box).value, from: $('#from', box).value, to: $('#to', box).value });
    $$('select, input', box).forEach((el) => { el.onchange = go; });
  },

  async ombor(box) {
    const [list, m] = await Promise.all([erp('GET', '/warehouses'), loadMeta(true)]);
    const staff = m.staff;
    box.innerHTML = `
      <div class="row" style="margin-bottom:12px;justify-content:space-between">
        <label style="max-width:360px">Smenadan qabul qilingan sut qaysi omborga kiradi<select id="milkWh"><option value="">— avtomatik —</option>${optionsHtml(list.filter((w) => w.active).map((w) => [w.id, w.name]), m.milkWarehouseId)}</select></label>
        ${can('stock.manage') ? '<button id="newWh">+ Ombor</button>' : ''}
      </div>
      <div class="card table-wrap"><table><thead><tr><th>Nomi</th><th>Turi</th><th>Mas'ullar</th><th>Manfiy qoldiq</th><th>Ogohlantirish</th><th></th></tr></thead><tbody>
      ${list.map((w) => `<tr class="${w.active ? '' : 'voided'}"><td><b>${esc(w.name)}</b>${w.note ? `<div class="muted">${esc(w.note)}</div>` : ''}</td>
        <td>${esc(w.kind_label)}${w.is_stage ? ` <span class="muted">· ${esc(w.stage_type_label ?? '')}</span>` : ''}</td>
        <td>${w.keepers.map((k) => esc(k.name)).join(', ') || '<span class="muted">—</span>'}</td>
        <td>${w.allow_negative ? '<span class="warn">Ruxsat</span>' : 'Yo\'q'}</td><td>${w.warn_negative ? 'Ha' : 'Yo\'q'}</td>
        <td>${w.is_stage ? '<a href="#prod-stages">Bosqichlar →</a>' : can('stock.manage') ? `<button class="ghost small" data-edit="${w.id}">Tahrirlash</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Ombor yo\'q</td></tr>'}
      </tbody></table></div>
      <p class="muted">Manfiy qoldiq: mahsulot hali kirim bo'lmasdan berilishi mumkinmi. Ruxsat bo'lsa, keyingi kirim kamomadni yopadi; narx farqi "Tannarx farqi" xarajatiga yoziladi.</p>`;
    $('#milkWh', box).onchange = act(async (e) => { if (e.target.value) { await erp('PUT', '/settings/milk-warehouse', { warehouseId: Number(e.target.value) }); flash('Saqlandi'); } });
    const edit = (w = null) => {
      const dlg = $('#dlg');
      const keepers = new Set((w?.keepers ?? []).map((k) => k.id));
      dlg.innerHTML = `<form method="dialog"><h2>${w ? 'Omborni tahrirlash' : 'Yangi ombor'}</h2>
        <label>Nomi<input name="name" required value="${esc(w?.name ?? '')}"></label>
        <label>Turi<select name="kind">${optionsHtml(Object.entries(m.warehouseKinds), w?.kind ?? 'general')}</select></label>
        <label style="display:flex;gap:8px;color:var(--text)"><input type="checkbox" name="allowNegative" ${w?.allow_negative ? 'checked' : ''}> Manfiy qoldiqqa ruxsat (kirimdan oldin berish mumkin)</label>
        <label style="display:flex;gap:8px;color:var(--text)"><input type="checkbox" name="warnNegative" ${w == null || w.warn_negative ? 'checked' : ''}> Manfiyga tushganda ogohlantirish</label>
        <div><div class="muted" style="font-size:13px;margin-bottom:4px">Mas'ul xodimlar (qabul qiladi va beradi)</div>
          <div class="checks">${staff.map((u) => `<label><input type="checkbox" name="keeper" value="${u.id}" ${keepers.has(u.id) ? 'checked' : ''}> ${esc(u.name)}</label>`).join('')}</div></div>
        <label>Izoh<input name="note" value="${esc(w?.note ?? '')}"></label>
        ${w ? `<label style="display:flex;gap:8px;color:var(--text)"><input type="checkbox" name="active" ${w.active ? 'checked' : ''}> Faol</label>` : ''}
        <p class="err" id="dlgErr"></p>
        <div class="actions"><button type="button" class="ghost" value="cancel">Bekor</button><button value="ok">Saqlash</button></div></form>`;
      const form = $('form', dlg);
      $('button[value=cancel]', dlg).onclick = () => dlg.close();
      form.onsubmit = async (e) => {
        e.preventDefault();
        const f = form.elements;
        const body = { name: f.name.value, kind: f.kind.value, allowNegative: f.allowNegative.checked, warnNegative: f.warnNegative.checked, note: f.note.value,
          keepers: $$('input[name=keeper]:checked', form).map((x) => Number(x.value)) };
        if (w) body.active = f.active.checked;
        try { await (w ? erp('PATCH', `/warehouses/${w.id}`, body) : erp('POST', '/warehouses', body)); dlg.close(); erpMeta = null; route(); } catch (ex) { $('#dlgErr').textContent = ex.message; }
      };
      dlg.showModal();
    };
    $('#newWh', box)?.addEventListener('click', () => edit());
    $$('[data-edit]', box).forEach((b) => { b.onclick = () => edit(list.find((w) => w.id === Number(b.dataset.edit))); });
  },

  // "Ombor turlari": which product kinds live in which warehouse. One warehouse per
  // type; a product goes to its kind's warehouse (and moves when that changes).
  async turlar(box) {
    const [{ types, kinds }, whs] = await Promise.all([erp('GET', '/warehouse-types'), erp('GET', '/warehouses')]);
    const manage = can('stock.manage');
    const free = Object.keys(kinds).filter((k) => !types.some((t) => t.product_kinds.includes(k)));
    box.innerHTML = `
      <div class="row" style="margin-bottom:12px;justify-content:space-between">
        <p class="muted" style="margin:0;flex:1">Mahsulot ochilganda yoki turi o'zgartirilganda u o'z turidagi omborga tushadi (masalan "Etiketka" → Etiketka ombori).
          Har bir turga bitta ombor biriktiriladi. Tur ombori o'zgarsa, mahsulotlar qoldig'i shu zahoti yangi omborga o'tadi.</p>
        ${manage ? '<button id="newT">+ Ombor turi</button>' : ''}
      </div>
      <div class="card table-wrap"><table><thead><tr><th>Ombor turi</th><th>Mahsulot turlari</th><th>Ombori</th><th class="num">Mahsulotlar</th><th></th></tr></thead><tbody>
      ${types.map((t) => `<tr><td><b>${esc(t.name)}</b></td><td>${t.kind_labels.map((k) => `<span class="badge">${esc(k)}</span>`).join(' ') || '<span class="muted">—</span>'}</td>
        <td>${t.warehouse ? esc(t.warehouse) : '<span class="warn">biriktirilmagan — birinchi mahsulotda o\'zi yaratiladi</span>'}</td><td class="num">${t.products || ''}</td>
        <td>${manage ? `<button class="ghost small" data-edit="${t.id}">Tahrirlash</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Ombor turi yo\'q</td></tr>'}
      </tbody></table></div>
      ${free.length ? `<p class="warn">Hech bir turga biriktirilmagan mahsulot turlari: ${free.map((k) => esc(kinds[k])).join(', ')} — ular o'z omboriga tushmaydi.</p>` : ''}
      <p class="muted">"Yarim tayyor (quyma)" bosqichlarda turadi, shuning uchun bu ro'yxatda yo'q. Yig'uvchilar suti faqat Sut yig'ish bo'limida.</p>`;
    const edit = (t = null) => {
      const dlg = $('#dlg');
      const taken = (k) => types.find((x) => x.id !== t?.id && x.product_kinds.includes(k));
      const usedWh = (w) => types.find((x) => x.id !== t?.id && x.warehouse_id === w.id);
      dlg.innerHTML = `<form method="dialog"><h2>${t ? 'Ombor turini tahrirlash' : 'Yangi ombor turi'}</h2>
        <label>Nomi<input name="name" required value="${esc(t?.name ?? '')}" placeholder="masalan Etiketka ombori"></label>
        <div><div class="muted" style="font-size:13px;margin-bottom:4px">Qaysi mahsulot turlari shu omborga tushadi</div>
          <div class="checks">${Object.entries(kinds).map(([k, label]) => {
            const o = taken(k);
            return `<label title="${o ? esc(`Hozir: ${o.name}`) : ''}"><input type="checkbox" name="kind" value="${k}" ${t?.product_kinds.includes(k) ? 'checked' : ''}> ${esc(label)}${o ? ` <span class="muted">(${esc(o.name)})</span>` : ''}</label>`;
          }).join('')}</div>
          <p class="muted" style="margin:4px 0 0">Boshqa turdagi belgini tanlasangiz, avval o'sha turdan olib tashlang.</p></div>
        <label>Ombori<select name="warehouseId" data-plain><option value="">— tanlanmagan —</option><option value="new">+ Shu nomda yangi ombor yaratish</option>
          ${whs.filter((w) => w.active).map((w) => { const u = usedWh(w); return `<option value="${w.id}" ${w.id === t?.warehouse_id ? 'selected' : ''} ${u ? 'disabled' : ''}>${esc(w.name)}${w.is_stage ? ' (bosqich)' : ''}${u ? ` — ${esc(u.name)}` : ''}</option>`; }).join('')}</select></label>
        <p class="err" id="dlgErr"></p>
        <div class="actions">${t ? '<button type="button" class="ghost danger" id="delT">O\'chirish</button>' : ''}<button type="button" class="ghost" value="cancel">Bekor</button><button value="ok">Saqlash</button></div></form>`;
      const form = $('form', dlg);
      $('button[value=cancel]', dlg).onclick = () => dlg.close();
      $('#delT', dlg)?.addEventListener('click', async () => {
        if (!confirm(`"${t.name}" turi o'chirilsinmi? (Ombor o'zi qoladi.)`)) return;
        try { await erp('DELETE', `/warehouse-types/${t.id}`); dlg.close(); route(); } catch (ex) { $('#dlgErr').textContent = ex.message; }
      });
      form.onsubmit = async (e) => {
        e.preventDefault();
        const f = form.elements;
        const body = { name: f.name.value, productKinds: $$('input[name=kind]:checked', form).map((x) => x.value), warehouseId: f.warehouseId.value || null };
        try {
          const r = await (t ? erp('PATCH', `/warehouse-types/${t.id}`, body) : erp('POST', '/warehouse-types', body));
          dlg.close();
          erpMeta = null;
          flash(r.moved ? `Saqlandi. ${r.moved} ta hujjat bilan qoldiqlar yangi omborga o'tdi.` : 'Saqlandi');
          route();
        } catch (ex) { $('#dlgErr').textContent = ex.message; }
      };
      dlg.showModal();
    };
    $('#newT', box)?.addEventListener('click', () => edit());
    $$('[data-edit]', box).forEach((b) => { b.onclick = () => edit(types.find((x) => x.id === Number(b.dataset.edit))); });
  },

  async mahsulot(box) {
    const p = hashParams();
    const kind = p.get('kind') || '';
    const [list, m, wt] = await Promise.all([erp('GET', `/products?active=all${kind ? `&kind=${kind}` : ''}`), loadMeta(), erp('GET', '/warehouse-types')]);
    // where each product kind goes (Ombor turlari)
    const homeOf = (k) => { const t = wt.types.find((x) => x.product_kinds.includes(k)); return t ? (t.warehouse ?? t.name) : null; };
    box.innerHTML = `
      <div class="row" style="margin-bottom:12px;justify-content:space-between">
        <label style="max-width:280px">Turi<select id="kind"><option value="">Hammasi</option>${optionsHtml(Object.entries(m.productKinds), kind)}</select></label>
        <div class="row" style="flex:none">${can('catalog.manage') ? '<button class="ghost" id="impP">⬆ Excel\'dan import</button><button id="newP">+ Mahsulot</button>' : ''}</div>
      </div>
      <div class="card table-wrap"><table><thead><tr><th>Nomi</th><th>Turi</th><th>Ombori</th><th>Birlik</th><th class="num">Netto, g</th><th class="num">Brutto, g</th><th>Hajm</th><th>Shakl</th><th class="num">Yaroqlilik, soat</th><th>Variantlar</th><th></th></tr></thead><tbody>
      ${list.filter((x) => !x.parent_id).map((x) => `<tr class="${x.active ? '' : 'voided'}"><td><b>${esc(x.name)}</b>${x.sku ? ` <span class="muted">${esc(x.sku)}</span>` : ''}</td><td>${esc(x.kind_label)}</td><td class="muted">${esc(homeOf(x.kind) ?? (x.kind === 'semi' ? 'bosqichda' : '—'))}</td><td>${esc(x.unit)}</td>
        <td class="num">${x.netto_g ?? ''}</td><td class="num">${x.brutto_g ?? ''}</td><td>${x.volume != null ? `${fmtNum(x.volume, 4)} ${esc(x.volume_unit ?? '')}` : ''}</td>
        <td>${esc(m.shapes[x.shape] ?? '')}</td><td class="num">${x.shelf_life_hours ?? ''}</td>
        <td>${x.has_variants ? list.filter((c) => c.parent_id === x.id).map((c) => `<span class="badge">${esc(c.variant)}</span>`).join(' ') : ''}${x.for_sale ? ' <span class="badge sent" title="Kg hisobida ham sotiladi">sotuvda</span>' : ''}${x.as_raw ? ' <span class="badge" title="Xomashyo sifatida ham ishlatiladi">xomashyo</span>' : ''}${x.kind === 'finished' && can('prod.manage') ? ` <button class="ghost small" data-tex="${x.id}">Tex karta</button>` : ''}</td>
        <td>${can('catalog.manage') && x.kind !== 'milk' ? `<button class="ghost small" data-edit="${x.id}">Tahrirlash</button> <button class="ghost small danger" data-del="${x.id}" title="Butunlay o'chirish (omborda qoldig'i bo'lmasa)">🗑</button>` : x.kind === 'milk' ? '<span class="muted" title="Sut yig\'ish bo\'limida tahrirlanadi">Sut yig\'ish</span>' : ''}</td></tr>`).join('') || '<tr><td colspan="11" class="muted">Mahsulot yo\'q</td></tr>'}
      </tbody></table></div>
      <p class="muted">Sut yig'uvchilar olib keladigan sut (Yog'li / Yog'siz sut) bu yerda va tarkib, ishlab chiqarish, hujjatlarda ko'rinmaydi —
      u faqat Sut yig'ish bo'limida (xonadonlar, hisobotlar). Qabul qilingan sut omborga ("Sut ombori") bitta "Yog'li sut" bo'lib kiradi — u "Asosiy xomashyo".</p>`;
    $('#kind', box).onchange = (e) => setHash('stock', { tab: 'mahsulot', kind: e.target.value });
    const kinds = Object.entries(m.productKinds).filter(([k]) => k !== 'milk');
    const edit = (x = null) => openForm({
      title: x ? 'Mahsulotni tahrirlash' : 'Yangi mahsulot',
      fields: [
        { name: 'name', label: 'Nomi', value: x?.name, required: true },
        { name: 'kind', label: 'Turi', type: 'select', options: kinds, value: x?.kind ?? 'finished' },
        { name: 'unit', label: 'O\'lchov birligi', type: 'select', options: m.units.map((u) => [u.short || u.name, u.name]), value: x?.unit ?? 'dona' },
        { name: 'netto_g', label: 'Netto vazn, g (1 birlik)', type: 'number', step: '0.001', min: 0, value: x?.netto_g, hint: 'Masalan 400 g qatiq uchun 400. Hisobotlarda umumiy vazn shundan hisoblanadi.' },
        { name: 'brutto_g', label: 'Brutto vazn, g (idish bilan)', type: 'number', step: '0.001', min: 0, value: x?.brutto_g },
        { name: 'volume', label: 'Hajm (1 birlik)', type: 'number', step: '0.000001', min: 0, value: x?.volume },
        { name: 'volume_unit', label: 'Hajm birligi', type: 'select', options: [['', '—'], ['m3', 'm³'], ['m2', 'm²'], ['l', 'litr']], value: x?.volume_unit ?? '' },
        { name: 'shape', label: 'Shakl', type: 'select', options: [['', '—'], ...Object.entries(m.shapes)], value: x?.shape ?? '' },
        { name: 'shelf_life_hours', label: 'Yaroqlilik muddati, soat', type: 'number', min: 0, value: x?.shelf_life_hours, hint: 'Kirimda partiya muddati shundan avtomatik qo\'yiladi (masalan 7 kun = 168).' },
        ...(x ? (x.has_variants ? [{ name: 'addVariants', label: "Yangi variant qo'shish (vergul bilan)", hint: `Hozir: ${list.filter((c) => c.parent_id === x.id).map((c) => c.variant).join(', ')}` }] : [])
          : [{ name: 'hasVariants', label: 'Variantli mahsulot (masalan Zakvaska: 499, 505) — keyin o\'zgartirib bo\'lmaydi', type: 'checkbox', value: false },
            { name: 'variants', label: 'Variantlar (vergul bilan)', hint: 'Har bir variant alohida mahsulot: "Zakvaska / 499" — o\'z qoldig\'i va tannarxi bilan.' }]),
        { name: 'sku', label: 'Artikul', value: x?.sku }, { name: 'barcode', label: 'Shtrix-kod', value: x?.barcode },
        { name: 'category', label: 'Turkum', value: x?.category },
        { name: 'forSale', label: 'Sotuv uchun mavjud — idishga quyilmagan holda kg hisobida ham sotiladi (yarim tayyor / tayyor)', type: 'checkbox', value: !!x?.for_sale },
        { name: 'asRaw', label: 'Xomashyo — tayyor / yarim tayyor mahsulot boshqa ishlab chiqarishda xomashyo sifatida ham ishlatiladi', type: 'checkbox', value: !!x?.as_raw },
        ...(x ? [{ name: 'active', label: 'Faol', type: 'checkbox', value: !!x.active }] : []),
      ],
      onSubmit: async (d) => {
        const body = { ...d };
        for (const k of ['netto_g', 'brutto_g', 'volume', 'shelf_life_hours']) body[k] = d[k] === '' ? null : Number(d[k]);
        delete body.addVariants;
        if (!x && !body.hasVariants) delete body.variants;
        await (x ? erp('PATCH', `/products/${x.id}`, body) : erp('POST', '/products', body));
        if (x && d.addVariants) await erp('POST', `/products/${x.id}/variants`, { variants: d.addVariants });
      },
    });
    // under "Turi": which warehouse the product will go to
    const withHint = (x) => {
      edit(x);
      const sel = $('#dlg select[name=kind]');
      if (!sel) return;
      const hint = document.createElement('span');
      hint.className = 'muted';
      const show = () => { const h = homeOf(sel.value); hint.textContent = h ? `→ Ombori: ${h}` : sel.value === 'semi' ? '→ bosqichlarda turadi' : "→ hech bir ombor turiga biriktirilmagan (Ombor turlari)"; };
      sel.closest('label').append(hint);
      sel.addEventListener('change', show);
      show();
    };
    $('#newP', box)?.addEventListener('click', () => withHint());
    $('#impP', box)?.addEventListener('click', () => setHash('stock', { tab: 'import' }));
    $$('[data-tex]', box).forEach((b) => { b.onclick = act(() => texCard(Number(b.dataset.tex))); });
    $$('[data-edit]', box).forEach((b) => { b.onclick = () => withHint(list.find((x) => x.id === Number(b.dataset.edit))); });
    // Delete for good: the server refuses (and says why) while there is stock,
    // history or a recipe that uses it.
    $$('[data-del]', box).forEach((b) => { b.onclick = act(async () => {
      const x = list.find((y) => y.id === Number(b.dataset.del));
      const vars = list.filter((c) => c.parent_id === x.id).length;
      if (!confirm(`"${x.name}"${vars ? ` va uning ${vars} ta varianti` : ''} butunlay o'chirilsinmi? Qaytarib bo'lmaydi.`)) return;
      await erp('DELETE', `/products/${x.id}`);
      flash(`"${x.name}" o'chirildi`);
      route();
    }); });
  },

  async ogoh(box) {
    const all = hashParams().get('all') === '1';
    const list = await erp('GET', `/alerts${all ? '?all=1' : ''}`);
    box.innerHTML = `<div class="row" style="margin-bottom:12px"><label style="display:flex;gap:8px;color:var(--text);flex:none"><input type="checkbox" id="all" ${all ? 'checked' : ''}> Yopilganlarini ham ko'rsatish</label></div>
      <div class="card table-wrap"><table><thead><tr><th>Vaqt</th><th>Xabar</th><th>Hujjat</th><th></th></tr></thead><tbody>
      ${list.map((a) => `<tr class="${a.resolved_at ? 'voided' : ''}"><td>${fmtDate(a.created_at)}</td><td>${esc(a.text)}</td><td>${a.doc_id ? `<a href="#stock-doc?id=${a.doc_id}">ochish</a>` : ''}</td>
        <td>${a.resolved_at ? `<span class="muted">${esc(String(a.resolved_by ?? '').replace(/^user:/, ''))}</span>` : `<button class="ghost small" data-res="${a.id}">Ko'rildi</button>`}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Ogohlantirish yo\'q</td></tr>'}
      </tbody></table></div>`;
    $('#all', box).onchange = (e) => setHash('stock', { tab: 'ogoh', all: e.target.checked ? '1' : '' });
    $$('[data-res]', box).forEach((b) => { b.onclick = act(async () => { await erp('POST', `/alerts/${b.dataset.res}/resolve`); route(); }); });
  },

  async sozlama(box) {
    const [reasons, units, cats] = await Promise.all([erp('GET', '/reasons?section=warehouse'), erp('GET', '/units'), costs() ? erp('GET', '/pnl-categories') : Promise.resolve([])]);
    const manage = can('stock.manage');
    box.innerHTML = `<div class="grid2">
      <div class="card"><h2>Hisobdan chiqarish sabablari</h2>
        <p class="muted">"Xodim hisobiga" sabab tanlansa, mahsulot tannarxi xodim qarziga yoziladi (oylikdan ushlanadi). Aks holda — tanlangan xarajat moddasiga.</p>
        <table><tbody>${reasons.map((r) => `<tr class="${r.active ? '' : 'voided'}"><td>${esc(r.name)}</td><td class="muted">${r.charge === 'staff' ? 'Xodim hisobiga' : esc(r.category ?? 'Kompaniya')}</td>
          <td>${manage ? `<button class="ghost small" data-reason="${r.id}">Tahrirlash</button>` : ''}</td></tr>`).join('')}</tbody></table>
        ${manage ? '<button class="small" id="newReason" style="margin-top:8px">+ Sabab</button>' : ''}</div>
      <div class="card"><h2>O'lchov birliklari</h2>
        <table><tbody>${units.map((u) => `<tr class="${u.active ? '' : 'voided'}"><td>${esc(u.name)}</td><td class="muted">${esc(u.short ?? '')}</td><td class="muted">${u.decimals} xona</td>
          <td>${can('catalog.manage') ? `<button class="ghost small" data-unit="${u.id}">Tahrirlash</button>` : ''}</td></tr>`).join('')}</tbody></table>
        ${can('catalog.manage') ? '<button class="small" id="newUnit" style="margin-top:8px">+ Birlik</button>' : ''}</div>
      ${costs() ? `<div class="card"><h2>Daromad va xarajat moddalari</h2>
        <p class="muted">Tizim moddalari o'chirilmaydi, faqat nomi o'zgartiriladi (masalan "Qayta ishlashda yo'qotilgan tannarx").</p>
        <table><tbody>${cats.map((c) => `<tr class="${c.active === 0 ? 'voided' : ''}"><td>${esc(c.name)}</td><td class="muted">${c.kind === 'income' ? 'Daromad' : 'Xarajat'}${c.system ? ' · tizim' : ''}</td>
          <td>${manage ? `<button class="ghost small" data-cat="${c.id}">Tahrirlash</button>` : ''}</td></tr>`).join('')}</tbody></table>
        ${manage ? '<button class="small" id="newCat" style="margin-top:8px">+ Modda</button>' : ''}</div>` : ''}
    </div>`;
    const catOpts = cats.filter((c) => c.kind === 'expense').map((c) => [c.id, c.name]);
    const reasonForm2 = (r = null) => openForm({
      title: r ? 'Sababni tahrirlash' : 'Yangi sabab',
      fields: [
        { name: 'name', label: 'Nomi', value: r?.name, required: true },
        { name: 'charge', label: 'Kim hisobiga', type: 'select', options: [['company', 'Kompaniya (xarajat)'], ['staff', 'Xodim hisobiga']], value: r?.charge ?? 'company' },
        ...(catOpts.length ? [{ name: 'categoryId', label: 'Xarajat moddasi', type: 'select', options: catOpts, value: r?.category_id }] : []),
        ...(r ? [{ name: 'active', label: 'Faol', type: 'checkbox', value: !!r.active }] : []),
      ],
      onSubmit: (d) => (r ? erp('PATCH', `/reasons/${r.id}`, d) : erp('POST', '/reasons', d)),
    });
    $('#newReason', box)?.addEventListener('click', () => reasonForm2());
    $$('[data-reason]', box).forEach((b) => { b.onclick = () => reasonForm2(reasons.find((x) => x.id === Number(b.dataset.reason))); });
    const unitForm = (u = null) => openForm({
      title: u ? 'Birlikni tahrirlash' : 'Yangi birlik',
      fields: [{ name: 'name', label: 'Nomi', value: u?.name, required: true }, { name: 'short', label: 'Qisqa', value: u?.short },
        { name: 'decimals', label: 'Kasr xonalari (0–3)', type: 'number', min: 0, value: u?.decimals ?? 3 },
        ...(u ? [{ name: 'active', label: 'Faol', type: 'checkbox', value: !!u.active }] : [])],
      onSubmit: (d) => (u ? erp('PATCH', `/units/${u.id}`, d) : erp('POST', '/units', d)),
    });
    $('#newUnit', box)?.addEventListener('click', () => unitForm());
    $$('[data-unit]', box).forEach((b) => { b.onclick = () => unitForm(units.find((x) => x.id === Number(b.dataset.unit))); });
    const catForm = (c = null) => openForm({
      title: c ? 'Moddani tahrirlash' : 'Yangi modda',
      fields: [{ name: 'name', label: 'Nomi', value: c?.name, required: true },
        ...(c ? [] : [{ name: 'kind', label: 'Turi', type: 'select', options: [['expense', 'Xarajat'], ['income', 'Daromad']] }])],
      onSubmit: (d) => (c ? erp('PATCH', `/pnl-categories/${c.id}`, d) : erp('POST', '/pnl-categories', d)),
    });
    $('#newCat', box)?.addEventListener('click', () => catForm());
    $$('[data-cat]', box).forEach((b) => { b.onclick = () => catForm(cats.find((x) => x.id === Number(b.dataset.cat))); });
  },

  async import(box) {
    const kinds = [['products', 'Mahsulotlar (nomenklatura)', 'catalog.manage'], ['opening', 'Boshlang\'ich qoldiqlar', 'stock.opening']].filter((k) => can(k[2]));
    box.innerHTML = kinds.map(([k, t]) => `<div class="card" data-kind="${k}"><h2>${t}</h2>
      <p class="muted">1) Shablonni yuklab oling va to'ldiring. 2) Faylni tanlang — avval tekshiruv natijasi ko'rsatiladi. 3) Xato bo'lmasa "Import qilish".</p>
      <div class="row"><button class="ghost" data-tpl>Shablonni yuklab olish</button><input type="file" accept=".xlsx" data-file><button data-check>Tekshirish</button><button data-run hidden>Import qilish</button></div>
      <div data-out style="margin-top:12px"></div></div>`).join('') || '<p class="muted">Ruxsat yo\'q</p>';
    $$('[data-kind]', box).forEach((card) => {
      const kind = card.dataset.kind;
      let file = null;
      $('[data-tpl]', card).onclick = act(async () => {
        const res = await request('GET', `/api/erp/import/${kind}/template.xlsx`);
        if (!res.ok) throw new Error('Yuklab bo\'lmadi');
        const url = URL.createObjectURL(await res.blob());
        Object.assign(document.createElement('a'), { href: url, download: `${kind === 'products' ? 'mahsulotlar' : 'boshlangich-qoldiq'}-shablon.xlsx` }).click();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
      });
      const send = async (dryRun) => {
        if (!file) throw new Error('Faylni tanlang');
        return erp('POST', `/import/${kind}`, { file: await fileToBase64(file), dryRun });
      };
      const out = $('[data-out]', card); const run = $('[data-run]', card);
      $('[data-file]', card).onchange = (e) => { file = e.target.files[0]; run.hidden = true; out.innerHTML = ''; };
      $('[data-check]', card).onclick = act(async () => {
        const r = await send(true);
        const s = r.summary;
        out.innerHTML = `<p>${kind === 'products' ? `Qatorlar: ${s.rows} · yangi: ${s.create} · yangilanadi: ${s.update}` : `Qatorlar: ${s.rows} · omborlar: ${s.warehouses}`} · xato: <b class="${s.errors ? 'err' : ''}">${s.errors}</b></p>
          ${r.errors.length ? `<table><tbody>${r.errors.map((e) => `<tr><td>${e.row}-qator</td><td class="err">${esc(e.error)}</td></tr>`).join('')}</tbody></table>` : ''}`;
        run.hidden = !r.ok;
      });
      run.onclick = act(async () => {
        const r = await send(false);
        flash(kind === 'products' ? `Import tugadi: ${r.summary.create} ta yangi, ${r.summary.update} ta yangilandi` : `Import tugadi: ${r.docs?.length ?? 0} ta hujjat`);
        run.hidden = true; out.innerHTML = '';
        erpMeta = null;
      });
    });
  },
};

// ------------------------------------------------------------------ pages
views.stock = async (v) => {
  const tab = hashParams().get('tab') || 'qoldiq';
  v.innerHTML = `${tabsHtml(tab === 'karta' ? 'qoldiq' : tab)}<div id="stockBox"><p class="muted">Yuklanmoqda...</p></div>`;
  $$('[data-tab]', v).forEach((b) => { b.onclick = () => setHash('stock', { tab: b.dataset.tab }); });
  await (stockTabs[tab] ?? stockTabs.qoldiq)($('#stockBox', v));
};

views['stock-doc'] = async (v) => {
  const id = Number(hashParams().get('id'));
  const d = await erp('GET', `/docs/${id}`);
  const inv = d.type === 'inventory';
  const isMine = d.created_by === `user:${me.login}`;
  const actions = [];
  if (d.status === 'draft' && inv) actions.push('<button data-a="edit" class="ghost">Sanoqni tahrirlash</button>', '<button data-a="post">Farqlarni ko\'rish va o\'tkazish</button>');
  else if (d.status === 'draft') actions.push('<button data-a="postplain">O\'tkazish</button>');
  if (d.status === 'sent') actions.push('<button data-a="accept">Qabul qilish</button>', '<button data-a="reject" class="ghost">Rad etish</button>');
  if (['draft', 'sent', 'posted'].includes(d.status) && d.source !== 'shift' && (can('stock.cancel') || (isMine && d.status !== 'posted'))) actions.push('<button data-a="cancel" class="danger">Bekor qilish</button>');
  const showBook = inv && d.status !== 'draft';
  v.innerHTML = `<p><a href="#stock?tab=hujjat">← Hujjatlar</a></p>
    <div class="card"><div class="row" style="justify-content:space-between;align-items:center"><h2 style="margin:0">${esc(d.type_label)} ${esc(d.label)} ${docBadge(d.status)}</h2><div class="row">${actions.join('')}</div></div>
      <div class="grid2" style="margin:12px 0 0">
        <div><div class="muted">Sana</div>${fmtDate(d.doc_date)}</div>
        ${d.from_name ? `<div><div class="muted">Kimdan</div>${esc(d.from_name)}</div>` : ''}
        ${d.to_name ? `<div><div class="muted">${inv ? 'Ombor' : 'Kimga'}</div>${esc(d.to_name)}</div>` : ''}
        ${inv ? `<div><div class="muted">Turi</div>${d.mode === 'full' ? 'To\'liq' : 'Qisman'}</div>` : ''}
        ${d.reason ? `<div><div class="muted">Sabab</div>${esc(d.reason)}</div>` : ''}
        ${d.charge_user_name ? `<div><div class="muted">Xodim hisobiga</div>${esc(d.charge_user_name)}</div>` : ''}
        <div><div class="muted">Yaratdi</div>${esc(String(d.created_by ?? '').replace(/^user:/, ''))} · ${fmtDate(d.created_at)}</div>
        ${d.posted_at ? `<div><div class="muted">O'tkazdi</div>${esc(String(d.posted_by ?? '').replace(/^user:/, ''))} · ${fmtDate(d.posted_at)}</div>` : ''}
        ${d.reject_reason ? `<div><div class="muted">Rad etish sababi</div>${esc(d.reject_reason)}</div>` : ''}
        ${d.cancel_reason ? `<div><div class="muted">Bekor qilish sababi</div>${esc(d.cancel_reason)} · ${fmtDate(d.cancelled_at)}</div>` : ''}
        ${d.note ? `<div><div class="muted">Izoh</div>${esc(d.note)}</div>` : ''}
      </div></div>
    ${d.charges?.length ? `<div class="card"><h2>Kamomad xodimlar hisobiga</h2><table><tbody>${d.charges.map((c) => `<tr><td>${esc(c.name)}</td>${costs() ? `<td class="num">${fmtMoney(c.amount)}</td>` : ''}</tr>`).join('')}</tbody></table></div>` : ''}
    <div class="card table-wrap"><table><thead><tr><th>Mahsulot</th>${showBook ? '<th class="num">Hisobda</th><th class="num">Sanalgan</th><th class="num">Farq</th>' : '<th class="num">Miqdor</th>'}
      ${costs() ? '<th class="num">Summa</th>' : ''}</tr></thead><tbody>
      ${d.lines.map((l) => `<tr><td>${esc(l.product)}</td>${showBook ? `<td class="num">${fmtQty(l.book)}</td><td class="num">${fmtQty(l.qty)}</td>
        <td class="num" style="color:${(l.diff ?? 0) < 0 ? 'var(--err)' : (l.diff ?? 0) > 0 ? 'var(--ok)' : 'inherit'}">${(l.diff ?? 0) > 0 ? '+' : ''}${fmtQty(l.diff)}</td>` : `<td class="num">${fmtQty(l.qty)} ${esc(l.unit)}</td>`}
        ${costs() ? `<td class="num">${fmtMoney(l.cost)}</td>` : ''}</tr>`).join('')}
      ${costs() ? `<tr><td colspan="${showBook ? 4 : 2}"><b>Jami</b></td><td class="num"><b>${fmtMoney(d.total_cost)}</b></td></tr>` : ''}
    </tbody></table></div>`;
  const a = (name, fn) => { const b = $(`[data-a=${name}]`, v); if (b) b.onclick = act(fn); };
  a('edit', () => openDocForm('inventory', { doc: d }));
  a('post', () => inventoryPost(d.id));
  a('postplain', async () => { await erp('POST', `/docs/${d.id}/post`, {}); flash('O\'tkazildi'); route(); });
  a('accept', async () => { await erp('POST', `/docs/${d.id}/accept`, {}); flash('Qabul qilindi'); route(); });
  a('reject', () => openForm({ title: 'Topshirishni rad etish', fields: [{ name: 'reason', label: 'Sabab', required: true }], submit: 'Rad etish',
    onSubmit: (x) => erp('POST', `/docs/${d.id}/reject`, x) }));
  a('cancel', () => openForm({ title: `${d.label} ni bekor qilish`, danger: true, submit: 'Bekor qilish',
    intro: d.status === 'posted' ? '<p class="muted">Hujjat to\'liq teskari yoziladi: qoldiq, xodim qarzi va xarajatlar qaytadi. Mahsulot allaqachon boshqa joyga ketgan bo\'lsa, bekor qilib bo\'lmaydi.</p>' : '',
    fields: [{ name: 'reason', label: 'Sabab', required: true }], onSubmit: (x) => erp('POST', `/docs/${d.id}/cancel`, x) }));
};

// Register the page (before "Mahsulotlar" of milk collection) and its detail route.
PAGES.push(['stock', 'Ombor', 'stock.view_all', 'stock']);
PAGE_PARENT['stock-doc'] = 'stock';
if (me) show();
