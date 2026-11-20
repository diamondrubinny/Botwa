// Usage: node dist/scripts/decrypt-backup.js <backup.sql.gz.enc> <out.sql.gz>   (needs ENCRYPTION_KEY, same as the server)
// Restore:  gunzip -c out.sql.gz | psql "$DATABASE_URL"      (into an EMPTY database; see docs/DEPLOY.md)
import { decryptBackup } from '../backup.js';
import { loadConfig } from '../config.js';

const [file, out] = process.argv.slice(2);
if (!file || !out) {
  console.error('usage: decrypt-backup <backup.sql.gz.enc> <out.sql.gz>');
  process.exit(1);
}
await decryptBackup(loadConfig(), file, out);
console.log('decrypted ->', out);
