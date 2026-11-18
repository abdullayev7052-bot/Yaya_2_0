// Production / warehouse part of Yaya 2.0. Everything here is additive: new
// tables, and new columns on `products`. The milk-collection tables are untouched,
// so older backups still restore (SCHEMA_VERSION stays the same).
//
// Core idea: stock is never typed in. Every quantity anywhere is the sum of
// stock_moves, and every move belongs to a document (docs). A holder is either a
// warehouse or a staff member (goods "in someone's hands" while they work on them).
// Every incoming quantity is a lot with its own unit cost; outgoing quantities take
// the oldest lots first (FIFO).

export const ERP_SCHEMA = `
CREATE TABLE IF NOT EXISTS units (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  short TEXT,
  decimals INTEGER NOT NULL DEFAULT 3,
  active INTEGER NOT NULL DEFAULT 1
);

-- allow_negative: may this warehouse go below zero (stock handed out before it was
-- received). warn_negative: raise an alert whenever it does. Set per warehouse.
CREATE TABLE IF NOT EXISTS warehouses (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'general',
  allow_negative INTEGER NOT NULL DEFAULT 0,
  warn_negative INTEGER NOT NULL DEFAULT 1,
  note TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Staff responsible for a warehouse: they accept goods into it and hand goods out.
CREATE TABLE IF NOT EXISTS warehouse_keepers (
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (warehouse_id, user_id)
);

-- A document: the only thing that writes to the ledgers. Numbered per type.
-- draft -> posted | cancelled; a hand-over (transfer) is sent -> posted (accepted)
-- or rejected. uuid comes from the device that created it, so an offline re-send
-- never creates a second document.
CREATE TABLE IF NOT EXISTS docs (
  id INTEGER PRIMARY KEY,
  uuid TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  number INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','posted','rejected','cancelled')),
  doc_date TEXT NOT NULL,
  from_wh INTEGER REFERENCES warehouses(id),
  from_user INTEGER REFERENCES users(id),
  to_wh INTEGER REFERENCES warehouses(id),
  to_user INTEGER REFERENCES users(id),
  mode TEXT,
  reason_id INTEGER,
  charge_user INTEGER REFERENCES users(id),
  source TEXT,
  note TEXT,
  meta TEXT,
  created_by TEXT NOT NULL,
  created_by_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  posted_by TEXT,
  posted_at TEXT,
  rejected_by TEXT,
  rejected_at TEXT,
  reject_reason TEXT,
  cancelled_by TEXT,
  cancelled_at TEXT,
  cancel_reason TEXT,
  UNIQUE (type, number)
);
CREATE INDEX IF NOT EXISTS idx_docs_type ON docs(type, status, doc_date);
CREATE INDEX IF NOT EXISTS idx_docs_to ON docs(status, to_wh, to_user);

CREATE TABLE IF NOT EXISTS doc_lines (
  id INTEGER PRIMARY KEY,
  doc_id INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty REAL NOT NULL,
  unit_cost REAL,
  expires_at TEXT,
  meta TEXT,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_doc_lines_doc ON doc_lines(doc_id);

-- A lot (partiya): one incoming quantity of one product with one unit cost.
CREATE TABLE IF NOT EXISTS lots (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  number TEXT NOT NULL,
  unit_cost REAL NOT NULL DEFAULT 0,
  produced_at TEXT NOT NULL,
  expires_at TEXT,
  doc_id INTEGER REFERENCES docs(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_lots_product ON lots(product_id, produced_at);

-- The stock ledger. Exactly one of warehouse_id / holder_id is set. qty and cost
-- are signed (+ in, - out). lot_id is NULL only for stock that went below zero in
-- a warehouse that allows it; the next receipt settles it.
CREATE TABLE IF NOT EXISTS stock_moves (
  id INTEGER PRIMARY KEY,
  doc_id INTEGER NOT NULL REFERENCES docs(id),
  line_id INTEGER REFERENCES doc_lines(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  lot_id INTEGER REFERENCES lots(id),
  warehouse_id INTEGER REFERENCES warehouses(id),
  holder_id INTEGER REFERENCES users(id),
  qty REAL NOT NULL,
  cost REAL NOT NULL DEFAULT 0,
  at TEXT NOT NULL,
  kind TEXT,
  CHECK ((warehouse_id IS NULL) <> (holder_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_moves_wh ON stock_moves(warehouse_id, product_id);
CREATE INDEX IF NOT EXISTS idx_moves_holder ON stock_moves(holder_id, product_id);
CREATE INDEX IF NOT EXISTS idx_moves_lot ON stock_moves(lot_id);
CREATE INDEX IF NOT EXISTS idx_moves_doc ON stock_moves(doc_id);

-- Money owed between the company and a person (staff now; customers and vendors
-- in later stages). amount > 0: the person owes the company; < 0: the company owes them.
CREATE TABLE IF NOT EXISTS party_entries (
  id INTEGER PRIMARY KEY,
  party_type TEXT NOT NULL CHECK (party_type IN ('staff','customer','vendor')),
  party_id INTEGER NOT NULL,
  amount REAL NOT NULL,
  kind TEXT NOT NULL,
  doc_id INTEGER REFERENCES docs(id),
  note TEXT,
  at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_party_entries ON party_entries(party_type, party_id, at);

-- Expense and income categories (names editable; system ones cannot be deleted).
CREATE TABLE IF NOT EXISTS pnl_categories (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'expense' CHECK (kind IN ('expense','income')),
  system INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

-- Profit and loss entries not tied to a sale (losses, write-offs, surpluses...).
-- The category says expense or income; a negative amount reduces it (reversals, gains).
CREATE TABLE IF NOT EXISTS pnl_entries (
  id INTEGER PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES pnl_categories(id),
  amount REAL NOT NULL,
  doc_id INTEGER REFERENCES docs(id),
  note TEXT,
  at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pnl_entries ON pnl_entries(category_id, at);

-- Write-off reasons (singan, yo'qolgan, to'kilgan...). charge: who pays by default.
CREATE TABLE IF NOT EXISTS stock_reasons (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  charge TEXT NOT NULL DEFAULT 'company' CHECK (charge IN ('company','staff')),
  category_id INTEGER REFERENCES pnl_categories(id),
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

-- Warnings for managers (negative stock now; limits and late tasks later).
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  text TEXT NOT NULL,
  payload TEXT,
  doc_id INTEGER REFERENCES docs(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  resolved_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_alerts_open ON alerts(resolved_at, created_at);
`;

// New columns on the existing products table (the milk products keep kind = 'milk').
export const PRODUCT_COLUMNS = [
  ['kind', "TEXT NOT NULL DEFAULT 'milk'"],
  ['sku', 'TEXT'],
  ['barcode', 'TEXT'],
  ['category', 'TEXT'],
  ['netto_g', 'REAL'],
  ['brutto_g', 'REAL'],
  ['volume', 'REAL'],
  ['volume_unit', 'TEXT'],
  ['shape', 'TEXT'],
  ['shelf_life_hours', 'REAL'],
  ['dwell_hours', 'REAL'],
  ['note', 'TEXT'],
];

export const PRODUCT_KINDS = {
  milk: "Yig'uvchilar suti (yog'li / yog'siz)",
  raw_milk: 'Xom sut (ombor)',
  raw: 'Xomashyo',
  semi: 'Yarim tayyor (quyma)',
  pack: 'Idish / tara',
  label: 'Etiketka',
  finished: 'Tayyor mahsulot',
  returned: 'Qaytgan mahsulot',
  recycled: 'Qayta ishlangan',
  other: 'Boshqa',
};

export const WAREHOUSE_KINDS = {
  raw_milk: 'Xom sut ombori',
  raw: 'Xomashyo ombori',
  pack: 'Idish ombori',
  incubator: 'Issiqxona',
  finished: 'Tayyor mahsulot ombori',
  expired: 'Muddati o\'tganlar ombori',
  recycle: 'Qayta ishlash',
  general: 'Boshqa',
};

export const SHAPES = { round: 'Dumaloq', rect: 'To\'rtburchak', other: 'Boshqa' };

const SEED_UNITS = [['kg', 'kg', 3], ['gramm', 'g', 0], ['litr', 'l', 3], ['dona', 'dona', 0]];
const SEED_CATEGORIES = [
  ['stock_loss', 'Inventarizatsiya kamomadi', 'expense'],
  ['stock_surplus', 'Inventarizatsiya ortiqchasi', 'income'],
  ['writeoff', 'Hisobdan chiqarilgan mahsulot', 'expense'],
  ['cost_variance', 'Tannarx farqi (manfiy qoldiq yopilganda)', 'expense'],
  ['reprocess_loss', 'Qayta ishlashda yo\'qotilgan tannarx', 'expense'],
  ['container_loss', 'Idish yo\'qotilishi', 'expense'],
];
const SEED_REASONS = [['Singan', 'company'], ['Yo\'qolgan', 'company'], ['To\'kilgan (xodim aybi)', 'staff'], ['Muddati o\'tgan', 'company'], ['Boshqa', 'company']];

export function setupErp(db, addColumn) {
  db.exec(ERP_SCHEMA);
  for (const [c, def] of PRODUCT_COLUMNS) addColumn('products', c, def);
  seedErp(db);
}

// Reference rows the warehouse part needs. Safe to run again at any time; it is
// also run after a backup restore, so an older (milk-only) Yaya backup restores
// into a working Yaya 2.0.
export function seedErp(db) {
  if (!db.prepare('SELECT 1 FROM units LIMIT 1').get()) {
    const ins = db.prepare('INSERT INTO units (name, short, decimals) VALUES (?, ?, ?)');
    for (const u of SEED_UNITS) ins.run(...u);
  }
  const insCat = db.prepare('INSERT OR IGNORE INTO pnl_categories (code, name, kind, system) VALUES (?, ?, ?, 1)');
  for (const c of SEED_CATEGORIES) insCat.run(...c);
  if (!db.prepare('SELECT 1 FROM stock_reasons LIMIT 1').get()) {
    const wo = db.prepare("SELECT id FROM pnl_categories WHERE code = 'writeoff'").get().id;
    const ins = db.prepare('INSERT INTO stock_reasons (name, charge, category_id, sort) VALUES (?, ?, ?, ?)');
    SEED_REASONS.forEach(([n, ch], i) => ins.run(n, ch, wo, i));
  }
}

// Every table the warehouse part adds.
export const ERP_SCHEMA_TABLES = [...ERP_SCHEMA.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);

// Tables cleared by "clear all history" (children first).
export const ERP_HISTORY_TABLES = ['alerts', 'stock_moves', 'pnl_entries', 'party_entries', 'doc_lines', 'lots', 'docs'];
