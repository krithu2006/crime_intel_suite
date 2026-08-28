import { MapContainer, TileLayer, CircleMarker, Circle, Popup, ScaleControl, useMap } from 'react-leaflet';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.heat';
import MapPopupButton from './MapPopupButton.jsx';
import { useTranslation } from './LanguageContext.jsx';

// ── Heatmap layer ──────────────────────────────────────────────────────────
function HeatmapLayer({ points, options = {} }) {
  const map = useMap();
  const heatLayerRef = useRef(null);

  useEffect(() => {
    if (heatLayerRef.current) map.removeLayer(heatLayerRef.current);
    if (points.length === 0) return;
    const defaults = {
      radius: 12, blur: 14, maxZoom: 17, max: 10, minOpacity: 0.15,
      gradient: {
        0.1: '#2563eb88', 0.3: '#22d3ee99', 0.5: '#34d399aa',
        0.7: '#fbbf24bb', 0.9: '#f97316cc', 1.0: '#ef4444dd',
      },
    };
    const heat = L.heatLayer(points, { ...defaults, ...options });
    heat.addTo(map);
    heatLayerRef.current = heat;
    return () => { if (heatLayerRef.current) map.removeLayer(heatLayerRef.current); };
  }, [points, options, map]);

  return null;
}

function FitMapToHotspots({ clusters, points }) {
  const map = useMap();
  useEffect(() => {
    const locations = clusters.length
      ? clusters.map((c) => [c.centroid.lat, c.centroid.lng])
      : points.map((p) => [p.lat, p.lng]);
    if (!locations.length) return;
    map.fitBounds(locations, { padding: [36, 36], maxZoom: 9 });
  }, [clusters, points, map]);
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

function severityColor(level) {
  if (level === 'High') return '#ef4444';
  if (level === 'Medium') return '#f59e0b';
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
function HotspotMapInner({ hotspots, loading, mapStyle, setMapStyle }) {
  const { t } = useTranslation();
  const center = [14.5, 76.2];
  const [leafletMap, setLeafletMap] = useState(null);
  const onMap = useCallback((m) => setLeafletMap(m), []);

  const incidentPoints = hotspots?.points || [];
  const heatPoints = incidentPoints.map((p) => [p.lat, p.lng, p.severity || 5]);
  const clusterMarkers = hotspots?.clusters ? [...hotspots.clusters] : [];

  const hasData = incidentPoints.length > 0;
  const searchLabel = hasData
    ? `${clusterMarkers.length} ${t('searchHotspotsScope')}`
    : t('searchHotspotsPlaceholder');

  return (
    <div className="google-map-shell relative w-full h-full overflow-hidden border border-white/10">
      {loading && (
        <div className="absolute inset-0 z-[1000] bg-surface-900/80 backdrop-blur-sm flex items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <div className="w-8 h-8 border-3 border-primary-500/30 border-t-primary-400 rounded-full animate-spin" />
            <p className="text-sm text-slate-400">Computing hotspots...</p>
          </div>
        </div>
      )}

      {!loading && !hasData && (
        <div className="absolute inset-0 z-[999] flex items-center justify-center bg-surface-900/60 backdrop-blur-sm rounded-2xl">
          <div className="text-center p-8">
            <svg className="w-12 h-12 mx-auto mb-3 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
            </svg>
            <p className="text-sm font-medium text-slate-400">{t('noHotspotsFound')}</p>
            <p className="text-xs text-slate-600 mt-1">{t('noHotspotsHint')}</p>
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
        <FitMapToHotspots clusters={clusterMarkers} points={incidentPoints} />
        <HeatmapLayer points={heatPoints} />

        {clusterMarkers.map((cluster) => {
          const level = cluster.severity_level || 'Low';
          const color = severityColor(level);
          return (
            <Fragment key={cluster.cluster_id}>
              <Circle
                center={[cluster.centroid.lat, cluster.centroid.lng]}
                radius={Math.max(cluster.radius_m, 50)}
                pathOptions={{ color, fillColor: color, fillOpacity: 0.08, weight: 1, dashArray: '4 4' }}
              />
              <CircleMarker
                center={[cluster.centroid.lat, cluster.centroid.lng]}
                radius={Math.max(6, Math.min(20, cluster.incident_count / 4))}
                pathOptions={{ color, fillColor: color, fillOpacity: 0.5, weight: 2 }}
              >
                <Popup>
                  <div style={{ color: '#1e293b', minWidth: 180, fontFamily: 'Inter, sans-serif' }}>
                    <p style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>
                      {cluster.district || `Hotspot #${cluster.cluster_id + 1}`}
                    </p>
                    <p style={{ fontSize: 12, margin: '2px 0' }}><strong>Cluster:</strong> #{cluster.cluster_id + 1}</p>
                    <p style={{ fontSize: 12, margin: '2px 0' }}><strong>Incidents:</strong> {cluster.incident_count}</p>
                    <p style={{ fontSize: 12, margin: '2px 0' }}><strong>Dominant:</strong> {cluster.dominant_crime_type}</p>
                    <p style={{ fontSize: 12, margin: '2px 0' }}><strong>Avg Severity:</strong> {cluster.avg_severity}</p>
                    <p style={{ fontSize: 12, margin: '2px 0' }}><strong>Risk Score:</strong> {cluster.risk_score}</p>
                    <p style={{ fontSize: 12, margin: '2px 0' }}><strong>Cluster Severity:</strong> {level}</p>
                    <p style={{ fontSize: 12, margin: '2px 0' }}><strong>Radius:</strong> {cluster.radius_m}m</p>
                  </div>
                </Popup>
              </CircleMarker>
            </Fragment>
          );
        })}

        {clusterMarkers.length === 0 && incidentPoints.map((point) => (
          <CircleMarker
            key={point.id}
            center={[point.lat, point.lng]}
            radius={4}
            pathOptions={{ color: '#2563eb', fillColor: '#38bdf8', fillOpacity: 0.75, weight: 1 }}
          >
            <Popup>
              <div style={{ color: '#1e293b', fontFamily: 'Inter, sans-serif' }}>
                <p style={{ fontWeight: 700, marginBottom: 4 }}>{point.crime_type}</p>
                <p style={{ fontSize: 12, margin: 0 }}>Severity: {point.severity}/10</p>
                <p style={{ fontSize: 12, margin: '2px 0 0' }}>{new Date(point.timestamp).toLocaleDateString()}</p>
              </div>
            </Popup>
          </CircleMarker>
        ))}
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
        <p className="text-xs font-semibold text-slate-700 mb-2">{t('clusterSeverity')}</p>
        <div className="flex items-center gap-3 text-xs text-slate-600">
          {[['#22c55e', t('low')], ['#f59e0b', t('med')], ['#ef4444', t('high')]].map(([color, label]) => (
            <span key={label} className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full" style={{ backgroundColor: color }} />
              {label}
            </span>
          ))}
        </div>
      </div>

      {/* Stats overlay */}
      {hotspots && (
        <div className="google-map-card absolute right-4 top-4 z-[1000] hidden px-4 py-3 sm:block">
          <p className="text-xs font-semibold text-slate-700">
            {hotspots.n_clusters} {t('clustersCount')} &middot; {hotspots.n_incidents} {t('incidentsCount')}
          </p>
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
        <MapPopupButton title={t('hotspots')}>
          {() => (
            <HotspotMapInner
              hotspots={hotspots}
              loading={loading}
              mapStyle={mapStyle}
              setMapStyle={setMapStyle}
            />
          )}
        </MapPopupButton>
      </div>
    </div>
  );
}

// ── Main export ────────────────────────────────────────────────────────────
export default function HotspotMap({ hotspots, loading }) {
  const [mapStyle, setMapStyle] = useState('map');
  return (
    <HotspotMapInner
      hotspots={hotspots}
      loading={loading}
      mapStyle={mapStyle}
      setMapStyle={setMapStyle}
    />
  );
}
