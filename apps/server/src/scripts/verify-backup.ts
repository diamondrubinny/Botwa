// Usage: node dist/scripts/verify-backup.js <backup.sql.gz.enc>   (needs ENCRYPTION_KEY). Exits 1 if the backup is unusable.
import { verifyBackup } from '../backup.js';
import { loadConfig } from '../config.js';

const file = process.argv[2];
if (!file) { console.error('usage: verify-backup <backup.sql.gz.enc>'); process.exit(1); }
const r = await verifyBackup(loadConfig(), file);
console.log(r.ok ? `OK: ${r.tables} tables, ${r.bytes} bytes of SQL` : `FAILED: ${r.reason}`);
process.exit(r.ok ? 0 : 1);
