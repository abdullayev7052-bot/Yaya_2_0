import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import * as api from '../api';
import { ask } from '../dialog';
import { Logo } from '../components';
import { PinPad } from './Lock';
import { C, s } from '../ui';

// Shared monoblock (stage 7). One screen for everyone: big name tiles; a person
// taps their name and types their 4-digit PIN. Alerts that name people (product
// too long in the incubator, a late task) stay visible on this screen for all.

// Pairing: once, with the code the admin gets in the panel (Boshqaruv → Monobloklar).
export function KioskPair({ onDone, onBack }) {
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const pair = async () => {
    setBusy(true); setErr('');
    try { await api.pairKiosk(code); onDone(); } catch (e) { setErr(e.offline ? "Internet yo'q yoki server javob bermadi" : e.message); } finally { setBusy(false); }
  };
  return (
    <ScrollView contentContainerStyle={[s.pad, { flexGrow: 1, justifyContent: 'center', gap: 16 }]} keyboardShouldPersistTaps="handled">
      <Text style={[s.h1, { textAlign: 'center' }]}>Monoblok rejimi</Text>
      <Text style={[s.muted, { textAlign: 'center' }]}>Bu kompyuterda bir nechta xodim ishlaydi: har kim o'z ismini tanlab, 4 xonali PIN bilan kiradi.
        Panelda (Boshqaruv → Monobloklar) olingan 6 xonali kodni kiriting.</Text>
      <TextInput style={[s.input, { textAlign: 'center', fontSize: 32, letterSpacing: 8 }]} value={code} onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))}
        keyboardType="number-pad" placeholder="______" placeholderTextColor={C.placeholder} autoFocus onSubmitEditing={pair} />
      {!!err && <Text style={[s.err, { textAlign: 'center' }]}>{err}</Text>}
      <Pressable style={[s.btn, (busy || code.length !== 6) && { opacity: 0.6 }]} onPress={pair} disabled={busy || code.length !== 6}>
        <Text style={s.btnText}>{busy ? '...' : 'Ulash'}</Text>
      </Pressable>
      <Pressable onPress={onBack} style={{ alignItems: 'center' }}><Text style={s.muted}>← Oddiy kirish</Text></Pressable>
    </ScrollView>
  );
}

function KioskAlerts() {
  const [list, setList] = useState([]);
  useEffect(() => {
    let alive = true;
    const load = () => api.kioskAlerts().then((x) => { if (alive) setList(x); }).catch(() => {});
    load();
    const t = setInterval(load, 30000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  if (!list.length) return null;
  return (
    <View style={{ backgroundColor: C.err, padding: 12, gap: 6 }}>
      {list.slice(0, 4).map((a) => <Text key={a.id} style={{ color: '#fff', fontSize: 17, fontWeight: '700' }}>⚠ {a.text}</Text>)}
    </View>
  );
}

export function KioskPicker({ onSignedIn, onLeft }) {
  const [data, setData] = useState(() => ({ kiosk: api.getKiosk(), staff: api.cachedKioskStaff() }));
  const [who, setWho] = useState(null);
  const [err, setErr] = useState('');
  const [offline, setOffline] = useState(false);
  const brand = api.getBrand();
  useEffect(() => {
    api.startAutoSync(); // unsent work of earlier people still goes out from this screen
    let alive = true;
    const load = () => api.kioskStaff().then((r) => { if (alive) { setData(r); setOffline(false); } })
      .catch((e) => { if (!alive) return; if (e.offline) setOffline(true); else if (e.status === 401) { api.leaveKiosk(); onLeft(); } });
    load();
    const t = setInterval(load, 60000);
    return () => { alive = false; clearInterval(t); };
  }, [onLeft]);
  const signIn = async (pin) => {
    setErr('');
    try { await api.kioskLogin(who.id, pin); setWho(null); onSignedIn(); } catch (e) { setErr(e.offline ? "Internet yo'q — monoblokka kirish uchun internet kerak" : e.message); }
  };
  if (who) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', padding: 24, gap: 16 }}>
        <PinPad title={who.name} subtitle="PIN kodingizni kiriting" error={err} onComplete={signIn} />
        <Pressable onPress={() => { setWho(null); setErr(''); }} style={{ alignItems: 'center', padding: 12 }}><Text style={[s.text, { color: C.muted }]}>← Boshqa xodim</Text></Pressable>
      </View>
    );
  }
  return (
    <View style={{ flex: 1 }}>
      <KioskAlerts />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <Logo size={48} />
          <View style={{ flex: 1 }}>
            <Text style={s.h1}>{brand.companyName || 'Yaya'}</Text>
            <Text style={s.muted}>{data.kiosk?.name ?? 'Monoblok'} · ismingizni tanlang{offline ? ' · internet yo\'q' : ''}</Text>
          </View>
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
          {data.staff.map((u) => (
            <Pressable key={u.id} onPress={() => u.hasPin && setWho(u)}
              style={({ pressed }) => [s.card, { width: 220, flexGrow: 1, minHeight: 96, justifyContent: 'center', gap: 4 }, !u.hasPin && { opacity: 0.5 }, pressed && { backgroundColor: C.line }]}>
              <Text style={{ fontSize: 22, fontWeight: '700', color: C.text }}>{u.name}</Text>
              <Text style={s.muted}>{u.hasPin ? u.role : "PIN o'rnatilmagan"}</Text>
            </Pressable>
          ))}
        </View>
        {!data.staff.length && <Text style={s.muted}>Xodimlar ro'yxati yuklanmadi.</Text>}
        <Pressable onPress={() => ask('Monoblok rejimi', "Bu kompyuter monoblok rejimidan chiqarilsinmi? Qayta ulash uchun paneldan yangi kod kerak bo'ladi.", 'Chiqarish', () => { api.leaveKiosk(); onLeft(); })}
          style={{ alignItems: 'center', padding: 12 }}>
          <Text style={[s.muted, { fontSize: 13 }]}>Monoblok rejimidan chiqish</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}
