// Telegram integrations: a household bot (each household gets its own purchases,
// payments and balance) and a backup bot (daily encrypted backup to the owner and
// an optional channel). Both are configured entirely from the panel — the admin
// pastes a token and it starts. Everything here is defensive: a bot error never
// touches the accounting data or crashes the server.
import { getSetting, setSetting } from './settings.js';
import { supplierBalance } from './ledger.js';
import { snapshot, encrypt } from './backup.js';
import { tg, sendMessage, sendDocument, getMe, getUpdates, answerCallback, contactKeyboard, menuKeyboard } from './telegram.js';

const METHOD = { cash: 'Naqd', card: 'Karta', transfer: "O'tkazma" };
const money = (n) => (n == null ? '—' : (n < 0 ? '-' : '') + String(Math.abs(Math.round(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ' '));
const localDT = (iso) => (iso ? new Date(Date.parse(iso) + 5 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') : '');
const q2 = (n) => String(Math.round(Number(n) * 100) / 100);

// ---- settings ---------------------------------------------------------------
// Defaults: messages and fields on; backup time midnight. Booleans are '1'/'0'.
const DEF = {
  hh_enabled: '0', hh_token: '', hh_org: '',
  hh_m_purchase: '1', hh_m_payment: '1', hh_m_void: '1', hh_m_balance: '1',
  hh_f_number: '1', hh_f_time: '1', hh_f_collector: '1', hh_f_unitprice: '1', hh_f_linetotal: '1', hh_f_qty: '1', hh_f_sum: '1', hh_f_balance: '1',
  hh_p_number: '1', hh_p_time: '1', hh_p_who: '1',
  hh_welcome: 'Assalomu alaykum, "{org}" xonadon botiga xush kelibsiz. Ro\'yxatdan o\'tish uchun pastdagi "Raqamni ulashish" tugmasini bosing.',
  hh_registered: 'Tabriklaymiz! Siz ro\'yxatdan o\'tdingiz. Endi xaridlaringiz, to\'lovlaringiz va balansingizni kuzatib borishingiz mumkin.',
  hh_regerror: 'Kechirasiz, bu raqam tizimda topilmadi. Iltimos, kompaniyaga murojaat qiling.',
  bk_enabled: '0', bk_token: '', bk_admin_id: '', bk_channel_id: '', bk_password: '', bk_time: '00:00',
};
const KEYS = Object.keys(DEF);
export const intg = (db) => Object.fromEntries(KEYS.map((k) => [k, getSetting(db, `tg_${k}`) ?? DEF[k]]));
const on = (v) => v !== '0' && v !== '' && v != null;

export function setIntg(db, patch) {
  for (const [k, v] of Object.entries(patch)) if (KEYS.includes(k)) setSetting(db, `tg_${k}`, v == null ? '' : String(v));
}

const orgName = (db) => intg(db).hh_org || getSetting(db, 'company_name') || 'Yaya';

// ---- household message builders --------------------------------------------
function purchaseText(db, shiftId, supplierId) {
  const sh = db.prepare(`SELECT sh.number, sh.copy_no, sh.accepted_at, COALESCE(u.name, u.login) AS collector, sh.client_uuid
    FROM shifts sh JOIN users u ON u.id = sh.employee_id WHERE sh.id = ?`).get(shiftId);
  if (!sh) return null;
  // this household's position in the shift (global seq)
  const order = db.prepare(`SELECT c.supplier_id FROM collections c WHERE c.shift_uuid = ? GROUP BY c.supplier_id ORDER BY MIN(c.collected_at), c.supplier_id`).all(sh.client_uuid);
  const seq = order.findIndex((r) => r.supplier_id === supplierId) + 1;
  const at = db.prepare('SELECT MIN(collected_at) AS t FROM collections WHERE shift_uuid = ? AND supplier_id = ?').get(sh.client_uuid, supplierId)?.t;
  const prods = db.prepare(`SELECT p.name, p.unit, ROUND(SUM(c.quantity), 2) AS qty,
      CAST(ROUND(AVG(COALESCE(c.price, 0))) AS INTEGER) AS price, CAST(SUM(ROUND(c.quantity * COALESCE(c.price, 0))) AS INTEGER) AS amount
    FROM collections c JOIN products p ON p.id = c.product_id WHERE c.shift_uuid = ? AND c.supplier_id = ? GROUP BY c.product_id ORDER BY p.name`).all(sh.client_uuid, supplierId);
  if (!prods.length) return null;
  const f = intg(db);
  const L = [];
  if (on(f.hh_f_number)) L.push(`Xarid: #${sh.number}-${seq}`);
  if (on(f.hh_f_time)) L.push(`Vaqt: ${localDT(at || sh.accepted_at)}`);
  if (on(f.hh_f_collector)) L.push(`Sut yig'uvchi: ${sh.collector}`);
  L.push('');
  let totQ = 0; let totS = 0;
  for (const p of prods) {
    totQ = Math.round((totQ + p.qty) * 100) / 100; totS += p.amount;
    let line = `${p.name} - ${q2(p.qty)} ${p.unit}`;
    if (on(f.hh_f_unitprice)) line += ` x ${money(p.price)}`;
    if (on(f.hh_f_linetotal)) line += ` = ${money(p.amount)}`;
    L.push(line);
  }
  if (on(f.hh_f_qty) || on(f.hh_f_sum)) {
    const parts = [];
    if (on(f.hh_f_qty)) parts.push(`${q2(totQ)} kg`);
    if (on(f.hh_f_sum)) parts.push(money(totS));
    L.push(`Jami: ${parts.join('  /  ')}`);
  }
  if (on(f.hh_f_balance)) { L.push(''); L.push(`Hozirgi balans: ${money(supplierBalance(db, supplierId))}`); }
  return L.join('\n');
}

function paymentText(db, paymentId) {
  const p = db.prepare(`SELECT p.*, (SELECT COALESCE(u.name, u.login) FROM users u WHERE 'user:' || u.login = p.created_by) AS who FROM payments p WHERE p.id = ?`).get(paymentId);
  if (!p) return null;
  const f = intg(db);
  const L = [];
  if (on(f.hh_p_number)) L.push(`To'lov: #${p.number ?? p.id}`);
  if (on(f.hh_p_time)) L.push(`Vaqt: ${localDT(p.paid_at)}`);
  if (on(f.hh_p_who)) L.push(`To'lov qildi: ${p.who || '—'}`);
  L.push('');
  L.push(`${METHOD[p.method] || 'To\'lov'}: ${money(p.amount)}`);
  L.push(`Jami: ${money(p.amount)}`);
  if (p.note) L.push(`Izoh: ${p.note}`);
  if (on(f.hh_f_balance)) { L.push(''); L.push(`Hozirgi balans: ${money(supplierBalance(db, p.supplier_id))}`); }
  return L.join('\n');
}

function voidText(db, paymentId) {
  const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  if (!p) return null;
  const L = [`#${p.number ?? p.id} to'lov bekor qilindi`];
  if (p.void_reason) L.push(`Izoh: ${p.void_reason}`);
  L.push('');
  L.push(`Hozirgi balans: ${money(supplierBalance(db, p.supplier_id))}`);
  return L.join('\n');
}

function balanceText(db, supplierId, note) {
  const L = ['Balansingiz o\'zgartirildi'];
  if (note) L.push(`Izoh: ${note}`);
  L.push('');
  L.push(`Hozirgi balans: ${money(supplierBalance(db, supplierId))}`);
  return L.join('\n');
}

// Fire-and-forget: notify the linked household about an event, if enabled.
export function notifyHousehold(db, kind, data) {
  try {
    const f = intg(db);
    if (!on(f.hh_enabled) || !f.hh_token) return;
    const want = { purchase: 'hh_m_purchase', payment: 'hh_m_payment', void: 'hh_m_void', balance: 'hh_m_balance' }[kind];
    if (want && !on(f[want])) return;
    const send = (supplierId, text) => {
      if (!text) return;
      const link = db.prepare('SELECT chat_id FROM tg_households WHERE supplier_id = ?').all(supplierId);
      for (const l of link) sendMessage(f.hh_token, l.chat_id, text).catch(() => {});
    };
    if (kind === 'purchase') {
      // data: { shiftId } -> notify every household in the shift
      const sh = db.prepare('SELECT client_uuid FROM shifts WHERE id = ?').get(data.shiftId);
      if (!sh) return;
      const hhs = db.prepare('SELECT DISTINCT supplier_id FROM collections WHERE shift_uuid = ?').all(sh.client_uuid);
      for (const h of hhs) send(h.supplier_id, purchaseText(db, data.shiftId, h.supplier_id));
    } else if (kind === 'payment') {
      const p = db.prepare('SELECT supplier_id FROM payments WHERE id = ?').get(data.paymentId);
      if (p) send(p.supplier_id, paymentText(db, data.paymentId));
    } else if (kind === 'void') {
      const p = db.prepare('SELECT supplier_id FROM payments WHERE id = ?').get(data.paymentId);
      if (p) send(p.supplier_id, voidText(db, data.paymentId));
    } else if (kind === 'balance') {
      send(data.supplierId, balanceText(db, data.supplierId, data.note));
    }
  } catch { /* never let a bot problem affect the operation */ }
}

// ---- household bot: incoming updates ----------------------------------------
const PAGE = 10;
const digits = (s) => String(s || '').replace(/\D/g, '');

// Link a chat to a household by phone. A phone that is not on an active household
// never links (returns null). Matches on the last 9 digits so a country code or
// spacing difference does not matter. Exported for testing.
export function tryLink(db, chatId, phone, tgName) {
  const tail = digits(phone).slice(-9);
  if (!tail) return null;
  const sup = db.prepare("SELECT id, name FROM suppliers WHERE active = 1 AND phone IS NOT NULL AND replace(replace(phone,'+',''),' ','') LIKE ?").get('%' + tail);
  if (!sup) return null;
  db.prepare(`INSERT INTO tg_households (chat_id, supplier_id, phone, tg_name) VALUES (?, ?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET supplier_id = excluded.supplier_id, phone = excluded.phone, tg_name = excluded.tg_name, linked_at = datetime('now')`)
    .run(String(chatId), sup.id, digits(phone), tgName || null);
  return sup;
}

// Exported for tests: the household message bodies.
export const _buildPurchase = purchaseText;
export const _buildPayment = paymentText;

function listPurchases(db, supplierId, offset) {
  // Household's purchases (visits) across accepted shifts, newest first, with the
  // shift-global seq number.
  const rows = db.prepare(`
    SELECT sh.number AS shift_number, sh.client_uuid,
      MIN(c.collected_at) AS at, ROUND(SUM(c.quantity), 2) AS qty, CAST(SUM(ROUND(c.quantity * c.price)) AS INTEGER) AS amount
    FROM collections c JOIN shifts sh ON sh.client_uuid = c.shift_uuid
    WHERE c.supplier_id = ? AND sh.status = 'accepted'
    GROUP BY sh.id ORDER BY MIN(c.collected_at) DESC LIMIT ? OFFSET ?`).all(supplierId, PAGE + 1, offset);
  const page = rows.slice(0, PAGE).map((r) => {
    const order = db.prepare('SELECT supplier_id FROM collections WHERE shift_uuid = ? GROUP BY supplier_id ORDER BY MIN(collected_at), supplier_id').all(r.client_uuid);
    const seq = order.findIndex((x) => x.supplier_id === supplierId) + 1;
    return `/${r.shift_number}_${seq} - ${localDT(r.at)} - ${q2(r.qty)} kg = ${money(r.amount)}`;
  });
  return { page, hasMore: rows.length > PAGE };
}

function listPayments(db, supplierId, offset) {
  const rows = db.prepare(`SELECT number, id, paid_at, amount FROM payments WHERE supplier_id = ? AND voided_at IS NULL
    ORDER BY paid_at DESC LIMIT ? OFFSET ?`).all(supplierId, PAGE + 1, offset);
  const page = rows.slice(0, PAGE).map((r) => `/${r.number ?? r.id} - ${localDT(r.paid_at)} - ${money(r.amount)}`);
  return { page, hasMore: rows.length > PAGE };
}

const pager = (prefix, offset, hasMore) => {
  const row = [];
  if (offset > 0) row.push({ text: '« Oldingi', callback_data: `${prefix}:${Math.max(0, offset - PAGE)}` });
  if (hasMore) row.push({ text: 'Keyingisi »', callback_data: `${prefix}:${offset + PAGE}` });
  return row.length ? { inline_keyboard: [row] } : undefined;
};

async function handleHHUpdate(db, update) {
  const f = intg(db);
  const token = f.hh_token;
  const msg = update.message;
  const cb = update.callback_query;
  const chatId = msg?.chat?.id ?? cb?.message?.chat?.id;
  if (!chatId) return;
  const link = db.prepare('SELECT supplier_id FROM tg_households WHERE chat_id = ?').get(String(chatId));

  // Callback: pagination.
  if (cb) {
    await answerCallback(token, cb.id);
    if (!link) return;
    const [prefix, offStr] = String(cb.data || '').split(':');
    const offset = Math.max(0, Number(offStr) || 0);
    if (prefix === 'pur') {
      const { page, hasMore } = listPurchases(db, link.supplier_id, offset);
      const text = page.length ? 'Xaridlar:\n\n' + page.join('\n') : 'Boshqa xarid yo\'q.';
      await tg(token, 'editMessageText', { chat_id: chatId, message_id: cb.message.message_id, text, reply_markup: pager('pur', offset, hasMore) });
    } else if (prefix === 'pay') {
      const { page, hasMore } = listPayments(db, link.supplier_id, offset);
      const text = page.length ? "To'lovlar:\n\n" + page.join('\n') : "Boshqa to'lov yo'q.";
      await tg(token, 'editMessageText', { chat_id: chatId, message_id: cb.message.message_id, text, reply_markup: pager('pay', offset, hasMore) });
    }
    return;
  }

  // Contact shared -> try to register by phone.
  if (msg.contact) {
    const sup = tryLink(db, chatId, msg.contact.phone_number, `${msg.contact.first_name || ''} ${msg.contact.last_name || ''}`.trim());
    if (!sup) { await sendMessage(token, chatId, f.hh_regerror); return; }
    await sendMessage(token, chatId, f.hh_registered, { reply_markup: menuKeyboard() });
    return;
  }

  const text = String(msg.text || '').trim();

  // Drill commands: /24_1 (a purchase) or /36 (a payment).
  const pur = /^\/(\d+)_(\d+)$/.exec(text);
  const pay = /^\/(\d+)$/.exec(text);
  if (!link) {
    await sendMessage(token, chatId, f.hh_welcome.replace('{org}', orgName(db)), { reply_markup: contactKeyboard('📱 Raqamni ulashish') });
    return;
  }
  if (pur) {
    const shiftNumber = Number(pur[1]); const seq = Number(pur[2]);
    const sh = db.prepare("SELECT id, client_uuid FROM shifts WHERE number = ? AND status = 'accepted' ORDER BY copy_no DESC LIMIT 1").get(shiftNumber);
    if (sh) {
      const order = db.prepare('SELECT supplier_id FROM collections WHERE shift_uuid = ? GROUP BY supplier_id ORDER BY MIN(collected_at), supplier_id').all(sh.client_uuid);
      const owner = order[seq - 1]?.supplier_id;
      if (owner === link.supplier_id) { await sendMessage(token, chatId, purchaseText(db, sh.id, owner)); return; }
    }
    await sendMessage(token, chatId, 'Bu xarid topilmadi yoki sizga tegishli emas.');
    return;
  }
  if (pay && text !== '/start') {
    const p = db.prepare('SELECT id, supplier_id FROM payments WHERE number = ? AND voided_at IS NULL').get(Number(pay[1]));
    if (p && p.supplier_id === link.supplier_id) { await sendMessage(token, chatId, paymentText(db, p.id)); return; }
    await sendMessage(token, chatId, 'Bu to\'lov topilmadi yoki sizga tegishli emas.');
    return;
  }

  if (text === 'Xaridlar') {
    const { page, hasMore } = listPurchases(db, link.supplier_id, 0);
    const body = page.length ? 'Xaridlar:\n\n' + page.join('\n') : 'Hali xarid yo\'q.';
    await sendMessage(token, chatId, body, { reply_markup: pager('pur', 0, hasMore) });
  } else if (text === "To'lovlar") {
    const { page, hasMore } = listPayments(db, link.supplier_id, 0);
    const body = page.length ? "To'lovlar:\n\n" + page.join('\n') : "Hali to'lov yo'q.";
    await sendMessage(token, chatId, body, { reply_markup: pager('pay', 0, hasMore) });
  } else if (text === 'Balans') {
    await sendMessage(token, chatId, `Hozirgi balans: ${money(supplierBalance(db, link.supplier_id))}`);
  } else if (text === 'Profil') {
    const s = db.prepare('SELECT name FROM suppliers WHERE id = ?').get(link.supplier_id);
    await sendMessage(token, chatId, `Tashkilot: ${orgName(db)}\nIsm: ${s?.name || '—'}`, { reply_markup: menuKeyboard() });
  } else {
    await sendMessage(token, chatId, 'Quyidagi tugmalardan foydalaning:', { reply_markup: menuKeyboard() });
  }
}

// ---- backup bot -------------------------------------------------------------
export async function sendBackup(db, { manual = false } = {}) {
  const f = intg(db);
  if (!f.bk_token || !f.bk_password) return { ok: false, error: 'Token yoki parol yo\'q' };
  const buf = encrypt(snapshot(db), f.bk_password);
  const name = `yaya_${new Date().toISOString().slice(0, 10)}.yaya`;
  const caption = `Yaya zaxira — ${new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')}${manual ? ' (qo\'lda)' : ''}`;
  const targets = [f.bk_admin_id, f.bk_channel_id].filter(Boolean);
  let okAny = false;
  for (const t of targets) { const r = await sendDocument(f.bk_token, t, buf, name, caption); okAny = okAny || r.ok; }
  return { ok: okAny, targets: targets.length };
}

async function handleBKUpdate(db, update) {
  const f = intg(db);
  const msg = update.message;
  const chatId = msg?.chat?.id;
  if (!chatId) return;
  // Only the configured admin id may interact; strangers get nothing.
  if (!f.bk_admin_id || String(chatId) !== String(f.bk_admin_id)) {
    if (msg.text === '/start') await sendMessage(f.bk_token, chatId, 'Bu bot faqat tashkilot administratori uchun.');
    return;
  }
  const text = String(msg.text || '').trim();
  if (text === '/start') await sendMessage(f.bk_token, chatId, 'Yaya zaxira boti. Har kuni belgilangan vaqtda shifrlangan zaxira yuboriladi. Hozir yuborish uchun /now.');
  else if (text === '/now') { const r = await sendBackup(db, { manual: true }); if (!r.ok) await sendMessage(f.bk_token, chatId, 'Zaxira yuborilmadi: ' + (r.error || 'xatolik')); }
}

// Check once a minute whether it's the configured backup time; send once per day.
export async function tickBackup(db) {
  try {
    const f = intg(db);
    if (!on(f.bk_enabled) || !f.bk_token || !f.bk_password) return;
    const nowLocal = new Date(Date.now() + 5 * 3600e3);
    const hhmm = nowLocal.toISOString().slice(11, 16);
    const today = nowLocal.toISOString().slice(0, 10);
    if (hhmm !== (f.bk_time || '00:00')) return;
    if (getSetting(db, 'tg_bk_last') === today) return;
    setSetting(db, 'tg_bk_last', today);
    await sendBackup(db, {});
  } catch { /* ignore */ }
}

// ---- bot runners (long polling) ---------------------------------------------
const runners = {}; // { hh: {gen, token}, bk: {...} }

function startLoop(db, which, getToken, enabled, handle) {
  const gen = (runners[which]?.gen || 0) + 1;
  runners[which] = { gen, token: getToken() };
  (async () => {
    let offsetKey = `tg_${which}_offset`;
    let offset = Number(getSetting(db, offsetKey)) || 0;
    while (runners[which]?.gen === gen) {
      const token = getToken();
      if (!token || !enabled()) { await new Promise((r) => setTimeout(r, 5000)); continue; }
      const res = await getUpdates(token, offset);
      if (runners[which]?.gen !== gen) break;
      if (res?.ok && Array.isArray(res.result)) {
        for (const u of res.result) {
          offset = u.update_id + 1;
          try { await handle(db, u); } catch { /* ignore one bad update */ }
        }
        if (res.result.length) setSetting(db, offsetKey, offset);
      } else {
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  })().catch(() => {});
}

export function reloadBots(db) {
  startLoop(db, 'hh', () => intg(db).hh_token, () => on(intg(db).hh_enabled), handleHHUpdate);
  startLoop(db, 'bk', () => intg(db).bk_token, () => on(intg(db).bk_enabled), handleBKUpdate);
}

let backupTimer = null;
export function startBots(db) {
  reloadBots(db);
  if (!backupTimer) backupTimer = setInterval(() => tickBackup(db), 60000);
}

// Validate a token (used by the panel "test" button).
export const checkToken = (token) => getMe(token);
