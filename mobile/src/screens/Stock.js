import { useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, TextInput, View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import * as api from '../api';
import { ask, notify } from '../dialog';
import { Btn, Chip, Err, Header, SearchBar, fmtDT, textMatch, toNumber, useLoad } from '../components';
import { C, fmtQty, s } from '../ui';

// Warehouse part of the workplace app (Yaya 2.0, stage 1): what I hold, the
// warehouses I keep, hand-overs waiting for me, and the three everyday documents
// (hand over, write off, count). Staff never see costs — the server does not send them.
// Online only for now; offline queueing of documents comes with the workplace stage.

const DOC_STATUS = {
  draft: ['Qoralama', C.warn], sent: ['Qabul kutmoqda', C.warn], posted: ['O\'tkazilgan', C.ok], rejected: ['Rad etilgan', C.err], cancelled: ['Bekor qilingan', C.err],
};
function DocBadge({ status }) {
  const [t, color] = DOC_STATUS[status] ?? [status, C.muted];
  return (
    <View style={{ borderWidth: 1, borderColor: color, borderRadius: 99, paddingHorizontal: 8, paddingVertical: 2, alignSelf: 'flex-start' }}>
      <Text style={{ color, fontSize: 13, fontWeight: '600' }}>{t}</Text>
    </View>
  );
}
const hKey = (h) => (h?.warehouseId ? `w${h.warehouseId}` : h?.userId ? `u${h.userId}` : '');
const holderQs = (h) => (h.warehouseId ? `warehouseId=${h.warehouseId}` : `userId=${h.userId}`);

export const canStock = () => api.canAny('stock.transfer', 'stock.writeoff', 'stock.inventory', 'stock.view_all');

function StockRows({ rows, empty }) {
  if (!rows?.length) return <Text style={s.muted}>{empty}</Text>;
  return rows.map((r) => (
    <View key={`${hKey(r.holder)}-${r.product_id}`} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, paddingVertical: 6, borderBottomWidth: 1, borderColor: C.line }}>
      <View style={{ flex: 1 }}>
        <Text style={s.text}>{r.product}</Text>
        {!!r.nearest_expiry && <Text style={{ fontSize: 13, color: C.muted }}>Muddati: {r.nearest_expiry.slice(0, 10)}</Text>}
      </View>
      <Text style={[s.text, { fontWeight: '700', color: r.qty < 0 ? C.err : C.text }]}>{fmtQty(r.qty)} {r.unit}</Text>
    </View>
  ));
}

// ---------------------------------------------------------------- main screen
export function Stock({ onForm, tick }) {
  const me = api.me();
  const { data, err, busy, load } = useLoad(() => Promise.all([api.cachedGet('/api/erp/stock/mine'), api.cachedGet('/api/erp/docs')]), [tick]);
  const [rejecting, setRejecting] = useState(null);
  const [reason, setReason] = useState('');
  const [mine, docs] = data ?? [null, []];
  const act = async (fn, msg) => {
    try {
      const r = await fn();
      if (r?.queued) notify('Internet yo\'q', 'Navbatga qo\'yildi — internet chiqqanda o\'zi yuboriladi');
      else if (msg) notify('Tayyor', msg);
      load();
    } catch (e) { notify('Xatolik', e.message); }
  };
  const keeps = (mine?.warehouses ?? []).length > 0;
  return (
    <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }} refreshControl={<RefreshControl refreshing={busy} onRefresh={load} />}>
      <Err err={err} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {api.can('stock.transfer') && <Btn title="Topshirish" onPress={() => onForm('transfer')} style={{ flexGrow: 1 }} />}
        {api.can('stock.writeoff') && <Btn title="Hisobdan chiqarish" kind="ghost" onPress={() => onForm('writeoff')} style={{ flexGrow: 1 }} />}
        {api.can('stock.inventory') && keeps && <Btn title="Inventarizatsiya" kind="ghost" onPress={() => onForm('inventory')} style={{ flexGrow: 1 }} />}
      </View>

      {!!mine?.inbox?.length && (
        <View style={[s.card, { gap: 10, borderColor: C.warn }]}>
          <Text style={s.h2}>Qabul qilishingiz kerak</Text>
          {mine.inbox.map((d) => (
            <View key={d.id} style={{ gap: 6, paddingBottom: 10, borderBottomWidth: 1, borderColor: C.line }}>
              <Text style={[s.text, { fontWeight: '700' }]}>{d.label} · {d.from_name} → {d.to_name}</Text>
              <Text style={s.muted}>{fmtDT(d.doc_date)}{d.note ? ` · ${d.note}` : ''}</Text>
              {d.lines.map((l) => <Text key={l.id} style={s.text}>• {l.product}: <Text style={{ fontWeight: '700' }}>{fmtQty(l.qty)} {l.unit}</Text></Text>)}
              {rejecting === d.id ? (
                <View style={{ gap: 8 }}>
                  <TextInput style={s.input} value={reason} onChangeText={setReason} placeholder="Rad etish sababi" placeholderTextColor={C.placeholder} autoFocus />
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <Btn title="Bekor" kind="ghost" onPress={() => { setRejecting(null); setReason(''); }} style={{ flex: 1 }} />
                    <Btn title="Rad etish" kind="danger" disabled={!reason.trim()} style={{ flex: 1 }}
                      onPress={() => act(() => api.send('POST', `/api/erp/docs/${d.id}/reject`, { reason }, `Rad etish: ${d.label}`), 'Rad etildi — mahsulot topshiruvchida qoldi').then(() => { setRejecting(null); setReason(''); })} />
                  </View>
                </View>
              ) : (
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Btn title="Rad etish" kind="ghost" onPress={() => setRejecting(d.id)} style={{ flex: 1 }} />
                  <Btn title="Qabul qildim" onPress={() => act(() => api.send('POST', `/api/erp/docs/${d.id}/accept`, {}, `Qabul: ${d.label}`), 'Qabul qilindi')} style={{ flex: 2 }} />
                </View>
              )}
            </View>
          ))}
        </View>
      )}

      <View style={[s.card, { gap: 4 }]}>
        <Text style={s.h2}>Mening qo'limda</Text>
        <StockRows rows={mine?.mine} empty="Qo'lingizda mahsulot yo'q" />
      </View>
      {(mine?.warehouses ?? []).map((w) => (
        <View key={w.id} style={[s.card, { gap: 4 }]}>
          <Text style={s.h2}>{w.name}</Text>
          <StockRows rows={w.rows} empty="Omborda qoldiq yo'q" />
        </View>
      ))}

      <View style={[s.card, { gap: 8 }]}>
        <Text style={s.h2}>Hujjatlarim</Text>
        {!docs.length && <Text style={s.muted}>Hali hujjat yo'q</Text>}
        {docs.slice(0, 30).map((d) => (
          <View key={d.id} style={{ gap: 4, paddingBottom: 8, borderBottomWidth: 1, borderColor: C.line }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <Text style={[s.text, { fontWeight: '700', flex: 1 }]} numberOfLines={1}>{d.label} · {d.type_label}</Text>
              <DocBadge status={d.status} />
            </View>
            <Text style={s.muted}>{fmtDT(d.doc_date)} · {[d.from_name, d.to_name].filter(Boolean).join(' → ')} · {d.lines} qator</Text>
            {d.status === 'rejected' && !!d.reject_reason && <Text style={{ color: C.err }}>Sabab: {d.reject_reason}</Text>}
            {d.type === 'inventory' && d.status === 'draft' && d.created_by === `user:${me?.login}` && (
              <Btn title="Davom ettirish" kind="ghost" onPress={() => onForm('inventory', d.id)} />
            )}
            {(d.status === 'sent' || d.status === 'draft') && d.created_by === `user:${me?.login}` && (
              <Btn title="Qaytarib olish" kind="warn" onPress={() => ask('Qaytarib olish', `${d.label} bekor qilinsinmi?`, 'Ha',
                () => act(() => api.erp('POST', `/docs/${d.id}/cancel`, { reason: 'Xodim qaytarib oldi' }), 'Bekor qilindi'))} />
            )}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

// ---------------------------------------------------------------- pickers
function HolderChips({ options, value, onPick }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {options.map((o) => <Chip key={hKey(o.h)} label={o.label} on={hKey(o.h) === hKey(value)} onPress={() => onPick(o.h)} />)}
    </View>
  );
}

function QtyRow({ name, unit, hint, value, onChange }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6, borderBottomWidth: 1, borderColor: C.line }}>
      <View style={{ flex: 1 }}>
        <Text style={s.text}>{name}</Text>
        {!!hint && <Text style={{ fontSize: 13, color: C.muted }}>{hint}</Text>}
      </View>
      <TextInput style={[s.input, { width: 110, paddingVertical: 8, fontSize: 18, textAlign: 'right' }]} keyboardType="decimal-pad"
        value={value} onChangeText={onChange} placeholder="0" placeholderTextColor={C.placeholder} />
      <Text style={[s.muted, { width: 36 }]}>{unit}</Text>
    </View>
  );
}

// ---------------------------------------------------------------- hand over / write off
export function StockForm({ type, onBack, onDone }) {
  const me = api.me();
  const { data, err } = useLoad(() => Promise.all([api.cachedGet('/api/erp/meta'), api.cachedGet('/api/erp/stock/mine')]), []);
  const [meta, mine] = data ?? [null, null];
  const sources = useMemo(() => (!meta ? [] : [
    { h: { userId: me.id }, label: 'Mening qo\'lim' },
    ...meta.warehouses.filter((w) => meta.myWarehouses.includes(w.id)).map((w) => ({ h: { warehouseId: w.id }, label: w.name })),
  ]), [meta]); // eslint-disable-line react-hooks/exhaustive-deps
  const [fromSel, setFrom] = useState(null);
  // Empty hands and a warehouse to keep: start from the warehouse.
  const from = fromSel ?? (mine && !mine.mine.length && mine.warehouses[0] ? { warehouseId: mine.warehouses[0].id } : { userId: me.id });
  const [to, setTo] = useState(null);
  const [toQuery, setToQuery] = useState('');
  const [qty, setQty] = useState({});
  const [reasonId, setReasonId] = useState(null);
  const [chargeUser, setChargeUser] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const available = !mine ? [] : from.userId ? mine.mine : (mine.warehouses.find((w) => w.id === from.warehouseId)?.rows ?? []);
  const reason = meta?.reasons.find((r) => r.id === reasonId);
  const needCharge = type === 'writeoff' && reason?.charge === 'staff' && !from.userId;
  const targets = !meta ? [] : [
    ...meta.warehouses.map((w) => ({ h: { warehouseId: w.id }, label: w.name, sub: 'Ombor' })),
    ...meta.staff.filter((u) => u.id !== me.id).map((u) => ({ h: { userId: u.id }, label: u.name, sub: 'Xodim' })),
  ].filter((t) => hKey(t.h) !== hKey(from) && (!toQuery || textMatch(t.label, toQuery)));
  const lines = available.map((r) => ({ productId: r.product_id, qty: toNumber(qty[r.product_id] || 0) })).filter((l) => l.qty > 0);
  const over = available.find((r) => toNumber(qty[r.product_id] || 0) > r.qty);
  const ok = lines.length && !over && (type === 'transfer' ? !!to : !!reasonId && (!needCharge || !!chargeUser));

  const submit = async () => {
    setBusy(true);
    try {
      const body = { type, uuid: randomUUID(), from, lines, note: note || null };
      if (type === 'transfer') body.to = to;
      else { body.reasonId = reasonId; if (chargeUser) body.chargeUserId = chargeUser; }
      const d = await api.send('POST', '/api/erp/docs', body, type === 'transfer' ? 'Topshirish' : 'Hisobdan chiqarish');
      if (d.queued) { onDone('Internet yo\'q — navbatga qo\'yildi, internet chiqqanda o\'zi yuboriladi'); return; }
      onDone(type === 'transfer' ? `${d.label} yuborildi — qabul qiluvchi tasdiqlashi kerak` : `${d.label} hisobdan chiqarildi`);
    } catch (e) { notify('Xatolik', e.message); } finally { setBusy(false); }
  };

  return (
    <View style={{ flex: 1 }}>
      <Header title={type === 'transfer' ? 'Topshirish' : 'Hisobdan chiqarish'} onBack={onBack} />
      <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }} keyboardShouldPersistTaps="handled">
        <Err err={err} />
        <View style={[s.card, { gap: 8 }]}>
          <Text style={s.muted}>Qayerdan</Text>
          <HolderChips options={sources} value={from} onPick={(h) => { setFrom(h); setQty({}); if (hKey(h) === hKey(to)) setTo(null); }} />
        </View>
        <View style={[s.card, { gap: 2 }]}>
          <Text style={[s.muted, { marginBottom: 4 }]}>Mahsulot va miqdor</Text>
          {!available.length && <Text style={s.muted}>Bu yerda mahsulot yo'q</Text>}
          {available.filter((r) => r.qty > 0).map((r) => (
            <QtyRow key={r.product_id} name={r.product} unit={r.unit} hint={`Bor: ${fmtQty(r.qty)} ${r.unit}`}
              value={qty[r.product_id] ?? ''} onChange={(v) => setQty((q) => ({ ...q, [r.product_id]: v }))} />
          ))}
          {!!over && <Text style={s.err}>{over.product}: bor miqdordan ko'p</Text>}
        </View>
        {type === 'transfer' ? (
          <View style={[s.card, { gap: 8 }]}>
            <Text style={s.muted}>Kimga</Text>
            <SearchBar value={toQuery} onChange={setToQuery} placeholder="🔍  Ombor yoki xodim" />
            {targets.slice(0, 40).map((t) => (
              <Pressable key={hKey(t.h)} onPress={() => setTo(t.h)}
                style={[s.btnGhost, { paddingVertical: 10, paddingHorizontal: 12, alignItems: 'flex-start' }, hKey(t.h) === hKey(to) && { backgroundColor: C.accent, borderColor: C.accent }]}>
                <Text style={[s.btnGhostText, hKey(t.h) === hKey(to) && { color: C.accentText }]}>{t.label} <Text style={{ fontSize: 13, fontWeight: '400' }}>· {t.sub}</Text></Text>
              </Pressable>
            ))}
          </View>
        ) : (
          <View style={[s.card, { gap: 8 }]}>
            <Text style={s.muted}>Sabab</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {(meta?.reasons ?? []).map((r) => <Chip key={r.id} label={r.name} on={r.id === reasonId} onPress={() => setReasonId(r.id)} />)}
            </View>
            {reason?.charge === 'staff' && from.userId && <Text style={{ color: C.warn }}>Mahsulot qiymati sizning hisobingizga yoziladi.</Text>}
            {needCharge && (
              <>
                <Text style={s.muted}>Kimning aybi bilan?</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  {(meta?.staff ?? []).map((u) => <Chip key={u.id} label={u.name} on={u.id === chargeUser} onPress={() => setChargeUser(u.id)} />)}
                </View>
              </>
            )}
          </View>
        )}
        <TextInput style={s.input} value={note} onChangeText={setNote} placeholder="Izoh (ixtiyoriy)" placeholderTextColor={C.placeholder} />
        <Btn title={busy ? 'Yuborilmoqda...' : type === 'transfer' ? 'Topshirish' : 'Hisobdan chiqarish'} onPress={submit} disabled={!ok || busy} />
      </ScrollView>
    </View>
  );
}

// ---------------------------------------------------------------- stock count
export function InventoryForm({ docId, onBack, onDone }) {
  const { data, err } = useLoad(async () => {
    const [meta, mine, products] = await Promise.all([api.erp('GET', '/meta'), api.erp('GET', '/stock/mine'), api.erp('GET', '/products')]);
    const doc = docId ? await api.erp('GET', `/docs/${docId}`) : null;
    return { meta, mine, products, doc };
  }, [docId]);
  const [wh, setWh] = useState(null);
  const [counts, setCounts] = useState(null);
  const [extra, setExtra] = useState([]);
  const [query, setQuery] = useState('');
  const [preview, setPreview] = useState(null);
  const [saved, setSaved] = useState(docId ?? null);
  const [busy, setBusy] = useState(false);
  const warehouses = data ? data.mine.warehouses : [];
  const whId = wh ?? data?.doc?.to?.warehouseId ?? warehouses[0]?.id;
  const book = warehouses.find((w) => w.id === whId)?.rows ?? [];
  // Counted values: from the saved draft, else empty (the person types what they see).
  const cnt = counts ?? Object.fromEntries((data?.doc?.lines ?? []).map((l) => [l.product_id, String(l.qty)]));
  const listed = [...book.map((r) => ({ id: r.product_id, name: r.product, unit: r.unit })),
    ...extra.filter((p) => !book.some((r) => r.product_id === p.id))];
  for (const l of data?.doc?.lines ?? []) if (!listed.some((x) => x.id === l.product_id)) listed.push({ id: l.product_id, name: l.product, unit: l.unit });
  const lines = listed.filter((p) => cnt[p.id] !== undefined && cnt[p.id] !== '').map((p) => ({ productId: p.id, qty: toNumber(cnt[p.id]) }));
  const matches = query ? (data?.products ?? []).filter((p) => textMatch(p.name, query) && !listed.some((x) => x.id === p.id)).slice(0, 8) : [];

  const save = async () => {
    const body = { lines, mode: 'partial' };
    if (saved) await api.erp('PUT', `/docs/${saved}`, body);
    else {
      const d = await api.erp('POST', '/docs', { type: 'inventory', uuid: randomUUID(), to: { warehouseId: whId }, ...body }, { idempotent: true });
      setSaved(d.id);
      return d.id;
    }
    return saved;
  };
  const check = async () => {
    setBusy(true);
    try { const id = await save(); setPreview(await api.erp('GET', `/docs/${id}/preview`)); } catch (e) { notify('Xatolik', e.message); } finally { setBusy(false); }
  };
  const post = async () => {
    setBusy(true);
    try {
      const d = await api.erp('POST', `/docs/${saved}/post`, {});
      onDone(`${d.label} o'tkazildi`);
    } catch (e) {
      if (e.message.includes('Kamomad')) onDone('Kamomad chiqdi. Sanoq saqlandi — rahbar kim hisobiga ekanini hal qilib o\'tkazadi.');
      else notify('Xatolik', e.message);
    } finally { setBusy(false); }
  };

  if (preview) {
    return (
      <View style={{ flex: 1 }}>
        <Header title="Sanoq natijasi" onBack={() => setPreview(null)} />
        <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }}>
          <View style={[s.card, { gap: 4 }]}>
            {!preview.lines.length && <Text style={s.text}>Farq yo'q — hisob va sanoq bir xil.</Text>}
            {preview.lines.map((l) => (
              <View key={l.id} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6, borderBottomWidth: 1, borderColor: C.line }}>
                <View style={{ flex: 1 }}><Text style={s.text}>{l.product}</Text><Text style={{ fontSize: 13, color: C.muted }}>Hisobda {fmtQty(l.book)} · sanaldi {fmtQty(l.qty)}</Text></View>
                <Text style={{ fontSize: 18, fontWeight: '700', color: l.diff < 0 ? C.err : C.ok }}>{l.diff > 0 ? '+' : ''}{fmtQty(l.diff)} {l.unit}</Text>
              </View>
            ))}
          </View>
          {preview.lines.some((l) => l.diff < 0) && <Text style={{ color: C.warn }}>Kamomad bor. Kim hisobiga yozilishini rahbar hal qiladi.</Text>}
          <Btn title="Yana sanash" kind="ghost" onPress={() => setPreview(null)} />
          <Btn title={busy ? '...' : 'Yakunlash'} onPress={post} disabled={busy} />
        </ScrollView>
      </View>
    );
  }
  return (
    <View style={{ flex: 1 }}>
      <Header title="Inventarizatsiya" onBack={onBack} />
      <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }} keyboardShouldPersistTaps="handled">
        <Err err={err} />
        {!saved && warehouses.length > 1 && (
          <View style={[s.card, { gap: 8 }]}>
            <Text style={s.muted}>Ombor</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {warehouses.map((w) => <Chip key={w.id} label={w.name} on={w.id === whId} onPress={() => { setWh(w.id); setCounts({}); setExtra([]); }} />)}
            </View>
          </View>
        )}
        <Text style={s.muted}>Har bir mahsulotdan nechta borligini sanab yozing. Yozilmaganlari o'zgarmaydi.</Text>
        <View style={[s.card, { gap: 2 }]}>
          {!listed.length && <Text style={s.muted}>Omborda hisobda mahsulot yo'q. Pastdan qo'shing.</Text>}
          {listed.map((p) => (
            <QtyRow key={p.id} name={p.name} unit={p.unit} value={cnt[p.id] ?? ''} onChange={(v) => setCounts({ ...cnt, [p.id]: v })} />
          ))}
        </View>
        <View style={[s.card, { gap: 8 }]}>
          <Text style={s.muted}>Hisobda yo'q mahsulot topildimi?</Text>
          <SearchBar value={query} onChange={setQuery} placeholder="🔍  Mahsulot nomi" />
          {matches.map((p) => (
            <Pressable key={p.id} onPress={() => { setExtra((x) => [...x, { id: p.id, name: p.name, unit: p.unit }]); setQuery(''); }} style={[s.btnGhost, { paddingVertical: 10 }]}>
              <Text style={s.btnGhostText}>+ {p.name}</Text>
            </Pressable>
          ))}
        </View>
        <Btn title={busy ? '...' : 'Saqlab, farqlarni ko\'rish'} onPress={check} disabled={busy || !lines.length || !whId} />
        <Btn title="Qoralama saqlash" kind="ghost" disabled={busy || !lines.length || !whId}
          onPress={async () => { try { await save(); onDone('Sanoq saqlandi — keyin davom ettirishingiz mumkin'); } catch (e) { notify('Xatolik', e.message); } }} />
      </ScrollView>
    </View>
  );
}
