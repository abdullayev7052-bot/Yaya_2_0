import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import * as lock from '../lock';
import { Logo } from '../components';
import { C, s } from '../ui';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'bio', '0', '⌫'];

// Four dots and a big number pad. Digits are kept as typed (leading zeros too).
export function PinPad({ title, subtitle, error, onComplete, bio, onBio }) {
  const [pin, setPin] = useState('');
  const done = useRef(onComplete);
  done.current = onComplete;
  const press = useCallback((k) => {
    setPin((p) => {
      if (k === '⌫') return p.slice(0, -1);
      if (p.length >= 4) return p;
      const next = p + k;
      if (next.length === 4) setTimeout(() => { done.current(next); setPin(''); }, 120);
      return next;
    });
  }, []);
  useEffect(() => {
    if (Platform.OS !== 'web') return undefined;
    const onKey = (e) => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') press('⌫');
    };
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, [press]);
  return (
    <View style={{ gap: 18, alignItems: 'center' }}>
      <Text style={[s.h2, { textAlign: 'center' }]}>{title}</Text>
      {!!subtitle && <Text style={[s.muted, { textAlign: 'center' }]}>{subtitle}</Text>}
      <View style={{ flexDirection: 'row', gap: 18, marginVertical: 8 }}>
        {[0, 1, 2, 3].map((i) => (
          <View key={i} style={{ width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: C.accent,
            backgroundColor: i < pin.length ? C.accent : 'transparent' }} />
        ))}
      </View>
      <Text style={[s.err, { minHeight: 22, textAlign: 'center' }]}>{error ?? ''}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, width: '100%', maxWidth: 340 }}>
        {KEYS.map((k) => {
          if (k === 'bio' && !bio) return <View key={k} style={{ width: '30%', flexGrow: 1 }} />;
          return (
            <Pressable key={k} onPress={() => (k === 'bio' ? onBio() : press(k))} accessibilityLabel={k === 'bio' ? 'Barmoq izi' : k}
              style={({ pressed }) => [s.card, { width: '30%', flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 0,
                minHeight: 66 }, pressed && { backgroundColor: C.line }]}>
              <Text style={{ fontSize: k === 'bio' ? 26 : 30, fontWeight: '600', color: C.text }}>{k === 'bio' ? '👆' : k}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function LockScreen({ user, onUnlock, onForgot }) {
  const [err, setErr] = useState('');
  const [bio, setBio] = useState(false);
  const tryBio = useCallback(async () => {
    if (await lock.bioAuth()) onUnlock();
  }, [onUnlock]);
  useEffect(() => {
    if (!lock.getLock().bio) return;
    lock.bioAvailable().then((ok) => {
      setBio(ok);
      if (ok) tryBio();
    });
  }, [tryBio]);
  return (
    <View style={{ flex: 1, justifyContent: 'center', padding: 16, gap: 12 }}>
      <View style={{ alignItems: 'center' }}><Logo size={64} /></View>
      <PinPad
        title={user?.name || user?.login || 'Yaya'}
        subtitle="Ilovani ochish uchun PIN kiriting"
        error={err}
        bio={bio}
        onBio={tryBio}
        onComplete={async (pin) => {
          if (await lock.verifyPin(pin)) { setErr(''); onUnlock(); return; }
          const left = lock.triesLeft();
          if (left <= 0) { lock.clearPin(); onForgot('PIN 5 marta noto\'g\'ri kiritildi. Login va parol bilan qayta kiring.'); return; }
          setErr(`PIN noto'g'ri. Yana ${left} ta urinish qoldi.`);
        }}
      />
      <Pressable onPress={() => onForgot('PIN unutildi. Login va parol bilan qayta kiring.')} style={{ alignItems: 'center', padding: 12 }}>
        <Text style={[s.muted, { textDecorationLine: 'underline' }]}>PIN'ni unutdim — parol bilan kirish</Text>
      </Pressable>
    </View>
  );
}

// New PIN: type it twice.
export function PinSetup({ onDone, onCancel }) {
  const [first, setFirst] = useState(null);
  const [err, setErr] = useState('');
  return (
    <View style={{ flex: 1, justifyContent: 'center', padding: 16, gap: 12 }}>
      <PinPad
        key={first ? 'confirm' : 'new'}
        title={first ? 'PIN\'ni takrorlang' : 'Yangi 4 xonali PIN'}
        subtitle="Bu PIN faqat shu telefonda ilovani ochish uchun"
        error={err}
        onComplete={async (pin) => {
          if (!first) { setFirst(pin); setErr(''); return; }
          if (pin !== first) { setFirst(null); setErr('PIN\'lar mos kelmadi. Qaytadan kiriting.'); return; }
          await lock.setPin(pin);
          onDone();
        }}
      />
      <Pressable onPress={onCancel} style={[s.btnGhost, { marginTop: 8 }]}><Text style={s.btnGhostText}>Bekor qilish</Text></Pressable>
    </View>
  );
}
