import { BlockList, isIP } from 'node:net';
import { z } from 'zod';
import type { Db } from './db.js';

/** An IPv4/IPv6 address or a CIDR range ("203.0.113.7", "203.0.113.0/24", "2001:db8::/32"). */
export function parseCidr(raw: string): { ip: string; prefix: number; family: 'ipv4' | 'ipv6' } | null {
  const [ipRaw, bits] = raw.trim().split('/');
  const ip = (ipRaw ?? '').trim();
  const v = isIP(ip);
  if (!v) return null;
  const max = v === 4 ? 32 : 128;
  const prefix = bits === undefined ? max : /^\d{1,3}$/.test(bits) ? Number(bits) : NaN;
  if (!Number.isInteger(prefix) || prefix < (v === 4 ? 8 : 16) || prefix > max) return null;   // no "everything" ranges by mistake
  return { ip, prefix, family: v === 4 ? 'ipv4' : 'ipv6' };
}
const cidr = z.string().trim().max(60).refine((v) => parseCidr(v) !== null, 'cidr');

export const firewallSchema = z.object({
  /** only these networks may open the panel (staff screens and sign-in) */
  enabled: z.boolean(),
  allow: z.array(cidr).max(100),
  /** the REST API (Power Apps, integrations) too */
  applyToApi: z.boolean().default(false),
  /** never served at all (except the health check) */
  deny: z.array(cidr).max(500).default([]),
});
export type FirewallSettings = z.infer<typeof firewallSchema>;
export const DEFAULT_FIREWALL: FirewallSettings = { enabled: false, allow: [], applyToApi: false, deny: [] };

export async function loadFirewall(db: Db): Promise<FirewallSettings> {
  const { rows } = await db.query(`SELECT value FROM settings WHERE key = 'firewall'`);
  const p = firewallSchema.safeParse(rows[0]?.value ?? {});
  return p.success ? p.data : DEFAULT_FIREWALL;
}

const toList = (entries: string[]) => {
  const b = new BlockList();
  for (const e of entries) { const c = parseCidr(e); if (c) b.addSubnet(c.ip, c.prefix, c.family); }
  return b;
};
/** "::ffff:1.2.3.4" is the IPv4 address it carries. */
export const normalizeIp = (ip: string) => (ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip);
export function ipMatches(ip: string, entries: string[]): boolean {
  const a = normalizeIp(ip);
  const v = isIP(a);
  if (!v || !entries.length) return false;
  return toList(entries).check(a, v === 4 ? 'ipv4' : 'ipv6');
}

/** Paths customers' browsers and other services must always reach (the chat widget, platform webhooks, the health check). */
const PUBLIC = [/^\/widget/, /^\/w\//, /^\/webhooks\//, /^\/healthz/, /^\/\.well-known\//];

/** The panel "firewall": cached settings, the decision for one request, and a count of what was refused (for the security page). */
export class Firewall {
  private cfg: FirewallSettings = DEFAULT_FIREWALL;
  private allow = new BlockList();
  private deny = new BlockList();
  private loadedAt = 0;
  private blocked: number[] = [];
  constructor(private readonly db: Db, private readonly disabled = false) {}

  set(s: FirewallSettings) { this.cfg = s; this.allow = toList(s.allow); this.deny = toList(s.deny); this.loadedAt = Date.now(); }
  async refresh(force = false) { if (force || Date.now() - this.loadedAt > 30_000) this.set(await loadFirewall(this.db).catch(() => this.cfg)); }

  /** null = let it through; otherwise the reason it is refused */
  async decide(rawIp: string, path: string): Promise<'denied' | 'not_allowed' | null> {
    if (this.disabled) return null;
    await this.refresh();
    const ip = normalizeIp(rawIp);
    const v = isIP(ip);
    if (!v || path.startsWith('/healthz')) return null;
    const fam = v === 4 ? 'ipv4' : 'ipv6';
    if (this.cfg.deny.length && this.deny.check(ip, fam)) return this.count('denied');
    if (!this.cfg.enabled || !this.cfg.allow.length) return null;
    if (PUBLIC.some((re) => re.test(path))) return null;
    if (path.startsWith('/api/v1/') && !this.cfg.applyToApi) return null;
    return this.allow.check(ip, fam) ? null : this.count('not_allowed');
  }
  private count<T>(r: T): T { const now = Date.now(); this.blocked.push(now); if (this.blocked.length > 5000) this.blocked.splice(0, 1000); return r; }
  blockedLastHour(): number { const t = Date.now() - 3600_000; return this.blocked.filter((x) => x > t).length; }
}
