import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { Button } from './ui';

// Only the top-most overlay reacts to Escape (a confirm dialog sits above a drawer).
const escStack = [];
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && escStack.length) escStack[escStack.length - 1].current?.();
  });
}
function useOverlay(onClose, active) {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => {
    if (!active) return undefined;
    escStack.push(ref);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      const i = escStack.indexOf(ref);
      if (i >= 0) escStack.splice(i, 1);
      document.body.style.overflow = prev;
    };
  }, [active]);
}

export function Modal({ open, onClose, title, subtitle, children, footer, size }) {
  useOverlay(onClose, open);
  if (!open) return null;
  return createPortal(
    <>
      <div className="overlay" onClick={onClose} />
      <div className={`modal ${size || ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <div>
            <h2>{title}</h2>
            {subtitle ? <p className="muted" style={{ marginTop: 2 }}>{subtitle}</p> : null}
          </div>
          <button type="button" className="icon-btn sm" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </>,
    document.body,
  );
}

export function Drawer({ open, onClose, head, children, footer, className = '' }) {
  useOverlay(onClose, open);
  if (!open) return null;
  return createPortal(
    <>
      <div className="overlay" onClick={onClose} />
      <aside className={`drawer ${className}`.trim()} role="dialog" aria-modal="true">
        <div className="drawer-head">
          <div className="grow">{head}</div>
          <button type="button" className="icon-btn sm" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <div className="drawer-body">{children}</div>
        {footer ? <div className="drawer-foot">{footer}</div> : null}
      </aside>
    </>,
    document.body,
  );
}

export function ConfirmDialog({ open, title, message, confirmLabel = 'Delete', tone = 'danger', onConfirm, onCancel, busy }) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      size="sm"
      footer={(
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} loading={busy} onClick={onConfirm}>{confirmLabel}</Button>
        </>
      )}
    >
      <p className="muted">{message}</p>
    </Modal>
  );
}
