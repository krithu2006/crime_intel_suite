/**
 * MapPopupButton — Reusable full-screen pop-up control for any Leaflet map.
 *
 * Usage:
 *   <MapPopupButton title="Hotspot Map">
 *     {(isPopup) => <YourMapContent isPopup={isPopup} />}
 *   </MapPopupButton>
 *
 * The button appears in the bottom-right of the parent container.
 * When clicked, the map is displayed in a full-viewport modal overlay.
 * Press Esc or click the close button to exit pop-up mode.
 */
import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';

export default function MapPopupButton({ children, title = 'Map' }) {
  const [isOpen, setIsOpen] = useState(false);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);

  // Keyboard Escape to close
  useEffect(() => {
    if (!isOpen) return undefined;
    const handleKey = (e) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', handleKey);
    // Prevent body scroll while open
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', handleKey);
      document.body.style.overflow = prev;
    };
  }, [isOpen, close]);

  return (
    <>
      {/* ── Pop-up trigger button (placed by the parent in the controls stack) ── */}
      <button
        type="button"
        onClick={open}
        title={`Open ${title} in full screen`}
        aria-label={`Open ${title} in full screen`}
        className="map-ctrl-btn"
      >
        {/* Expand / full-screen icon */}
        <svg
          className="w-4 h-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4 8V4h4M20 8V4h-4M4 16v4h4M20 16v4h-4"
          />
        </svg>
      </button>

      {/* ── Full-screen pop-up portal ── */}
      {isOpen &&
        createPortal(
          <div
            className="map-popup-backdrop"
            role="dialog"
            aria-modal="true"
            aria-label={`${title} — full screen`}
          >
            {/* Header bar */}
            <div className="map-popup-header">
              <div className="flex items-center gap-2">
                <svg
                  className="w-4 h-4 text-primary-300"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"
                  />
                </svg>
                <span className="map-popup-title">{title}</span>
                <span className="map-popup-hint">Press Esc to close</span>
              </div>
              <button
                type="button"
                onClick={close}
                className="map-popup-close"
                aria-label="Close full screen map"
              >
                {/* Compress / minimize icon */}
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M8 3v3a2 2 0 01-2 2H3m18 0h-3a2 2 0 01-2-2V3m0 18v-3a2 2 0 012-2h3M3 16h3a2 2 0 012 2v3"
                  />
                </svg>
                <span>Exit full screen</span>
              </button>
            </div>

            {/* Map content area */}
            <div className="map-popup-body">
              {children(true /* isPopup */)}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
