import { useEffect, useRef } from 'react';
import { t } from '../strings';

interface Props { open: boolean; title: string; message: string; confirmLabel?: string; danger?: boolean; onConfirm: () => void; onCancel: () => void }

/** Native <dialog>: focus trap, Esc to close and aria-modal semantics come from the browser. */
export function ConfirmDialog({ open, title, message, confirmLabel = t.confirm, danger, onConfirm, onCancel }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} aria-labelledby="dlg-title" aria-describedby="dlg-msg" onCancel={(e) => { e.preventDefault(); onCancel(); }}>
      <h2 id="dlg-title">{title}</h2>
      <p id="dlg-msg">{message}</p>
      <div className="row">
        <button className={danger ? 'danger' : 'primary'} onClick={onConfirm}>{confirmLabel}</button>
        <button onClick={onCancel} autoFocus>{t.cancel}</button>
      </div>
    </dialog>
  );
}
