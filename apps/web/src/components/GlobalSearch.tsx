import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { api, can, type Conversation, type Me } from '../api';
import { hrefOf, searchSettings } from '../searchIndex';
import { Icon } from './Icon';

/**
 * Global search (Ctrl+K / ⌘K or the search button): screens and settings (from the index, instantly, by permission) and data
 * (conversations, knowledge base, ready replies, forms, officers, users, tags) from the server. A combobox in a modal dialog:
 * arrows move, Enter opens, Esc closes; results are links, so they also open in a new tab.
 */
interface Hit { key: string; group: string; label: string; sub?: string | null; href: string }
interface ServerRow { id: string; title: string; sub?: string | null }
interface ServerResult { kb: ServerRow[]; canned: ServerRow[]; forms: ServerRow[]; officers: ServerRow[]; users: ServerRow[]; tags: ServerRow[] }

const KB_KIND: Record<string, string> = { faq: 'שאלה ותשובה', text: 'טקסט', file: 'קובץ', url: 'קישור', link: 'קישור', gov: 'חקיקה' };

export function GlobalSearch({ me, open, onClose }: { me: Me; open: boolean; onClose: () => void }) {
  const dlg = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');
  const [data, setData] = useState<{ q: string; server: ServerResult | null; convs: Conversation[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();

  useEffect(() => {
    const d = dlg.current;
    if (!d) return;
    if (open) {
      if (!d.open) d.showModal();
      if (document.activeElement !== input.current) input.current?.focus();   // never select: the first letters typed would be replaced
    } else {
      if (d.open) d.close();
      setQ(''); setData(null); setActive(0);     // a fresh search next time
    }
  }, [open]);

  // data from the server, a moment after typing stops
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setData(null); setLoading(false); return; }
    setLoading(true);
    let stale = false;
    const t = setTimeout(async () => {
      const enc = encodeURIComponent(term);
      const [server, convs] = await Promise.all([
        api<ServerResult>('GET', `/search?q=${enc}`).catch(() => null),
        api<Conversation[]>('GET', `/conversations?q=${enc}&limit=5`).catch(() => [] as Conversation[]),
      ]);
      if (!stale) { setData({ q: term, server, convs }); setLoading(false); }
    }, 250);
    return () => { stale = true; clearTimeout(t); };
  }, [q]);

  const hits = useMemo<Hit[]>(() => {
    const out: Hit[] = searchSettings(me, q).map((e) => ({ key: `s:${e.page}:${e.tab ?? ''}:${e.s ?? e.label}`, group: 'מסכים והגדרות', label: e.label, sub: e.where, href: hrefOf(e) }));
    if (data && data.q === q.trim()) {
      for (const c of data.convs) out.push({ key: `c:${c.id}`, group: 'שיחות', label: c.contactName || c.contactId.replace(/@.*/, ''), sub: [c.channelLabel, c.status === 'closed' ? 'סגורה' : c.assignedName ? `אצל ${c.assignedName}` : 'פתוחה'].filter(Boolean).join(' · '), href: `#/inbox?c=${c.id}` });
      const s = data.server;
      if (s) {
        for (const r of s.kb) out.push({ key: `k:${r.id}`, group: 'מאגר ידע', label: r.title, sub: KB_KIND[r.sub ?? ''] ?? r.sub, href: `#/kb?tab=sources&q=${encodeURIComponent(r.title)}` });
        for (const r of s.canned) out.push({ key: `r:${r.id}`, group: 'תשובות מוכנות', label: r.title, sub: r.sub, href: can(me, 'canned.manage') ? `#/canned?q=${encodeURIComponent(r.title)}` : '#/inbox' });
        for (const r of s.forms) out.push({ key: `f:${r.id}`, group: 'טפסים', label: r.title, href: '#/forms?tab=templates' });
        for (const r of s.officers) out.push({ key: `o:${r.id}`, group: 'ממונים', label: r.title, sub: r.sub, href: can(me, 'safety.view') ? '#/safety?s=officers' : '#/bot' });
        for (const r of s.users) out.push({ key: `u:${r.id}`, group: 'צוות', label: r.title, sub: r.sub, href: '#/team' });
        for (const r of s.tags) out.push({ key: `t:${r.id}`, group: 'תגיות', label: r.title, href: can(me, 'tags.manage') ? '#/canned?s=tags-h' : `#/inbox` });
      }
    }
    return out;
  }, [me, q, data]);

  useEffect(() => { setActive((a) => Math.min(a, Math.max(0, hits.length - 1))); }, [hits.length]);
  useEffect(() => { document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' }); }, [active, listId]);

  const go = (h: Hit) => {
    onClose();
    // the same address again (e.g. another setting on the page already open) still has to land on it
    if (window.location.hash === h.href) window.dispatchEvent(new HashChangeEvent('hashchange'));
    else window.location.hash = h.href.slice(1);
  };
  const onKey = (e: React.KeyboardEvent) => {
    // a search field would only clear itself on Esc: here Esc closes the search, as the hint says
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (hits.length ? (a + 1) % hits.length : 0)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (hits.length ? (a - 1 + hits.length) % hits.length : 0)); }
    else if (e.key === 'Home' && e.ctrlKey) { e.preventDefault(); setActive(0); }
    else if (e.key === 'End' && e.ctrlKey) { e.preventDefault(); setActive(Math.max(0, hits.length - 1)); }
    else if (e.key === 'Enter' && hits[active]) { e.preventDefault(); go(hits[active]!); }
  };

  const term = q.trim();
  const status = !term ? '' : loading ? 'מחפש…' : hits.length ? `${hits.length} תוצאות` : 'לא נמצאו תוצאות';
  let lastGroup = '';

  return (
    <dialog ref={dlg} className="gsearch" aria-labelledby={`${listId}-h`} onClose={onClose} onCancel={onClose}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <h2 id={`${listId}-h`} className="sr-only">חיפוש במערכת</h2>
      <div className="gs-bar">
        <Icon name="search" size={18} />
        <input ref={input} type="search" value={q} onChange={(e) => { setQ(e.target.value); setActive(0); }} onKeyDown={onKey}
          role="combobox" aria-expanded={hits.length > 0} aria-controls={listId} aria-autocomplete="list"
          aria-activedescendant={hits.length ? `${listId}-${active}` : undefined}
          aria-label="חיפוש הגדרות, מסכים, שיחות, מאגר ידע, טפסים, ממונים ואנשי צוות" placeholder="חיפוש: הגדרה, מסך, שיחה, ממונה…" maxLength={80} autoComplete="off" spellCheck={false} />
        <button type="button" className="ghost sm" onClick={onClose} ><kbd>Esc</kbd><span className="sr-only"> סגירת החיפוש</span></button>
      </div>
      <p className="sr-only" role="status" aria-live="polite">{status}</p>
      {hits.length > 0 ? (
        <ul id={listId} role="listbox" className="gs-list" aria-label="תוצאות">
          {hits.map((h, i) => {
            const head = h.group !== lastGroup ? h.group : null;
            lastGroup = h.group;
            return (
              <li key={h.key} role="presentation">
                {head && <div className="gs-group" aria-hidden="true">{head}</div>}
                <a id={`${listId}-${i}`} role="option" aria-selected={i === active} href={h.href} tabIndex={-1} className="gs-item"
                  onMouseMove={() => setActive(i)} onClick={(e) => { if (e.ctrlKey || e.metaKey || e.shiftKey) return; e.preventDefault(); go(h); }}>
                  <span className="gs-label">{h.label}</span>
                  <small className="gs-sub"><span className="sr-only">{h.group}: </span>{h.sub}</small>
                </a>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="gs-empty muted">{!term ? 'הקלידו כדי לחפש. למשל: "חירום", "שעות פעילות", "SMS", "ממונה אש", שם לקוח או מילה מתוך שיחה.' : loading ? 'מחפש…' : 'לא נמצאו תוצאות. נסו מילה אחרת.'}</p>
      )}
      <p className="gs-foot muted" aria-hidden="true"><kbd>↑</kbd><kbd>↓</kbd> מעבר · <kbd>Enter</kbd> פתיחה · <kbd>Esc</kbd> סגירה · <kbd>Ctrl</kbd>+<kbd>K</kbd> מכל מקום</p>
    </dialog>
  );
}
