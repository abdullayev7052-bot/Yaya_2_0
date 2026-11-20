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

-- ---------------------------------------------------------------- production (stage 2)
-- A recipe (tarkib): what goes into one base batch. kind 'cook' makes one product
-- (quyma) from milk and raw materials; 'separation' splits milk into several outputs;
-- 'pour' fills containers (per 1 unit: 0.4 kg quyma + container + label); 'cap'
-- closes them (per 1 unit: the unit itself + a lid). max_minutes: a task running
-- longer raises an alert with the worker's name.
-- out_min / out_max: allowed output weight (kg) for this base batch; a real batch
-- is checked against the range scaled by its size (all limits are proportional).
CREATE TABLE IF NOT EXISTS recipes (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'cook' CHECK (kind IN ('cook','separation','pour','cap')),
  product_id INTEGER REFERENCES products(id),
  out_min REAL,
  out_max REAL,
  max_minutes REAL,
  note TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS recipe_lines (
  id INTEGER PRIMARY KEY,
  recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty REAL NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);
-- Alternatives for a line (another container, another starter...). qty NULL = same amount.
CREATE TABLE IF NOT EXISTS recipe_alts (
  line_id INTEGER NOT NULL REFERENCES recipe_lines(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty REAL,
  PRIMARY KEY (line_id, product_id)
);
-- Separation outputs and how the cost is split: fixed unit cost (capped, e.g. cream
-- 42 000 per kg), a percent of the total, or the rest.
CREATE TABLE IF NOT EXISTS recipe_outputs (
  id INTEGER PRIMARY KEY,
  recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  cost_mode TEXT NOT NULL DEFAULT 'rest' CHECK (cost_mode IN ('fixed','percent','rest')),
  cost_value REAL,
  sort INTEGER NOT NULL DEFAULT 0
);

-- Piece rates of a recipe, per unit of output (e.g. "Quyish" 170 so'm per jar).
-- Several workers on one task share it equally.
CREATE TABLE IF NOT EXISTS recipe_rates (
  id INTEGER PRIMARY KEY,
  recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  amount REAL NOT NULL CHECK (amount >= 0),
  sort INTEGER NOT NULL DEFAULT 0
);

-- A technologist's shift: milk and materials are handed to them; tasks use them;
-- at the end the milk that is not accounted for is explained by reasons.
CREATE TABLE IF NOT EXISTS prod_shifts (
  id INTEGER PRIMARY KEY,
  uuid TEXT NOT NULL UNIQUE,
  number INTEGER NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','approval','closed')),
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  close_data TEXT,
  close_doc_id INTEGER REFERENCES docs(id),
  approval_note TEXT,
  approved_by TEXT,
  note TEXT
);
CREATE TABLE IF NOT EXISTS prod_tasks (
  id INTEGER PRIMARY KEY,
  uuid TEXT NOT NULL UNIQUE,
  number INTEGER NOT NULL,
  shift_id INTEGER NOT NULL REFERENCES prod_shifts(id),
  recipe_id INTEGER REFERENCES recipes(id),
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','approval','done','cancelled')),
  plan TEXT,
  result TEXT,
  doc_id INTEGER REFERENCES docs(id),
  milk_qty REAL NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  done_at TEXT,
  approval_note TEXT,
  approved_by TEXT,
  cancel_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_prod_tasks_shift ON prod_tasks(shift_id);

-- Lot lineage: which lots went into a new lot. Used to pass a later cost change
-- (e.g. boiling loss found at the end of the shift) on to everything made from it.
CREATE TABLE IF NOT EXISTS lot_sources (
  lot_id INTEGER NOT NULL REFERENCES lots(id),
  source_lot_id INTEGER NOT NULL REFERENCES lots(id),
  qty REAL NOT NULL,
  doc_id INTEGER REFERENCES docs(id)
);
CREATE INDEX IF NOT EXISTS idx_lot_sources_src ON lot_sources(source_lot_id);
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

// Added to lots: qty0 = quantity the lot was created with; provisional = cost not
// final yet (the technologist's shift is still open); shift_id = that shift.
export const LOT_COLUMNS = [['qty0', 'REAL'], ['provisional', 'INTEGER NOT NULL DEFAULT 0'], ['shift_id', 'INTEGER']];
// Added to stock_reasons: section = where the reason is offered (warehouse, tech =
// technologist, pour, reprocess); effect = cost (raises the batch cost), company
// (expense) or staff (the person pays); limit = limit_qty per limit_base of milk used.
export const REASON_COLUMNS = [['section', "TEXT NOT NULL DEFAULT 'warehouse'"], ['effect', 'TEXT'], ['limit_qty', 'REAL'], ['limit_base', 'REAL']];
export const REASON_SECTIONS = { warehouse: 'Ombor', tech: 'Texnolog', pour: 'Quyish', reprocess: 'Qayta ishlash' };
export const REASON_EFFECTS = { cost: 'Tannarxga (partiya qimmatlashadi)', company: 'Kompaniya xarajatiga', staff: 'Xodim hisobiga' };

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
  ['production_loss', "Ishlab chiqarishdagi yo'qotish", 'expense'],
];
const SEED_REASONS = [['Singan', 'company'], ['Yo\'qolgan', 'company'], ['To\'kilgan (xodim aybi)', 'staff'], ['Muddati o\'tgan', 'company'], ['Boshqa', 'company']];

export function setupErp(db, addColumn) {
  db.exec(ERP_SCHEMA);
  for (const [c, def] of PRODUCT_COLUMNS) addColumn('products', c, def);
  for (const [c, def] of LOT_COLUMNS) addColumn('lots', c, def);
  for (const [c, def] of REASON_COLUMNS) addColumn('stock_reasons', c, def);
  migrateRecipeKinds(db);
  addColumn('recipes', 'max_minutes', 'REAL');
  seedErp(db);
}

// Stage 3 added the 'pour' and 'cap' recipe kinds. A database created in stage 2 has
// the old CHECK on recipes.kind; SQLite cannot change a CHECK in place, so the table
// is rebuilt once (same rows, same ids; the tables pointing to it keep working).
function migrateRecipeKinds(db) {
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'recipes'").get()?.sql ?? '';
  if (!sql || sql.includes("'pour'")) return;
  const def = ERP_SCHEMA.slice(ERP_SCHEMA.indexOf('CREATE TABLE IF NOT EXISTS recipes ('), ERP_SCHEMA.indexOf('CREATE TABLE IF NOT EXISTS recipe_lines'));
  const fk = db.pragma('foreign_keys', { simple: true });
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(def.replace('CREATE TABLE IF NOT EXISTS recipes (', 'CREATE TABLE recipes_v3 ('));
      const keep = db.prepare('PRAGMA table_info(recipes_v3)').all().map((c) => c.name);
      const cols = db.prepare('PRAGMA table_info(recipes)').all().map((c) => c.name).filter((c) => keep.includes(c)).join(', ');
      db.exec(`INSERT INTO recipes_v3 (${cols}) SELECT ${cols} FROM recipes`);
      db.exec('DROP TABLE recipes');
      db.exec('ALTER TABLE recipes_v3 RENAME TO recipes');
    })();
  } finally {
    db.pragma(`foreign_keys = ${fk ? 'ON' : 'OFF'}`);
  }
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
  // The technologist's reasons for milk that is not accounted for at the end of a shift.
  if (!db.prepare("SELECT 1 FROM stock_reasons WHERE section = 'tech'").get()) {
    const wo = db.prepare("SELECT id FROM pnl_categories WHERE code = 'production_loss'").get().id;
    const ins = db.prepare("INSERT INTO stock_reasons (name, charge, category_id, sort, section, effect, limit_qty, limit_base) VALUES (?, ?, ?, ?, 'tech', ?, ?, ?)");
    ins.run('Qaynatishda', 'company', wo, 0, 'cost', 100, 1000);
    ins.run('Oxladitelda', 'company', wo, 1, 'cost', null, null);
    ins.run("To'kildi", 'company', wo, 2, 'company', null, null);
  }
}

// Every table the warehouse part adds.
export const ERP_SCHEMA_TABLES = [...ERP_SCHEMA.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);

// Tables cleared by "clear all history" (children first).
export const ERP_HISTORY_TABLES = ['alerts', 'lot_sources', 'stock_moves', 'pnl_entries', 'party_entries', 'prod_tasks', 'prod_shifts', 'doc_lines', 'lots', 'docs'];
