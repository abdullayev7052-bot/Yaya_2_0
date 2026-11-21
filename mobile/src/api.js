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

// One attempt at an HTTP call. Throws an err with `.status` for a real HTTP
// response (4xx/5xx), or an err with `.offline = true` for a dropped / timed-out
// connection (the field conditions that show up server-side as "499 — client
// closed the request before the server could respond").
async function callOnce(method, path, body, timeoutMs, token = null, extraHeaders = null) {
  const session = token ? { token } : getSession();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(getServerUrl() + path, {
      method,
      signal: ctrl.signal,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(session ? { Authorization: `Bearer ${session.token}` } : {}), ...(extraHeaders ?? {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const raw = await res.json().then((d) => ({ d }), () => null);
    // A successful reply that is not JSON (a proxy / maintenance page, a cut-off body)
    // is a failed call — never treat it as an empty answer and overwrite good data.
    if (res.ok && !raw) { const bad = new Error('Server javobi noto\'g\'ri'); bad.offline = true; throw bad; }
    const data = raw?.d ?? {};
    if (!res.ok) {
      const err = new Error(data.error || `Server xatosi (${res.status})`);
      err.status = res.status;
      // Account switched off or this phone was removed from its device slots.
      if (res.status === 401 && session && !token && !path.endsWith('/login')) logout(err.message);
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

// Collectors work on patchy mobile networks that drop a connection mid-request
// even where coverage looks fine; the server then logs a 499 and answers in a
// millisecond, but the phone saw nothing. So a request that failed only because
// the connection dropped (`.offline`) is retried a few times with a short
// back-off. Only safe-to-repeat calls retry: every GET, and any call the caller
// marks `idempotent` (the sync endpoint keys off client-generated UUIDs, so a
// re-send can never double-count). A real HTTP error (4xx/5xx) never retries.
async function call(method, path, body, { timeoutMs = 15000, idempotent = false, token = null, headers = null } = {}) {
  const retries = method === 'GET' || idempotent ? 2 : 0;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 700 * attempt)); // 0.7s, 1.4s
    try {
      return await callOnce(method, path, body, timeoutMs, token, headers);
    } catch (e) {
      if (!e.offline) throw e; // a real server answer (4xx/5xx/401) — do not retry
      lastErr = e;
    }
  }
  throw lastErr;
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
  if (token && !reason && !getSession()?.kiosk) releaseDeviceSlot(token);
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
// Warehouse (Yaya 2.0). Pass { idempotent: true } for document posts that carry a uuid.
export const erp = (method, path, body, opts) => call(method, '/api/erp' + path, body, opts);
export const salesApi = (method, path, body, opts) => call(method, '/api/erp/sales' + path, body, opts);
export const finApi = (method, path, body, opts) => call(method, '/api/erp/finance' + path, body, opts);
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
  // Keep the last good copy unless this answer is complete: an empty/partial reply
  // must never wipe the households list (the collector would see nobody).
  if (!r?.user?.permissions || !Array.isArray(r.suppliers) || !Array.isArray(r.products)) {
    const bad = new Error('Server javobi to\'liq emas'); bad.offline = true; throw bad;
  }
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

// ---------------------------------------------------------------- shared monoblock (stage 7)
// The monoblock is paired once with a code from the panel and keeps its own secret.
// People then pick their name and type their 4-digit PIN; the session is theirs
// until they switch or the idle timer brings the name list back.
export const getKiosk = () => store.getKv('kiosk');
const kioskHeaders = () => ({ 'x-kiosk-token': getKiosk()?.token ?? '' });
export async function pairKiosk(code) {
  const r = await call('POST', '/api/kiosk/pair', { code });
  store.setKv('kiosk', { token: r.token, ...r.kiosk });
  return r.kiosk;
}
export function leaveKiosk() {
  store.setKv('kiosk', null);
  logout();
}
export async function kioskStaff() {
  const r = await call('GET', '/api/kiosk/staff', null, { headers: kioskHeaders() });
  store.setKv('kiosk', { ...getKiosk(), ...r.kiosk });
  store.setKv('kioskStaff', r.staff);
  return r;
}
export const cachedKioskStaff = () => store.getKv('kioskStaff', []);
export const kioskAlerts = () => call('GET', '/api/kiosk/alerts', null, { headers: kioskHeaders() });
export async function kioskLogin(userId, pin) {
  const r = await call('POST', '/api/kiosk/login', { userId, pin }, { headers: kioskHeaders() });
  // No "owner" switch here: several people share this screen by design.
  store.setKv('session', { token: r.token, user: r.user, kiosk: true });
  store.setKv('logoutReason', null);
  try { await refreshBootstrap(); } catch { /* offline */ }
  sessionListeners.forEach((fn) => fn(getSession()));
  return r.user;
}
export const setMyPin = (pin, password) => call('PUT', '/api/kiosk/my-pin', { pin, password });

// ---------------------------------------------------------------- offline outbox (stage 7)
// Documents that carry their own uuid (sales, returns, payments, hand-overs,
// write-offs, accept/reject, cash hand-over) are safe to send again, so with no
// internet they wait here and go out by themselves when the connection is back.
// Each item keeps the token of the person who made it: on a shared monoblock it is
// never sent under someone else's name. A refusal from the server (e.g. not enough
// stock any more) moves it to the "not sent" list for the person to see.
const outboxListeners = new Set();
export const onOutbox = (fn) => { outboxListeners.add(fn); return () => outboxListeners.delete(fn); };
const outboxEmit = () => outboxListeners.forEach((fn) => fn());
export const getOutbox = () => store.getKv('outbox', []);
export const getOutboxFailed = () => store.getKv('outboxFailed', []);
export const dropFailed = (id) => { store.setKv('outboxFailed', getOutboxFailed().filter((x) => x.id !== id)); outboxEmit(); };

export async function send(method, path, body, label) {
  try {
    return await call(method, path, body, { idempotent: true });
  } catch (e) {
    if (!e.offline) throw e;
    const s0 = getSession();
    store.setKv('outbox', [...getOutbox(), { id: randomUUID(), method, path, body, label, token: s0?.token, user: s0?.user?.name ?? s0?.user?.login, at: new Date().toISOString() }]);
    outboxEmit();
    return { queued: true };
  }
}

let flushing = null;
export function flushOutbox() {
  if (flushing) return flushing;
  flushing = (async () => {
    for (;;) {
      const [item] = getOutbox();
      if (!item) break;
      try {
        await call(item.method, item.path, item.body, { idempotent: true, token: item.token, timeoutMs: 20000 });
      } catch (e) {
        if (e.offline) break; // still no connection: try again later, keep the order
        store.setKv('outboxFailed', [...getOutboxFailed(), { ...item, error: e.message }]);
      }
      store.setKv('outbox', getOutbox().filter((x) => x.id !== item.id));
      outboxEmit();
    }
  })().finally(() => { flushing = null; });
  return flushing;
}

// Reads that keep working offline: the last answer is kept per person and path.
export async function cachedGet(path) {
  const key = `cache:${getSession()?.user?.id ?? 0}:${path}`;
  try {
    const d = await call('GET', path);
    store.setKv(key, d);
    return d;
  } catch (e) {
    if (!e.offline) throw e;
    const d = store.getKv(key);
    if (d == null) throw e;
    return d;
  }
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
    flushOutbox();
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
        }, { timeoutMs: 30000, idempotent: true });
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
