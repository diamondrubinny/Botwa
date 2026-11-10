import { FetchError } from '../fetch.js';
import type { GovHttp } from './wikisource.js';

/**
 * Stage 3: the status of an imported law in the Knesset's national legislation database (OData, knesset.gov.il, no key).
 * It covers primary legislation only (laws and ordinances, not regulations): whether the law is in force or repealed, and the date of
 * its latest publication, which tells when an amendment is newer than the text we hold.
 */
export const KNESSET_HOST = 'knesset.gov.il';
const BASE = `https://${KNESSET_HOST}/Odata/ParliamentInfo.svc/KNS_IsraelLaw`;
const SELECT = 'IsraelLawID,Name,LawValidityDesc,PublicationDate,LatestPublicationDate,ValidityFinishDate';

export interface LawStatus { id: number; name: string; validity: string; repealed: boolean; latestPublication: string | null; finished: string | null; checkedAt: string }
interface Row { IsraelLawID: number; Name: string; LawValidityDesc: string | null; PublicationDate: string | null; LatestPublicationDate: string | null; ValidityFinishDate: string | null }

export interface KnOptions { http: GovHttp; sleep: (ms: number) => Promise<void> }

async function get<T>(o: KnOptions, url: string): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await o.http(url);
    if (r.status === 200) { try { return JSON.parse(r.body) as T; } catch { throw new FetchError('bad_response'); } }
    if (r.status === 404) return null as T;
    if (r.status === 429 || r.status === 503 || r.status === 502) { await o.sleep(Math.min(60, r.retryAfter ?? 10 * (attempt + 1)) * 1000); continue; }
    throw new FetchError(`http_${r.status}`);
  }
  throw new FetchError('rate_limited');
}

/** Query string with %20 for spaces (OData servers do not all read "+" as a space). */
const qs = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
const day = (s: string | null) => (s ? s.slice(0, 10) : null);
const toStatus = (r: Row): LawStatus => ({
  id: r.IsraelLawID, name: r.Name, validity: r.LawValidityDesc ?? '', repealed: (r.LawValidityDesc ?? '').trim() === 'בטל',
  latestPublication: day(r.LatestPublicationDate ?? r.PublicationDate), finished: day(r.ValidityFinishDate), checkedAt: new Date().toISOString(),
});

/** Laws and ordinances only: the database has no secondary legislation. */
export const isPrimaryLaw = (pageTitle: string) => /^(חוק|פקודת)\s/.test(pageTitle);

/**
 * Find the law: by its Knesset id when the page states it, otherwise by name. Several laws can share the start of a name (an ordinance
 * of 1946 and its new version of 1970): the one with the year of the full title wins, then the one in force, then the latest.
 */
export async function lawStatus(o: KnOptions, q: { knessetId: string | null; pageTitle: string; fullTitle: string }): Promise<LawStatus | null> {
  if (q.knessetId && /^\d{4,9}$/.test(q.knessetId)) {
    const r = await get<Row | null>(o, `${BASE}(${q.knessetId})?${qs({ $format: 'json', $select: SELECT })}`);
    if (r?.IsraelLawID) return toStatus(r);
  }
  // the title was validated as a plain law title; quotes are doubled for OData all the same
  const name = q.pageTitle.replace(/'/g, "''").slice(0, 200);
  const j = await get<{ value?: Row[] } | null>(o, `${BASE}?${qs({ $format: 'json', $select: SELECT, $top: '20', $filter: `startswith(Name,'${name}')` })}`);
  const rows = (j?.value ?? []).filter((r) => r.Name.replace(/["״]/g, '"').startsWith(q.pageTitle.replace(/["״]/g, '"')));
  if (!rows.length) return null;
  const year = /(1[89]\d\d|20\d\d)\s*$/.exec(q.fullTitle.trim())?.[1];
  const byYear = year ? rows.filter((r) => r.Name.includes(year)) : [];
  const pool = byYear.length ? byYear : rows;
  const inForce = pool.filter((r) => (r.LawValidityDesc ?? '').trim() !== 'בטל');
  const best = (inForce.length ? inForce : pool).sort((a, b) => (b.PublicationDate ?? '').localeCompare(a.PublicationDate ?? ''))[0]!;
  return toStatus(best);
}
