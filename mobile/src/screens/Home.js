import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import * as api from '../api';
import { Logo } from '../components';
import Collector from './Collector';
import Profile from './Profile';
import { Debts, Lab, LabDetail, MyPayments, Payments, ShiftDetail, Shifts, Today } from './Office';
import { PaymentForm, SupplierCard } from './Supplier';
import { C, s } from '../ui';

// One app for all staff. The sections shown depend only on the person's permissions:
// a collector sees the shift; a storekeeper or accountant sees shifts to accept,
// debts and payments; a manager sees the day's figures as well.
const TABS = [
  ['collect', 'Smena', () => api.can('collect.shift')],
  ['today', 'Kun', () => api.can('reports.view')],
  ['shifts', 'Smenalar', () => api.can('shifts.view_all')],
  ['lab', 'Laborant', () => api.can('lab.view')],
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
  if (payFor) {
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
  else if (current === 'debts') body = <Debts onOpen={setCardId} onPay={setPayFor} tick={tick} />;
  else if (current === 'pays') body = <Payments onOpen={setCardId} />;
  else if (current === 'mypays') body = <MyPayments />;
  else body = <Profile tick={tick} onLogout={onLogout} setFull={setFull} />;

  const detail = !!(payFor || cardId || shiftId || labId);
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
              <View>
                <Text style={{ fontSize: 15, fontWeight: current === k ? '700' : '500', color: current === k ? C.accent : C.muted }}>{t}</Text>
                {k === 'lab' && labFlag && <View style={{ position: 'absolute', top: -2, right: -10, width: 9, height: 9, borderRadius: 5, backgroundColor: C.err }} />}
              </View>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}
