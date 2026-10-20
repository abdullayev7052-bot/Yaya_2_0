import { useCallback, useEffect, useRef, useState } from 'react';
import { Image, Modal, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { getBrand } from './api';
import { useBack } from './back';
import { C, fmtTime, s } from './ui';

export const fmtMoney = (n) => (n == null ? '—' : String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' '));

export function Logo({ size = 48 }) {
  const b = getBrand();
  if (b.logo) return <Image source={{ uri: b.logo }} style={{ width: size, height: size }} resizeMode="contain" accessibilityLabel="Logo" />;
  return null;
}

export function Header({ title, onBack, right }) {
  // The phone's own back button mirrors this arrow.
  useBack(onBack, !!onBack);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10, gap: 8 }}>
      {onBack && (
        <Pressable onPress={onBack} hitSlop={16} style={{ paddingRight: 6 }}>
          <Text style={{ fontSize: 28, color: C.muted }}>←</Text>
        </Pressable>
      )}
      <Text style={[s.h2, { flex: 1 }]} numberOfLines={2}>{title}</Text>
      {right}
    </View>
  );
}

export function Tile({ label, value, sub, wide }) {
  return (
    <View style={[s.card, { flexBasis: wide ? '100%' : '47%', flexGrow: 1, padding: 12 }]}>
      <Text style={s.muted}>{label}</Text>
      <Text style={{ fontSize: 26, fontWeight: '700', color: C.text }} adjustsFontSizeToFit numberOfLines={1}>{value}</Text>
      {!!sub && <Text style={{ fontSize: 13, color: C.muted }}>{sub}</Text>}
    </View>
  );
}

const STATUS = {
  open: ['Ochiq', C.warn], editing: ['Tahrir', C.warn], closed: ['Qabul kutmoqda', C.warn], accepted: ['Qabul qilingan', C.ok], cancelled: ['Bekor qilingan', C.err],
};
export function ShiftBadge({ status }) {
  const [t, color] = STATUS[status] ?? [status, C.muted];
  return (
    <View style={{ borderWidth: 1, borderColor: color, borderRadius: 99, paddingHorizontal: 8, paddingVertical: 2, alignSelf: 'flex-start' }}>
      <Text style={{ color, fontSize: 13, fontWeight: '600' }}>{t}</Text>
    </View>
  );
}

export function Chip({ label, on, onPress }) {
  return (
    <Pressable onPress={onPress} style={[s.btnGhost, { flexGrow: 1, paddingHorizontal: 14, paddingVertical: 10 }, on && { backgroundColor: C.accent, borderColor: C.accent }]}>
      <Text style={[s.btnGhostText, on && { color: C.accentText }]}>{label}</Text>
    </Pressable>
  );
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', ',', '0', '⌫'];

/**
 * Big on-screen number pad. value is a string with ',' as decimal separator.
 * decimals=0 hides the comma key (money). Laptop keyboard works in the browser tester.
 */
export function Keypad({ value, onChange, onSubmit, onCancel, decimals = 2, maxDigits = 6 }) {
  const press = (k) => {
    let next = value;
    if (k === '⌫') next = value.slice(0, -1);
    else if (k === ',') { if (decimals && !value.includes(',')) next = (value || '0') + ','; }
    else if (value === '0') next = k;
    else if (new RegExp(`,\\d{${decimals}}$`).test(value) || value.replace(',', '').length >= maxDigits) return;
    else next = value + k;
    onChange(next);
  };
  const handler = useRef(null);
  handler.current = (e) => {
    if (/^\d$/.test(e.key)) press(e.key);
    else if (e.key === ',' || e.key === '.') press(',');
    else if (e.key === 'Backspace') press('⌫');
    else if (e.key === 'Enter') onSubmit?.();
    else if (e.key === 'Escape') onCancel?.();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  useEffect(() => {
    if (Platform.OS !== 'web') return undefined;
    const onKey = (e) => {
      if (e.target?.tagName === 'INPUT' || e.target?.tagName === 'TEXTAREA') return;
      handler.current?.(e);
    };
    // Capture phase: a focused button (e.g. a product chip) must not swallow Enter.
    globalThis.addEventListener('keydown', onKey, true);
    return () => globalThis.removeEventListener('keydown', onKey, true);
  }, []);
  return (
    <View style={{ flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {KEYS.map((k) => (k === ',' && !decimals ? <View key={k} style={{ width: '31.5%', flexGrow: 1 }} /> : (
        <Pressable key={k} onPress={() => press(k)}
          style={({ pressed }) => [s.card, { width: '31.5%', flexGrow: 1, alignItems: 'center', justifyContent: 'center',
            padding: 0, minHeight: 60 }, pressed && { backgroundColor: C.line }]}>
          <Text style={{ fontSize: 30, fontWeight: '600', color: C.text }}>{k}</Text>
        </Pressable>
      )))}
    </View>
  );
}

export const toNumber = (v) => Number(String(v).replace(',', '.'));
export const digitsOf = (v) => String(v ?? '').replace(/\D/g, '');

// Smart text key for search: lower-case, treat "x" and "h" as the same letter,
// and drop apostrophes/accents. So "Hurmo" finds "Xurmo" and "Ozbek" finds "O'zbek".
export const normText = (s) => String(s ?? '').toLowerCase()
  .replace(/['‘’ʻʼ`´]/g, '')
  .replace(/x/g, 'h');
export const textMatch = (haystack, query) => normText(haystack).includes(normText(query));

// Search by name, address or phone digits ("93 111" finds 931112233).
export function matches(item, query) {
  const q = normText(query.trim());
  if (!q) return true;
  const d = digitsOf(query);
  return normText(item.name).includes(q) || normText(item.address).includes(q)
    || (d.length >= 2 && digitsOf(item.phone).includes(d));
}

// ---- dates (Tashkent business day = UTC+5) ----
export const todayLocal = () => new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);
export const addDays = (day, n) => new Date(Date.parse(day) + n * 864e5).toISOString().slice(0, 10);
export const fmtDay = (d) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
export const fmtDT = (iso) => {
  if (!iso) return '';
  const d = new Date(/Z|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso.replace(' ', 'T')}Z`);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} ${fmtTime(d.toISOString())}`;
};
export const METHOD = { cash: 'Naqd', card: 'Karta', transfer: 'O\'tkazma' };

// Loads data and keeps error/refresh state in one place.
export function useLoad(fn, deps) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setBusy(true);
    setErr('');
    try { setData(await fn()); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { load(); }, [load]);
  return { data, err, busy, load, setData };
}

export const Err = ({ err }) => (err ? <Text style={[s.err, { padding: 12 }]}>{err}</Text> : null);

// A search field with a built-in clear "✕" on the right. `right` adds a button
// (e.g. "+") next to it.
export function SearchBar({ value, onChange, placeholder = '🔍  Ism yoki telefon raqam', right }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <View style={{ flex: 1, justifyContent: 'center' }}>
        <TextInput style={[s.input, { paddingRight: 38 }]} value={value} onChangeText={onChange}
          placeholder={placeholder} placeholderTextColor={C.muted} autoCorrect={false} />
        {!!value && (
          <Pressable onPress={() => onChange('')} hitSlop={12}
            style={{ position: 'absolute', right: 6, width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ fontSize: 17, color: C.muted }}>✕</Text>
          </Pressable>
        )}
      </View>
      {right}
    </View>
  );
}

export function DayPicker({ day, onChange }) {
  const today = todayLocal();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Pressable style={[s.btnGhost, { paddingHorizontal: 18 }]} onPress={() => onChange(addDays(day, -1))}><Text style={s.btnGhostText}>‹</Text></Pressable>
      <Pressable style={{ flex: 1 }} onPress={() => onChange(today)}>
        <Text style={[s.h2, { textAlign: 'center' }]}>{day === today ? `Bugun, ${fmtDay(day)}` : fmtDay(day)}</Text>
      </Pressable>
      <Pressable style={[s.btnGhost, { paddingHorizontal: 18 }, day >= today && { opacity: 0.3 }]} disabled={day >= today}
        onPress={() => onChange(addDays(day, 1))}><Text style={s.btnGhostText}>›</Text></Pressable>
    </View>
  );
}

// ---- calendar (pick one day or a range) ----
const MONTHS = ['Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun', 'Iyul', 'Avgust', 'Sentabr', 'Oktabr', 'Noyabr', 'Dekabr'];
const WEEKDAYS = ['Du', 'Se', 'Ch', 'Pa', 'Ju', 'Sh', 'Ya'];
const ym = (day) => day.slice(0, 7);
const shiftMonth = (m, n) => {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

// A plain month grid. Tap one day for a single day, a second day to make a range;
// a further tap starts over. Future days are disabled. Apply confirms {from,to}.
export function CalendarModal({ visible, from, to, onClose, onApply }) {
  const today = todayLocal();
  const [month, setMonth] = useState(() => ym(from || today));
  const [a, setA] = useState(from || today);
  const [b, setB] = useState(to || from || today);
  useEffect(() => {
    if (!visible) return;
    setA(from || today); setB(to || from || today); setMonth(ym(from || today));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const [Y, M] = month.split('-').map(Number);
  const startWd = (new Date(Date.UTC(Y, M - 1, 1)).getUTCDay() + 6) % 7; // Mon = 0
  const daysIn = new Date(Date.UTC(Y, M, 0)).getUTCDate();
  const cells = [...Array(startWd).fill(null), ...Array.from({ length: daysIn }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`)];
  const lo = a <= b ? a : b;
  const hi = a <= b ? b : a;

  const tap = (day) => {
    if (day > today) return;
    if (a === b) { // a single day is selected → the next tap makes a range
      if (day === a) return;
      setA(a); setB(day);
    } else { setA(day); setB(day); } // a range exists → start over with one day
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable onPress={onClose} style={{ flex: 1, backgroundColor: '#0008', justifyContent: 'center', padding: 16 }}>
        <Pressable onPress={() => {}} style={[s.card, { gap: 10, padding: 14 }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Pressable onPress={() => setMonth(shiftMonth(month, -1))} hitSlop={12} style={{ padding: 6 }}><Text style={{ fontSize: 24, color: C.accent }}>‹</Text></Pressable>
            <Text style={[s.h2, { flex: 1, textAlign: 'center' }]}>{MONTHS[M - 1]} {Y}</Text>
            <Pressable onPress={() => { if (shiftMonth(month, 1) <= ym(today)) setMonth(shiftMonth(month, 1)); }} hitSlop={12}
              style={{ padding: 6, opacity: shiftMonth(month, 1) <= ym(today) ? 1 : 0.3 }}><Text style={{ fontSize: 24, color: C.accent }}>›</Text></Pressable>
          </View>
          <View style={{ flexDirection: 'row' }}>
            {WEEKDAYS.map((w) => <Text key={w} style={{ flex: 1, textAlign: 'center', color: C.muted, fontSize: 12, fontWeight: '600' }}>{w}</Text>)}
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
            {cells.map((day, i) => {
              if (!day) return <View key={`e${i}`} style={{ width: `${100 / 7}%`, height: 40 }} />;
              const inRange = day >= lo && day <= hi;
              const edge = day === lo || day === hi;
              const future = day > today;
              return (
                <Pressable key={day} onPress={() => tap(day)} disabled={future}
                  style={{ width: `${100 / 7}%`, height: 40, alignItems: 'center', justifyContent: 'center' }}>
                  <View style={{ width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center',
                    backgroundColor: edge ? C.accent : inRange ? C.line : 'transparent' }}>
                    <Text style={{ color: future ? C.muted : edge ? C.accentText : C.text, fontSize: 15, opacity: future ? 0.4 : 1 }}>{Number(day.slice(8))}</Text>
                  </View>
                </Pressable>
              );
            })}
          </View>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
            <Btn title="Bugun" kind="ghost" style={{ flex: 1 }} onPress={() => { setMonth(ym(today)); setA(today); setB(today); }} />
            <Btn title="Tanlash" style={{ flex: 1 }} onPress={() => { onApply({ from: lo, to: hi }); onClose(); }} />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

export function Btn({ title, onPress, kind = 'main', disabled, style }) {
  const ghost = kind !== 'main' && kind !== 'danger';
  return (
    <Pressable onPress={onPress} disabled={disabled}
      style={[ghost ? s.btnGhost : s.btn, kind === 'danger' && { backgroundColor: C.err }, { paddingVertical: 12, paddingHorizontal: 14 },
        disabled && { opacity: 0.4 }, style]}>
      <Text style={[ghost ? s.btnGhostText : [s.btnText, { fontSize: 17 }], kind === 'warn' && { color: C.err }]}>{title}</Text>
    </Pressable>
  );
}
