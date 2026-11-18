// Catalogue of everything a role can be allowed to do. Every staff member —
// owner, manager, storekeeper, accountant, milk collector — is one user with one
// role; the role's permissions decide what they see in the mobile app.
// The web panel is a separate, admin-level tool (panel.access).

export const PERMISSIONS = [
  // --- collecting milk (mobile app)
  { key: 'collect.shift', group: 'Sut qabul qilish (smena)', label: 'Smena ochish, xonadondan sut qabul qilish va smenani yopish' },
  { key: 'collect.edit_own', group: 'Sut qabul qilish (smena)', label: 'Ochiq smenadagi o\'z yozuvini tahrirlash' },
  { key: 'collect.delete_own', group: 'Sut qabul qilish (smena)', label: 'Ochiq smenadagi o\'z yozuvini o\'chirish' },
  { key: 'collect.copy_cancelled', group: 'Sut qabul qilish (smena)', label: 'O\'zining bekor qilingan smenasini nusxalash' },
  { key: 'collect.view_own_shifts', group: 'Sut qabul qilish (smena)', label: 'O\'zining avvalgi smenalarini ko\'rish' },
  { key: 'collect.detail_own', group: 'Sut qabul qilish (smena)', label: 'O\'zining qabul qilingan smenasi tafsilotini ko\'rish va nusxalash' },

  // --- suppliers
  { key: 'suppliers.card_own', group: 'Xonadonlar', label: 'O\'ziga biriktirilganlarning kartochkasi: kg tarixi va qarz qoldig\'i (narxsiz)' },
  { key: 'suppliers.view', group: 'Xonadonlar', label: 'Barcha xonadonlar va kartochkalarini ko\'rish' },
  { key: 'suppliers.create', group: 'Xonadonlar', label: 'Yangi xonadon qo\'shish' },
  { key: 'suppliers.edit', group: 'Xonadonlar', label: 'Xonadon ma\'lumotlarini (ism, telefon) o\'zgartirish' },
  { key: 'suppliers.location', group: 'Xonadonlar', label: 'Xonadon manzili va xaritadagi joyini belgilash/tahrirlash' },
  { key: 'suppliers.import', group: 'Xonadonlar', label: 'Excel orqali import va eksport' },
  { key: 'prices.view', group: 'Xonadonlar', label: 'Narx va summalarni ko\'rish', hint: 'O\'chirilsa, faqat kg ko\'rinadi' },
  { key: 'prices.manage', group: 'Xonadonlar', label: 'Narxlarni belgilash' },

  // --- shifts
  { key: 'shifts.view_all', group: 'Smenalar', label: 'Barcha smenalarni, jumladan hozir ochiq (jonli) smenalarni ko\'rish' },
  { key: 'shifts.accept', group: 'Smenalar', label: 'Yopilgan smenani qabul qilish' },
  { key: 'shifts.cancel', group: 'Smenalar', label: 'Smenani bekor qilish' },
  { key: 'shifts.copy', group: 'Smenalar', label: 'Har qanday bekor qilingan smenani nusxalash' },
  { key: 'diff.view', group: 'Smenalar', label: 'Qabul farqini ko\'rish (real miqdor, yutuq/yo\'qotish)', hint: 'Smena yopilgani bilan qabul qilingan real miqdor orasidagi farq' },

  // --- money
  { key: 'debts.view', group: 'Qarzlar va to\'lovlar', label: 'Barcha qarzlar va to\'lovlar tarixini ko\'rish', hint: 'Butun kompaniya balanslari — faqat buxgalter/omborchi uchun' },
  { key: 'payments.view_own', group: 'Qarzlar va to\'lovlar', label: 'Faqat o\'zi qilgan to\'lovlar tarixini ko\'rish', hint: 'Umumiy balanslar yoki boshqa xonadonlar qarzi ko\'rinmaydi' },
  { key: 'payments.create', group: 'Qarzlar va to\'lovlar', label: 'Xonadonga to\'lov qilish' },
  { key: 'payments.void', group: 'Qarzlar va to\'lovlar', label: 'To\'lovni bekor qilish' },

  // --- laboratory
  { key: 'lab.view', group: 'Laboratoriya', label: 'Laborant bo\'limini ko\'rish (narx va xonadonlarsiz)' },
  { key: 'lab.edit', group: 'Laboratoriya', label: 'Laboratoriya qiymatlarini kiritish va saqlash' },
  { key: 'lab.accept', group: 'Laboratoriya', label: 'Limitdan o\'tgan smenani qabul qilish (laborantga ko\'rinmaydi)' },
  { key: 'lab.fields', group: 'Laboratoriya', label: 'Laboratoriya maydonlari va limitlarini sozlash' },

  // --- warehouse (Yaya 2.0)
  { key: 'stock.view_all', group: 'Ombor', label: "Barcha omborlar va xodimlar zimmasidagi qoldiqlarni ko'rish", hint: "O'chirilsa, faqat o'z zimmasidagi va o'zi mas'ul omborlar ko'rinadi" },
  { key: 'stock.costs', group: 'Ombor', label: "Tannarx va summalarni ko'rish (ombor, hujjatlar)", hint: "Oddiy xodimlarga bermang: o'chirilsa, server summalarni umuman yubormaydi" },
  { key: 'stock.transfer', group: 'Ombor', label: "Mahsulotni topshirish va qabul qilish" },
  { key: 'stock.inventory', group: 'Ombor', label: "Inventarizatsiya o'tkazish (mas'ul omborida)" },
  { key: 'stock.writeoff', group: 'Ombor', label: "Hisobdan chiqarish (singan, yo'qolgan, to'kilgan)" },
  { key: 'stock.opening', group: 'Ombor', label: "Boshlang'ich qoldiq kiritish va Excel import" },
  { key: 'stock.cancel', group: 'Ombor', label: "O'tkazilgan ombor hujjatini bekor qilish" },
  { key: 'stock.manage', group: 'Ombor', label: "Omborlar, mas'ullar, sabablar va ombor sozlamalari; istalgan joy nomidan ishlash" },
  { key: 'alerts.view', group: 'Ombor', label: "Ogohlantirishlarni ko'rish (manfiy qoldiq va boshqalar)" },

  // --- production (Yaya 2.0)
  { key: 'prod.work', group: 'Ishlab chiqarish', label: "Texnolog: smena ochish, tarkib bo'yicha topshiriq bajarish, smenani yopish" },
  { key: 'prod.view', group: 'Ishlab chiqarish', label: "Barcha texnolog smenalari va topshiriqlarini ko'rish" },
  { key: 'prod.approve', group: 'Ishlab chiqarish', label: "Limitdan chiqqan topshiriq va smenani tasdiqlash yoki rad etish" },
  { key: 'prod.manage', group: 'Ishlab chiqarish', label: "Tarkiblar, separatsiya, yo'qotish sabablari va limitlarni sozlash" },

  // --- reports
  { key: 'reports.view', group: 'Hisobotlar', label: 'Hisobotlar, o\'rtacha tannarx, kunlik ko\'rsatkichlar' },
  { key: 'reports.export', group: 'Hisobotlar', label: 'Hisobotni Excel\'ga yuklab olish' },

  // --- administration
  { key: 'panel.access', group: 'Boshqaruv', label: 'Veb boshqaruv paneliga kirish' },
  { key: 'staff.manage', group: 'Boshqaruv', label: 'Xodimlar, rollar, ruxsatlar va qurilmalarni boshqarish' },
  { key: 'catalog.manage', group: 'Boshqaruv', label: 'Mahsulotlarni boshqarish' },
  { key: 'settings.manage', group: 'Boshqaruv', label: 'Sozlamalar (logo, kompaniya nomi)' },
  { key: 'integrations.manage', group: 'Boshqaruv', label: 'Integratsiya: Telegram botlar (xonadon boti, zaxira boti)' },
  { key: 'audit.view', group: 'Boshqaruv', label: 'Harakatlar jurnalini ko\'rish' },
  { key: 'data.backup', group: 'Boshqaruv', label: 'Zaxira nusxa: eksport, import, tarixni tozalash' },
  { key: 'tester.use', group: 'Boshqaruv', label: 'Ilovani brauzerda sinash' },
];

export const PERMISSION_KEYS = new Set(PERMISSIONS.map((p) => p.key));
const ALL = PERMISSIONS.map((p) => p.key);

// Collecting milk is a specific field job. Admins and office staff manage and
// pay but never open a shift, so these are kept out of the admin role too.
export const COLLECT_PERMS = ['collect.shift', 'collect.edit_own', 'collect.delete_own', 'collect.copy_cancelled', 'collect.view_own_shifts', 'collect.detail_own'];
// The admin has every permission except the collector ones, so the mobile app
// never offers an admin a shift to open. Losing collect.* cannot lock anyone out.
const ADMIN_PERMS = ALL.filter((k) => !COLLECT_PERMS.includes(k));
// What a warehouse or workshop worker needs: hand over / accept, count, write off.
export const STOCK_WORKER_PERMS = ['stock.transfer', 'stock.inventory', 'stock.writeoff'];

// Built-in roles created on first start. "admin" is locked to every management
// permission so the owner can never lock themselves out.
export const BUILTIN_ROLES = [
  { code: 'admin', name: 'Admin', locked: 1, perms: ADMIN_PERMS },
  { code: 'manager', name: 'Menejer', locked: 0,
    perms: ALL.filter((k) => !['panel.access', 'staff.manage', 'settings.manage', 'integrations.manage', 'audit.view', 'data.backup', 'tester.use',
      ...COLLECT_PERMS].includes(k)) },
  { code: 'storekeeper', name: 'Omborchi', locked: 0,
    perms: ['shifts.view_all', 'shifts.accept', 'shifts.cancel', 'shifts.copy', 'diff.view', 'suppliers.view', 'debts.view', 'payments.create', 'reports.view',
      'lab.view', 'lab.accept', ...STOCK_WORKER_PERMS] },
  { code: 'viewer', name: 'Buxgalter', locked: 0,
    perms: ['shifts.view_all', 'shifts.accept', 'shifts.cancel', 'diff.view', 'suppliers.view', 'suppliers.edit', 'suppliers.location',
      'prices.view', 'prices.manage', 'debts.view', 'payments.create', 'payments.void', 'reports.view', 'reports.export', 'lab.view', 'lab.accept'] },
  { code: 'collector', name: 'Sut yig\'uvchi', locked: 0,
    perms: [...COLLECT_PERMS, 'suppliers.card_own', 'suppliers.location', 'payments.create'] },
  { code: 'lab', name: 'Laborant', locked: 0, perms: ['lab.view', 'lab.edit'] },
  { code: 'technologist', name: 'Texnolog', locked: 0, perms: ['prod.work', 'stock.transfer', 'stock.writeoff'] },
];

// v3 permission keys -> v4 keys (used once by the v3 -> v4 migration).
export const V3_TO_V4 = {
  'dashboard.view': ['reports.view'], 'reports.view': ['reports.view'], 'reports.export': ['reports.export'],
  'amounts.view': ['prices.view'], 'collections.view': ['shifts.view_all'], 'collections.edit': ['shifts.cancel'],
  'collections.void': ['shifts.cancel'], 'shifts.view': ['shifts.view_all'], 'shifts.approve': ['shifts.accept', 'shifts.cancel', 'shifts.copy'],
  'suppliers.view': ['suppliers.view'], 'suppliers.manage': ['suppliers.create', 'suppliers.edit', 'suppliers.location', 'suppliers.import'],
  'prices.manage': ['prices.manage'], 'payments.view': ['debts.view'], 'payments.create': ['payments.create'],
  'payments.void': ['payments.void'], 'employees.manage': ['staff.manage'], 'catalog.manage': ['catalog.manage'],
  'tester.use': ['tester.use'], 'users.manage': ['staff.manage'], 'settings.manage': ['settings.manage'], 'audit.view': ['audit.view'],
  'app.collect': ['collect.shift'], 'app.edit_own': ['collect.edit_own'], 'app.void_own': ['collect.delete_own'],
  'app.history': ['collect.copy_cancelled'], 'app.pay': ['payments.create', 'suppliers.card_own'],
};

export function permsOf(db, roleId) {
  const r = db.prepare('SELECT code, permissions FROM roles WHERE id = ?').get(roleId);
  if (!r) return new Set();
  if (r.code === 'admin') return new Set(ADMIN_PERMS);
  return new Set(JSON.parse(r.permissions || '[]').filter((k) => PERMISSION_KEYS.has(k)));
}
