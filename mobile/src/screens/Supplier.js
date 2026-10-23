import { createElement, useEffect } from 'react';
import { useState } from 'react';
import { FlatList, Platform, Pressable, RefreshControl, ScrollView, Text, TextInput, View } from 'react-native';
import * as api from '../api';
import * as store from '../db';
import { useBack } from '../back';
import { getOnce, mapPickerUrl } from '../geo';
import { confirmAction, notify } from '../dialog';
import { Btn, Chip, Err, Header, Keypad, METHOD, Tile, fmtDT, fmtMoney, useLoad } from '../components';
import { C, fmtQty, s } from '../ui';

// react-native-webview is native-only, so it's loaded lazily (never on web).
let WebViewCmp = null;
if (Platform.OS !== 'web') { try { WebViewCmp = require('react-native-webview').WebView; } catch { /* dev */ } }

// Full-screen map picker: the same map.html the panel uses. On the phone it runs
// in a WebView; in the browser tester it runs in an iframe. Calls
// onPick({lat,lng,address}) when saved, or onClose() when cancelled.
function MapPicker({ supplier, onPick, onClose }) {
  useBack(onClose);
  const url = mapPickerUrl({ lat: supplier.lat, lng: supplier.lng, name: supplier.name, address: supplier.address });
  const handle = (raw) => {
    let d = {};
    try { d = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { /* ignore */ }
    if (d && d.ok) onPick({ lat: d.lat, lng: d.lng }); // address is a manual field; the map sets only coordinates
    else onClose();
  };
  // Browser tester: an iframe plus a window message listener.
  useEffect(() => {
    if (Platform.OS !== 'web') return undefined;
    const onMsg = (e) => { if (e.data?.yayaMap) handle(e.data.yayaMap); };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);
  return (
    <View style={{ flex: 1 }}>
      <Header title={`Joylashuv: ${supplier.name}`} onBack={onClose} />
      {Platform.OS === 'web'
        ? createElement('iframe', { src: url, style: { flex: 1, border: 0, width: '100%', height: '100%' }, title: 'Xarita' })
        : WebViewCmp && <WebViewCmp source={{ uri: url }} geolocationEnabled onMessage={(e) => handle(e.nativeEvent.data)} />}
    </View>
  );
}

// Supplier card for everyone in the app: kg history (never prices), the current
// debt or advance, recent payments and a "pay" button when allowed.
export function SupplierCard({ id, onBack, onPay }) {
  const { data: c, err, busy, load } = useLoad(() => api.mobile('GET', `/suppliers/${id}/card`), [id]);
  const [editing, setEditing] = useState(null); // { name, phone, address }
  const [priceEdit, setPriceEdit] = useState(null); // { productId, name, value }
  const [mapSlot, setMapSlot] = useState(0); // 0 closed, 1 primary, 2 additional
  const [locBusy, setLocBusy] = useState(false);
  const local = api.getSuppliers().find((x) => x.id === id);
  const name = c?.supplier.name ?? local?.name ?? '...';
  const canPay = c ? c.canPay : api.can('payments.create');
  // Payments made on this phone that have not reached the server yet.
  const unsent = store.recentPayments().filter((p) => p.supplier_id === id && !p.synced_at);

  const saveSupplier = async () => {
    try {
      await api.admin('PATCH', `/suppliers/${id}`, { name: editing.name.trim(), phone: editing.phone, address: editing.address });
      setEditing(null);
      await load();
      api.syncNow();
    } catch (e) { notify('Xato', e.message); }
  };
  const savePrice = async () => {
    try {
      await api.admin('PUT', '/supplier-products', { supplierId: id, productId: priceEdit.productId, price: Math.round(Number(String(priceEdit.value).replace(/\s/g, ''))) || 0 });
      setPriceEdit(null);
      await load();
    } catch (e) { notify('Xato', e.message); }
  };

  const saveLocation = async (body) => {
    try {
      await api.mobile('POST', `/suppliers/${id}/location`, body);
      await load();
      api.syncNow();
    } catch (e) { notify('Bo\'lmadi', e.message); }
  };
  const saveHere = async (slot = 1) => {
    setLocBusy(true);
    try {
      const here = await getOnce();
      if (!here) { notify('Joylashuv yo\'q', 'Telefonda joylashuvni (GPS) yoqing va ruxsat bering.'); return; }
      await saveLocation({ lat: here.lat, lng: here.lng, slot });
      notify('Saqlandi', 'Joylashuv hozirgi joyingizga belgilandi.');
    } finally { setLocBusy(false); }
  };
  const deleteLoc2 = async () => {
    try { await api.admin('PATCH', `/suppliers/${id}`, { lat2: null, lng2: null, address2: null }); await load(); api.syncNow(); }
    catch (e) { notify('Xato', e.message); }
  };

  if (mapSlot && c) {
    const sup = mapSlot === 2 ? { ...c.supplier, lat: c.supplier.lat2, lng: c.supplier.lng2, address: c.supplier.address2 } : c.supplier;
    return <MapPicker supplier={sup} onClose={() => setMapSlot(0)}
      onPick={async (r) => { const sl = mapSlot; setMapSlot(0); await saveLocation({ ...r, slot: sl }); }} />;
  }

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
            {editing != null ? (
              <View style={[s.card, { gap: 8 }]}>
                <Text style={[s.text, { fontWeight: '700' }]}>Xonadon ma'lumotlari</Text>
                <TextInput style={s.input} value={editing.name} onChangeText={(t) => setEditing({ ...editing, name: t })} placeholder="Ism" placeholderTextColor={C.placeholder} autoFocus />
                <TextInput style={s.input} value={editing.phone} onChangeText={(t) => setEditing({ ...editing, phone: t })} placeholder="Telefon" placeholderTextColor={C.placeholder} keyboardType="phone-pad" />
                <TextInput style={s.input} value={editing.address} onChangeText={(t) => setEditing({ ...editing, address: t })} placeholder="Manzil" placeholderTextColor={C.placeholder} />
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Btn title="Bekor" kind="ghost" style={{ flex: 1 }} onPress={() => setEditing(null)} />
                  <Btn title="Saqlash" style={{ flex: 1 }} disabled={!editing.name.trim()} onPress={saveSupplier} />
                </View>
              </View>
            ) : c.canEdit && <Btn title="✎ Ma'lumotlarini tahrirlash" kind="ghost" onPress={() => setEditing({ name: c.supplier.name, phone: c.supplier.phone || '', address: c.supplier.address || '' })} />}
            {c.seePrices && !!c.products?.length && (
              <View style={[s.card, { gap: 6 }]}>
                <Text style={[s.text, { fontWeight: '700' }]}>Mahsulotlar va narxlar</Text>
                {c.products.map((p) => (priceEdit?.productId === p.id ? (
                  <View key={p.id} style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                    <Text style={[s.text, { flex: 1 }]}>{p.isDefault ? '★ ' : ''}{p.name}</Text>
                    <TextInput style={[s.input, { width: 110 }]} value={priceEdit.value} onChangeText={(t) => setPriceEdit({ ...priceEdit, value: t })} keyboardType="numeric" autoFocus />
                    <Btn title="✓" style={{ paddingHorizontal: 14 }} onPress={savePrice} />
                    <Btn title="✕" kind="ghost" style={{ paddingHorizontal: 12 }} onPress={() => setPriceEdit(null)} />
                  </View>
                ) : (
                  <View key={p.id} style={{ flexDirection: 'row', gap: 8, alignItems: 'center', borderTopWidth: 1, borderColor: C.line, paddingTop: 6 }}>
                    <Text style={[s.text, { flex: 1 }]}>{p.isDefault ? '★ ' : ''}{p.name}</Text>
                    <Text style={[s.text, { fontWeight: '700' }]}>{p.price == null ? 'narx yo\'q' : `${fmtMoney(p.price)} so'm`}</Text>
                    {c.canManagePrices && <Btn title="✎" kind="ghost" style={{ paddingHorizontal: 12 }} onPress={() => setPriceEdit({ productId: p.id, name: p.name, value: p.price == null ? '' : String(p.price) })} />}
                  </View>
                )))}
              </View>
            )}
            {c.canSetLocation && api.locationEnabled() && (
              <View style={[s.card, { gap: 8 }]}>
                <Text style={[s.text, { fontWeight: '700' }]}>📍 Manzil / joylashuv</Text>
                <Text style={s.muted}>{c.supplier.address || 'Manzil kiritilmagan'}{c.supplier.lat != null ? ' · xaritada belgilangan' : ''}</Text>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Btn title={locBusy ? '...' : '📍 Hozirgi joy'} kind="ghost" style={{ flex: 1 }} disabled={locBusy} onPress={() => saveHere(1)} />
                  <Btn title="🗺️ Xaritada" kind="ghost" style={{ flex: 1 }} onPress={() => setMapSlot(1)} />
                </View>
                {(c.supplier.lat2 != null || c.supplier.address2) ? (
                  <View style={{ gap: 6, borderTopWidth: 1, borderColor: C.line, paddingTop: 8 }}>
                    <Text style={[s.text, { fontWeight: '600' }]}>2-manzil</Text>
                    <Text style={s.muted}>{c.supplier.address2 || 'Manzil kiritilmagan'}{c.supplier.lat2 != null ? ' · xaritada belgilangan' : ''}</Text>
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                      <Btn title={locBusy ? '...' : '📍 Hozirgi joy'} kind="ghost" style={{ flex: 1 }} disabled={locBusy} onPress={() => saveHere(2)} />
                      <Btn title="🗺️ Xaritada" kind="ghost" style={{ flex: 1 }} onPress={() => setMapSlot(2)} />
                      <Btn title="🗑" kind="warn" style={{ paddingHorizontal: 14 }} onPress={deleteLoc2} />
                    </View>
                  </View>
                ) : <Btn title="＋ Qo'shimcha manzil" kind="ghost" onPress={() => setMapSlot(2)} />}
              </View>
            )}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              <Tile label={bal > 0 ? 'Qarzdorlik' : bal < 0 ? 'Haqdorlik' : 'Qarz yo\'q'} value={fmtMoney(Math.abs(bal ?? 0))} sub="so'm" />
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
                    {fmtDT(p.paid_at)} · {fmtMoney(p.amount)} so'm · {METHOD[p.method] ?? p.method}{p.by_name ? ` · ${p.by_name}` : ''}
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
    confirmAction('payment', 'To\'lovni tasdiqlang', `${supplier.name}\n${fmtMoney(value)} so'm (${METHOD[method]})`, 'Ha, saqlash', () => {
      store.addPayment({ supplier, amount: value, method });
      api.syncNow();
      onDone(`To'lov saqlandi: ${supplier.name} — ${fmtMoney(value)} so'm ✓`);
    });
  };
  return (
    <View style={{ flex: 1, padding: 12, gap: 10 }}>
      <Header title={`To'lov: ${supplier.name}`} onBack={onBack} />
      {supplier.balance != null && (
        <Text style={s.muted}>{supplier.balance >= 0 ? `Qarzdorlik: ${fmtMoney(supplier.balance)} so'm` : `Haqdorlik: ${fmtMoney(-supplier.balance)} so'm`}</Text>
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
  const [prices, setPrices] = useState({}); // productId -> price string (only for price managers)
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const canPrice = api.can('prices.manage');
  const toggle = (id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const save = async () => {
    setBusy(true);
    setErr('');
    try {
      const r = await api.mobile('POST', '/suppliers', { name, phone, address, productIds: picked });
      // A price manager can set prices right away.
      if (canPrice) {
        for (const pid of picked) {
          const price = Math.round(Number(String(prices[pid] ?? '').replace(/\s/g, '')));
          if (price > 0) await api.admin('PUT', '/supplier-products', { supplierId: r.id, productId: pid, price, isDefault: pid === picked[0] });
        }
      }
      await api.refreshBootstrap();
      onCreated(api.getSuppliers().find((x) => x.id === r.id) ?? null);
    } catch (e) { setErr(e.offline ? 'Yangi xonadon qo\'shish uchun internet kerak' : e.message); } finally { setBusy(false); }
  };
  return (
    <View style={{ flex: 1 }}>
      <Header title="Yangi xonadon" onBack={onBack} />
      <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }} keyboardShouldPersistTaps="handled">
        <TextInput style={s.input} value={name} onChangeText={setName} placeholder="Ism familiya" />
        <TextInput style={s.input} value={phone} onChangeText={setPhone} placeholder="Telefon (ixtiyoriy)" keyboardType="phone-pad" />
        <TextInput style={s.input} value={address} onChangeText={setAddress} placeholder="Manzil (ixtiyoriy)" />
        <Text style={s.muted}>Qaysi mahsulotni topshiradi?{picked.length ? ' (birinchisi — asosiy ★)' : ''}</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {products.map((p) => <Chip key={p.id} label={p.name} on={picked.includes(p.id)} onPress={() => toggle(p.id)} />)}
        </View>
        {canPrice ? (
          <View style={{ gap: 8 }}>
            {picked.map((pid, i) => {
              const p = products.find((x) => x.id === pid);
              return (
                <View key={pid} style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                  <Text style={[s.text, { flex: 1 }]}>{i === 0 ? '★ ' : ''}{p?.name} narxi</Text>
                  <TextInput style={[s.input, { width: 130 }]} value={prices[pid] ?? ''} onChangeText={(t) => setPrices({ ...prices, [pid]: t })} placeholder="so'm" placeholderTextColor={C.placeholder} keyboardType="numeric" />
                </View>
              );
            })}
            <Text style={s.muted}>Narxni keyin ham o'zgartirish mumkin. Narx belgilanmaguncha smena qabul qilinmaydi.</Text>
          </View>
        ) : <Text style={s.muted}>Narxni admin yoki buxgalter belgilaydi. Narx belgilanmaguncha smena qabul qilinmaydi.</Text>}
        {!!err && <Text style={s.err}>{err}</Text>}
        <Btn title={busy ? 'Saqlanmoqda...' : 'Qo\'shish'} disabled={busy || !name.trim() || !picked.length} onPress={save} />
      </ScrollView>
    </View>
  );
}
