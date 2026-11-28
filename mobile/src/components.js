import { useCallback, useEffect, useRef, useState } from 'react';
import { Dimensions, Image, Modal, PanResponder, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { getBrand } from './api';
import * as store from './db';
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

// A row of filter tabs the user can reorder on their own device: long-press any
// tab (~0.6s) to enter arrange mode, then nudge each left/right with ‹ ›. The
// order is the caller's to persist (locally, per device); the first tab is what
// opens by default. `items` is [[key,label],...]; `order` an array of keys.
export function ReorderTabs({ items, order, active, onPick, onReorder }) {
  const [edit, setEdit] = useState(false);
  const ordered = order.filter((k) => items.some((i) => i[0] === k))
    .concat(items.filter((i) => !order.includes(i[0])).map((i) => i[0]));
  const labelOf = (k) => (items.find((i) => i[0] === k) || [k, k])[1];
  const move = (dir) => {
    const arr = [...ordered];
    const i = arr.indexOf(active); const j = i + dir;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    onReorder(arr);
  };
  // A single, never-wrapping row of tabs; long-press any tab to arrange, then
  // move the selected one left/right. Kept to one row so it never balloons.
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: 'row', gap: 6 }}>
        {ordered.map((k) => (
          <Pressable key={k} onPress={() => onPick(k)} onLongPress={() => setEdit(true)} delayLongPress={600}
            style={[s.btnGhost, { flex: 1, paddingHorizontal: 6, paddingVertical: 10 },
              active === k && { backgroundColor: C.accent, borderColor: C.accent }, edit && active !== k && { borderStyle: 'dashed', borderColor: C.accent }]}>
            <Text style={[s.btnGhostText, active === k && { color: C.accentText }]} numberOfLines={1}>{labelOf(k)}</Text>
          </Pressable>
        ))}
      </View>
      {edit && (
        <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
          <Text style={[s.muted, { flex: 1 }]} numberOfLines={1}>«{labelOf(active)}» ni ko'chiring</Text>
          <Pressable onPress={() => move(-1)} style={[s.btnGhost, { paddingHorizontal: 16 }]}><Text style={s.btnGhostText}>◀</Text></Pressable>
          <Pressable onPress={() => move(1)} style={[s.btnGhost, { paddingHorizontal: 16 }]}><Text style={s.btnGhostText}>▶</Text></Pressable>
          <Pressable onPress={() => setEdit(false)} style={[s.btn, { paddingHorizontal: 16, paddingVertical: 10 }]}><Text style={s.btnText}>✓</Text></Pressable>
        </View>
      )}
    </View>
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
// A half-screen list with a search box: pick one item. items: [{ key, label, sub?, on? }].
export function PickSheet({ visible, title, items, onPick, onClose, placeholder = '🔍  Qidirish' }) {
  const [q, setQ] = useState('');
  useEffect(() => { if (visible) setQ(''); }, [visible]);
  const n = q.trim().toLowerCase();
  const list = n ? items.filter((x) => `${x.label} ${x.sub ?? ''}`.toLowerCase().includes(n)) : items;
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' }} onPress={onClose} />
      <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '60%', minHeight: '45%', backgroundColor: C.card,
        borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 14, gap: 10 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Text style={[s.h2, { flex: 1 }]}>{title}</Text>
          <Pressable onPress={onClose} hitSlop={12}><Text style={{ fontSize: 20, color: C.muted }}>✕</Text></Pressable>
        </View>
        {items.length > 5 && <SearchBar value={q} onChange={setQ} placeholder={placeholder} />}
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 6, paddingBottom: 10 }}>
          {list.map((x) => (
            <Pressable key={x.key} onPress={() => onPick(x)}
              style={({ pressed }) => [{ padding: 12, borderRadius: 12, borderWidth: 1, borderColor: x.on ? C.accent : C.line, backgroundColor: x.on ? C.accent : C.bg }, pressed && { opacity: 0.6 }]}>
              <Text style={[s.text, { fontWeight: '600', color: x.on ? C.accentText : C.text }]}>{x.label}</Text>
              {!!x.sub && <Text style={{ color: x.on ? C.accentText : C.muted }}>{x.sub}</Text>}
            </Pressable>
          ))}
          {!list.length && <Text style={s.muted}>Topilmadi</Text>}
        </ScrollView>
      </View>
    </Modal>
  );
}

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

// ---------------------------------------------------------------- monoblock number keys
// On the shared monoblock (a touch screen, no keyboard) a column of big number keys
// sits in the bottom-right corner while a number field is focused, so people can
// type quantities (with a decimal point) without covering the rest of the screen.
// A number field joins with kioskField(value, onChange).
let kTarget = null; // { value, onChange }
const kListeners = new Set();
const kNotify = () => kListeners.forEach((fn) => fn(kTarget));
// Settings on this monoblock (Profile → "Raqamli klaviatura" and the keypad itself):
// on / off, the key size (w = key width in px) and where it sits (x, y; null = the
// bottom-right corner).
export const KEY_SIZES = { s: ['Kichik', 52], m: ["O'rta", 66], l: ['Katta', 84] };
const KEY_MIN = 40;
const KEY_MAX = 120;
export const getKeysCfg = () => {
  const c = { on: true, size: 'm', x: null, y: null, ...(store.getKv('kioskKeys') ?? {}) };
  return { ...c, w: Math.min(KEY_MAX, Math.max(KEY_MIN, Number(c.w) || (KEY_SIZES[c.size] ?? KEY_SIZES.m)[1])) };
};
export function setKeysCfg(patch) {
  // choosing a named size (Profile) sets the key width too
  const extra = patch.size && KEY_SIZES[patch.size] ? { w: KEY_SIZES[patch.size][1] } : {};
  store.setKv('kioskKeys', { ...getKeysCfg(), ...patch, ...extra });
  kNotify();
}
export function kioskField(value, onChange) {
  return {
    onFocus: () => { kTarget = { value: String(value ?? ''), onChange }; kNotify(); },
    onChangeText: (v) => { if (kTarget?.onChange === onChange) kTarget.value = v; onChange(v); },
  };
}
// The usual 4 × 3 number pad, in rows: 1 2 3 / 4 5 6 / 7 8 9 / , 0 ⌫.
const KROWS = [['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9'], [',', '0', '⌫']];
export function KioskKeys() {
  const [target, setTarget] = useState(kTarget);
  const [, bump] = useState(0);
  const [drag, setDrag] = useState(null); // live position while being moved
  const box = useRef({ w: 0, h: 0 });
  const start = useRef(null);
  useEffect(() => { const fn = (t) => { setTarget(t); bump((n) => n + 1); }; kListeners.add(fn); return () => kListeners.delete(fn); }, []);
  const cfg = getKeysCfg();
  const win = Dimensions.get('window');
  const gap = Math.max(4, Math.round(cfg.w * 0.09));
  const keyH = Math.round(cfg.w * 0.82);
  const width = cfg.w * 3 + gap * 2 + 16; // keys + gaps + padding and border
  const clamp = (x, y) => ({
    x: Math.min(Math.max(0, x), Math.max(0, win.width - (box.current.w || width))),
    y: Math.min(Math.max(0, y), Math.max(0, win.height - (box.current.h || 300))),
  });
  const pos = drag ?? (cfg.x == null || cfg.y == null ? null : clamp(cfg.x, cfg.y));
  // Moving: hold the top bar and drag. The place is kept for this monoblock.
  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: () => {
      const c = getKeysCfg(); const w2 = Dimensions.get('window');
      start.current = { x: c.x ?? w2.width - box.current.w - 10, y: c.y ?? w2.height - box.current.h - 10 };
    },
    onPanResponderMove: (_e, g) => setDrag(clamp(start.current.x + g.dx, start.current.y + g.dy)),
    onPanResponderRelease: (_e, g) => { const p = clamp(start.current.x + g.dx, start.current.y + g.dy); setKeysCfg(p); setDrag(null); },
    onPanResponderTerminate: () => setDrag(null),
  })).current;
  if (!target || !cfg.on) return null;
  const press = (k) => {
    let v = kTarget.value;
    if (k === '⌫') v = v.slice(0, -1);
    else if (k === ',') { if (!v.includes(',') && !v.includes('.')) v = (v || '0') + ','; }
    else v = v === '0' ? k : v + k;
    kTarget.value = v;
    kTarget.onChange(v);
  };
  const resize = (d) => setKeysCfg({ w: Math.min(KEY_MAX, Math.max(KEY_MIN, cfg.w + d)), size: null });
  const small = { minWidth: 40, height: 34, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: C.bg, borderWidth: 1, borderColor: C.line };
  return (
    <View onLayout={(e) => { box.current = { w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height }; }}
      style={[{ position: 'absolute', width, padding: 7, gap, borderRadius: 16, backgroundColor: C.card, borderWidth: 1, borderColor: C.line,
        shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 12, elevation: 10 }, pos ? { left: pos.x, top: pos.y } : { right: 10, bottom: 10 }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <View {...pan.panHandlers} style={[small, { flex: 1, ...(Platform.OS === 'web' ? { cursor: 'move' } : {}) }]}>
          <Text numberOfLines={1} style={{ color: C.muted, fontWeight: '700', fontSize: 18, letterSpacing: 2 }}>⠿⠿⠿</Text>
        </View>
        <Pressable onPress={() => resize(-8)} style={small}><Text style={{ fontSize: 20, fontWeight: '700', color: C.text }}>−</Text></Pressable>
        <Pressable onPress={() => resize(8)} style={small}><Text style={{ fontSize: 20, fontWeight: '700', color: C.text }}>+</Text></Pressable>
        <Pressable onPress={() => { kTarget = null; kNotify(); }} style={small}><Text style={{ fontSize: 16, fontWeight: '700', color: C.muted }}>✕</Text></Pressable>
      </View>
      {KROWS.map((row) => (
        <View key={row.join('')} style={{ flexDirection: 'row', gap }}>
          {row.map((k) => (
            <Pressable key={k} onPress={() => press(k)} style={({ pressed }) => [{ width: cfg.w, height: keyH, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
              backgroundColor: pressed ? C.line : C.bg, borderWidth: 1, borderColor: C.line }]}>
              <Text style={{ fontSize: Math.round(cfg.w * 0.42), fontWeight: '700', color: C.text }}>{k}</Text>
            </Pressable>
          ))}
        </View>
      ))}
    </View>
  );
}
