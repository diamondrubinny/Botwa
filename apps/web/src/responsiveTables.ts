/**
 * On a phone every data table becomes a list of cards (CSS in styles.css, below 700px): each row a card, each cell with its column's
 * name before it. This labels the cells from the table's header (data-label) and keeps the table roles for screen readers, which
 * browsers drop once a table is no longer displayed as one. Runs on every table that appears, as pages change.
 */
function label(table: HTMLTableElement) {
  if (table.dataset.cards === 'off') return;
  const heads = [...table.querySelectorAll<HTMLTableCellElement>('thead tr:last-child th')].map((th) => (th.textContent ?? '').trim());
  table.setAttribute('role', 'table');
  table.querySelectorAll('thead, tbody, tfoot').forEach((g) => g.setAttribute('role', 'rowgroup'));
  table.querySelectorAll('tr').forEach((tr) => {
    tr.setAttribute('role', 'row');
    let col = 0;
    [...tr.children].forEach((c) => {
      const cell = c as HTMLTableCellElement;
      const inHead = !!cell.closest('thead');
      cell.setAttribute('role', inHead ? 'columnheader' : cell.tagName === 'TH' ? 'rowheader' : 'cell');
      if (!inHead) { const h = heads[col]; if (h) cell.dataset.label = h; else delete cell.dataset.label; }
      col += cell.colSpan || 1;
    });
  });
}

export function startResponsiveTables(root: HTMLElement = document.body): () => void {
  let queued = false;
  const run = () => { queued = false; root.querySelectorAll('table').forEach((t) => label(t as HTMLTableElement)); };
  run();
  const mo = new MutationObserver(() => { if (!queued) { queued = true; requestAnimationFrame(run); } });
  mo.observe(root, { childList: true, subtree: true });
  return () => mo.disconnect();
}
