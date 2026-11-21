'use strict';

// Hisobotlar: one page for every report of the whole chain (sales, production,
// stock, losses, staff). Pick a report and a period; the table, totals and an
// Excel file come from the same server answer (/api/erp/reports).

const repApi = (path) => api('GET', path, null, '/api/erp/reports');
const cell = (c, v) => {
  if (v == null || v === '') return '';
  if (c.type === 'money') return fmtMoney(v);
  if (c.type === 'qty') return fmtNum(v, 3);
  if (c.type === 'pct') return `${fmtNum(v, 1)}%`;
  if (c.type === 'datetime') return fmtDate(v);
  if (c.type === 'date') return `${String(v).slice(8, 10)}.${String(v).slice(5, 7)}.${String(v).slice(0, 4)}`;
  return esc(v);
};
const GROUP_OF = (k) => (k.startsWith('sales') ? 'Savdo' : k.startsWith('production') ? 'Ishlab chiqarish' : k.startsWith('staff') ? 'Xodimlar' : 'Ombor');

views['erp-reports'] = async (v) => {
  const q = hashParams();
  const list = await repApi('/');
  const key = q.get('r') || list[0]?.key;
  const f = { from: q.get('from') || `${todayLocal().slice(0, 7)}-01`, to: q.get('to') || todayLocal(), warehouseId: q.get('wh') || '', days: q.get('days') || '3' };
  const qs = new URLSearchParams({ from: f.from, to: f.to, ...(f.warehouseId ? { warehouseId: f.warehouseId } : {}), days: f.days });
  const [rep, whs] = await Promise.all([key ? repApi(`/${key}?${qs}`) : null, key === 'stock_movement' ? api('GET', '/warehouses', null, '/api/erp') : []]);
  const groups = {};
  for (const r of list) (groups[GROUP_OF(r.key)] ??= []).push(r);
  const go = (patch) => setHash('erp-reports', { r: key, from: f.from, to: f.to, wh: f.warehouseId, days: f.days, ...patch });
  v.innerHTML = `<div class="card"><div class="row" style="gap:16px;align-items:flex-start">
      ${Object.entries(groups).map(([g, items]) => `<div><div class="muted" style="font-size:12px;margin-bottom:4px">${g}</div><div class="presets">
        ${items.map((r) => `<button class="ghost small ${r.key === key ? 'on' : ''}" data-r="${r.key}">${esc(r.title.replace(/^.*— /, ''))}</button>`).join('')}</div></div>`).join('')}
    </div></div>
    ${rep ? `<div class="card"><div class="row" style="justify-content:space-between;align-items:end">
        <h2 style="margin:0;flex:1">${esc(rep.title)}</h2>
        ${key === 'expiry' ? `<label style="flex:none">Necha kun ichida<input type="number" id="days" min="0" max="60" value="${f.days}" style="width:90px"></label>`
          : `<label style="flex:none">Dan<input type="date" id="from" value="${f.from}"></label><label style="flex:none">Gacha<input type="date" id="to" value="${f.to}"></label>`}
        ${key === 'stock_movement' ? `<label style="flex:none">Ombor<select id="wh"><option value="">Hamma joylar</option>${whs.map((w) => `<option value="${w.id}" ${String(w.id) === f.warehouseId ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select></label>` : ''}
        ${can('reports.export') ? '<button class="ghost" id="xlsx">Excel</button>' : ''}</div>
      ${rep.note ? `<p class="muted" style="margin:8px 0 0">${esc(rep.note)}</p>` : ''}</div>
      ${rep.chart && rep.rows.length > 1 ? '<div class="card"><div id="chart"></div></div>' : ''}
      ${rep.summary?.length ? `<div class="card"><div id="summary"></div></div>` : ''}
      <div class="card table-wrap"><table><thead><tr>${rep.columns.map((c) => `<th class="${c.type === 'text' ? '' : 'num'}">${esc(c.label)}</th>`).join('')}</tr></thead><tbody>
        ${rep.rows.map((r) => `<tr>${rep.columns.map((c) => `<td class="${c.type === 'text' ? '' : 'num'}">${cell(c, r[c.key])}</td>`).join('')}</tr>`).join('')
          || `<tr><td colspan="${rep.columns.length}" class="muted">Bu davrda ma'lumot yo'q</td></tr>`}
        ${rep.rows.length && Object.keys(rep.totals).length ? `<tr>${rep.columns.map((c, i) => `<td class="${c.type === 'text' ? '' : 'num'}"><b>${i === 0 ? 'Jami' : cell(c, rep.totals[c.key])}</b></td>`).join('')}</tr>` : ''}
      </tbody></table></div>` : '<p class="muted">Hisobot yo\'q</p>'}`;
  $$('[data-r]', v).forEach((b) => { b.onclick = () => go({ r: b.dataset.r }); });
  $('#from', v)?.addEventListener('change', (e) => go({ from: e.target.value }));
  $('#to', v)?.addEventListener('change', (e) => go({ to: e.target.value }));
  $('#wh', v)?.addEventListener('change', (e) => go({ wh: e.target.value }));
  $('#days', v)?.addEventListener('change', (e) => go({ days: e.target.value }));
  $('#xlsx', v)?.addEventListener('click', act(async () => {
    const res = await request('GET', `/api/erp/reports/${key}/xlsx?${qs}`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Yuklab bo\'lmadi');
    const url = URL.createObjectURL(await res.blob());
    Object.assign(document.createElement('a'), { href: url, download: `${key}-${f.from}-${f.to}.xlsx` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }));
  if (rep?.chart && $('#chart', v)) {
    const series = rep.chart.series.filter(([k]) => rep.columns.some((c) => c.key === k)).slice(0, 1);
    Charts.stackedBars($('#chart', v), {
      categories: rep.rows.map((r) => ({ key: r[rep.chart.x], label: String(r[rep.chart.x]).slice(5).split('-').reverse().join('.') })),
      series: series.map(([k, name]) => ({ key: k, name })),
      value: (cat, s) => rep.rows.find((r) => r[rep.chart.x] === cat)?.[s] ?? 0, unit: "so'm",
    });
  }
  if (rep?.summary?.length && $('#summary', v)) Charts.rankBars($('#summary', v), { rows: rep.summary.map((x) => ({ label: esc(x.label), value: x.value })), unit: "so'm" });
};

PAGES.push(['erp-reports', 'Umumiy hisobotlar', 'reports.view', 'reports']);

// ------------------------------------------------------------------ Bosh panel: 14-day trend
const homeView = views.overview;
views.overview = async (v) => {
  await homeView(v);
  if (!can('reports.view')) return;
  const tr = await repApi('/trend?days=14').catch(() => null);
  if (!tr) return;
  const box = document.createElement('div');
  box.className = 'grid2';
  box.innerHTML = '<div class="card"><h2>Sotuv (sof), 14 kun</h2><div id="trSales"></div></div><div class="card"><h2>Qabul qilingan sut, kg, 14 kun</h2><div id="trMilk"></div></div>';
  const first = v.querySelector('.card');
  if (first) first.before(box); else v.append(box);
  const cats = tr.map((d) => ({ key: d.day, label: `${d.day.slice(8, 10)}.${d.day.slice(5, 7)}` }));
  Charts.stackedBars($('#trSales', box), { categories: cats, series: [{ key: 'sales', name: 'Sof sotuv' }], value: (d) => Math.max(0, tr.find((x) => x.day === d)?.sales ?? 0), unit: "so'm" });
  Charts.stackedBars($('#trMilk', box), { categories: cats, series: [{ key: 'milk', name: 'Sut' }], value: (d) => tr.find((x) => x.day === d)?.milk ?? 0, unit: 'kg' });
};
