import { StyleSheet } from 'react-native';

// Two palettes. Each user can turn night mode on or off for themselves; the
// default is light. The theme is applied by swapping the colours in `C` (same
// object, so references stay valid) and rebuilding `s`; the app remounts on
// change so every screen picks up the new styles.
const LIGHT = {
  bg: '#F4F6F5', card: '#FFFFFF', text: '#14201B', muted: '#5E6B66', line: '#DCE3E0',
  accent: '#1F7A5A', accentText: '#FFFFFF', warn: '#B54708', err: '#B42318', ok: '#1F7A5A', placeholder: '#AAB4AF',
};
const DARK = {
  bg: '#0F1412', card: '#1A211E', text: '#ECF1EE', muted: '#9AA8A2', line: '#2B3833',
  accent: '#36A47B', accentText: '#FFFFFF', warn: '#E59248', err: '#F0796F', ok: '#36A47B', placeholder: '#6C7872',
};

export const C = { ...LIGHT };
let dark = false;

export const fmtQty = (n) => {
  const t = Number(n).toFixed(2).replace(/\.?0+$/, '');
  return t.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
};
export const fmtTime = (iso) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const make = (c) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },
  pad: { padding: 16 },
  h1: { fontSize: 26, fontWeight: '700', color: c.text },
  h2: { fontSize: 20, fontWeight: '700', color: c.text },
  text: { fontSize: 17, color: c.text },
  muted: { fontSize: 15, color: c.muted },
  input: { backgroundColor: c.card, borderWidth: 1, borderColor: c.line, borderRadius: 12, paddingHorizontal: 16,
    paddingVertical: 14, fontSize: 20, color: c.text },
  btn: { backgroundColor: c.accent, borderRadius: 14, paddingVertical: 18, alignItems: 'center', justifyContent: 'center' },
  btnText: { color: c.accentText, fontSize: 20, fontWeight: '700' },
  btnGhost: { borderWidth: 1, borderColor: c.line, backgroundColor: c.card, borderRadius: 14, paddingVertical: 14,
    alignItems: 'center' },
  btnGhostText: { color: c.text, fontSize: 17, fontWeight: '600' },
  card: { backgroundColor: c.card, borderRadius: 14, borderWidth: 1, borderColor: c.line, padding: 16 },
  err: { color: c.err, fontSize: 16 },
});

export let s = make(C);

const listeners = new Set();
export const onThemeChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const isDark = () => dark;

// Apply a theme ('dark' | anything else = light). Rebuilds styles and notifies.
export function setTheme(mode) {
  dark = mode === 'dark';
  Object.assign(C, dark ? DARK : LIGHT);
  s = make(C);
  listeners.forEach((fn) => fn(dark));
}
