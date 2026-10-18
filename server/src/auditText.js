// Human-readable Uzbek sentences for the activity log, so the owner can read
// what happened without knowing the technical action names.

const money = (n) => (n == null ? '' : `${String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} so'm`);
const kg = (n) => (n == null ? '' : `${n} kg`);
const METHOD = { cash: 'naqd', card: 'karta', transfer: 'o\'tkazma' };

const T = {
  'auth.login': (d) => `Tizimga kirdi (${d.client === 'panel' ? 'veb panel' : 'ilova'}${d.device ? `, ${d.device}` : ''})`,
  'auth.fail': (d) => `Noto'g'ri parol bilan kirishga urinish: "${d.login}"`,
  'auth.device_denied': (d) => `Ruxsat etilmagan yangi qurilmadan kirishga urinish${d.device ? ` (${d.device})` : ''}`,
  'auth.recovery': (d) => `Zaxira (tiklash) kirish orqali tizimga kirildi (${d.client === 'panel' ? 'veb panel' : 'ilova'})`,
  'suppliers.location': (d) => `Yetkazib beruvchi joylashuvi belgilandi: ${d.name ?? `#${d.id}`}${d.fromApp ? ' (ilovadan)' : ''}`,
  login: () => 'Tizimga kirdi',
  'password.change': () => 'O\'z parolini o\'zgartirdi',
  'device.bound': (d) => `Yangi qurilma biriktirildi: ${d.device ?? ''} (${d.slot ?? ''})`,
  'device.add': (d) => `${d.user ?? ''} uchun qurilma joyi qo'shildi`,
  'device.free': (d) => `${d.user ?? ''} — "${d.slot ?? ''}" qurilma joyi bo'shatildi`,
  'device.logout': (d) => `Ilovadan chiqdi — "${d.slot ?? ''}" qurilma joyi avtomatik bo'shatildi`,
  'device.delete': (d) => `${d.user ?? ''} — qurilma joyi o'chirildi`,
  'user.create': (d) => `Yangi xodim qo'shildi: ${d.name || d.login}`,
  'user.update': (d) => `Xodim ma'lumotlari o'zgartirildi: ${d.name || d.login || `#${d.id}`}${d.passwordChanged ? ' (parol yangilandi)' : ''}${d.active === false ? ' — o\'chirildi' : d.active === true ? ' — yoqildi' : ''}`,
  'user.assign': (d) => `${d.name ?? 'Xodim'}ga ${d.count} ta yetkazib beruvchi biriktirildi`,
  'role.create': (d) => `Yangi rol yaratildi: ${d.name}`,
  'role.update': (d) => `"${d.name}" roli ruxsatlari o'zgartirildi`,
  'role.delete': (d) => `"${d.name}" roli o'chirildi`,
  'suppliers.create': (d) => `Yangi yetkazib beruvchi: ${d.name}${d.fromApp ? ' (ilovadan)' : ''}`,
  'suppliers.update': (d) => `Yetkazib beruvchi o'zgartirildi: ${d.name ?? `#${d.id}`}${d.active === false ? ' — o\'chirildi' : ''}`,
  'suppliers.import': (d) => `Excel'dan import: ${d.suppliersCreated} ta yangi, ${d.suppliersUpdated} ta yangilandi`,
  'suppliers.export': () => 'Yetkazib beruvchilar Excel\'ga yuklab olindi',
  'products.create': (d) => `Yangi mahsulot: ${d.name}`,
  'products.update': (d) => `Mahsulot o'zgartirildi: ${d.name ?? `#${d.id}`}`,
  'price.set': (d) => `Narx belgilandi: ${d.supplier ?? `#${d.supplierId}`} — ${d.product ?? ''} ${money(d.price)}`,
  'price.remove': (d) => `Mahsulot yetkazib beruvchidan olib tashlandi: ${d.supplier ?? ''} — ${d.product ?? ''}`,
  'shift.close': (d) => `${d.shift} smena yopildi: ${d.pickups} ta yetkazib berish, ${kg(d.quantity)}`,
  'shift.accept': (d) => `${d.shift} smena qabul qilindi (${d.employee ?? ''})`,
  'shift.cancel': (d) => `${d.shift} smena bekor qilindi (${d.employee ?? ''}). Sabab: ${d.reason}`,
  'shift.copy': (d) => `${d.from} smena nusxalandi → ${d.to}`,
  'collection.edit': (d) => `Ochiq smenada yozuv tahrirlandi: ${kg(d.was)} → ${kg(d.quantity)}`,
  'collection.delete': (d) => `Ochiq smenadan yozuv o'chirildi (${kg(d.was)})`,
  'payment.create': (d) => `To'lov: ${d.supplier ?? `yetkazib beruvchi #${d.supplierId}`} — ${money(d.amount)} (${METHOD[d.method] ?? d.method})${d.fromApp ? ', ilovadan' : ''}`,
  'payment.void': (d) => `To'lov bekor qilindi: ${money(d.amount)}. Sabab: ${d.reason}`,
  'report.export': (d) => `Hisobot yuklab olindi: ${d.from} — ${d.to}`,
  'settings.update': () => 'Sozlamalar o\'zgartirildi',
  'logo.update': () => 'Logo yangilandi',
  'logo.remove': () => 'Logo olib tashlandi',
  'intro.update': () => 'Kirish animatsiyasi yangilandi',
  'intro.remove': () => 'Kirish animatsiyasi olib tashlandi',
  'data.export': () => 'Barcha ma\'lumotlarning shifrlangan zaxira nusxasi yuklab olindi',
  'data.import': () => 'Zaxira fayldan barcha ma\'lumotlar tiklandi',
  'data.wipe': (d) => `BARCHA HISOBOTLAR TARIXI TOZALANDI${d.resetOpening ? ' (boshlang\'ich qarzlar ham)' : ''}. Tiklash nusxasi #${d.safety} (3 kun)`,
  'data.restore': (d) => `Avtomatik zaxira #${d.id} dan ma'lumotlar tiklandi`,
  'test-data.clear': (d) => `Test ma'lumotlari tozalandi (${d.collections} ta yozuv)`,
};

export function describe(action, detailsJson) {
  let d = {};
  try { d = detailsJson ? JSON.parse(detailsJson) : {}; } catch { /* keep empty */ }
  const f = T[action];
  try {
    return f ? f(d) : action;
  } catch {
    return action;
  }
}

export function actorName(db, actor) {
  const [kind, id] = String(actor).split(':');
  if (kind === 'user') {
    const u = db.prepare('SELECT name, login FROM users WHERE login = ?').get(id);
    return u ? (u.name && u.name !== u.login ? `${u.name} (${u.login})` : u.login) : id;
  }
  if (kind === 'ip') return `Noma'lum (${id})`;
  if (kind === 'employee') return `Xodim ${id}`;
  return actor;
}
