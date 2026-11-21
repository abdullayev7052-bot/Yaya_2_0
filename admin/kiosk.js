'use strict';

// Boshqaruv → Monobloklar: shared workplace computers. Create one, get a one-time
// 6-digit code and type it on the monoblock (app → "Monoblok rejimi"); choose who
// may sign in on it and after how many idle minutes the name list comes back.
// Staff PINs (4 digits) are set here or by each person in the app's Profile.

const kioskApi = (method, path, body) => api(method, path, body, '/api/kiosk');

views.kiosks = async (v) => {
  const d = await kioskApi('GET', '/admin');
  v.innerHTML = `<div class="card"><p class="muted" style="margin:0">Monoblok — sexdagi umumiy kompyuter. Unda har kim o'z ismini tanlab, <b>4 xonali PIN</b> bilan kiradi (shaxsiy qurilma joyi ishlatilmaydi).
      Ulash: monoblokni yarating → "Ulash kodi" → monoblokda ilovani oching → "Monoblok rejimi" → kodni kiriting. Kod 15 daqiqa amal qiladi va bir marta ishlaydi.</p></div>
    <div class="row" style="margin-bottom:12px;justify-content:flex-end"><button id="newK">+ Monoblok</button></div>
    <div class="card table-wrap"><table><thead><tr><th>Monoblok</th><th>Holati</th><th>Kim kira oladi</th><th class="num">Bo'sh turganda, daq.</th><th></th></tr></thead><tbody>
    ${d.kiosks.map((k) => `<tr class="${k.active ? '' : 'voided'}"><td><b>${esc(k.name)}</b>${k.last_seen_at ? `<div class="muted">oxirgi marta ${fmtDate(k.last_seen_at)}</div>` : ''}</td>
      <td>${k.paired ? '<span class="badge sent">Ulangan</span>' : '<span class="badge pending">Ulanmagan</span>'}${k.pair_code ? `<div>Kod: <b style="font-size:20px;letter-spacing:3px">${k.pair_code}</b></div>` : ''}</td>
      <td class="muted">${k.users.length ? k.users.map((u) => esc(u.name)).join(', ') : 'PIN o\'rnatgan hamma xodim'}</td><td class="num">${k.idle_minutes}</td>
      <td style="white-space:nowrap"><button class="small" data-code="${k.id}">Ulash kodi</button> <button class="ghost small" data-edit="${k.id}">Tahrirlash</button>
        ${k.paired ? `<button class="ghost small" data-unpair="${k.id}">Uzish</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Monoblok yo\'q</td></tr>'}
    </tbody></table></div>
    <div class="card table-wrap"><h2>Xodimlar PIN kodi</h2><p class="muted">Xodim PINni o'zi ham telefonidagi ilovada (Profil → "Monoblok uchun PIN") o'rnatishi mumkin.</p>
      <table><tbody>${d.staff.map((u) => `<tr class="${u.active ? '' : 'voided'}"><td>${esc(u.name)}</td><td class="muted">${esc(u.role ?? '')}</td>
        <td>${u.has_pin ? '<span class="badge sent">PIN bor</span>' : '<span class="muted">PIN yo\'q</span>'}</td>
        <td><button class="ghost small" data-pin="${u.id}">${u.has_pin ? "O'zgartirish" : "O'rnatish"}</button> ${u.has_pin ? `<button class="ghost small" data-clear="${u.id}">O'chirish</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
  const form = (k = null) => {
    const dlg = $('#dlg'); const sel = new Set((k?.users ?? []).map((u) => u.id));
    dlg.innerHTML = `<form method="dialog"><h2>${k ? 'Monoblok' : 'Yangi monoblok'}</h2>
      <label>Nomi<input name="name" required value="${esc(k?.name ?? '')}" placeholder="Masalan: Sex monobloki"></label>
      <label>Necha daqiqa bo'sh tursa, ismlar ro'yxatiga qaytsin<input name="idle" type="number" min="1" max="60" value="${k?.idle_minutes ?? 2}"></label>
      <div><div class="muted" style="font-size:13px">Kim kira oladi (hech kim belgilanmasa — PIN o'rnatgan hamma)</div>
        <div class="checks">${d.staff.filter((u) => u.active).map((u) => `<label><input type="checkbox" name="u" value="${u.id}" ${sel.has(u.id) ? 'checked' : ''}> ${esc(u.name)}</label>`).join('')}</div></div>
      ${k ? `<label style="display:flex;gap:8px;color:var(--text)"><input type="checkbox" name="active" ${k.active ? 'checked' : ''}> Faol</label>` : ''}
      <p class="err" id="dlgErr"></p><div class="actions"><button type="button" class="ghost" value="cancel">Bekor</button><button value="ok">Saqlash</button></div></form>`;
    const f = $('form', dlg); $('button[value=cancel]', dlg).onclick = () => dlg.close();
    f.onsubmit = async (e) => {
      e.preventDefault();
      const body = { name: f.elements.name.value, idleMinutes: Number(f.elements.idle.value), users: $$('input[name=u]:checked', f).map((x) => Number(x.value)), ...(k ? { active: f.elements.active.checked } : {}) };
      try { await (k ? kioskApi('PATCH', `/admin/${k.id}`, body) : kioskApi('POST', '/admin', body)); dlg.close(); route(); } catch (ex) { $('#dlgErr').textContent = ex.message; }
    };
    dlg.showModal();
  };
  $('#newK', v).onclick = () => form();
  $$('[data-edit]', v).forEach((b) => { b.onclick = () => form(d.kiosks.find((k) => k.id === Number(b.dataset.edit))); });
  $$('[data-code]', v).forEach((b) => { b.onclick = act(async () => {
    const r = await kioskApi('POST', `/admin/${b.dataset.code}/code`);
    const dlg = $('#dlg');
    dlg.innerHTML = `<form method="dialog"><h2>Ulash kodi</h2><p style="font-size:44px;font-weight:700;letter-spacing:8px;text-align:center;margin:8px 0">${r.code}</p>
      <p class="muted">Monoblokda ilovani oching → "Monoblok rejimi" → shu kodni kiriting. ${r.expiresInMinutes} daqiqa amal qiladi, bir marta ishlaydi. Qayta ulansa eski ulanish bekor bo'ladi.</p>
      <div class="actions"><button value="cancel">Yopish</button></div></form>`;
    dlg.onclose = () => { dlg.onclose = null; route(); };
    dlg.showModal();
  }); });
  $$('[data-unpair]', v).forEach((b) => { b.onclick = act(async () => {
    if (!confirm('Monoblok uzilsinmi? Undagi hamma sessiyalar to\'xtaydi; qayta ulash uchun yangi kod kerak.')) return;
    await kioskApi('PATCH', `/admin/${b.dataset.unpair}`, { unpair: true }); route();
  }); });
  $$('[data-pin]', v).forEach((b) => { b.onclick = () => openForm({ title: 'PIN kod', submit: 'Saqlash',
    fields: [{ name: 'pin', label: '4 xonali PIN', type: 'password', pattern: '\\d{4}', inputmode: 'numeric', required: true }],
    onSubmit: (x) => kioskApi('PUT', `/admin/pin/${b.dataset.pin}`, x) }); });
  $$('[data-clear]', v).forEach((b) => { b.onclick = act(async () => { if (confirm('PIN o\'chirilsinmi?')) { await kioskApi('PUT', `/admin/pin/${b.dataset.clear}`, { pin: null }); route(); } }); });
};

PAGES.push(['kiosks', 'Monobloklar', 'staff.manage', 'admin']);
