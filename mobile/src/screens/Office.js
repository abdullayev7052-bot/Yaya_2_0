import { useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, ScrollView, Text, TextInput, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as api from '../api';
import * as store from '../db';
import { confirmAction, notify } from '../dialog';
import { Btn, CalendarModal, Chip, Err, Header, METHOD, ReorderTabs, SearchBar, ShiftBadge, Tile, addDays, fmtDay, fmtDT, fmtMoney, textMatch, todayLocal, toNumber, useLoad } from '../components';
import { C, fmtQty, fmtTime, s } from '../ui';

// Signed difference, coloured: surplus green (+), shortfall red (−).
function Diff({ kg, unit = 'kg', style }) {
  if (kg == null) return null;
  const c = kg > 0 ? C.ok : kg < 0 ? C.err : C.muted;
  return <Text style={[{ color: c, fontWeight: '700' }, style]}>{kg > 0 ? '+' : ''}{fmtQty(kg)} {unit}</Text>;
}

// Office sections of the app (storekeeper, accountant, manager, admin).
// Online only: they read live data from the server with the person's own permissions.
const money = () => api.can('prices.view');

function ShiftRow({ x, onOpen }) {
  return (
    <Pressable onPress={() => onOpen(x.id)} style={({ pressed }) => [s.card, { gap: 4 }, pressed && { opacity: 0.6 }]}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <Text style={[s.text, { fontWeight: '700', flex: 1 }]} numberOfLines={1}>{x.label} · {x.employee_name}{x.is_test ? ' (test)' : ''}</Text>
        <ShiftBadge status={x.status} />
      </View>
      <Text style={s.muted}>{fmtDT(x.opened_at)} — {x.closed_at ? fmtTime(x.closed_at) : '...'}</Text>
      <Text style={s.text}>{x.pickups} ta · {x.suppliers} uy · <Text style={{ fontWeight: '700' }}>{fmtQty(x.quantity)} kg</Text>
        {money() && x.amount != null ? ` · ${fmtMoney(x.amount)} so'm` : ''}</Text>
      {x.accepted_quantity != null && (
        <Text style={s.text}>Qabul: <Text style={{ fontWeight: '700' }}>{fmtQty(x.accepted_quantity)} kg</Text> · Farq: <Diff kg={x.diff_quantity} /></Text>
      )}
      {!!x.cancel_reason && <Text style={{ color: C.err }}>Sabab: {x.cancel_reason}</Text>}
    </Pressable>
  );
}

// ---------------------------------------------------------------- dashboard for a chosen day/range
export function Today({ onShift }) {
  const today = todayLocal();
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [cal, setCal] = useState(false);
  const [product, setProduct] = useState(0); // 0 = all products
  const [nominal, setNominal] = useState(false); // false = real (accepted) cost, true = nominal price
  const single = from === to;
  const qs = `from=${from}&to=${to}${product ? `&product=${product}` : ''}`;
  const { data: d, err, busy, load } = useLoad(() => api.admin('GET', `/dashboard?${qs}`), [from, to, product]);
  // Open shifts change minute by minute: keep the numbers live.
  useEffect(() => { const t = setInterval(load, 20000); return () => clearInterval(t); }, [load]);
  const m = money();
  const dr = d?.diff; // difference report (only for diff.view)
  const costByProduct = Object.fromEntries((dr?.byProduct ?? []).map((p) => [p.id, p]));
  const tot = d?.summary?.totals;
  const products = api.getProducts();
  const goDay = (n) => { const x = addDays(to, n); setFrom(x); setTo(x); };
  const header = single ? (from === today ? `Bugun, ${fmtDay(from)}` : fmtDay(from)) : `${fmtDay(from)} — ${fmtDay(to)}`;
  return (
    <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }} refreshControl={<RefreshControl refreshing={busy} onRefresh={load} />}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Pressable style={[s.btnGhost, { paddingHorizontal: 16, opacity: single ? 1 : 0.3 }]} disabled={!single} onPress={() => goDay(-1)}><Text style={s.btnGhostText}>‹</Text></Pressable>
        <Pressable style={{ flex: 1 }} onPress={() => setCal(true)}><Text style={[s.h2, { textAlign: 'center' }]}>{header}</Text></Pressable>
        <Pressable style={[s.btnGhost, { paddingHorizontal: 16 }, (!single || to >= today) && { opacity: 0.3 }]} disabled={!single || to >= today} onPress={() => goDay(1)}><Text style={s.btnGhostText}>›</Text></Pressable>
      </View>
      <CalendarModal visible={cal} from={from} to={to} onClose={() => setCal(false)} onApply={({ from: f, to: t }) => { setFrom(f); setTo(t); }} />
      {products.length > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
          <Chip label="Hammasi" on={!product} onPress={() => setProduct(0)} />
          {products.map((p) => <Chip key={p.id} label={p.name} on={product === p.id} onPress={() => setProduct(p.id)} />)}
        </ScrollView>
      )}
      <Err err={err} />
      {d && tot && (
        <>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <Tile label="Qabul qilingan sut" value={fmtQty(tot.quantity)} sub={`kg · ${tot.shifts} ta smena`} />
            {m && <Tile label="Summa" value={fmtMoney(tot.amount)} sub="so'm" />}
            {d.debt && <Tile label="Qarzdorlik" value={fmtMoney(d.debt.weOwe)} sub={to >= today ? "so'm" : `so'm · ${fmtDay(to)} oxirida`} wide={!m} />}
          </View>
          <View style={[s.card, { gap: 6 }]}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={[s.text, { fontWeight: '700' }]}>Mahsulotlar{m ? ' va tannarx' : ''}</Text>
              {/* Real (accepted) cost by default; toggle to the nominal price. */}
              {m && dr && <Chip label={nominal ? 'Nominal narx' : 'Real tannarx'} on onPress={() => setNominal((x) => !x)} />}
            </View>
            {d.summary.byProduct.map((p) => {
              const c = costByProduct[p.id];
              const showQ = dr && c && !nominal ? c.real_q : p.quantity; // accepted qty by default
              const cost = dr && c ? (nominal ? c.nominal_cost : c.real_cost) : p.avg_cost;
              return (
                <View key={p.id} style={{ borderTopWidth: 1, borderColor: C.line, paddingTop: 6 }}>
                  <Text style={[s.text, { fontWeight: '600' }]}>{p.name}: {fmtQty(showQ)} {p.unit}
                    {dr && c && !nominal && c.diff_q ? <Text style={s.muted}>  (farq <Diff kg={c.diff_q} unit={p.unit} />)</Text> : null}</Text>
                  {m && <Text style={s.muted}>{nominal ? 'Nominal' : 'Real'} tannarx {fmtMoney(cost)} so'm/{p.unit}</Text>}
                </View>
              );
            })}
            {!d.summary.byProduct.length && <Text style={s.muted}>Qabul qilingan smena yo'q</Text>}
          </View>
          {/* How much the company gained/lost from the accepted-quantity gaps. */}
          {dr && (dr.totals.diff_q || dr.totals.gain) ? (
            <View style={[s.card, { gap: 6 }]}>
              <Text style={[s.text, { fontWeight: '700' }]}>Farqdan yutuq / yo'qotish</Text>
              <Text style={s.text}>Jami farq: <Diff kg={dr.totals.diff_q} />{m ? <Text style={{ fontWeight: '700', color: dr.totals.gain >= 0 ? C.ok : C.err }}>  ·  {dr.totals.gain >= 0 ? '+' : ''}{fmtMoney(dr.totals.gain)} so'm</Text> : null}</Text>
              {dr.byEmployee.length > 1 && dr.byEmployee.map((e) => (
                <Text key={e.id} style={s.muted}>{e.name}: <Diff kg={e.diff_q} />{m ? ` · ${e.gain >= 0 ? '+' : ''}${fmtMoney(e.gain)} so'm` : ''}</Text>
              ))}
            </View>
          ) : null}
          {!!d.live?.length && (
            <View style={{ gap: 8 }}>
              <Text style={[s.text, { fontWeight: '700' }]}>Ochiq smenalar</Text>
              {d.live.map((x) => <ShiftRow key={x.id} x={x} onOpen={onShift} />)}
            </View>
          )}
          {!!d.waiting?.length && (
            <View style={{ gap: 8 }}>
              <Text style={[s.text, { fontWeight: '700' }]}>Qabul kutayotgan smenalar</Text>
              {d.waiting.map((x) => <ShiftRow key={x.id} x={x} onOpen={onShift} />)}
            </View>
          )}
          <View style={{ gap: 8 }}>
            <Text style={[s.text, { fontWeight: '700' }]}>Qabul qilingan smenalar</Text>
            {d.accepted.map((x) => <ShiftRow key={x.id} x={x} onOpen={onShift} />)}
            {!d.accepted.length && <Text style={s.muted}>Yo'q</Text>}
          </View>
        </>
      )}
    </ScrollView>
  );
}

// ---------------------------------------------------------------- shifts to review
const FILTERS = [['closed', 'Kutmoqda'], ['open', 'Ochiq'], ['accepted', 'Qabul'], ['cancelled', 'Bekor']];
const DEFAULT_ORDER = FILTERS.map((f) => f[0]);
// The tab order is saved on this device only; the first tab is what opens.
const loadOrder = () => {
  const saved = store.getKv('shiftTabsOrder');
  const keys = Array.isArray(saved) ? saved.filter((k) => DEFAULT_ORDER.includes(k)) : [];
  return keys.length ? [...keys, ...DEFAULT_ORDER.filter((k) => !keys.includes(k))] : DEFAULT_ORDER;
};

export function Shifts({ onShift, tick }) {
  const [order, setOrder] = useState(loadOrder);
  const [status, setStatus] = useState(() => loadOrder()[0]);
  const from = addDays(todayLocal(), -13);
  const { data, err, busy, load } = useLoad(() => api.admin('GET', `/shifts?status=${status}&from=${from}&to=${todayLocal()}`), [status, tick]);
  const saveOrder = (arr) => { setOrder(arr); try { store.setKv('shiftTabsOrder', arr); } catch { /* ignore */ } };
  return (
    <View style={{ flex: 1 }}>
      <View style={{ padding: 12 }}>
        <ReorderTabs items={FILTERS} order={order} active={status} onPick={setStatus} onReorder={saveOrder} />
      </View>
      <Err err={err} />
      <FlatList
        data={data ?? []}
        keyExtractor={(x) => String(x.id)}
        refreshControl={<RefreshControl refreshing={busy} onRefresh={load} />}
        contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 12, gap: 8 }}
        ListEmptyComponent={<Text style={[s.muted, { padding: 16 }]}>{data ? (status === 'closed' || status === 'open' ? 'Smena yo\'q' : 'Smena yo\'q (oxirgi 14 kun)') : 'Yuklanmoqda...'}</Text>}
        renderItem={({ item: x }) => <ShiftRow x={x} onOpen={onShift} />}
      />
    </View>
  );
}

// Shift detail: who collected, from whom, how much — and the decisions.
// A closed shift can never be edited: only accepted, cancelled, or (once cancelled) copied.
export function ShiftDetail({ id, onBack, onChanged, onCard }) {
  const { data: d, err, busy, load } = useLoad(() => api.admin('GET', `/shifts/${id}`), [id]);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const [q, setQ] = useState('');
  // Per-product real accepted quantity (difference feature), keyed by product id.
  const [real, setReal] = useState({});
  const m = money();
  const sh = d?.shift;
  const diff = d?.diff;
  const diffOn = sh?.status === 'closed' && api.can('shifts.accept') && diff?.enabled && !!diff?.products?.length;
  // Pre-fill the real quantities with what the collector wrote, once the shift loads.
  useEffect(() => {
    if (diffOn) setReal(Object.fromEntries(diff.products.map((p) => [p.product_id, String(p.written)])));
  }, [id, diffOn]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live per-product difference and whether a limit is exceeded.
  const checks = diffOn ? diff.products.map((p) => {
    const v = toNumber(real[p.product_id] ?? p.written);
    const dd = Math.round((v - p.written) * 100) / 100;
    const bad = !Number.isFinite(v) || v < 0 || (diff.over != null && dd > diff.over) || (diff.under != null && dd < -diff.under);
    return { ...p, v, diff: dd, bad };
  }) : [];
  const blocked = checks.some((c) => c.bad);

  const act = async (path, body, done) => {
    try {
      await api.admin('POST', `/shifts/${id}/${path}`, body);
      notify('Tayyor', done);
      setCancelling(false); setReason('');
      await load(); onChanged?.();
    } catch (e) { notify('Bo\'lmadi', e.message); }
  };
  const accept = () => {
    const body = diffOn ? { real: Object.fromEntries(checks.map((c) => [c.product_id, c.v])) } : null;
    confirmAction('accept', 'Qabul qilish', `${sh.label} smena qabul qilinsinmi? Shundan keyin u qarz va hisobotlarga kiradi.`, 'Ha',
      () => act('accept', body, 'Smena qabul qilindi'));
  };
  const copySummary = async () => {
    try {
      const { text } = await api.admin('GET', `/shifts/${id}/copytext`);
      if (!text) { notify('Nusxalash', 'Nusxalash uchun ma\'lumot yo\'q.'); return; }
      await Clipboard.setStringAsync(text);
      notify('Nusxalandi', 'Smena ma\'lumotlari klaviaturaga nusxalandi.');
    } catch (e) { notify('Bo\'lmadi', e.message); }
  };
  const rows = useMemo(() => (d?.rows ?? []).filter((r) => textMatch(r.supplier_name, q)), [d, q]);
  return (
    <View style={{ flex: 1 }}>
      <Header title={sh ? `${sh.label} — ${sh.employee_name}` : '...'} onBack={onBack}
        right={d && d.rows?.length ? <Pressable onPress={copySummary} hitSlop={10} style={{ padding: 6 }}><Text style={{ fontSize: 22 }}>📋</Text></Pressable> : null} />
      <Err err={err} />
      {d && (
        <FlatList
          data={rows}
          keyExtractor={(r) => String(r.id)}
          refreshControl={<RefreshControl refreshing={busy} onRefresh={load} />}
          contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 16, gap: 6 }}
          ListHeaderComponent={(
            <View style={{ gap: 10, marginBottom: 8 }}>
              <ShiftBadge status={sh.status} />
              <Text style={s.muted}>Ochilgan {fmtDT(sh.opened_at)}{sh.closed_at ? ` · yopilgan ${fmtDT(sh.closed_at)}` : ''}</Text>
              {sh.accepted_at && <Text style={s.muted}>Qabul qildi: {String(sh.accepted_by ?? '').replace(/^user:/, '')} · {fmtDT(sh.accepted_at)}</Text>}
              {sh.cancelled_at && <Text style={{ color: C.err }}>Bekor qildi: {String(sh.cancelled_by ?? '').replace(/^user:/, '')} · {fmtDT(sh.cancelled_at)}. Sabab: {sh.cancel_reason}</Text>}
              {sh.status === 'open' && <Text style={{ color: C.warn }}>Ochiq smena. Hisobga kirmaydi.</Text>}
              {sh.status === 'editing' && <Text style={{ color: C.warn }}>Tahrir qilinmoqda. Xodim qayta yopmaguncha qabul qilib bo'lmaydi.</Text>}
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {d.byProduct.map((p) => <Tile key={p.name} label={p.name} value={fmtQty(p.quantity)} sub={`${p.unit} · ${p.pickups} ta`} />)}
              </View>
              {/* Accepted shift: real total and the company's surplus/shortfall. */}
              {diff?.hasReal && (
                <View style={[s.card, { gap: 4 }]}>
                  <Text style={[s.text, { fontWeight: '700' }]}>Qabul qilingan (real) va farq</Text>
                  {diff.products.map((p) => (
                    <Text key={p.product_id} style={s.text}>{p.name}: {fmtQty(p.real)} {p.unit} · Farq: <Diff kg={p.diff} unit={p.unit} /></Text>
                  ))}
                  <Text style={[s.text, { fontWeight: '700', marginTop: 2 }]}>Jami qabul: {fmtQty(diff.real)} kg · Farq: <Diff kg={diff.diff} /></Text>
                </View>
              )}
              {/* Closed shift awaiting acceptance: record the real quantity per product. */}
              {diffOn && (
                <View style={[s.card, { gap: 8 }]}>
                  <Text style={[s.text, { fontWeight: '700' }]}>Qabul qilingan real miqdor</Text>
                  {checks.map((c) => (
                    <View key={c.product_id} style={{ gap: 4 }}>
                      <Text style={s.muted}>{c.name} — yozilgan {fmtQty(c.written)} {c.unit}</Text>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <TextInput style={[s.input, { flex: 1 }, c.bad && { borderColor: C.err }]} keyboardType="decimal-pad"
                          value={real[c.product_id] ?? ''} onChangeText={(t) => setReal((x) => ({ ...x, [c.product_id]: t }))} placeholder={String(c.written)} />
                        <Diff kg={c.diff} unit={c.unit} style={{ minWidth: 72, textAlign: 'right' }} />
                      </View>
                    </View>
                  ))}
                  {(diff.over != null || diff.under != null) && (
                    <Text style={s.muted}>Ruxsat etilgan farq: {diff.over != null ? `+${diff.over}` : '∞'} / {diff.under != null ? `−${diff.under}` : '∞'} kg</Text>
                  )}
                  {blocked && <Text style={s.err}>Farq ruxsat etilgan chegaradan tashqarida — qabul qilib bo'lmaydi.</Text>}
                </View>
              )}
              {sh.status === 'closed' && api.can('shifts.accept') && (
                <Btn title="Qabul qilish" disabled={blocked} onPress={accept} />
              )}
              {sh.status === 'closed' && api.can('shifts.cancel') && api.cancelEnabled() && (cancelling ? (
                <View style={{ gap: 8 }}>
                  <TextInput style={s.input} value={reason} onChangeText={setReason} placeholder="Bekor qilish sababi" autoFocus />
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <Btn title="Orqaga" kind="ghost" style={{ flex: 1 }} onPress={() => setCancelling(false)} />
                    <Btn title="Bekor qilish" kind="danger" style={{ flex: 1 }} disabled={!reason.trim()} onPress={() => act('cancel', { reason: reason.trim() }, 'Smena bekor qilindi. U hisobga kirmaydi va qarz yaratmaydi.')} />
                  </View>
                </View>
              ) : <Btn title="Rad etish (bekor qilish)" kind="warn" onPress={() => setCancelling(true)} />)}
              {sh.status === 'cancelled' && api.can('shifts.copy') && (
                <Btn title="Nusxa olish (yangi ochiq smena)" kind="ghost" onPress={() => act('copy', null, 'Nusxa ochildi: xodim qatorlarni tuzatib qayta yopadi.')} />
              )}
              {d.rows.length > 6 && <SearchBar value={q} onChange={setQ} placeholder="🔍  Xonadon nomi" />}
            </View>
          )}
          renderItem={({ item: r }) => (
            <Pressable onPress={() => onCard?.(r.supplier_id)}
              style={({ pressed }) => [s.card, { padding: 10, flexDirection: 'row', alignItems: 'center', gap: 8 }, pressed && { opacity: 0.6 }]}>
              <View style={{ flex: 1 }}>
                <Text style={[s.text, { fontWeight: '600' }]}>{r.supplier_name}</Text>
                <Text style={s.muted}>{fmtTime(r.collected_at)} · {r.product_name}{r.edited_at ? ' · tahrirlangan' : ''}
                  {m ? ` · ${r.price != null ? fmtMoney(r.price) : r.current_price != null ? `${fmtMoney(r.current_price)} (joriy)` : 'narx yo\'q!'}` : ''}</Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={{ fontSize: 18, fontWeight: '700', color: C.text }}>{fmtQty(r.quantity)} {r.unit}</Text>
                {m && r.amount != null && <Text style={s.muted}>{fmtMoney(r.amount)}</Text>}
              </View>
              {onCard && <Text style={{ color: C.muted, fontSize: 20 }}>›</Text>}
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

// ---------------------------------------------------------------- payments by date
export function Payments({ onOpen }) {
  const today = todayLocal();
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [cal, setCal] = useState(false);
  const { data, err, busy, load } = useLoad(() => api.admin('GET', `/payments?from=${from}&to=${to}`), [from, to]);
  const m = money();
  const goDay = (n) => { const x = addDays(to, n); setFrom(x); setTo(x); };
  const single = from === to;
  const header = single ? (from === today ? `Bugun, ${fmtDay(from)}` : fmtDay(from)) : `${fmtDay(from)} — ${fmtDay(to)}`;
  const total = (data ?? []).filter((p) => p.kind === 'payment' && !p.voided_at).reduce((a, p) => a + p.amount, 0);
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12 }}>
        <Pressable style={[s.btnGhost, { paddingHorizontal: 16, opacity: single ? 1 : 0.3 }]} disabled={!single} onPress={() => goDay(-1)}><Text style={s.btnGhostText}>‹</Text></Pressable>
        <Pressable style={{ flex: 1 }} onPress={() => setCal(true)}><Text style={[s.h2, { textAlign: 'center' }]}>{header}</Text></Pressable>
        <Pressable style={[s.btnGhost, { paddingHorizontal: 16 }, (!single || to >= today) && { opacity: 0.3 }]} disabled={!single || to >= today} onPress={() => goDay(1)}><Text style={s.btnGhostText}>›</Text></Pressable>
      </View>
      <CalendarModal visible={cal} from={from} to={to} onClose={() => setCal(false)} onApply={({ from: f, to: t }) => { setFrom(f); setTo(t); }} />
      {m && <Text style={[s.text, { paddingHorizontal: 12, fontWeight: '700' }]}>Jami to'lovlar: {fmtMoney(total)} so'm</Text>}
      <Err err={err} />
      <FlatList
        data={data ?? []}
        keyExtractor={(p) => `${p.kind}-${p.id}`}
        refreshControl={<RefreshControl refreshing={busy} onRefresh={load} />}
        contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 12, gap: 8 }}
        ListEmptyComponent={<Text style={[s.muted, { padding: 16 }]}>{data ? 'To\'lov yo\'q' : 'Yuklanmoqda...'}</Text>}
        renderItem={({ item: p }) => (
          <Pressable onPress={() => onOpen?.(p.supplier_id)} style={({ pressed }) => [s.card, { gap: 2 }, pressed && { opacity: 0.6 }, p.voided_at && { opacity: 0.5 }]}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
              <Text style={[s.text, { fontWeight: '700', flex: 1 }]} numberOfLines={1}>{p.supplier_name}</Text>
              <Text style={{ fontWeight: '700', color: p.kind === 'adjust' ? C.warn : C.text }}>{m ? `${fmtMoney(p.amount)} so'm` : ''}</Text>
            </View>
            <Text style={s.muted}>{fmtDT(p.at)} · {p.kind === 'adjust' ? 'Balans tahrirlandi' : METHOD[p.method] || 'To\'lov'} · {p.by_name || '—'} orqali
              {p.note ? ` · ${p.note}` : ''}{p.voided_at ? ' · BEKOR QILINGAN' : ''}</Text>
          </Pressable>
        )}
      />
    </View>
  );
}

// ---------------------------------------------------------------- debts
export function Debts({ onOpen, onPay, tick }) {
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => { const t = setTimeout(() => setQuery(q), 350); return () => clearTimeout(t); }, [q]);
  const { data, err, busy, load } = useLoad(() => api.admin('GET', `/balances?q=${encodeURIComponent(query)}`), [query, tick]);
  return (
    <View style={{ flex: 1 }}>
      <View style={{ padding: 12, gap: 8 }}>
        {data && (
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Tile label="Qarzdorlik" value={fmtMoney(data.totals.weOwe)} sub="so'm" />
            <Tile label="Haqdorlik" value={fmtMoney(data.totals.theyOwe)} sub="so'm (avans)" />
          </View>
        )}
        <TextInput style={s.input} value={q} onChangeText={setQ} placeholder="🔍  Ism yoki telefon raqam" autoCorrect={false} />
      </View>
      <Err err={err} />
      <FlatList
        data={data?.rows ?? []}
        keyExtractor={(r) => String(r.id)}
        refreshControl={<RefreshControl refreshing={busy} onRefresh={load} />}
        contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 12, gap: 8 }}
        renderItem={({ item: r }) => (
          <Pressable onPress={() => onOpen(r.id)} style={({ pressed }) => [s.card, { flexDirection: 'row', alignItems: 'center', gap: 8 }, pressed && { opacity: 0.6 }]}>
            <View style={{ flex: 1 }}>
              <Text style={[s.text, { fontWeight: '600' }]}>{r.name}</Text>
              <Text style={s.muted}>{r.phone ?? ''}</Text>
            </View>
            <Text style={{ fontSize: 17, fontWeight: '700', color: r.balance < 0 ? C.warn : C.text }}>{fmtMoney(r.balance)}</Text>
            {api.can('payments.create') && <Btn title="To'lov" onPress={() => onPay({ id: r.id, name: r.name, balance: r.balance })} />}
          </Pressable>
        )}
      />
    </View>
  );
}
