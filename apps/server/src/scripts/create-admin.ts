// Usage: ADMIN_EMAIL=a@b.c ADMIN_NAME="Name" ADMIN_PASSWORD='...' npm run create-admin
import { loadConfig } from '../config.js';
import { createDb } from '../db.js';
import { migrate } from '../migrate.js';
import { hashPassword, PASSWORD_MIN } from '../password.js';

const { ADMIN_EMAIL, ADMIN_NAME, ADMIN_PASSWORD } = process.env;
if (!ADMIN_EMAIL || !ADMIN_NAME || !ADMIN_PASSWORD || ADMIN_PASSWORD.length < PASSWORD_MIN) {
  console.error(`Set ADMIN_EMAIL, ADMIN_NAME, ADMIN_PASSWORD (min ${PASSWORD_MIN} chars)`);
  process.exit(1);
}
const db = createDb(loadConfig().DATABASE_URL);
await migrate(db);
await db.query(
  `INSERT INTO users (email, name, role, password_hash) VALUES ($1,$2,'admin',$3)
   ON CONFLICT (email) DO NOTHING`,
  [ADMIN_EMAIL.toLowerCase(), ADMIN_NAME, await hashPassword(ADMIN_PASSWORD)],
);
console.log('admin ready:', ADMIN_EMAIL.toLowerCase());
await db.end();
