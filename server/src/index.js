import bcrypt from 'bcryptjs';
import { audit, ensureDeviceSlots, openDb, roleIdByCode } from './db/index.js';
import { buildApp } from './app.js';
import { jwtSecret } from './settings.js';
import { pruneSafety } from './backup.js';
import { startBots } from './integrations.js';

const {
  PORT = '3000',
  DB_FILE = './data/yaya.db',
  JWT_SECRET,
  ADMIN_LOGIN,
  ADMIN_PASSWORD,
  RESET_DEVICES_FOR,
} = process.env;

const db = openDb(DB_FILE);
pruneSafety(db);

// First start: create the admin from env so no shell access is needed on the host.
if (ADMIN_LOGIN && ADMIN_PASSWORD && !db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
  const id = db.prepare('INSERT INTO users (login, password_hash, role_id) VALUES (?, ?, ?)')
    .run(ADMIN_LOGIN.toLowerCase(), bcrypt.hashSync(ADMIN_PASSWORD, 10), roleIdByCode(db, 'admin')).lastInsertRowid;
  ensureDeviceSlots(db, id);
  console.log(`Admin "${ADMIN_LOGIN}" yaratildi`);
}

// Emergency: an admin locked out of all device slots sets RESET_DEVICES_FOR=<login>
// on the server, restarts once, signs in, then removes the variable.
if (RESET_DEVICES_FOR) {
  const u = db.prepare('SELECT id FROM users WHERE login = ?').get(RESET_DEVICES_FOR.toLowerCase());
  if (u) {
    db.prepare('UPDATE devices SET device_id = NULL, device_label = NULL, bound_at = NULL WHERE user_id = ?').run(u.id);
    audit(db, 'system', 'device.free', { user: RESET_DEVICES_FOR, slot: 'barchasi (RESET_DEVICES_FOR)' });
    console.log(`"${RESET_DEVICES_FOR}" qurilma joylari bo'shatildi`);
  }
}

const app = buildApp({ db, jwtSecret: jwtSecret(db, JWT_SECRET), logger: true });
setInterval(() => pruneSafety(db), 6 * 3600e3).unref();
// Start the Telegram bots (household + backup). No-op until tokens are configured.
startBots(db);

// Close the database cleanly so the WAL is checkpointed on redeploys.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    await app.close();
    db.close();
    process.exit(0);
  });
}

await app.listen({ port: Number(PORT), host: '0.0.0.0' });
