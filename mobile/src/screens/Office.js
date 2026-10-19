import { useEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, ScrollView, Text, TextInput, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as api from '../api';
import { ask, notify } from '../dialog';
import { Btn, CalendarModal, Chip, Err, Header, ShiftBadge, Tile, addDays, fmtDay, fmtDT, fmtMoney, todayLocal, useLoad } from '../components';
import { C, fmtQty, fmtTime, s } from '../ui';

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
  const single = from === to;
  const qs = `from=${from}&to=${to}${product ? `&product=${product}` : ''}`;
  const { data: d, err, busy, load } = useLoad(() => api.admin('GET', `/dashboard?${qs}`), [from, to, product]);
  // Open shifts change minute by minute: keep the numbers live.
  useEffect(() => { const t = setInterval(load, 20000); return () => clearInterval(t); }, [load]);
  const m = money();
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
            <Text style={[s.text, { fontWeight: '700' }]}>Mahsulotlar{m ? ' va o\'rtacha tannarx' : ''}</Text>
            {d.summary.byProduct.map((p) => (
              <View key={p.id} style={{ borderTopWidth: 1, borderColor: C.line, paddingTop: 6 }}>
                <Text style={[s.text, { fontWeight: '600' }]}>{p.name}: {fmtQty(p.quantity)} {p.unit}</Text>
                {m && <Text style={s.muted}>O'rtacha tannarx {fmtMoney(p.avg_cost)} so'm/{p.unit}</Text>}
              </View>
            ))}
            {!d.summary.byProduct.length && <Text style={s.muted}>Qabul qilingan smena yo'q</Text>}
          </View>
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

export function Shifts({ onShift, tick }) {
  const [status, setStatus] = useState('closed');
  const from = addDays(todayLocal(), -13);
  const { data, err, busy, load } = useLoad(() => api.admin('GET', `/shifts?status=${status}&from=${from}&to=${todayLocal()}`), [status, tick]);
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: 'row', gap: 6, padding: 12 }}>
        {FILTERS.map(([k, t]) => <Chip key={k} label={t} on={status === k} onPress={() => setStatus(k)} />)}
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
export function ShiftDetail({ id, onBack, onChanged }) {
  const { data: d, err, busy, load } = useLoad(() => api.admin('GET', `/shifts/${id}`), [id]);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const m = money();
  const act = async (path, body, done) => {
    try {
      await api.admin('POST', `/shifts/${id}/${path}`, body);
      notify('Tayyor', done);
      setCancelling(false);
      setReason('');
      await load();
      onChanged?.();
    } catch (e) { notify('Bo\'lmadi', e.message); }
  };
  const copySummary = async () => {
    try {
      const { text } = await api.admin('GET', `/shifts/${id}/copytext`);
      if (!text) { notify('Nusxalash', 'Nusxalash uchun ma\'lumot yo\'q.'); return; }
      await Clipboard.setStringAsync(text);
      notify('Nusxalandi', 'Smena ma\'lumotlari klaviaturaga nusxalandi.');
    } catch (e) { notify('Bo\'lmadi', e.message); }
  };
  const sh = d?.shift;
  return (
    <View style={{ flex: 1 }}>
      <Header title={sh ? `${sh.label} — ${sh.employee_name}` : '...'} onBack={onBack}
        right={d && d.rows?.length ? <Pressable onPress={copySummary} hitSlop={10} style={{ padding: 6 }}><Text style={{ fontSize: 22 }}>📋</Text></Pressable> : null} />
      <Err err={err} />
      {d && (
        <FlatList
          data={d.rows}
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
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {d.byProduct.map((p) => <Tile key={p.name} label={p.name} value={fmtQty(p.quantity)} sub={`${p.unit} · ${p.pickups} ta`} />)}
              </View>
              {sh.status === 'closed' && api.can('shifts.accept') && (
                <Btn title="Qabul qilish" onPress={() => ask('Qabul qilish', `${sh.label} smena qabul qilinsinmi? Shundan keyin u qarz va hisobotlarga kiradi.`, 'Ha', () => act('accept', null, 'Smena qabul qilindi'))} />
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
            </View>
          )}
          renderItem={({ item: r }) => (
            <View style={[s.card, { padding: 10, flexDirection: 'row', alignItems: 'center', gap: 8 }]}>
              <View style={{ flex: 1 }}>
                <Text style={[s.text, { fontWeight: '600' }]}>{r.supplier_name}</Text>
                <Text style={s.muted}>{fmtTime(r.collected_at)} · {r.product_name}{r.edited_at ? ' · tahrirlangan' : ''}
                  {m ? ` · ${r.price != null ? fmtMoney(r.price) : r.current_price != null ? `${fmtMoney(r.current_price)} (joriy)` : 'narx yo\'q!'}` : ''}</Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={{ fontSize: 18, fontWeight: '700', color: C.text }}>{fmtQty(r.quantity)} {r.unit}</Text>
                {m && r.amount != null && <Text style={s.muted}>{fmtMoney(r.amount)}</Text>}
              </View>
            </View>
          )}
        />
      )}
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
