import type { ReactNode } from 'react';

/**
 * Original illustrations drawn for Botwa (part of the project, no third-party licence, nothing loaded from outside).
 * Flat shapes coloured through CSS classes (.il-*), so they follow the palette and the dark theme. Always decorative:
 * the text next to them carries the meaning, so they are hidden from screen readers.
 */
export type IllustrationName = 'inbox' | 'pick' | 'search' | 'knowledge' | 'channels' | 'canned' | 'safety' | 'welcome' | 'done' | 'chart' | 'team' | 'settings' | 'flow';

const ART: Record<IllustrationName, ReactNode> = {
  // an empty tray with two chat bubbles floating above it
  inbox: (
    <>
      <ellipse className="il-shadow" cx="120" cy="140" rx="80" ry="8" />
      <path className="il-soft" d="M52 92h136l-14 40H66z" />
      <path className="il-line-s" d="M52 92h40l8 14h40l8-14h40" fill="none" strokeWidth="4" strokeLinejoin="round" />
      <rect className="il-sun" x="62" y="26" width="70" height="40" rx="14" />
      <path className="il-sun" d="M76 64l-6 14 18-12z" />
      <rect className="il-accent" x="112" y="44" width="70" height="36" rx="14" />
      <path className="il-accent" d="M168 78l8 12-18-10z" />
      <circle className="il-on" cx="134" cy="62" r="4" /><circle className="il-on" cx="147" cy="62" r="4" /><circle className="il-on" cx="160" cy="62" r="4" />
      <path className="il-line-s" d="M78 42h38M78 52h26" strokeWidth="5" strokeLinecap="round" />
      <path className="il-sparkle" d="M196 30l3 8 8 3-8 3-3 8-3-8-8-3 8-3z" />
    </>
  ),
  // a hand-drawn arrow pointing to the list of conversations
  pick: (
    <>
      <ellipse className="il-shadow" cx="120" cy="140" rx="70" ry="7" />
      <rect className="il-card" x="70" y="30" width="100" height="100" rx="16" />
      <circle className="il-peach" cx="94" cy="56" r="11" /><rect className="il-line-f" x="112" y="50" width="44" height="6" rx="3" /><rect className="il-line-f" x="112" y="60" width="30" height="5" rx="2.5" />
      <circle className="il-sky" cx="94" cy="84" r="11" /><rect className="il-line-f" x="112" y="78" width="44" height="6" rx="3" /><rect className="il-line-f" x="112" y="88" width="24" height="5" rx="2.5" />
      <circle className="il-mint" cx="94" cy="112" r="11" /><rect className="il-line-f" x="112" y="106" width="44" height="6" rx="3" /><rect className="il-line-f" x="112" y="116" width="34" height="5" rx="2.5" />
      <path className="il-accent-s" d="M206 44c-10 28-26 36-44 34" fill="none" strokeWidth="5" strokeLinecap="round" />
      <path className="il-accent-s" d="M170 70l-10 8 12 6" fill="none" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  // a magnifying glass over an empty page
  search: (
    <>
      <ellipse className="il-shadow" cx="120" cy="140" rx="70" ry="7" />
      <rect className="il-card" x="64" y="26" width="84" height="104" rx="12" />
      <rect className="il-line-f" x="78" y="44" width="54" height="6" rx="3" /><rect className="il-line-f" x="78" y="58" width="40" height="6" rx="3" /><rect className="il-line-f" x="78" y="72" width="48" height="6" rx="3" />
      <circle className="il-soft" cx="150" cy="92" r="30" />
      <circle className="il-accent-s" cx="150" cy="92" r="30" fill="none" strokeWidth="8" />
      <path className="il-accent-s" d="M172 114l22 22" strokeWidth="12" strokeLinecap="round" />
      <path className="il-line-s" d="M140 86q10-8 20 0" fill="none" strokeWidth="4" strokeLinecap="round" />
    </>
  ),
  // a small stack of books with a bookmark
  knowledge: (
    <>
      <ellipse className="il-shadow" cx="120" cy="140" rx="80" ry="8" />
      <rect className="il-sky" x="58" y="104" width="124" height="26" rx="6" />
      <rect className="il-sun" x="68" y="80" width="110" height="24" rx="6" />
      <rect className="il-accent" x="62" y="56" width="104" height="24" rx="6" />
      <path className="il-line-s" d="M74 117h80M80 92h70M74 68h64" strokeWidth="4" strokeLinecap="round" opacity=".55" />
      <path className="il-peach" d="M150 56v-24l10 8 10-8v24z" />
      <path className="il-sparkle" d="M196 40l3 8 8 3-8 3-3 8-3-8-8-3 8-3z" />
    </>
  ),
  // a phone and a chat window joined by a plug line
  channels: (
    <>
      <ellipse className="il-shadow" cx="120" cy="140" rx="80" ry="8" />
      <rect className="il-card" x="44" y="34" width="56" height="96" rx="12" />
      <rect className="il-mint" x="52" y="46" width="40" height="18" rx="7" /><rect className="il-soft" x="56" y="70" width="36" height="16" rx="7" />
      <rect className="il-card" x="140" y="44" width="70" height="60" rx="12" />
      <rect className="il-accent" x="140" y="44" width="70" height="16" rx="8" />
      <rect className="il-sun" x="150" y="68" width="40" height="12" rx="6" />
      <path className="il-accent-s" d="M100 92c18 0 20-20 40-20" fill="none" strokeWidth="5" strokeDasharray="2 9" strokeLinecap="round" />
    </>
  ),
  // quick replies: three stacked bubbles with a lightning mark
  canned: (
    <>
      <ellipse className="il-shadow" cx="120" cy="140" rx="70" ry="7" />
      <rect className="il-soft" x="60" y="30" width="110" height="26" rx="13" />
      <rect className="il-sun" x="72" y="64" width="110" height="26" rx="13" />
      <rect className="il-mint" x="60" y="98" width="110" height="26" rx="13" />
      <path className="il-accent" d="M190 38l-14 22h12l-8 20 20-28h-12l8-14z" />
    </>
  ),
  // a shield with a check, for the safety pages
  safety: (
    <>
      <ellipse className="il-shadow" cx="120" cy="140" rx="60" ry="7" />
      <path className="il-accent" d="M120 22l44 16v32c0 30-20 52-44 62-24-10-44-32-44-62V38z" />
      <path className="il-soft" d="M120 34l32 12v24c0 22-14 40-32 48z" opacity=".55" />
      <path className="il-on-s" d="M102 76l12 12 24-26" fill="none" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" />
      <path className="il-sparkle" d="M184 36l3 8 8 3-8 3-3 8-3-8-8-3 8-3z" />
    </>
  ),
  // the sign-in picture: a friendly bot face between two bubbles
  welcome: (
    <>
      <ellipse className="il-shadow" cx="120" cy="146" rx="72" ry="7" />
      <rect className="il-sun" x="26" y="30" width="58" height="34" rx="14" />
      <path className="il-sun" d="M70 62l10 12-2-14z" />
      <rect className="il-mint" x="160" y="24" width="56" height="30" rx="13" />
      <path className="il-mint" d="M170 52l-8 12 16-10z" />
      <rect className="il-accent" x="74" y="56" width="92" height="76" rx="26" />
      <path className="il-accent-s" d="M120 56V40" strokeWidth="6" strokeLinecap="round" />
      <circle className="il-peach" cx="120" cy="36" r="8" />
      <rect className="il-card" x="88" y="74" width="64" height="36" rx="16" />
      <circle className="il-accent" cx="106" cy="92" r="6" /><circle className="il-accent" cx="134" cy="92" r="6" />
      <path className="il-on-s" d="M108 120q12 8 24 0" fill="none" strokeWidth="5" strokeLinecap="round" />
      <path className="il-line-s" d="M38 46h30M172 38h30" strokeWidth="5" strokeLinecap="round" />
    </>
  ),
  // all done: a big check with confetti
  done: (
    <>
      <ellipse className="il-shadow" cx="120" cy="140" rx="60" ry="7" />
      <circle className="il-mint" cx="120" cy="80" r="46" />
      <path className="il-ok-s" d="M98 80l16 16 30-32" fill="none" strokeWidth="10" strokeLinecap="round" strokeLinejoin="round" />
      <rect className="il-sun" x="52" y="34" width="10" height="10" rx="2" transform="rotate(20 57 39)" />
      <rect className="il-peach" x="178" y="44" width="10" height="10" rx="2" transform="rotate(-15 183 49)" />
      <circle className="il-sky" cx="186" cy="110" r="6" /><circle className="il-accent" cx="58" cy="112" r="5" />
    </>
  ),
  // a small bar chart with an empty first bar
  chart: (
    <>
      <ellipse className="il-shadow" cx="120" cy="140" rx="70" ry="7" />
      <rect className="il-card" x="56" y="28" width="128" height="104" rx="14" />
      <rect className="il-soft" x="74" y="92" width="18" height="24" rx="4" />
      <rect className="il-sky" x="100" y="74" width="18" height="42" rx="4" />
      <rect className="il-sun" x="126" y="58" width="18" height="58" rx="4" />
      <rect className="il-accent" x="152" y="44" width="18" height="72" rx="4" />
    </>
  ),
  // three people side by side, the middle one in front
  team: (
    <>
      <ellipse className="il-shadow" cx="120" cy="140" rx="84" ry="8" />
      <circle className="il-sky" cx="70" cy="62" r="16" /><path className="il-sky" d="M42 122c0-20 12-34 28-34s28 14 28 34z" />
      <circle className="il-mint" cx="170" cy="62" r="16" /><path className="il-mint" d="M142 122c0-20 12-34 28-34s28 14 28 34z" />
      <circle className="il-peach" cx="120" cy="52" r="20" /><path className="il-accent" d="M84 132c0-26 16-44 36-44s36 18 36 44z" />
      <path className="il-sparkle" d="M196 26l3 8 8 3-8 3-3 8-3-8-8-3 8-3z" />
    </>
  ),
  // two meshing gears and a slider
  settings: (
    <>
      <ellipse className="il-shadow" cx="120" cy="140" rx="74" ry="8" />
      <circle className="il-accent" cx="98" cy="72" r="34" /><circle className="il-card" cx="98" cy="72" r="13" />
      <path className="il-accent" d="M92 28h12l2 12h-16zM92 116h12l2-12h-16zM54 66v12l12 2v-16zM142 66v12l-12 2v-16z" />
      <circle className="il-sun" cx="160" cy="98" r="22" /><circle className="il-card" cx="160" cy="98" r="8" />
      <path className="il-sun" d="M156 70h8l1 9h-10zM156 126h8l1-9h-10zM132 94v8l9 1v-10zM188 94v8l-9 1v-10z" />
      <rect className="il-line-f" x="58" y="124" width="70" height="6" rx="3" /><circle className="il-mint" cx="104" cy="127" r="8" />
    </>
  ),
  // a small flow: start, a question, two branches
  flow: (
    <>
      <ellipse className="il-shadow" cx="120" cy="142" rx="84" ry="7" />
      <path className="il-line-s" d="M150 46h-30M120 46v24M120 70H82v22M120 70h38v22" fill="none" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      <rect className="il-mint" x="150" y="32" width="56" height="28" rx="10" />
      <rect className="il-accent" x="96" y="30" width="48" height="32" rx="10" />
      <rect className="il-sun" x="52" y="92" width="60" height="30" rx="10" />
      <rect className="il-sky" x="128" y="92" width="60" height="30" rx="10" />
      <path className="il-on-s" d="M110 46h20" strokeWidth="4" strokeLinecap="round" />
    </>
  ),
};

export function Illustration({ name, size = 200 }: { name: IllustrationName; size?: number }) {
  return (
    <svg className="illustration" width={size} height={Math.round(size * 2 / 3)} viewBox="0 0 240 160" aria-hidden="true" focusable="false">{ART[name]}</svg>
  );
}

/** A page title with its picture beside it (the picture hides on narrow screens; the title stays the page's h1). */
export function PageTitle({ art, title, children }: { art: IllustrationName; title: string; children?: ReactNode }) {
  return (
    <header className="page-head">
      <div className="page-head-text">
        <h1 tabIndex={-1}>{title}</h1>
        {children && <p className="hint">{children}</p>}
      </div>
      <Illustration name={art} size={150} />
    </header>
  );
}

/** An empty state: a picture, a short title, one helpful sentence and, when there is one, the next action. */
export function EmptyState({ art, title, children, action, size }: { art: IllustrationName; title: string; children?: ReactNode; action?: ReactNode; size?: number }) {
  return (
    <div className="empty-state">
      <Illustration name={art} size={size} />
      <p className="empty-title">{title}</p>
      {children && <p className="hint">{children}</p>}
      {action}
    </div>
  );
}
