import { describe, expect, it } from 'vitest';
import { safeLogUrl } from '../src/app.js';
import { globMatch, parseSitemap, patternMatches, robotsAllows } from '../src/kb/crawler.js';
import { checkUrl, isPublicIp } from '../src/kb/fetch.js';

describe('security regressions', () => {
  it('SSRF: IPv4 inside IPv6 in any spelling, NAT64, 6to4 and Teredo are not public', () => {
    for (const ip of ['::ffff:7f00:1', '::ffff:a9fe:a9fe', '::ffff:127.0.0.1', '::ffff:10.0.0.5', '::127.0.0.1', '::1', '::', 'fe80::1', 'fd00::1', '2002:7f00:1::', '2001:0:4136::1', '64:ff9b::a9fe:a9fe']) expect(isPublicIp(ip), ip).toBe(false);
    for (const ip of ['2606:4700::1111', '::ffff:8.8.8.8', '8.8.8.8']) expect(isPublicIp(ip), ip).toBe(true);
    for (const u of ['http://[::ffff:169.254.169.254]/latest/meta-data/', 'http://[::ffff:a9fe:a9fe]/', 'http://[::ffff:7f00:1]:8080/']) expect(() => checkUrl(u), u).toThrow('blocked_address');
  });
  it('ReDoS: a hostile robots.txt rule, sitemap or pattern is matched in linear time', () => {
    const t = Date.now();
    expect(robotsAllows({ allow: [], disallow: ['/*a*a*a*a*a*a*a*a*a*a*a*a*X'], crawlDelay: null, sitemaps: [] }, `/${'a'.repeat(5000)}`)).toBe(true);
    expect(patternMatches('*a*a*a*a*a*a*a*a*a*a*X', 'a'.repeat(5000))).toBe(false);
    expect(parseSitemap(`<loc>a${' '.repeat(100_000)}`).urls).toEqual([]);
    expect(Date.now() - t).toBeLessThan(1000);
    // and still right
    expect(globMatch('/private', '/private/x', true)).toBe(true);
    expect(globMatch('/*.pdf$', '/a/b.pdf', true)).toBe(true);
    expect(globMatch('/*.pdf$', '/a/b.pdf?x', true)).toBe(false);
    expect(robotsAllows({ allow: ['/private/ok'], disallow: ['/private'], crawlDelay: null, sitemaps: [] }, '/private/ok/1')).toBe(true);
  });
  it('logs: no query strings, personal links hidden', () => {
    expect(safeLogUrl('/webhooks/wa/1?hub.verify_token=secret&hub.challenge=1')).toBe('/webhooks/wa/1');
    expect(safeLogUrl('/f/abcDEF123/info')).toBe('/f/[token]/info');
  });
});

describe('website chat identity with an expiry', () => {
  it('a signature with exp is checked and stops working when it expires; the older form without exp still works', async () => {
    const { identitySignature, identitySignatureExp, verifyIdentity } = await import('../src/webchat/config.js');
    const secret = 'secretsecretsecretsecret1', now = Date.now(), exp = Math.floor(now / 1000) + 3600;
    expect(verifyIdentity(secret, 'wp-42', identitySignatureExp(secret, 'wp-42', exp), exp, now)).toBe(true);
    expect(verifyIdentity(secret, 'wp-42', identitySignatureExp(secret, 'wp-42', exp), exp, now + 2 * 3600_000)).toBe(false);   // expired
    expect(verifyIdentity(secret, 'wp-42', identitySignatureExp(secret, 'wp-42', exp), exp + 60, now)).toBe(false);             // exp changed
    const far = Math.floor(now / 1000) + 30 * 86400;
    expect(verifyIdentity(secret, 'wp-42', identitySignatureExp(secret, 'wp-42', far), far, now)).toBe(false);                   // too far ahead
    expect(verifyIdentity(secret, 'wp-42', identitySignature(secret, 'wp-42'))).toBe(true);                                     // older integrations
  });
});

describe('the built-in accident form', () => {
  it('a one-page PDF with its fields placed on the page; fits WhatsApp Flows without problems', async () => {
    const { buildAccidentForm } = await import('../src/forms/accident.js');
    const { buildFlowJson } = await import('../src/forms/flowjson.js');
    const f = await buildAccidentForm();
    expect(f.pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(f.fields.map((x) => x.id)).toEqual(['reporter', 'phone', 'date', 'time', 'place', 'kind', 'what', 'injured', 'injury', 'witnesses', 'actions', 'signature']);
    for (const x of f.fields) { expect(x.y).toBeGreaterThan(0); expect(x.x + x.w).toBeLessThanOrEqual(f.pages[0]!.w); }
    expect(buildFlowJson('דיווח תאונה', f.fields).problems).toEqual([]);
  });
});
