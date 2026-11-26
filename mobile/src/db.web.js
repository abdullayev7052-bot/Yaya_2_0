// Browser version of db.js (Metro picks *.web.js for the web build). Same API,
// backed by localStorage, so the admin panel can run the real app UI for testing.
// The phone build always uses the SQLite version in db.js.

const PREFIX = 'yaya_test_';
const load = (k, d) => {
  try { const v = localStorage.getItem(PREFIX + k); return v == null ? d : JSON.parse(v); } catch { return d; }
};
const save = (k, v) => {
  try { localStorage.setItem(PREFIX + k, JSON.stringify(v)); } catch { /* storage full or blocked */ }
};
const uuid = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  }));
const nowIso = () => new Date().toISOString();

const shifts = () => load('shifts', []);
const collections = () => load('collections', []).filter((c) => !c.voided_at);
const ops = () => load('ops', []);
const payments = () => load('payments', []);

export function getKv(key, fallback = null) {
  const kv = load('kv', {});
  return key in kv ? kv[key] : fallback;
}
export function setKv(key, value) {
  const kv = load('kv', {});
  if (value === null || value === undefined) delete kv[key]; else kv[key] = value;
  save('kv', kv);
}

export function getOpenShift() {
  return shifts().filter((s) => !s.closed_at && !s.error).sort((a, b) => b.opened_at.localeCompare(a.opened_at))[0] ?? null;
}
export const allShifts = () => shifts().sort((a, b) => b.opened_at.localeCompare(a.opened_at));
export function openShift() {
  const shift = { uuid: uuid(), opened_at: nowIso(), closed_at: null, dirty: 1, error: null };
  save('shifts', [...shifts(), shift]);
  return shift;
}
export function closeShift(id) {
  save('shifts', shifts().map((s) => (s.uuid === id ? { ...s, closed_at: nowIso(), dirty: 1 } : s)));
}
export function adoptShift(s) {
  if (!shifts().some((x) => x.uuid === s.uuid)) save('shifts', [...shifts(), { uuid: s.uuid, opened_at: s.opened_at, closed_at: null, dirty: 0, error: null }]);
  const have = new Set(collections().map((c) => c.uuid));
  save('collections', [...collections(), ...s.collections.filter((c) => !have.has(c.uuid)).map((c) => ({
    ...c, shift_uuid: s.uuid, unit: c.unit ?? 'kg', synced_at: nowIso(), error: null, edited_at: null }))]);
}
export function discardShift(id) {
  save('collections', collections().filter((c) => c.shift_uuid !== id));
  save('shifts', shifts().filter((s) => s.uuid !== id));
}

export function addCollectionAndClearDraft({ shiftUuid, supplier, product, quantity }) {
  save('collections', [...collections(), {
    uuid: uuid(), shift_uuid: shiftUuid, supplier_id: supplier.id, supplier_name: supplier.name,
    product_id: product.id, product_name: product.name, unit: product.unit ?? 'kg', quantity,
    collected_at: nowIso(), synced_at: null, error: null, edited_at: null,
  }]);
  setKv('draft', null);
}
export function shiftCollections(shiftUuid) {
  return collections().filter((c) => c.shift_uuid === shiftUuid).sort((a, b) => b.collected_at.localeCompare(a.collected_at));
}
export function editCollection(id, { quantity, product }) {
  save('collections', collections().map((x) => (x.uuid === id
    ? { ...x, quantity, product_id: product.id, product_name: product.name, unit: product.unit ?? 'kg', edited_at: nowIso() } : x)));
  save('ops', [...ops(), { uuid: uuid(), type: 'edit', target: id, quantity, product_id: product.id, created_at: nowIso(), synced_at: null, error: null }]);
}
export function deleteCollection(id) {
  save('collections', collections().filter((x) => x.uuid !== id));
  save('ops', [...ops(), { uuid: uuid(), type: 'delete', target: id, created_at: nowIso(), synced_at: null, error: null }]);
}

export function addPayment({ supplier, amount, method, note }) {
  save('payments', [...payments(), { uuid: uuid(), supplier_id: supplier.id, supplier_name: supplier.name, amount,
    method: method ?? 'cash', note: note ?? null, paid_at: nowIso(), synced_at: null, error: null }]);
}
export const recentPayments = () => payments().sort((a, b) => b.paid_at.localeCompare(a.paid_at)).slice(0, 50);

const pending = (x) => !x.synced_at && !x.error;
export const unsyncedCount = () => collections().filter(pending).length + ops().filter(pending).length
  + payments().filter(pending).length + shifts().filter((s) => s.dirty && !s.error).length;
export const errorCount = () => [...collections(), ...ops(), ...payments(), ...shifts()].filter((x) => x.error).length;
export const errors = () => [
  ...shifts().filter((x) => x.error).map((x) => ({ kind: 'shift', uuid: x.uuid, name: 'Smena', error: x.error })),
  ...collections().filter((x) => x.error).map((x) => ({ kind: 'pickup', uuid: x.uuid, name: x.supplier_name, error: x.error })),
  ...ops().filter((x) => x.error).map((x) => ({ kind: 'fix', uuid: x.uuid, name: 'Tuzatish', error: x.error })),
  ...payments().filter((x) => x.error).map((x) => ({ kind: 'payment', uuid: x.uuid, name: x.supplier_name, error: x.error })),
];

export function errorDetails() {
  const cols = collections();
  return [
    ...shifts().filter((x) => x.error).map((x) => ({ kind: 'shift', uuid: x.uuid, title: 'Smena ochish',
      detail: `${cols.filter((c) => c.shift_uuid === x.uuid).length} ta yozuv bilan`, when: x.opened_at, error: x.error })),
    ...cols.filter((x) => x.error).map((x) => ({ kind: 'pickup', uuid: x.uuid, title: x.supplier_name,
      detail: `${x.product_name}: ${x.quantity} ${x.unit ?? 'kg'}`, when: x.collected_at, error: x.error })),
    ...ops().filter((x) => x.error).map((x) => {
      const c = cols.find((y) => y.uuid === x.target);
      return { kind: 'fix', uuid: x.uuid, title: c ? c.supplier_name : 'Tuzatish',
        detail: x.type === 'delete' ? 'Yozuvni o\'chirish' : `Yozuvni tuzatish: ${x.quantity} ${c?.product_name ?? ''}`.trim(), when: x.created_at, error: x.error };
    }),
    ...payments().filter((x) => x.error).map((x) => ({ kind: 'payment', uuid: x.uuid, title: x.supplier_name,
      detail: `To'lov: ${x.amount} so'm`, when: x.paid_at, error: x.error })),
  ];
}
export function pendingDetails() {
  const cols = collections();
  return [
    ...cols.filter(pending).map((x) => ({ kind: 'pickup', uuid: x.uuid, title: x.supplier_name, detail: `${x.product_name}: ${x.quantity} ${x.unit ?? 'kg'}`, when: x.collected_at })),
    ...ops().filter(pending).map((x) => {
      const c = cols.find((y) => y.uuid === x.target);
      return { kind: 'fix', uuid: x.uuid, title: c ? c.supplier_name : 'Tuzatish', detail: x.type === 'delete' ? "Yozuvni o'chirish" : `Yozuvni tuzatish: ${x.quantity}`, when: x.created_at };
    }),
    ...payments().filter(pending).map((x) => ({ kind: 'payment', uuid: x.uuid, title: x.supplier_name, detail: `To'lov: ${x.amount} so'm`, when: x.paid_at })),
    ...shifts().filter((s) => s.dirty && !s.error).map((x) => ({ kind: 'shift', uuid: x.uuid, title: 'Smena', detail: x.closed_at ? 'yopilgani yuborilmagan' : 'ochilgani yuborilmagan', when: x.closed_at ?? x.opened_at, keep: true })),
  ];
}
export function discardError(kind, id) {
  if (kind === 'shift') discardShift(id);
  else if (kind === 'pickup') save('collections', collections().filter((x) => x.uuid !== id));
  else if (kind === 'fix') save('ops', ops().filter((x) => x.uuid !== id));
  else if (kind === 'payment') save('payments', payments().filter((x) => x.uuid !== id));
}
export function discardAllErrors() {
  for (const e of errorDetails()) discardError(e.kind, e.uuid);
}

export function pendingUpload() {
  return {
    shifts: shifts().filter((s) => s.dirty && !s.error).map(({ uuid: u, opened_at, closed_at }) => ({ uuid: u, opened_at, closed_at })),
    collections: collections().filter(pending).sort((a, b) => a.collected_at.localeCompare(b.collected_at)).slice(0, 300),
    ops: ops().filter(pending).slice(0, 300),
    payments: payments().filter(pending).slice(0, 200),
  };
}
export function markUploaded(sentShifts, r) {
  const now = nowIso();
  const rejShift = new Map((r.shifts?.rejected ?? []).map((x) => [x.uuid, x.error]));
  save('shifts', shifts().map((s) => {
    let x = sentShifts.some((y) => y.uuid === s.uuid && y.closed_at === s.closed_at) ? { ...s, dirty: 0 } : s;
    if (rejShift.has(s.uuid)) x = { ...x, error: rejShift.get(s.uuid) };
    return x;
  }));
  const apply = (key, list, acc = [], rej = []) => {
    const a = new Set(acc);
    const e = new Map(rej.map((x) => [x.uuid, x.error]));
    save(key, list.map((x) => (a.has(x.uuid) ? { ...x, synced_at: now } : e.has(x.uuid) ? { ...x, error: e.get(x.uuid) } : x)));
  };
  apply('collections', collections(), r.accepted, r.rejected);
  apply('ops', ops(), r.ops?.accepted, r.ops?.rejected);
  apply('payments', payments(), r.payments?.accepted, r.payments?.rejected);
}
export function retryErrors() {
  save('shifts', shifts().map((s) => (s.error ? { ...s, error: null, dirty: 1 } : s)));
  for (const [k, list] of [['collections', collections()], ['ops', ops()], ['payments', payments()]]) save(k, list.map((x) => ({ ...x, error: null })));
}
export function pruneOld() {
  const cutoff = new Date(Date.now() - 30 * 864e5).toISOString();
  save('collections', collections().filter((c) => !(c.synced_at && c.collected_at < cutoff)));
  save('ops', ops().filter((o) => !(o.synced_at && o.created_at < cutoff)));
  save('payments', payments().filter((p) => !(p.synced_at && p.paid_at < cutoff)));
}
export function wipeLocal() {
  for (const k of ['collections', 'ops', 'payments', 'shifts']) save(k, []);
  for (const k of ['draft', 'bootstrap', 'lastSync']) setKv(k, null);
}
