import { useCallback, useEffect, useState } from 'react';

export type SbMode = 'full' | 'compact' | 'hidden';
export const SB_MIN = 200, SB_MAX = 420, SB_DEFAULT = 264, SB_COMPACT = 76;
const KEY = 'botwa_sidebar';

interface St { mode: SbMode; width: number }
const clamp = (w: number) => Math.min(SB_MAX, Math.max(SB_MIN, Math.round(w)));
function read(): St {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<St>;
    return { mode: v.mode === 'compact' || v.mode === 'hidden' ? v.mode : 'full', width: typeof v.width === 'number' ? clamp(v.width) : SB_DEFAULT };
  } catch { return { mode: 'full', width: SB_DEFAULT }; }
}

/** Desktop side menu state (full, icons only, or hidden, and its width), remembered in this browser. */
export function useSidebar() {
  const [st, setSt] = useState<St>(read);
  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch { /* storage unavailable */ } }, [st]);
  const setMode = useCallback((mode: SbMode) => setSt((s) => ({ ...s, mode })), []);
  const setWidth = useCallback((w: number) => setSt((s) => ({ ...s, width: clamp(w) })), []);
  const reset = useCallback(() => setSt({ mode: 'full', width: SB_DEFAULT }), []);
  const px = st.mode === 'hidden' ? 0 : st.mode === 'compact' ? SB_COMPACT : st.width;
  return { ...st, px, setMode, setWidth, reset };
}
