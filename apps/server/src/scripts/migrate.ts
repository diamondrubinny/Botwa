import { loadConfig } from '../config.js';
import { createDb } from '../db.js';
import { migrate } from '../migrate.js';

const db = createDb(loadConfig().DATABASE_URL);
console.log('applied:', await migrate(db));
await db.end();
