import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

const DEFAULT_FEATURE_LABELS = {
  hotspots: 'Hotspots',
  risk: 'Predictive Risk',
  network: 'Criminal Network',
  trends: 'Trends & Anomalies',
  alerts: 'Intelligence Alerts',
  brief: 'Intelligence Brief',
  drilldown: 'District Intelligence',
};

export default function FeatureModal({
  title,
  variant,
  children,
  onClose,
  activeFeature,
  onSelectFeature,
  featureLabels = DEFAULT_FEATURE_LABELS,
}) {
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

  const currentFeature = activeFeature || variant;

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

        {onSelectFeature && (
          <nav className="feature-modal__nav" aria-label="Intelligence features switcher">
            <div className="feature-modal__tabs">
              {Object.entries(featureLabels).map(([key, label]) => {
                const isActive = currentFeature === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => onSelectFeature(key)}
                    className={`feature-modal__tab ${isActive ? 'feature-modal__tab--active' : ''}`}
                    aria-selected={isActive}
                  >
                    <span className="feature-modal__tab-dot" aria-hidden="true" />
                    {label}
                  </button>
                );
              })}
            </div>
          </nav>
        )}

        <div className="feature-modal__body custom-scrollbar">{children}</div>
      </section>
    </div>,
    document.body,
  );
}

