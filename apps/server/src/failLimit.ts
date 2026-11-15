/**
 * Wrong credentials from one address (a made-up widget token or API key): at most `max` a minute, then refused before any database
 * work. Rate limits keyed on the credential alone can be dodged by sending a new made-up value each time; this one cannot.
 */
export function failureLimiter(max: number, windowMs = 60_000) {
  const seen = new Map<string, number[]>();
  return {
    blocked(ip: string): boolean {
      const now = Date.now();
      const list = (seen.get(ip) ?? []).filter((t) => now - t < windowMs);
      if (list.length) seen.set(ip, list); else seen.delete(ip);
      if (seen.size > 50_000) seen.clear();          // never grows without bound
      return list.length >= max;
    },
    fail(ip: string): void { const l = seen.get(ip) ?? []; l.push(Date.now()); seen.set(ip, l); },
  };
}
