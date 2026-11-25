import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { setupErp } from '../src/erp/schema.js';

// Pouring, capping and their wages now run on the stage model (stages.test.js).
test('a stage-2 database gets the new recipe kinds without losing recipes', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT, unit TEXT DEFAULT 'kg', active INTEGER DEFAULT 1);
    CREATE TABLE users (id INTEGER PRIMARY KEY, login TEXT);
    CREATE TABLE recipes (id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'cook' CHECK (kind IN ('cook','separation')),
      product_id INTEGER REFERENCES products(id), out_min REAL, out_max REAL, note TEXT, sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO products (id, name) VALUES (1, '5% siyro');
    INSERT INTO recipes (id, name, product_id) VALUES (7, '5%', 1);`);
  const addColumn = (t, c, d) => { try { db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`); } catch { /* there */ } };
  setupErp(db, addColumn);
  assert.equal(db.prepare('SELECT name FROM recipes WHERE id = 7').get().name, '5%');
  db.prepare("INSERT INTO recipes (name, kind, product_id, max_minutes) VALUES ('quyish', 'pour', 1, 30)").run();
  assert.equal(db.prepare("SELECT COUNT(*) n FROM recipes WHERE kind = 'pour'").get().n, 1);
});
