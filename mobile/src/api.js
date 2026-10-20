import Constants from 'expo-constants';
import NetInfo from '@react-native-community/netinfo';
import { randomUUID } from 'expo-crypto';
import { AppState, Platform } from 'react-native';
import * as store from './db';
import { setTheme } from './ui';

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
    // A real HTTP response error carries a status; anything else is a network /
    // timeout / DNS failure (e.g. java.net.* on Android) → one plain message.
    if (e.status) throw e;
    const err = new Error('Internet yo\'q yoki server javob bermadi');
    err.offline = true;
    throw err;
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------- branding
// The logo is cached as a data URI so it shows even with no network.
const DEFAULT_LIST_FIELDS = { name: true, address: true, phone: true };
export const getBrand = () => store.getKv('brand', { companyName: '', version: '', greeting: '', logo: null, intro: null, locationEnabled: true, locationPin: true, listFields: DEFAULT_LIST_FIELDS });
// Which fields the admin lets the shift household list show.
export const listFields = () => ({ ...DEFAULT_LIST_FIELDS, ...(getBrand().listFields || {}) });
// Admin switches: whether the app uses location at all, and whether the little
// route pin shows in the shift list. Default on when the server hasn't said.
export const locationEnabled = () => getBrand().locationEnabled !== false;
// Whether the "Bekor qilish" feature is on (admin can switch it off).
export const cancelEnabled = () => getBrand().cancelEnabled !== false;
// Whether a given action still asks "are you sure?" (admin can switch each off).
export const confirmOn = (action) => (getBrand().confirms || {})[action] !== false;
// Whether editing a closed-but-not-accepted shift is allowed (admin setting).
export const editClosedEnabled = () => getBrand().editClosed !== false;
const toDataUri = async (url) => {
  const blob = await (await fetch(url)).blob();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
};

// The entry video plays from a cached data URI (exactly like the logo), not by
// streaming the remote URL — remote video streaming proved unreliable on the
// phone. Kept in its own key so it never bloats the frequently-read brand object.
export function getCachedIntro() {
  const b = getBrand();
  if (!b.intro) return null;
  const c = store.getKv('introData');
  return c && c.version === b.version && c.uri ? c.uri : null;
}
export function getIntroSrc() {
  return getCachedIntro() || getBrand().intro || null; // cached data URI, else remote
}
async function cacheIntro(version, url) {
  try {
    const cur = store.getKv('introData');
    if (cur && cur.version === version && cur.uri) return; // already cached
    const uri = await toDataUri(url);
    // data: URIs over ~12 MB are impractical; above that stay with the remote URL.
    store.setKv('introData', { version, uri: uri && uri.length < 12 * 1024 * 1024 ? uri : null });
  } catch { /* keep the remote URL as the fallback */ }
}

export async function refreshBrand(knownVersion) {
  const cur = getBrand();
  if (knownVersion && cur.version === String(knownVersion)) {
    if (cur.intro) cacheIntro(cur.version, cur.intro); // make sure it is cached
    return cur;
  }
  try {
    const b = await call('GET', '/api/public/brand');
    const logo = b.logoUrl ? await toDataUri(getServerUrl() + b.logoUrl) : null;
    const next = {
      companyName: b.companyName,
      greeting: b.greeting ?? '',
      version: String(b.version),
      logo,
      intro: b.introUrl ? getServerUrl() + b.introUrl : null,
      locationEnabled: b.locationEnabled !== false,
      cancelEnabled: b.cancelEnabled !== false,
      listFields: { ...DEFAULT_LIST_FIELDS, ...(b.listFields || {}) },
      confirms: b.confirms || {},
      editClosed: b.editClosed !== false,
    };
    store.setKv('brand', next);
    // Download the video into the cache (fire and forget) so the splash plays it locally.
    if (next.intro) cacheIntro(next.version, next.intro);
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

// Best-effort: tell the server to release this phone's device slot so the
// person can sign back in from the same (or a replaced) phone with no admin.
// Uses the token directly, since the session is cleared right after.
function releaseDeviceSlot(token) {
  if (!token) return;
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 8000);
  fetch(getServerUrl() + '/api/auth/logout', {
    method: 'POST', signal: ctrl.signal,
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => { /* offline: the same phone can still sign back in (its slot stays its own) */ });
}

export function logout(reason) {
  const token = getSession()?.token;
  // Only a deliberate sign-out frees the slot. A forced logout (revoked/expired
  // token, reason set) would fail the call anyway and must not race.
  if (token && !reason) releaseDeviceSlot(token);
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

// Night mode is per-user and stored on this phone. Default: light.
const themeKey = () => `theme:${getSession()?.user?.id ?? 'none'}`;
export const getThemePref = () => store.getKv(themeKey(), 'light');
export function setThemePref(mode) {
  store.setKv(themeKey(), mode);
  setTheme(mode);
}
export const applySavedTheme = () => setTheme(getThemePref());

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

// Why a new shift cannot be opened yet, or null if it can. A shift number blocks
// until it is accepted: while it is open/closed (waiting), or cancelled and not
// yet replaced by an accepted copy. kind: 'waiting' | 'cancelled'.
export function shiftBlock() {
  // A shift closed on this phone but not uploaded is certainly still waiting.
  const localPending = store.allShifts().find((x) => x.closed_at && x.dirty && !x.error);
  if (localPending) return { kind: 'waiting', label: shiftInfo(localPending.uuid)?.label };
  const byNumber = {};
  for (const sh of serverShifts()) (byNumber[sh.number] ||= []).push(sh);
  for (const grp of Object.values(byNumber)) {
    if (grp.some((x) => x.status === 'accepted')) continue;
    const active = grp.find((x) => x.status === 'open' || x.status === 'closed');
    if (active) return { kind: 'waiting', label: active.label };
    const canc = grp.find((x) => x.status === 'cancelled');
    if (canc) return { kind: 'cancelled', label: canc.label, reason: canc.cancel_reason };
  }
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

// Reopen a closed-but-not-accepted shift for editing: the server moves it back to
// the editable state and hands it back as the open shift, which we re-adopt.
export async function reopenShiftForEdit(serverId) {
  await call('POST', `/api/mobile/shifts/${serverId}/reopen`);
  const r = await refreshBootstrap();
  if (r.openShift) store.reopenLocalShift(r.openShift);
  return r.openShift;
}

// ---------------------------------------------------------------- background sync
const listeners = new Set();
export function onSyncState(fn) { listeners.add(fn); return () => listeners.delete(fn); }

let state = { online: true, syncing: false, lastSync: store.getKv('lastSync'), lastError: null };
const emit = (patch) => { state = { ...state, ...patch }; listeners.forEach((fn) => fn(state)); };
export const getSyncState = () => state;

let inFlight = null;
let resyncQueued = false;
export function syncNow() {
  // If a sync is already running, remember to run once more right after, so a
  // shift just closed (or any change) is pushed immediately, not at the next tick.
  if (inFlight) { resyncQueued = true; return inFlight; }
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
  inFlight.finally(() => { if (resyncQueued) { resyncQueued = false; syncNow(); } });
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
