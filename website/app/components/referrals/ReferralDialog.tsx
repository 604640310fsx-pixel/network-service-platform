import { useEffect, useRef, type ReactNode } from "react";

/* 基于原生 <dialog>：showModal 提供模态层、Esc 关闭与焦点陷阱；
   关闭后把焦点还给打开它的按钮。 */
export function ReferralDialog({
  open,
  onClose,
  eyebrow,
  title,
  wide = false,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  eyebrow: string;
  title: string;
  wide?: boolean;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    if (open) return;
    const target = returnFocusRef.current;
    returnFocusRef.current = null;
    if (target && document.contains(target)) target.focus();
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      className={`rfc-dialog${wide ? " is-wide" : ""}`}
      aria-label={title}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="rfc-dialog-head">
        <div>
          <em>{eyebrow}</em>
          <h2>{title}</h2>
        </div>
        <button type="button" className="rfc-dialog-close" onClick={onClose} aria-label={`关闭${title}`}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>
      <div className="rfc-dialog-body">{open ? children : null}</div>
      <div className="rfc-dialog-foot">
        {footer}
        <button type="button" className="rfc-ghost" onClick={onClose}>关闭</button>
      </div>
    </dialog>
  );
}
