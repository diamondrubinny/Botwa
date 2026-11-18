import { useEffect, useState } from 'react';
import { api } from '../api';

interface Profile { fields: { key: string; label: string; value: string }[]; lang: 'he' | 'en' | 'ar' }

/** What the customer told Betty when identifying, at the top of the conversation (nothing when there is nothing to show). */
export function IdentityCard({ convId, refresh }: { convId: string; refresh?: unknown }) {
  const [p, setP] = useState<Profile | null>(null);
  useEffect(() => {
    let live = true;
    api<Profile>('GET', `/conversations/${convId}/profile`).then((x) => { if (live) setP(x); }).catch(() => { if (live) setP(null); });
    return () => { live = false; };
  }, [convId, refresh]);
  if (!p || (p.fields.length === 0 && p.lang === 'he')) return null;
  return (
    <section className="identity-card" aria-labelledby={`idc-${convId}`}>
      <h3 id={`idc-${convId}`} className="sr-only">פרטי הפונה</h3>
      <dl style={{ display: 'flex', flexWrap: 'wrap', gap: '.25rem .9rem', margin: 0, padding: '.4rem .75rem', fontSize: '.9rem' }}>
        {p.fields.map((f) => (
          <div key={f.key} style={{ display: 'flex', gap: '.3rem', minWidth: 0 }}>
            <dt style={{ fontWeight: 600 }}>{f.label}:</dt>
            <dd style={{ margin: 0, overflowWrap: 'anywhere', unicodeBidi: 'isolate' }}>{f.value}</dd>
          </div>
        ))}
        {p.lang !== 'he' && <div style={{ display: 'flex', gap: '.3rem' }}><dt style={{ fontWeight: 600 }}>שפה:</dt><dd style={{ margin: 0 }}>{p.lang === 'en' ? 'English' : 'ערבית'}</dd></div>}
      </dl>
    </section>
  );
}
