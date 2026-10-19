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

  // --- money
  { key: 'debts.view', group: 'Qarzlar va to\'lovlar', label: 'Qarzlar va to\'lovlar tarixini ko\'rish' },
  { key: 'payments.create', group: 'Qarzlar va to\'lovlar', label: 'Xonadonga to\'lov qilish' },
  { key: 'payments.void', group: 'Qarzlar va to\'lovlar', label: 'To\'lovni bekor qilish' },

  // --- reports
  { key: 'reports.view', group: 'Hisobotlar', label: 'Hisobotlar, o\'rtacha tannarx, kunlik ko\'rsatkichlar' },
  { key: 'reports.export', group: 'Hisobotlar', label: 'Hisobotni Excel\'ga yuklab olish' },

  // --- administration
  { key: 'panel.access', group: 'Boshqaruv', label: 'Veb boshqaruv paneliga kirish' },
  { key: 'staff.manage', group: 'Boshqaruv', label: 'Xodimlar, rollar, ruxsatlar va qurilmalarni boshqarish' },
  { key: 'catalog.manage', group: 'Boshqaruv', label: 'Mahsulotlarni boshqarish' },
  { key: 'settings.manage', group: 'Boshqaruv', label: 'Sozlamalar (logo, kompaniya nomi)' },
  { key: 'audit.view', group: 'Boshqaruv', label: 'Harakatlar jurnalini ko\'rish' },
  { key: 'data.backup', group: 'Boshqaruv', label: 'Zaxira nusxa: eksport, import, tarixni tozalash' },
  { key: 'tester.use', group: 'Boshqaruv', label: 'Ilovani brauzerda sinash' },
];

export const PERMISSION_KEYS = new Set(PERMISSIONS.map((p) => p.key));
const ALL = PERMISSIONS.map((p) => p.key);

// Collecting milk is a specific field job. Admins and office staff manage and
// pay but never open a shift, so these are kept out of the admin role too.
export const COLLECT_PERMS = ['collect.shift', 'collect.edit_own', 'collect.delete_own', 'collect.copy_cancelled', 'collect.view_own_shifts'];
// The admin has every permission except the collector ones, so the mobile app
// never offers an admin a shift to open. Losing collect.* cannot lock anyone out.
const ADMIN_PERMS = ALL.filter((k) => !COLLECT_PERMS.includes(k));

// Built-in roles created on first start. "admin" is locked to every management
// permission so the owner can never lock themselves out.
export const BUILTIN_ROLES = [
  { code: 'admin', name: 'Admin', locked: 1, perms: ADMIN_PERMS },
  { code: 'manager', name: 'Menejer', locked: 0,
    perms: ALL.filter((k) => !['panel.access', 'staff.manage', 'settings.manage', 'audit.view', 'data.backup', 'tester.use',
      ...COLLECT_PERMS].includes(k)) },
  { code: 'storekeeper', name: 'Omborchi', locked: 0,
    perms: ['shifts.view_all', 'shifts.accept', 'shifts.cancel', 'shifts.copy', 'suppliers.view', 'debts.view', 'payments.create', 'reports.view'] },
  { code: 'viewer', name: 'Buxgalter', locked: 0,
    perms: ['shifts.view_all', 'shifts.accept', 'shifts.cancel', 'suppliers.view', 'prices.view', 'debts.view', 'payments.create',
      'payments.void', 'reports.view', 'reports.export'] },
  { code: 'collector', name: 'Sut yig\'uvchi', locked: 0,
    perms: [...COLLECT_PERMS, 'suppliers.card_own', 'suppliers.location', 'payments.create'] },
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
