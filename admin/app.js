'use strict';

// Yaya web panel — the administrator's desk. Everyday work for all staff
// happens in the mobile app; the panel adds setup, people, devices, data.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtNum = (n, d = 2) => (n == null ? '—' : Number(n).toLocaleString('uz-UZ', { maximumFractionDigits: d }).replace(/,/g, ' '));
const fmtMoney = (n) => (n == null ? '—' : fmtNum(Math.round(n), 0));
// Server stores UTC; show Tashkent time (UTC+5, no DST).
const fmtDate = (s) => {
  if (!s) return '';
  const d = new Date(/Z$|[+-]\d\d:\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z');
  return new Date(d.getTime() + 5 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
};
const todayLocal = () => new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);
const addDays = (day, n) => new Date(Date.parse(day) + n * 864e5).toISOString().slice(0, 10);
const dayLabel = (day) => `${day.slice(8, 10)}.${day.slice(5, 7)}`;
const digits = (s) => String(s ?? '').replace(/\D/g, '');
const METHOD = { cash: 'Naqd', card: 'Karta', transfer: 'O\'tkazma' };
const SHIFT_STATUS = { open: ['Ochiq', 'pending'], editing: ['Tahrir', 'pending'], closed: ['Qabul kutmoqda', 'pending'], accepted: ['Qabul qilingan', 'sent'], cancelled: ['Bekor qilingan', 'error'] };
const cancelOn = () => brand.cancelEnabled !== false;

let token = null;
let me = null;
let brand = { companyName: '', logoUrl: null };
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* ignore */ } },
};
token = store.get('yaya_token');
// Each browser is a "device" that must fit into one of the admin's device slots.
let deviceId = store.get('yaya_device');
if (!deviceId) {
  deviceId = (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).replace(/[^\w-]/g, '');
  store.set('yaya_device', deviceId);
}
const can = (perm) => !!me?.permissions.includes(perm);
const money = () => can('prices.view');
// Confirm an action only when its prompt is enabled in settings.
const confirmFor = (action, message) => (brand.confirms || {})[action] === false || confirm(message);

async function request(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Internet yo\'q yoki server javob bermadi');
  }
  if (res.status === 401 && !url.endsWith('/login')) { logout(); throw new Error('Sessiya tugadi, qayta kiring'); }
  return res;
}
async function api(method, path, body, base = '/api/admin') {
  const res = await request(method, base + path, body);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const err = new Error(data.error || 'Xatolik: ' + res.status); err.status = res.status; err.data = data; throw err; }
  return data;
}
// File downloads need the auth header, so fetch them instead of following a link.
async function download(method, path, filename, body) {
  const res = await request(method, '/api/admin' + path, body);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Yuklab bo\'lmadi');
  const url = URL.createObjectURL(await res.blob());
  Object.assign(document.createElement('a'), { href: url, download: filename }).click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const fileToBase64 = (f) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });

function flash(msg, kind = 'ok') {
  const el = $('#flash');
  el.textContent = msg;
  el.className = kind;
  el.hidden = false;
  clearTimeout(flash.t);
  flash.t = setTimeout(() => { el.hidden = true; }, kind === 'err' ? 9000 : 3500);
}
// Wraps an async action so any error is shown instead of silently lost.
const act = (fn) => async (...args) => { try { await fn(...args); } catch (e) { flash(e.message, 'err'); } };

// Generic dialog form. fields: [{name,label,type,value,options:[[v,t]],required,hint}]
function openForm({ title, fields, submit = 'Saqlash', onSubmit, intro = '', danger = false }) {
  const dlg = $('#dlg');
  dlg.innerHTML = `<form method="dialog">
    <h2>${esc(title)}</h2>${intro}
    ${fields.map((f) => {
      if (f.type === 'checkbox') return `<label style="display:flex;gap:8px;align-items:center;color:var(--text)"><input type="checkbox" name="${f.name}" ${f.value ? 'checked' : ''}> ${esc(f.label)}</label>`;
      if (f.type === 'select') return `<label>${esc(f.label)}<select name="${f.name}" ${f.required ? 'required' : ''}>${f.options.map(([v, t]) => `<option value="${esc(v)}" ${String(v) === String(f.value ?? '') ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;
      return `<label>${esc(f.label)}<input name="${f.name}" type="${f.type || 'text'}" value="${esc(f.value ?? '')}" ${f.required ? 'required' : ''}
        ${f.pattern ? `pattern="${f.pattern}"` : ''} ${f.inputmode ? `inputmode="${f.inputmode}"` : ''} ${f.step ? `step="${f.step}"` : ''} ${f.min != null ? `min="${f.min}"` : ''} placeholder="${esc(f.placeholder ?? '')}" autocomplete="${f.type === 'password' ? 'new-password' : 'off'}">
        ${f.hint ? `<span class="muted">${esc(f.hint)}</span>` : ''}</label>`;
    }).join('')}
    <p class="err" id="dlgErr"></p>
    <div class="actions"><button type="button" class="ghost" value="cancel">Bekor</button><button value="ok" ${danger ? 'class="danger"' : ''}>${esc(submit)}</button></div>
  </form>`;
  const form = $('form', dlg);
  $('button[value=cancel]', dlg).onclick = () => dlg.close();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const data = {};
    for (const f of fields) {
      const input = form.elements[f.name];
      data[f.name] = f.type === 'checkbox' ? input.checked : input.value;
    }
    try {
      await onSubmit(data);
      dlg.close();
      route();
    } catch (err) {
      $('#dlgErr').textContent = err.message;
    }
  };
  dlg.showModal();
  $('input, select', dlg)?.focus();
}

// Full-screen map picker (shared map.html in an iframe). Resolves to
// {lat, lng, address} when saved, or null when cancelled.
function openMap({ lat, lng, name, address }) {
  return new Promise((resolve) => {
    const dlg = $('#dlg');
    const q = new URLSearchParams();
    if (lat != null) q.set('lat', lat);
    if (lng != null) q.set('lng', lng);
    if (name) q.set('name', name);
    if (address) q.set('address', address);
    dlg.innerHTML = `<div style="width:min(92vw,720px);height:80vh;display:flex;flex-direction:column">
      <iframe src="map.html?${q.toString()}" style="flex:1;border:0;border-radius:12px" title="Xarita"></iframe></div>`;
    const onMsg = (e) => {
      if (e.origin !== location.origin || !e.data?.yayaMap) return;
      window.removeEventListener('message', onMsg);
      dlg.close();
      resolve(e.data.yayaMap.ok ? e.data.yayaMap : null);
    };
    window.addEventListener('message', onMsg);
    dlg.addEventListener('close', () => window.removeEventListener('message', onMsg), { once: true });
    dlg.showModal();
  });
}

// Balance editing is opened with the admin's own password, then kept in memory
// for the editor page's save.
let BALANCE_PW = '';
function openBalanceEditor() {
  openForm({
    title: 'Balanslarni tahrirlash',
    intro: '<p class="muted">Bu bo\'lim admin paroli bilan ochiladi.</p>',
    fields: [{ name: 'password', label: 'Admin parolingiz', type: 'password', required: true }],
    submit: 'Ochish',
    onSubmit: async (d) => {
      // Verify by a no-op edit: wrong password errors, correct one reports "no items".
      const res = await request('POST', '/api/admin/balances/edit', { password: d.password, items: [] });
      const data = await res.json().catch(() => ({}));
      if (/parol/i.test(data.error || '')) throw new Error('Parol noto\'g\'ri');
      BALANCE_PW = d.password;
      location.hash = 'balance-edit';
    },
  });
}

async function paymentForm(supplier, balance) {
  // The money leaves a cashbox (Moliya). Without finance rights the server picks: own, else main.
  let boxes = [];
  if (can('finance.view') || can('finance.cash')) {
    try { boxes = (await api('GET', '/cashboxes', null, '/api/erp/finance')).filter((c) => c.active); } catch { boxes = []; }
  }
  openForm({
    title: `To'lov: ${supplier.name}`,
    intro: balance != null ? `<p class="muted">Joriy qarzimiz: <b>${fmtMoney(balance)}</b> so'm</p>` : '',
    fields: [
      { name: 'amount', label: 'Summa (so\'m)', type: 'number', min: 1, step: 1, required: true, value: balance > 0 ? Math.round(balance) : '' },
      { name: 'method', label: 'Usul', type: 'select', options: Object.entries(METHOD), value: 'cash' },
      ...(boxes.length ? [{ name: 'cashboxId', label: 'Qaysi kassadan', type: 'select', options: boxes.map((c) => [c.id, `${c.name} (${fmtMoney(c.balance)})`]), value: boxes.find((c) => c.is_main)?.id }] : []),
      { name: 'paidAt', label: 'Sana', type: 'date', value: todayLocal() },
      { name: 'note', label: 'Izoh' },
    ],
    submit: 'To\'lovni saqlash',
    onSubmit: async (d) => {
      const paidAt = d.paidAt === todayLocal() ? new Date().toISOString() : new Date(`${d.paidAt}T12:00:00+05:00`).toISOString();
      await api('POST', '/payments', { supplierId: supplier.id, amount: Number(d.amount), method: d.method, note: d.note, paidAt, ...(d.cashboxId ? { cashboxId: Number(d.cashboxId) } : {}) });
      flash('To\'lov saqlandi');
    },
  });
}

function reasonForm(title, path, submit = 'Bekor qilish') {
  openForm({
    title, submit, danger: true,
    fields: [{ name: 'reason', label: 'Sababi', required: true }],
    onSubmit: async (d) => { await api('POST', path, d); flash('Bajarildi'); },
  });
}

function logout() {
  token = null;
  me = null;
  store.set('yaya_token', null);
  show();
}

async function loadBrand() {
  try { brand = await (await fetch('/api/public/brand')).json(); } catch { /* keep defaults */ }
  const logo = brand.logoUrl ? `<img src="${esc(brand.logoUrl)}" alt="" class="logo">` : '';
  const name = esc(brand.companyName || 'Yaya');
  $('#brandLogin').innerHTML = `${logo}<h1>${name}</h1>`;
  $('#brandHead').innerHTML = `${logo}<b>${name}</b>`;
  document.title = `${brand.companyName || 'Yaya'} — Boshqaruv`;
  if (brand.logoUrl) {
    let link = $('link[rel=icon]');
    if (!link) document.head.appendChild(link = Object.assign(document.createElement('link'), { rel: 'icon' }));
    link.href = brand.logoUrl;
  }
}

// The panel covers the whole chain. Pages are grouped by part of the business; the
// top row shows the groups, the second row the pages of the open group.
// [key, label, permission (one, or a list = any of them), group]
const GROUPS = [
  ['home', 'Bosh panel'], ['milk', "Sut yig'ish"], ['prod', 'Ishlab chiqarish'], ['stock', 'Ombor'],
  ['reports', 'Hisobotlar'], ['admin', 'Boshqaruv'],
];
const PAGES = [
  ['overview', 'Bosh panel', ['reports.view', 'stock.view_all'], 'home'],
  ['dashboard', 'Kunlik', 'reports.view', 'milk'], ['shifts', 'Smenalar', 'shifts.view_all', 'milk'], ['purchases', 'Xaridlar', 'reports.view', 'milk'],
  ['suppliers', 'Xonadonlar', 'suppliers.view', 'milk'], ['debts', "Qarzlar va to'lovlar", 'debts.view', 'milk'],
  ['catalog', 'Sut mahsulotlari', 'catalog.manage', 'milk'], ['lab', 'Laboratoriya', 'lab.fields', 'milk'],
  ['reports', "Sut yig'ish hisobotlari", 'reports.view', 'reports'],
  ['staff', 'Xodimlar', 'staff.manage', 'admin'], ['roles', 'Rollar va ruxsatlar', 'staff.manage', 'admin'], ['devices', 'Qurilmalar', 'staff.manage', 'admin'],
  ['integrations', 'Integratsiya', 'integrations.manage', 'admin'], ['tester', 'Ilovani sinash', 'tester.use', 'admin'], ['settings', 'Sozlamalar', null, 'admin'],
];
const canPage = (p) => !p[2] || [].concat(p[2]).some(can);
const groupOf = (key) => PAGES.find((p) => p[0] === key)?.[3];
function drawNav() {
  const pages = PAGES.filter(canPage);
  $('#nav').innerHTML = GROUPS.map(([g, t]) => {
    const first = pages.find((p) => p[3] === g);
    return first ? `<a href="#${first[0]}" data-group="${g}">${esc(t)}</a>` : '';
  }).join('');
}

// Detail pages highlight (and are allowed by) their list page.
const PAGE_PARENT = { supplier: 'suppliers', shift: 'shifts', 'balance-edit': 'debts' };

async function show() {
  if (token && !me) {
    try { me = await api('GET', '/me', null, '/api/auth'); } catch { token = null; }
  }
  $('#login').hidden = !!me;
  $('#main').hidden = !me;
  if (!me) return;
  drawNav();
  $('#whoami').textContent = `${me.name || me.login} · ${me.role}`;
  route();
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const r = await api('POST', '/login', { login: f.get('login'), password: f.get('password'), deviceId, deviceLabel: `Brauzer (${navigator.platform || 'kompyuter'})`, client: 'panel' }, '/api/auth');
    token = r.token;
    me = r.user;
    store.set('yaya_token', token);
    $('#loginErr').textContent = '';
    e.target.reset();
    show();
  } catch (err) {
    $('#loginErr').textContent = err.message;
  }
});
$('#logout').addEventListener('click', logout);

const hashParams = () => new URLSearchParams(location.hash.split('?')[1] || '');
const setHash = (name, params) => {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null)).toString();
  location.hash = name + (qs ? '?' + qs : '');
};
const shiftBadge = (s) => `<span class="badge ${SHIFT_STATUS[s]?.[1] ?? ''}">${SHIFT_STATUS[s]?.[0] ?? esc(s)}</span>`;

function dailyChart(host, byDay, from, to) {
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  const products = [];
  for (const r of byDay) if (!products.find((p) => p.key === r.product_id)) products.push({ key: r.product_id, name: esc(r.product_name) });
  // More than three products fold into "Boshqa" so colors stay distinguishable.
  const series = products.length > 3 ? [...products.slice(0, 2), { key: 'other', name: 'Boshqa' }] : products;
  const keep = new Set(series.map((s) => s.key));
  const map = new Map();
  for (const r of byDay) {
    const k = keep.has(r.product_id) ? r.product_id : 'other';
    map.set(`${r.day}|${k}`, (map.get(`${r.day}|${k}`) || 0) + r.quantity);
  }
  Charts.stackedBars(host, {
    categories: days.map((d) => ({ key: d, label: dayLabel(d) })),
    series: series.length ? series : [{ key: 'none', name: 'Miqdor' }],
    value: (d, s) => map.get(`${d}|${s}`) || 0,
    unit: 'kg',
  });
}

function costTable(products) {
  return `<div class="card">
    <h2>Mahsulotlar${money() ? ' va o\'rtacha tannarx' : ''}</h2>
    <div class="table-wrap"><table>
      <tr><th>Mahsulot</th><th class="num">Miqdor</th>${money() ? '<th class="num">O\'rtacha tannarx</th>' : ''}</tr>
      ${products.map((p) => `<tr><td>${esc(p.name)}</td><td class="num">${fmtNum(p.quantity)} ${esc(p.unit)}</td>
        ${money() ? `<td class="num"><b>${fmtNum(p.avg_cost)}</b> so'm/${esc(p.unit)}</td>` : ''}</tr>`).join('')
        || `<tr><td colspan="${money() ? 3 : 2}" class="muted">Qabul qilingan smena yo'q</td></tr>`}
    </table></div></div>`;
}

// Accepted-quantity difference analytics: real vs. written, real cost and the
// company's surplus/shortfall value — by product, collector and shift.
function diffCard(dr) {
  const m = money();
  const sign = (n) => `<b style="color:${n > 0 ? 'var(--ok)' : n < 0 ? 'var(--err)' : 'var(--muted)'}">${n > 0 ? '+' : ''}${fmtNum(n)}</b>`;
  const gain = (n) => (m ? `<b style="color:${n >= 0 ? 'var(--ok)' : 'var(--err)'}">${n >= 0 ? '+' : ''}${fmtMoney(n)}</b>` : '—');
  return `<div class="card"><h2>Farqdan yutuq / yo'qotish</h2>
    <div class="tiles">
      <div class="tile"><div class="k">Jami farq</div><div class="v">${sign(dr.totals.diff_q)}</div><div class="s">kg</div></div>
      ${m ? `<div class="tile"><div class="k">Yutuq / yo'qotish</div><div class="v">${gain(dr.totals.gain)}</div><div class="s">so'm</div></div>` : ''}
      <div class="tile"><div class="k">Qabul qilingan</div><div class="v">${fmtNum(dr.totals.real_q)}</div><div class="s">kg (yozilgan ${fmtNum(dr.totals.written_q)})</div></div>
    </div>
    <h2 style="margin-top:12px">Mahsulotlar bo'yicha</h2><div class="table-wrap"><table>
      <tr><th>Mahsulot</th><th class="num">Yozilgan</th><th class="num">Qabul (real)</th><th class="num">Farq</th>${m ? '<th class="num">Nominal tannarx</th><th class="num">Real tannarx</th><th class="num">Yutuq</th>' : ''}</tr>
      ${dr.byProduct.map((p) => `<tr><td>${esc(p.name)}</td><td class="num">${fmtNum(p.written_q)} ${esc(p.unit)}</td><td class="num"><b>${fmtNum(p.real_q)}</b></td><td class="num">${sign(p.diff_q)}</td>${m ? `<td class="num">${fmtNum(p.nominal_cost)}</td><td class="num"><b>${fmtNum(p.real_cost)}</b></td><td class="num">${gain(p.gain)}</td>` : ''}</tr>`).join('')}
    </table></div>
    <h2 style="margin-top:12px">Sut yig'uvchilar bo'yicha</h2><div class="table-wrap"><table>
      <tr><th>Xodim</th><th class="num">Qabul</th><th class="num">Farq</th>${m ? '<th class="num">Yutuq / yo\'qotish</th>' : ''}</tr>
      ${dr.byEmployee.map((e) => `<tr><td>${esc(e.name)}</td><td class="num">${fmtNum(e.real_q)}</td><td class="num">${sign(e.diff_q)}</td>${m ? `<td class="num">${gain(e.gain)}</td>` : ''}</tr>`).join('')}
    </table></div>
    <h2 style="margin-top:12px">Smenalar bo'yicha</h2><div class="table-wrap"><table>
      <tr><th>Smena</th><th>Xodim</th><th class="num">Qabul</th><th class="num">Farq</th>${m ? '<th class="num">Yutuq / yo\'qotish</th>' : ''}</tr>
      ${dr.byShift.map((x) => `<tr><td><a href="#shift?id=${x.id}"><b>${esc(x.label)}</b></a></td><td>${esc(x.employee_name)}</td><td class="num">${fmtNum(x.real_q)}</td><td class="num">${sign(x.diff_q)}</td>${m ? `<td class="num">${gain(x.gain)}</td>` : ''}</tr>`).join('')}
    </table></div></div>`;
}

function shiftRows(list, { actions = true, showAmount = true } = {}) {
  const diffCols = can('diff.view');
  const sign = (n) => (n == null ? '—' : `<b style="color:${n > 0 ? 'var(--ok)' : n < 0 ? 'var(--err)' : 'var(--muted)'}">${n > 0 ? '+' : ''}${fmtNum(n)}</b>`);
  return `<div class="table-wrap"><table>
    <tr><th>Smena</th><th>Xodim</th><th>Ochilgan</th><th>Yopilgan</th><th class="num">Uylar</th><th class="num">kg</th>${diffCols ? '<th class="num">Qabul</th><th class="num">Farq</th>' : ''}${money() && showAmount ? '<th class="num">Summa</th>' : ''}<th>Holat</th><th></th></tr>
    ${list.map((s) => `<tr>
      <td><a href="#shift?id=${s.id}"><b>${esc(s.label)}</b></a></td>
      <td>${esc(s.employee_name)} ${s.is_test ? '<span class="badge test">test</span>' : ''}</td>
      <td>${esc(fmtDate(s.opened_at))}</td><td>${esc(fmtDate(s.closed_at))}</td>
      <td class="num">${s.suppliers}</td><td class="num"><b>${fmtNum(s.quantity)}</b></td>${diffCols ? `<td class="num">${s.accepted_quantity != null ? fmtNum(s.accepted_quantity) : '—'}</td><td class="num">${sign(s.diff_quantity)}</td>` : ''}${money() && showAmount ? `<td class="num">${s.status === 'accepted' ? fmtMoney(s.amount) : '—'}</td>` : ''}
      <td>${shiftBadge(s.status)}${s.cancel_reason ? `<div class="muted">${esc(s.cancel_reason)}</div>` : ''}</td>
      <td class="row">${actions ? shiftActions(s) : ''}</td></tr>`).join('') || `<tr><td colspan="${diffCols ? 11 : 9}" class="muted">Yo\'q</td></tr>`}
  </table></div>`;
}
const shiftActions = (s, { skipAccept = false } = {}) => [
  s.status === 'closed' && can('shifts.accept') && !skipAccept ? `<button class="small" data-accept="${s.id}">Qabul qilish</button>` : '',
  s.status === 'closed' && can('shifts.cancel') && cancelOn() ? `<button class="small ghost" data-cancel="${s.id}">Bekor qilish</button>` : '',
  s.status === 'cancelled' && can('shifts.copy') ? `<button class="small ghost" data-copy="${s.id}">Nusxalash</button>` : '',
].join('');
function bindShiftActions(v) {
  $$('[data-accept]', v).forEach((b) => { b.onclick = act(async () => { if (!confirmFor('accept', 'Smena qabul qilinsinmi? Shundan keyin u qarz va hisobotlarga kiradi.')) return; await api('POST', `/shifts/${b.dataset.accept}/accept`); flash('Smena qabul qilindi'); route(); }); });
  $$('[data-cancel]', v).forEach((b) => { b.onclick = () => reasonForm('Smenani bekor qilish', `/shifts/${b.dataset.cancel}/cancel`); });
  $$('[data-copy]', v).forEach((b) => { b.onclick = act(async () => {
    const r = await api('POST', `/shifts/${b.dataset.copy}/copy`);
    flash(`${r.label} ochiq smena yaratildi — xodim ilovasida paydo bo'ladi`);
    route();
  }); });
}

const views = {
  // ------------------------------------------------------------------ day overview
  async dashboard(v) {
    const p = hashParams();
    const to = p.get('to') || todayLocal();
    const from = p.get('from') || to;
    const product = p.get('product') || '';
    const [d, prods] = await Promise.all([
      api('GET', `/dashboard?from=${from}&to=${to}${product ? `&product=${product}` : ''}`),
      api('GET', '/products'),
    ]);
    const t = d.summary.totals;
    const preset = (f, t2, label) => `<button class="ghost small" data-range="${f}|${t2}">${label}</button>`;
    v.innerHTML = `
      <div class="row" style="align-items:end;gap:12px;flex-wrap:wrap">
        <label>Dan <input type="date" id="from" value="${from}" max="${todayLocal()}"></label>
        <label>Gacha <input type="date" id="to" value="${to}" max="${todayLocal()}"></label>
        <div class="row" style="gap:6px">${preset(todayLocal(), todayLocal(), 'Bugun')}${preset(addDays(todayLocal(), -6), todayLocal(), '7 kun')}${preset(addDays(todayLocal(), -29), todayLocal(), '30 kun')}</div>
        <label>Mahsulot <select id="product"><option value="">Barchasi</option>${prods.filter((x) => x.active).map((x) => `<option value="${x.id}" ${String(x.id) === product ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
      </div>
      <div class="tiles" style="margin-top:12px">
        <div class="tile"><div class="k">Qabul qilingan sut</div><div class="v">${fmtNum(t.quantity)}</div><div class="s">kg · ${t.shifts} ta smena</div></div>
        ${money() ? `<div class="tile"><div class="k">Summa</div><div class="v">${fmtMoney(t.amount)}</div><div class="s">so'm</div></div>` : ''}
        ${d.debt ? `<div class="tile"><div class="k">Qarzdorlik</div><div class="v">${fmtMoney(d.debt.weOwe)}</div><div class="s"><a href="#debts">batafsil</a></div></div>` : ''}
      </div>
      ${costTable(d.summary.byProduct)}
      ${d.diff && (d.diff.totals.diff_q || d.diff.totals.gain) ? diffCard(d.diff) : ''}
      ${d.live.length || can('shifts.view_all') ? `<div class="card"><h2>Ochiq smenalar <span class="muted">(hisobga kirmaydi)</span></h2>${shiftRows(d.live, { actions: false })}</div>` : ''}
      ${d.waiting.length ? `<div class="card"><h2>Qabul kutayotgan smenalar</h2>${shiftRows(d.waiting)}</div>` : ''}
      <div class="card"><h2>Qabul qilingan smenalar</h2>${shiftRows(d.accepted)}</div>
      <div class="card"><h2>Kunlik qabul (kg)</h2><div id="chart30"></div></div>`;
    dailyChart($('#chart30', v), d.summary.byDay, from, to);
    const go = (f, t2) => setHash('dashboard', { from: f, to: t2, ...(product ? { product } : {}) });
    $('#from', v).onchange = (e) => go(e.target.value, to > e.target.value ? to : e.target.value);
    $('#to', v).onchange = (e) => go(from < e.target.value ? from : e.target.value, e.target.value);
    $('#product', v).onchange = (e) => setHash('dashboard', { from, to, ...(e.target.value ? { product: e.target.value } : {}) });
    $$('[data-range]', v).forEach((btn) => { btn.onclick = () => { const [f, t2] = btn.dataset.range.split('|'); go(f, t2); }; });
    bindShiftActions(v);
  },

  // ------------------------------------------------------------------ shifts
  async shifts(v) {
    const q = hashParams();
    const today = todayLocal();
    const params = { status: q.get('status') ?? 'closed', from: q.get('from') || addDays(today, -6), to: q.get('to') || today, employee: q.get('employee') || '' };
    const [rows, emps] = await Promise.all([api('GET', '/shifts?' + new URLSearchParams(params)), api('GET', '/staff/names')]);
    const dated = !['open', 'closed'].includes(params.status);
    v.innerHTML = `
      <div class="card">
        <div class="presets">${[['closed', 'Qabul kutmoqda'], ['open', 'Ochiq'], ['accepted', 'Qabul qilingan'], ['cancelled', 'Bekor qilingan'], ['', 'Hammasi']]
          .map(([k, t]) => `<button class="ghost small ${k === params.status ? 'on' : ''}" data-st="${k}">${t}</button>`).join('')}</div>
        <div class="row" style="margin-top:8px">
          ${dated ? `<label>Dan <input type="date" id="from" value="${params.from}"></label><label>Gacha <input type="date" id="to" value="${params.to}"></label>` : ''}
          <label>Xodim <select id="emp"><option value="">Hammasi</option>${emps.map((e) => `<option value="${e.id}" ${String(e.id) === params.employee ? 'selected' : ''}>${esc(e.name || e.login)}</option>`).join('')}</select></label>
        </div>
      </div>
      <div class="card">${shiftRows(rows)}</div>`;
    $$('[data-st]', v).forEach((b) => { b.onclick = () => setHash('shifts', { ...params, status: b.dataset.st }); });
    $('#from', v) && ($('#from', v).onchange = (e) => setHash('shifts', { ...params, from: e.target.value }));
    $('#to', v) && ($('#to', v).onchange = (e) => setHash('shifts', { ...params, to: e.target.value }));
    $('#emp', v).onchange = (e) => setHash('shifts', { ...params, employee: e.target.value });
    bindShiftActions(v);
  },

  async shift(v) {
    const d = await api('GET', `/shifts/${hashParams().get('id')}`);
    const s = d.shift;
    const missing = d.rows.filter((r) => r.current_price == null && s.status === 'closed');
    // Difference feature: a closed shift gets per-product real-quantity inputs;
    // an accepted one shows the real total and the gap. Only for diff.view users.
    const diffAccept = s.status === 'closed' && can('shifts.accept') && d.diff?.enabled && !!d.diff.products.length;
    const sign = (n) => `<b style="color:${n > 0 ? 'var(--ok)' : n < 0 ? 'var(--err)' : 'var(--muted)'}">${n > 0 ? '+' : ''}${fmtNum(n)} kg</b>`;
    v.innerHTML = `
      <p><a href="#shifts">← Smenalar</a></p>
      <div class="card"><div class="row" style="justify-content:space-between;align-items:start">
        <div><h2 style="margin-bottom:4px">${esc(s.label)} — ${esc(s.employee_name)} ${shiftBadge(s.status)}</h2>
          <div class="muted">Ochilgan: ${esc(fmtDate(s.opened_at))} · Yopilgan: ${esc(fmtDate(s.closed_at)) || '—'}</div>
          ${s.accepted_at ? `<div class="muted">Qabul qildi: ${esc(s.accepted_by?.replace(/^\w+:/, ''))} · ${esc(fmtDate(s.accepted_at))}</div>` : ''}
          ${s.cancelled_at ? `<div class="err">Bekor qildi: ${esc(s.cancelled_by?.replace(/^\w+:/, ''))} · ${esc(fmtDate(s.cancelled_at))} — ${esc(s.cancel_reason)}</div>` : ''}</div>
        <div class="row">${d.rows.length ? '<button class="small ghost" id="copyText">📋 Nusxalash</button>' : ''}${shiftActions({ ...s, id: s.id }, { skipAccept: diffAccept })}</div></div>
        ${missing.length ? `<p class="err">Narx belgilanmagan: ${[...new Set(missing.map((r) => r.supplier_name))].map(esc).join(', ')} — "Xonadonlar" bo'limida narx qo'ying, keyin qabul qiling.</p>` : ''}
      </div>
      <div class="tiles">${d.byProduct.map((p) => `<div class="tile"><div class="k">${esc(p.name)}</div><div class="v">${fmtNum(p.quantity)}</div><div class="s">${esc(p.unit)} · ${p.pickups} ta</div></div>`).join('')}</div>
      ${d.diff?.hasReal ? `<div class="card"><h2>Qabul qilingan (real) va farq</h2><div class="table-wrap"><table>
        <tr><th>Mahsulot</th><th class="num">Yozilgan</th><th class="num">Qabul</th><th class="num">Farq</th></tr>
        ${d.diff.products.map((p) => `<tr><td>${esc(p.name)}</td><td class="num">${fmtNum(p.written)} ${esc(p.unit)}</td><td class="num"><b>${fmtNum(p.real)}</b></td><td class="num">${sign(p.diff)}</td></tr>`).join('')}
        <tr><td><b>Jami</b></td><td class="num">${fmtNum(d.diff.written)}</td><td class="num"><b>${fmtNum(d.diff.real)}</b></td><td class="num">${sign(d.diff.diff)}</td></tr>
      </table></div></div>` : ''}
      ${diffAccept ? `<div class="card"><h2>Qabul qilingan real miqdor</h2>
        ${d.diff.products.map((p) => `<div class="row" style="align-items:center;gap:10px;margin-bottom:6px">
          <div style="flex:1">${esc(p.name)} <span class="muted">— yozilgan ${fmtNum(p.written)} ${esc(p.unit)}</span></div>
          <input class="diffReal" data-pid="${p.product_id}" data-written="${p.written}" type="number" step="0.1" min="0" value="${p.written}" style="width:130px">
          <span class="diffOut" style="min-width:90px;text-align:right"></span></div>`).join('')}
        ${(d.diff.over != null || d.diff.under != null) ? `<p class="muted">Ruxsat etilgan farq: ${d.diff.over != null ? '+' + d.diff.over : '∞'} / ${d.diff.under != null ? '−' + d.diff.under : '∞'} kg</p>` : ''}
        <p class="err" id="diffWarn" style="display:none">Farq ruxsat etilgan chegaradan tashqarida — qabul qilib bo'lmaydi.</p>
        <button id="diffAcceptBtn">Qabul qilish</button></div>` : ''}
      <div class="card"><div class="table-wrap"><table>
        <tr><th>Vaqt</th><th>Xonadon</th><th>Mahsulot</th><th class="num">Miqdor</th>${money() ? '<th class="num">Narx</th><th class="num">Summa</th>' : ''}</tr>
        ${d.rows.map((r) => `<tr><td>${esc(fmtDate(r.collected_at))}${r.edited_at ? ' <span class="muted" title="Ochiq paytida tahrirlangan">✎</span>' : ''}</td>
          <td><a href="#supplier?id=${r.supplier_id}">${esc(r.supplier_name)}</a></td><td>${esc(r.product_name)}</td><td class="num">${fmtNum(r.quantity)} ${esc(r.unit)}</td>
          ${money() ? `<td class="num">${r.price != null ? fmtMoney(r.price) : r.current_price != null ? `<span class="muted">${fmtMoney(r.current_price)}*</span>` : '<span class="err">yo\'q</span>'}</td><td class="num">${fmtMoney(r.amount)}</td>` : ''}</tr>`).join('')
          || '<tr><td colspan="6" class="muted">Bo\'sh smena</td></tr>'}
      </table></div>${money() && s.status !== 'accepted' ? '<p class="muted">* joriy narx; qabul qilinganda shu narx yoziladi.</p>' : ''}</div>`;
    bindShiftActions(v);
    if (diffAccept) {
      const over = d.diff.over; const under = d.diff.under;
      const recompute = () => {
        let bad = false;
        $$('.diffReal', v).forEach((inp) => {
          const w = Number(inp.dataset.written); const val = Number(inp.value); const diff = Math.round((val - w) * 100) / 100;
          const good = Number.isFinite(val) && val >= 0 && !(over != null && diff > over) && !(under != null && diff < -under);
          if (!good) bad = true;
          const out = inp.parentElement.querySelector('.diffOut');
          out.textContent = `${diff > 0 ? '+' : ''}${fmtNum(diff)} kg`;
          out.style.cssText = `min-width:90px;text-align:right;font-weight:700;color:${diff > 0 ? 'var(--ok)' : diff < 0 ? 'var(--err)' : 'var(--muted)'}`;
        });
        $('#diffWarn', v).style.display = bad ? 'block' : 'none';
        $('#diffAcceptBtn', v).disabled = bad;
      };
      $$('.diffReal', v).forEach((inp) => { inp.oninput = recompute; });
      recompute();
      $('#diffAcceptBtn', v).onclick = act(async () => {
        if (!confirmFor('accept', 'Smena qabul qilinsinmi? Shundan keyin u qarz va hisobotlarga kiradi.')) return;
        const real = {};
        $$('.diffReal', v).forEach((inp) => { real[inp.dataset.pid] = Number(inp.value); });
        await api('POST', `/shifts/${s.id}/accept`, { real });
        flash('Smena qabul qilindi');
        route();
      });
    }
    const cb = $('#copyText', v);
    if (cb) cb.onclick = act(async () => {
      const { text } = await api('GET', `/shifts/${s.id}/copytext`);
      if (!text) return flash('Nusxalash uchun ma\'lumot yo\'q');
      try { await navigator.clipboard.writeText(text); } catch {
        const ta = Object.assign(document.createElement('textarea'), { value: text });
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
      }
      flash('Smena klaviaturaga nusxalandi');
    });
  },

  // ------------------------------------------------------------------ purchases
  async purchases(v) {
    const q = hashParams();
    const today = todayLocal();
    const from = q.get('from') || addDays(today, -6);
    const to = q.get('to') || today;
    const filt = { employee: q.get('employee') || '', supplier: q.get('supplier') || '', shift: q.get('shift') || '' };
    const qs = new URLSearchParams({ from, to, ...filt }).toString();
    const [d, emps, sups] = await Promise.all([api('GET', '/purchases?' + qs), api('GET', '/staff/names'), can('suppliers.view') ? api('GET', '/suppliers') : []]);
    const presets = [['Bugun', today, today], ['Kecha', addDays(today, -1), addDays(today, -1)], ['7 kun', addDays(today, -6), today], ['30 kun', addDays(today, -29), today]];
    v.innerHTML = `
      <div class="card"><div class="row" style="flex-wrap:wrap">
        <div class="presets">${presets.map(([t, f, tt]) => `<button class="ghost small ${f === from && tt === to ? 'on' : ''}" data-f="${f}" data-t="${tt}">${t}</button>`).join('')}</div>
        <label>Dan <input type="date" id="from" value="${from}"></label>
        <label>Gacha <input type="date" id="to" value="${to}"></label>
        <label>Sut yig'uvchi <select id="emp"><option value="">Hammasi</option>${emps.filter((e) => !e.is_test).map((e) => `<option value="${e.id}" ${String(e.id) === filt.employee ? 'selected' : ''}>${esc(e.name || e.login)}</option>`).join('')}</select></label>
        ${sups.length ? `<label>Xonadon <select id="sup"><option value="">Hammasi</option>${sups.map((x) => `<option value="${x.id}" ${String(x.id) === filt.supplier ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>` : ''}
        <label>Smena № <input id="shift" type="number" min="1" value="${esc(filt.shift)}" style="width:90px"></label>
        ${can('reports.export') ? '<button type="button" class="ghost" id="csv">⬇ Excel (CSV)</button>' : ''}
      </div><p class="muted">Faqat qabul qilingan smenalar. Har smenadagi "Farq" alohida xarid sifatida (narxsiz) ko'rsatiladi.</p></div>
      <div class="tiles">
        <div class="tile"><div class="k">Xaridlar soni</div><div class="v">${d.totals.count}</div><div class="s">ta</div></div>
        <div class="tile"><div class="k">Jami miqdor (farq bilan)</div><div class="v">${fmtNum(d.totals.quantity)}</div><div class="s">kg</div></div>
        ${money() ? `<div class="tile"><div class="k">Jami summa</div><div class="v">${fmtMoney(d.totals.amount)}</div><div class="s">so'm</div></div>` : ''}
      </div>
      <div class="card"><div class="table-wrap"><table>
        <tr><th>Xarid</th><th>Smena</th><th>Vaqt</th><th>Sut yig'uvchi</th><th>Xonadon</th><th class="num">Miqdor</th>${money() ? '<th class="num">Summa</th>' : ''}<th></th></tr>
        ${d.rows.map((r) => `<tr class="${r.isDiff ? 'voided' : ''}">
          <td><b>${esc(r.number)}</b></td>
          <td><a href="#shift?id=${r.shift_id}">${esc(r.shift)}</a></td>
          <td>${esc(fmtDate(r.at))}</td><td>${esc(r.collector)}</td>
          <td>${r.isDiff ? '<i>Farq (smena)</i>' : `<a href="#supplier?id=${r.supplier_id}">${esc(r.supplier)}</a>`}</td>
          <td class="num"><b style="${r.quantity < 0 ? 'color:var(--err)' : ''}">${fmtNum(r.quantity)}</b></td>
          ${money() ? `<td class="num">${r.isDiff ? '—' : fmtMoney(r.amount)}</td>` : ''}
          <td>${r.isDiff ? '' : `<button class="small ghost" data-det="${r.shift_id}:${r.supplier_id}:${esc(r.number)}">Ko'rish</button>`}</td></tr>`).join('')
          || `<tr><td colspan="${money() ? 8 : 7}" class="muted">Bu davrda xarid yo'q</td></tr>`}
      </table></div></div>`;
    const go = (patch) => setHash('purchases', { from, to, ...filt, ...patch });
    $$('.presets button', v).forEach((b) => { b.onclick = () => go({ from: b.dataset.f, to: b.dataset.t }); });
    $('#from', v).onchange = (e) => go({ from: e.target.value });
    $('#to', v).onchange = (e) => go({ to: e.target.value });
    $('#emp', v).onchange = (e) => go({ employee: e.target.value });
    $('#sup', v) && ($('#sup', v).onchange = (e) => go({ supplier: e.target.value }));
    $('#shift', v).onchange = (e) => go({ shift: e.target.value });
    $('#csv', v) && ($('#csv', v).onclick = act(() => download('GET', `/purchases/export.csv?${qs}`, `yaya_xaridlar_${from}_${to}.csv`)));
    $$('[data-det]', v).forEach((b) => { b.onclick = act(async () => {
      const [shiftId, supplierId, number] = b.dataset.det.split(':');
      const rows = await api('GET', `/purchases/breakdown?shift=${shiftId}&supplier=${supplierId}`);
      openForm({ title: `Xarid ${number}`, submit: 'Yopish', fields: [], intro: `<div class="table-wrap"><table>
        <tr><th>Mahsulot</th><th class="num">Miqdor</th>${money() ? '<th class="num">Narx</th><th class="num">Summa</th>' : ''}</tr>
        ${rows.map((p) => `<tr><td>${esc(p.product)}</td><td class="num">${fmtNum(p.quantity)} ${esc(p.unit)}</td>${money() ? `<td class="num">${fmtMoney(p.price)}</td><td class="num">${fmtMoney(p.amount)}</td>` : ''}</tr>`).join('')}
      </table></div>`, onSubmit: async () => {} });
    }); });
  },

  // ------------------------------------------------------------------ analytics
  async reports(v) {
    const q = hashParams();
    const today = todayLocal();
    const from = q.get('from') || addDays(today, -6);
    const to = q.get('to') || today;
    const filt = { employee: q.get('employee') || '', supplier: q.get('supplier') || '' };
    const qs = new URLSearchParams({ from, to, ...filt }).toString();
    const [s, emps, sups, dr] = await Promise.all([api('GET', '/reports/summary?' + qs), api('GET', '/staff/names'),
      can('suppliers.view') ? api('GET', '/suppliers') : [], can('diff.view') ? api('GET', '/reports/diff?' + qs).catch(() => null) : null]);
    const monthStart = today.slice(0, 8) + '01';
    const prevMonthEnd = addDays(monthStart, -1);
    const presets = [
      ['Bugun', today, today], ['Kecha', addDays(today, -1), addDays(today, -1)], ['7 kun', addDays(today, -6), today],
      ['30 kun', addDays(today, -29), today], ['Bu oy', monthStart, today], ["O'tgan oy", prevMonthEnd.slice(0, 8) + '01', prevMonthEnd],
    ];
    v.innerHTML = `
      <div class="card"><div class="row">
        <div class="presets">${presets.map(([t, f, tt]) => `<button class="ghost small ${f === from && tt === to ? 'on' : ''}" data-f="${f}" data-t="${tt}">${t}</button>`).join('')}</div>
        <label>Dan <input type="date" id="from" value="${from}"></label>
        <label>Gacha <input type="date" id="to" value="${to}"></label>
        <label>Xodim <select id="emp"><option value="">Hammasi</option>${emps.filter((e) => !e.is_test).map((e) => `<option value="${e.id}" ${String(e.id) === filt.employee ? 'selected' : ''}>${esc(e.name || e.login)}</option>`).join('')}</select></label>
        ${sups.length ? `<label>Xonadon <select id="sup"><option value="">Hammasi</option>${sups.map((x) => `<option value="${x.id}" ${String(x.id) === filt.supplier ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>` : ''}
        ${can('reports.export') ? '<button type="button" class="ghost" id="csv">⬇ Excel (CSV)</button>' : ''}
      </div><p class="muted">Faqat qabul qilingan smenalar.</p></div>
      <div class="tiles">
        <div class="tile"><div class="k">Jami miqdor</div><div class="v">${fmtNum(s.totals.quantity)}</div><div class="s">kg · ${s.totals.shifts} smena</div></div>
        ${money() ? `<div class="tile"><div class="k">Summa</div><div class="v">${fmtMoney(s.totals.amount)}</div><div class="s">so'm</div></div>
          <div class="tile"><div class="k">O'rtacha tannarx</div><div class="v">${s.totals.quantity ? fmtMoney(s.totals.amount / s.totals.quantity) : '—'}</div><div class="s">so'm/kg</div></div>` : ''}
        <div class="tile"><div class="k">Yetkazib berishlar</div><div class="v">${s.totals.pickups}</div><div class="s">${s.totals.suppliers} ta xonadondan</div></div>
      </div>
      <div class="card"><h2>Kunlik miqdor (kg)</h2><div id="daily"></div></div>
      <div class="grid2">
        <div class="card"><h2>Xonadonlar bo'yicha (kg)</h2><div id="rankSup"></div></div>
        <div class="card"><h2>Xodimlar bo'yicha (kg)</h2><div id="rankEmp"></div></div>
      </div>
      <div class="card"><h2>Mahsulotlar</h2><div class="table-wrap"><table>
        <tr><th>Mahsulot</th><th class="num">Yetkazib berish</th><th class="num">Miqdor</th>${money() ? '<th class="num">O\'rtacha tannarx</th><th class="num">Summa</th>' : ''}</tr>
        ${s.byProduct.map((p) => `<tr><td>${esc(p.name)}</td><td class="num">${p.pickups}</td><td class="num">${fmtNum(p.quantity)} ${esc(p.unit)}</td>${money() ? `<td class="num">${fmtNum(p.avg_cost)}</td><td class="num">${fmtMoney(p.amount)}</td>` : ''}</tr>`).join('')
          || '<tr><td colspan="5" class="muted">Bu davrda yozuv yo\'q</td></tr>'}
      </table></div></div>
      ${dr && (dr.totals.diff_q || dr.totals.gain) ? diffCard(dr) : ''}`;
    dailyChart($('#daily', v), s.byDay, s.range.from, s.range.to);
    Charts.rankBars($('#rankSup', v), { rows: s.bySupplier.map((r) => ({ label: esc(r.name), value: r.quantity, sub: money() ? `${fmtMoney(r.amount)} so'm` : '' })), unit: 'kg' });
    Charts.rankBars($('#rankEmp', v), { rows: s.byEmployee.map((r) => ({ label: esc(r.name), value: r.quantity, sub: `${r.shifts} smena · ${r.pickups} ta` })), unit: 'kg' });
    const go = (patch) => setHash('reports', { from, to, ...filt, ...patch });
    $$('.presets button', v).forEach((b) => { b.onclick = () => go({ from: b.dataset.f, to: b.dataset.t }); });
    $('#from', v).onchange = (e) => go({ from: e.target.value });
    $('#to', v).onchange = (e) => go({ to: e.target.value });
    $('#emp', v).onchange = (e) => go({ employee: e.target.value });
    $('#sup', v) && ($('#sup', v).onchange = (e) => go({ supplier: e.target.value }));
    $('#csv', v) && ($('#csv', v).onclick = act(() => download('GET', `/reports/export.csv?${qs}`, `yaya_${from}_${to}.csv`)));
  },

  // ------------------------------------------------------------------ debts & payments
  async debts(v) {
    const q = hashParams();
    const today = todayLocal();
    const params = { q: q.get('q') || '', from: q.get('from') || addDays(today, -29), to: q.get('to') || today };
    const [b, pays] = await Promise.all([api('GET', '/balances?q=' + encodeURIComponent(params.q)), api('GET', `/payments?from=${params.from}&to=${params.to}&voided=1`)]);
    v.innerHTML = `
      <div class="tiles">
        <div class="tile"><div class="k">Qarzdorlik</div><div class="v">${fmtMoney(b.totals.weOwe)}</div><div class="s">so'm, ${b.rows.filter((r) => r.balance > 0).length} ta xonadon</div></div>
        <div class="tile"><div class="k">Haqdorlik</div><div class="v">${fmtMoney(b.totals.theyOwe)}</div><div class="s">so'm (avans)</div></div>
      </div>
      <div class="card">
        <div class="row" style="justify-content:space-between;align-items:center">
          <input id="q" value="${esc(params.q)}" placeholder="Ism, telefon yoki manzil bo'yicha qidirish..." style="flex:1">
          <div class="row" style="gap:6px">
            <button class="ghost small" id="xls">⬇ Excel</button>
            ${can('payments.create') ? '<button class="small" id="editbal">Balanslarni tahrirlash</button>' : ''}</div>
        </div>
        <div class="table-wrap"><table>
          <tr><th>Xonadon</th><th>Telefon</th><th class="num">Olingan</th><th class="num">To'langan</th><th class="num">Balans</th><th>Oxirgi to'lov</th><th></th></tr>
          ${b.rows.map((r) => `<tr ${r.active ? '' : 'class="muted"'}>
            <td><a href="#supplier?id=${r.id}">${esc(r.name)}</a></td><td>${esc(r.phone)}</td>
            <td class="num">${fmtMoney(r.purchased)}</td><td class="num">${fmtMoney(r.paid)}</td>
            <td class="num"><b class="${r.balance < 0 ? 'warn' : ''}">${fmtMoney(r.balance)}</b></td>
            <td>${esc(fmtDate(r.last_payment).slice(0, 10))}</td>
            <td>${can('payments.create') ? `<button class="small" data-pay="${r.id}">To'lov</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">Topilmadi</td></tr>'}
        </table></div>
      </div>
      <div class="card"><div class="row" style="justify-content:space-between;align-items:end"><h2>To'lovlar tarixi</h2>
        <div class="row"><label>Dan <input type="date" id="from" value="${params.from}"></label><label>Gacha <input type="date" id="to" value="${params.to}"></label></div></div>
        <div class="table-wrap"><table>
          <tr><th>Sana</th><th>Xonadon</th><th class="num">Summa</th><th>Usul</th><th>Izoh</th><th>Kim</th><th></th></tr>
          ${pays.map((p) => p.kind === 'adjust'
            ? `<tr><td>${esc(fmtDate(p.at))}</td><td><a href="#supplier?id=${p.supplier_id}">${esc(p.supplier_name)}</a></td>
              <td class="num">${fmtMoney(p.amount)}</td><td colspan="2"><b>Balans tahrirlandi</b>${p.note ? ` — ${esc(p.note)}` : ''}</td><td class="muted">${esc(p.by_name || '')}</td><td></td></tr>`
            : `<tr class="${p.voided_at ? 'voided' : ''}"><td>${esc(fmtDate(p.at))}</td><td><a href="#supplier?id=${p.supplier_id}">${esc(p.supplier_name)}</a></td>
            <td class="num">${fmtMoney(p.amount)}</td><td>${p.number ? `<span class="muted">#${p.number}</span> ` : ''}${METHOD[p.method]}</td><td>${esc(p.note)}</td><td class="muted">${esc(p.by_name || '')}</td>
            <td>${p.voided_at ? `<span class="muted">Bekor: ${esc(p.void_reason)}</span>` : can('payments.void') ? `<button class="small ghost" data-void="${p.id}">Bekor qilish</button>` : ''}</td></tr>`).join('')
            || '<tr><td colspan="7" class="muted">Bu davrda yozuv yo\'q</td></tr>'}
        </table></div></div>`;
    $('#xls', v).onclick = act(() => download('GET', `/balances-export.xlsx?q=${encodeURIComponent(params.q)}`, 'yaya_qarzlar.xlsx'));
    $('#editbal', v) && ($('#editbal', v).onclick = () => openBalanceEditor());
    let t;
    $('#q', v).oninput = (e) => { clearTimeout(t); t = setTimeout(() => setHash('debts', { ...params, q: e.target.value }), 400); };
    if (params.q) { $('#q', v).focus(); $('#q', v).setSelectionRange(params.q.length, params.q.length); }
    $('#from', v).onchange = (e) => setHash('debts', { ...params, from: e.target.value });
    $('#to', v).onchange = (e) => setHash('debts', { ...params, to: e.target.value });
    $$('[data-pay]', v).forEach((btn) => { btn.onclick = () => { const r = b.rows.find((x) => String(x.id) === btn.dataset.pay); paymentForm(r, r.balance); }; });
    $$('[data-void]', v).forEach((btn) => { btn.onclick = () => reasonForm('To\'lovni bekor qilish', `/payments/${btn.dataset.void}/void`); });
  },

  // ------------------------------------------------------------------ edit balances
  async ['balance-edit'](v) {
    if (!BALANCE_PW) { location.hash = 'debts'; return; }
    const q = hashParams().get('q') || '';
    const b = await api('GET', '/balances?q=' + encodeURIComponent(q));
    v.innerHTML = `
      <p><a href="#debts">← Qarzlar va to'lovlar</a></p>
      <div class="card">
        <h2>Balanslarni tahrirlash</h2>
        <p class="muted">Xonadonni tanlab, "Yangi balans" ustuniga haqiqiy summani yozing (musbat — biz qarzmiz, minus — bizga qarz). Faqat yozilgan qatorlar o'zgaradi.</p>
        <input id="q" value="${esc(q)}" placeholder="Qidirish..." style="width:100%;margin-bottom:8px">
        <div class="table-wrap"><table>
          <tr><th>Xonadon</th><th class="num">Hozirgi balans</th><th class="num">Yangi balans (haqiqat)</th></tr>
          ${b.rows.map((r) => `<tr><td>${esc(r.name)}</td><td class="num">${fmtMoney(r.balance)}</td>
            <td class="num"><input type="number" step="1" class="newbal" data-id="${r.id}" data-cur="${r.balance}" placeholder="${r.balance}" style="width:140px;text-align:right"></td></tr>`).join('')}
        </table></div>
        <label style="margin-top:10px">Izoh (barcha o'zgarishlar uchun) <input id="note" maxlength="300" placeholder="Masalan: inventarizatsiya"></label>
        <p class="err" id="err"></p>
        <button id="save">Saqlash</button>
      </div>`;
    $('#q', v).onchange = (e) => setHash('balance-edit', { q: e.target.value });
    $('#save', v).onclick = act(async () => {
      const items = $$('.newbal', v).filter((i) => i.value.trim() !== '')
        .map((i) => ({ supplierId: Number(i.dataset.id), target: Math.round(Number(i.value)) }));
      if (!items.length) { $('#err', v).textContent = 'Hech bo\'lmasa bitta xonadonga yangi balans yozing'; return; }
      const names = items.length;
      if (!confirm(`${names} ta xonadon balansi o'zgaradi. Davom etasizmi?`)) return;
      await api('POST', '/balances/edit', { password: BALANCE_PW, items, note: $('#note', v).value });
      BALANCE_PW = '';
      flash('Balanslar saqlandi');
      location.hash = 'debts';
    });
  },

  // ------------------------------------------------------------------ supplier card
  async supplier(v) {
    const id = hashParams().get('id');
    const c = await api('GET', `/suppliers/${id}/card`);
    const s = c.supplier;
    const st = c.statement;
    v.innerHTML = `
      <p><a href="#suppliers">← Xonadonlar</a></p>
      <div class="card"><div class="row" style="justify-content:space-between;align-items:start">
        <div><h2 style="margin-bottom:4px">${esc(s.name)} ${s.active ? '' : '<span class="badge error">o\'chirilgan</span>'}</h2>
          <div class="muted">${esc(s.phone)}</div>
          <div class="muted">📍 ${s.address ? esc(s.address) : '<i>manzil kiritilmagan</i>'}${s.lat != null ? ` <span title="xaritada belgilangan">· 🗺️</span>` : ''}
            ${(can('suppliers.location') || can('suppliers.edit')) ? '<button class="small ghost" id="mapBtn">Xaritada belgilash</button>' : ''}
            ${s.lat != null ? `<a class="small ghost btnlike" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${s.lat},${s.lng}">Ko'rish ↗</a>` : ''}</div>
          ${(s.address2 || s.lat2 != null) ? `<div class="muted">📍 2-manzil: ${s.address2 ? esc(s.address2) : '<i>manzil kiritilmagan</i>'}${s.lat2 != null ? ` <span title="xaritada belgilangan">· 🗺️</span>` : ''}
            ${(can('suppliers.location') || can('suppliers.edit')) ? '<button class="small ghost" id="mapBtn2">Xaritada belgilash</button>' : ''}
            ${s.lat2 != null ? `<a class="small ghost btnlike" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${s.lat2},${s.lng2}">Ko'rish ↗</a>` : ''}
            ${(can('suppliers.location') || can('suppliers.edit')) ? '<button class="small ghost" id="delLoc2">🗑 O\'chirish</button>' : ''}</div>`
            : ((can('suppliers.location') || can('suppliers.edit')) ? '<div class="muted"><button class="small ghost" id="addLoc2">＋ Qo\'shimcha manzil</button></div>' : '')}
          ${s.note ? `<div class="muted">${esc(s.note)}</div>` : ''}
          <div class="muted">Sut yig'uvchi: ${c.collectors.map((e) => esc(e.name || e.login)).join(', ') || '—'}</div>
          ${money() ? `<div style="margin-top:6px">${c.products.map((p) => `${p.is_default ? '★ ' : ''}${esc(p.name)}: <b>${p.price == null ? '<span class="err">narx yo\'q</span>' : fmtMoney(p.price)}</b> so'm/${esc(p.unit)}`).join(' · ') || '<span class="err">Mahsulot biriktirilmagan</span>'}</div>` : ''}</div>
        <div class="row">${st && can('payments.create') ? '<button id="pay">+ To\'lov</button>' : ''}</div>
      </div></div>
      <div class="tiles">
        ${st ? `<div class="tile"><div class="k">${st.balance >= 0 ? 'Biz qarzmiz' : 'Bizga qarz (avans)'}</div><div class="v">${fmtMoney(Math.abs(st.balance))}</div><div class="s">so'm</div></div>` : ''}
        <div class="tile"><div class="k">Jami qabul qilingan</div><div class="v">${fmtNum(c.allTime.quantity)}</div><div class="s">kg · ${c.allTime.pickups} marta</div></div>
        ${money() ? `<div class="tile"><div class="k">Jami summa</div><div class="v">${fmtMoney(c.allTime.amount)}</div><div class="s">so'm</div></div>` : ''}
        <div class="tile"><div class="k">60 kunda</div><div class="v">${fmtNum(c.last60.totals.quantity)}</div><div class="s">kg</div></div>
      </div>
      <div class="card"><h2>Oxirgi 60 kun — qabul qilingan sut (kg)</h2><div id="chart"></div></div>
      ${st ? `<div class="card"><h2>Hisob-kitob tarixi (akt-sverka)</h2><div class="table-wrap"><table>
        <tr><th>Sana</th><th>Amal</th><th class="num">Miqdor</th>${money() ? '<th class="num">Narx</th>' : ''}<th class="num">Olindi (+)</th><th class="num">To'landi (−)</th><th class="num">Qarz qoldig'i</th><th>Kim</th></tr>
        ${st.entries.map((e) => `<tr class="${e.voided_at ? 'voided' : ''}">
          <td>${esc(fmtDate(e.at))}</td>
          <td>${e.kind === 'pickup' ? `${esc(e.product_name)} <a href="#shift?id=${e.shift_id}" class="muted" title="${esc(e.by_name || '')} · smenani ochish">#${e.shift_number}${e.copy_no ? '-copy' : ''}${e.by_name ? ` · ${esc(e.by_name)}` : ''}</a>` : `To'lov${e.number ? ` #${e.number}` : ''} (${METHOD[e.method]})${e.note ? ` — ${esc(e.note)}` : ''}`}${e.voided_at ? ` <span class="muted">bekor: ${esc(e.void_reason)}</span>` : ''}</td>
          <td class="num">${e.kind === 'pickup' ? `${fmtNum(e.quantity)} ${esc(e.unit)}` : ''}</td>${money() ? `<td class="num">${e.kind === 'pickup' ? fmtMoney(e.price) : ''}</td>` : ''}
          <td class="num">${e.kind === 'pickup' ? fmtMoney(e.amount) : ''}</td><td class="num">${e.kind === 'payment' ? fmtMoney(e.amount) : ''}</td>
          <td class="num"><b>${fmtMoney(e.balance)}</b></td><td class="muted">${esc(String(e.by_name).replace(/^\w+:/, ''))}</td></tr>`).join('')}
        <tr><td></td><td class="muted">Boshlang'ich qarz</td><td></td>${money() ? '<td></td>' : ''}<td></td><td></td><td class="num">${fmtMoney(st.opening)}</td><td></td></tr>
      </table></div></div>` : ''}`;
    dailyChart($('#chart', v), c.last60.byDay, c.last60.range.from, c.last60.range.to);
    $('#pay', v) && ($('#pay', v).onclick = () => paymentForm(s, st.balance));
    $('#mapBtn', v) && ($('#mapBtn', v).onclick = act(async () => {
      const r = await openMap({ lat: s.lat, lng: s.lng, name: s.name, address: s.address });
      if (!r) return;
      // Only the coordinates are saved from the map; the manual address is kept.
      await api('PATCH', `/suppliers/${s.id}`, { lat: r.lat, lng: r.lng });
      flash('Joylashuv saqlandi');
      route();
    }));
    const setLoc2 = act(async () => {
      const r = await openMap({ lat: s.lat2, lng: s.lng2, name: s.name, address: s.address2 });
      if (!r) return;
      await api('PATCH', `/suppliers/${s.id}`, { lat2: r.lat, lng2: r.lng });
      flash('Qo\'shimcha joylashuv saqlandi');
      route();
    });
    $('#mapBtn2', v) && ($('#mapBtn2', v).onclick = setLoc2);
    $('#addLoc2', v) && ($('#addLoc2', v).onclick = setLoc2);
    $('#delLoc2', v) && ($('#delLoc2', v).onclick = act(async () => {
      if (!confirm('Qo\'shimcha manzilni o\'chirishni tasdiqlaysizmi?')) return;
      await api('PATCH', `/suppliers/${s.id}`, { address2: null, lat2: null, lng2: null });
      flash('Qo\'shimcha manzil o\'chirildi');
      route();
    }));
  },

  // ------------------------------------------------------------------ suppliers & prices
  async suppliers(v) {
    const [sups, prods, links, staff] = await Promise.all([api('GET', '/suppliers'), api('GET', '/products'), api('GET', '/supplier-products'),
      can('staff.manage') ? api('GET', '/staff') : []]);
    const bySup = {};
    for (const l of links) (bySup[l.supplier_id] ||= []).push(l);
    const prices = can('prices.manage');
    const form = (s = {}) => [
      { name: 'name', label: 'F.I.Sh', value: s.name, required: true },
      { name: 'phone', label: 'Telefon', value: s.phone, inputmode: 'tel' },
      { name: 'address', label: 'Manzil', value: s.address },
      { name: 'address2', label: 'Qo\'shimcha manzil (ixtiyoriy)', value: s.address2 },
      { name: 'note', label: 'Izoh', value: s.note },
      ...(!s.id && can('payments.create') ? [{ name: 'openingBalance', label: 'Hozirgi qarzimiz (so\'m, ixtiyoriy)', type: 'number', step: 1, hint: 'U bizga qarz bo\'lsa — minus bilan' }] : []),
    ];
    const prodOpts = prods.filter((p) => p.active).map((p) => [p.id, `${p.name} (${p.unit})`]);
    v.innerHTML = `
      <div class="card"><div class="row" style="justify-content:space-between"><h2>Xonadonlar (${sups.filter((s) => s.active).length})</h2>
        <div class="row">${can('suppliers.create') ? '<button id="add">+ Yangi</button>' : ''}
          ${can('suppliers.import') ? '<button class="ghost" id="exp">⬇ Excel\'ga eksport</button><button class="ghost" id="tpl">⬇ Bo\'sh shablon</button>' : ''}
          ${can('suppliers.import') && prices ? '<button class="ghost" id="imp">⬆ Excel\'dan import</button>' : ''}</div></div>
        <input id="flt" placeholder="Ism, telefon yoki manzil bo'yicha qidirish..." style="width:100%;margin-top:8px">
      </div>
      <div id="impBox"></div>
      <div class="card"><div class="table-wrap"><table>
        <tr><th>Xonadon</th><th>Sut yig'uvchi</th><th>Mahsulot${money() ? ' va narx' : ''}</th><th></th></tr>
        ${sups.map((s) => `<tr data-name="${esc(`${s.name} ${s.address ?? ''}`.toLowerCase())}" data-phone="${digits(s.phone)}" ${s.active ? '' : 'class="muted"'}>
          <td><a href="#supplier?id=${s.id}"><b>${esc(s.name)}</b></a>${s.active ? '' : ' (o\'chirilgan)'}<div class="muted">${esc(s.phone)} ${esc(s.address)}</div>
            ${s.created_by?.startsWith('user:') && s.created_by !== `user:${me.login}` ? `<div class="muted">qo'shgan: ${esc(s.created_by.slice(5))}</div>` : ''}</td>
          <td>${esc(s.collectors) || '<span class="muted">—</span>'}</td>
          <td>${(bySup[s.id] || []).map((l) => `<div class="row" style="align-items:center">
              ${l.is_default ? '<span title="Asosiy mahsulot">★</span>' : ''} ${esc(l.product_name)}${money() ? `: <b>${l.price == null ? '<span class="err">narx yo\'q</span>' : fmtMoney(l.price)}</b>` : ''}
              ${prices ? `<button class="small ghost" data-price="${s.id}|${l.product_id}">✎</button><button class="small ghost" data-del="${s.id}/${l.product_id}">✕</button>` : ''}</div>`).join('')
              || '<span class="err">Mahsulot biriktirilmagan</span>'}</td>
          <td class="row">${prices ? `<button class="small" data-price="${s.id}|">+ Narx</button>` : ''}
            ${can('suppliers.edit') ? `<button class="small ghost" data-edit="${s.id}">Tahrirlash</button><button class="small ghost" data-toggle="${s.id}">${s.active ? 'O\'chirish' : 'Yoqish'}</button>${!s.active ? `<button class="small ghost" data-remove="${s.id}">Butunlay o'chirish</button>` : ''}` : ''}</td>
        </tr>`).join('') || '<tr><td colspan="4" class="muted">Hali xonadon yo\'q</td></tr>'}
      </table></div></div>`;
    void staff;
    $('#flt', v).oninput = (e) => {
      const t = e.target.value.toLowerCase().trim();
      const d = digits(t);
      $$('tr[data-name]', v).forEach((tr) => { tr.hidden = !!t && !tr.dataset.name.includes(t) && !(d.length >= 2 && tr.dataset.phone.includes(d)); });
    };
    $('#add', v) && ($('#add', v).onclick = () => openForm({ title: 'Yangi xonadon', fields: form(),
      onSubmit: async (d) => { await api('POST', '/suppliers', { ...d, openingBalance: d.openingBalance === '' ? undefined : Number(d.openingBalance) }); flash('Qo\'shildi. Endi mahsulot va narx belgilang.'); } }));
    $('#tpl', v) && ($('#tpl', v).onclick = act(() => download('GET', '/suppliers-import/template.xlsx', 'yaya_yetkazib_beruvchilar_shablon.xlsx')));
    $('#exp', v) && ($('#exp', v).onclick = act(() => download('GET', '/suppliers-export.xlsx', `yaya_yetkazib_beruvchilar_${todayLocal()}.xlsx`)));
    $('#imp', v) && ($('#imp', v).onclick = () => importFlow($('#impBox', v)));
    $$('[data-edit]', v).forEach((b) => { b.onclick = () => {
      const s = sups.find((x) => String(x.id) === b.dataset.edit);
      openForm({ title: 'Tahrirlash', fields: form(s), onSubmit: async (d) => { await api('PATCH', `/suppliers/${s.id}`, d); flash('Saqlandi'); } });
    }; });
    $$('[data-toggle]', v).forEach((b) => { b.onclick = act(async () => {
      const s = sups.find((x) => String(x.id) === b.dataset.toggle);
      await api('PATCH', `/suppliers/${s.id}`, { active: !s.active });
      route();
    }); });
    $$('[data-remove]', v).forEach((b) => { b.onclick = act(async () => {
      const s = sups.find((x) => String(x.id) === b.dataset.remove);
      if (!confirmFor('entity_delete', `${s.name} tizimdan BUTUNLAY o'chiriladi (qarzi/haqi 0 bo'lishi shart). Davom etasizmi?`)) return;
      try {
        await api('DELETE', `/suppliers/${s.id}`);
      } catch (e) {
        // History exists: ask once more, then delete together with the history.
        if (e.status === 409 || /tarixi bor/.test(e.message || '')) {
          if (!confirm(`${s.name}da sut/to'lov tarixi bor. Tarix bilan birga o'chirilsa — o'tgan hisobotlar o'zgaradi. Baribir butunlay o'chirilsinmi?`)) return;
          await api('DELETE', `/suppliers/${s.id}`, { force: true });
        } else throw e;
      }
      flash('Xonadon butunlay o\'chirildi');
      route();
    }); });
    $$('[data-price]', v).forEach((b) => { b.onclick = () => {
      if (!prodOpts.length) { flash('Avval "Mahsulotlar" bo\'limida mahsulot qo\'shing', 'err'); return; }
      const [sid, pid] = b.dataset.price.split('|');
      const cur = links.find((l) => String(l.supplier_id) === sid && String(l.product_id) === pid);
      const hasAny = (bySup[sid] || []).length > 0;
      openForm({
        title: `${sups.find((x) => String(x.id) === sid).name} — narx`,
        fields: [
          { name: 'productId', label: 'Mahsulot', type: 'select', options: prodOpts, value: pid },
          { name: 'price', label: 'Narx (so\'m, 1 birlik uchun)', type: 'number', step: 'any', value: cur?.price, required: true },
          { name: 'isDefault', label: 'Asosiy mahsulot (ilovada avtomatik tanlanadi)', type: 'checkbox', value: cur ? cur.is_default : !hasAny },
        ],
        onSubmit: async (d) => {
          await api('PUT', '/supplier-products', { supplierId: Number(sid), productId: Number(d.productId), price: Number(d.price), isDefault: d.isDefault });
          flash('Narx saqlandi');
        },
      });
    }; });
    $$('[data-del]', v).forEach((b) => { b.onclick = act(async () => {
      if (!confirm('Bu mahsulotni xonadondan olib tashlaysizmi?')) return;
      await api('DELETE', '/supplier-products/' + b.dataset.del);
      route();
    }); });
  },

  // ------------------------------------------------------------------ staff
  async staff(v) {
    const [rows, roles, sups] = await Promise.all([api('GET', '/staff'), api('GET', '/roles'), api('GET', '/suppliers')]);
    const roleOpts = roles.map((r) => [r.id, r.name]);
    const collectRoles = new Set(roles.filter((r) => r.permissions.includes('collect.shift')).map((r) => r.id));
    const form = (u = {}) => [
      { name: 'name', label: 'Ism familiya', value: u.name, required: true },
      { name: 'login', label: 'Login (telefon raqam yoki so\'z)', value: u.login, required: true, placeholder: '901234567' },
      { name: 'phone', label: 'Telefon', value: u.phone, inputmode: 'tel' },
      { name: 'password', label: u.id ? 'Yangi parol (o\'zgartirmaslik uchun bo\'sh)' : 'Parol (kamida 6 belgi)', type: 'password', required: !u.id },
      { name: 'roleId', label: 'Rol (ruxsatlar)', type: 'select', options: roleOpts, value: u.role_id ?? roles.find((r) => r.code === 'collector')?.id },
      { name: 'isTest', label: 'Test xodim (hisobotlarga kirmaydi, qurilma cheklovi yo\'q)', type: 'checkbox', value: u.is_test },
    ];
    const toBody = (d) => ({ ...d, roleId: Number(d.roleId), password: d.password || undefined });
    v.innerHTML = `
      <div class="card"><div class="row" style="justify-content:space-between"><h2>Xodimlar</h2><button id="add">+ Yangi xodim</button></div>
      <div class="table-wrap"><table>
        <tr><th>Ism</th><th>Login</th><th>Rol</th><th class="num">Yashirilgan</th><th>Qurilmalar</th><th>Oxirgi faollik</th><th></th></tr>
        ${rows.map((u) => `<tr ${u.active ? '' : 'class="muted"'}>
          <td>${esc(u.name)} ${u.is_test ? '<span class="badge test">test</span>' : ''}${u.active ? '' : ' (o\'chirilgan)'}<div class="muted">${esc(u.phone)}</div></td>
          <td><code>${esc(u.login)}</code></td><td>${esc(u.role_name)}</td>
          <td class="num">${collectRoles.has(u.role_id) ? (u.hidden_count || 0) : '—'}</td>
          <td><a href="#devices?user=${u.id}">${u.devices_bound} / ${u.device_slots}</a></td>
          <td>${esc(fmtDate(u.last_seen_at))}</td>
          <td class="row">${collectRoles.has(u.role_id) ? `<button class="small" data-assign="${u.id}">Xonadonlar</button>` : ''}
            <button class="small ghost" data-edit="${u.id}">Tahrirlash</button>
            <button class="small ghost" data-toggle="${u.id}">${u.active ? 'O\'chirish' : 'Yoqish'}</button>
            ${!u.active ? `<button class="small ghost" data-remove="${u.id}">Butunlay o'chirish</button>` : ''}</td></tr>`).join('')}
      </table></div></div>
      <div id="assign"></div>`;
    $('#add', v).onclick = () => openForm({ title: 'Yangi xodim', fields: form(), onSubmit: async (d) => { await api('POST', '/staff', toBody(d)); flash('Qo\'shildi. Unga 1 ta qurilma joyi ochildi.'); } });
    $$('[data-edit]', v).forEach((b) => { b.onclick = () => {
      const u = rows.find((x) => String(x.id) === b.dataset.edit);
      openForm({ title: `${u.name || u.login} — tahrirlash`, fields: form(u), onSubmit: async (d) => { await api('PATCH', `/staff/${u.id}`, toBody(d)); flash('Saqlandi'); } });
    }; });
    $$('[data-toggle]', v).forEach((b) => { b.onclick = act(async () => {
      const u = rows.find((x) => String(x.id) === b.dataset.toggle);
      if (u.active && !confirm(`${u.name || u.login} tizimga kira olmaydi. Davom etasizmi?`)) return;
      await api('PATCH', `/staff/${u.id}`, { active: !u.active });
      route();
    }); });
    $$('[data-remove]', v).forEach((b) => { b.onclick = act(async () => {
      const u = rows.find((x) => String(x.id) === b.dataset.remove);
      if (!confirmFor('entity_delete', `${u.name || u.login} tizimdan BUTUNLAY o'chiriladi. Bu amalni qaytarib bo'lmaydi. Davom etasizmi?`)) return;
      await api('DELETE', `/staff/${u.id}`);
      flash('Xodim butunlay o\'chirildi');
      route();
    }); });
    $$('[data-assign]', v).forEach((b) => { b.onclick = act(async () => {
      const id = b.dataset.assign;
      const u = rows.find((x) => String(x.id) === id);
      const hidden = await api('GET', `/staff/${id}/hidden`);
      const box = $('#assign', v);
      const active = sups.filter((s) => s.active);
      box.innerHTML = `<div class="card">
        <h2>${esc(u.name || u.login)} — xonadonlar ko'rinishi</h2>
        <p class="muted">Barcha xonadonlar bu xodimga avtomatik ko'rinadi. Ko'rsatmaslik (yashirish) kerak bo'lganlarini belgilang.</p>
        <input id="flt" placeholder="Ism yoki telefon bo'yicha qidirish..." style="width:100%;margin-bottom:8px">
        <div id="list">${active.map((s) => `<div class="row" data-id="${s.id}" data-name="${esc(s.name.toLowerCase())}" data-phone="${digits(s.phone)}" style="align-items:center;padding:4px 0">
          <label style="display:flex;gap:8px;align-items:center;color:var(--text);flex:1"><input type="checkbox" ${hidden.includes(s.id) ? 'checked' : ''}> ${esc(s.name)} <span class="muted">${esc(s.phone)} ${esc(s.address)}</span></label></div>`).join('')
          || '<p class="muted">Avval xonadon qo\'shing.</p>'}</div>
        <p><button id="saveAssign">Saqlash</button></p></div>`;
      $('#flt', box).oninput = (e) => {
        const t = e.target.value.toLowerCase();
        const d = digits(t);
        $$('#list > div', box).forEach((r) => { r.hidden = !!t && !r.dataset.name.includes(t) && !(d.length >= 2 && r.dataset.phone.includes(d)); });
      };
      $('#saveAssign', box).onclick = act(async () => {
        const ids = $$('#list > div', box).filter((r) => $('input', r).checked).map((r) => Number(r.dataset.id));
        await api('PUT', `/staff/${id}/hidden`, { supplierIds: ids });
        flash(ids.length ? `${ids.length} ta xonadon yashirildi` : 'Hamma xonadon ko\'rinadi');
        route();
      });
      box.scrollIntoView({ behavior: 'smooth' });
    }); });
  },

  // ------------------------------------------------------------------ devices
  async devices(v) {
    const userFilter = hashParams().get('user');
    const [rows, staff] = await Promise.all([api('GET', '/devices'), api('GET', '/staff')]);
    const list = userFilter ? staff.filter((u) => String(u.id) === userFilter) : staff.filter((u) => !u.is_test);
    v.innerHTML = `
      <div class="card"><h2>Qurilmalar</h2>
        ${userFilter ? '<p><a href="#devices">← Barcha xodimlar</a></p>' : ''}
      </div>
      ${list.map((u) => {
        const slots = rows.filter((d) => d.user_id === u.id);
        return `<div class="card"><div class="row" style="justify-content:space-between;align-items:center">
            <h2 style="margin:0">${esc(u.name || u.login)} <span class="muted">(${esc(u.login)})</span></h2>
            <button class="small" data-add="${u.id}">+ Joy qo'shish</button></div>
          <div class="table-wrap"><table><tr><th>Joy</th><th>Biriktirilgan qurilma</th><th>Biriktirilgan</th><th>Oxirgi faollik</th><th></th></tr>
          ${slots.map((d) => `<tr><td>${esc(d.name)}</td><td>${d.device_id ? `✅ ${esc(d.device_label)}` : '<span class="muted">bo\'sh — keyingi yangi qurilma shu yerga tushadi</span>'}</td>
            <td>${esc(fmtDate(d.bound_at))}</td><td>${esc(fmtDate(d.last_seen_at))}</td>
            <td class="row">${d.device_id ? `<button class="small ghost" data-free="${d.id}">Bo'shatish</button>` : ''}
              <button class="small ghost" data-rename="${d.id}">Nomi</button><button class="small ghost" data-del="${d.id}">O'chirish</button></td></tr>`).join('')
            || '<tr><td colspan="5" class="err">Qurilma joyi yo\'q — bu xodim hech qayerdan kira olmaydi</td></tr>'}
          </table></div></div>`;
      }).join('')}`;
    $$('[data-add]', v).forEach((b) => { b.onclick = act(async () => { await api('POST', '/devices', { userId: Number(b.dataset.add) }); route(); }); });
    $$('[data-free]', v).forEach((b) => { b.onclick = act(async () => {
      if (!confirm('Bu qurilma tizimdan chiqariladi. Davom etasizmi?')) return;
      await api('PATCH', `/devices/${b.dataset.free}`, { free: true });
      flash('Bo\'shatildi');
      route();
    }); });
    $$('[data-rename]', v).forEach((b) => { b.onclick = () => openForm({ title: 'Qurilma joyi nomi', fields: [{ name: 'name', label: 'Nomi', required: true, placeholder: 'Ali — Samsung A54' }],
      onSubmit: async (d) => { await api('PATCH', `/devices/${b.dataset.rename}`, d); } }); });
    $$('[data-del]', v).forEach((b) => { b.onclick = act(async () => {
      if (!confirm('Qurilma joyini o\'chirasizmi? Agar unga qurilma biriktirilgan bo\'lsa, u chiqarib yuboriladi.')) return;
      await api('DELETE', `/devices/${b.dataset.del}`);
      route();
    }); });
  },

  // ------------------------------------------------------------------ roles & permissions
  async roles(v) {
    const [roles, perms] = await Promise.all([api('GET', '/roles'), api('GET', '/permissions')]);
    const groups = [];
    for (const p of perms) {
      let g = groups.find((x) => x.name === p.group);
      if (!g) groups.push(g = { name: p.group, items: [] });
      g.items.push(p);
    }
    v.innerHTML = `
      <div class="card"><div class="row" style="justify-content:space-between"><h2>Rollar (ruxsatlar to'plami)</h2><button id="addRole">+ Yangi rol</button></div>
        <div class="table-wrap"><table><tr><th>Rol</th><th class="num">Ruxsatlar</th><th class="num">Xodimlar</th><th></th></tr>
        ${roles.map((r) => `<tr><td><b>${esc(r.name)}</b>${r.locked ? ' <span class="muted">(doim barcha ruxsatlar)</span>' : ''}</td>
          <td class="num">${r.permissions.length} / ${perms.length}</td><td class="num">${r.users}</td>
          <td class="row">${r.locked ? '' : `<button class="small" data-role="${r.id}">Ruxsatlarni sozlash</button>`}
            ${!r.code && !r.users ? `<button class="small ghost" data-delrole="${r.id}">O'chirish</button>` : ''}</td></tr>`).join('')}
        </table></div></div>
      <div id="roleEditor"></div>`;
    const editRole = (role) => {
      const box = $('#roleEditor', v);
      const cur = new Set(role?.permissions ?? []);
      box.innerHTML = `<form class="card" id="roleForm">
        <h2>${role ? `Rol: ${esc(role.name)}` : 'Yangi rol'}</h2>
        <label>Rol nomi <input name="name" required value="${esc(role?.name ?? '')}" placeholder="masalan: Katta omborchi"></label>
        ${groups.map((g) => `<fieldset style="border:1px solid var(--line);border-radius:8px;margin:10px 0;padding:8px 12px">
          <legend><b>${esc(g.name)}</b> <button type="button" class="small ghost" data-all="${esc(g.name)}">hammasi</button></legend>
          <div class="checks" style="max-height:none">${g.items.map((p) => `<label title="${esc(p.hint ?? '')}"><input type="checkbox" name="perm" value="${p.key}" data-group="${esc(g.name)}" ${cur.has(p.key) ? 'checked' : ''}> ${esc(p.label)}</label>`).join('')}</div>
        </fieldset>`).join('')}
        <div class="row"><button>Saqlash</button><button type="button" class="ghost" id="cancelRole">Yopish</button></div>
      </form>`;
      $$('[data-all]', box).forEach((b) => { b.onclick = () => {
        const boxes = $$(`input[data-group="${CSS.escape(b.dataset.all)}"]`, box);
        const on = !boxes.every((x) => x.checked);
        boxes.forEach((x) => { x.checked = on; });
      }; });
      $('#cancelRole', box).onclick = () => { box.innerHTML = ''; };
      $('#roleForm', box).onsubmit = act(async (e) => {
        e.preventDefault();
        const body = { name: e.target.elements.name.value, permissions: $$('input[name=perm]:checked', box).map((x) => x.value) };
        if (role) await api('PATCH', `/roles/${role.id}`, body); else await api('POST', '/roles', body);
        flash('Rol saqlandi');
        route();
      });
      box.scrollIntoView({ behavior: 'smooth' });
    };
    $('#addRole', v).onclick = () => editRole(null);
    $$('[data-role]', v).forEach((b) => { b.onclick = () => editRole(roles.find((r) => String(r.id) === b.dataset.role)); });
    $$('[data-delrole]', v).forEach((b) => { b.onclick = act(async () => {
      if (!confirm('Rolni o\'chirasizmi?')) return;
      await api('DELETE', `/roles/${b.dataset.delrole}`);
      route();
    }); });
  },

  // ------------------------------------------------------------------ products
  async catalog(v) {
    const prods = await api('GET', '/products');
    v.innerHTML = `<div class="card" style="max-width:720px"><div class="row" style="justify-content:space-between"><h2>Mahsulotlar</h2><button id="add">+ Mahsulot</button></div>
      <table><tr><th>Nomi</th><th>Birlik</th><th></th></tr>
      ${prods.map((r) => `<tr ${r.active ? '' : 'class="muted"'}><td>${esc(r.name)}</td><td>${esc(r.unit)}</td>
        <td class="row"><button class="small ghost" data-edit="${r.id}">Tahrirlash</button>
          <button class="small ghost" data-toggle="${r.id}">${r.active ? 'O\'chirish' : 'Yoqish'}</button></td></tr>`).join('') || '<tr><td colspan="3" class="muted">Ro\'yxat bo\'sh</td></tr>'}</table></div>`;
    const fields = (r = {}) => [{ name: 'name', label: 'Nomi', value: r.name, required: true, placeholder: 'Yog\'li sut' }, { name: 'unit', label: 'O\'lchov birligi', value: r.unit ?? 'kg' }];
    $('#add', v).onclick = () => openForm({ title: 'Yangi mahsulot', fields: fields(), onSubmit: async (d) => { await api('POST', '/products', d); flash('Qo\'shildi'); } });
    $$('[data-edit]', v).forEach((b) => { b.onclick = () => {
      const r = prods.find((x) => String(x.id) === b.dataset.edit);
      openForm({ title: 'Tahrirlash', fields: fields(r), onSubmit: async (d) => { await api('PATCH', `/products/${r.id}`, d); flash('Saqlandi'); } });
    }; });
    $$('[data-toggle]', v).forEach((b) => { b.onclick = act(async () => {
      const r = prods.find((x) => String(x.id) === b.dataset.toggle);
      await api('PATCH', `/products/${r.id}`, { active: !r.active });
      route();
    }); });
  },

  // ------------------------------------------------------------------ in-browser app tester
  async tester(v) {
    const staff = can('staff.manage') ? await api('GET', '/staff') : [];
    const testers = staff.filter((e) => e.is_test && e.active);
    v.innerHTML = `<div class="grid2">
      <div class="card">
        <h2>Ilovani noutbukda sinash</h2>
        <p>O'ngda — telefondagi ilova bilan <b>aynan bir xil</b> ilova, faqat brauzerda ishlaydi. Har qanday xodim login/paroli bilan kirib, uning ko'rinishini tekshirish mumkin.</p>
        <ol>
          <li><b>Test xodim</b> bilan kiring — yozuvlari hisobotlarga kirmaydi va qurilma cheklovi yo'q.</li>
          <li>Haqiqiy xodim bilan kirsangiz, bu brauzer uning qurilma joylaridan birini egallaydi.</li>
          <li>kg ni noutbuk klaviaturasidan yozib, Enter bosishingiz mumkin. Oflayn: F12 → Network → "Offline".</li>
        </ol>
        ${can('staff.manage') ? `<p><b>Test xodimlar:</b> ${testers.map((e) => `${esc(e.name)} — <code>${esc(e.login)}</code>`).join(', ') || '<span class="muted">yo\'q</span>'}</p>` : ''}
        <div class="row">
          ${can('staff.manage') ? '<button id="mk">+ Test xodim yaratish</button><button class="ghost" id="clr">Test ma\'lumotlarini tozalash</button>' : ''}
          <a href="/app/" target="_blank" rel="noopener"><button class="ghost" type="button">Alohida oynada ochish ↗</button></a>
        </div>
      </div>
      <div class="card"><div class="phone"><iframe src="/app/" title="Yaya ilovasi"></iframe></div></div>
    </div>`;
    const roles = can('staff.manage') ? await api('GET', '/roles') : [];
    $('#mk', v) && ($('#mk', v).onclick = () => openForm({
      title: 'Test xodim',
      fields: [
        { name: 'name', label: 'Ism', value: 'Test', required: true },
        { name: 'login', label: 'Login', value: '900000000', required: true },
        { name: 'password', label: 'Parol', value: '111111', required: true },
        { name: 'roleId', label: 'Rol', type: 'select', options: roles.map((r) => [r.id, r.name]), value: roles.find((r) => r.code === 'collector')?.id },
      ],
      onSubmit: async (d) => { await api('POST', '/staff', { ...d, roleId: Number(d.roleId), isTest: true }); flash('Test xodim yaratildi.'); },
    }));
    $('#clr', v) && ($('#clr', v).onclick = act(async () => {
      if (!confirm('Test xodimlar kiritgan barcha smena va to\'lovlar o\'chiriladi. Davom etasizmi?')) return;
      const r = await api('DELETE', '/test-data');
      flash(`${r.deleted} ta test yozuv o'chirildi`);
    }));
  },

  // ------------------------------------------------------------------ settings, data, audit
  // ------------------------------------------------------------------ integrations (Telegram bots)
  async integrations(v) {
    const s = await api('GET', '/integrations');
    const ck = (name, label, checked) => `<label style="display:flex;gap:8px;align-items:center;color:var(--text)"><input type="checkbox" name="${name}" ${checked ? 'checked' : ''}> ${label}</label>`;
    const on = (x) => x !== '0' && x !== '' && x != null;
    v.innerHTML = `
      <div class="card" style="max-width:820px"><h2>📨 Xonadon boti</h2>
        <p class="muted">Ulangan xonadonlar: <b>${s.hh_linked}</b>.</p>
        <form id="hhForm">
          ${ck('hh_enabled', 'Bot yoqilgan', on(s.hh_enabled))}
          <label>Bot tokeni <input name="hh_token" value="${esc(s.hh_token)}" placeholder="123456:ABC..." autocomplete="off"></label>
          <div class="row"><button type="button" class="ghost small" id="hhCheck">Tokenni tekshirish</button><span id="hhCheckRes" class="muted"></span></div>
          <label>Tashkilot nomi (botda ko'rinadi) <input name="hh_org" value="${esc(s.hh_org)}" placeholder="${esc(brand.companyName || 'Yaya')}"></label>
          <div style="margin-top:8px"><b>Qaysi xabarlar yuborilsin</b>
            ${ck('hh_m_purchase', 'Xaridlar', on(s.hh_m_purchase))}${ck('hh_m_payment', "To'lovlar", on(s.hh_m_payment))}
            ${ck('hh_m_void', 'Bekor qilingan to\'lovlar', on(s.hh_m_void))}${ck('hh_m_balance', 'Balans tahrirlanishi', on(s.hh_m_balance))}</div>
          <div style="margin-top:8px"><b>Xarid xabari tarkibi</b>
            ${ck('hh_f_number', 'Xarid raqami', on(s.hh_f_number))}${ck('hh_f_time', 'Vaqt', on(s.hh_f_time))}${ck('hh_f_collector', 'Sut yig\'uvchi', on(s.hh_f_collector))}
            ${ck('hh_f_unitprice', 'Mahsulot narxi', on(s.hh_f_unitprice))}${ck('hh_f_linetotal', 'Mahsulot umumiy narxi', on(s.hh_f_linetotal))}
            ${ck('hh_f_qty', 'Jami miqdor', on(s.hh_f_qty))}${ck('hh_f_sum', 'Jami summa', on(s.hh_f_sum))}${ck('hh_f_balance', 'Hozirgi balans', on(s.hh_f_balance))}</div>
          <div style="margin-top:8px"><b>To'lov xabari tarkibi</b>
            ${ck('hh_p_number', 'To\'lov raqami', on(s.hh_p_number))}${ck('hh_p_time', 'Vaqt', on(s.hh_p_time))}${ck('hh_p_who', 'To\'lov qildi', on(s.hh_p_who))}</div>
          <label style="margin-top:8px">Kirish (xush kelibsiz) xabari <textarea name="hh_welcome" rows="2">${esc(s.hh_welcome)}</textarea></label>
          <p class="muted"><code>{org}</code> — tashkilot nomiga almashtiriladi.</p>
          <label>Ro'yxatdan o'tgani xabari <textarea name="hh_registered" rows="2">${esc(s.hh_registered)}</textarea></label>
          <label>Ro'yxatdan o'tishda xatolik (raqam topilmadi) <textarea name="hh_regerror" rows="2">${esc(s.hh_regerror)}</textarea></label>
          <button>Saqlash</button>
        </form>
      </div>
      <div class="card" style="max-width:820px"><h2>🔐 Backup (zaxira) boti</h2>
        <form id="bkForm">
          ${ck('bk_enabled', 'Bot yoqilgan (har kuni avtomatik yuborish)', on(s.bk_enabled))}
          <label>Bot tokeni <input name="bk_token" value="${esc(s.bk_token)}" placeholder="123456:ABC..." autocomplete="off"></label>
          <div class="row"><button type="button" class="ghost small" id="bkCheck">Tokenni tekshirish</button><span id="bkCheckRes" class="muted"></span></div>
          <label>Admin ID <input name="bk_admin_id" value="${esc(s.bk_admin_id)}" placeholder="masalan: 123456789"></label>
          <label>Kanal ID <input name="bk_channel_id" value="${esc(s.bk_channel_id)}" placeholder="masalan: -1001234567890"></label>
          <label>Zaxira paroli <input name="bk_password" value="${esc(s.bk_password)}" autocomplete="off"></label>
          <label>Yuborish vaqti (soat:daqiqa) <input name="bk_time" value="${esc(s.bk_time)}" placeholder="00:00" style="width:120px"></label>
          <div class="row"><button>Saqlash</button><button type="button" class="ghost" id="bkNow">Hozir yuborish</button><span id="bkNowRes" class="muted"></span></div>
        </form>
      </div>`;
    const collect = (form) => {
      const data = {};
      for (const el of form.elements) {
        if (!el.name) continue;
        data[el.name] = el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value;
      }
      return data;
    };
    $('#hhForm', v).onsubmit = act(async (e) => { e.preventDefault(); await api('PUT', '/integrations', collect(e.target)); flash('Saqlandi'); });
    $('#bkForm', v).onsubmit = act(async (e) => { e.preventDefault(); await api('PUT', '/integrations', collect(e.target)); flash('Saqlandi'); });
    const check = (tokenInput, resEl) => act(async () => {
      resEl.textContent = 'Tekshirilmoqda...';
      const r = await api('POST', '/integrations/check', { token: tokenInput.value });
      resEl.textContent = r.ok ? `✓ @${r.username}` : `✗ ${r.error}`;
      resEl.style.color = r.ok ? 'var(--ok)' : 'var(--err)';
    });
    $('#hhCheck', v).onclick = check($('[name=hh_token]', v), $('#hhCheckRes', v));
    $('#bkCheck', v).onclick = check($('[name=bk_token]', v), $('#bkCheckRes', v));
    $('#bkNow', v).onclick = act(async () => {
      const res = $('#bkNowRes', v); res.textContent = 'Yuborilmoqda...';
      await api('PUT', '/integrations', collect($('#bkForm', v))); // save first so token/password are current
      const r = await api('POST', '/integrations/backup/now');
      if (r.results) res.innerHTML = r.results.map((x) => `<span style="color:${x.ok ? 'var(--ok)' : 'var(--err)'}">${x.label}: ${x.ok ? '✓' : '✗ ' + esc(x.error || '')}</span>`).join(' · ');
      else { res.textContent = r.ok ? '✓ yuborildi' : `✗ ${r.error || 'xatolik'}`; res.style.color = r.ok ? 'var(--ok)' : 'var(--err)'; }
    });
  },

  // ------------------------------------------------------------------ laboratory fields
  async lab(v) {
    const fields = await api('GET', '/lab/fields');
    const typeLabel = (f) => (f.type === 'variant' ? 'Variant (Bor/Yo\'q)' : 'Raqam');
    const limitText = (f) => {
      if (f.type === 'variant') {
        const a = f.amount_on ? `Bor: ${f.amount_max != null ? `max ${f.amount_max} kg` : 'miqdor erkin'}` : '';
        if (a) return a;
        return f.bad_option ? `"${f.bad_option === 'bor' ? 'Bor' : 'Yo\'q'}" bo'lsa limitdan o'tgan` : 'erkin';
      }
      const p = [];
      if (f.limit_min != null) p.push(`min ${f.limit_min}`);
      if (f.limit_max != null) p.push(`max ${f.limit_max}`);
      return p.length ? p.join(' · ') : 'erkin';
    };
    v.innerHTML = `
      <div class="card"><div class="row" style="justify-content:space-between"><h2>Laboratoriya maydonlari</h2><button id="add">+ Yangi maydon</button></div>
        <p class="muted">Laborant har bir <b>qabul qilingan</b> smenaga shu qiymatlarni ilovadagi "Laborant" bo'limida kiritadi. Limitdan o'tsa — smena qizil ramkada belgilanadi va admin ko'rib qabul qilmaguncha shunday turadi. Bu yerda faqat maydonlar sozlanadi, kunlik ma'lumot kiritilmaydi.</p>
        <div class="table-wrap"><table>
          <tr><th>Maydon</th><th>Turi</th><th>Limit</th><th></th></tr>
          ${fields.map((f) => `<tr><td><b>${esc(f.name)}</b></td><td>${typeLabel(f)}</td><td>${limitText(f)}</td>
            <td class="row"><button class="small ghost" data-edit="${f.id}">Tahrirlash</button><button class="small ghost" data-del="${f.id}">O'chirish</button></td></tr>`).join('')
            || '<tr><td colspan="4" class="muted">Hali maydon yo\'q. Masalan: Жир, Вода, Кислотист (raqam) yoki Антибиотик, Мастит (Bor/Yo\'q).</td></tr>'}
        </table></div></div>`;
    const form = (f = {}) => [
      { name: 'name', label: 'Nomi', value: f.name, required: true },
      { name: 'type', label: 'Turi', type: 'select', value: f.type || 'number', options: [['number', 'Raqam (masalan 3.65)'], ['variant', 'Variant (Bor / Yo\'q)']] },
      { name: 'limitMin', label: 'Limit — eng kam (ixtiyoriy, faqat raqam uchun)', type: 'number', step: 'any', value: f.limit_min },
      { name: 'limitMax', label: 'Limit — eng ko\'p (ixtiyoriy, faqat raqam uchun)', type: 'number', step: 'any', value: f.limit_max },
      { name: 'badOption', label: 'Variant uchun: qaysi javob "limitdan o\'tgan" hisoblansin', type: 'select', value: f.bad_option || '', options: [['', 'Erkin (limit yo\'q)'], ['bor', '"Bor" bo\'lsa'], ['yoq', '"Yo\'q" bo\'lsa']] },
      { name: 'amountOn', label: 'Variant uchun: "Bor" tanlanganda miqdor (kg) kiritilsinmi', type: 'select', value: f.amount_on ? '1' : '0', options: [['0', 'Yo\'q'], ['1', 'Ha — miqdor maydoni ochilsin']] },
      { name: 'amountMax', label: 'Miqdor limiti — eng ko\'p kg (bo\'sh = cheklovsiz)', type: 'number', step: 'any', value: f.amount_max },
    ];
    $('#add', v).onclick = () => openForm({ title: 'Yangi laboratoriya maydoni', fields: form(), onSubmit: async (d) => { await api('POST', '/lab/fields', d); flash('Qo\'shildi'); } });
    $$('[data-edit]', v).forEach((b) => { b.onclick = () => { const f = fields.find((x) => String(x.id) === b.dataset.edit); openForm({ title: 'Maydonni tahrirlash', fields: form(f), onSubmit: async (d) => { await api('PATCH', `/lab/fields/${f.id}`, d); flash('Saqlandi'); } }); }; });
    $$('[data-del]', v).forEach((b) => { b.onclick = act(async () => { if (!confirm('Bu maydon o\'chirilsinmi? Eski yozuvlarga ta\'sir qilmaydi.')) return; await api('DELETE', `/lab/fields/${b.dataset.del}`); flash('O\'chirildi'); route(); }); });
  },

  async settings(v) {
    const st = can('settings.manage') ? await api('GET', '/settings') : null;
    const safety = can('data.backup') ? await api('GET', '/data/safety') : [];
    v.innerHTML = `
      ${st ? `<div class="card" style="max-width:760px">
        <h2>Brend</h2>
        <form id="brandForm">
          <label>Kompaniya nomi <input name="companyName" value="${esc(st.companyName)}" maxlength="60"></label>
          <label>Salomlashish matni <input name="greeting" value="${esc(st.greeting || '')}" maxlength="120" placeholder="Assalomu alaykum, {ism}"></label>
          <p class="muted"><code>{ism}</code> — foydalanuvchining ismiga almashtiriladi.</p>
          <label style="display:flex;gap:8px;align-items:center;color:var(--text)"><input type="checkbox" name="locationEnabled" ${st.locationEnabled ? 'checked' : ''}> Xarita rejimi</label>
          <label style="display:flex;gap:8px;align-items:center;color:var(--text)"><input type="checkbox" name="cancelEnabled" ${st.cancelEnabled ? 'checked' : ''}> "Bekor qilish" rejimi</label>
          <div style="margin-top:10px"><b>Ro'yxat sozlamalari</b><p class="muted" style="margin:2px 0 6px">Smena ochilganda xonadonlar ro'yxatida nimalar ko'rinsin:</p>
            <label style="display:flex;gap:8px;align-items:center;color:var(--text)"><input type="checkbox" name="lf_name" ${st.listFields.name ? 'checked' : ''}> Xonadon ismi</label>
            <label style="display:flex;gap:8px;align-items:center;color:var(--text)"><input type="checkbox" name="lf_address" ${st.listFields.address ? 'checked' : ''}> Manzili</label>
            <label style="display:flex;gap:8px;align-items:center;color:var(--text)"><input type="checkbox" name="lf_phone" ${st.listFields.phone ? 'checked' : ''}> Telefon raqami</label>
          </div>
          <div style="margin-top:10px"><b>Nusxalash sozlamalari</b><p class="muted" style="margin:2px 0 6px">Yopilgan smenani "Nusxalash"da nimalar bo'lsin:</p>
            <label style="display:flex;gap:8px;align-items:center;color:var(--text)"><input type="checkbox" name="cf_product" ${st.copyFields.product ? 'checked' : ''}> Mahsulot</label>
            <label style="display:flex;gap:8px;align-items:center;color:var(--text)"><input type="checkbox" name="cf_household" ${st.copyFields.household ? 'checked' : ''}> Xonadon</label>
            <label style="display:flex;gap:8px;align-items:center;color:var(--text)"><input type="checkbox" name="cf_qty" ${st.copyFields.qty ? 'checked' : ''}> Miqdori</label>
            <label style="display:flex;gap:8px;align-items:center;color:var(--text)"><input type="checkbox" name="cf_price" ${st.copyFields.price ? 'checked' : ''}> Narxi</label>
          </div>
          <div style="margin-top:10px"><b>Tasdiq so'rovlari</b><p class="muted" style="margin:2px 0 6px">Belgilangan amallarda "Ha yoki Yo'q" so'raladi. Olib tashlansa — darhol bajariladi.</p>
            ${[['open','Smena ochish'],['close','Smena yopish'],['accept','Qabul qilish'],['cancel','Bekor qilish'],['edit','Tahrirlash'],['payment','To\'lov qo\'shish'],['delete','Yozuvni o\'chirish'],['copy_cancelled','Bekor qilingan smenani nusxalash'],['entity_delete','Xodim yoki xonadon o\'chirish']]
              .map(([k, t]) => `<label style="display:flex;gap:8px;align-items:center;color:var(--text)"><input type="checkbox" name="cfm_${k}" ${(st.confirms || {})[k] !== false ? 'checked' : ''}> ${t}</label>`).join('')}
          </div>
          <div style="margin-top:10px"><b>Smenani tahrirlash</b>
            <label style="display:flex;gap:8px;align-items:center;color:var(--text)"><input type="checkbox" name="editClosed" ${st.editClosed ? 'checked' : ''}> Qabul qilinmagan smenani tahrirlashga ruxsat</label>
          </div>
          <div style="margin-top:10px"><b>Farqlar bilan ishlash</b>
            <label style="display:flex;gap:8px;align-items:center;color:var(--text)"><input type="checkbox" name="diffEnabled" ${st.diff?.enabled ? 'checked' : ''}> Yoqilgan</label>
            <div class="row" style="gap:12px;margin-top:6px">
              <label>Farq limiti — Ko'p (+ kg) <input name="diffOver" type="number" min="0" step="0.1" value="${st.diff?.over ?? ''}" placeholder="cheksiz" style="width:120px"></label>
              <label>Kam (− kg) <input name="diffUnder" type="number" min="0" step="0.1" value="${st.diff?.under ?? ''}" placeholder="cheksiz" style="width:120px"></label>
            </div>
          </div>
          <button>Saqlash</button>
        </form>
        <div class="row" style="align-items:center;margin-top:12px">
          <div class="logo-preview">${brand.logoUrl ? `<img src="${esc(brand.logoUrl)}" alt="Logo">` : '<span class="muted">Logo yo\'q</span>'}</div>
          <div><label style="display:inline-block"><input type="file" id="logoFile" accept="image/png,image/jpeg,image/webp" hidden><span class="btnlike">⬆ Logo yuklash</span></label>
            ${brand.logoUrl ? '<button class="ghost" id="logoDel">Logoni olib tashlash</button>' : ''}</div>
        </div>
        <hr style="border:0;border-top:1px solid var(--line);margin:16px 0">
        <h2>Kirish animatsiyasi</h2>
        <div class="row" style="align-items:center">
          <div class="intro-preview">${st.hasIntro ? `<video src="${esc(brand.introUrl || '/api/public/intro')}" muted autoplay loop playsinline></video>` : '<span class="muted">Yo\'q</span>'}</div>
          <div><label style="display:inline-block"><input type="file" id="introFile" accept="video/mp4,video/webm" hidden><span class="btnlike">⬆ Video yuklash</span></label>
            ${st.hasIntro ? '<button class="ghost" id="introDel">Olib tashlash</button>' : ''}</div>
        </div>
      </div>
      <form class="card" id="meForm" style="max-width:520px">
        <h2>Mening hisobim</h2>
        <label>Ism <input name="name" value="${esc(me.name || '')}" maxlength="120"></label>
        <label>Login <input name="login" value="${esc(me.login)}" minlength="3" maxlength="32"></label>
        <p class="muted">Login va parolingizni o'zgartirsangiz, keyingi kirishda yangisidan foydalaning.</p>
        <button>Ism va loginni saqlash</button>
      </form>` : ''}
      <form class="card" id="pw" style="max-width:520px">
        <h2>Parolni o'zgartirish</h2>
        <label>Joriy parol <input name="current" type="password" required autocomplete="current-password"></label>
        <label>Yangi parol (kamida 6 belgi) <input name="next" type="password" required minlength="6" autocomplete="new-password"></label>
        <button>O'zgartirish</button>
      </form>
      ${can('data.backup') ? `
      <div class="card" style="max-width:760px">
        <h2>🔐 Zaxira nusxa (barcha ma'lumotlar)</h2>
        <p class="muted">Butun tizim — xodimlar, rollar, xonadonlar, narxlar, smenalar, to'lovlar, jurnal, logo — bitta <b>.yaya</b> faylga yoziladi
          va siz tanlagan parol bilan <b>AES-256</b> shifrlanadi. Parolsiz faylni hech kim ocha olmaydi. Yangi serverga ko'chishda shu faylni import qilasiz.</p>
        <form id="expForm" class="row" style="align-items:end">
          <label>Admin parolingiz <input name="password" type="password" required autocomplete="current-password"></label>
          <label>Zaxira paroli (kamida 8 belgi) <input name="backupPassword" type="password" required minlength="8" autocomplete="new-password"></label>
          <label>Zaxira parolini takrorlang <input name="backupPassword2" type="password" required minlength="8" autocomplete="new-password"></label>
          <button>⬇ Zaxirani yuklab olish</button>
        </form>
        <p class="warn">Zaxira parolini unutmang — u tiklanmaydi.</p>
        <hr style="border:0;border-top:1px solid var(--line);margin:16px 0">
        <h2>⬆ Zaxiradan tiklash (import)</h2>
        <p class="muted">Hozirgi BARCHA ma'lumotlar fayldagilar bilan almashtiriladi. Oldin avtomatik nusxa olinadi (3 kun saqlanadi).</p>
        <form id="impForm" class="row" style="align-items:end">
          <label>Zaxira fayli (.yaya) <input name="file" type="file" accept=".yaya" required></label>
          <label>Zaxira paroli <input name="backupPassword" type="password" required autocomplete="off"></label>
          <label>Admin parolingiz <input name="password" type="password" required autocomplete="current-password"></label>
          <label>Tasdiqlash uchun <b>TIKLASH</b> deb yozing <input name="confirm" required autocomplete="off"></label>
          <button class="danger">Tiklash</button>
        </form>
      </div>
      <div class="card danger-zone" style="max-width:760px">
        <h2>⚠️ Barcha hisobotlar tarixini tozalash</h2>
        <div id="wipe"></div>
      </div>
      <div class="card" style="max-width:760px">
        <h2>Avtomatik zaxiralar (3 kun ichida tiklash mumkin)</h2>
        <table><tr><th>#</th><th>Sabab</th><th>Kim</th><th>Qachon</th><th>Muddati</th><th></th></tr>
        ${safety.map((s) => `<tr><td>${s.id}</td><td>${esc(s.reason)}</td><td>${esc(String(s.created_by).replace(/^\w+:/, ''))}</td><td>${esc(fmtDate(s.created_at))}</td>
          <td>${esc(fmtDate(s.expires_at))}</td><td><button class="small ghost" data-restore="${s.id}">Tiklash</button></td></tr>`).join('')
          || '<tr><td colspan="6" class="muted">Yo\'q</td></tr>'}</table>
      </div>` : ''}
      ${can('audit.view') ? '<div class="card"><div class="row" style="justify-content:space-between"><h2>Harakatlar jurnali</h2><button class="ghost" id="auditCsv">⬇ Excel (CSV)</button></div><div id="audit" class="table-wrap"><p class="muted">Yuklanmoqda...</p></div></div>' : ''}`;

    $('#pw', v).onsubmit = act(async (e) => {
      e.preventDefault();
      await api('PUT', '/password', Object.fromEntries(new FormData(e.target)), '/api/auth');
      e.target.reset();
      flash('Parol o\'zgartirildi');
    });
    if (st) {
      $('#brandForm', v).onsubmit = act(async (e) => {
        e.preventDefault();
        const f = e.target.elements;
        await api('PUT', '/settings', {
          companyName: f.companyName.value, greeting: f.greeting.value,
          locationEnabled: f.locationEnabled.checked, cancelEnabled: f.cancelEnabled.checked,
          listFields: { name: f.lf_name.checked, address: f.lf_address.checked, phone: f.lf_phone.checked },
          copyFields: { product: f.cf_product.checked, household: f.cf_household.checked, qty: f.cf_qty.checked, price: f.cf_price.checked },
          confirms: Object.fromEntries(['open','close','accept','cancel','edit','payment','delete','copy_cancelled','entity_delete'].map((k) => [k, f['cfm_' + k].checked])),
          editClosed: f.editClosed.checked,
          diff: { enabled: f.diffEnabled.checked, over: f.diffOver.value, under: f.diffUnder.value },
        });
        await loadBrand();
        flash('Saqlandi');
      });
      $('#meForm', v).onsubmit = act(async (e) => {
        e.preventDefault();
        const r = await api('PUT', '/profile', { name: e.target.elements.name.value, login: e.target.elements.login.value }, '/api/auth');
        me = r.user;
        $('#whoami').textContent = `${me.name || me.login} · ${me.role}`;
        flash('Saqlandi');
      });
      $('#introFile', v).onchange = act(async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        if (file.size > 10 * 1024 * 1024) return flash('Fayl 10 MB dan katta', 'err');
        await api('PUT', '/settings/intro', { dataUrl: await fileToDataUrl(file) });
        await loadBrand();
        flash('Kirish animatsiyasi yangilandi');
        route();
      });
      $('#introDel', v) && ($('#introDel', v).onclick = act(async () => { await api('DELETE', '/settings/intro'); await loadBrand(); route(); }));
      $('#logoFile', v).onchange = act(async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        await api('PUT', '/settings/logo', { dataUrl: await squarePng(file, 512) });
        await loadBrand();
        flash('Logo yangilandi');
        route();
      });
      $('#logoDel', v) && ($('#logoDel', v).onclick = act(async () => { await api('DELETE', '/settings/logo'); await loadBrand(); route(); }));
    }
    if (can('data.backup')) {
      $('#expForm', v).onsubmit = act(async (e) => {
        e.preventDefault();
        const d = Object.fromEntries(new FormData(e.target));
        if (d.backupPassword !== d.backupPassword2) throw new Error('Zaxira parollari bir xil emas');
        await download('POST', '/data/export', `yaya_zaxira_${todayLocal()}.yaya`, { password: d.password, backupPassword: d.backupPassword });
        e.target.reset();
        flash('Zaxira yuklab olindi. Faylni va parolni xavfsiz joyda saqlang.');
      });
      $('#impForm', v).onsubmit = act(async (e) => {
        e.preventDefault();
        const f = e.target.elements;
        if (!confirm('Hozirgi barcha ma\'lumotlar fayldagilar bilan almashtiriladi. Ishonchingiz komilmi?')) return;
        const r = await api('POST', '/data/import', { file: await fileToBase64(f.file.files[0]), backupPassword: f.backupPassword.value, password: f.password.value, confirm: f.confirm.value });
        flash(`Tiklandi (zaxira sanasi: ${fmtDate(r.exportedAt)}). Avvalgi holat #${r.safety} sifatida 3 kun saqlanadi.`);
        setTimeout(() => location.reload(), 1500);
      });
      wipeWizard($('#wipe', v));
      $$('[data-restore]', v).forEach((b) => { b.onclick = () => openForm({
        title: `Zaxira #${b.dataset.restore} dan tiklash`, danger: true, submit: 'Tiklash',
        intro: '<p class="warn">Hozirgi holat ham avtomatik saqlanadi (3 kun).</p>',
        fields: [{ name: 'password', label: 'Admin parolingiz', type: 'password', required: true }],
        onSubmit: async (d) => { await api('POST', `/data/safety/${b.dataset.restore}/restore`, d); flash('Tiklandi'); },
      }); });
    }
    if (can('audit.view')) {
      $('#auditCsv', v).onclick = act(() => download('GET', '/audit/export.csv', `yaya_jurnal_${todayLocal()}.csv`));
      const log = await api('GET', '/audit');
      $('#audit', v).innerHTML = `<table><tr><th>Vaqt</th><th>Kim</th><th>Nima bo'ldi</th></tr>
        ${log.map((a) => `<tr><td style="white-space:nowrap">${esc(fmtDate(a.at))}</td><td>${esc(a.who)}</td><td>${esc(a.what)}</td></tr>`).join('')}</table>`;
    }
  },
};

// Three deliberate steps before history is wiped: understand, prove you are a
// person (arithmetic), confirm with your password and the exact phrase.
function wipeWizard(box) {
  let step = 1;
  let ch = null;
  const render = () => {
    if (step === 1) {
      box.innerHTML = `<p class="err"><b>Diqqat!</b> Barcha smenalar, sut yozuvlari, to'lovlar va hisobotlar o'chiriladi.
        Xodimlar, xonadonlar, narxlar va sozlamalar qoladi.</p>
        <p class="muted">Tozalashdan oldin avtomatik zaxira olinadi va <b>3 kun</b> ichida tiklash mumkin. Shundan keyin qaytarib bo'lmaydi.
          Avval "Zaxirani yuklab olish" orqali o'zingizda ham nusxa saqlashni tavsiya qilamiz.</p>
        <label style="display:flex;gap:8px;align-items:center;color:var(--text)"><input type="checkbox" id="w1"> Tushundim, davom etmoqchiman</label>
        <p><button class="danger" id="wNext" disabled>Davom etish (1/3)</button></p>`;
      $('#w1', box).onchange = (e) => { $('#wNext', box).disabled = !e.target.checked; };
      $('#wNext', box).onclick = act(async () => { ch = await api('GET', '/data/challenge'); step = 2; render(); });
    } else if (step === 2) {
      box.innerHTML = `<p>Siz bot emasligingizni tasdiqlang: <b style="font-size:20px">${esc(ch.question)}</b></p>
        <div class="row" style="align-items:end"><label>Javob <input id="w2" inputmode="numeric" autocomplete="off"></label>
        <button class="danger" id="wNext">Davom etish (2/3)</button><button class="ghost" id="wBack">Bekor</button></div>`;
      $('#wBack', box).onclick = () => { step = 1; render(); };
      $('#wNext', box).onclick = () => { ch.answer = $('#w2', box).value; step = 3; render(); };
    } else {
      box.innerHTML = `<form class="row" style="align-items:end" id="wf">
        <label>Admin parolingiz <input name="password" type="password" required autocomplete="current-password"></label>
        <label>Aynan <b>${esc(ch.phrase)}</b> deb yozing <input name="confirm" required autocomplete="off"></label>
        <label style="display:flex;gap:8px;align-items:center;color:var(--text)"><input type="checkbox" name="resetOpening"> Boshlang'ich qarzlarni ham nolga tushirish</label>
        <button class="danger">TOZALASH (3/3)</button><button type="button" class="ghost" id="wBack">Bekor</button></form>`;
      $('#wBack', box).onclick = () => { step = 1; render(); };
      $('#wf', box).onsubmit = act(async (e) => {
        e.preventDefault();
        const f = e.target.elements;
        try {
          const r = await api('POST', '/data/wipe', { password: f.password.value, confirm: f.confirm.value, resetOpening: f.resetOpening.checked, challengeId: ch.id, answer: ch.answer });
          flash(`Tarix tozalandi. Tiklash nusxasi #${r.safety} — 3 kun saqlanadi.`);
          route();
        } catch (err) {
          step = 1;
          render();
          throw err;
        }
      });
    }
  };
  render();
}

// Fit any picture into a square transparent PNG, so it works as an app icon too.
function squarePng(file, size) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = Object.assign(document.createElement('canvas'), { width: size, height: size });
      const k = Math.min(size / img.width, size / img.height);
      const w = img.width * k;
      const h = img.height * k;
      c.getContext('2d').drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('Rasmni o\'qib bo\'lmadi'));
    img.src = URL.createObjectURL(file);
  });
}

// Read a file (video/gif) as a data URL to upload.
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('Faylni o\'qib bo\'lmadi'));
    r.readAsDataURL(file);
  });
}

// Excel import: choose file -> server preview (nothing saved) -> confirm -> apply.
function importFlow(box) {
  box.innerHTML = `<div class="card"><h2>Excel'dan import</h2>
    <ol class="muted"><li>"⬇ Excel'ga eksport" (hozirgi ro'yxat) yoki "⬇ Bo'sh shablon" ni yuklab oling va to'ldiring. Yo'riqnoma shablonning 2-varag'ida.</li>
      <li>Faylni tanlang — avval tekshiriladi, hech narsa saqlanmaydi.</li><li>Natijani ko'rib, "Import qilish" ni bosing.</li></ol>
    <input type="file" id="xls" accept=".xlsx"><div id="impRes"></div></div>`;
  box.scrollIntoView({ behavior: 'smooth' });
  let file64 = null;
  const send = async (dryRun) => api('POST', '/suppliers-import', { file: file64, dryRun });
  $('#xls', box).onchange = act(async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    file64 = await fileToBase64(f);
    const r = await send(true);
    const s = r.summary;
    $('#impRes', box).innerHTML = `
      <p><b>Tekshiruv natijasi:</b> yangi — ${s.suppliersCreated}, yangilanadi — ${s.suppliersUpdated}, narxlar — ${s.pricesSet}, yangi mahsulot — ${s.productsCreated},
        <span class="${s.errorRows ? 'err' : ''}">xato qatorlar — ${s.errorRows}</span></p>
      <div class="table-wrap" style="max-height:360px;overflow:auto"><table><tr><th>Qator</th><th>F.I.Sh</th><th>Telefon</th><th>Mahsulot</th><th class="num">Narx</th><th class="num">Qarz</th><th>Sut yig'uvchi</th><th>Natija</th></tr>
        ${r.rows.map((x) => `<tr><td>${x.row}</td><td>${esc(x.name)}</td><td>${esc(x.phone)}</td><td>${esc(x.product)}</td><td class="num">${fmtMoney(x.price)}</td><td class="num">${fmtMoney(x.debt)}</td>
          <td>${esc(x.collectors)}</td><td>${x.errors.length ? `<span class="err">${esc(x.errors.join('; '))}</span>` : `<span class="muted">${esc(x.actions.join('; '))}</span>`}</td></tr>`).join('')}
      </table></div>
      <p>${s.errorRows ? '<span class="err">Xato qatorlar o\'tkazib yuboriladi.</span> ' : ''}<button id="go" ${s.suppliersCreated + s.suppliersUpdated ? '' : 'disabled'}>Import qilish</button></p>`;
    $('#go', box).onclick = act(async () => {
      const done = await send(false);
      flash(`Import tugadi: ${done.summary.suppliersCreated} ta yangi, ${done.summary.suppliersUpdated} ta yangilandi`);
      route();
    });
  });
}

const route = act(async () => {
  if (!me) return;
  // Section scripts (stock, prod, sales, finance) add their groups as they load: redraw each time.
  drawNav();
  const name = location.hash.slice(1).split('?')[0] || 'overview';
  const parent = PAGE_PARENT[name] ?? name;
  const pages = PAGES.filter(canPage);
  const group = groupOf(parent) ?? groupOf(pages[0]?.[0]);
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.group === group));
  const inGroup = pages.filter((p) => p[3] === group);
  const sub = $('#subnav');
  sub.innerHTML = inGroup.length > 1 ? inGroup.map(([k, t]) => `<a href="#${k}" class="${k === parent ? 'active' : ''}">${esc(t)}</a>`).join('') : '';
  sub.hidden = inGroup.length <= 1;
  // Each navigation renders into a fresh container, so a slow, older page that
  // finishes loading late can never overwrite the page the user is now on.
  const v = document.createElement('main');
  v.id = 'view';
  v.innerHTML = '<p class="muted">Yuklanmoqda...</p>';
  $('#view').replaceWith(v);
  const allowed = pages.map((p) => p[0]);
  const target = views[name] && allowed.includes(parent) ? name : allowed[0];
  await views[target](v);
});

window.addEventListener('hashchange', route);
loadBrand();
// Section scripts (stock.js … reports.js) load after this file and add their pages:
// start once they all have, so a reloaded #pnl or #balances opens that page, not the home page.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show); else show();
