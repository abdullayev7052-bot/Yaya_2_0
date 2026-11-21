import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import * as api from '../api';
import { Logo } from '../components';
import Collector from './Collector';
import Profile from './Profile';
import { Debts, Lab, LabDetail, MyPayments, Payments, ShiftDetail, Shifts, Today } from './Office';
import { PaymentForm, SupplierCard } from './Supplier';
import { InventoryForm, Stock, StockForm, canStock } from './Stock';
import { CloseShift, NewTask, Production, TaskScreen, canProduce } from './Production';
import { AlertBanner } from '../AlertBanner';
import { OutboxBadge } from '../Outbox';
import { SaleForm, SaleView, SalesHome, canSell } from './Sales';
import { C, s } from '../ui';

// One app for all staff. The sections shown depend only on the person's permissions:
// a collector sees the shift; a storekeeper or accountant sees shifts to accept,
// debts and payments; a manager sees the day's figures as well.
const TABS = [
  ['collect', 'Smena', () => api.can('collect.shift')],
  ['today', 'Kun', () => api.can('reports.view')],
  ['shifts', 'Smenalar', () => api.can('shifts.view_all')],
  ['lab', 'Laborant', () => api.can('lab.view')],
  ['sales', 'Savdo', canSell],
  ['prod', 'Ishlab chiqarish', canProduce],
  ['stock', 'Ombor', canStock],
  ['debts', 'Qarzlar', () => api.can('debts.view')],
  ['pays', 'To\'lovlar', () => api.can('debts.view')],
  // Collector's own payments only — shown when they lack the broad debts.view.
  ['mypays', 'To\'lovlarim', () => api.can('payments.view_own') && !api.can('debts.view')],
  ['me', 'Profil', () => true],
];

export default function Home({ tick, refresh, onLogout }) {
  const tabs = TABS.filter((t) => t[2]());
  const [tab, setTab] = useState(tabs[0][0]);
  const [full, setFull] = useState(false);
  // Detail screens opened from the office tabs.
  const [shiftId, setShiftId] = useState(null);
  const [cardId, setCardId] = useState(null);
  const [labId, setLabId] = useState(null);
  const [payFor, setPayFor] = useState(null);
  const [labFlag, setLabFlag] = useState(false);
  // Warehouse form: { type, docId } (hand over / write off / count).
  const [stockForm, setStockForm] = useState(null);
  // Technologist screens: { screen: 'new' | 'task' | 'close', id }.
  const [prodView, setProdView] = useState(null);
  // Seller screens: { screen: 'form', type } or { screen: 'view', id }.
  const [saleView, setSaleView] = useState(null);
  const [toast, setToast] = useState('');
  // Red dot on the Laborant tab while any accepted shift is flagged (over a limit).
  useEffect(() => {
    if (!api.can('lab.view')) return undefined;
    let alive = true;
    const check = () => api.admin('GET', '/lab').then((d) => { if (alive) setLabFlag((d.flagged || 0) > 0); }).catch(() => {});
    check();
    const t = setInterval(check, 30000);
    return () => { alive = false; clearInterval(t); };
  }, [tick]);
  // Long-pressing the "Smena" tab (2s) opens the collector's own shift history,
  // even while a shift is open. Bumping this counter signals the request.
  const [histReq, setHistReq] = useState(0);
  const current = tabs.some((t) => t[0] === tab) ? tab : tabs[0][0];
  const me = api.me();

  let body;
  const stockDone = (m) => { setStockForm(null); setToast(m); setTimeout(() => setToast(''), 4000); refresh(); };
  const prodDone = (m) => { setProdView(null); setToast(m); setTimeout(() => setToast(''), 4000); refresh(); };
  if (saleView?.screen === 'form') {
    body = <SaleForm type={saleView.type} onBack={() => setSaleView(null)} onDone={(id) => {
      if (id) setSaleView({ screen: 'view', id });
      else { setSaleView(null); setToast("Internet yo'q — navbatga qo'yildi, internet chiqqanda o'zi yuboriladi"); setTimeout(() => setToast(''), 5000); }
      refresh();
    }} />;
  } else if (saleView?.screen === 'view') {
    body = <SaleView id={saleView.id} onBack={() => { setSaleView(null); refresh(); }} />;
  } else if (prodView?.screen === 'new') {
    body = <NewTask onBack={() => setProdView(null)} onDone={(id) => setProdView({ screen: 'task', id })} />;
  } else if (prodView?.screen === 'task') {
    body = <TaskScreen id={prodView.id} onBack={() => { setProdView(null); refresh(); }} onDone={prodDone} />;
  } else if (prodView?.screen === 'close') {
    body = <CloseShift onBack={() => setProdView(null)} onDone={prodDone} />;
  } else if (stockForm?.type === 'inventory') {
    body = <InventoryForm docId={stockForm.docId} onBack={() => setStockForm(null)} onDone={stockDone} />;
  } else if (stockForm) {
    body = <StockForm type={stockForm.type} onBack={() => setStockForm(null)} onDone={stockDone} />;
  } else if (payFor) {
    body = <PaymentForm supplier={payFor} onBack={() => setPayFor(null)}
      onDone={(m) => { setPayFor(null); setToast(m); setTimeout(() => setToast(''), 3000); refresh(); }} />;
  } else if (cardId) {
    body = <SupplierCard id={cardId} onBack={() => setCardId(null)} onPay={setPayFor} />;
  } else if (shiftId) {
    body = <ShiftDetail id={shiftId} onBack={() => setShiftId(null)} onChanged={refresh} onCard={setCardId} />;
  } else if (labId) {
    body = <LabDetail id={labId} onBack={() => setLabId(null)} onChanged={refresh} />;
  } else if (current === 'collect') body = <Collector tick={tick} refresh={refresh} setFull={setFull} histReq={histReq} />;
  else if (current === 'today') body = <Today onShift={setShiftId} />;
  else if (current === 'shifts') body = <Shifts onShift={setShiftId} tick={tick} />;
  else if (current === 'lab') body = <Lab onOpen={setLabId} />;
  else if (current === 'sales') body = <SalesHome tick={tick} onForm={(type) => setSaleView({ screen: 'form', type })} onOpen={(id) => setSaleView({ screen: 'view', id })} />;
  else if (current === 'prod') body = <Production tick={tick} onNew={() => setProdView({ screen: 'new' })} onTask={(id) => setProdView({ screen: 'task', id })} onClose={() => setProdView({ screen: 'close' })} />;
  else if (current === 'stock') body = <Stock tick={tick} onForm={(type, docId) => setStockForm({ type, docId })} />;
  else if (current === 'debts') body = <Debts onOpen={setCardId} onPay={setPayFor} tick={tick} />;
  else if (current === 'pays') body = <Payments onOpen={setCardId} />;
  else if (current === 'mypays') body = <MyPayments />;
  else body = <Profile tick={tick} onLogout={onLogout} setFull={setFull} />;

  const detail = !!(saleView || prodView || stockForm || payFor || cardId || shiftId || labId);
  const chrome = !full && !detail;
  return (
    <View style={{ flex: 1 }}>
      {chrome && (
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, gap: 10, borderBottomWidth: 1, borderColor: C.line }}>
          <Logo size={28} />
          <Text style={[s.text, { flex: 1, fontWeight: '700' }]} numberOfLines={1}>{api.getBrand().companyName || 'Yaya'}</Text>
          <OutboxBadge />
          <Text style={s.muted} numberOfLines={1}>{me?.name || me?.login} · {me?.role}</Text>
          {api.getSession()?.kiosk && (
            <Pressable onPress={onLogout} style={[s.btnGhost, { paddingVertical: 8, paddingHorizontal: 14 }]}>
              <Text style={s.btnGhostText}>⇄ Almashish</Text>
            </Pressable>
          )}
        </View>
      )}
      {(canProduce() || canStock() || api.can('alerts.view')) && <AlertBanner tick={tick} />}
      {!!toast && <View style={{ backgroundColor: C.ok, padding: 12 }}><Text style={{ color: '#fff', fontSize: 17, fontWeight: '700' }}>{toast}</Text></View>}
      <View style={{ flex: 1 }}>{body}</View>
      {chrome && tabs.length > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} bounces={false}
          style={{ flexGrow: 0, borderTopWidth: 1, borderColor: C.line, backgroundColor: C.card }}
          contentContainerStyle={{ flexGrow: 1 }}>
          {tabs.map(([k, t]) => (
            <Pressable key={k} onPress={() => setTab(k)}
              onLongPress={k === 'collect' && api.can('collect.view_own_shifts') ? () => { setTab('collect'); setHistReq((n) => n + 1); } : undefined}
              delayLongPress={2000}
              style={{ flexGrow: 1, minWidth: 68, paddingVertical: 13, paddingHorizontal: 10, alignItems: 'center', justifyContent: 'center' }}>
              <View>
                <Text numberOfLines={1} style={{ fontSize: 13.5, fontWeight: current === k ? '700' : '500', color: current === k ? C.accent : C.muted }}>{t}</Text>
                {k === 'lab' && labFlag && <View style={{ position: 'absolute', top: -2, right: -10, width: 9, height: 9, borderRadius: 5, backgroundColor: C.err }} />}
              </View>
            </Pressable>
          ))}
        </ScrollView>
      )}
    </View>
  );
}
