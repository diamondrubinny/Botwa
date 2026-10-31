import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

interface Live { tick: number; announce: string }
const Ctx = createContext<Live>({ tick: 0, announce: '' });
export const useLive = () => useContext(Ctx);

/**
 * One server-sent-events connection for the whole app: events carry no content, they only tell pages to refetch.
 * `announce` feeds a polite aria-live region so screen-reader users hear about new messages.
 */
export function LiveProvider({ children }: { children: ReactNode }) {
  const [tick, setTick] = useState(0);
  const [announce, setAnnounce] = useState('');
  useEffect(() => {
    const es = new EventSource('/events');
    let t: ReturnType<typeof setTimeout>;
    es.onmessage = () => {
      setTick((n) => n + 1);
      setAnnounce('התקבלה הודעה חדשה');
      clearTimeout(t);
      t = setTimeout(() => setAnnounce(''), 1500);
    };
    return () => { clearTimeout(t); es.close(); };
  }, []);
  return (
    <Ctx.Provider value={{ tick, announce }}>
      {children}
      <p className="sr-only" role="status" aria-live="polite">{announce}</p>
    </Ctx.Provider>
  );
}
