import { useEffect, useRef, useState } from 'react';

/** Run `fn` every `ms` while the tab is visible (also immediately on mount). */
export function usePoll(fn: () => void | Promise<void>, ms: number, deps: unknown[] = []) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    void ref.current();
    const id = setInterval(() => {
      if (!document.hidden) void ref.current();
    }, ms);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, ...deps]);
}

export function useHashRoute(): [string, (r: string) => void] {
  const read = () => window.location.hash.replace(/^#\/?/, '').split('?')[0] || 'inbox';   // "#/inbox?c=ID" is the inbox, opened on that conversation
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return [route, (r) => (window.location.hash = `/${r}`)];
}

/** A parameter of the address after "?" ("#/kb?tab=health&s=hl-q" → hashParam('tab') = "health"). */
export function hashParam(name: string): string | null {
  return new URLSearchParams(window.location.hash.split('?')[1] ?? '').get(name);
}

/** Follow a tab given in the address (also when the page is already open, e.g. from the global search). */
export function useHashTab<T extends string>(valid: readonly T[], set: (t: T) => void) {
  useEffect(() => {
    const on = () => { const t = hashParam('tab'); if (t && (valid as readonly string[]).includes(t)) set(t as T); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/**
 * "s=<id>" in the address: scroll to that part of the page and put the focus on it (opening the folded sections around it), so a
 * search result lands on the setting itself. Waits for the page to draw it (up to 4 seconds).
 */
export function useHashSpot() {
  useEffect(() => {
    const land = (el: HTMLElement) => {
      if (!el.matches('input,textarea,select,button,a[href],[tabindex]')) el.setAttribute('tabindex', '-1');
      el.focus({ preventScroll: true });
      const box = el.closest('section,fieldset,details,.card') ?? el;
      box.classList.add('spot');
      setTimeout(() => box.classList.remove('spot'), 2500);
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const go = () => {
      const id = hashParam('s');
      if (!id) return;
      let n = 0;
      const tryFind = () => {
        const el = document.getElementById(id);
        if (!el) { if (++n < 40) timer = setTimeout(tryFind, 100); return; }
        for (let p: HTMLElement | null = el; p; p = p.parentElement) if (p instanceof HTMLDetailsElement) p.open = true;
        el.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
        land(el);
        // a page that first draws a placeholder and then the real part replaces the element: land again on the new one
        timer = setTimeout(() => { const again = document.getElementById(id); const lost = !document.activeElement || document.activeElement === document.body; if (again && again !== el && !el.isConnected && lost && hashParam('s') === id) land(again); }, 900);
      };
      tryFind();
    };
    go();
    window.addEventListener('hashchange', go);
    return () => { window.removeEventListener('hashchange', go); if (timer) clearTimeout(timer); };
  }, []);
}

/** A filter given in the address ("q=..."), also when the page is already open: the global search opens a list filtered on its result. */
export function useHashQuery(set: (q: string) => void) {
  useEffect(() => {
    const on = () => { const q = hashParam('q'); if (q) set(q); };
    on();
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
