import { useCallback, useEffect, useState } from 'react';
import { AppState, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as api from './src/api';
import * as lock from './src/lock';
import Login from './src/screens/Login';
import Home from './src/screens/Home';
import { LockScreen } from './src/screens/Lock';
import { s } from './src/ui';

export default function App() {
  return (
    <SafeAreaProvider>
      <SafeAreaView style={s.screen} edges={['top', 'bottom']}>
        <StatusBar style="dark" />
        <Root />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function Root() {
  const [session, setSession] = useState(api.getSession());
  // Starting the app with a PIN set always asks for it.
  const [locked, setLocked] = useState(() => !!api.getSession() && lock.lockEnabled());
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => api.onSession(setSession), []);

  useEffect(() => {
    if (!session) return undefined;
    api.startAutoSync();
    return api.onSyncState(refresh);
  }, [session, refresh]);

  // Auto-lock after the chosen idle time, also counting time in the background.
  useEffect(() => {
    if (!session) return undefined;
    const check = () => { if (lock.shouldLock()) setLocked(true); };
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active') check();
      else lock.touch();
    });
    const t = setInterval(check, 15000);
    return () => { sub.remove(); clearInterval(t); };
  }, [session]);

  const logout = (reason) => { api.logout(reason); setLocked(false); };

  if (!session) return <Login onDone={() => { lock.touch(); setSession(api.getSession()); setLocked(false); }} />;
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
