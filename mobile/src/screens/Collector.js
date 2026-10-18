import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import * as api from '../api';
import * as store from '../db';
import SyncBar from '../SyncBar';
import { ask, notify } from '../dialog';
import { Btn, Chip, Header, Keypad, Logo, ShiftBadge, fmtDT, matches, toNumber } from '../components';
import { NewSupplier, PaymentForm, SupplierCard } from './Supplier';
import { C, fmtQty, fmtTime, s } from '../ui';

// Collecting milk: offline-first. Every action is written to the phone first
// and uploaded by the background sync. An open shift is a draft: nothing in it
// counts until the shift is closed and accepted by a storekeeper / manager.
export default function Collector({ tick, refresh, setFull }) {
  const shift = store.getOpenShift();
  // Unfinished input survives the app being killed: reopen straight into it.
  const [draft, setDraftState] = useState(() => (store.getOpenShift() ? store.getKv('draft') : null));
  const [screen, setScreen] = useState(null);
  // null | 'entries' | 'pay' | 'history' | 'close' | 'new' | { edit } | { card, from } | { payFor, from }
  const [toast, setToast] = useState('');
  void tick;

  const setDraft = (d) => { store.setKv('draft', d); setDraftState(d); };
  const say = (msg) => { setToast(msg); setTimeout(() => setToast(''), 3000); };
  const back = () => setScreen(null);

  // Full-screen work (number pad, card, forms) hides the app's tab bar.
  const full = !!(draft && shift) || (screen && screen !== 'entries' && screen !== 'history');
  useEffect(() => { setFull(!!full); }, [full, setFull]);

  return (
    <View style={{ flex: 1 }}>
      {!!toast && (
        <View style={{ backgroundColor: C.ok, padding: 14 }}>
          <Text style={{ color: '#fff', fontSize: 18, fontWeight: '700' }}>{toast}</Text>
        </View>
      )}
      <View style={{ flex: 1 }}>{content()}</View>
    </View>
  );

  function content() {
    if (screen?.payFor) {
      return <PaymentForm supplier={screen.payFor} onBack={() => setScreen(screen.from ?? null)}
        onDone={(m) => { setScreen(screen.from ?? null); refresh(); say(m); }} />;
    }
    if (screen?.card) {
      return <SupplierCard id={screen.card} onBack={() => setScreen(screen.from ?? null)}
        onPay={(sup) => setScreen({ payFor: sup, from: screen })} />;
    }
    if (screen === 'history') return <History onBack={back} onCopied={() => { back(); refresh(); say('Nusxa ochildi — qatorlarni tuzatib, yopishingiz mumkin'); }} />;
    if (screen === 'pay') return <PickSupplier title="To'lov: kimga?" onBack={back} onPick={(sup) => setScreen({ payFor: { id: sup.id, name: sup.name }, from: 'pay' })} />;
    if (screen === 'new') {
      return <NewSupplier onBack={back} onCreated={(sup) => {
        back();
        refresh();
        if (sup && shift) setDraft({ supplierId: sup.id, productId: sup.products[0]?.id ?? null, qty: '' });
      }} />;
    }
    if (!shift) return <StartShift tick={tick} refresh={refresh} onOpen={() => { store.openShift(); refresh(); api.syncNow(); }} onNav={setScreen} />;
    if (draft) {
      return (
        <Entry
          draft={draft}
          onChange={setDraft}
          onCancel={() => setDraft(null)}
          onCard={(id) => setScreen({ card: id })}
          onSave={(supplier, product, quantity) => {
            store.addCollectionAndClearDraft({ shiftUuid: shift.uuid, supplier, product, quantity });
            setDraftState(null);
            refresh();
            api.syncNow();
            say(`${supplier.name}: ${fmtQty(quantity)} ${product.unit || 'kg'} saqlandi ✓`);
          }}
        />
      );
    }
    if (screen?.edit) {
      return <EditEntry row={screen.edit} onBack={() => setScreen('entries')} onSaved={() => { setScreen('entries'); refresh(); api.syncNow(); say('O\'zgartirildi ✓'); }} />;
    }
    if (screen === 'entries') return <Entries shift={shift} tick={tick} onBack={back} onEdit={(row) => setScreen({ edit: row })} refresh={refresh} />;
    if (screen === 'close') return <CloseShift shift={shift} onBack={back} onClosed={() => { setScreen(null); api.syncNow(); refresh(); say('Smena yopildi va qabulga yuborildi ✓'); }} />;
    return (
      <ShiftView
        shift={shift}
        tick={tick}
        onPick={(supplier) => {
          const def = supplier.products.find((p) => p.isDefault) ?? supplier.products[0];
          setDraft({ supplierId: supplier.id, productId: def?.id ?? null, qty: '' });
        }}
        onNav={setScreen}
      />
    );
  }
}

const shiftName = (uuid) => api.shiftInfo(uuid)?.label ?? 'Yangi smena';

// ---------------------------------------------------------------- Start shift
function StartShift({ tick, refresh, onOpen, onNav }) {
  const me = api.me();
  const suppliers = api.getSuppliers();
  const block = api.shiftBlock();
  const refused = store.allShifts().filter((x) => x.error);
  const cancelled = api.serverShifts().filter((x) => x.status === 'cancelled').slice(0, 3);
  void tick;
  return (
    <View style={{ flex: 1 }}>
      <SyncBar tick={tick} />
      <ScrollView contentContainerStyle={[s.pad, { flexGrow: 1, justifyContent: 'center', gap: 16 }]}>
        <View style={{ alignItems: 'center' }}><Logo size={72} /></View>
        <Text style={s.h1}>Assalomu alaykum, {me?.name || me?.login}</Text>
        <Text style={s.muted}>Sizga biriktirilgan yetkazib beruvchilar: {suppliers.length} ta</Text>
        {refused.map((r) => (
          <View key={r.uuid} style={[s.card, { borderColor: C.err, gap: 8 }]}>
            <Text style={{ color: C.err, fontWeight: '700' }}>Server smenani qabul qilmadi</Text>
            <Text style={s.text}>{r.error}</Text>
            <Btn title="Bu smenani telefondan o'chirish" kind="warn" onPress={() => ask('O\'chirish',
              'Bu smena va undagi yozuvlar telefondan o\'chiriladi. Davom etasizmi?', 'Ha', () => { store.discardShift(r.uuid); refresh(); })} />
          </View>
        ))}
        {cancelled.map((r) => (
          <View key={r.uuid} style={[s.card, { borderColor: C.err, gap: 4 }]}>
            <Text style={{ color: C.err, fontWeight: '700' }}>{r.label} smena bekor qilindi</Text>
            {!!r.cancel_reason && <Text style={s.text}>Sabab: {r.cancel_reason}</Text>}
          </View>
        ))}
        {block ? (
          <View style={[s.card, { borderColor: C.warn }]}>
            <Text style={[s.text, { color: C.warn }]}>{block.text}</Text>
          </View>
        ) : (
          <Pressable style={[s.btn, { paddingVertical: 32 }]} onPress={onOpen}>
            <Text style={[s.btnText, { fontSize: 26 }]}>Smenani ochish</Text>
          </Pressable>
        )}
      </ScrollView>
      <View style={[s.pad, { gap: 10 }]}>
        {api.can('payments.create') && <Btn title="To'lov kiritish" kind="ghost" onPress={() => onNav('pay')} />}
        <Btn title="Smenalarim tarixi" kind="ghost" onPress={() => onNav('history')} />
        <Btn title="Ro'yxatni yangilash" kind="ghost" onPress={() => api.syncNow()} />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------- Shift: supplier list
function ShiftView({ shift, tick, onPick, onNav }) {
  const [q, setQ] = useState('');
  const suppliers = api.getSuppliers();
  const rows = useMemo(() => store.shiftCollections(shift.uuid), [shift.uuid, tick]);

  // Totals per supplier for this shift, so the collector sees who is already done.
  const done = useMemo(() => {
    const m = {};
    for (const r of rows) (m[r.supplier_id] ||= []).push(r);
    return m;
  }, [rows]);

  const list = useMemo(() => [...suppliers.filter((x) => matches(x, q))]
    // Not yet visited first; keep the admin's route order within each group.
    .sort((a, b) => (done[a.id] ? 1 : 0) - (done[b.id] ? 1 : 0)), [suppliers, q, done]);

  const totalByProduct = rows.reduce((m, r) => ({ ...m, [r.product_name]: (m[r.product_name] || 0) + r.quantity }), {});

  return (
    <View style={{ flex: 1 }}>
      <SyncBar tick={tick} />
      <View style={{ padding: 12, gap: 8 }}>
        <Text style={s.muted}>
          <Text style={{ fontWeight: '700', color: C.text }}>{shiftName(shift.uuid)}</Text> · ochiq (qoralama) · {fmtTime(shift.opened_at)} · {rows.length} ta ·{' '}
          {Object.entries(totalByProduct).map(([k, v]) => `${k} ${fmtQty(v)}`).join(', ') || '0'}
        </Text>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <TextInput style={[s.input, { flex: 1 }]} value={q} onChangeText={setQ} placeholder="🔍  Ism yoki telefon raqam"
            autoCorrect={false} clearButtonMode="while-editing" />
          {api.can('suppliers.create') && (
            <Pressable onPress={() => onNav('new')} style={[s.btn, { paddingHorizontal: 18, paddingVertical: 0 }]} accessibilityLabel="Yangi yetkazib beruvchi">
              <Text style={s.btnText}>＋</Text>
            </Pressable>
          )}
        </View>
      </View>
      <FlatList
        data={list}
        keyExtractor={(x) => String(x.id)}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 12, gap: 8 }}
        ListEmptyComponent={<Text style={[s.muted, { padding: 16 }]}>{suppliers.length ? 'Topilmadi' : 'Sizga yetkazib beruvchi biriktirilmagan. Adminga murojaat qiling.'}</Text>}
        renderItem={({ item }) => {
          const got = done[item.id];
          const noProduct = !item.products?.length;
          return (
            <Pressable
              onPress={() => (noProduct
                ? notify('Mahsulot yo\'q', 'Bu yetkazib beruvchiga admin mahsulot biriktirmagan.')
                : onPick(item))}
              style={({ pressed }) => [s.card, { flexDirection: 'row', alignItems: 'center', minHeight: 68 },
                got && { borderColor: C.ok }, pressed && { opacity: 0.6 }]}
            >
              <View style={{ flex: 1 }}>
                <Text style={[s.text, { fontSize: 19, fontWeight: '600' }]}>{item.name}</Text>
                {!!(item.address || item.phone) && <Text style={s.muted}>{[item.address, item.phone].filter(Boolean).join(' · ')}</Text>}
              </View>
              {got && (
                <Text style={{ color: C.ok, fontSize: 18, fontWeight: '700' }}>
                  ✓ {fmtQty(got.reduce((a, r) => a + r.quantity, 0))}
                </Text>
              )}
            </Pressable>
          );
        }}
      />
      <View style={{ padding: 12, flexDirection: 'row', gap: 8 }}>
        <Btn title="Yozuvlar" kind="ghost" style={{ flex: 1 }} onPress={() => onNav('entries')} />
        {api.can('payments.create') && <Btn title="To'lov" kind="ghost" style={{ flex: 1 }} onPress={() => onNav('pay')} />}
        <Btn title="Yopish" kind="ghost" style={{ flex: 1 }} onPress={() => onNav('close')} />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------- Quantity entry
function Entry({ draft, onChange, onCancel, onSave, onCard }) {
  const supplier = api.getSuppliers().find((x) => x.id === draft.supplierId);
  useEffect(() => {
    // Supplier was unassigned while a draft was open: drop the draft.
    if (!supplier) onCancel();
  }, [supplier, onCancel]);
  if (!supplier) return null;
  const product = supplier.products.find((p) => p.id === draft.productId) ?? supplier.products[0];
  return (
    <QuantityPad
      title={supplier.name}
      onTitle={() => onCard(supplier.id)}
      products={supplier.products}
      product={product}
      qty={draft.qty}
      onProduct={(p) => onChange({ ...draft, productId: p.id })}
      onQty={(qty) => onChange({ ...draft, productId: product.id, qty })}
      onCancel={onCancel}
      onSave={(value) => onSave(supplier, product, value)}
      saveLabel="OK — saqlash"
    />
  );
}

function QuantityPad({ title, onTitle, products, product, qty, onProduct, onQty, onCancel, onSave, saveLabel }) {
  const value = toNumber(qty);
  const save = () => {
    if (!(value > 0)) return;
    if (value > 1000) ask('Tekshiring', `${fmtQty(value)} ${product.unit || 'kg'} — to'g'rimi?`, 'Ha, saqlash', () => onSave(value));
    else onSave(value);
  };
  return (
    <View style={{ flex: 1, padding: 12, gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Pressable onPress={onCancel} hitSlop={16} style={{ paddingRight: 6 }}><Text style={{ fontSize: 28, color: C.muted }}>←</Text></Pressable>
        <View style={{ flex: 1 }} />
        {/* Supplier name in the corner: tap for the card (history, debt, payment). */}
        <Pressable onPress={onTitle} disabled={!onTitle} style={({ pressed }) => [{ maxWidth: '80%', borderRadius: 10, paddingHorizontal: 10,
          paddingVertical: 6, backgroundColor: onTitle ? '#E6F2ED' : 'transparent' }, pressed && { opacity: 0.6 }]}>
          <Text style={[s.h2, { color: onTitle ? C.accent : C.text, textAlign: 'right' }]} numberOfLines={2}>{title}{onTitle ? '  ⓘ' : ''}</Text>
        </Pressable>
      </View>
      {products.length > 1 ? (
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {products.map((p) => <Chip key={p.id} label={p.name} on={p.id === product.id} onPress={() => onProduct(p)} />)}
        </View>
      ) : <Text style={s.muted}>{product.name}</Text>}
      <View style={[s.card, { alignItems: 'flex-end', paddingVertical: 20 }]}>
        <Text style={{ fontSize: 56, fontWeight: '700', color: qty ? C.text : C.line }} adjustsFontSizeToFit numberOfLines={1}>
          {qty || '0'} <Text style={{ fontSize: 28, color: C.muted }}>{product.unit || 'kg'}</Text>
        </Text>
      </View>
      <Keypad value={qty} onChange={onQty} onSubmit={save} onCancel={onCancel} />
      <Pressable style={[s.btn, { paddingVertical: 22 }, !(value > 0) && { opacity: 0.4 }]} onPress={save} disabled={!(value > 0)}>
        <Text style={[s.btnText, { fontSize: 26 }]}>{saveLabel}</Text>
      </Pressable>
    </View>
  );
}

// ---------------------------------------------------------------- Own entries: edit / delete (open shift only)
function Entries({ shift, tick, onBack, onEdit, refresh }) {
  const rows = useMemo(() => store.shiftCollections(shift.uuid), [shift.uuid, tick]);
  const canEdit = api.can('collect.edit_own');
  const canDelete = api.can('collect.delete_own');
  return (
    <View style={{ flex: 1 }}>
      <Header title={`${shiftName(shift.uuid)} — yozuvlar`} onBack={onBack} />
      <FlatList
        data={rows}
        keyExtractor={(r) => r.uuid}
        contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 12, gap: 8 }}
        ListEmptyComponent={<Text style={[s.muted, { padding: 16 }]}>Hali yozuv yo'q</Text>}
        renderItem={({ item: r }) => (
          <View style={[s.card, { gap: 6 }]}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text style={[s.text, { fontWeight: '600', flex: 1 }]}>{fmtTime(r.collected_at)}  {r.supplier_name}</Text>
              <Text style={[s.text, { fontWeight: '700' }]}>{fmtQty(r.quantity)} {r.unit}</Text>
            </View>
            <Text style={s.muted}>
              {r.product_name}{r.edited_at ? ' · tahrirlangan' : ''}
              {' · '}{r.error ? `xato: ${r.error}` : r.synced_at ? 'yuborilgan ✓' : 'telefonda'}
            </Text>
            {(canEdit || canDelete) && (
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {canEdit && <Btn title="Tahrirlash" kind="ghost" style={{ flex: 1 }} onPress={() => onEdit(r)} />}
                {canDelete && (
                  <Btn title="O'chirish" kind="warn" style={{ flex: 1 }}
                    onPress={() => ask('O\'chirish', `${r.supplier_name}: ${fmtQty(r.quantity)} ${r.unit} — o'chirilsinmi?`, 'Ha, o\'chirish', () => {
                      store.deleteCollection(r.uuid);
                      refresh();
                      api.syncNow();
                    })} />
                )}
              </View>
            )}
          </View>
        )}
      />
    </View>
  );
}

function EditEntry({ row, onBack, onSaved }) {
  const supplier = api.getSuppliers().find((x) => x.id === row.supplier_id);
  const products = supplier?.products?.length ? supplier.products : [{ id: row.product_id, name: row.product_name, unit: row.unit }];
  const [product, setProduct] = useState(products.find((p) => p.id === row.product_id) ?? products[0]);
  const [qty, setQty] = useState(String(row.quantity).replace('.', ','));
  return (
    <QuantityPad
      title={`Tahrirlash: ${row.supplier_name}`}
      products={products}
      product={product}
      qty={qty}
      onProduct={setProduct}
      onQty={setQty}
      onCancel={onBack}
      onSave={(value) => { store.editCollection(row.uuid, { quantity: value, product }); onSaved(); }}
      saveLabel="Saqlash"
    />
  );
}

// ---------------------------------------------------------------- Pick a supplier (for a payment)
export function PickSupplier({ title, onBack, onPick }) {
  const [q, setQ] = useState('');
  const suppliers = api.getSuppliers().filter((x) => matches(x, q));
  const recent = store.recentPayments().slice(0, 5);
  return (
    <View style={{ flex: 1 }}>
      <Header title={title} onBack={onBack} />
      <View style={{ paddingHorizontal: 12 }}>
        <TextInput style={s.input} value={q} onChangeText={setQ} placeholder="🔍  Ism yoki telefon raqam" autoCorrect={false} />
      </View>
      <FlatList
        data={suppliers}
        keyExtractor={(x) => String(x.id)}
        contentContainerStyle={{ padding: 12, gap: 8 }}
        ListFooterComponent={recent.length ? (
          <View style={{ marginTop: 12, gap: 4 }}>
            <Text style={s.muted}>Oxirgi to'lovlar (shu telefondan):</Text>
            {recent.map((p) => (
              <Text key={p.uuid} style={s.text}>{fmtDT(p.paid_at)}  {p.supplier_name} — {String(Math.round(p.amount)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} so'm {p.error ? `(xato: ${p.error})` : p.synced_at ? '✓' : '…'}</Text>
            ))}
          </View>
        ) : null}
        renderItem={({ item }) => (
          <Pressable onPress={() => onPick(item)} style={({ pressed }) => [s.card, pressed && { opacity: 0.6 }]}>
            <Text style={[s.text, { fontSize: 18, fontWeight: '600' }]}>{item.name}</Text>
            {!!item.phone && <Text style={s.muted}>{item.phone}</Text>}
          </Pressable>
        )}
      />
    </View>
  );
}

// ---------------------------------------------------------------- History (online)
function History({ onBack, onCopied }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => { setErr(''); api.history().then(setRows).catch((e) => setErr(e.message)); }, []);
  useEffect(load, [load]);
  const canCopy = api.can('collect.copy_cancelled');
  const copy = (r) => ask('Nusxa olish', `${r.label} smenaning nusxasi yangi ochiq smena sifatida ochiladi. Qatorlarni tuzatib, qayta yopasiz.`, 'Ha', async () => {
    try {
      await api.mobile('POST', `/shifts/${r.id}/copy`);
      await api.refreshBootstrap();
      onCopied();
    } catch (e) { notify('Bo\'lmadi', e.message); }
  });
  return (
    <View style={{ flex: 1 }}>
      <Header title="Smenalarim tarixi" onBack={onBack} />
      {!!err && <Text style={[s.err, { padding: 12 }]}>{err}</Text>}
      <FlatList
        data={rows ?? []}
        keyExtractor={(r) => r.uuid}
        contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 12, gap: 8 }}
        ListEmptyComponent={<Text style={[s.muted, { padding: 16 }]}>{rows ? 'Hali smena yo\'q' : 'Yuklanmoqda...'}</Text>}
        renderItem={({ item: r }) => (
          <View style={[s.card, { gap: 4 }]}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={[s.text, { fontWeight: '700' }]}>{r.label}  <Text style={{ fontWeight: '400' }}>{fmtDT(r.opened_at)}–{r.closed_at ? fmtTime(r.closed_at) : '...'}</Text></Text>
              <ShiftBadge status={r.status} />
            </View>
            <Text style={s.text}>{r.pickups} ta yetkazib berish · {fmtQty(r.quantity)} kg</Text>
            {!!r.cancel_reason && <Text style={{ color: C.err }}>Sabab: {r.cancel_reason}</Text>}
            {r.status === 'cancelled' && canCopy && <Btn title="Nusxa olib tuzatish" kind="ghost" onPress={() => copy(r)} />}
          </View>
        )}
      />
    </View>
  );
}

// ---------------------------------------------------------------- Close shift
function CloseShift({ shift, onBack, onClosed }) {
  const rows = store.shiftCollections(shift.uuid);
  const byProduct = rows.reduce((m, r) => ({ ...m, [`${r.product_name}|${r.unit}`]: (m[`${r.product_name}|${r.unit}`] || 0) + r.quantity }), {});
  return (
    <View style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={[s.pad, { gap: 12 }]}>
        <Text style={s.h1}>{shiftName(shift.uuid)} smenani yopish</Text>
        <Text style={s.muted}>Ochilgan: {fmtTime(shift.opened_at)} · {rows.length} ta yetkazib berish</Text>
        <View style={[s.card, { gap: 6 }]}>
          {Object.entries(byProduct).map(([k, v]) => {
            const [name, unit] = k.split('|');
            return <Text key={k} style={[s.text, { fontSize: 22, fontWeight: '700' }]}>{name}: {fmtQty(v)} {unit}</Text>;
          })}
          {!rows.length && <Text style={s.muted}>Bu smenada yozuv yo'q</Text>}
        </View>
        <Text style={[s.text, { color: C.warn }]}>
          Yopilgan smenani hech kim o'zgartira olmaydi. U omborchi / rahbar qabuliga yuboriladi va qabul qilingach hisobga kiradi.
        </Text>
        {rows.map((r) => (
          <View key={r.uuid} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6,
            borderBottomWidth: 1, borderColor: C.line }}>
            <Text style={[s.text, { flex: 1 }]}>{fmtTime(r.collected_at)}  {r.supplier_name}</Text>
            <Text style={[s.text, { fontWeight: '600' }]}>{fmtQty(r.quantity)} {r.unit}</Text>
            <Text style={{ width: 28, textAlign: 'right', color: r.error ? C.err : r.synced_at ? C.ok : C.warn }}>
              {r.error ? '!' : r.synced_at ? '✓' : '…'}
            </Text>
          </View>
        ))}
      </ScrollView>
      <View style={[s.pad, { gap: 10 }]}>
        <Pressable style={s.btn} onPress={() => { store.closeShift(shift.uuid); onClosed(); }}>
          <Text style={s.btnText}>Ha, smenani yopish</Text>
        </Pressable>
        <Btn title="Orqaga" kind="ghost" onPress={onBack} />
      </View>
    </View>
  );
}
