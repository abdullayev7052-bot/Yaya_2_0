import { Component, useCallback, useEffect, useState } from 'react';
import { AppState, Pressable, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as api from './src/api';
import * as lock from './src/lock';
import Login from './src/screens/Login';
import Home from './src/screens/Home';
import Splash from './src/screens/Splash';
import { LockScreen } from './src/screens/Lock';
import { KioskPair, KioskPicker } from './src/screens/Kiosk';
import { isDark, onThemeChange, s, setTheme } from './src/ui';

// Catches any render error anywhere in the app and shows a recover screen
// instead of letting the app close. Nothing the user entered is lost — it is
// already saved on the phone and will still sync.
class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error) { /* kept on screen; could be logged later */ }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <View style={{ flex: 1, justifyContent: 'center', padding: 24, gap: 16 }}>
        <Text style={s.h1}>Nimadir xato ketdi</Text>
        <Text style={s.muted}>Ma'lumotlaringiz telefonda saqlangan va yo'qolmaydi. "Qayta urinish" ni bosing.</Text>
        <Pressable style={s.btn} onPress={() => this.setState({ error: null })}>
          <Text style={s.btnText}>Qayta urinish</Text>
        </Pressable>
      </View>
    );
  }
}

// Apply the signed-in user's saved night-mode preference before the first paint.
api.applySavedTheme();

export default function App() {
  const [themeTick, setThemeTick] = useState(0);
  useEffect(() => onThemeChange(() => setThemeTick((t) => t + 1)), []);
  return (
    <SafeAreaProvider>
      <SafeAreaView style={s.screen} edges={['top', 'bottom']} key={themeTick}>
        <StatusBar style={isDark() ? 'light' : 'dark'} />
        <ErrorBoundary>
          <Root />
        </ErrorBoundary>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function Root() {
  const [session, setSession] = useState(api.getSession());
  // Starting the app with a PIN set always asks for it.
  const [locked, setLocked] = useState(() => !!api.getSession() && lock.lockEnabled());
  const [splash, setSplash] = useState(false);
  // Shared monoblock: paired once; then the name list replaces the login screen.
  const [kiosk, setKiosk] = useState(() => !!api.getKiosk());
  const [pairing, setPairing] = useState(false);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => api.onSession((sx) => { setSession(sx); if (!sx) setTheme('light'); }), []);

  useEffect(() => {
    if (!session) return undefined;
    api.startAutoSync();
    return api.onSyncState(refresh);
  }, [session, refresh]);

  // On a monoblock the idle timer signs the person out and brings the name list back.
  useEffect(() => {
    if (!session?.kiosk) return undefined;
    const minutes = api.getKiosk()?.idleMinutes ?? 2;
    lock.touch();
    const t = setInterval(() => { if (lock.idleFor() > minutes * 60000) api.logout(); }, 5000);
    return () => clearInterval(t);
  }, [session]);

  // Auto-lock after the chosen idle time, also counting time in the background.
  useEffect(() => {
    if (!session || session.kiosk) return undefined;
    const check = () => { if (lock.shouldLock()) setLocked(true); };
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active') check();
      else lock.touch();
    });
    const t = setInterval(check, 15000);
    return () => { sub.remove(); clearInterval(t); };
  }, [session]);

  const logout = (reason) => { api.logout(reason); setLocked(false); setSplash(false); };

  if (!session && kiosk) {
    return <KioskPicker onSignedIn={() => { lock.touch(); api.applySavedTheme(); setSession(api.getSession()); setLocked(false); }} onLeft={() => setKiosk(false)} />;
  }
  if (!session && pairing) return <KioskPair onDone={() => { setPairing(false); setKiosk(true); }} onBack={() => setPairing(false)} />;
  if (!session) {
    return <Login onKiosk={() => setPairing(true)} onDone={() => { lock.touch(); api.applySavedTheme(); setSession(api.getSession()); setLocked(false); setSplash(true); }} />;
  }
  // The entry animation plays once, right after signing in.
  if (splash) return <Splash onDone={() => setSplash(false)} />;
  if (locked) {
    return <LockScreen user={session.user} onUnlock={() => { lock.touch(); setLocked(false); }} onForgot={logout} />;
  }
  return (
    // Any touch counts as activity for the auto-lock timer.
    <View style={{ flex: 1 }} onStartShouldSetResponderCapture={() => { lock.touch(); return false; }}>
      <Home tick={tick} refresh={refresh} onLogout={() => logout()} />
    </View>
  );
}
