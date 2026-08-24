import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { API_URL } from './config.js';
import HotspotMap from './HotspotMap.jsx';
import RiskScoreMap from './RiskScoreMap.jsx';
import RisingZones from './RisingZones.jsx';
import { NetworkGraph, NetworkSidebar } from './NetworkView.jsx';
import { HorizonSelector, ModelPerformanceCard, PredictiveRiskBlock, PREDICTION_DISCLAIMER, DEFAULT_HORIZON } from './PredictiveRisk.jsx';
import TrendsPanel from './TrendsPanel.jsx';
import AlertsPanel from './AlertsPanel.jsx';
import DrilldownPanel from './DrilldownPanel.jsx';
import IntelligenceBrief from './IntelligenceBrief.jsx';
import FeatureModal from './FeatureModal.jsx';
import SettingsPopover from './SettingsPopover.jsx';

// AppSail suspends the backend instance when it is idle, so the first request
// after a cold start can fail or hang for several seconds. The dashboard polls
// /api/health until it answers before rendering or fetching anything else.
const WAKE_MAX_ATTEMPTS = 40;   // ≈100s of cold-start headroom at WAKE_RETRY_MS
const WAKE_RETRY_MS = 2500;
const WAKE_TIMEOUT_MS = 8000;   // cap one attempt so a hung socket can't stall the loop

const FEATURE_LABELS = {
  hotspots: 'Hotspots',
  risk: 'Predictive Risk',
  network: 'Criminal Network',
  trends: 'Trends & Anomalies',
  alerts: 'Intelligence Alerts',
  brief: 'Intelligence Brief',
  drilldown: 'District Intelligence',
};

function getInitialTheme() {
  try {
    return localStorage.getItem('crime-intel-theme') === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

function formatMetric(value, decimals = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 'Not available';
  return number.toLocaleString('en-IN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function formatNotificationDate(iso) {
  if (!iso) return 'Recently detected';
  return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function App() {
  const [theme, setTheme] = useState(getInitialTheme);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [health, setHealth] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  // >0 once a health probe has failed, i.e. the backend is waking from sleep.
  const [wakeAttempt, setWakeAttempt] = useState(0);

  // Module 2 state
  const [hotspots, setHotspots] = useState(null);
  const [hotspotsLoading, setHotspotsLoading] = useState(false);
  const [escalation, setEscalation] = useState(null);
  const [escalationLoading, setEscalationLoading] = useState(false);

  // Module 3 state
  const [riskScores, setRiskScores] = useState(null);
  const [riskLoading, setRiskLoading] = useState(false);

  // Module 3b state — predictive (future-window) risk
  const [predictions, setPredictions] = useState(null);
  const [predictionsLoading, setPredictionsLoading] = useState(false);
  const [horizonDays, setHorizonDays] = useState(DEFAULT_HORIZON);

  // Module 5 state — trend analysis + anomaly detection (distinct from
  // predictions above: this describes what already happened, not a forecast)
  const [trends, setTrends] = useState(null);
  const [trendsLoading, setTrendsLoading] = useState(false);
  const [trendGranularity, setTrendGranularity] = useState('weekly');

  // Module 4 state
  const [network, setNetwork] = useState(null);
  const [networkLoading, setNetworkLoading] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState(null);

  // Module 6 state — Intelligence Alert Center
  const [alertsData, setAlertsData] = useState(null);
  const [alertsLoading, setAlertsLoading] = useState(false);
  const [alertSeverityFilter, setAlertSeverityFilter] = useState('ALL');
  const [alertStatusFilter, setAlertStatusFilter] = useState('ACTIVE');
  const [unreadAlertCount, setUnreadAlertCount] = useState(0);
  const [notifications, setNotifications] = useState([]);
  const [notificationSeverityCounts, setNotificationSeverityCounts] = useState({});
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const notificationRef = useRef(null);
  const [selectedAlertId, setSelectedAlertId] = useState(null);
  const selectedAlertTimer = useRef(null);

  // View toggle: 'hotspots', 'risk', 'network', 'trends', or 'alerts'
  const [mapView, setMapView] = useState('hotspots');
  const [activeFeature, setActiveFeature] = useState(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('crime-intel-theme', theme); } catch { /* storage may be unavailable */ }
  }, [theme]);

  // Date range
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  // District filter
  const [districtsList, setDistrictsList] = useState([]);
  const [selectedDistrict, setSelectedDistrict] = useState('');
  const [crimeTypes, setCrimeTypes] = useState([]);
  const [selectedCrimeType, setSelectedCrimeType] = useState('');

  // Ward scope — set by alert navigation or by drilling into a ward (Module
  // 7). Clearable via the chip next to the filters, or the breadcrumb.
  const [selectedWard, setSelectedWard] = useState(null); // { id, name, district } | null

  // Module 7 state — District & Ward Intelligence Drilldown
  const [districtDrilldown, setDistrictDrilldown] = useState(null);
  const [districtDrilldownLoading, setDistrictDrilldownLoading] = useState(false);
  const [wardDrilldown, setWardDrilldown] = useState(null);
  const [wardDrilldownLoading, setWardDrilldownLoading] = useState(false);
  const [brief, setBrief] = useState(null);
  const [briefLoading, setBriefLoading] = useState(false);
  const [briefError, setBriefError] = useState(null);

  // ── Wake the backend, then fetch health ──
  // /api/health is the lightest endpoint, so it doubles as the wake-up ping.
  // Nothing else renders or fetches until this resolves — see the `loading`
  // branch below and the `health` guard on every other effect.
  useEffect(() => {
    let cancelled = false;
    let retryTimer = null;
    let attempts = 0;

    const loadHealth = () => {
      attempts += 1;
      fetch(`${API_URL}/api/health`, { signal: AbortSignal.timeout(WAKE_TIMEOUT_MS) })
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        })
        .then((data) => {
          if (cancelled) return;
          setHealth(data);
          setError(null);
          setLoading(false);
        })
        .catch((err) => {
          if (cancelled) return;
          if (attempts < WAKE_MAX_ATTEMPTS) {
            // A failed probe means the instance is asleep or still booting.
            setWakeAttempt(attempts);
            retryTimer = window.setTimeout(loadHealth, WAKE_RETRY_MS);
            return;
          }
          setError(err.message);
          setLoading(false);
        });
    };

    loadHealth();

    return () => {
      cancelled = true;
      if (retryTimer) window.clearTimeout(retryTimer);
    };
  }, []);

  // Gated on `health`: firing this before the backend is awake used to fail
  // silently and leave the Crime Type dropdown empty for the whole session.
  useEffect(() => {
    if (!health) return;
    fetch(`${API_URL}/api/crime-types`)
      .then((res) => res.ok ? res.json() : null)
      .then((data) => { if (data?.data) setCrimeTypes(data.data); })
      .catch(() => setCrimeTypes([]));
  }, [health]);

  // New imports can have a different date range. Start the dashboard with the
  // range reported by the data source instead of a hard-coded historic year.
  useEffect(() => {
    if (!health?.date_range) return;
    setDateFrom((current) => current || health.date_range.from?.slice(0, 10) || '');
    setDateTo((current) => current || health.date_range.to?.slice(0, 10) || '');
  }, [health]);

  // ── Fetch districts ──
  // Gated on `health` for the same reason as the crime types above.
  useEffect(() => {
    if (!health) return;
    fetch(`${API_URL}/api/districts`)
      .then((res) => { if (res.ok) return res.json(); })
      .then((data) => { if (data?.data) setDistrictsList(data.data); })
      .catch(console.error);
  }, [health]);

  // ── Fetch hotspots ──
  // NOTE: every fetch callback lists selectedCrimeType in its dependency
  // array. Without it, useCallback captures a stale (empty) crime type and
  // the filter silently does nothing — which was the original Crime Type bug.
  const fetchHotspots = useCallback(() => {
    setHotspotsLoading(true);
    const params = new URLSearchParams();
    if (dateFrom) params.set('from', dateFrom);
    if (dateTo) params.set('to', dateTo);
    if (selectedDistrict) params.set('district', selectedDistrict);
    if (selectedCrimeType) params.set('crime_type', selectedCrimeType);
    fetch(`${API_URL}/api/hotspots?${params}`)
      .then((res) => res.json())
      .then((data) => { setHotspots(data); setHotspotsLoading(false); })
      .catch(() => setHotspotsLoading(false));
  }, [dateFrom, dateTo, selectedDistrict, selectedCrimeType]);

  // ── Fetch escalation ──
  // Escalation is a minor-crime early-warning signal (Dispute/Vandalism/Eve
  // Teasing by definition), so it is intentionally NOT scoped by crime type.
  const fetchEscalation = useCallback(() => {
    setEscalationLoading(true);
    const params = new URLSearchParams({ period: 'monthly' });
    if (dateFrom) params.set('from', dateFrom);
    if (dateTo) params.set('to', dateTo);
    if (selectedDistrict) params.set('district', selectedDistrict);
    fetch(`${API_URL}/api/escalation?${params}`)
      .then((res) => res.json())
      .then((data) => { setEscalation(data); setEscalationLoading(false); })
      .catch(() => setEscalationLoading(false));
  }, [dateFrom, dateTo, selectedDistrict]);

  // ── Fetch risk scores ──
  const fetchRiskScores = useCallback(() => {
    setRiskLoading(true);
    const params = new URLSearchParams();
    if (dateFrom) params.set('from', dateFrom);
    if (dateTo) params.set('to', dateTo);
    if (selectedDistrict) params.set('district', selectedDistrict);
    if (selectedCrimeType) params.set('crime_type', selectedCrimeType);
    fetch(`${API_URL}/api/risk-scores?${params}`)
      .then((res) => res.json())
      .then((data) => { setRiskScores(data); setRiskLoading(false); })
      .catch(() => setRiskLoading(false));
  }, [dateFrom, dateTo, selectedDistrict, selectedCrimeType]);

  // ── Fetch predictions ──
  // The prediction anchor is the selected "To" date (or the latest data if
  // none is set) — see prediction.py's `as_of`. District/ward/crime-type
  // filters are passed through so the forecast scope always matches what
  // the analyst is looking at.
  const fetchPredictions = useCallback(() => {
    setPredictionsLoading(true);
    const params = new URLSearchParams({ prediction_horizon: String(horizonDays) });
    if (dateTo) params.set('to', dateTo);
    if (selectedDistrict) params.set('district', selectedDistrict);
    if (selectedCrimeType) params.set('crime_type', selectedCrimeType);
    if (selectedWard) params.set('ward_id', String(selectedWard.id));
    fetch(`${API_URL}/api/predictions/risk?${params}`)
      .then((res) => res.json())
      .then((data) => { setPredictions(data); setPredictionsLoading(false); })
      .catch(() => setPredictionsLoading(false));
  }, [dateTo, selectedDistrict, selectedCrimeType, selectedWard, horizonDays]);

  // ── Fetch trends ──
  const fetchTrends = useCallback(() => {
    setTrendsLoading(true);
    const params = new URLSearchParams({ granularity: trendGranularity });
    if (dateFrom) params.set('from', dateFrom);
    if (dateTo) params.set('to', dateTo);
    if (selectedDistrict) params.set('district', selectedDistrict);
    if (selectedCrimeType) params.set('crime_type', selectedCrimeType);
    if (selectedWard) params.set('ward_id', String(selectedWard.id));
    fetch(`${API_URL}/api/trends?${params}`)
      .then((res) => res.json())
      .then((data) => { setTrends(data); setTrendsLoading(false); })
      .catch(() => setTrendsLoading(false));
  }, [dateFrom, dateTo, selectedDistrict, selectedCrimeType, selectedWard, trendGranularity]);

  // ── Fetch alerts (Module 6 — lazy, only while the Alerts tab is open) ──
  const fetchAlerts = useCallback(() => {
    setAlertsLoading(true);
    const params = new URLSearchParams({ granularity: trendGranularity });
    if (dateFrom) params.set('from', dateFrom);
    if (dateTo) params.set('to', dateTo);
    if (selectedDistrict) params.set('district', selectedDistrict);
    if (selectedCrimeType) params.set('crime_type', selectedCrimeType);
    if (selectedWard) params.set('ward_id', String(selectedWard.id));
    if (alertSeverityFilter && alertSeverityFilter !== 'ALL') params.set('severity', alertSeverityFilter);
    if (alertStatusFilter && alertStatusFilter !== 'ACTIVE') params.set('status', alertStatusFilter);
    fetch(`${API_URL}/api/alerts?${params}`)
      .then((res) => res.json())
      .then((data) => { setAlertsData(data); setAlertsLoading(false); })
      .catch(() => setAlertsLoading(false));
  }, [dateFrom, dateTo, selectedDistrict, selectedCrimeType, selectedWard, trendGranularity,
      alertSeverityFilter, alertStatusFilter]);

  // Notification state is global and independent from investigation status.
  const fetchUnreadAlertCount = useCallback(() => {
    fetch(`${API_URL}/api/notifications/count`)
      .then((res) => res.json())
      .then((data) => setUnreadAlertCount(data?.unread_count ?? 0))
      .catch(() => {});
  }, []);

  const fetchNotifications = useCallback(() => {
    fetch(`${API_URL}/api/notifications?limit=5`)
      .then((res) => res.json())
      .then((data) => {
        setNotifications(data?.alerts || []);
        setNotificationSeverityCounts(data?.severity_counts || {});
        setUnreadAlertCount(data?.unread_count ?? 0);
      })
      .catch(() => {});
  }, []);

  // ── Fetch district/ward drilldown (Module 7 — lazy, only while that tab
  // is open, and only one of the two depending on whether a ward is picked) ──
  const fetchDistrictDrilldown = useCallback(() => {
    if (!selectedDistrict) return;
    setDistrictDrilldownLoading(true);
    const params = new URLSearchParams({ granularity: trendGranularity, prediction_horizon: String(horizonDays) });
    if (selectedCrimeType) params.set('crime_type', selectedCrimeType);
    if (dateFrom) params.set('from', dateFrom);
    if (dateTo) params.set('to', dateTo);
    fetch(`${API_URL}/api/drilldown/district/${encodeURIComponent(selectedDistrict)}?${params}`)
      .then((res) => res.json())
      .then((data) => { setDistrictDrilldown(data); setDistrictDrilldownLoading(false); })
      .catch(() => setDistrictDrilldownLoading(false));
  }, [selectedDistrict, selectedCrimeType, dateFrom, dateTo, trendGranularity, horizonDays]);

  const fetchWardDrilldown = useCallback(() => {
    if (!selectedWard) return;
    setWardDrilldownLoading(true);
    const params = new URLSearchParams({ granularity: trendGranularity, prediction_horizon: String(horizonDays) });
    if (selectedCrimeType) params.set('crime_type', selectedCrimeType);
    if (dateFrom) params.set('from', dateFrom);
    if (dateTo) params.set('to', dateTo);
    fetch(`${API_URL}/api/drilldown/ward/${selectedWard.id}?${params}`)
      .then((res) => res.json())
      .then((data) => {
        setWardDrilldown(data);
        setWardDrilldownLoading(false);
        // Back-fill district context if the ward was selected without one
        // (e.g. from a district-unfiltered alert) — the ward response's
        // district is authoritative, straight from the Ward record.
        if (data.status === 'ok' && data.district) {
          setSelectedDistrict((cur) => cur || data.district);
          setSelectedWard((cur) => (cur && !cur.district ? { ...cur, district: data.district } : cur));
        }
      })
      .catch(() => setWardDrilldownLoading(false));
  }, [selectedWard, selectedCrimeType, dateFrom, dateTo, trendGranularity, horizonDays]);

  // ── Fetch network ──
  const fetchNetwork = useCallback(() => {
    setNetworkLoading(true);
    const params = new URLSearchParams();
    if (dateFrom) params.set('from', dateFrom);
    if (dateTo) params.set('to', dateTo);
    if (selectedDistrict) params.set('district', selectedDistrict);
    if (selectedCrimeType) params.set('crime_type', selectedCrimeType);
    fetch(`${API_URL}/api/network?${params}`)
      .then((res) => res.json())
      .then((data) => { setNetwork(data); setNetworkLoading(false); })
      .catch(() => setNetworkLoading(false));
  }, [dateFrom, dateTo, selectedDistrict, selectedCrimeType]);

  // Auto-fetch on load and whenever any filter (date/district/crime type)
  // changes — the fetch callbacks are memoized on those filters, so a filter
  // change gives them new identities and re-triggers this effect. That is what
  // makes changing the Crime Type dropdown immediately update every view.
  useEffect(() => {
    if (health && !error) {
      fetchHotspots();
      fetchEscalation();
      fetchRiskScores();
      fetchPredictions();
      fetchNetwork();
    }
  }, [health, error, fetchHotspots, fetchEscalation, fetchRiskScores, fetchPredictions, fetchNetwork]);

  // Trends is fetched lazily — only while that tab is active — since it's
  // a heavier analytics call and there's no map/chart to keep in sync when
  // the tab isn't visible. Re-fetches whenever filters or granularity change
  // while the tab is open.
  useEffect(() => {
    if (health && !error && mapView === 'trends') {
      fetchTrends();
    }
  }, [health, error, mapView, fetchTrends]);

  // Alerts is fetched lazily too, for the same reason as Trends.
  useEffect(() => {
    if (health && !error && mapView === 'alerts') {
      fetchAlerts();
    }
  }, [health, error, mapView, fetchAlerts]);

  // Drilldown: fetch ward-level data when a ward is selected, otherwise
  // district-level — never both, and never anything with no district picked
  // (that state shows the district selector instead, see DrilldownPanel).
  useEffect(() => {
    if (health && !error && mapView === 'drilldown') {
      if (selectedWard) fetchWardDrilldown();
      else if (selectedDistrict) fetchDistrictDrilldown();
    }
  }, [health, error, mapView, selectedWard, selectedDistrict, fetchWardDrilldown, fetchDistrictDrilldown]);

  // Fetch on startup and periodically so newly generated alerts appear.
  useEffect(() => {
    if (health && !error) {
      fetchUnreadAlertCount();
      const timer = window.setInterval(fetchUnreadAlertCount, 60000);
      return () => window.clearInterval(timer);
    }
  }, [health, error, fetchUnreadAlertCount]);

  useEffect(() => {
    if (!notificationsOpen) return undefined;
    fetchNotifications();
    const closeOnOutsideClick = (event) => {
      if (!notificationRef.current?.contains(event.target)) setNotificationsOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    return () => document.removeEventListener('mousedown', closeOnOutsideClick);
  }, [notificationsOpen, fetchNotifications]);

  // A status change updates the local list immediately (no full refetch) and
  // Workflow status remains independent from notification read state.
  const handleAlertStatusChange = useCallback((alertId, newStatus) => {
    return fetch(`${API_URL}/api/alerts/${encodeURIComponent(alertId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus }),
    })
      .then((res) => res.json())
      .then((updated) => {
        if (updated?.error) throw new Error(updated.error);
        setAlertsData((prev) => {
          if (!prev) return prev;
          const nextAlerts = prev.alerts.map((a) => (a.id === alertId ? { ...a, status: updated.status, note: updated.note } : a));
          return { ...prev, alerts: nextAlerts };
        });
        return updated;
      });
  }, []);

  const handleAlertRead = useCallback((alertId) => {
    return fetch(`${API_URL}/api/alerts/${encodeURIComponent(alertId)}/read`, { method: 'PATCH' })
      .then((res) => res.json())
      .then((result) => {
        if (!result?.success) throw new Error('Could not mark alert read');
        setAlertsData((prev) => prev ? {
          ...prev,
          alerts: prev.alerts.map((alert) => alert.id === alertId ? { ...alert, is_read: true, read_at: result.read_at } : alert),
        } : prev);
        setNotifications((prev) => {
          const readAlert = prev.find((alert) => alert.id === alertId);
          if (readAlert?.severity) {
            setNotificationSeverityCounts((counts) => ({ ...counts, [readAlert.severity]: Math.max(0, (counts[readAlert.severity] || 0) - 1) }));
          }
          return prev.filter((alert) => alert.id !== alertId);
        });
        setUnreadAlertCount((count) => Math.max(0, count - 1));
        fetchUnreadAlertCount();
        return result;
      });
  }, [fetchUnreadAlertCount]);

  const handleMarkAllRead = useCallback(() => {
    return fetch(`${API_URL}/api/notifications/read-all`, { method: 'PATCH' })
      .then((res) => res.json())
      .then((result) => {
        if (!result?.success) throw new Error('Could not mark all alerts read');
        setUnreadAlertCount(0);
        setNotifications([]);
        setNotificationSeverityCounts({});
        setAlertsData((prev) => prev ? {
          ...prev,
          alerts: prev.alerts.map((alert) => ({ ...alert, is_read: true })),
        } : prev);
        fetchUnreadAlertCount();
        return result;
      });
  }, [fetchUnreadAlertCount]);

  // Navigate from an alert into the relevant existing module, preserving
  // district/crime-type/ward scope so the analyst lands in the right context.
  const openFeature = useCallback((view) => {
    setMapView(view);
    setActiveFeature(view);
    setSettingsOpen(false);
  }, []);
  const closeFeature = useCallback(() => setActiveFeature(null), []);

  const openAlertFromNotification = useCallback((alert) => {
    setSelectedDistrict(alert.district || '');
    setSelectedCrimeType(alert.crime_type || '');
    setSelectedWard(alert.ward_id != null ? { id: alert.ward_id, name: alert.ward, district: alert.district } : null);
    setDateFrom('');
    setDateTo('');
    setAlertSeverityFilter('ALL');
    setAlertStatusFilter('ALL');
    setSelectedAlertId(alert.id);
    if (selectedAlertTimer.current) window.clearTimeout(selectedAlertTimer.current);
    selectedAlertTimer.current = window.setTimeout(() => setSelectedAlertId(null), 3000);
    setNotificationsOpen(false);
    openFeature('alerts');
  }, [openFeature]);

  const handleAlertNavigate = useCallback((action, alert) => {
    setSelectedDistrict(alert.district || '');
    setSelectedCrimeType(alert.crime_type || '');
    setSelectedWard(alert.ward_id != null ? { id: alert.ward_id, name: alert.ward, district: alert.district } : null);
    if (action === 'view_trend') openFeature('trends');
    else if (action === 'view_risk') {
      openFeature('risk');
      if (alert.prediction_horizon_days) setHorizonDays(alert.prediction_horizon_days);
    } else if (action === 'view_hotspot') openFeature('hotspots');
    else if (action === 'view_network') openFeature('network');
  }, [openFeature]);

  // ── Module 7 — the ONE way any module selects a ward (district ward
  // table, risk card, hotspot popup, alert) so there's never more than one
  // ward-selection system. Also locks in the ward's district, since a ward
  // without its district doesn't make sense as a filter.
  const selectWard = useCallback((wardId, wardName, district) => {
    setSelectedDistrict(district || '');
    setSelectedWard({ id: wardId, name: wardName, district: district || '' });
    openFeature('drilldown');
  }, [openFeature]);

  const clearWard = useCallback(() => setSelectedWard(null), []);
  const clearToKarnataka = useCallback(() => {
    setSelectedDistrict('');
    setSelectedWard(null);
  }, []);

  // A district change must never leave an "impossible" ward selected —
  // clear it unless the ward actually belongs to the newly selected district.
  useEffect(() => {
    if (selectedWard && selectedWard.district && selectedWard.district !== selectedDistrict) {
      setSelectedWard(null);
    }
  }, [selectedDistrict]); // eslint-disable-line react-hooks/exhaustive-deps

  // Generic "jump into another module, keeping district/ward/crime-type
  // scope" — used by the drilldown's Trend/Risk/Alerts/Hotspot/Network quick
  // links (Phase 3's handleAlertNavigate is the same idea, scoped to an alert).
  const goToView = useCallback((view, options = {}) => {
    openFeature(view);
    if (options.horizonDays) setHorizonDays(options.horizonDays);
  }, [openFeature]);

  const fetchBrief = useCallback(() => {
    if (!selectedDistrict && !selectedWard) { setBrief(null); return; }
    setBriefLoading(true); setBriefError(null);
    const params = new URLSearchParams({ prediction_horizon: String(horizonDays), granularity: trendGranularity });
    if (selectedDistrict) params.set('district', selectedDistrict);
    if (selectedWard) params.set('ward_id', String(selectedWard.id));
    if (selectedCrimeType) params.set('crime_type', selectedCrimeType);
    if (dateFrom) params.set('from', dateFrom);
    if (dateTo) params.set('to', dateTo);
    fetch(`${API_URL}/api/intelligence-brief?${params}`).then((r) => r.json())
      .then((data) => { setBrief(data); setBriefLoading(false); })
      .catch((e) => { setBriefError(e.message); setBriefLoading(false); });
  }, [selectedDistrict, selectedWard, selectedCrimeType, dateFrom, dateTo, horizonDays, trendGranularity]);

  useEffect(() => { if (health && !error && mapView === 'brief') fetchBrief(); }, [health, error, mapView, fetchBrief]);

  // predictions keyed by ward_id for O(1) lookup from ward cards/popups
  const predictionsByWard = useMemo(() => {
    const map = new Map();
    for (const p of predictions?.predictions || []) map.set(p.ward_id, p);
    return map;
  }, [predictions]);

  // A selected offender may not exist after re-filtering the network, so clear
  // the selection whenever the district or crime-type filter changes.
  useEffect(() => {
    setSelectedNodeId(null);
  }, [selectedDistrict, selectedCrimeType]);

  // Determine side panel content based on map view
  let sidePanel = null;
  if (mapView === 'hotspots') {
    sidePanel = <RisingZones hotspots={hotspots} loading={hotspotsLoading} />;
  } else if (mapView === 'risk') {
    sidePanel = (
      <RiskRankings
        riskScores={riskScores}
        loading={riskLoading}
        predictionsByWard={predictionsByWard}
        modelPerformance={predictions?.model_performance}
        predictionsLoading={predictionsLoading}
        highlightWardId={selectedWard?.id}
        onSelectWard={selectWard}
      />
    );
  } else if (mapView === 'network') {
    sidePanel = <NetworkSidebar
      selectedNodeId={selectedNodeId}
      network={network}
      onClear={() => setSelectedNodeId(null)}
      onNodeSelect={setSelectedNodeId}
      filters={{ district: selectedDistrict, crimeType: selectedCrimeType, from: dateFrom, to: dateTo }}
    />;
  }

  const availableFrom = health?.date_range?.from?.slice(0, 10) || '';
  const availableTo = health?.date_range?.to?.slice(0, 10) || '';
  const quickRanges = availableFrom && availableTo
    ? [
        { label: 'Full range', from: availableFrom, to: availableTo },
      ]
    : [];

  return (
    <div className="app-shell min-h-screen flex flex-col">
      {/* ── Header ── */}
      <header className="app-header border-b border-white/10 sticky top-0">
        <div className="dashboard-container app-header__inner">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-xl bg-gradient-to-br from-primary-500 to-accent-cyan flex items-center justify-center shadow-glow flex-shrink-0">
              <svg className="w-5 h-5 sm:w-6 sm:h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
            </div>
            <div className="min-w-0">
              <h1 className="text-lg sm:text-xl font-bold tracking-tight gradient-text truncate">Crime Intel Suite</h1>
              <p className="text-[10px] sm:text-xs text-slate-500 font-medium truncate">Karnataka State Police — Intelligence Dashboard</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 sm:gap-2 flex-shrink-0">
            {!loading && !error && (
              <div className="notification-menu" ref={notificationRef}>
                <button
                  type="button"
                  onClick={() => setNotificationsOpen((open) => !open)}
                  className="notification-bell relative flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-sm text-slate-300 transition-colors hover:border-primary-400/40 hover:bg-primary-500/10 hover:text-white"
                  aria-label={`Notifications${unreadAlertCount ? `, ${unreadAlertCount} unread` : ''}`}
                  aria-expanded={notificationsOpen}
                  title="Notifications"
                >
                  <span aria-hidden="true">🔔</span>
                  {unreadAlertCount > 0 && (
                    <span key={unreadAlertCount} className="notification-badge badge bg-rose-500/90 text-white text-[10px] px-1.5 py-0 min-w-[18px] justify-center">
                      {unreadAlertCount}
                    </span>
                  )}
                </button>
                {notificationsOpen && (
                  <div className="notification-dropdown" role="dialog" aria-label="Notifications">
                    <div className="notification-dropdown__header">
                      <div>
                        <strong>Notifications</strong>
                        <p>{unreadAlertCount === 0 ? 'No new alerts' : `${unreadAlertCount} new alert${unreadAlertCount === 1 ? '' : 's'}`}</p>
                      </div>
                    </div>
                    <div className="notification-summary">
                      {['CRITICAL', 'HIGH', 'MEDIUM'].map((severity) => (
                        <span key={severity} className={`notification-summary__item notification-summary__item--${severity.toLowerCase()}`}>
                          <b>{notificationSeverityCounts[severity] || 0}</b> {severity[0] + severity.slice(1).toLowerCase()}
                        </span>
                      ))}
                    </div>
                    <div className="notification-dropdown__list">
                      {notifications.length === 0 ? (
                        <p className="notification-dropdown__empty">You’re all caught up.</p>
                      ) : notifications.map((alert) => (
                        <button key={alert.id} type="button" className="notification-item" onClick={() => {
                          handleAlertRead(alert.id).then(() => openAlertFromNotification(alert)).catch(() => {});
                        }}>
                          <span className={`notification-item__dot notification-item__dot--${alert.severity?.toLowerCase() || 'low'}`} aria-hidden="true" />
                          <span>
                            <span className={`notification-item__severity notification-item__severity--${alert.severity?.toLowerCase() || 'low'}`}>{alert.severity || 'ALERT'}</span>
                            <strong>{alert.title}</strong>
                            <small>{[alert.district, alert.ward].filter(Boolean).join(' · ')}</small>
                            <small>{alert.description || alert.type} · {formatNotificationDate(alert.period || alert.detected_at)}</small>
                            <small className="notification-item__action">Click to investigate →</small>
                          </span>
                        </button>
                      ))}
                    </div>
                    <button type="button" className="notification-dropdown__footer" onClick={() => {
                      setNotificationsOpen(false);
                      openFeature('alerts');
                    }}>View all alerts <span aria-hidden="true">→</span></button>
                  </div>
                )}
              </div>
            )}
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="header-settings-button"
              aria-label="Open settings"
              title="Settings"
            >
              <span aria-hidden="true">⚙</span>
              <span className="hidden lg:inline">Settings</span>
            </button>
            {loading ? (
              <span className="badge bg-yellow-500/20 text-yellow-300 border border-yellow-500/30">
                <span className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse"></span>
                <span className="hidden sm:inline">Connecting...</span>
              </span>
            ) : error ? (
              <span className="badge bg-rose-500/20 text-rose-300 border border-rose-500/30">
                <span className="w-2 h-2 rounded-full bg-rose-400"></span>
                Offline
              </span>
            ) : (
              <span className="badge bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse-slow"></span>
                <span className="hidden sm:inline">Backend</span> Online
              </span>
            )}
            <span className="badge bg-amber-500/10 text-amber-300 border border-amber-500/20">
              <span className="w-2 h-2 rounded-full bg-amber-400"></span>
              <span className="hidden sm:inline">Synthetic</span> Demo Data
            </span>
          </div>
        </div>
      </header>

      {/* ── Main Content ── */}
      <main className="dashboard-container dashboard-main flex-1 w-full">
        {loading ? (
          <div className="flex items-center justify-center h-64">
            <div className="flex flex-col items-center gap-4">
              <div className="w-12 h-12 border-4 border-primary-500/30 border-t-primary-400 rounded-full animate-spin"></div>
              <p className="text-slate-400 text-sm">
                {wakeAttempt > 0
                  ? 'Starting backend... Please wait a few seconds.'
                  : 'Connecting to backend...'}
              </p>
              {wakeAttempt > 0 && (
                <p className="text-slate-500 text-xs">
                  The server sleeps when idle. Attempt {wakeAttempt} of {WAKE_MAX_ATTEMPTS}.
                </p>
              )}
            </div>
          </div>
        ) : error ? (
          <div className="glass-card p-8 text-center max-w-lg mx-auto animate-fade-in">
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-rose-500/20 flex items-center justify-center">
              <svg className="w-8 h-8 text-rose-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
            </div>
            <h2 className="text-xl font-semibold text-white mb-2">Backend Unreachable</h2>
            <p className="text-slate-400 mb-4">
              Could not connect to the API server. Make sure the backend is running on <code className="font-mono text-primary-400">{API_URL || '/api'}</code>.
            </p>
            <p className="text-sm text-slate-500 font-mono">Error: {error}</p>
          </div>
        ) : (
          <div className="animate-fade-in space-y-6">
            {/* ── Stats Row ── */}
            <div className="dashboard-kpis grid grid-cols-2 sm:grid-cols-4 gap-4">
              <StatCard icon="🚨" label="Incidents" value={health.incidents?.toLocaleString() ?? '—'}
                color="from-primary-500/20 to-primary-600/10" borderColor="border-primary-500/20" />
              <StatCard icon="👤" label="Accused" value={health.accused?.toLocaleString() ?? '—'}
                color="from-accent-cyan/20 to-accent-cyan/5" borderColor="border-cyan-500/20" />
              <StatCard icon="📍" label="Wards" value={health.wards?.toLocaleString() ?? '—'}
                color="from-accent-emerald/20 to-accent-emerald/5" borderColor="border-emerald-500/20" />
              <StatCard
                icon={mapView === 'risk' ? '🎯' : mapView === 'network' ? '🕸️' : mapView === 'trends' ? '📈' : mapView === 'alerts' ? '🚨' : mapView === 'drilldown' ? '🧭' : '🔥'}
                label={mapView === 'risk' ? 'High-Risk Wards' : mapView === 'network' ? 'Identified Groups' : mapView === 'trends' ? 'Anomalies Detected' : mapView === 'alerts' ? 'Active Alerts' : mapView === 'drilldown' ? 'Wards Ranked' : 'Hotspot Clusters'}
                value={mapView === 'risk'
                  ? (riskScores?.wards?.filter(w => w.risk_score >= 50).length?.toString() ?? '—')
                  : mapView === 'drilldown'
                  ? (districtDrilldown?.ward_rankings?.length?.toString() ?? '—')
                  : mapView === 'network'
                  ? (network?.summary?.n_communities?.toLocaleString() ?? '—')
                  : mapView === 'trends'
                  ? (trends?.anomalies?.length?.toString() ?? '—')
                  : mapView === 'alerts'
                  ? (alertsData?.summary?.total?.toString() ?? '—')
                  : (hotspots?.n_clusters?.toLocaleString() ?? '—')}
                color="from-accent-rose/20 to-accent-rose/5" borderColor="border-rose-500/20"
              />
            </div>

            {/* ── Controls Bar ── */}
            <div className="dashboard-metrics grid grid-cols-2 sm:grid-cols-5 gap-3 -mt-2">
              {[
                ['Total clusters', hotspots?.n_clusters ?? 0, 'text-sky-300'],
                ['High risk', (hotspots?.clusters || []).filter((cluster) => cluster.severity_level === 'High').length, 'text-rose-300'],
                ['Medium risk', (hotspots?.clusters || []).filter((cluster) => cluster.severity_level === 'Medium').length, 'text-amber-300'],
                ['Low risk', (hotspots?.clusters || []).filter((cluster) => cluster.severity_level === 'Low').length, 'text-emerald-300'],
                ['Average risk', riskScores?.wards?.length ? (riskScores.wards.reduce((sum, ward) => sum + ward.risk_score, 0) / riskScores.wards.length).toFixed(1) : '—', 'text-violet-300'],
              ].map(([label, value, color]) => (
                <div key={label} className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-2.5">
                  <p className="text-[10px] uppercase tracking-wide text-slate-500">{label}</p>
                  <p className={`mt-0.5 text-lg font-bold ${color}`}>{value}</p>
                </div>
              ))}
            </div>

            <div className="dashboard-controls glass-card">
              <div className="dashboard-launcher-row">
                <p className="dashboard-control-label">Intelligence workspaces</p>
                <div className="feature-launcher-grid" aria-label="Open an intelligence feature">
                {Object.entries(FEATURE_LABELS).map(([view, label]) => (
                  <button
                    key={view}
                    type="button"
                    onClick={() => openFeature(view)}
                    className={`feature-launcher ${mapView === view ? 'feature-launcher--active' : ''}`}
                  >
                    <span className="feature-launcher__dot" aria-hidden="true" />
                    {label}
                  </button>
                ))}
                </div>
              </div>

              <div className="dashboard-filter-row">

              {/* District Filter (always visible) */}
              <div className="flex items-center gap-2 border-l border-white/10 pl-4">
                <label className="text-xs text-slate-500">District</label>
                <select 
                  value={selectedDistrict} 
                  onChange={(e) => setSelectedDistrict(e.target.value)}
                  className="bg-surface-800 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white focus:border-primary-400 focus:ring-1 focus:ring-primary-400/30 outline-none"
                >
                  <option value="">All Districts</option>
                  {districtsList.map(d => (
                    <option key={d.id} value={d.district}>{d.district}</option>
                  ))}
                </select>
              </div>

              <div className="flex items-center gap-2">
                <label className="text-xs text-slate-500">Crime Type</label>
                <select
                  value={selectedCrimeType}
                  onChange={(e) => setSelectedCrimeType(e.target.value)}
                  className="bg-surface-800 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white focus:border-primary-400 focus:ring-1 focus:ring-primary-400/30 outline-none"
                >
                  <option value="">All Types</option>
                  {crimeTypes.map((crimeType) => <option key={crimeType} value={crimeType}>{crimeType}</option>)}
                </select>
              </div>

              {/* Ward scope — set by alert navigation or drilling into a ward */}
              {selectedWard && (
                <button
                  type="button"
                  onClick={clearWard}
                  className="flex items-center gap-1.5 rounded-full border border-primary-500/30 bg-primary-500/10 px-3 py-1 text-xs font-medium text-primary-200 hover:bg-primary-500/20 transition-colors"
                  title="Clear ward filter"
                >
                  Ward: {selectedWard.name}
                  <span aria-hidden="true">✕</span>
                </button>
              )}

              {/* Date range and refresh controls */}
              {
                <>
                  <div className="flex items-center gap-2 border-l border-white/10 pl-4">
                    <label className="text-xs text-slate-500">From</label>
                    <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
                      className="bg-surface-800 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white focus:border-primary-400 focus:ring-1 focus:ring-primary-400/30 outline-none" />
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-slate-500">To</label>
                    <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
                      className="bg-surface-800 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white focus:border-primary-400 focus:ring-1 focus:ring-primary-400/30 outline-none" />
                  </div>
                  <button onClick={() => {
                    fetchHotspots(); fetchEscalation(); fetchNetwork(); fetchRiskScores(); fetchPredictions();
                    if (mapView === 'trends') fetchTrends();
                    if (mapView === 'alerts') fetchAlerts();
                    if (mapView === 'drilldown') { if (selectedWard) fetchWardDrilldown(); else fetchDistrictDrilldown(); }
                  }} disabled={hotspotsLoading || escalationLoading || networkLoading || riskLoading || predictionsLoading}
                    className="px-4 py-1.5 rounded-lg bg-primary-600 hover:bg-primary-500 text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                    {hotspotsLoading || escalationLoading || networkLoading || riskLoading || predictionsLoading ? 'Computing...' : 'Update'}
                  </button>
                </>
              }

              {/* Prediction horizon selector — only meaningful in Risk Score View */}
              {mapView === 'risk' && (
                <div className="border-l border-white/10 pl-4">
                  <HorizonSelector value={horizonDays} onChange={setHorizonDays} />
                </div>
              )}

              {/* Risk score info tooltip */}
              {mapView === 'risk' && (
                <div className="flex items-center gap-2 text-xs text-slate-400">
                  <svg className="w-4 h-4 text-primary-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <span>
                    Descriptive Risk Score (0-100) reflects current incident history, offender presence,
                    socio-economic factors, and escalation trends. Predictive Risk below forecasts the next
                    {' '}{horizonDays} days from historical patterns. Click a ward for details.
                  </span>
                </div>
              )}

              {/* Data provenance note — always visible across all views */}
              <div className="flex items-center gap-1.5 text-[11px] text-slate-500 italic">
                <svg className="w-3.5 h-3.5 text-amber-500/60 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                This prototype uses synthetic data modeled on realistic Karnataka crime patterns. In production, this would integrate with CCTNS and existing e-FIR systems.
              </div>

              {/* Quick range buttons */}
              <div className="flex gap-1 ml-auto">
                {quickRanges.map(({ label, from, to }) => (
                  <button key={label}
                    onClick={() => { setDateFrom(from); setDateTo(to); }}
                    className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                      dateFrom === from && dateTo === to
                        ? 'bg-primary-500/30 text-primary-300 border border-primary-500/30'
                        : 'bg-white/5 text-slate-400 hover:bg-white/10 hover:text-slate-300 border border-transparent'
                    }`}
                  >{label}</button>
                ))}
              </div>
              </div>
            </div>

            {!activeFeature && (
              <section className="intelligence-overview glass-card" aria-labelledby="overview-title">
                <div className="intelligence-overview__intro">
                  <p className="section-eyebrow">Intelligence overview</p>
                  <h2 id="overview-title">Ready for focused analysis</h2>
                  <p>
                    Current scope: <strong>{selectedDistrict || 'Karnataka'}</strong>
                    <span aria-hidden="true"> · </span>
                    {selectedCrimeType || 'All Crime Types'}
                    {selectedWard ? ` · ${selectedWard.name}` : ''}
                  </p>
                  <button type="button" className="overview-primary-action" onClick={() => openFeature('drilldown')}>
                    Open District Intelligence <span aria-hidden="true">→</span>
                  </button>
                </div>
                <div className="overview-signals" aria-label="Quick signals">
                  {[
                    ['High-risk wards', riskScores?.wards?.filter((ward) => ward.risk_score >= 50).length ?? '—', 'signal-critical'],
                    ['Active hotspots', hotspots?.n_clusters ?? '—', 'signal-info'],
                    ['Average risk', riskScores?.wards?.length ? (riskScores.wards.reduce((sum, ward) => sum + ward.risk_score, 0) / riskScores.wards.length).toFixed(1) : '—', 'signal-predictive'],
                    ['Unread alerts', unreadAlertCount, 'signal-warning'],
                  ].map(([label, value, tone]) => (
                    <div key={label} className={`overview-signal glass-interactive ${tone}`}>
                      <p>{label}</p>
                      <strong>{value}</strong>
                    </div>
                  ))}
                </div>
                <div className="overview-quick-access">
                  <p className="dashboard-control-label">Quick access</p>
                  <div>
                    {[
                      ['risk', 'Predictive Risk'],
                      ['trends', 'Trends'],
                      ['alerts', 'Alerts'],
                      ['hotspots', 'Hotspots'],
                    ].map(([view, label]) => (
                      <button key={view} type="button" onClick={() => openFeature(view)}>{label}<span aria-hidden="true">↗</span></button>
                    ))}
                  </div>
                </div>
              </section>
            )}

            {activeFeature && (
              <FeatureModal title={FEATURE_LABELS[activeFeature]} onClose={closeFeature} variant={activeFeature}>
            {/* ── District Summary Card ──
                All figures below come from `hotspots`, `riskScores`, and
                `escalation` — the same three state objects the map, Rising
                Zones panel, and top stats row consume, all fetched with the
                same selectedDistrict/date/crime-type filters. Nothing here
                is recomputed from a different dataset. */}
            {activeFeature === 'drilldown' && selectedDistrict && districtsList.find(d => d.district === selectedDistrict) && (() => {
              const dInfo = districtsList.find(d => d.district === selectedDistrict);
              const dWards = riskScores?.wards || [];
              const highWards = dWards.filter(w => w.risk_score >= 50).length;
              const avgRisk = dWards.length > 0 ? (dWards.reduce((sum, w) => sum + w.risk_score, 0) / dWards.length).toFixed(1) : '—';
              const topWard = dWards.length > 0 ? [...dWards].sort((a, b) => b.risk_score - a.risk_score)[0] : null;

              const dClusters = hotspots?.clusters || [];
              const totalIncidents = hotspots?.n_incidents ?? 0;
              const totalHotspots = hotspots?.n_clusters ?? 0;
              const crimeBreakdown = {};
              for (const cluster of dClusters) {
                for (const [crimeType, cnt] of Object.entries(cluster.crime_breakdown || {})) {
                  crimeBreakdown[crimeType] = (crimeBreakdown[crimeType] || 0) + cnt;
                }
              }
              const dominantCrime = Object.entries(crimeBreakdown).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '—';

              const escWards = escalation?.wards || [];
              const risingCount = escWards.filter(w => w.trending_up).length;
              const crimeTrend = escWards.length === 0
                ? '—'
                : risingCount > 0
                ? `Rising (${risingCount} zone${risingCount === 1 ? '' : 's'})`
                : 'Stable';

              return (
                <div className="district-summary-strip glass-card p-5 rounded-xl mb-6 bg-primary-900/20 border-primary-500/20 flex flex-wrap items-center justify-between gap-5 view-transition">
                  <div>
                    <h2 className="text-lg font-bold text-white flex items-center gap-2">
                      <svg className="w-5 h-5 text-primary-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                      </svg>
                      {selectedDistrict} District Summary
                    </h2>
                    <p className="text-xs text-slate-400 mt-1">Viewing aggregated stats for the selected district.</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-6">
                    <div>
                      <p className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">Total Incidents</p>
                      <p className="text-lg font-bold text-sky-300">{totalIncidents.toLocaleString()}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">Total Hotspots</p>
                      <p className="text-lg font-bold text-cyan-300">{totalHotspots}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">Avg Risk</p>
                      <p className="text-lg font-bold text-orange-400">{avgRisk}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">Highest Risk Ward</p>
                      <p className="text-lg font-bold text-red-400 truncate max-w-[140px]">
                        {topWard ? `${topWard.ward_name} (${topWard.risk_score.toFixed(0)})` : '—'}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">Dominant Crime</p>
                      <p className="text-lg font-bold text-violet-300">{dominantCrime}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">Crime Trend</p>
                      <p className={`text-lg font-bold ${risingCount > 0 ? 'text-rose-400' : 'text-emerald-400'}`}>{crimeTrend}</p>
                    </div>
                    <div className="socio-economic-inset border-l border-white/10 pl-6 hidden lg:block">
                      <p className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">Socio-Economic</p>
                      <p className="text-xs text-slate-300 mt-1 leading-5">
                        Unemployment: <span className="font-semibold text-amber-300">{formatMetric(dInfo.unemployment_rate)}%</span>
                        <span className="text-slate-600"> &middot; </span>
                        Literacy: <span className="font-semibold text-emerald-300">{formatMetric(dInfo.literacy_rate)}%</span>
                        <span className="text-slate-600"> &middot; </span>
                        Density: <span className="font-semibold text-sky-300">{formatMetric(dInfo.population_density, 0)}/km²</span>
                      </p>
                      <p className="text-[10px] text-slate-500 italic mt-1">Contextual model features; their contribution appears in ward explanations. Correlation does not imply causation.</p>
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* ── Map + Side Panel (with view transition) ── */}
            {mapView === 'brief' ? (
              <IntelligenceBrief brief={brief} loading={briefLoading} error={briefError} onRefresh={fetchBrief} onNavigate={(action, item) => {
                if (action === 'view_ward') { selectWard(item.ward_id, item.ward_name, item.district || selectedDistrict); return; }
                const target = { view_trend: 'trends', view_risk: 'risk', view_alerts: 'alerts', view_hotspots: 'hotspots', view_network: 'network' }[action];
                if (target) goToView(target);
              }} />
            ) : mapView === 'trends' ? (
              <div className="view-transition">
                <TrendsPanel
                  trends={trends}
                  loading={trendsLoading}
                  granularity={trendGranularity}
                  onGranularityChange={setTrendGranularity}
                />
              </div>
            ) : mapView === 'alerts' ? (
              <div className="view-transition">
                <AlertsPanel
                  alertsData={alertsData}
                  loading={alertsLoading}
                  granularity={trendGranularity}
                  onGranularityChange={setTrendGranularity}
                  severityFilter={alertSeverityFilter}
                  onSeverityFilterChange={setAlertSeverityFilter}
                  statusFilter={alertStatusFilter}
                  onStatusFilterChange={setAlertStatusFilter}
                  onStatusChange={handleAlertStatusChange}
                  onAlertRead={handleAlertRead}
                  onMarkAllRead={handleMarkAllRead}
                  unreadCount={unreadAlertCount}
                  selectedAlertId={selectedAlertId}
                  onNavigate={handleAlertNavigate}
                  onSelectWard={selectWard}
                />
              </div>
            ) : mapView === 'drilldown' ? (
              <div className="view-transition">
                <DrilldownPanel
                  districtsList={districtsList}
                  selectedDistrict={selectedDistrict}
                  selectedWard={selectedWard}
                  onSelectDistrict={setSelectedDistrict}
                  onSelectWard={selectWard}
                  onClearWard={clearWard}
                  onClearToKarnataka={clearToKarnataka}
                  districtData={districtDrilldown}
                  districtLoading={districtDrilldownLoading}
                  wardData={wardDrilldown}
                  wardLoading={wardDrilldownLoading}
                  horizonDays={horizonDays}
                  onGoToView={goToView}
                />
              </div>
            ) : (
              <div className={`analysis-workspace feature-workspace feature-workspace--${mapView}`}>
                {/* Map/Graph takes 2/3 */}
                <div className="map-stage view-transition">
                  {mapView === 'hotspots'
                    ? <HotspotMap hotspots={hotspots} loading={hotspotsLoading} />
                    : mapView === 'risk'
                    ? <RiskScoreMap riskScores={riskScores} loading={riskLoading} predictionsByWard={predictionsByWard} />
                    : <NetworkGraph
                      network={network}
                      loading={networkLoading}
                      selectedNodeId={selectedNodeId}
                      onNodeSelect={setSelectedNodeId}
                      dateFrom={dateFrom}
                      dateTo={dateTo}
                    />
                  }
                </div>

                {/* Side panel takes 1/3 — consistent padding/rounding */}
                <div className="intelligence-sidebar glass-card p-4 sm:p-5 view-transition">
                  {sidePanel}
                </div>
              </div>
            )}
              </FeatureModal>
            )}

            {/* ── Date Range Info ── */}
            {health.date_range && (
              <div className="text-center text-xs text-slate-600">
                Dataset: {formatDate(health.date_range.from)} &mdash; {formatDate(health.date_range.to)}
              </div>
            )}
          </div>
        )}
      </main>

      {/* ── Footer ── */}
      <footer className="border-t border-white/5 py-4 text-center text-xs text-slate-600">
        Crime Intel Suite v0.4 — Karnataka State Police Datathon
      </footer>

      <AiAssistantWidget
        health={health}
        hotspots={hotspots}
        escalation={escalation}
        riskScores={riskScores}
        network={network}
        mapView={mapView}
        selectedDistrict={selectedDistrict}
        selectedWard={selectedWard}
        selectedCrimeType={selectedCrimeType}
        dateFrom={dateFrom}
        dateTo={dateTo}
        horizonDays={horizonDays}
        trendGranularity={trendGranularity}
        onNavigate={(action, item) => {
          if (action === 'view_ward' && item?.ward_id != null) { selectWard(item.ward_id, item.ward_name || item.name, item.district || selectedDistrict); return; }
          const target = { view_brief: 'brief', view_district: 'drilldown', view_trend: 'trends', view_risk: 'risk', view_alerts: 'alerts', view_hotspots: 'hotspots', view_network: 'network' }[action];
          if (target) openFeature(target);
        }}
      />
      {settingsOpen && (
        <SettingsPopover
          theme={theme}
          onThemeChange={setTheme}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}

// ── Risk Rankings side panel (shown when Risk Score View is active) ──
// Shows two distinct things per the Descriptive vs Predictive Risk split:
// the existing descriptive risk_scoring.py ranking (current-window index),
// and — from the new prediction.py pipeline — a Model Performance summary
// plus a per-ward Predictive Risk block sourced from `predictionsByWard`.
function RiskRankings({ riskScores, loading, predictionsByWard, modelPerformance, predictionsLoading, highlightWardId, onSelectWard }) {
  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-3 border-amber-500/30 border-t-amber-400 rounded-full animate-spin"></div>
          <p className="text-sm text-slate-400">Computing risk scores...</p>
        </div>
      </div>
    );
  }

  if (!riskScores?.wards) return <div className="text-slate-500 text-sm text-center">No data</div>;

  // Alert-driven navigation focuses the list on a single ward so its
  // Predictive Risk block is immediately visible instead of buried in a
  // 100+ ward ranking. Clear the "Ward: X" chip to return to the full list.
  const wards = highlightWardId
    ? riskScores.wards.filter((w) => w.ward_id === highlightWardId)
    : riskScores.wards;

  return (
    <div className="flex flex-col gap-4 h-full">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-bold text-white flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-amber-500"></span>
            Risk Rankings
          </h3>
          <p className="text-xs text-slate-500 mt-0.5">
            Descriptive risk scores (0-100) for the current window
          </p>
        </div>
        <div className="badge bg-amber-500/20 text-amber-300 border border-amber-500/30">
          {wards.filter(w => w.risk_score >= 50).length} high-risk
        </div>
      </div>

      {!predictionsLoading && <ModelPerformanceCard modelPerformance={modelPerformance} />}

      <div className="flex-1 overflow-y-auto space-y-2 pr-1 custom-scrollbar">
        {wards.length === 0 ? (
          <div className="glass-card p-4 text-center text-slate-500 text-sm">
            No risk data available for this selection.
          </div>
        ) : (
          wards.map((ward) => (
            <RiskWardCard key={ward.ward_id} ward={ward} prediction={predictionsByWard?.get(ward.ward_id)} onSelectWard={onSelectWard} />
          ))
        )}
      </div>

      <div className="text-xs text-slate-600 border-t border-white/5 pt-2 space-y-1">
        <p>Descriptive: XGBoost + SHAP explainability · Predictive: temporal ML forecast</p>
        <p className="italic text-slate-600">{PREDICTION_DISCLAIMER}</p>
      </div>
    </div>
  );
}

function RiskWardCard({ ward, prediction, onSelectWard }) {
  const scoreColor = ward.risk_score >= 75 ? 'text-red-400'
    : ward.risk_score >= 50 ? 'text-orange-400'
    : ward.risk_score >= 25 ? 'text-yellow-400'
    : 'text-emerald-400';

  const bgColor = ward.risk_score >= 75 ? 'bg-red-500/5 border-red-500/20'
    : ward.risk_score >= 50 ? 'bg-orange-500/5 border-orange-500/15'
    : 'bg-white/[0.02] border-white/5';

  const levelLabel = ward.risk_level === 'critical' ? 'CRITICAL'
    : ward.risk_level === 'high' ? 'HIGH'
    : ward.risk_level === 'moderate' ? 'MOD'
    : 'LOW';

  return (
    <div className={`ward-card-hover rounded-xl border p-3 ${bgColor}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            {onSelectWard ? (
              <button
                type="button"
                onClick={() => onSelectWard(ward.ward_id, ward.ward_name, ward.district)}
                className="text-sm font-semibold text-white truncate hover:text-primary-300 hover:underline transition-colors"
                title="Open Ward Intelligence Drilldown"
              >
                {ward.ward_name}
              </button>
            ) : (
              <p className="text-sm font-semibold text-white truncate">{ward.ward_name}</p>
            )}
            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
              ward.risk_score >= 75 ? 'bg-red-500/20 text-red-300'
              : ward.risk_score >= 50 ? 'bg-orange-500/20 text-orange-300'
              : ward.risk_score >= 25 ? 'bg-yellow-500/20 text-yellow-300'
              : 'bg-emerald-500/20 text-emerald-300'
            }`}>{levelLabel}</span>
          </div>
          <p className="text-xs text-slate-500">{ward.district}</p>
        </div>
        <p className={`text-2xl font-bold tabular-nums ${scoreColor}`}>
          {Math.round(ward.risk_score)}
        </p>
      </div>

      {/* Explanation */}
      <p className="text-[11px] text-slate-400 mt-1.5 leading-relaxed line-clamp-2">
        {ward.explanation}
      </p>

      {/* Top factors as compact tags */}
      {ward.top_factors && (
        <div className="flex flex-wrap gap-1 mt-2">
          {ward.top_factors.map((f, i) => (
            <span key={i} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${
              f.direction === 'up'
                ? 'bg-red-500/10 text-red-300 border border-red-500/20'
                : 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20'
            }`}>
              {f.direction === 'up' ? '↑' : '↓'} {f.description}
            </span>
          ))}
        </div>
      )}

      <PredictiveRiskBlock prediction={prediction} compact />
    </div>
  );
}

function StatCard({ icon, label, value, color, borderColor }) {
  return (
    <div className={`glass-card-hover p-4 ${borderColor} animate-slide-up`}>
      <div className="flex items-center gap-3">
        <div className={`kpi-icon w-11 h-11 rounded-xl bg-gradient-to-br ${color} flex items-center justify-center text-xl`}>
          {icon}
        </div>
        <div>
          <p className="text-2xl font-bold text-white tabular-nums">{value}</p>
          <p className="text-xs font-medium text-slate-400 uppercase tracking-wider">{label}</p>
        </div>
      </div>
    </div>
  );
}

const AI_SUGGESTIONS = [
  "What needs attention?",
  'Why is this ward high risk?',
  'What changed recently?',
  'Show critical alerts',
  'Summarize offender activity',
];

function formatChatTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
}

function TypingDots() {
  return (
    <span className="ai-typing" aria-label="Assistant is typing">
      <span />
      <span />
      <span />
    </span>
  );
}

function AiAssistantWidget({
  health,
  hotspots,
  escalation,
  riskScores,
  network,
  mapView,
  selectedDistrict,
  selectedWard,
  selectedCrimeType,
  dateFrom,
  dateTo,
  horizonDays,
  trendGranularity,
  onNavigate,
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [question, setQuestion] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  // The conversation only exists while the popup is open; New Chat resets it.
  const [messages, setMessages] = useState([]);
  const inputRef = useRef(null);
  const scrollRef = useRef(null);

  const context = {
    health,
    hotspots,
    escalation,
    riskScores,
    network,
    mapView,
    selectedDistrict,
    selectedWard,
    selectedCrimeType,
    dateFrom,
    dateTo,
    prediction_horizon: horizonDays,
    granularity: trendGranularity,
  };

  const hasConversation = messages.length > 0;

  // Auto-focus the input when the panel opens or a new chat starts.
  useEffect(() => {
    if (isOpen && !isClosing) {
      const t = window.setTimeout(() => inputRef.current?.focus(), 80);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [isOpen, isClosing, hasConversation]);

  // Keep the newest message / typing indicator in view.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, aiLoading]);

  const addAssistantMessage = (text) => {
    setMessages((prev) => [...prev, { role: 'assistant', text, ts: Date.now() }]);
  };

  const handleSummary = () => {
    askQuestion('Summarize the current intelligence brief');
  };

  // Shared ask flow — used by the input and the suggestion chips. The API
  // call, request body and fallback are unchanged; only message bookkeeping
  // differs (append the answer instead of replacing a placeholder).
  const askQuestion = async (raw) => {
    const trimmed = (raw || '').trim();
    if (!trimmed || aiLoading) return;

    setMessages((prev) => [...prev, { role: 'user', text: trimmed, ts: Date.now() }]);
    setQuestion('');
    setAiLoading(true);

    try {
      const response = await fetch(`${API_URL}/api/copilot`, {
        method: 'POST',
        // text/plain keeps this a CORS "simple request" so the browser skips
        // the preflight. The Catalyst gateway answers OPTIONS itself without
        // any Access-Control-* headers, so a preflighted POST is always
        // blocked. The body is still JSON; the backend parses it directly.
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify({
          message: trimmed,
          context,
          history: messages.slice(-8).map((m) => ({ role: m.role, content: m.text })),
        }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      setMessages((prev) => [...prev, { role: 'assistant', text: data.answer || 'No grounded answer was available.', evidence: data.evidence || [], actions: data.actions || [], sources: data.sources || [], ts: Date.now() }]);
    } catch {
      addAssistantMessage('The AI Assistant is temporarily unavailable. Please try again after the backend responds.');
    } finally {
      setAiLoading(false);
    }
  };

  const handleAsk = (event) => {
    event.preventDefault();
    askQuestion(question);
  };

  // Enter to send, Shift+Enter for a newline.
  const handleKeyDown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      askQuestion(question);
    }
  };

  // New Chat — clears the in-memory conversation and returns to the empty
  // state without touching the dashboard, backend or the page.
  const startNewChat = () => {
    setMessages([]);
    setQuestion('');
    setAiLoading(false);
    window.setTimeout(() => inputRef.current?.focus(), 40);
  };

  const closePanel = () => {
    setIsClosing(true);
    window.setTimeout(() => {
      setIsOpen(false);
      setIsClosing(false);
    }, 170);
  };

  const togglePanel = () => (isOpen ? closePanel() : setIsOpen(true));

  // Keep drag state out of React state so the bubble follows the pointer with
  // no render lag. `dragMoved` prevents a drag-release from opening the panel.
  const AI_POSITION_KEY = 'crime-intel-ai-position';
  const AI_BALL_SIZE = 58;
  const AI_EDGE_GUTTER = 20;
  const dragRef = useRef({ active: false, moved: false, offsetX: 0, offsetY: 0, startX: 0, startY: 0, pointerId: null, target: null });
  const [bubblePosition, setBubblePosition] = useState(() => {
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem(AI_POSITION_KEY)); } catch { /* use default */ }
    const side = stored?.side === 'left' ? 'left' : 'right';
    const y = Number.isFinite(stored?.y) ? stored.y : window.innerHeight - AI_BALL_SIZE - 28;
    return {
      x: side === 'left' ? AI_EDGE_GUTTER : window.innerWidth - AI_BALL_SIZE - AI_EDGE_GUTTER,
      y: Math.max(AI_EDGE_GUTTER, Math.min(y, window.innerHeight - AI_BALL_SIZE - AI_EDGE_GUTTER)),
    };
  });
  const [isDragging, setIsDragging] = useState(false);
  const clampBubblePosition = (x, y) => {
    return {
      x: Math.max(AI_EDGE_GUTTER, Math.min(x, window.innerWidth - AI_BALL_SIZE - AI_EDGE_GUTTER)),
      y: Math.max(AI_EDGE_GUTTER, Math.min(y, window.innerHeight - AI_BALL_SIZE - AI_EDGE_GUTTER)),
    };
  };
  const handleBubblePointerDown = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    dragRef.current = {
      active: true,
      moved: false,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      startX: event.clientX,
      startY: event.clientY,
      pointerId: event.pointerId,
      target: event.currentTarget,
    };
    setIsDragging(true);
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const handleBubblePointerMove = (event) => {
    const drag = dragRef.current;
    if (!drag.active) return;
    const next = clampBubblePosition(event.clientX - drag.offsetX, event.clientY - drag.offsetY);
    if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 6) drag.moved = true;
    event.preventDefault();
    setBubblePosition(next);
  };
  const handleBubblePointerUp = (event) => {
    const drag = dragRef.current;
    if (!drag.active) return;
    drag.active = false;
    setIsDragging(false);
    if (!drag.moved) return;
    setBubblePosition((position) => {
      const side = position.x + AI_BALL_SIZE / 2 < window.innerWidth / 2 ? 'left' : 'right';
      const snapped = clampBubblePosition(
        side === 'left' ? AI_EDGE_GUTTER : window.innerWidth - AI_BALL_SIZE - AI_EDGE_GUTTER,
        position.y,
      );
      try { localStorage.setItem(AI_POSITION_KEY, JSON.stringify({ side, y: snapped.y })); } catch { /* storage may be unavailable */ }
      return snapped;
    });
    drag.target?.releasePointerCapture?.(drag.pointerId);
  };

  useEffect(() => {
    window.addEventListener('pointermove', handleBubblePointerMove, { passive: false });
    window.addEventListener('pointerup', handleBubblePointerUp);
    window.addEventListener('pointercancel', handleBubblePointerUp);
    return () => {
      window.removeEventListener('pointermove', handleBubblePointerMove);
      window.removeEventListener('pointerup', handleBubblePointerUp);
      window.removeEventListener('pointercancel', handleBubblePointerUp);
    };
  });

  useEffect(() => {
    const keepBubbleVisible = () => setBubblePosition((position) => {
      const side = position.x + AI_BALL_SIZE / 2 < window.innerWidth / 2 ? 'left' : 'right';
      return clampBubblePosition(side === 'left' ? AI_EDGE_GUTTER : window.innerWidth - AI_BALL_SIZE - AI_EDGE_GUTTER, position.y);
    });
    window.addEventListener('resize', keepBubbleVisible);
    return () => window.removeEventListener('resize', keepBubbleVisible);
  }, []);

  const dateRangeLabel = dateFrom && dateTo
    ? `${formatDate(dateFrom)} – ${formatDate(dateTo)}`
    : 'Full range';

  const assistantOnLeft = bubblePosition.x + AI_BALL_SIZE / 2 < window.innerWidth / 2;
  const assistantOnUpperHalf = bubblePosition.y + AI_BALL_SIZE / 2 < window.innerHeight / 2;
  const panelMaxHeight = Math.max(240, assistantOnUpperHalf
    ? window.innerHeight - bubblePosition.y - AI_BALL_SIZE - 24
    : bubblePosition.y - 24);

  return (
    <div
      className={`ai-assistant${isOpen ? ' ai-assistant--open' : ''}${isDragging ? ' ai-assistant--dragging' : ''}${assistantOnLeft ? ' ai-assistant--left' : ''}${assistantOnUpperHalf ? ' ai-assistant--upper' : ''}`}
      style={{ left: bubblePosition.x, top: bubblePosition.y, right: 'auto', bottom: 'auto' }}
    >
      {isOpen && (
        <section
          className={`ai-analysis-panel${isClosing ? ' ai-analysis-panel--closing' : ''}`}
          aria-label="AI analysis panel"
          style={panelMaxHeight ? { maxHeight: panelMaxHeight } : undefined}
        >
          {/* ── Header ── */}
          <div className="flex items-start justify-between gap-3 px-4 py-3 border-b border-white/10">
            <div className="flex items-start gap-2.5 min-w-0">
              <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-primary-500 to-accent-cyan flex items-center justify-center text-lg flex-shrink-0 shadow-glow">
                🤖
              </div>
              <div className="min-w-0">
                <h2 className="text-sm font-bold text-white leading-tight">AI Assistant</h2>
                <p className="text-[11px] text-slate-400 leading-snug mt-0.5">
                  Evidence-grounded answers from the current analytical scope.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              {hasConversation && (
                <button
                  type="button"
                  onClick={startNewChat}
                  className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-[11px] font-medium text-slate-300 transition-colors hover:border-primary-400/40 hover:bg-primary-500/10 hover:text-white"
                >
                  <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v14M5 12h14" />
                  </svg>
                  New Chat
                </button>
              )}
              <button
                type="button"
                onClick={closePanel}
                className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-white/10 hover:text-white"
                aria-label="Close assistant"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18 18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>

          {/* ── Body: empty state (intro + context + suggestions) or chat ── */}
          <div ref={scrollRef} className="ai-analysis-messages custom-scrollbar">
            {!hasConversation ? (
              <div className="ai-empty space-y-3.5">
                {/* Friendly introduction */}
                <p className="text-[12.5px] leading-relaxed text-slate-300">
                  Hi — I’m your AI Assistant. Ask about risk, trends, alerts, hotspots, incidents,
                  offender networks, or the current intelligence brief.
                </p>

                {/* Current context */}
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-1.5">Current Context</p>
                  <div className="flex flex-wrap gap-1.5">
                    <ContextChip label="View" value={viewLabel(mapView)} />
                    <ContextChip label="District" value={selectedDistrict || 'All Districts'} />
                    {selectedWard && <ContextChip label="Ward" value={selectedWard.name} />}
                    <ContextChip label="Crime Type" value={selectedCrimeType || 'All Types'} />
                    <ContextChip label="Date" value={dateRangeLabel} />
                  </div>
                </div>

                {/* Suggested questions */}
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-1.5">Suggested questions</p>
                  <div className="flex flex-col gap-1.5">
                    {AI_SUGGESTIONS.map((suggestion) => (
                      <button
                        key={suggestion}
                        type="button"
                        disabled={aiLoading}
                        onClick={() => askQuestion(suggestion)}
                        className="group flex items-center justify-between gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-left text-[12px] text-slate-300 transition-colors hover:border-primary-400/40 hover:bg-primary-500/10 hover:text-white disabled:opacity-50"
                      >
                        <span>{suggestion}</span>
                        <svg className="h-3.5 w-3.5 flex-shrink-0 text-slate-600 transition-colors group-hover:text-primary-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={handleSummary}
                      className="rounded-lg border border-primary-500/30 bg-primary-500/10 px-3 py-2 text-left text-[12px] font-medium text-primary-200 transition-colors hover:bg-primary-500/20"
                    >
                      Summarize the current dashboard
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <>
                {messages.map((message, index) => {
                  const isUser = message.role === 'user';
                  return (
                    <div key={index} className={`ai-msg-in flex flex-col ${isUser ? 'items-end' : 'items-start'}`}>
                      <div
                        className={
                          isUser
                            ? 'max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-primary-600 px-3.5 py-2 text-[12.5px] leading-relaxed text-white shadow-sm'
                            : 'max-w-[90%] whitespace-pre-wrap rounded-2xl rounded-bl-sm border border-white/10 bg-white/[0.05] px-3.5 py-2 text-[12.5px] leading-relaxed text-slate-100'
                        }
                      >
                        {message.text}
                      </div>
                      {message.role === 'assistant' && message.evidence?.length > 0 && (
                        <div className="mt-1.5 max-w-[92%] rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2">
                          <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Evidence</p>
                          {message.evidence.map((item, i) => <p key={i} className="text-[11px] text-slate-300">• {item.label}: <span className="text-slate-100">{item.value}</span></p>)}
                          {message.sources?.length > 0 && <p className="text-[10px] text-slate-600 mt-1">Based on: {message.sources.join(' · ')}</p>}
                          {message.actions?.length > 0 && <div className="flex flex-wrap gap-1.5 mt-2">{message.actions.map((item, i) => <button key={i} type="button" onClick={() => onNavigate?.(item.action, item)} className="rounded-md border border-primary-500/30 bg-primary-500/10 px-2 py-1 text-[10px] text-primary-200 hover:bg-primary-500/20">{item.label}</button>)}</div>}
                        </div>
                      )}
                      {message.ts && (
                        <span className="mt-1 px-1 text-[9px] text-slate-600">{formatChatTime(message.ts)}</span>
                      )}
                    </div>
                  );
                })}
                {aiLoading && (
                  <div className="ai-msg-in flex items-start">
                    <div className="rounded-2xl rounded-bl-sm border border-white/10 bg-white/[0.05] px-3.5 py-3">
                      <TypingDots />
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          {/* ── Input ── */}
          <form onSubmit={handleAsk} className="flex items-end gap-2 border-t border-white/10 px-3 py-3">
            <textarea
              ref={inputRef}
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={handleKeyDown}
              disabled={aiLoading}
              rows={1}
              placeholder="Ask about hotspots, risks or offenders…"
              className="ai-analysis-input min-w-0 flex-1 resize-none rounded-lg border border-white/10 bg-surface-900/80 px-3 py-2 text-sm text-white outline-none transition-colors placeholder:text-slate-600 focus:border-primary-400 focus:ring-1 focus:ring-primary-400/30"
            />
            <button
              type="submit"
              disabled={aiLoading || !question.trim()}
              className="flex h-9 w-11 items-center justify-center rounded-lg bg-primary-600 text-sm font-semibold text-white transition-colors hover:bg-primary-500 disabled:opacity-50"
              aria-label="Send question"
            >
              {aiLoading ? (
                <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
              ) : (
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              )}
            </button>
          </form>
        </section>
      )}

      <button
        type="button"
        className="ai-assistant-fab"
        aria-label="Open AI Assistant"
        aria-expanded={isOpen}
        onPointerDown={handleBubblePointerDown}
        onClick={() => { if (!dragRef.current.moved) togglePanel(); }}
      >
        <span aria-hidden="true" className="text-lg leading-none">✦</span>
        <span>AI</span>
      </button>
    </div>
  );
}

function ContextChip({ label, value }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.03] px-2 py-1 text-[10.5px]">
      <span className="text-slate-500">{label}:</span>
      <span className="font-medium text-slate-200">{value}</span>
    </span>
  );
}

function buildAssistantContext(context) {
  const { health, hotspots, escalation, riskScores, network, mapView, selectedDistrict, dateFrom, dateTo } = context;
  const topCluster = [...(hotspots?.clusters || [])].sort((a, b) => b.incident_count - a.incident_count)[0];
  const topRiskWards = [...(riskScores?.wards || [])].sort((a, b) => b.risk_score - a.risk_score).slice(0, 8);
  const risingWards = (escalation?.wards || []).filter((ward) => ward.trending_up).slice(0, 8);

  return {
    selectedDistrict: selectedDistrict || 'All Districts',
    dateFrom,
    dateTo,
    currentView: viewLabel(mapView),
    summary: {
      incidents: health?.incidents ?? null,
      accused: health?.accused ?? null,
      wards: health?.wards ?? null,
      hotspot_clusters: hotspots?.n_clusters ?? 0,
      hotspot_incidents: hotspots?.n_incidents ?? 0,
      high_risk_wards: (riskScores?.wards || []).filter((ward) => ward.risk_score >= 50).length,
      rising_wards: (escalation?.wards || []).filter((ward) => ward.trending_up).length,
      network_groups: network?.summary?.n_communities ?? 0,
      network_individuals: network?.summary?.n_nodes ?? 0,
    },
    topCluster: topCluster
      ? {
          id: topCluster.cluster_id + 1,
          incidents: topCluster.incident_count,
          dominantCrimeType: topCluster.dominant_crime_type,
          averageSeverity: topCluster.avg_severity,
        }
      : null,
    topRiskWards: topRiskWards.map((ward) => ({
      ward: ward.ward_name,
      district: ward.district,
      score: Math.round(ward.risk_score),
      level: ward.risk_level,
      explanation: ward.explanation,
    })),
    risingWards: risingWards.map((ward) => ({
      ward: ward.ward_name,
      district: ward.district,
      escalationScore: ward.escalation_score,
      latestCount: ward.latest_count,
      latestPeriod: ward.latest_period,
    })),
    networkSummary: network?.summary || null,
  };
}

function buildDashboardSummary(context) {
  const { health, hotspots, escalation, riskScores, network, mapView, selectedDistrict, dateFrom, dateTo } = context;
  const scope = selectedDistrict ? `${selectedDistrict} district` : 'all districts';
  const topCluster = [...(hotspots?.clusters || [])].sort((a, b) => b.incident_count - a.incident_count)[0];
  const highRiskWards = (riskScores?.wards || []).filter((ward) => ward.risk_score >= 50);
  const topRiskWard = [...(riskScores?.wards || [])].sort((a, b) => b.risk_score - a.risk_score)[0];
  const risingWards = (escalation?.wards || []).filter((ward) => ward.trending_up);

  const lines = [
    `Summary for ${scope}, ${formatDate(dateFrom)} to ${formatDate(dateTo)}.`,
    `Current view: ${viewLabel(mapView)}. Dataset has ${health?.incidents?.toLocaleString() ?? 'available'} incidents across ${health?.wards ?? 'multiple'} wards.`,
  ];

  if (hotspots) {
    lines.push(`${hotspots.n_clusters ?? 0} hotspot clusters were detected from ${hotspots.n_incidents ?? 0} incidents.`);
  }
  if (topCluster) {
    lines.push(`Largest hotspot is #${topCluster.cluster_id + 1} with ${topCluster.incident_count} incidents, mainly ${topCluster.dominant_crime_type}.`);
  }
  if (topRiskWard) {
    lines.push(`Highest risk ward is ${topRiskWard.ward_name} (${topRiskWard.district}) with score ${Math.round(topRiskWard.risk_score)}.`);
  }
  if (riskScores?.wards) {
    lines.push(`${highRiskWards.length} wards are currently high-risk or critical.`);
  }
  if (escalation?.wards) {
    lines.push(`${risingWards.length} wards show abnormal rising minor-crime trends.`);
  }
  if (network?.summary) {
    lines.push(`Network analysis found ${network.summary.n_communities ?? 0} groups across ${network.summary.n_nodes ?? 0} individuals.`);
  }

  return lines.join(' ');
}

function answerDashboardQuestion(question, context) {
  const q = question.toLowerCase();
  const { hotspots, escalation, riskScores, network } = context;
  const topRiskWard = [...(riskScores?.wards || [])].sort((a, b) => b.risk_score - a.risk_score)[0];
  const highRiskWards = (riskScores?.wards || []).filter((ward) => ward.risk_score >= 50);
  const topCluster = [...(hotspots?.clusters || [])].sort((a, b) => b.incident_count - a.incident_count)[0];
  const risingWards = (escalation?.wards || []).filter((ward) => ward.trending_up);

  if (q.includes('summary') || q.includes('summar')) {
    return buildDashboardSummary(context);
  }
  if (q.includes('highest') || q.includes('top risk') || q.includes('risky')) {
    if (!topRiskWard) return 'Risk score data is still loading or unavailable for this filter. Try the Risk Score View or click Generate Summary again after the dashboard finishes computing.';
    return `${topRiskWard.ward_name} in ${topRiskWard.district} is the highest-risk ward with score ${Math.round(topRiskWard.risk_score)} (${topRiskWard.risk_level}). ${topRiskWard.explanation}`;
  }
  if (q.includes('hotspot') || q.includes('cluster')) {
    if (!hotspots) return 'Hotspot data is not loaded yet.';
    if (!topCluster) return 'No hotspot clusters were found for the current filters.';
    return `${hotspots.n_clusters} clusters were detected from ${hotspots.n_incidents} incidents. The largest is hotspot #${topCluster.cluster_id + 1}, with ${topCluster.incident_count} incidents and dominant crime type ${topCluster.dominant_crime_type}.`;
  }
  if (q.includes('rising') || q.includes('escalat') || q.includes('trend')) {
    if (!escalation?.wards) return 'Escalation data is not loaded yet.';
    if (risingWards.length === 0) return 'No wards are currently showing abnormal escalation in the selected data.';
    return `${risingWards.length} wards are trending upward. Top zones: ${risingWards.slice(0, 5).map((ward) => `${ward.ward_name} (+${ward.escalation_score.toFixed(1)})`).join(', ')}.`;
  }
  if (q.includes('network') || q.includes('group') || q.includes('accused')) {
    if (!network?.summary) return 'Network data is not loaded yet.';
    return `The network view has ${network.summary.n_nodes ?? 0} individuals, ${network.summary.n_edges ?? 0} links, and ${network.summary.n_communities ?? 0} detected groups. Larger nodes usually indicate stronger centrality.`;
  }
  if (q.includes('how many') && (q.includes('risk') || q.includes('critical') || q.includes('high'))) {
    return `${highRiskWards.length} wards are high-risk or critical in the current filter.`;
  }

  return 'I can answer dashboard questions locally. For broad ask-anything answers, make sure the backend is running with OPENAI_API_KEY configured.';
}

function viewLabel(mapView) {
  if (mapView === 'risk') return 'Risk Score View';
  if (mapView === 'network') return 'Network View';
  if (mapView === 'trends') return 'Trends & Anomalies';
  if (mapView === 'alerts') return 'Intelligence Alerts';
  if (mapView === 'drilldown') return 'District Intelligence';
  if (mapView === 'brief') return 'Intelligence Brief';
  return 'Hotspot View';
}

function formatDate(isoStr) {
  if (!isoStr) return '—';
  const d = new Date(isoStr);
  return d.toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' });
}

export default App;
