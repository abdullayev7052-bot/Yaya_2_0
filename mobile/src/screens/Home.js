import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import * as api from '../api';
import { Logo } from '../components';
import Collector from './Collector';
import Profile from './Profile';
import { Debts, ShiftDetail, Shifts, Today } from './Office';
import { PaymentForm, SupplierCard } from './Supplier';
import { C, s } from '../ui';

// One app for all staff. The sections shown depend only on the person's permissions:
// a collector sees the shift; a storekeeper or accountant sees shifts to accept,
// debts and payments; a manager sees the day's figures as well.
const TABS = [
  ['collect', 'Smena', () => api.can('collect.shift')],
  ['today', 'Kun', () => api.can('reports.view')],
  ['shifts', 'Smenalar', () => api.can('shifts.view_all')],
  ['debts', 'Qarzlar', () => api.can('debts.view')],
  ['me', 'Profil', () => true],
];

export default function Home({ tick, refresh, onLogout }) {
  const tabs = TABS.filter((t) => t[2]());
  const [tab, setTab] = useState(tabs[0][0]);
  const [full, setFull] = useState(false);
  // Detail screens opened from the office tabs.
  const [shiftId, setShiftId] = useState(null);
  const [cardId, setCardId] = useState(null);
  const [payFor, setPayFor] = useState(null);
  const [toast, setToast] = useState('');
  // Long-pressing the "Smena" tab (2s) opens the collector's own shift history,
  // even while a shift is open. Bumping this counter signals the request.
  const [histReq, setHistReq] = useState(0);
  const current = tabs.some((t) => t[0] === tab) ? tab : tabs[0][0];
  const me = api.me();

  let body;
  if (payFor) {
    body = <PaymentForm supplier={payFor} onBack={() => setPayFor(null)}
      onDone={(m) => { setPayFor(null); setToast(m); setTimeout(() => setToast(''), 3000); refresh(); }} />;
  } else if (cardId) {
    body = <SupplierCard id={cardId} onBack={() => setCardId(null)} onPay={setPayFor} />;
  } else if (shiftId) {
    body = <ShiftDetail id={shiftId} onBack={() => setShiftId(null)} onChanged={refresh} />;
  } else if (current === 'collect') body = <Collector tick={tick} refresh={refresh} setFull={setFull} histReq={histReq} />;
  else if (current === 'today') body = <Today onShift={setShiftId} />;
  else if (current === 'shifts') body = <Shifts onShift={setShiftId} tick={tick} />;
  else if (current === 'debts') body = <Debts onOpen={setCardId} onPay={setPayFor} tick={tick} />;
  else body = <Profile tick={tick} onLogout={onLogout} setFull={setFull} />;

  const detail = !!(payFor || cardId || shiftId);
  const chrome = !full && !detail;
  return (
    <View style={{ flex: 1 }}>
      {chrome && (
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, gap: 10, borderBottomWidth: 1, borderColor: C.line }}>
          <Logo size={28} />
          <Text style={[s.text, { flex: 1, fontWeight: '700' }]} numberOfLines={1}>{api.getBrand().companyName || 'Yaya'}</Text>
          <Text style={s.muted} numberOfLines={1}>{me?.name || me?.login} · {me?.role}</Text>
        </View>
      )}
      {!!toast && <View style={{ backgroundColor: C.ok, padding: 12 }}><Text style={{ color: '#fff', fontSize: 17, fontWeight: '700' }}>{toast}</Text></View>}
      <View style={{ flex: 1 }}>{body}</View>
      {chrome && tabs.length > 1 && (
        <View style={{ flexDirection: 'row', borderTopWidth: 1, borderColor: C.line, backgroundColor: C.card }}>
          {tabs.map(([k, t]) => (
            <Pressable key={k} onPress={() => setTab(k)}
              onLongPress={k === 'collect' && api.can('collect.view_own_shifts') ? () => { setTab('collect'); setHistReq((n) => n + 1); } : undefined}
              delayLongPress={2000}
              style={{ flex: 1, paddingVertical: 14, alignItems: 'center' }}>
              <Text style={{ fontSize: 15, fontWeight: current === k ? '700' : '500', color: current === k ? C.accent : C.muted }}>{t}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}
