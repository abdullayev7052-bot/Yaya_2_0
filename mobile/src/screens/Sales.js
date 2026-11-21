import { useMemo, useState } from 'react';
import { Platform, Pressable, RefreshControl, ScrollView, Text, TextInput, View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import * as api from '../api';
import { notify } from '../dialog';
import { Btn, Chip, Err, Header, SearchBar, fmtDT, fmtMoney, textMatch, toNumber, useLoad } from '../components';
import { C, fmtQty, s } from '../ui';

// Seller's workplace (Yaya 2.0, stage 4): sell from their hands or a warehouse they
// keep, take returns (each return type goes to its warehouse), take payments, and
// print the 80 mm receipt. Sellers see prices, totals and the customer's debt
// (they are on the receipt) but never cost — the server does not send it.

const sales = (method, path, body, opts) => api.salesApi(method, path, body, opts);
export const canSell = () => api.canAny('sales.sell', 'sales.return');
const hKey = (h) => (h?.warehouseId ? `w${h.warehouseId}` : h?.userId ? `u${h.userId}` : '');

function printHtml(html) {
  if (Platform.OS !== 'web') { notify('Chop etish', "Printer ilova yig'ilganda ulanadi. Hozircha chekni brauzer/monoblokdan chop eting."); return; }
  const w = globalThis.open('', '_blank', 'width=420,height=700');
  if (!w) { notify('Chop etish', 'Brauzer yangi oynani ochishga ruxsat bermadi'); return; }
  w.document.write(html.replace('</body>', '<script>window.onload = () => setTimeout(() => window.print(), 300);<\/script></body>'));
  w.document.close();
}

// ---------------------------------------------------------------- main
export function SalesHome({ tick, onForm, onOpen }) {
  const { data, err, busy, load } = useLoad(() => Promise.all([
    api.can('sales.sell') ? sales('GET', '/my-cashbox') : null,
    sales('GET', `/docs?from=${new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10)}`),
  ]), [tick]);
  const [box, docs] = data ?? [null, []];
  return (
    <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }} refreshControl={<RefreshControl refreshing={busy} onRefresh={load} />}>
      <Err err={err} />
      {box && (
        <View style={[s.card, { gap: 4 }]}>
          <Text style={s.muted}>{box.name}</Text>
          <Text style={{ fontSize: 26, fontWeight: '700', color: C.text }}>{fmtMoney(box.balance)} so'm</Text>
        </View>
      )}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {api.can('sales.sell') && <Btn title="Sotish" onPress={() => onForm('sale')} style={{ flexGrow: 1 }} />}
        {api.can('sales.return') && <Btn title="Qaytarish" kind="ghost" onPress={() => onForm('return')} style={{ flexGrow: 1 }} />}
        {api.can('sales.sell') && <Btn title="To'lov olish" kind="ghost" onPress={() => onForm('payment')} style={{ flexGrow: 1 }} />}
      </View>
      <View style={[s.card, { gap: 8 }]}>
        <Text style={s.h2}>Bugun</Text>
        {!docs.length && <Text style={s.muted}>Hali hujjat yo'q</Text>}
        {docs.map((d) => (
          <Pressable key={d.id} onPress={() => onOpen(d.id)} style={({ pressed }) => [{ paddingVertical: 8, borderBottomWidth: 1, borderColor: C.line, gap: 2 }, pressed && { opacity: 0.6 }]}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
              <Text style={[s.text, { fontWeight: '700', flex: 1, textDecorationLine: d.status === 'cancelled' ? 'line-through' : 'none' }]} numberOfLines={1}>{d.label} · {d.customer?.name}</Text>
              <Text style={[s.text, { fontWeight: '700' }]}>{fmtMoney(d.total)}</Text>
            </View>
            <Text style={s.muted}>{d.type_label}{d.return_type ? ` (${d.return_type})` : ''} · {fmtDT(d.doc_date)}{d.status === 'cancelled' ? ' · bekor qilingan' : ''}</Text>
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}

// ---------------------------------------------------------------- customer picker
function CustomerPick({ value, onPick }) {
  const { data: list, load } = useLoad(() => sales('GET', '/customers'), []);
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  if (value) {
    return (
      <Pressable onPress={() => onPick(null)} style={[s.card, { gap: 2 }]}>
        <Text style={s.muted}>Mijoz (o'zgartirish uchun bosing)</Text>
        <Text style={[s.text, { fontWeight: '700' }]}>{value.name}</Text>
        <Text style={{ color: value.balance > 0 ? C.err : C.muted }}>Qarzi: {fmtMoney(value.balance)} so'm</Text>
      </Pressable>
    );
  }
  const shown = (list ?? []).filter((c) => !q || textMatch(`${c.name} ${c.phone ?? ''}`, q)).slice(0, 30);
  const add = async () => {
    try {
      const r = await sales('POST', '/customers', { name, phone });
      await load();
      onPick({ id: r.id, name, phone, balance: 0 });
    } catch (e) { notify('Xatolik', e.message); }
  };
  return (
    <View style={[s.card, { gap: 8 }]}>
      <Text style={s.muted}>Mijoz</Text>
      <SearchBar value={q} onChange={setQ} placeholder="🔍  Mijoz nomi yoki telefoni" />
      {shown.map((c) => (
        <Pressable key={c.id} onPress={() => onPick(c)} style={[s.btnGhost, { paddingVertical: 10, paddingHorizontal: 12, alignItems: 'flex-start' }]}>
          <Text style={s.btnGhostText}>{c.name}</Text>
          <Text style={{ fontSize: 13, color: c.balance > 0 ? C.err : C.muted }}>{c.type_name ? `${c.type_name} · ` : ''}qarzi {fmtMoney(c.balance)}</Text>
        </Pressable>
      ))}
      {api.can('sales.sell') && (adding ? (
        <View style={{ gap: 8 }}>
          <TextInput style={s.input} value={name} onChangeText={setName} placeholder="Yangi mijoz nomi" placeholderTextColor={C.placeholder} />
          <TextInput style={s.input} value={phone} onChangeText={setPhone} placeholder="Telefon" keyboardType="phone-pad" placeholderTextColor={C.placeholder} />
          <Btn title="Qo'shish" onPress={add} disabled={!name.trim()} />
        </View>
      ) : <Btn title="+ Yangi mijoz" kind="ghost" onPress={() => setAdding(true)} />)}
    </View>
  );
}

function Qty({ value, onChange, unit, width = 90 }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
      <TextInput style={[s.input, { width, paddingVertical: 8, fontSize: 18, textAlign: 'right' }]} keyboardType="decimal-pad" value={String(value ?? '')}
        onChangeText={onChange} placeholder="0" placeholderTextColor={C.placeholder} />
      {!!unit && <Text style={s.muted}>{unit}</Text>}
    </View>
  );
}

// ---------------------------------------------------------------- sale / return / payment
export function SaleForm({ type, onBack, onDone }) {
  const { data, err } = useLoad(() => Promise.all([sales('GET', '/meta'), api.erp('GET', '/stock/mine'), api.erp('GET', '/products')]), []);
  const [meta, mine, products] = data ?? [null, null, []];
  const [customer, setCustomer] = useState(null);
  const { data: prices } = useLoad(() => (customer ? sales('GET', `/prices?customerId=${customer.id}`) : Promise.resolve({})), [customer?.id]);
  const [src, setSrc] = useState(null);
  const [qty, setQty] = useState({});
  const [priceOver, setPriceOver] = useState({});
  const [paid, setPaid] = useState('');
  const [methodId, setMethodId] = useState(null);
  const [rtId, setRtId] = useState(null);
  const [costMode, setCostMode] = useState('last');
  const [amount, setAmount] = useState('');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const source = src ?? (meta ? (mine && !mine.mine.length && meta.sources[1] ? meta.sources[1] : meta.sources[0]) : null);
  const methods = (meta?.methods ?? []).filter((m) => m.active);
  const method = methodId ?? methods[0]?.id;
  // What can be sold: what is at the chosen place.
  const available = useMemo(() => {
    if (!mine || !source) return [];
    return source.userId ? mine.mine : (mine.warehouses.find((w) => w.id === source.warehouseId)?.rows ?? []);
  }, [mine, source]);
  const items = type === 'sale'
    ? available.filter((r) => r.qty > 0).map((r) => ({ id: r.product_id, name: r.product, unit: r.unit, have: r.qty }))
    : products.filter((p) => ['finished', 'returned', 'recycled', 'other'].includes(p.kind)).map((p) => ({ id: p.id, name: p.name, unit: p.unit }));
  const shown = items.filter((x) => !q || textMatch(x.name, q) || toNumber(qty[x.id] || 0) > 0);
  const priceOf = (id) => (priceOver[id] !== undefined && priceOver[id] !== '' ? toNumber(priceOver[id]) : prices?.[id]);
  const lines = items.filter((x) => toNumber(qty[x.id] || 0) > 0).map((x) => ({ productId: x.id, qty: toNumber(qty[x.id]), price: priceOf(x.id), name: x.name, have: x.have }));
  const total = Math.round(lines.reduce((a, l) => a + l.qty * (l.price ?? 0), 0) * 100) / 100;
  const over = lines.find((l) => l.have != null && l.qty > l.have);
  const noPrice = type === 'sale' && lines.find((l) => l.price == null);
  const returnTypes = (meta?.returnTypes ?? []).filter((r) => r.active);
  const rt = rtId ?? returnTypes[0]?.id;

  const submit = async () => {
    setBusy(true);
    try {
      let d;
      const uuid = randomUUID();
      const withPrice = (l) => ({ productId: l.productId, qty: l.qty, ...(priceOver[l.productId] !== undefined && priceOver[l.productId] !== '' ? { price: toNumber(priceOver[l.productId]) } : {}) });
      if (type === 'sale') d = await sales('POST', '/sales', { uuid, customerId: customer.id, from: source.userId ? { userId: source.userId } : { warehouseId: source.warehouseId }, lines: lines.map(withPrice), paid: toNumber(paid || 0), methodId: method }, { idempotent: true });
      else if (type === 'return') d = await sales('POST', '/returns', { uuid, customerId: customer.id, returnTypeId: rt, costMode, lines: lines.map(withPrice) }, { idempotent: true });
      else d = await sales('POST', '/payments', { uuid, customerId: customer.id, amount: toNumber(amount), methodId: method }, { idempotent: true });
      onDone(d.id);
    } catch (e) { notify('Xatolik', e.message); } finally { setBusy(false); }
  };
  const title = { sale: 'Sotish', return: 'Qaytarish', payment: "To'lov olish" }[type];
  const ok = customer && (type === 'payment' ? toNumber(amount) > 0 : lines.length && !over && !noPrice && (type !== 'return' || rt));
  return (
    <View style={{ flex: 1 }}>
      <Header title={title} onBack={onBack} />
      <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }} keyboardShouldPersistTaps="handled">
        <Err err={err} />
        <CustomerPick value={customer} onPick={setCustomer} />
        {customer && type === 'sale' && meta && meta.sources.length > 1 && (
          <View style={[s.card, { gap: 8 }]}>
            <Text style={s.muted}>Qayerdan</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {meta.sources.map((x) => <Chip key={hKey(x)} label={x.name} on={hKey(x) === hKey(source)} onPress={() => { setSrc(x); setQty({}); }} />)}
            </View>
          </View>
        )}
        {customer && type === 'return' && (
          <View style={[s.card, { gap: 8 }]}>
            <Text style={s.muted}>Qaytarish turi</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {returnTypes.map((r) => <Chip key={r.id} label={`${r.name} → ${r.warehouse ?? '?'}`} on={r.id === rt} onPress={() => setRtId(r.id)} />)}
            </View>
            {!returnTypes.length && <Text style={s.err}>Qaytarish turlari sozlanmagan (panel → Savdo → Sozlamalar)</Text>}
            <Text style={s.muted}>Qaytgan mahsulot tannarxi</Text>
            <View style={{ flexDirection: 'row', gap: 6 }}>
              <Chip label="Oxirgi partiya" on={costMode === 'last'} onPress={() => setCostMode('last')} />
              <Chip label={`O'rtacha (${meta?.returnAvgDays ?? 7} kun)`} on={costMode === 'avg'} onPress={() => setCostMode('avg')} />
            </View>
          </View>
        )}
        {customer && type !== 'payment' && (
          <View style={[s.card, { gap: 4 }]}>
            <SearchBar value={q} onChange={setQ} placeholder="🔍  Mahsulot" />
            {!items.length && <Text style={s.muted}>{type === 'sale' ? 'Bu joyda sotiladigan mahsulot yo\'q' : 'Mahsulot yo\'q'}</Text>}
            {shown.map((x) => {
              const p = priceOf(x.id);
              const n = toNumber(qty[x.id] || 0);
              return (
                <View key={x.id} style={{ paddingVertical: 6, borderBottomWidth: 1, borderColor: C.line, gap: 4 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <View style={{ flex: 1 }}>
                      <Text style={s.text}>{x.name}</Text>
                      <Text style={{ fontSize: 13, color: p == null && type === 'sale' ? C.err : C.muted }}>
                        {p == null ? (type === 'sale' ? 'narx belgilanmagan' : 'narx: oxirgi sotuvdan') : `${fmtMoney(p)} so'm`}{x.have != null ? ` · bor: ${fmtQty(x.have)} ${x.unit}` : ''}
                      </Text>
                    </View>
                    <Qty value={qty[x.id] ?? ''} unit={x.unit} onChange={(val) => setQty((o) => ({ ...o, [x.id]: val }))} />
                  </View>
                  {meta?.canEditPrice && n > 0 && (
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
                      <Text style={s.muted}>Narx:</Text>
                      <Qty value={priceOver[x.id] ?? (p ?? '')} unit="so'm" width={110} onChange={(val) => setPriceOver((o) => ({ ...o, [x.id]: val }))} />
                    </View>
                  )}
                </View>
              );
            })}
            {!!over && <Text style={s.err}>{over.name}: bor miqdordan ko'p</Text>}
          </View>
        )}
        {customer && type !== 'payment' && lines.length > 0 && (
          <View style={[s.card, { gap: 6 }]}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text style={s.h2}>Jami</Text>
              <Text style={s.h2}>{fmtMoney(total)} so'm</Text>
            </View>
            {type === 'return' && <Text style={s.muted}>Mijoz qarzidan ayriladigan summa: muddati o'tgan bo'lsa, mijoz siyosatiga qarab.</Text>}
          </View>
        )}
        {customer && type === 'sale' && lines.length > 0 && (
          <View style={[s.card, { gap: 8 }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text style={s.text}>Hozir to'landi</Text>
              <Qty value={paid} unit="so'm" width={130} onChange={setPaid} />
            </View>
            <View style={{ flexDirection: 'row', gap: 6 }}>
              <Chip label="Hammasi" on={toNumber(paid || 0) === total} onPress={() => setPaid(String(total))} />
              <Chip label="Qarzga" on={!toNumber(paid || 0)} onPress={() => setPaid('')} />
            </View>
            {toNumber(paid || 0) > 0 && (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                {methods.map((m) => <Chip key={m.id} label={m.name} on={m.id === method} onPress={() => setMethodId(m.id)} />)}
              </View>
            )}
            <Text style={s.muted}>Savdodan keyin qarzi: {fmtMoney((customer.balance ?? 0) + total - toNumber(paid || 0))} so'm</Text>
          </View>
        )}
        {customer && type === 'payment' && (
          <View style={[s.card, { gap: 8 }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text style={s.text}>Summa</Text>
              <Qty value={amount} unit="so'm" width={140} onChange={setAmount} />
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {methods.map((m) => <Chip key={m.id} label={m.name} on={m.id === method} onPress={() => setMethodId(m.id)} />)}
            </View>
          </View>
        )}
        {customer && <Btn title={busy ? '...' : title} onPress={submit} disabled={!ok || busy} />}
      </ScrollView>
    </View>
  );
}

// ---------------------------------------------------------------- receipt
export function SaleView({ id, onBack }) {
  const { data: d, err } = useLoad(() => sales('GET', `/docs/${id}`), [id]);
  const print = async () => {
    try { printHtml((await sales('GET', `/docs/${id}/receipt`)).html); } catch (e) { notify('Xatolik', e.message); }
  };
  return (
    <View style={{ flex: 1 }}>
      <Header title={d ? `${d.type_label} ${d.label}` : 'Chek'} onBack={onBack} />
      <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }}>
        <Err err={err} />
        {d && (
          <View style={[s.card, { gap: 6 }]}>
            {d.status === 'cancelled' && <Text style={s.err}>Bekor qilingan</Text>}
            <Text style={s.text}>{d.customer?.name}</Text>
            <Text style={s.muted}>{fmtDT(d.doc_date)} · {d.seller}{d.return_type ? ` · ${d.return_type}` : ''}</Text>
            {d.lines.map((l) => (
              <View key={l.id} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4, borderBottomWidth: 1, borderColor: C.line }}>
                <Text style={[s.text, { flex: 1 }]}>{l.product}{'\n'}<Text style={s.muted}>{fmtQty(l.qty)} {l.unit} × {fmtMoney(l.price)}</Text></Text>
                <Text style={[s.text, { fontWeight: '700' }]}>{fmtMoney(l.sum)}</Text>
              </View>
            ))}
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><Text style={s.h2}>Jami</Text><Text style={s.h2}>{fmtMoney(d.total)}</Text></View>
            {d.type === 'sale' && <Text style={s.text}>To'landi: {fmtMoney(d.paid)}{d.method ? ` (${d.method})` : ''}</Text>}
            {d.type === 'return' && <Text style={s.text}>Qarzdan ayrildi: {fmtMoney(d.credit)}</Text>}
            <Text style={s.text}>Qarz: {fmtMoney(d.debt_before)} → <Text style={{ fontWeight: '700' }}>{fmtMoney(d.debt_after)}</Text></Text>
          </View>
        )}
        {d && <Btn title="Chekni chop etish" onPress={print} />}
      </ScrollView>
    </View>
  );
}
