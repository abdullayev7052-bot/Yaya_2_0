import { useState } from 'react';
import { FlatList, Pressable, RefreshControl, ScrollView, Text, TextInput, View } from 'react-native';
import * as api from '../api';
import * as store from '../db';
import { ask, notify } from '../dialog';
import { Btn, Chip, Err, Header, Keypad, METHOD, Tile, fmtDT, fmtMoney, useLoad } from '../components';
import { C, fmtQty, s } from '../ui';

// Supplier card for everyone in the app: kg history (never prices), the current
// debt or advance, recent payments and a "pay" button when allowed.
export function SupplierCard({ id, onBack, onPay }) {
  const { data: c, err, busy, load } = useLoad(() => api.mobile('GET', `/suppliers/${id}/card`), [id]);
  const [renaming, setRenaming] = useState(null);
  const local = api.getSuppliers().find((x) => x.id === id);
  const name = c?.supplier.name ?? local?.name ?? '...';
  const canPay = c ? c.canPay : api.can('payments.create');
  // Payments made on this phone that have not reached the server yet.
  const unsent = store.recentPayments().filter((p) => p.supplier_id === id && !p.synced_at);

  const rename = async () => {
    try {
      await api.admin('PATCH', `/suppliers/${id}`, { name: renaming.trim() });
      setRenaming(null);
      await load();
      api.syncNow();
    } catch (e) { notify('Xato', e.message); }
  };

  const bal = c?.balance;
  return (
    <View style={{ flex: 1 }}>
      <Header title={name} onBack={onBack}
        right={canPay ? <Btn title="To'lov" onPress={() => onPay({ id, name, balance: bal })} /> : null} />
      <Err err={err && `${err}${err.includes('Internet') ? ' — kartochka uchun internet kerak. To\'lovni internetsiz ham kiritish mumkin.' : ''}`} />
      <FlatList
        data={c?.pickups ?? []}
        keyExtractor={(_, i) => `p${i}`}
        refreshControl={<RefreshControl refreshing={busy} onRefresh={load} />}
        contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 16, gap: 6 }}
        ListHeaderComponent={c ? (
          <View style={{ gap: 10, marginBottom: 8 }}>
            {!!(c.supplier.phone || c.supplier.address) && <Text style={s.muted}>{[c.supplier.phone, c.supplier.address].filter(Boolean).join(' · ')}</Text>}
            {renaming != null ? (
              <View style={{ gap: 8 }}>
                <TextInput style={s.input} value={renaming} onChangeText={setRenaming} autoFocus />
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Btn title="Bekor" kind="ghost" style={{ flex: 1 }} onPress={() => setRenaming(null)} />
                  <Btn title="Saqlash" style={{ flex: 1 }} disabled={!renaming.trim()} onPress={rename} />
                </View>
              </View>
            ) : c.canEdit && <Btn title="Ismini tahrirlash" kind="ghost" onPress={() => setRenaming(c.supplier.name)} />}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              <Tile label={bal > 0 ? 'Biz qarzmiz' : bal < 0 ? 'Bizga qarz (avans)' : 'Qarz yo\'q'} value={fmtMoney(Math.abs(bal ?? 0))} sub="so'm" />
              <Tile label="Oxirgi marta" value={c.lastPickup ? `${fmtQty(c.lastPickup.quantity)} ${c.lastPickup.unit}` : '—'}
                sub={c.lastPickup ? `${fmtDT(c.lastPickup.collected_at)} · ${c.lastPickup.product_name}` : ''} />
            </View>
            {!!unsent.length && (
              <Text style={{ color: C.warn }}>Telefonda yuborilmagan to'lov: {unsent.map((p) => `${fmtMoney(p.amount)} so'm`).join(', ')} — qarzga internet bo'lganda qo'shiladi</Text>
            )}
            {!!c.payments.length && (
              <View style={[s.card, { gap: 4 }]}>
                <Text style={[s.text, { fontWeight: '700' }]}>To'lovlar</Text>
                {c.payments.slice(0, 10).map((p, i) => (
                  <Text key={i} style={[s.text, p.voided_at && { textDecorationLine: 'line-through', color: C.muted }]}>
                    {fmtDT(p.paid_at)} · {fmtMoney(p.amount)} so'm · {METHOD[p.method] ?? p.method}
                  </Text>
                ))}
              </View>
            )}
            <Text style={[s.text, { fontWeight: '700' }]}>Topshirgan suti</Text>
            {!c.pickups.length && <Text style={s.muted}>Hali yozuv yo'q</Text>}
          </View>
        ) : null}
        renderItem={({ item: p }) => (
          <View style={[s.card, { padding: 10, flexDirection: 'row', alignItems: 'center', gap: 8 }, !p.counted && { opacity: 0.7 }]}>
            <View style={{ flex: 1 }}>
              <Text style={s.text}>{fmtDT(p.collected_at)} · {p.product_name}</Text>
              <Text style={s.muted}>{p.shift} · {p.by_name}{p.counted ? '' : p.status === 'open' ? ' · ochiq smena' : ' · qabul kutmoqda'}</Text>
            </View>
            <Text style={{ fontSize: 18, fontWeight: '700', color: C.text }}>{fmtQty(p.quantity)} {p.unit}</Text>
          </View>
        )}
      />
    </View>
  );
}

// Payment is written to the phone first and uploaded by the background sync,
// so it works without internet. It reduces our debt as soon as it reaches the server.
export function PaymentForm({ supplier, onBack, onDone }) {
  const [amount, setAmount] = useState(supplier.balance > 0 ? String(Math.round(supplier.balance)) : '');
  const [method, setMethod] = useState('cash');
  const value = Number(amount);
  const save = () => {
    if (!(value > 0)) return;
    ask('To\'lovni tasdiqlang', `${supplier.name}\n${fmtMoney(value)} so'm (${METHOD[method]})`, 'Ha, saqlash', () => {
      store.addPayment({ supplier, amount: value, method });
      api.syncNow();
      onDone(`To'lov saqlandi: ${supplier.name} — ${fmtMoney(value)} so'm ✓`);
    });
  };
  return (
    <View style={{ flex: 1, padding: 12, gap: 10 }}>
      <Header title={`To'lov: ${supplier.name}`} onBack={onBack} />
      {supplier.balance != null && (
        <Text style={s.muted}>{supplier.balance >= 0 ? `Joriy qarzimiz: ${fmtMoney(supplier.balance)} so'm` : `Bizga qarz (avans): ${fmtMoney(-supplier.balance)} so'm`}</Text>
      )}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {Object.entries(METHOD).map(([k, t]) => <Chip key={k} label={t} on={method === k} onPress={() => setMethod(k)} />)}
      </View>
      <View style={[s.card, { alignItems: 'flex-end', paddingVertical: 18 }]}>
        <Text style={{ fontSize: 44, fontWeight: '700', color: amount ? C.text : C.line }} adjustsFontSizeToFit numberOfLines={1}>
          {fmtMoney(value || 0)} <Text style={{ fontSize: 22, color: C.muted }}>so'm</Text>
        </Text>
      </View>
      <Keypad value={amount} onChange={setAmount} onSubmit={save} onCancel={onBack} decimals={0} maxDigits={11} />
      <Pressable style={[s.btn, { paddingVertical: 20 }, !(value > 0) && { opacity: 0.4 }]} onPress={save} disabled={!(value > 0)}>
        <Text style={s.btnText}>To'lovni saqlash</Text>
      </Pressable>
    </View>
  );
}

// A farmer met in the field. Online only; the admin sets the price later
// (the shift cannot be accepted until then).
export function NewSupplier({ onBack, onCreated }) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const products = api.getProducts();
  const [picked, setPicked] = useState(products.length === 1 ? [products[0].id] : []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const toggle = (id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const save = async () => {
    setBusy(true);
    setErr('');
    try {
      const r = await api.mobile('POST', '/suppliers', { name, phone, address, productIds: picked });
      await api.refreshBootstrap();
      onCreated(api.getSuppliers().find((x) => x.id === r.id) ?? null);
    } catch (e) { setErr(e.offline ? 'Yangi yetkazib beruvchi qo\'shish uchun internet kerak' : e.message); } finally { setBusy(false); }
  };
  return (
    <View style={{ flex: 1 }}>
      <Header title="Yangi yetkazib beruvchi" onBack={onBack} />
      <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }} keyboardShouldPersistTaps="handled">
        <TextInput style={s.input} value={name} onChangeText={setName} placeholder="Ism familiya" />
        <TextInput style={s.input} value={phone} onChangeText={setPhone} placeholder="Telefon (ixtiyoriy)" keyboardType="phone-pad" />
        <TextInput style={s.input} value={address} onChangeText={setAddress} placeholder="Manzil (ixtiyoriy)" />
        <Text style={s.muted}>Qaysi mahsulotni topshiradi?</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {products.map((p) => <Chip key={p.id} label={p.name} on={picked.includes(p.id)} onPress={() => toggle(p.id)} />)}
        </View>
        <Text style={s.muted}>Narxni admin belgilaydi. Narx belgilanmaguncha smena qabul qilinmaydi.</Text>
        {!!err && <Text style={s.err}>{err}</Text>}
        <Btn title={busy ? 'Saqlanmoqda...' : 'Qo\'shish'} disabled={busy || !name.trim() || !picked.length} onPress={save} />
      </ScrollView>
    </View>
  );
}
