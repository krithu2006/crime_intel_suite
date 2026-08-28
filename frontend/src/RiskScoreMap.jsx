/**
 * RiskScoreMap — Leaflet map colored by ward risk scores.
 * Shows CircleMarkers at ward centroids, colored by risk level.
 * Clicking a ward shows a popup card with score, explanation, and top factors.
 */
import { MapContainer, TileLayer, CircleMarker, Popup, ScaleControl, useMap } from 'react-leaflet';
import { useCallback, useEffect, useState } from 'react';
import 'leaflet/dist/leaflet.css';
import MapPopupButton from './MapPopupButton.jsx';
import { useTranslation } from './LanguageContext.jsx';

// Saturated, distinct color steps: green → amber → orange → red
const RISK_COLORS = {
  critical: { fill: '#ef4444', border: '#b91c1c' },
  high:     { fill: '#f97316', border: '#c2410c' },
  moderate: { fill: '#eab308', border: '#a16207' },
  low:      { fill: '#22c55e', border: '#15803d' },
};

function riskColor(level) {
  return RISK_COLORS[level] || RISK_COLORS.moderate;
}

function FitMapToWards({ wards }) {
  const map = useMap();
  useEffect(() => {
    if (!wards.length) return;
    map.fitBounds(wards.map((w) => [w.lat, w.lng]), { padding: [36, 36], maxZoom: 9 });
  }, [wards, map]);
  return null;
}

function KeepMapSized() {
  const map = useMap();
  useEffect(() => {
    const container = map.getContainer();
    const refresh = () => map.invalidateSize({ pan: false });
    const timer = window.setTimeout(refresh, 180);
    const observer = new ResizeObserver(refresh);
    observer.observe(container);
    return () => { window.clearTimeout(timer); observer.disconnect(); };
  }, [map]);
  return null;
}

/** Captures the Leaflet map instance and passes it up to the parent. */
function MapCapture({ onMap }) {
  const map = useMap();
  useEffect(() => { onMap(map); }, [map, onMap]);
  return null;
}

function riskGradient(score) {
  if (score >= 75) return '#ef4444';
  if (score >= 50) return '#f97316';
  if (score >= 25) return '#eab308';
  return '#22c55e';
}

// ── Reusable square control button ────────────────────────────────────────
function MapCtrlBtn({ onClick, title, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="map-ctrl-btn"
    >
      {children}
    </button>
  );
}

// ── Inner map content (shared between inline and popup) ────────────────────
function RiskScoreMapInner({ riskScores, loading, predictionsByWard, mapStyle, setMapStyle }) {
  const { t } = useTranslation();
  const center = [14.5, 76.2];
  const [leafletMap, setLeafletMap] = useState(null);
  const onMap = useCallback((m) => setLeafletMap(m), []);

  const wards = riskScores?.wards || [];
  const searchLabel = wards.length > 0
    ? `${wards.length} ${t('searchWardScope')}`
    : t('searchWardPlaceholder');

  return (
    <div className="google-map-shell relative w-full h-full overflow-hidden border border-white/10">
      {loading && (
        <div className="absolute inset-0 z-[1000] bg-surface-900/80 backdrop-blur-sm flex items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <div className="w-8 h-8 border-3 border-primary-500/30 border-t-primary-400 rounded-full animate-spin" />
            <p className="text-sm text-slate-400">Computing risk scores...</p>
          </div>
        </div>
      )}

      {!loading && wards.length === 0 && (
        <div className="absolute inset-0 z-[999] flex items-center justify-center bg-surface-900/60 backdrop-blur-sm rounded-2xl">
          <div className="text-center p-8">
            <svg className="w-12 h-12 mx-auto mb-3 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <p className="text-sm font-medium text-slate-400">{t('noRiskScoresFound')}</p>
            <p className="text-xs text-slate-600 mt-1">{t('noRiskScoresHint')}</p>
          </div>
        </div>
      )}

      <MapContainer
        center={center}
        zoom={12}
        style={{ height: '100%', width: '100%', background: '#e5e3df' }}
        zoomControl={false}
      >
        <MapCapture onMap={onMap} />
        <KeepMapSized />
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url={mapStyle === 'satellite'
            ? 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
            : 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'}
          className="map-tiles-google-like"
        />
        <ScaleControl position="bottomleft" imperial={false} />
        <FitMapToWards wards={wards} />

        {wards.map((ward) => {
          const colors = riskColor(ward.risk_level);
          const radius = Math.max(10, Math.min(22, 8 + (ward.risk_score / 6)));
          return (
            <CircleMarker
              key={ward.ward_id}
              center={[ward.lat, ward.lng]}
              radius={radius}
              pathOptions={{
                color: colors.border,
                fillColor: colors.fill,
                fillOpacity: 0.55,
                weight: 2,
              }}
            >
              <Popup maxWidth={320} minWidth={280}>
                <RiskPopup ward={ward} prediction={predictionsByWard?.get(ward.ward_id)} />
              </Popup>
            </CircleMarker>
          );
        })}
      </MapContainer>

      {/* Search bar overlay */}
      <div className="google-map-search absolute left-4 right-4 top-4 z-[1000] sm:right-auto sm:w-[390px]">
        <svg className="h-5 w-5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="m21 21-4.35-4.35m1.35-5.15a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0z" />
        </svg>
        <span className="truncate text-sm font-medium text-slate-700">{searchLabel}</span>
      </div>

      {/* Map / Satellite toggle */}
      <div className="google-map-layers absolute left-4 top-20 z-[1000]">
        <button className={mapStyle === 'map' ? 'is-active' : ''} type="button" onClick={() => setMapStyle('map')}>{t('mapStyleMap')}</button>
        <button className={mapStyle === 'satellite' ? 'is-active' : ''} type="button" onClick={() => setMapStyle('satellite')}>{t('mapStyleSatellite')}</button>
      </div>

      {/* Legend */}
      <div className="google-map-card absolute bottom-8 left-4 z-[1000] px-4 py-3">
        <p className="text-xs font-semibold text-slate-700 mb-2">{t('riskLevel')}</p>
        <div className="flex items-center gap-3 text-xs text-slate-600">
          {[
            { label: t('low'), color: '#22c55e' },
            { label: t('moderate'), color: '#eab308' },
            { label: t('high'), color: '#f97316' },
            { label: t('critical'), color: '#ef4444' },
          ].map(({ label, color }) => (
            <span key={label} className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full" style={{ backgroundColor: color }} />
              {label}
            </span>
          ))}
        </div>
      </div>

      {/* Score range indicator */}
      {riskScores?.model_info && (
        <div className="google-map-card absolute right-4 top-4 z-[1000] hidden px-4 py-3 sm:block">
          <p className="text-xs font-semibold text-slate-700">{wards.length} {t('wardsScored')}</p>
        </div>
      )}

      {/* ── Custom controls column: Zoom In / Zoom Out / Full Screen ── */}
      <div className="absolute bottom-6 right-[10px] z-[1001] flex flex-col gap-[2px]">
        {/* Zoom In */}
        <MapCtrlBtn title="Zoom in" onClick={() => leafletMap?.zoomIn()}>
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 5v14M5 12h14" />
          </svg>
        </MapCtrlBtn>

        {/* Zoom Out */}
        <MapCtrlBtn title="Zoom out" onClick={() => leafletMap?.zoomOut()}>
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 12h14" />
          </svg>
        </MapCtrlBtn>

        {/* Full Screen Pop-up */}
        <MapPopupButton title={t('predictiveRisk')}>
          {() => (
            <RiskScoreMapInner
              riskScores={riskScores}
              loading={loading}
              predictionsByWard={predictionsByWard}
              mapStyle={mapStyle}
              setMapStyle={setMapStyle}
            />
          )}
        </MapPopupButton>
      </div>
    </div>
  );
}

export default function RiskScoreMap({ riskScores, loading, predictionsByWard }) {
  const [mapStyle, setMapStyle] = useState('map');
  return (
    <RiskScoreMapInner
      riskScores={riskScores}
      loading={loading}
      predictionsByWard={predictionsByWard}
      mapStyle={mapStyle}
      setMapStyle={setMapStyle}
    />
  );
}

/** Popup card shown when clicking a ward on the risk score map */
function RiskPopup({ ward, prediction }) {
  const scoreColor = riskGradient(ward.risk_score);
  return (
    <div style={{ fontFamily: 'Inter, sans-serif', color: '#1e293b', minWidth: 250 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
        <div>
          <p style={{ fontWeight: 700, fontSize: 15, margin: 0 }}>{ward.ward_name}</p>
          <p style={{ fontSize: 11, color: '#64748b', margin: 0 }}>{ward.district}</p>
        </div>
        <div style={{ textAlign: 'right' }}>
          <p style={{ fontWeight: 800, fontSize: 28, margin: 0, lineHeight: 1, color: scoreColor }}>
            {Math.round(ward.risk_score)}
          </p>
          <p style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', margin: 0, color: scoreColor }}>
            {ward.risk_level}
          </p>
        </div>
      </div>

      <p style={{ fontSize: 12, color: '#475569', lineHeight: 1.5, margin: '0 0 10px 0', borderLeft: `3px solid ${scoreColor}`, paddingLeft: 8 }}>
        {ward.explanation}
      </p>

      {ward.top_factors && ward.top_factors.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {ward.top_factors.map((f) => (
            <div key={`${f.label || f.description}:${f.direction}`} style={{ display: 'flex', items: 'center', gap: 6 }}>
              <span style={{ fontSize: 10, color: f.direction === 'up' ? '#dc2626' : '#16a34a', width: 12, fontWeight: 700 }}>
                {f.direction === 'up' ? '▲' : '▼'}
              </span>
              <div style={{ flex: 1 }}>
                <div style={{ height: 6, borderRadius: 3, backgroundColor: '#e2e8f0', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${Math.min(f.contribution_pct, 100)}%`, borderRadius: 3, backgroundColor: f.direction === 'up' ? '#f87171' : '#4ade80' }} />
                </div>
              </div>
              <span style={{ fontSize: 10, color: '#64748b', whiteSpace: 'nowrap', maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {f.description}
              </span>
            </div>
          ))}
        </div>
      )}

      <PredictionSection prediction={prediction} />
    </div>
  );
}

function PredictionSection({ prediction }) {
  const headingStyle = {
    fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em',
    color: '#64748b', margin: '10px 0 4px 0', borderTop: '1px solid #e2e8f0', paddingTop: 8,
  };

  if (!prediction || prediction.insufficient_data) {
    return (
      <div>
        <p style={headingStyle}>Predictive Risk</p>
        <p style={{ fontSize: 11, color: '#94a3b8', fontStyle: 'italic', margin: 0 }}>
          {prediction?.message || 'Insufficient historical data for reliable prediction.'}
        </p>
      </div>
    );
  }

  const scoreColor = riskGradient(prediction.risk_score);
  const trendArrow = prediction.trend === 'rising' ? '↑ Rising' : prediction.trend === 'falling' ? '↓ Falling' : '→ Stable';

  return (
    <div>
      <p style={headingStyle}>Predictive Risk · Next {prediction.prediction_horizon_days}d</p>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4 }}>
        <span style={{ fontWeight: 800, fontSize: 22, color: scoreColor }}>{Math.round(prediction.risk_score)}</span>
        <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: scoreColor }}>{prediction.risk_level} risk</span>
      </div>
      <p style={{ fontSize: 11, color: '#475569', margin: '0 0 2px 0' }}>
        Expected incidents: <strong>{prediction.predicted_incidents?.toFixed(1)}</strong>
        {'  ·  '}Confidence: <strong>{Math.round(prediction.confidence * 100)}%</strong>
        {'  ·  '}{trendArrow}
      </p>
      {prediction.top_factors?.length > 0 && (
        <ul style={{ margin: '4px 0 0 0', paddingLeft: 14, fontSize: 10.5, color: '#64748b' }}>
          {prediction.top_factors.slice(0, 3).map((f) => <li key={f.label}>{f.label}</li>)}
        </ul>
      )}
      <p style={{ fontSize: 9.5, color: '#94a3b8', fontStyle: 'italic', margin: '6px 0 0 0' }}>
        Decision-support prediction based on historical patterns. Requires analyst validation.
      </p>
    </div>
  );
}
