import { type ReactNode, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

/** Native modal keeps the workbench mounted and makes the background inert. */
export function WorkbenchDialog({ title, children, onClose, busy = false }: {
  title: string; children: ReactNode; onClose: () => void; busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const label = useId();
  const close = useRef(onClose); close.current = onClose;
  const locked = useRef(busy); locked.current = busy;
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    return () => { if (typeof dialog.close === "function") dialog.close(); previous?.focus(); };
  }, []);
  return createPortal(<dialog ref={ref} className="wb-dialog" aria-labelledby={label} aria-modal="true"
    onCancel={event => { event.preventDefault(); if (!locked.current) close.current(); }}
    onClick={event => { if (event.target === event.currentTarget && !busy) { const box = event.currentTarget.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onClose(); } }}>
    <header><h2 id={label}>{title}</h2><button type="button" aria-label={`关闭${title}`} disabled={busy} onClick={onClose}>×</button></header>
    <div className="wb-dialog-content">{children}</div>
  </dialog>, document.body);
}
