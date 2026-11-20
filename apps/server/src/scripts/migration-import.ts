// Usage (inside the server container; see scripts/migrate-import.sh):
//   MIGRATION_PASSPHRASE=... node dist/scripts/migration-import.js open <bundle> <dir>  < current .env   -> merged .env on stdout
//   node dist/scripts/migration-import.js restore <dir>       (server stopped; replaces this server's database and files)
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { mergeEnv, openMigrationBundle, restoreFromFolder } from '../backup.js';
import { loadConfig } from '../config.js';

const [cmd, a, b] = process.argv.slice(2);
if (cmd === 'open' && a && b) {
  let current = '';
  for await (const c of process.stdin) current += c;
  const r = await openMigrationBundle(a, process.env.MIGRATION_PASSPHRASE ?? '', b);
  console.error(`bundle from ${r.manifest.createdAt}: database OK, ${r.files} attachment files`);
  process.stdout.write(mergeEnv(await readFile(path.join(b, 'env'), 'utf8'), current));
} else if (cmd === 'restore' && a) {
  await restoreFromFolder(loadConfig(), a);
  await rm(a, { recursive: true, force: true });
  console.error('database and attachment files restored');
} else {
  console.error('usage: migration-import open <bundle> <dir> < .env | migration-import restore <dir>');
  process.exit(1);
}
