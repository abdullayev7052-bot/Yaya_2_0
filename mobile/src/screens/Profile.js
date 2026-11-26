import { useEffect, useState } from 'react';
import { ScrollView, Switch, Text, TextInput, View } from 'react-native';
import * as api from '../api';
import * as lock from '../lock';
import * as store from '../db';
import SyncBar from '../SyncBar';
import { ask, notify } from '../dialog';
import { Btn, Chip, KEY_SIZES, getKeysCfg, setKeysCfg } from '../components';
import { PinSetup } from './Lock';
import { s } from '../ui';

// "Profil": who is logged in, app lock (PIN / fingerprint / auto-lock), password, logout.
export default function Profile({ tick, onLogout, setFull }) {
  const [keys, setKeys] = useState(getKeysCfg());
  const me = api.me();
  const [cfg, setCfg] = useState(lock.getLock());
  const [settingPin, setSettingPin] = useState(false);
  const [bioOk, setBioOk] = useState(false);
  const [pw, setPw] = useState({ current: '', next: '' });
  const [pwOpen, setPwOpen] = useState(false);
  const [pwBusy, setPwBusy] = useState(false);
  const [night, setNight] = useState(api.getThemePref() === 'dark');
  useEffect(() => { lock.bioAvailable().then(setBioOk); }, []);
  useEffect(() => { setFull(settingPin); }, [settingPin, setFull]);
  const reload = () => setCfg(lock.getLock());

  if (settingPin) return <PinSetup onCancel={() => setSettingPin(false)} onDone={() => { setSettingPin(false); reload(); notify('Tayyor', 'PIN o\'rnatildi'); }} />;

  const changePw = async () => {
    setPwBusy(true);
    try {
      await api.changePassword(pw.current, pw.next);
      setPw({ current: '', next: '' });
      setPwOpen(false);
      notify('Tayyor', 'Parol o\'zgartirildi');
    } catch (e) { notify('Bo\'lmadi', e.message); } finally { setPwBusy(false); }
  };
  const logout = () => {
    const pending = store.unsyncedCount();
    if (pending) {
      notify('Chiqib bo\'lmaydi', `${pending} ta yozuv hali serverga yuborilmagan. Internetga ulaning va kuting.`);
      return;
    }
    ask('Chiqish', 'Hisobdan chiqasizmi? Qayta kirish uchun login va parol kerak bo\'ladi.', 'Ha, chiqish', onLogout);
  };

  return (
    <View style={{ flex: 1 }}>
      <SyncBar tick={tick} />
      <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }} keyboardShouldPersistTaps="handled">
        <View style={[s.card, { gap: 4 }]}>
          <Text style={s.h2}>{me?.name || me?.login}</Text>
          <Text style={s.muted}>{me?.role} · login: {me?.login}{me?.isTest ? ' · TEST' : ''}</Text>
        </View>

        {api.getSession()?.kiosk && (
          <View style={[s.card, { gap: 10 }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Text style={[s.text, { flex: 1, fontWeight: '700' }]}>⌨ Ekrandagi raqamli klaviatura</Text>
              <Switch value={keys.on} onValueChange={(v) => { setKeysCfg({ on: v }); setKeys(getKeysCfg()); }} />
            </View>
            <Text style={s.muted}>Monoblokda son kiritiladigan joy bosilganda burchakda chiqadi. Shu monoblok uchun saqlanadi.</Text>
            {keys.on && (
              <View style={{ flexDirection: 'row', gap: 6 }}>
                {Object.entries(KEY_SIZES).map(([k, [label]]) => <Chip key={k} label={label} on={keys.size === k} onPress={() => { setKeysCfg({ size: k }); setKeys(getKeysCfg()); }} />)}
              </View>
            )}
          </View>
        )}

        <View style={[s.card, { gap: 10 }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Text style={[s.text, { flex: 1, fontWeight: '700' }]}>🌙 Tungi rejim</Text>
            <Switch value={night} onValueChange={(v) => { setNight(v); api.setThemePref(v ? 'dark' : 'light'); }} />
          </View>
        </View>

        <View style={[s.card, { gap: 10 }]}>
          <Text style={[s.text, { fontWeight: '700' }]}>🔒 Ilova qulfi</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Text style={[s.text, { flex: 1 }]}>PIN o'rnatish</Text>
            <Switch value={!!cfg.pin} onValueChange={(v) => {
              if (v) setSettingPin(true);
              else ask('PIN\'ni o\'chirish', 'Ilova qulfsiz ochiladi. Davom etasizmi?', 'Ha', () => { lock.clearPin(); reload(); });
            }} />
          </View>
          {!!cfg.pin && <Btn title="PIN'ni almashtirish" kind="ghost" onPress={() => setSettingPin(true)} />}
          {!!cfg.pin && bioOk && (
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Text style={[s.text, { flex: 1 }]}>Barmoq izi / Face ID</Text>
              <Switch value={!!cfg.bio} onValueChange={async (v) => {
                if (v && !(await lock.bioAuth())) return;
                lock.setBio(v);
                reload();
              }} />
            </View>
          )}
          {!!cfg.pin && (
            <>
              <Text style={s.muted}>Avtomatik qulflash (ishlatilmasa):</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                {lock.TIMEOUTS.map((m) => (
                  <Chip key={m} label={m ? `${m} daq` : 'O\'chiq'} on={cfg.minutes === m} onPress={() => { lock.setMinutes(m); reload(); }} />
                ))}
              </View>
              {!cfg.minutes && <Text style={s.muted}>O'chiq: ilova faqat qayta ishga tushirilganda qulflanadi.</Text>}
            </>
          )}
        </View>

        <View style={[s.card, { gap: 10 }]}>
          {!pwOpen ? (
            <Btn title="Parolni o'zgartirish" kind="ghost" onPress={() => setPwOpen(true)} />
          ) : (
            <>
              <Text style={[s.text, { fontWeight: '700' }]}>Parolni o'zgartirish</Text>
              <TextInput style={s.input} value={pw.current} onChangeText={(v) => setPw({ ...pw, current: v })} placeholder="Joriy parol" secureTextEntry autoCapitalize="none" autoFocus />
              <TextInput style={s.input} value={pw.next} onChangeText={(v) => setPw({ ...pw, next: v })} placeholder="Yangi parol (kamida 6 belgi)" secureTextEntry autoCapitalize="none" />
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Btn title="Bekor" kind="ghost" style={{ flex: 1 }} onPress={() => { setPwOpen(false); setPw({ current: '', next: '' }); }} />
                <Btn title={pwBusy ? '...' : "O'zgartirish"} style={{ flex: 1 }} disabled={pwBusy || !pw.current || pw.next.length < 6} onPress={changePw} />
              </View>
            </>
          )}
        </View>

        {!api.getSession()?.kiosk && <MonoblockPin />}
        <Btn title={api.getSession()?.kiosk ? '⇄ Almashish' : 'Hisobdan chiqish'} kind="warn" onPress={logout} />
      </ScrollView>
    </View>
  );
}

// The 4-digit PIN for signing in on a shared monoblock (set from one's own phone).
function MonoblockPin() {
  const [open, setOpen] = useState(false);
  const [pin, setPinV] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { await api.setMyPin(pin, password); notify('Tayyor', 'Monoblok PIN kodi saqlandi'); setOpen(false); setPinV(''); setPassword(''); }
    catch (e) { notify('Xatolik', e.message); } finally { setBusy(false); }
  };
  return (
    <View style={[s.card, { gap: 8 }]}>
      {!open ? <Btn title="Monoblok uchun PIN" kind="ghost" onPress={() => setOpen(true)} /> : (
        <>
          <Text style={[s.text, { fontWeight: '700' }]}>Monoblok PIN kodi</Text>
          <Text style={s.muted}>Sexdagi umumiy kompyuterda ismingizni tanlab, shu 4 xonali PIN bilan kirasiz.</Text>
          <TextInput style={s.input} value={pin} onChangeText={(v) => setPinV(v.replace(/\D/g, '').slice(0, 4))} placeholder="Yangi PIN (4 raqam)" keyboardType="number-pad" secureTextEntry />
          <TextInput style={s.input} value={password} onChangeText={setPassword} placeholder="Parolingiz" secureTextEntry autoCapitalize="none" />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Btn title="Bekor" kind="ghost" style={{ flex: 1 }} onPress={() => setOpen(false)} />
            <Btn title={busy ? '...' : 'Saqlash'} style={{ flex: 1 }} disabled={busy || pin.length !== 4 || !password} onPress={save} />
          </View>
        </>
      )}
    </View>
  );
}
