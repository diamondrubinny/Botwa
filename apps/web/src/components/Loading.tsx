/**
 * A loading placeholder: grey bars shaped like the content that is coming (no layout jump when it arrives).
 * Screen readers hear "טוען…" once; the bars themselves are hidden from them.
 */
export function Loading({ lines = 3, card = false }: { lines?: number; card?: boolean }) {
  const widths = ['92%', '76%', '84%', '60%', '88%', '70%'];
  return (
    <div className={`skeleton${card ? ' card' : ''}`} role="status">
      <span className="sr-only">טוען…</span>
      <div aria-hidden="true">
        <div className="sk-line sk-title" />
        {Array.from({ length: lines }, (_, i) => <div key={i} className="sk-line" style={{ width: widths[i % widths.length] }} />)}
      </div>
    </div>
  );
}
