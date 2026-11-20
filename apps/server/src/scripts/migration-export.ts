// Usage (inside the server container): MIGRATION_PASSPHRASE=... node dist/scripts/migration-export.js <out.bundle> < .env
// Writes a passphrase-protected bundle with the database, attachment files and the settings file. See scripts/migrate-export.sh.
import { createMigrationBundle, MIN_PASSPHRASE } from '../backup.js';
import { loadConfig } from '../config.js';

const out = process.argv[2];
const pass = process.env.MIGRATION_PASSPHRASE ?? '';
if (!out) { console.error('usage: migration-export <out.bundle> < .env'); process.exit(1); }
if (pass.length < MIN_PASSPHRASE) { console.error(`the passphrase must have at least ${MIN_PASSPHRASE} characters`); process.exit(1); }
let env = '';
for await (const c of process.stdin) env += c;
const r = await createMigrationBundle(loadConfig(), pass, env, out);
console.error(`bundle written: ${out} (${Math.round(r.size / 1024)} KB)`);
