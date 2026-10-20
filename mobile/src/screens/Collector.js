import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, FlatList, Modal, PanResponder, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as api from '../api';
import * as store from '../db';
import SyncBar from '../SyncBar';
import { useBack } from '../back';
import { distanceM, openRoute, startLocation, stopLocation, useMyLocation } from '../geo';
import { ask, confirmAction, notify } from '../dialog';
import { Btn, Header, Keypad, Logo, SearchBar, ShiftBadge, digitsOf, fmtDT, matches, textMatch, toNumber } from '../components';
import { NewSupplier, PaymentForm, SupplierCard } from './Supplier';
import { C, fmtQty, fmtTime, s } from '../ui';

// The greeting shown on the start screen; the admin can change the template.
function greetingFor(name) {
  const tpl = api.getBrand().greeting;
  if (tpl && tpl.trim()) return tpl.replace(/\{ism\}/gi, name || '');
  return `Assalomu alaykum, ${name || ''}`;
}

// Collecting milk: offline-first. Every action is written to the phone first
// and uploaded by the background sync. An open shift is a draft: nothing in it
// counts until the shift is closed and accepted by a storekeeper / manager.
export default function Collector({ tick, refresh, setFull, histReq = 0 }) {
  const shift = store.getOpenShift();
  // Unfinished input survives the app being killed: reopen straight into it.
  const [draft, setDraftState] = useState(() => (store.getOpenShift() ? store.getKv('draft') : null));
  const [screen, setScreen] = useState(null);
  // null | 'entries' | 'pay' | 'history' | 'close' | 'new' | { edit } | { card, from } | { payFor, from }
  const [toast, setToast] = useState('');
  // The shift-list search text is kept here so it survives entering a quantity and
  // coming back — the collector still sees who they just saved for.
  const [shiftQ, setShiftQ] = useState('');
  void tick;

  const setDraft = (d) => { store.setKv('draft', d); setDraftState(d); };
  const say = (msg) => { setToast(msg); setTimeout(() => setToast(''), 3000); };
  const back = () => setScreen(null);

  // Full-screen work (number pad, card, forms) hides the app's tab bar.
  const full = !!(draft && shift) || (screen && screen !== 'entries' && screen !== 'history');
  useEffect(() => { setFull(!!full); }, [full, setFull]);

  // While a shift is open (and the admin has location on), follow the phone's
  // location so the list can order itself nearest-first. Keyed on the shift id
  // (a stable value) so re-renders never restart the GPS watch.
  const locationOn = api.locationEnabled();
  useEffect(() => {
    if (shift?.uuid && locationOn) { startLocation(); return () => stopLocation(); }
    return undefined;
  }, [shift?.uuid, locationOn]);

  // A 2-second long-press on the "Smena" tab opens own shift history, even while
  // a shift is open. histReq is bumped by Home on each long-press.
  useEffect(() => { if (histReq > 0) setScreen('history'); }, [histReq]);

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
    if (screen === 'history') return <History onBack={back}
      onCopied={() => { back(); refresh(); say('Nusxa ochildi — qatorlarni tuzatib, yopishingiz mumkin'); }}
      onReopened={() => { back(); refresh(); say('Smena tahrir uchun ochildi — tuzatib, qayta yoping'); }} />;
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
        q={shiftQ}
        setQ={setShiftQ}
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

// Tapping the shift total copies just the overall figures (for a group chat):
//   #5
//   Barkamol - 371.5 kg
//   Yog'li sut - 359 kg
//   Yog'siz sut - 12.5 kg
function totalsText(uuid, collections) {
  const grand = collections.reduce((a, r) => a + r.quantity, 0);
  const byP = {};
  for (const r of collections) byP[r.product_name] = (byP[r.product_name] || 0) + r.quantity;
  const me = api.me();
  const lines = [shiftName(uuid), `${me?.name || me?.login || ''} - ${fmtQty(grand)} kg`];
  for (const [name, v] of Object.entries(byP)) lines.push(`${name} - ${fmtQty(v)} kg`);
  return lines.join('\n');
}
async function copyTotals(uuid, collections) {
  if (!collections.length) return;
  try { await Clipboard.setStringAsync(totalsText(uuid, collections)); notify('Nusxalandi', 'Jami miqdor klaviaturaga nusxalandi.'); } catch { /* ignore */ }
}

// Wraps a row so a left→right swipe fires onSwipe, while taps still reach the
// Pressable inside. The row slides with the finger and springs back, and a map
// pin is revealed behind it as a hint. Reads current props via a ref (the
// PanResponder is created once).
function SwipeRow({ enabled, onSwipe, children }) {
  const tx = useRef(new Animated.Value(0)).current;
  const cb = useRef({ enabled, onSwipe });
  cb.current = { enabled, onSwipe };
  const springBack = () => Animated.spring(tx, { toValue: 0, useNativeDriver: false, speed: 18, bounciness: 10 }).start();
  const pan = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => cb.current.enabled && g.dx > 16 && Math.abs(g.dy) < 12,
    onPanResponderMove: (_, g) => { if (cb.current.enabled) tx.setValue(Math.max(0, Math.min(g.dx, 110))); },
    onPanResponderRelease: (_, g) => {
      const fire = cb.current.enabled && g.dx > 60 && Math.abs(g.dy) < 40;
      springBack();
      if (fire) cb.current.onSwipe();
    },
    onPanResponderTerminate: springBack,
  })).current;
  if (!enabled) return <View>{children}</View>;
  return (
    <View>
      <Animated.View pointerEvents="none" style={{ position: 'absolute', left: 18, top: 0, bottom: 0, justifyContent: 'center',
        opacity: tx.interpolate({ inputRange: [0, 60], outputRange: [0, 1], extrapolate: 'clamp' }) }}>
        <Text style={{ fontSize: 24 }}>🗺️</Text>
      </Animated.View>
      <Animated.View style={{ transform: [{ translateX: tx }] }} {...pan.panHandlers}>{children}</Animated.View>
    </View>
  );
}

// ---------------------------------------------------------------- Start shift
function StartShift({ tick, refresh, onOpen, onNav }) {
  const me = api.me();
  const suppliers = api.getSuppliers();
  const block = api.shiftBlock();
  void refresh;
  void tick;
  const tryOpen = () => {
    if (block) {
      notify('Smena ochib bo\'lmaydi', block.kind === 'cancelled'
        ? 'Sizda Bekor qilingan smena bor. Avval uni to\'g\'rilab, keyin urinib ko\'ring.'
        : block.kind === 'editing'
          ? 'Sizda tahrirdagi smena bor. Avval uni qayta yoping.'
          : 'Sizda Qabul qilinmagan smena bor. Avval omborchi uni qabul qilishi kerak.');
      return;
    }
    confirmAction('open', 'Smena ochish', 'Yangi smena ochilsinmi?', 'Ha', onOpen);
  };
  return (
    <View style={{ flex: 1 }}>
      <SyncBar tick={tick} />
      <ScrollView contentContainerStyle={[s.pad, { flexGrow: 1, justifyContent: 'center', gap: 16 }]}>
        <View style={{ alignItems: 'center' }}><Logo size={72} /></View>
        <Text style={s.h1}>{greetingFor(me?.name || me?.login)}</Text>
        <Text style={s.muted}>Sizga biriktirilgan xonadonlar: {suppliers.length} ta</Text>
        <Pressable style={[s.btn, { paddingVertical: 32 }]} onPress={tryOpen}>
          <Text style={[s.btnText, { fontSize: 26 }]}>Smenani ochish</Text>
        </Pressable>
      </ScrollView>
      <View style={[s.pad, { gap: 10 }]}>
        {api.can('payments.create') && <Btn title="To'lov kiritish" kind="ghost" onPress={() => onNav('pay')} />}
        {/* A red dot marks a cancelled or not-yet-accepted shift that needs fixing. */}
        {api.can('collect.view_own_shifts') && (
          <View>
            <Btn title="Smenalarim tarixi" kind="ghost" onPress={() => onNav('history')} />
            {!!block && <View style={{ position: 'absolute', top: 8, right: 14, width: 12, height: 12, borderRadius: 6, backgroundColor: C.err }} />}
          </View>
        )}
        <Btn title="Ro'yxatni yangilash" kind="ghost" onPress={() => api.syncNow()} />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------- Shift: supplier list
function ShiftView({ shift, tick, q, setQ, onPick, onNav }) {
  const suppliers = api.getSuppliers();
  const locationOn = api.locationEnabled();
  const lf = api.listFields();
  const here = useMyLocation();
  const rows = useMemo(() => store.shiftCollections(shift.uuid), [shift.uuid, tick]);

  // Totals per supplier for this shift, so the collector sees who is already done.
  const done = useMemo(() => {
    const m = {};
    for (const r of rows) (m[r.supplier_id] ||= []).push(r);
    return m;
  }, [rows]);

  // Distance from where the collector is now to each supplier (when both known).
  const withDist = useMemo(() => suppliers.map((x) => ({
    ...x, dist: locationOn && here && x.lat != null ? distanceM(here, x) : null,
  })), [suppliers, here, locationOn]);

  // Nearest first, farthest last. Suppliers with no location keep the admin's
  // route order and come after the located ones. Order only changes when the
  // collector actually moves (location updates are throttled), so the list is stable.
  const list = useMemo(() => withDist.filter((x) => matches(x, q)).sort((a, b) => {
    if (a.dist != null && b.dist != null) return a.dist - b.dist;
    if (a.dist != null) return -1;
    if (b.dist != null) return 1;
    return 0;
  }), [withDist, q]);

  const totalByProduct = rows.reduce((m, r) => ({ ...m, [r.product_name]: (m[r.product_name] || 0) + r.quantity }), {});

  return (
    <View style={{ flex: 1 }}>
      <SyncBar tick={tick} />
      <View style={{ padding: 12, gap: 8 }}>
        {/* Tap the totals to copy just the overall figures (for a group chat). */}
        <Pressable onPress={() => copyTotals(shift.uuid, rows)}>
          <Text style={s.muted}>
            <Text style={{ fontWeight: '700', color: C.text }}>{shiftName(shift.uuid)}</Text> · ochiq · {fmtTime(shift.opened_at)} · {rows.length} ta ·{' '}
            {Object.entries(totalByProduct).map(([k, v]) => `${k} ${fmtQty(v)}`).join(', ') || '0'}  📋
          </Text>
        </Pressable>
        <SearchBar value={q} onChange={setQ}
          right={api.can('suppliers.create')
            ? <Pressable onPress={() => onNav('new')} style={[s.btn, { paddingHorizontal: 18, paddingVertical: 0, justifyContent: 'center' }]} accessibilityLabel="Yangi xonadon"><Text style={s.btnText}>＋</Text></Pressable>
            : null} />
      </View>
      <FlatList
        data={list}
        keyExtractor={(x) => String(x.id)}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 12, gap: 8 }}
        ListEmptyComponent={<Text style={[s.muted, { padding: 16 }]}>{suppliers.length ? 'Topilmadi' : 'Sizga xonadon biriktirilmagan. Adminga murojaat qiling.'}</Text>}
        renderItem={({ item }) => {
          const got = done[item.id];
          const noProduct = !item.products?.length;
          // Swipe a row left→right to open its location in Google Maps (when it has one).
          const canRoute = locationOn && item.lat != null;
          return (
            <SwipeRow enabled={canRoute} onSwipe={() => openRoute(item)}>
            <Pressable
              onPress={() => (noProduct
                ? notify('Mahsulot yo\'q', 'Bu xonadonga admin mahsulot biriktirmagan.')
                : onPick(item))}
              style={({ pressed }) => [s.card, { flexDirection: 'row', alignItems: 'center', minHeight: 68 },
                got && { borderColor: C.ok }, pressed && { opacity: 0.6 }]}
            >
              <View style={{ flex: 1 }}>
                {lf.name && <Text style={[s.text, { fontSize: 19, fontWeight: '600' }]}>{item.name}</Text>}
                {(() => { const sub = [lf.address ? item.address : null, lf.phone ? item.phone : null].filter(Boolean).join(' · ');
                  return sub ? <Text style={s.muted} numberOfLines={1}>{sub}</Text> : null; })()}
                {!lf.name && !lf.address && !lf.phone && <Text style={[s.text, { fontSize: 19, fontWeight: '600' }]}>{item.name}</Text>}
              </View>
              {got && (
                <Text style={{ color: C.ok, fontSize: 18, fontWeight: '700' }}>
                  ✓ {fmtQty(got.reduce((a, r) => a + r.quantity, 0))}
                </Text>
              )}
            </Pressable>
            </SwipeRow>
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
      saveLabel="Saqlash"
    />
  );
}

function QuantityPad({ title, onTitle, products, product, qty, onProduct, onQty, onCancel, onSave, saveLabel }) {
  useBack(onCancel, !!onCancel);
  const value = toNumber(qty);
  const save = () => {
    if (!(value > 0)) return;
    if (value > 1000) ask('Tekshiring', `${fmtQty(value)} ${product.unit || 'kg'} — to'g'rimi?`, 'Ha, saqlash', () => onSave(value));
    else onSave(value);
  };
  const multi = products.length > 1;
  const [picking, setPicking] = useState(false);
  return (
    <View style={{ flex: 1, padding: 12, gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Pressable onPress={onCancel} hitSlop={16} style={{ paddingRight: 2 }}><Text style={{ fontSize: 28, color: C.muted }}>←</Text></Pressable>
        {/* Product, top-left. Tap to choose another of this household's products. */}
        <Pressable onPress={() => multi && setPicking(true)} disabled={!multi}
          style={({ pressed }) => [{ borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6, maxWidth: '55%',
            backgroundColor: multi ? C.card : 'transparent', borderWidth: multi ? 1 : 0, borderColor: C.line }, pressed && { opacity: 0.6 }]}>
          <Text style={[s.h2, { color: C.accent }]} numberOfLines={1}>{product.isDefault ? '★ ' : ''}{product.name}{multi ? '  ▾' : ''}</Text>
        </Pressable>
        <View style={{ flex: 1 }} />
        {/* Household name: tap for the card (history, debt, payment). */}
        <Pressable onPress={onTitle} disabled={!onTitle} style={({ pressed }) => [{ maxWidth: '45%', borderRadius: 10, paddingHorizontal: 10,
          paddingVertical: 6 }, pressed && { opacity: 0.6 }]}>
          <Text style={[s.h2, { color: onTitle ? C.accent : C.text, textAlign: 'right' }]} numberOfLines={2}>{title}{onTitle ? '  ⓘ' : ''}</Text>
        </Pressable>
      </View>
      <View style={[s.card, { alignItems: 'flex-end', paddingVertical: 20 }]}>
        <Text style={{ fontSize: 56, fontWeight: '700', color: qty ? C.text : C.line }} adjustsFontSizeToFit numberOfLines={1}>
          {qty || '0'} <Text style={{ fontSize: 28, color: C.muted }}>{product.unit || 'kg'}</Text>
        </Text>
      </View>
      <Keypad value={qty} onChange={onQty} onSubmit={save} onCancel={onCancel} />
      <Pressable style={[s.btn, { paddingVertical: 22 }, !(value > 0) && { opacity: 0.4 }]} onPress={save} disabled={!(value > 0)}>
        <Text style={[s.btnText, { fontSize: 26 }]}>{saveLabel}</Text>
      </Pressable>
      <Modal visible={picking} transparent animationType="fade" onRequestClose={() => setPicking(false)}>
        <Pressable onPress={() => setPicking(false)} style={{ flex: 1, backgroundColor: '#0008', justifyContent: 'center', padding: 24 }}>
          <Pressable onPress={() => {}} style={[s.card, { gap: 2 }]}>
            <Text style={[s.h2, { marginBottom: 6 }]}>Mahsulotni tanlang</Text>
            {products.map((p) => (
              <Pressable key={p.id} onPress={() => { onProduct(p); setPicking(false); }}
                style={({ pressed }) => [{ paddingVertical: 14, paddingHorizontal: 10, borderRadius: 10, flexDirection: 'row', alignItems: 'center', gap: 10 },
                  p.id === product.id && { backgroundColor: C.line }, pressed && { opacity: 0.6 }]}>
                <Text style={{ fontSize: 20, width: 22, color: C.warn }}>{p.isDefault ? '★' : ''}</Text>
                <Text style={[s.text, { fontSize: 19, fontWeight: p.id === product.id ? '700' : '500', flex: 1 }]}>{p.name}</Text>
                {p.id === product.id && <Text style={{ color: C.accent, fontSize: 18 }}>✓</Text>}
              </Pressable>
            ))}
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

// ---------------------------------------------------------------- Own entries: edit / delete (open shift only)
function Entries({ shift, tick, onBack, onEdit, refresh }) {
  const all = useMemo(() => store.shiftCollections(shift.uuid), [shift.uuid, tick]);
  const [q, setQ] = useState('');
  const canEdit = api.can('collect.edit_own');
  const canDelete = api.can('collect.delete_own');
  // Search own entries by household name or phone.
  const phoneOf = (id) => api.getSuppliers().find((x) => x.id === id)?.phone ?? '';
  const d = digitsOf(q);
  const rows = q.trim()
    ? all.filter((r) => textMatch(r.supplier_name, q) || (d.length >= 2 && digitsOf(phoneOf(r.supplier_id)).includes(d)))
    : all;
  return (
    <View style={{ flex: 1 }}>
      <Header title={`${shiftName(shift.uuid)} — yozuvlar`} onBack={onBack} />
      <View style={{ paddingHorizontal: 12, paddingBottom: 8 }}>
        <SearchBar value={q} onChange={setQ} />
      </View>
      <FlatList
        data={rows}
        keyExtractor={(r) => r.uuid}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 12, gap: 8 }}
        ListEmptyComponent={<Text style={[s.muted, { padding: 16 }]}>{all.length ? 'Topilmadi' : 'Hali yozuv yo\'q'}</Text>}
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
                    onPress={() => confirmAction('delete', 'O\'chirish', `${r.supplier_name}: ${fmtQty(r.quantity)} ${r.unit} — o'chirilsinmi?`, 'Ha, o\'chirish', () => {
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
function History({ onBack, onCopied, onReopened }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => { setErr(''); api.history().then(setRows).catch((e) => setErr(e.message)); }, []);
  useEffect(load, [load]);
  const canCopy = api.can('collect.copy_cancelled');
  const canEdit = api.editClosedEnabled() && api.can('collect.edit_own');
  const copy = (r) => confirmAction('copy_cancelled', 'Nusxa olish', `${r.label} smenaning nusxasi yangi ochiq smena sifatida ochiladi. Qatorlarni tuzatib, qayta yopasiz.`, 'Ha', async () => {
    try {
      await api.mobile('POST', `/shifts/${r.id}/copy`);
      await api.refreshBootstrap();
      onCopied();
    } catch (e) { notify('Bo\'lmadi', e.message); }
  });
  const edit = (r) => confirmAction('edit', 'Tahrirlash', `${r.label} smena tahrirlash uchun qayta ochiladi. Tuzatib, qayta yoping.`, 'Ha', async () => {
    try {
      await api.reopenShiftForEdit(r.id);
      onReopened();
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
            <Text style={s.text}>{r.pickups} ta qabul · {fmtQty(r.quantity)} kg</Text>
            {!!r.cancel_reason && <Text style={{ color: C.err }}>Sabab: {r.cancel_reason}</Text>}
            {r.status === 'cancelled' && canCopy && <Btn title="Nusxa olib tuzatish" kind="ghost" onPress={() => copy(r)} />}
            {r.status === 'closed' && canEdit && <Btn title="Tahrirlash" kind="ghost" onPress={() => edit(r)} />}
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
        <Text style={s.muted}>Ochilgan: {fmtTime(shift.opened_at)} · {rows.length} ta qabul</Text>
        {/* Tap the totals to copy just the overall figures to send in a group chat. */}
        <Pressable style={[s.card, { gap: 6 }]} onPress={() => copyTotals(shift.uuid, rows)}>
          {Object.entries(byProduct).map(([k, v]) => {
            const [name, unit] = k.split('|');
            return <Text key={k} style={[s.text, { fontSize: 22, fontWeight: '700' }]}>{name}: {fmtQty(v)} {unit}</Text>;
          })}
          {!rows.length && <Text style={s.muted}>Bu smenada yozuv yo'q</Text>}
          {!!rows.length && <Text style={[s.muted, { marginTop: 4 }]}>Jami miqdorni nusxalash uchun bosing 📋</Text>}
        </Pressable>
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
        <Pressable style={s.btn} onPress={() => confirmAction('close', 'Smenani yopish', 'Smena yopilib, qabulga yuborilsinmi?', 'Ha', () => { store.closeShift(shift.uuid); onClosed(); })}>
          <Text style={s.btnText}>Ha, smenani yopish</Text>
        </Pressable>
        <Btn title="Orqaga" kind="ghost" onPress={onBack} />
      </View>
    </View>
  );
}
