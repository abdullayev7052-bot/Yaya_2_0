import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, Text, Vibration, View } from 'react-native';
import * as api from './api';
import { C } from './ui';

// Red banner at the top of the app for alerts that concern this person: product
// kept too long in the incubator (keepers), a task past its time limit (the worker),
// and for managers everything. A new alert beeps (browser / monoblock) or vibrates
// (phone). "Ko'rdim" hides it on this device; it closes for good on the server
// when the cause is gone. Push notifications come with the app builds.

function beep() {
  if (Platform.OS !== 'web') { Vibration.vibrate([0, 400, 200, 400]); return; }
  try {
    const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    [0, 0.35].forEach((t) => {
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.frequency.value = 880; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.25, ctx.currentTime + t); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.3);
      o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.3);
    });
  } catch { /* no sound available */ }
}

export function AlertBanner({ tick }) {
  const [alerts, setAlerts] = useState([]);
  const [hidden, setHidden] = useState(() => new Set());
  const known = useRef(null);
  useEffect(() => {
    let alive = true;
    const check = () => api.erp('GET', '/alerts/mine').then((list) => {
      if (!alive) return;
      const ids = new Set(list.map((a) => a.id));
      if (known.current && list.some((a) => !known.current.has(a.id))) beep();
      known.current = ids;
      setAlerts(list);
    }).catch(() => {});
    check();
    const t = setInterval(check, 30000);
    return () => { alive = false; clearInterval(t); };
  }, [tick]);
  const shown = alerts.filter((a) => !hidden.has(a.id));
  if (!shown.length) return null;
  const a = shown[0];
  return (
    <View style={{ backgroundColor: C.err, paddingHorizontal: 12, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700', flex: 1 }}>{shown.length > 1 ? `(${shown.length}) ` : ''}{a.text}</Text>
      <Pressable onPress={() => setHidden((h) => new Set([...h, a.id]))} hitSlop={10}
        style={{ borderWidth: 1, borderColor: '#fff', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6 }}>
        <Text style={{ color: '#fff', fontWeight: '700' }}>Ko'rdim</Text>
      </Pressable>
    </View>
  );
}
