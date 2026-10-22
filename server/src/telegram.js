// Minimal Telegram Bot API client over fetch — no third-party dependency, so no
// extra code runs with the server's data. Every call is defensive: a network or
// API error resolves to { ok:false }, it never throws, so a bot problem can never
// crash the server or break an accounting operation.

const API = 'https://api.telegram.org';

export async function tg(token, method, params = {}, { timeoutMs = 60000 } = {}) {
  if (!token) return { ok: false, error: 'no token' };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({ ok: false }));
    return data;
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

export const sendMessage = (token, chatId, text, extra = {}) =>
  tg(token, 'sendMessage', { chat_id: chatId, text, disable_web_page_preview: true, ...extra });

export const answerCallback = (token, id, text) =>
  tg(token, 'answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) });

export const getMe = (token) => tg(token, 'getMe', {}, { timeoutMs: 10000 });

export const getUpdates = (token, offset, timeoutS = 50) =>
  tg(token, 'getUpdates', { offset, timeout: timeoutS, allowed_updates: ['message', 'callback_query'] }, { timeoutMs: (timeoutS + 10) * 1000 });

// Send a document (buffer) via multipart/form-data.
export async function sendDocument(token, chatId, buffer, filename, caption, { timeoutMs = 120000 } = {}) {
  if (!token) return { ok: false, error: 'no token' };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) form.append('caption', caption);
    form.append('document', new Blob([buffer], { type: 'application/octet-stream' }), filename);
    const res = await fetch(`${API}/bot${token}/sendDocument`, { method: 'POST', body: form, signal: ctrl.signal });
    return await res.json().catch(() => ({ ok: false }));
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

// A reply keyboard asking the user to share their phone contact.
export const contactKeyboard = (label) => ({
  keyboard: [[{ text: label, request_contact: true }]],
  resize_keyboard: true, one_time_keyboard: false,
});

// The household menu keyboard.
export const menuKeyboard = () => ({
  keyboard: [[{ text: 'Xaridlar' }, { text: "To'lovlar" }], [{ text: 'Balans' }, { text: 'Profil' }]],
  resize_keyboard: true,
});
