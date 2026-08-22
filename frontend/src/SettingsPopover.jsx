import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

export default function SettingsPopover({ theme, onThemeChange, onClose }) {
  const titleId = useId();
  const panelRef = useRef(null);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    panelRef.current?.querySelector('button')?.focus();
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return createPortal(
    <div className="settings-layer" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section ref={panelRef} className="settings-popover" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="settings-popover__header">
          <h2 id={titleId}>Settings</h2>
          <button type="button" className="settings-popover__close" onClick={onClose} aria-label="Close settings">×</button>
        </header>
        <p className="settings-popover__label">Appearance</p>
        <div className="settings-theme-grid">
          {[
            { value: 'light', icon: '☀', label: 'Light' },
            { value: 'dark', icon: '🌙', label: 'Dark' },
          ].map((option) => (
            <button
              key={option.value}
              type="button"
              className={`settings-theme-option ${theme === option.value ? 'settings-theme-option--active' : ''}`}
              onClick={() => onThemeChange(option.value)}
              aria-pressed={theme === option.value}
            >
              <span aria-hidden="true">{option.icon}</span>
              <span>{option.label}</span>
              {theme === option.value && <span className="settings-theme-option__check" aria-hidden="true">✓</span>}
            </button>
          ))}
        </div>
      </section>
    </div>,
    document.body,
  );
}
