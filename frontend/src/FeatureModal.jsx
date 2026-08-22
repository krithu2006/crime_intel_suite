import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

export default function FeatureModal({ title, variant, children, onClose }) {
  const titleId = useId();
  const dialogRef = useRef(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previousPaddingRight = document.body.style.paddingRight;
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = 'hidden';
    if (scrollbarWidth > 0) document.body.style.paddingRight = `${scrollbarWidth}px`;

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    dialogRef.current?.querySelector('.feature-modal__close')?.focus();

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      document.body.style.paddingRight = previousPaddingRight;
    };
  }, [onClose]);

  return createPortal(
    <div
      className="feature-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className={`feature-modal feature-modal--${variant}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="feature-modal__header">
          <div>
            <p className="feature-modal__eyebrow">Intelligence workspace</p>
            <h2 id={titleId}>{title}</h2>
          </div>
          <button type="button" className="feature-modal__close" onClick={onClose} aria-label={`Close ${title}`}>
            <span aria-hidden="true">×</span>
          </button>
        </header>
        <div className="feature-modal__body custom-scrollbar">{children}</div>
      </section>
    </div>,
    document.body,
  );
}
