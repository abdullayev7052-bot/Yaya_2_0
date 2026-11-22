'use strict';

// Bosh panel: the whole chain on one page — milk collection, warehouses,
// production, alerts and this month's losses. Each block shows only what the
// person may see (the server leaves out the rest). Uses app.js / stock.js helpers.

const KIND_LABEL = {
  raw_milk: 'Xom sut', raw: 'Xomashyo', semi: 'Quyma', pack: 'Idish', label: 'Etiketka', finished: 'Tayyor mahsulot',
  returned: 'Qaytgan', recycled: 'Qayta ishlangan', other: 'Boshqa', milk: 'Yig\'uvchilar suti',
};

views.overview = async (v) => {
  const day = hashParams().get('day') || todayLocal();
  const o = await api('GET', `/overview?day=${day}`, null, '/api/erp');
  const tile = (k, val, sub, href) => `<div class="tile">${href ? `<a href="${href}" style="color:inherit;text-decoration:none">` : ''}
    <div class="k">${k}</div><div class="v">${val}</div>${sub ? `<div class="s">${sub}</div>` : ''}${href ? '</a>' : ''}</div>`;
  const blocks = [];

  if (o.milk) {
    const sh = o.milk.shifts;
    blocks.push(`<div class="card"><div class="row" style="justify-content:space-between;align-items:center"><h2 style="margin:0">1. Sut yig'ish</h2><a href="#dashboard?from=${day}&to=${day}">batafsil →</a></div>
      <div class="tiles" style="margin:12px 0 0">
        ${tile('Qabul qilingan sut', `${fmtNum(o.milk.quantity)} kg`, o.milk.products.map((p) => `${esc(p.name)}: ${fmtNum(p.quantity)}`).join(' · '))}
        ${o.milk.amount != null ? tile('Summa', fmtMoney(o.milk.amount), "so'm") : ''}
        ${tile('Smenalar', `${sh.accepted} / ${sh.open + sh.closed + sh.accepted}`, `ochiq ${sh.open} · qabul kutmoqda ${sh.closed}`, '#shifts')}
      </div></div>`);
  }
  if (o.stock) {
    const s = o.stock;
    blocks.push(`<div class="card"><div class="row" style="justify-content:space-between;align-items:center"><h2 style="margin:0">2. Ombor</h2><a href="#stock">batafsil →</a></div>
      <div class="tiles" style="margin:12px 0 0">
        ${tile('Xom sut qoldig\'i', `${fmtNum(s.raw_milk)} kg`, 'omborlar va xodimlar qo\'lida', '#stock?tab=qoldiq&kind=raw_milk')}
        ${costs() ? tile('Qoldiq qiymati', fmtMoney(s.value), "so'm, tannarxda") : ''}
        ${tile('Qabul kutayotgan topshirishlar', s.waiting_handovers, s.draft_counts ? `${s.draft_counts} ta sanoq tasdiq kutmoqda` : '', '#stock?tab=hujjat&status=sent')}
        ${tile('Muddati yaqin partiyalar', s.expiring, '2 kun ichida')}
        ${s.negative ? tile('Manfiy qoldiqlar', `<span class="err">${s.negative}</span>`, 'kirimni tekshiring', '#stock?tab=qoldiq') : ''}
      </div>
      ${Object.keys(s.by_kind).length ? `<table style="margin-top:12px"><thead><tr><th>Turi</th><th class="num">Pozitsiya</th>${costs() ? '<th class="num">Qiymati</th>' : ''}</tr></thead><tbody>
        ${Object.entries(s.by_kind).map(([k, x]) => `<tr><td>${esc(KIND_LABEL[k] ?? k)}</td><td class="num">${x.items}</td>${costs() ? `<td class="num">${fmtMoney(x.cost)}</td>` : ''}</tr>`).join('')}
      </tbody></table>` : ''}</div>`);
  }
  if (o.production) {
    const p = o.production;
    blocks.push(`<div class="card"><div class="row" style="justify-content:space-between;align-items:center"><h2 style="margin:0">3. Ishlab chiqarish</h2><a href="#prod">batafsil →</a></div>
      <div class="tiles" style="margin:12px 0 0">
        ${tile('Ochiq texnolog smenalari', p.open_shifts, '', '#prod?status=open')}
        ${tile('Bajarilgan topshiriqlar', p.tasks_done, `${fmtNum(p.milk_used)} kg xom sut ishlatildi`)}
        ${tile('Tasdiq kutmoqda', p.approvals ? `<span class="warn">${p.approvals}</span>` : 0, 'limitdan chiqqanlar', '#prod-approvals')}
      </div>
      ${p.output.length ? `<table style="margin-top:12px"><thead><tr><th>Chiqqan mahsulot</th><th class="num">Miqdor</th></tr></thead><tbody>
        ${p.output.map((x) => `<tr><td>${esc(x.name)}</td><td class="num">${fmtNum(x.qty, 3)} ${esc(x.unit)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted" style="margin:12px 0 0">Bu kunda topshiriq bajarilmagan.</p>'}</div>`);
  }
  if (o.finance) {
    const f = o.finance;
    blocks.push(`<div class="card"><div class="row" style="justify-content:space-between;align-items:center"><h2 style="margin:0">4. Moliya</h2><a href="#finance">batafsil →</a></div>
      <div class="tiles" style="margin:12px 0 0">
        ${tile('Kassalarda', fmtMoney(f.cash), f.cashboxes.map((c) => `${esc(c.name)}: ${fmtMoney(c.balance)}`).join(' · '))}
        ${tile('Biz xonadonlarga (sut)', fmtMoney(f.we_owe_households), '', '#balances')}
        ${tile('Biz yetkazib beruvchilarga', fmtMoney(f.we_owe_vendors), '', '#vendors')}
        ${tile('Biz xodimlarga', fmtMoney(f.we_owe_staff), 'oylik, ishbay, bonus', '#payroll')}
      </div></div>`);
  }
  if (o.alerts) {
    blocks.push(`<div class="card"><div class="row" style="justify-content:space-between;align-items:center"><h2 style="margin:0">Ogohlantirishlar (${o.alerts.open})</h2><a href="#stock?tab=ogoh">hammasi →</a></div>
      ${o.alerts.latest.length ? `<table style="margin-top:8px"><tbody>${o.alerts.latest.map((a) => `<tr><td class="muted" style="white-space:nowrap">${fmtDate(a.created_at)}</td><td>${esc(a.text)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">Ochiq ogohlantirish yo\'q.</p>'}</div>`);
  }
  if (o.pnl) {
    blocks.push(`<div class="card"><h2>Shu oy: yo'qotish va farqlar</h2>
      ${o.pnl.length ? `<table><tbody>${o.pnl.map((x) => `<tr><td>${esc(x.name)}</td><td class="num" style="color:${(x.kind === 'income') === (x.amount > 0) ? 'var(--ok)' : 'var(--err)'}">${fmtMoney(x.amount)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">Bu oyda yozuv yo\'q.</p>'}</div>`);
  }
  v.innerHTML = `<div class="row" style="margin-bottom:12px;align-items:end"><h2 style="margin:0;flex:1">Bosh panel — butun zanjir</h2>
      <label style="flex:none">Kun <input type="date" id="day" value="${day}" max="${todayLocal()}"></label></div>
    ${blocks.join('')}`;
  $('#day', v).onchange = (e) => setHash('overview', { day: e.target.value });
};
