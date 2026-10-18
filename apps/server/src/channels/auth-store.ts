import type { Db } from '../db.js';
import { decrypt, encrypt } from '../crypto.js';
import type { AuthStore } from './types.js';

export function createAuthStore(db: Db, channelId: string, encryptionKey: string): AuthStore {
  return {
    async get(key) {
      const { rows } = await db.query('SELECT value_enc FROM channel_auth WHERE channel_id=$1 AND key=$2', [channelId, key]);
      return rows[0] ? decrypt(rows[0].value_enc, encryptionKey) : null;
    },
    async set(key, value) {
      await db.query(
        `INSERT INTO channel_auth (channel_id, key, value_enc) VALUES ($1,$2,$3)
         ON CONFLICT (channel_id, key) DO UPDATE SET value_enc = EXCLUDED.value_enc`,
        [channelId, key, encrypt(value, encryptionKey)],
      );
    },
    async delete(key) {
      await db.query('DELETE FROM channel_auth WHERE channel_id=$1 AND key=$2', [channelId, key]);
    },
    async clear() {
      await db.query('DELETE FROM channel_auth WHERE channel_id=$1', [channelId]);
    },
  };
}
