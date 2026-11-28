// Searchable dropdowns: every long <select> in the panel (products, raw materials,
// packaging, warehouses, staff...) gets a text box on top of it. Type part of the
// name, pick from the list with the mouse or ↑ ↓ Enter. The real <select> stays in
// the page (hidden) and keeps its value and its events, so the page code that reads
// select.value or listens for "change" works as before. A select is left alone when
// it has few options or carries data-plain.
(() => {
  const MIN = 8;
  const norm = (t) => String(t ?? '').toLowerCase().replace(/[ʻʼ’‘`']/g, "'").replace(/\s+/g, ' ').trim();
  // "— mahsulot —"-style empty choices show as the placeholder; "Hammasi" shows as itself
const label = (sel) => { const t = sel.selectedOptions[0]?.text ?? ''; return /^\s*—/.test(t) ? '' : t; };

  function enhance(sel) {
    if (sel.dataset.combo || sel.multiple || sel.dataset.plain != null || sel.options.length < MIN) return;
    sel.dataset.combo = '1';
    const box = document.createElement('div');
    box.className = 'combo';
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'combo-in';
    inp.autocomplete = 'off';
    inp.spellcheck = false;
    inp.placeholder = '🔍 Yozib qidiring...';
    if (sel.style.minWidth) inp.style.minWidth = sel.style.minWidth;
    const list = document.createElement('div');
    list.className = 'combo-list';
    list.hidden = true;
    box.append(inp, list);
    sel.after(box);
    sel.classList.add('combo-hidden');
    sel.tabIndex = -1;
    let items = [];
    let at = -1;
    const sync = () => { inp.value = label(sel); inp.disabled = sel.disabled; };
    const draw = (q) => {
      const n = norm(q);
      items = [...sel.options].filter((o) => !o.disabled && !o.hidden && (!n || norm(o.text).includes(n)));
      at = items.findIndex((o) => o.value === sel.value);
      if (at < 0 && n && items.length) at = 0;
      list.innerHTML = items.length
        ? items.map((o, i) => `<div class="combo-opt${i === at ? ' on' : ''}${o.value === '' ? ' muted' : ''}" data-i="${i}">${o.text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</div>`).join('')
        : '<div class="combo-opt muted">Topilmadi</div>';
      list.hidden = false;
      place();
      list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
    };
    // Fixed to the screen so a scrolling table or a dialog never clips the list.
    const place = () => {
      const r = inp.getBoundingClientRect();
      const below = window.innerHeight - r.bottom;
      list.style.left = `${r.left}px`;
      list.style.width = `${Math.max(r.width, 240)}px`;
      if (below < 200 && r.top > below) { list.style.top = ''; list.style.bottom = `${window.innerHeight - r.top + 2}px`; list.style.maxHeight = `${Math.min(280, r.top - 8)}px`; }
      else { list.style.bottom = ''; list.style.top = `${r.bottom + 2}px`; list.style.maxHeight = `${Math.min(280, below - 8)}px`; }
    };
    window.addEventListener('scroll', () => { if (!list.hidden) place(); }, true);
    const choose = (o) => {
      if (!o) return;
      const changed = sel.value !== o.value;
      sel.value = o.value;
      list.hidden = true;
      sync();
      if (changed) {
        sel.dispatchEvent(new Event('input', { bubbles: true }));
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    };
    inp.addEventListener('focus', () => { inp.select(); draw(''); });
    inp.addEventListener('input', (e) => { e.stopPropagation(); draw(inp.value); });
    inp.addEventListener('change', (e) => e.stopPropagation());
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (list.hidden) draw('');
        at = Math.max(0, Math.min(items.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)));
        list.querySelectorAll('.combo-opt').forEach((d, i) => d.classList.toggle('on', i === at));
        list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (!list.hidden && items[at]) choose(items[at]);
      } else if (e.key === 'Escape') {
        list.hidden = true;
        sync();
      }
    });
    // mousedown (before blur) so the click is not lost when the list closes
    list.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const d = e.target.closest('[data-i]');
      if (d) choose(items[Number(d.dataset.i)]);
    });
    inp.addEventListener('blur', () => { list.hidden = true; sync(); });
    sel.addEventListener('change', sync);
    // a click on the surrounding <label> focuses the hidden select: pass it on
    sel.addEventListener('focus', () => inp.focus());
    // the page may set the value right after drawing: read it once things settle
    requestAnimationFrame(sync);
    sync();
  }

  const scan = (root) => {
    if (root.tagName === 'SELECT') enhance(root);
    root.querySelectorAll?.('select').forEach(enhance);
  };
  new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) if (n.nodeType === 1) scan(n);
      // options added later to an existing select
      if (m.target.tagName === 'SELECT') enhance(m.target);
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
  scan(document);
  // a value set from code (without a change event) shows up on the next look
  setInterval(() => document.querySelectorAll('select[data-combo]').forEach((s) => {
    const inp = s.nextElementSibling?.querySelector('.combo-in');
    if (inp && document.activeElement !== inp) {
      const t = s.selectedOptions[0]?.text ?? '';
      const want = /^\s*—/.test(t) ? '' : t;
      if (inp.value !== want) inp.value = want;
      inp.disabled = s.disabled;
    }
  }), 400);
})();
