import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from './LanguageContext.jsx';

export default function FeatureModal({
  title,
  variant,
  children,
  onClose,
  activeFeature,
  onSelectFeature,
  featureLabels,
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const dialogRef = useRef(null);

  const defaultLabels = {
    hotspots: t('hotspots'),
    risk: t('predictiveRisk'),
    network: t('criminalNetwork'),
    trends: t('trendsAnomalies'),
    alerts: t('intelligenceAlerts'),
    brief: t('intelligenceBrief'),
    drilldown: t('districtIntelligence'),
  };

  const labels = featureLabels || defaultLabels;

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
            <p className="feature-modal__eyebrow">{t('intelligenceWorkspaces')}</p>
            <h2 id={titleId}>{title}</h2>
          </div>
          <button type="button" className="feature-modal__close" onClick={onClose} aria-label="Close">
            <span aria-hidden="true">×</span>
          </button>
        </header>

        {onSelectFeature && (
          <nav className="feature-modal__nav" aria-label="Intelligence features switcher">
            <div className="feature-modal__tabs">
              {Object.entries(labels).map(([key, label]) => {
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

