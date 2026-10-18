import Constants from 'expo-constants';
import NetInfo from '@react-native-community/netinfo';
import { randomUUID } from 'expo-crypto';
import { AppState, Platform } from 'react-native';
import * as store from './db';

// In the browser tester the app is served by the same server it talks to.
const DEFAULT_URL = Platform.OS === 'web' ? globalThis.location?.origin ?? '' : Constants.expoConfig?.extra?.apiUrl ?? '';

export const getServerUrl = () => store.getKv('serverUrl', DEFAULT_URL);
export const setServerUrl = (url) => store.setKv('serverUrl', url.trim().replace(/\/+$/, ''));

// session: { token, user: { id, login, name, role, permissions } }
// Old sessions (separate collector / manager logins) are dropped: everyone logs in again once.
export const getSession = () => {
  const s = store.getKv('session');
  return s?.user?.permissions ? s : null;
};

// A stable id for this phone. The server ties each account to a limited number of devices.
export function deviceId() {
  let id = store.getKv('deviceId');
  if (!id) {
    id = `${Platform.OS}-${randomUUID()}`;
    store.setKv('deviceId', id);
  }
  return id;
}
const deviceLabel = () => {
  const name = Constants.deviceName || (Platform.OS === 'web' ? 'Brauzer' : 'Telefon');
  return `${name} (${Platform.OS === 'ios' ? 'iOS' : Platform.OS === 'android' ? 'Android' : 'Web'})`.slice(0, 100);
};

async function call(method, path, body, { timeoutMs = 15000 } = {}) {
  const session = getSession();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(getServerUrl() + path, {
      method,
      signal: ctrl.signal,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(session ? { Authorization: `Bearer ${session.token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Server xatosi (${res.status})`);
      err.status = res.status;
      // Account switched off or this phone was removed from its device slots.
      if (res.status === 401 && session && !path.endsWith('/login')) logout(err.message);
      throw err;
    }
    return data;
  } catch (e) {
    if (e.name === 'AbortError' || e.message === 'Network request failed' || e.message === 'Failed to fetch') {
      const err = new Error('Internet yo\'q yoki server javob bermadi');
      err.offline = true;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------- branding
// The logo is cached as a data URI so it shows even with no network.
export const getBrand = () => store.getKv('brand', { companyName: '', version: '', greeting: '', logo: null, intro: null });
const toDataUri = async (url) => {
  const blob = await (await fetch(url)).blob();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
};
export async function refreshBrand(knownVersion) {
  const cur = getBrand();
  if (knownVersion && cur.version === String(knownVersion)) return cur;
  try {
    const b = await call('GET', '/api/public/brand');
    const logo = b.logoUrl ? await toDataUri(getServerUrl() + b.logoUrl) : null;
    // The intro video is streamed from the server (not cached: it can be large).
    const next = {
      companyName: b.companyName,
      greeting: b.greeting ?? '',
      version: String(b.version),
      logo,
      intro: b.introUrl ? getServerUrl() + b.introUrl : null,
    };
    store.setKv('brand', next);
    return next;
  } catch {
    return cur;
  }
}

// ---------------------------------------------------------------- session
// One login for everybody. The server knows the person's role and the app
// opens only the sections their permissions allow.
export async function login(loginName, password) {
  const r = await call('POST', '/api/auth/login', {
    login: loginName.trim(), password, deviceId: deviceId(), deviceLabel: deviceLabel(), client: 'app',
  });
  const owner = store.getKv('owner');
  if (owner != null && owner !== r.user.id) {
    // Never upload one person's unsent work under another person's name.
    if (store.unsyncedCount()) {
      throw new Error('Bu telefonda avvalgi foydalanuvchining yuborilmagan yozuvlari bor. Avval o\'sha hisob bilan kirib, internetga ulaning.');
    }
    store.wipeLocal();
  }
  store.setKv('owner', r.user.id);
  store.setKv('session', { token: r.token, user: r.user });
  store.setKv('logoutReason', null);
  try { await refreshBootstrap(); } catch { /* works offline after the first login */ }
  return r.user;
}

const sessionListeners = new Set();
export const onSession = (fn) => { sessionListeners.add(fn); return () => sessionListeners.delete(fn); };

export function logout(reason) {
  store.setKv('session', null);
  store.setKv('bootstrap', null);
  if (reason) store.setKv('logoutReason', reason);
  sessionListeners.forEach((fn) => fn(null));
}
export const takeLogoutReason = () => {
  const r = store.getKv('logoutReason');
  store.setKv('logoutReason', null);
  return r;
};

export const me = () => store.getKv('bootstrap')?.user ?? getSession()?.user ?? null;
export const can = (perm) => !!me()?.permissions?.includes(perm);
export const canAny = (...perms) => perms.some(can);

export const admin = (method, path, body) => call(method, '/api/admin' + path, body);
export const mobile = (method, path, body) => call(method, '/api/mobile' + path, body);
export const changePassword = (current, next) => call('PUT', '/api/auth/password', { current, next });
// Change own name/login (admins). Updates the cached session so the UI follows.
export async function changeProfile({ name, login }) {
  const r = await call('PUT', '/api/auth/profile', { name, login });
  const sx = getSession();
  if (sx && r.user) store.setKv('session', { ...sx, user: { ...sx.user, ...r.user } });
  return r.user;
}

// ---------------------------------------------------------------- field data
// Suppliers list is cached on the phone so the app works with no network at all.
const boot = () => store.getKv('bootstrap', {});
export const getSuppliers = () => boot().suppliers ?? [];
export const getProducts = () => boot().products ?? [];
export const serverShifts = () => boot().shifts ?? [];
export const shiftInfo = (uuid) => serverShifts().find((s) => s.uuid === uuid) ?? (boot().openShift?.uuid === uuid ? boot().openShift : null);

// Why a new shift cannot be opened right now, or null if it can.
export function shiftBlock() {
  const after = ' Omborchi yoki rahbar qabul qilgandan (yoki bekor qilgandan) keyin yangi smena ochiladi.';
  for (const s of store.allShifts()) {
    if (s.error) continue;
    if (!s.closed_at) return { shift: s, text: 'Ochiq smena bor' };
    // Closed here but not uploaded yet: it certainly still waits for acceptance.
    if (s.dirty) return { shift: s, text: `Yopilgan smena hali serverga yuborilmagan.${after}` };
  }
  const waiting = serverShifts().find((s) => s.status === 'closed' || s.status === 'open');
  if (waiting) return { text: `${waiting.label} smena hali ${waiting.status === 'open' ? 'ochiq' : 'qabul qilinmagan'}.${after}` };
  return null;
}

export async function refreshBootstrap() {
  const r = await call('GET', '/api/mobile/bootstrap');
  store.setKv('bootstrap', r);
  const s = getSession();
  if (s) store.setKv('session', { ...s, user: { ...s.user, ...r.user } });
  // A copy of a cancelled shift made on the server becomes the open shift here.
  if (r.openShift && !store.getOpenShift()) store.adoptShift(r.openShift);
  refreshBrand(r.brand?.version);
  return r;
}
export const history = () => call('GET', '/api/mobile/history');

// ---------------------------------------------------------------- background sync
const listeners = new Set();
export function onSyncState(fn) { listeners.add(fn); return () => listeners.delete(fn); }

let state = { online: true, syncing: false, lastSync: store.getKv('lastSync'), lastError: null };
const emit = (patch) => { state = { ...state, ...patch }; listeners.forEach((fn) => fn(state)); };
export const getSyncState = () => state;

let inFlight = null;
export function syncNow() {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    if (!getSession()) return;
    emit({ syncing: true });
    try {
      // Upload in batches until the queue is empty.
      for (let i = 0; i < 50; i++) {
        const p = store.pendingUpload();
        if (!p.shifts.length && !p.collections.length && !p.ops.length && !p.payments.length) break;
        const r = await call('POST', '/api/mobile/sync', {
          shifts: p.shifts.map((s) => ({ uuid: s.uuid, openedAt: s.opened_at, closedAt: s.closed_at })),
          collections: p.collections.map((c) => ({ uuid: c.uuid, shiftUuid: c.shift_uuid, supplierId: c.supplier_id,
            productId: c.product_id, quantity: c.quantity, collectedAt: c.collected_at })),
          ops: p.ops.map((o) => ({ uuid: o.uuid, type: o.type, target: o.target, ...(o.quantity != null ? { quantity: o.quantity } : {}),
            ...(o.product_id != null ? { productId: o.product_id } : {}) })),
          payments: p.payments.map((x) => ({ uuid: x.uuid, supplierId: x.supplier_id, amount: x.amount, method: x.method,
            ...(x.note ? { note: x.note } : {}), paidAt: x.paid_at })),
        }, { timeoutMs: 30000 });
        store.markUploaded(p.shifts, r);
      }
      await refreshBootstrap();
      store.pruneOld();
      const now = new Date().toISOString();
      store.setKv('lastSync', now);
      emit({ syncing: false, online: true, lastSync: now, lastError: null });
    } catch (err) {
      emit({ syncing: false, lastError: err.message, ...(err.offline ? { online: false } : {}) });
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

let started = false;
export function startAutoSync() {
  if (started) { syncNow(); return; }
  started = true;
  NetInfo.addEventListener((s) => {
    const online = !!s.isConnected && s.isInternetReachable !== false;
    emit({ online });
    if (online) syncNow();
  });
  AppState.addEventListener('change', (s) => { if (s === 'active') syncNow(); });
  setInterval(syncNow, 30000);
  syncNow();
}
