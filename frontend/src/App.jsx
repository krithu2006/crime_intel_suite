import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { API_URL } from './config.js';
import HotspotMap from './HotspotMap.jsx';
import RiskScoreMap from './RiskScoreMap.jsx';
import RisingZones from './RisingZones.jsx';
import { NetworkGraph, NetworkSidebar } from './NetworkView.jsx';
import { HorizonSelector, ModelPerformanceCard, PredictiveRiskBlock, DEFAULT_HORIZON } from './PredictiveRisk.jsx';
import TrendsPanel from './TrendsPanel.jsx';
import AlertsPanel from './AlertsPanel.jsx';
import DrilldownPanel from './DrilldownPanel.jsx';
import IntelligenceBrief from './IntelligenceBrief.jsx';
import SettingsPopover from './SettingsPopover.jsx';
import AssistantMarkdown from './AssistantMarkdown.jsx';
import { LanguageProvider, useTranslation } from './LanguageContext.jsx';
import { LANGUAGE_OPTIONS } from './translations.js';

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

const FEATURE_TRANSLATION_KEYS = {
  hotspots: 'hotspots',
  risk: 'predictiveRisk',
  network: 'criminalNetwork',
  trends: 'trendsAnomalies',
  alerts: 'intelligenceAlerts',
  brief: 'intelligenceBrief',
  drilldown: 'districtIntelligence',
};

function getAlertTargetFromUrl() {
  return new URLSearchParams(window.location.search).get('alert');
}

async function parseApiResponse(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.error) {
    throw new Error(payload?.detail || payload?.error || `Request failed (${response.status})`);
  }
  return payload;
}

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

function AppContent() {
  const { t, language, setLanguage } = useTranslation();
  const [theme, setTheme] = useState(getInitialTheme);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [health, setHealth] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  // >0 once a health probe has failed, i.e. the backend is waking from sleep.
  const [wakeAttempt, setWakeAttempt] = useState(0);

  // AI Copilot panel state — lifted here so the app-shell can apply ai-open class
  const [isAiOpen, setIsAiOpen] = useState(false);

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
  const [alertStatusFilter, setAlertStatusFilter] = useState(() => getAlertTargetFromUrl() ? 'ALL' : 'ACTIVE');
  const [unreadAlertCount, setUnreadAlertCount] = useState(0);
  const [notifications, setNotifications] = useState([]);
  const [notificationSeverityCounts, setNotificationSeverityCounts] = useState({});
  const [notificationsLoading, setNotificationsLoading] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const notificationRef = useRef(null);
  const [selectedAlertId, setSelectedAlertId] = useState(getAlertTargetFromUrl);
  const selectedAlertTimer = useRef(null);
  const [alertMutationError, setAlertMutationError] = useState(null);
  const analyticsRequestIds = useRef({});

  // View toggle: 'hotspots', 'risk', 'network', 'trends', or 'alerts'
  const [mapView, setMapView] = useState(() => getAlertTargetFromUrl() ? 'alerts' : 'hotspots');
  const [activeFeature, setActiveFeature] = useState(() => getAlertTargetFromUrl() ? 'alerts' : 'hotspots');

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
    const requestId = (analyticsRequestIds.current.hotspots || 0) + 1;
    analyticsRequestIds.current.hotspots = requestId;
    setHotspotsLoading(true);
    const params = new URLSearchParams();
    if (dateFrom) params.set('from', dateFrom);
    if (dateTo) params.set('to', dateTo);
    if (selectedDistrict) params.set('district', selectedDistrict);
    if (selectedCrimeType) params.set('crime_type', selectedCrimeType);
    if (selectedWard) params.set('ward_id', String(selectedWard.id));
    fetch(`${API_URL}/api/hotspots?${params}`)
      .then((res) => res.json())
      .then((data) => {
        if (analyticsRequestIds.current.hotspots !== requestId) return;
        setHotspots(data); setHotspotsLoading(false);
      })
      .catch(() => {
        if (analyticsRequestIds.current.hotspots === requestId) setHotspotsLoading(false);
      });
  }, [dateFrom, dateTo, selectedDistrict, selectedCrimeType, selectedWard]);

  // ── Fetch escalation ──
  // Escalation is a minor-crime early-warning signal (Dispute/Vandalism/Eve
  // Teasing by definition), so it is intentionally NOT scoped by crime type.
  const fetchEscalation = useCallback(() => {
    const requestId = (analyticsRequestIds.current.escalation || 0) + 1;
    analyticsRequestIds.current.escalation = requestId;
    setEscalationLoading(true);
    const params = new URLSearchParams({ period: 'monthly' });
    if (dateFrom) params.set('from', dateFrom);
    if (dateTo) params.set('to', dateTo);
    if (selectedDistrict) params.set('district', selectedDistrict);
    if (selectedWard) params.set('ward_id', String(selectedWard.id));
    fetch(`${API_URL}/api/escalation?${params}`)
      .then((res) => res.json())
      .then((data) => {
        if (analyticsRequestIds.current.escalation !== requestId) return;
        setEscalation(data); setEscalationLoading(false);
      })
      .catch(() => {
        if (analyticsRequestIds.current.escalation === requestId) setEscalationLoading(false);
      });
  }, [dateFrom, dateTo, selectedDistrict, selectedWard]);

  // ── Fetch risk scores ──
  const fetchRiskScores = useCallback(() => {
    const requestId = (analyticsRequestIds.current.risk || 0) + 1;
    analyticsRequestIds.current.risk = requestId;
    setRiskLoading(true);
    const params = new URLSearchParams();
    if (dateFrom) params.set('from', dateFrom);
    if (dateTo) params.set('to', dateTo);
    if (selectedDistrict) params.set('district', selectedDistrict);
    if (selectedCrimeType) params.set('crime_type', selectedCrimeType);
    if (selectedWard) params.set('ward_id', String(selectedWard.id));
    fetch(`${API_URL}/api/risk-scores?${params}`)
      .then((res) => res.json())
      .then((data) => {
        if (analyticsRequestIds.current.risk !== requestId) return;
        setRiskScores(data); setRiskLoading(false);
      })
      .catch(() => {
        if (analyticsRequestIds.current.risk === requestId) setRiskLoading(false);
      });
  }, [dateFrom, dateTo, selectedDistrict, selectedCrimeType, selectedWard]);

  // ── Fetch predictions ──
  // The prediction anchor is the selected "To" date (or the latest data if
  // none is set) — see prediction.py's `as_of`. District/ward/crime-type
  // filters are passed through so the forecast scope always matches what
  // the analyst is looking at.
  const fetchPredictions = useCallback(() => {
    const requestId = (analyticsRequestIds.current.predictions || 0) + 1;
    analyticsRequestIds.current.predictions = requestId;
    setPredictionsLoading(true);
    const params = new URLSearchParams({ prediction_horizon: String(horizonDays) });
    if (dateTo) params.set('to', dateTo);
    if (selectedDistrict) params.set('district', selectedDistrict);
    if (selectedCrimeType) params.set('crime_type', selectedCrimeType);
    if (selectedWard) params.set('ward_id', String(selectedWard.id));
    fetch(`${API_URL}/api/predictions/risk?${params}`)
      .then((res) => res.json())
      .then((data) => {
        if (analyticsRequestIds.current.predictions !== requestId) return;
        setPredictions(data); setPredictionsLoading(false);
      })
      .catch(() => {
        if (analyticsRequestIds.current.predictions === requestId) setPredictionsLoading(false);
      });
  }, [dateTo, selectedDistrict, selectedCrimeType, selectedWard, horizonDays]);

  // ── Fetch trends ──
  const fetchTrends = useCallback(() => {
    const requestId = (analyticsRequestIds.current.trends || 0) + 1;
    analyticsRequestIds.current.trends = requestId;
    setTrendsLoading(true);
    const params = new URLSearchParams({ granularity: trendGranularity });
    if (dateFrom) params.set('from', dateFrom);
    if (dateTo) params.set('to', dateTo);
    if (selectedDistrict) params.set('district', selectedDistrict);
    if (selectedCrimeType) params.set('crime_type', selectedCrimeType);
    if (selectedWard) params.set('ward_id', String(selectedWard.id));
    fetch(`${API_URL}/api/trends?${params}`)
      .then((res) => res.json())
      .then((data) => {
        if (analyticsRequestIds.current.trends !== requestId) return;
        setTrends(data); setTrendsLoading(false);
      })
      .catch(() => {
        if (analyticsRequestIds.current.trends === requestId) setTrendsLoading(false);
      });
  }, [dateFrom, dateTo, selectedDistrict, selectedCrimeType, selectedWard, trendGranularity]);

  // ── Fetch alerts (Module 6 — lazy, only while the Alerts tab is open) ──
  const fetchAlerts = useCallback(() => {
    const requestId = (analyticsRequestIds.current.alerts || 0) + 1;
    analyticsRequestIds.current.alerts = requestId;
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
      .then((data) => {
        if (analyticsRequestIds.current.alerts !== requestId) return;
        setAlertsData(data); setAlertsLoading(false);
      })
      .catch(() => {
        if (analyticsRequestIds.current.alerts === requestId) setAlertsLoading(false);
      });
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
    setNotificationsLoading(true);
    fetch(`${API_URL}/api/notifications?limit=5`)
      .then((res) => {
        if (!res.ok) throw new Error(`Notification request failed: ${res.status}`);
        return res.json();
      })
      .then((data) => {
        setNotifications(data?.alerts || []);
        setNotificationSeverityCounts(data?.severity_counts || {});
        setUnreadAlertCount(data?.unread_count ?? 0);
      })
      .catch(() => {})
      .finally(() => setNotificationsLoading(false));
  }, []);

  // ── Fetch district/ward drilldown (Module 7 — lazy, only while that tab
  // is open, and only one of the two depending on whether a ward is picked) ──
  const fetchDistrictDrilldown = useCallback(() => {
    if (!selectedDistrict) return;
    const requestId = (analyticsRequestIds.current.districtDrilldown || 0) + 1;
    analyticsRequestIds.current.districtDrilldown = requestId;
    setDistrictDrilldownLoading(true);
    const params = new URLSearchParams({ granularity: trendGranularity, prediction_horizon: String(horizonDays) });
    if (selectedCrimeType) params.set('crime_type', selectedCrimeType);
    if (dateFrom) params.set('from', dateFrom);
    if (dateTo) params.set('to', dateTo);
    fetch(`${API_URL}/api/drilldown/district/${encodeURIComponent(selectedDistrict)}?${params}`)
      .then((res) => res.json())
      .then((data) => {
        if (analyticsRequestIds.current.districtDrilldown !== requestId) return;
        setDistrictDrilldown(data); setDistrictDrilldownLoading(false);
      })
      .catch(() => {
        if (analyticsRequestIds.current.districtDrilldown === requestId) setDistrictDrilldownLoading(false);
      });
  }, [selectedDistrict, selectedCrimeType, dateFrom, dateTo, trendGranularity, horizonDays]);

  const fetchWardDrilldown = useCallback(() => {
    if (!selectedWard) return;
    const requestId = (analyticsRequestIds.current.wardDrilldown || 0) + 1;
    analyticsRequestIds.current.wardDrilldown = requestId;
    setWardDrilldownLoading(true);
    const params = new URLSearchParams({ granularity: trendGranularity, prediction_horizon: String(horizonDays) });
    if (selectedCrimeType) params.set('crime_type', selectedCrimeType);
    if (dateFrom) params.set('from', dateFrom);
    if (dateTo) params.set('to', dateTo);
    fetch(`${API_URL}/api/drilldown/ward/${selectedWard.id}?${params}`)
      .then((res) => res.json())
      .then((data) => {
        if (analyticsRequestIds.current.wardDrilldown !== requestId) return;
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
      .catch(() => {
        if (analyticsRequestIds.current.wardDrilldown === requestId) setWardDrilldownLoading(false);
      });
  }, [selectedWard, selectedCrimeType, dateFrom, dateTo, trendGranularity, horizonDays]);

  // ── Fetch network ──
  const fetchNetwork = useCallback(() => {
    const requestId = (analyticsRequestIds.current.network || 0) + 1;
    analyticsRequestIds.current.network = requestId;
    setNetworkLoading(true);
    const params = new URLSearchParams();
    if (dateFrom) params.set('from', dateFrom);
    if (dateTo) params.set('to', dateTo);
    if (selectedDistrict) params.set('district', selectedDistrict);
    if (selectedCrimeType) params.set('crime_type', selectedCrimeType);
    if (selectedWard) params.set('ward_id', String(selectedWard.id));
    fetch(`${API_URL}/api/network?${params}`)
      .then((res) => res.json())
      .then((data) => {
        if (analyticsRequestIds.current.network !== requestId) return;
        setNetwork(data); setNetworkLoading(false);
      })
      .catch(() => {
        if (analyticsRequestIds.current.network === requestId) setNetworkLoading(false);
      });
  }, [dateFrom, dateTo, selectedDistrict, selectedCrimeType, selectedWard]);

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

  // A notification target is a real deep link, not transient component state.
  // It therefore still opens the exact generated alert after a browser refresh
  // or a history back/forward navigation.
  useEffect(() => {
    const syncAlertTarget = () => {
      const target = getAlertTargetFromUrl();
      setSelectedAlertId(target);
      if (target) {
        setAlertSeverityFilter('ALL');
        setAlertStatusFilter('ALL');
        setMapView('alerts');
        setActiveFeature('alerts');
      }
    };
    window.addEventListener('popstate', syncAlertTarget);
    return () => window.removeEventListener('popstate', syncAlertTarget);
  }, []);

  // A status change updates the local list immediately (no full refetch) and
  // Workflow status remains independent from notification read state.
  const handleAlertStatusChange = useCallback((alertId, newStatus) => {
    setAlertMutationError(null);
    // POST + text/plain, not PATCH/application-json: PATCH is never a CORS
    // "simple method" (always preflighted) and this deployment's gateway
    // answers that preflight without Access-Control-* headers, so the
    // browser blocks it before it reaches the API. text/plain keeps this a
    // "simple request" that skips the preflight — same fix as /api/copilot.
    return fetch(`${API_URL}/api/alerts/${encodeURIComponent(alertId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ status: newStatus }),
    })
      .then(parseApiResponse)
      .then((updated) => {
        setAlertsData((prev) => {
          if (!prev) return prev;
          const nextAlerts = prev.alerts.map((a) => (a.id === alertId ? { ...a, status: updated.status, note: updated.note } : a));
          return { ...prev, alerts: nextAlerts };
        });
        // The server summary is calculated over the complete scoped alert
        // set (not merely the currently filtered card list), so refresh it to
        // keep status-dependent counts correct without a page reload.
        fetchAlerts();
        return updated;
      })
      .catch((error) => {
        setAlertMutationError(error.message || 'Could not update alert status.');
        throw error;
      });
  }, [fetchAlerts]);

  const handleAlertRead = useCallback((alertId) => {
    setAlertMutationError(null);
    // POST, not PATCH — see the comment on handleAlertStatusChange above.
    return fetch(`${API_URL}/api/alerts/${encodeURIComponent(alertId)}/read`, { method: 'POST' })
      .then(parseApiResponse)
      .then((result) => {
        if (!result?.success) throw new Error('Could not mark alert read');
        setAlertsData((prev) => prev ? {
          ...prev,
          alerts: prev.alerts.map((alert) => alert.id === alertId ? { ...alert, is_read: true, read_at: result.read_at } : alert),
        } : prev);
        setNotifications((prev) => {
          const readAlert = prev.find((alert) => alert.id === alertId);
          if (result.marked_read && readAlert?.severity) {
            setNotificationSeverityCounts((counts) => ({ ...counts, [readAlert.severity]: Math.max(0, (counts[readAlert.severity] || 0) - 1) }));
          }
          return prev.filter((alert) => alert.id !== alertId);
        });
        if (result.marked_read) setUnreadAlertCount((count) => Math.max(0, count - 1));
        fetchUnreadAlertCount();
        return result;
      })
      .catch((error) => {
        setAlertMutationError(error.message || 'Could not mark alert read.');
        throw error;
      });
  }, [fetchUnreadAlertCount]);

  const handleMarkAllRead = useCallback(() => {
    setAlertMutationError(null);
    // POST, not PATCH — see the comment on handleAlertStatusChange above.
    return fetch(`${API_URL}/api/notifications/read-all`, { method: 'POST' })
      .then(parseApiResponse)
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
      })
      .catch((error) => {
        setAlertMutationError(error.message || 'Could not mark all alerts read.');
        throw error;
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
    const url = new URL(window.location.href);
    url.searchParams.set('alert', alert.id);
    window.history.pushState({}, '', url);
    setNotificationsOpen(false);
    openFeature('alerts');
  }, [openFeature]);

  // Start the temporary emphasis only after the card actually exists in the
  // rendered list. This avoids losing the target while a slow analytics fetch
  // is still in progress.
  const handleAlertFocused = useCallback(() => {
    if (selectedAlertTimer.current) window.clearTimeout(selectedAlertTimer.current);
    selectedAlertTimer.current = window.setTimeout(() => setSelectedAlertId(null), 3000);
  }, []);

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
      theme={theme}
    />;
  }

  const availableFrom = health?.date_range?.from?.slice(0, 10) || '';
  const availableTo = health?.date_range?.to?.slice(0, 10) || '';
  const datasetRange = availableFrom && availableTo
    ? `${formatDate(availableFrom)} – ${formatDate(availableTo)}`
    : null;

  return (
    <div className={`app-shell${isAiOpen ? ' ai-open' : ''}`}>
      {/* ── Main Application Layout (left column when AI is open) ── */}
      <div className="app-layout">
        {/* ── Header ── */}
        <header className="app-header border-b border-white/10 sticky top-0">
          <div className="dashboard-container app-header__inner">
            {/* Title — no logo icon */}
            <div className="min-w-0">
              <h1 className="text-lg sm:text-xl font-bold tracking-tight gradient-text truncate">{t('appTitle')}</h1>
              <p className="text-[10px] sm:text-xs text-slate-500 font-medium truncate">{t('appSubtitle')}</p>
            </div>
            <div className="app-header__actions flex items-center gap-1.5 sm:gap-2 flex-shrink-0">
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
                    <svg className="w-4 h-4 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                    </svg>
                    {unreadAlertCount > 0 && (
                      <span key={unreadAlertCount} className="notification-badge">
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
                        {notificationsLoading ? (
                          <p className="notification-dropdown__empty">Loading intelligence signals…</p>
                        ) : notifications.length === 0 ? (
                          <p className="notification-dropdown__empty">You're all caught up.</p>
                        ) : notifications.map((alert) => (
                          <button key={alert.id} type="button" className="notification-item" onClick={() => {
                            // Navigation must not depend on the mark-read mutation
                            // succeeding — a transient failure there shouldn't make
                            // "Click to investigate" appear to do nothing.
                            handleAlertRead(alert.id).catch(() => {});
                            openAlertFromNotification(alert);
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
                aria-label="Open themes"
                title={t('themes')}
              >
                <svg className="w-4 h-4 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01" />
                </svg>
                <span className="hidden lg:inline">{t('themes')}</span>
              </button>
              {loading ? (
                <span className="badge bg-yellow-500/20 text-yellow-300 border border-yellow-500/30">
                  <span className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse"></span>
                  <span className="hidden sm:inline">{t('backendConnecting')}</span>
                </span>
              ) : error ? (
                <span className="badge bg-rose-500/20 text-rose-300 border border-rose-500/30">
                  <span className="w-2 h-2 rounded-full bg-rose-400"></span>
                  {t('backendOffline')}
                </span>
              ) : (
                <span className="badge bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse-slow"></span>
                  {t('backendOnline')}
                </span>
              )}
              {/* Language Selector Dropdown */}
              <div className="language-selector-wrapper">
                <span className="language-selector-icon" aria-hidden="true">
                  <span className="lang-icon-kn">ಕ</span>
                  <span className="lang-icon-en">A</span>
                </span>
                <select
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                  className="language-selector-select"
                  title="Select Language"
                  aria-label="Select Language"
                >
                  {LANGUAGE_OPTIONS.map((opt) => (
                    <option key={opt.code} value={opt.code}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                <span className="language-selector-arrow" aria-hidden="true">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M19 9l-7 7-7-7" />
                  </svg>
                </span>
              </div>
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
            <div className="animate-fade-in space-y-3">
              {/* ── Top KPI Cards ── */}
              <div className="dashboard-kpis grid grid-cols-2 sm:grid-cols-4 gap-3">
                <StatCard
                  label={t('incidents')}
                  value={hotspots?.n_incidents?.toLocaleString() ?? health.incidents?.toLocaleString() ?? '—'}
                  borderColor="border-primary-500/20"
                />
                <StatCard
                  label={t('accused')}
                  value={network?.summary?.n_nodes?.toLocaleString() ?? health.accused?.toLocaleString() ?? '—'}
                  borderColor="border-cyan-500/20"
                />
                <StatCard
                  label={t('wards')}
                  value={riskScores?.wards?.length?.toLocaleString() ?? health.wards?.toLocaleString() ?? '—'}
                  borderColor="border-emerald-500/20"
                />
                <StatCard
                  label={t('hotspotClusters')}
                  value={hotspots?.n_clusters?.toLocaleString() ?? '—'}
                  borderColor="border-rose-500/20"
                />
              </div>

              {/* ── Secondary Risk Summary Row ── */}
              <div className="dashboard-metrics grid grid-cols-2 sm:grid-cols-5 gap-2 sm:gap-2.5">
                {[
                  [t('totalClusters'), hotspots?.n_clusters ?? 0, 'text-sky-300'],
                  [t('highRisk'), (hotspots?.clusters || []).filter((cluster) => cluster.severity_level === 'High').length, 'text-rose-300'],
                  [t('mediumRisk'), (hotspots?.clusters || []).filter((cluster) => cluster.severity_level === 'Medium').length, 'text-amber-300'],
                  [t('lowRisk'), (hotspots?.clusters || []).filter((cluster) => cluster.severity_level === 'Low').length, 'text-emerald-300'],
                  [t('averageRisk'), riskScores?.wards?.length ? (riskScores.wards.reduce((sum, ward) => sum + ward.risk_score, 0) / riskScores.wards.length).toFixed(1) : '—', 'text-violet-300'],
                ].map(([label, value, color]) => (
                  <div key={label} className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 flex flex-col justify-center">
                    <p className="text-[10px] uppercase tracking-wider font-semibold text-slate-500">{label}</p>
                    <p className={`mt-0.5 text-base sm:text-lg font-bold tabular-nums ${color}`}>{value}</p>
                  </div>
                ))}
              </div>

              {/* ── Intelligence Command Center Master Panel ── */}
              <div className="dashboard-controls glass-card flex flex-col gap-4">
                {/* ── Top Full-Width Filters Box ── */}
                <div className="dashboard-top-filter-bar border-b border-white/10 pb-4">
                  <div className="dashboard-filter-row custom-scrollbar pb-1">
                    <div className="filter-group-main">
                      {/* District Filter */}
                      <div className="dashboard-filter-control flex items-center gap-1.5 flex-shrink-0">
                        <label className="text-[10px] text-slate-200 font-extrabold uppercase tracking-wider">{t('district')}</label>
                        <select
                          value={selectedDistrict}
                          onChange={(e) => setSelectedDistrict(e.target.value)}
                          className="bg-surface-800 border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-white w-[150px] focus:border-primary-400 focus:ring-1 focus:ring-primary-400/30 outline-none"
                        >
                          <option value="">{t('allDistricts')}</option>
                          {districtsList.map(d => (
                            <option key={d.id} value={d.district}>{d.district}</option>
                          ))}
                        </select>
                      </div>

                      {/* Crime Type Filter */}
                      <div className="dashboard-filter-control flex items-center gap-1.5 flex-shrink-0 border-l border-white/10 pl-3">
                        <label className="text-[10px] text-slate-200 font-extrabold uppercase tracking-wider">{t('crimeType')}</label>
                        <select
                          value={selectedCrimeType}
                          onChange={(e) => setSelectedCrimeType(e.target.value)}
                          className="bg-surface-800 border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-white w-[140px] focus:border-primary-400 focus:ring-1 focus:ring-primary-400/30 outline-none"
                        >
                          <option value="">{t('allTypes')}</option>
                          {crimeTypes.map((crimeType) => <option key={crimeType} value={crimeType}>{crimeType}</option>)}
                        </select>
                      </div>

                      {/* Ward Scope Chip */}
                      {selectedWard && (
                        <div className="dashboard-filter-control flex items-center gap-1.5 flex-shrink-0 border-l border-white/10 pl-3">
                          <button
                            type="button"
                            onClick={clearWard}
                            className="flex items-center gap-1 rounded-full border border-primary-500/30 bg-primary-500/10 px-2.5 py-1 text-[11px] font-medium text-primary-200 hover:bg-primary-500/20 transition-colors h-[28px]"
                            title="Clear ward filter"
                          >
                            Ward: {selectedWard.name}
                            <span aria-hidden="true">✕</span>
                          </button>
                        </div>
                      )}
                    </div>

                    <div className="filter-group-dates">
                      {/* From Date */}
                      <div className="dashboard-filter-control flex items-center gap-1.5 flex-shrink-0">
                        <label className="text-[10px] text-slate-200 font-extrabold uppercase tracking-wider">{t('from')}</label>
                        <input
                          type="date"
                          value={dateFrom}
                          onChange={(e) => setDateFrom(e.target.value)}
                          className="bg-surface-800 border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-white w-[145px] focus:border-primary-400 focus:ring-1 focus:ring-primary-400/30 outline-none"
                        />
                      </div>

                      {/* To Date */}
                      <div className="dashboard-filter-control flex items-center gap-1.5 flex-shrink-0 border-l border-white/10 pl-3">
                        <label className="text-[10px] text-slate-200 font-extrabold uppercase tracking-wider">{t('to')}</label>
                        <input
                          type="date"
                          value={dateTo}
                          onChange={(e) => setDateTo(e.target.value)}
                          className="bg-surface-800 border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-white w-[145px] focus:border-primary-400 focus:ring-1 focus:ring-primary-400/30 outline-none"
                        />
                      </div>

                      {/* Update Button */}
                      <div className="dashboard-filter-control dashboard-filter-control--update border-l border-white/10 pl-3 flex-shrink-0">
                        <button
                          type="button"
                          onClick={() => {
                            fetchHotspots(); fetchEscalation(); fetchNetwork(); fetchRiskScores(); fetchPredictions();
                            if (mapView === 'trends') fetchTrends();
                            if (mapView === 'alerts') fetchAlerts();
                            if (mapView === 'drilldown') { if (selectedWard) fetchWardDrilldown(); else fetchDistrictDrilldown(); }
                          }}
                          disabled={hotspotsLoading || escalationLoading || networkLoading || riskLoading || predictionsLoading}
                          className="px-4 py-1.5 rounded-lg bg-primary-600 hover:bg-primary-500 text-white text-xs font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-sm h-[30px] flex items-center justify-center min-w-[80px]"
                        >
                          {hotspotsLoading || escalationLoading || networkLoading || riskLoading || predictionsLoading ? 'Computing...' : t('update')}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                {/* ── Bottom Content Grid: Switcher + Workspace Content ── */}
                <div className="dashboard-bottom-workspace">
                  {/* Left Sidebar Switcher */}
                  <div className="dashboard-launcher-column">
                    <div className="flex items-center gap-2">
                      <p className="dashboard-control-label">{t('intelligenceWorkspaces')}</p>
                    </div>
                    <div className="feature-launcher-grid" aria-label="Open an intelligence feature">
                      {Object.entries(FEATURE_LABELS).map(([view, label]) => (
                        <button
                          key={view}
                          type="button"
                          onClick={() => openFeature(view)}
                          className={`feature-launcher ${activeFeature === view ? 'feature-launcher--active' : ''}`}
                          aria-pressed={activeFeature === view}
                        >
                          {t(FEATURE_TRANSLATION_KEYS[view] || view, label)}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Right Content Column */}
                  <div className="dashboard-workspace-column">
                    {/* Inline Active Workspace Area */}
                    {activeFeature ? (
                    <div className="inline-workspace-container animate-fade-in">
                      {activeFeature === 'risk' && (
                        <div className="mb-4 flex justify-end">
                          <HorizonSelector value={horizonDays} onChange={setHorizonDays} />
                        </div>
                      )}
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
                          <div className="district-summary-strip glass-card p-4 rounded-xl mb-4 bg-primary-900/20 border-primary-500/20 flex flex-wrap items-center justify-between gap-4 view-transition">
                            <div>
                              <h2 className="text-base font-bold text-white flex items-center gap-2">
                                <svg className="w-4 h-4 text-primary-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                                </svg>
                                {selectedDistrict} {t('districtIntelligence')}
                              </h2>
                            </div>
                            <div className="flex flex-wrap items-center gap-4 text-xs">
                              <div>
                                <p className="text-[10px] text-slate-500 uppercase font-semibold">{t('incidents')}</p>
                                <p className="font-bold text-sky-300">{totalIncidents.toLocaleString()}</p>
                              </div>
                              <div>
                                <p className="text-[10px] text-slate-500 uppercase font-semibold">{t('hotspotClusters')}</p>
                                <p className="font-bold text-cyan-300">{totalHotspots}</p>
                              </div>
                              <div>
                                <p className="text-[10px] text-slate-500 uppercase font-semibold">{t('averageRisk')}</p>
                                <p className="font-bold text-orange-400">{avgRisk}</p>
                              </div>
                              <div>
                                <p className="text-[10px] text-slate-500 uppercase font-semibold">{t('highRisk')}</p>
                                <p className="font-bold text-red-400 truncate max-w-[120px]">
                                  {topWard ? `${topWard.ward_name} (${topWard.risk_score.toFixed(0)})` : '—'}
                                </p>
                              </div>
                              <div>
                                <p className="text-[10px] text-slate-500 uppercase font-semibold">{t('crimeType')}</p>
                                <p className="font-bold text-violet-300">{dominantCrime}</p>
                              </div>
                            </div>
                          </div>
                        );
                      })()}

                      <div className="inline-workspace-body custom-scrollbar">
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
                              mutationError={alertMutationError}
                              onAlertFocused={handleAlertFocused}
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
                              selectedCrimeType={selectedCrimeType}
                              dateFrom={dateFrom}
                              dateTo={dateTo}
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
                                  theme={theme}
                                />
                              }
                            </div>

                            {/* Side panel takes 1/3 */}
                            <div className="intelligence-sidebar glass-card p-4 sm:p-5 view-transition">
                              {sidePanel}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center py-20 text-center text-slate-500 border border-dashed border-white/10 rounded-xl my-4">
                      <svg className="w-12 h-12 text-slate-600 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                      </svg>
                      <p className="text-sm font-medium text-slate-400">{t('noWorkspaceSelected')}</p>
                      <p className="text-xs text-slate-600 mt-1 max-w-xs">{t('selectWorkspaceHint')}</p>
                    </div>
                  )}

                  {/* Panel Footer */}
                  <div className="dashboard-panel-footer">
                    <span className="dashboard-panel-footer__note">
                      <svg className="w-3.5 h-3.5 text-amber-400/80 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      Synthetic demo data · Karnataka crime patterns
                      {datasetRange && <span className="dashboard-panel-footer__range"> · Dataset range: {datasetRange}</span>}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            </div>
          )}
        </main>

        {/* ── Footer ── */}
        <footer className="border-t border-white/5 py-3 text-center text-xs text-slate-600">
          Crime Intel Suite v0.4 — Karnataka State Police Datathon
        </footer>
      </div>

      {/* ── AI Copilot Panel (right column, only when open) ── */}
      {isAiOpen && (
        <AiCopilotPanel
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
          onClose={() => setIsAiOpen(false)}
          onNavigate={(action, item) => {
            if (action === 'view_ward' && item?.ward_id != null) { selectWard(item.ward_id, item.ward_name || item.name, item.district || selectedDistrict); return; }
            const target = { view_brief: 'brief', view_district: 'drilldown', view_trend: 'trends', view_risk: 'risk', view_alerts: 'alerts', view_hotspots: 'hotspots', view_network: 'network' }[action];
            if (target) openFeature(target);
          }}
        />
      )}

      {/* ── Floating AI FAB (visible when AI is closed) ── */}
      {!isAiOpen && (
        <AiFabButton onOpen={() => setIsAiOpen(true)} />
      )}

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
function RiskRankings({ riskScores, loading, predictionsByWard, modelPerformance, predictionsLoading, highlightWardId, onSelectWard }) {
  const { t } = useTranslation();
  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-3 border-amber-500/30 border-t-amber-400 rounded-full animate-spin"></div>
          <p className="text-sm text-slate-400">{t('computingRiskScores')}</p>
        </div>
      </div>
    );
  }

  if (!riskScores?.wards) return <div className="text-slate-500 text-sm text-center">{t('noRiskData')}</div>;

  const wards = highlightWardId
    ? riskScores.wards.filter((w) => w.ward_id === highlightWardId)
    : riskScores.wards;

  return (
    <div className="flex flex-col gap-4 h-full">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-bold text-white flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-amber-500"></span>
            {t('riskRankings')}
          </h3>
          <p className="text-xs text-slate-500 mt-0.5">
            {t('descriptiveRiskScores')}
          </p>
        </div>
        <div className="badge bg-amber-500/20 text-amber-300 border border-amber-500/30">
          {wards.filter(w => w.risk_score >= 50).length} {t('highRiskWards')}
        </div>
      </div>

      {!predictionsLoading && <ModelPerformanceCard modelPerformance={modelPerformance} />}

      <div className="flex-1 overflow-y-auto space-y-2 pr-1 custom-scrollbar">
        {wards.length === 0 ? (
          <div className="glass-card p-4 text-center text-slate-500 text-sm">
            {t('noRiskData')}
          </div>
        ) : (
          wards.map((ward) => (
            <RiskWardCard key={ward.ward_id} ward={ward} prediction={predictionsByWard?.get(ward.ward_id)} onSelectWard={onSelectWard} />
          ))
        )}
      </div>

    </div>
  );
}

function RiskWardCard({ ward, prediction, onSelectWard }) {
  const { t, language } = useTranslation();
  const scoreColor = ward.risk_score >= 75 ? 'text-red-400'
    : ward.risk_score >= 50 ? 'text-orange-400'
    : ward.risk_score >= 25 ? 'text-yellow-400'
    : 'text-emerald-400';

  const bgColor = ward.risk_score >= 75 ? 'bg-red-500/5 border-red-500/20'
    : ward.risk_score >= 50 ? 'bg-orange-500/5 border-orange-500/15'
    : 'bg-white/[0.02] border-white/5';

  const levelLabel = ward.risk_level === 'critical' ? t('critical')
    : ward.risk_level === 'high' ? t('high')
    : ward.risk_level === 'moderate' ? t('moderate')
    : t('low');
  const factorText = (factor) => {
    const labels = {
      kn: { 'high incident volume': 'ಹೆಚ್ಚಿನ ಘಟನೆಗಳ ಪ್ರಮಾಣ', 'low incident volume': 'ಕಡಿಮೆ ಘಟನೆಗಳ ಪ್ರಮಾಣ', 'elevated crime severity': 'ಹೆಚ್ಚಿದ ಅಪರಾಧ ತೀವ್ರತೆ', 'low crime severity': 'ಕಡಿಮೆ ಅಪರಾಧ ತೀವ್ರತೆ', 'many high-severity incidents': 'ಹೆಚ್ಚು ತೀವ್ರತೆಯ ಘಟನೆಗಳು', 'few severe incidents': 'ಕಡಿಮೆ ಗಂಭೀರ ಘಟನೆಗಳು', 'rising minor-crime trend': 'ಸಣ್ಣ ಅಪರಾಧಗಳ ಏರಿಕೆ', 'stable minor-crime levels': 'ಸ್ಥಿರ ಸಣ್ಣ ಅಪರಾಧ ಮಟ್ಟಗಳು', 'elevated offender presence': 'ಹೆಚ್ಚಿದ ಅಪರಾಧಿ ಉಪಸ್ಥಿತಿ', 'low offender presence': 'ಕಡಿಮೆ ಅಪರಾಧಿ ಉಪಸ್ಥಿತಿ', 'high repeat-offender density': 'ಹೆಚ್ಚಿನ ಪುನರಾವರ್ತಿತ ಅಪರಾಧಿ ಸಾಂದ್ರತೆ', 'few repeat offenders': 'ಕಡಿಮೆ ಪುನರಾವರ್ತಿತ ಅಪರಾಧಿಗಳು' },
      hi: { 'high incident volume': 'घटनाओं की अधिक संख्या', 'low incident volume': 'घटनाओं की कम संख्या', 'elevated crime severity': 'अपराध की बढ़ी हुई गंभीरता', 'low crime severity': 'कम अपराध गंभीरता', 'many high-severity incidents': 'अधिक गंभीर घटनाएं', 'few severe incidents': 'कम गंभीर घटनाएं', 'rising minor-crime trend': 'छोटे अपराधों में वृद्धि', 'stable minor-crime levels': 'छोटे अपराधों का स्थिर स्तर', 'elevated offender presence': 'अपराधियों की बढ़ी हुई उपस्थिति', 'low offender presence': 'अपराधियों की कम उपस्थिति', 'high repeat-offender density': 'बार-बार अपराध करने वालों की अधिक संख्या', 'few repeat offenders': 'बार-बार अपराध करने वाले कम लोग' },
    };
    return labels[language]?.[factor] || factor;
  };
  const localizedExplanation = language === 'kn'
    ? `${ward.ward_name} ನಲ್ಲಿ ${levelLabel} ಅಪಾಯ. ಪ್ರಮುಖ ಅಂಶಗಳು: ${(ward.top_factors || []).slice(0, 2).map((f) => factorText(f.description)).join(', ') || 'ಲಭ್ಯವಿರುವ ಅಪಾಯದ ಅಂಕ'}.`
    : language === 'hi'
      ? `${ward.ward_name} में ${levelLabel} जोखिम। मुख्य कारक: ${(ward.top_factors || []).slice(0, 2).map((f) => factorText(f.description)).join(', ') || 'उपलब्ध जोखिम स्कोर'}।`
      : ward.explanation;

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
        {localizedExplanation}
      </p>

      {/* Top factors as compact tags */}
      {ward.top_factors && (
        <div className="flex flex-wrap gap-1 mt-2">
          {ward.top_factors.map((f) => (
            <span key={`${f.description}:${f.direction}`} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${
              f.direction === 'up'
                ? 'bg-red-500/10 text-red-300 border border-red-500/20'
                : 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20'
            }`}>
              {f.direction === 'up' ? '↑' : '↓'} {factorText(f.description)}
            </span>
          ))}
        </div>
      )}

      <PredictiveRiskBlock prediction={prediction} compact />
    </div>
  );
}

function StatCard({ label, value, borderColor }) {
  return (
    <div className={`dashboard-kpi-card glass-card-hover p-4 sm:p-5 ${borderColor} animate-slide-up`}>
      <div className="dashboard-kpi-card__label text-left">
        <p className="text-lg sm:text-xl font-extrabold text-white uppercase tracking-wider leading-none">{label}</p>
      </div>
      <div className="dashboard-kpi-card__value text-right">
        <p className="text-lg sm:text-xl font-extrabold text-cyan-400 uppercase tracking-wider leading-none">{value}</p>
      </div>
    </div>
  );
}

// ── Floating AI Button (shown when AI panel is closed) ──
const AI_BALL_SIZE = 72;
const AI_EDGE_GUTTER = 20;
const AI_POSITION_KEY = 'crime-intel-ai-position';

function AiFabButton({ onOpen }) {
  const dragRef = useRef({ active: false, moved: false, offsetX: 0, offsetY: 0, startX: 0, startY: 0, pointerId: null });
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

  const clampPos = (x, y) => ({
    x: Math.max(AI_EDGE_GUTTER, Math.min(x, window.innerWidth - AI_BALL_SIZE - AI_EDGE_GUTTER)),
    y: Math.max(AI_EDGE_GUTTER, Math.min(y, window.innerHeight - AI_BALL_SIZE - AI_EDGE_GUTTER)),
  });

  const handlePointerDown = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    dragRef.current = { active: true, moved: false, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top, startX: event.clientX, startY: event.clientY, pointerId: event.pointerId };
    setIsDragging(true);
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handlePointerMove = useCallback((event) => {
    const drag = dragRef.current;
    if (!drag.active) return;
    const next = clampPos(event.clientX - drag.offsetX, event.clientY - drag.offsetY);
    if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 6) drag.moved = true;
    event.preventDefault();
    setBubblePosition(next);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handlePointerUp = useCallback((event) => {
    const drag = dragRef.current;
    if (!drag.active) return;
    drag.active = false;
    setIsDragging(false);
    if (!drag.moved) return;
    setBubblePosition((pos) => {
      const side = pos.x + AI_BALL_SIZE / 2 < window.innerWidth / 2 ? 'left' : 'right';
      const snapped = clampPos(side === 'left' ? AI_EDGE_GUTTER : window.innerWidth - AI_BALL_SIZE - AI_EDGE_GUTTER, pos.y);
      try { localStorage.setItem(AI_POSITION_KEY, JSON.stringify({ side, y: snapped.y })); } catch { /* unavailable */ }
      return snapped;
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    window.addEventListener('pointermove', handlePointerMove, { passive: false });
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    };
  });

  useEffect(() => {
    const keepVisible = () => setBubblePosition((pos) => {
      const side = pos.x + AI_BALL_SIZE / 2 < window.innerWidth / 2 ? 'left' : 'right';
      return clampPos(side === 'left' ? AI_EDGE_GUTTER : window.innerWidth - AI_BALL_SIZE - AI_EDGE_GUTTER, pos.y);
    });
    window.addEventListener('resize', keepVisible);
    return () => window.removeEventListener('resize', keepVisible);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      className={`ai-fab-wrapper${isDragging ? ' ai-dragging' : ''}`}
      style={{ left: bubblePosition.x, top: bubblePosition.y, right: 'auto', bottom: 'auto' }}
    >
      <button
        type="button"
        className="ai-assistant-fab"
        aria-label="Open AI Mitra"
        onPointerDown={handlePointerDown}
        onClick={() => { if (!dragRef.current.moved) onOpen(); }}
      >
        <span aria-hidden="true" style={{ fontSize: '20px', lineHeight: 1 }}>✦</span>
        <span style={{ fontSize: '11px', fontWeight: 750 }}>AI</span>
      </button>
    </div>
  );
}

// ── AI Suggestions ──
const AI_SUGGESTIONS = [
  "What needs attention?",
  'Why is this ward high risk?',
  'What changed recently?',
  'Show critical alerts',
  'Summarize offender activity',
];

function formatChatTime(ts, language = 'en') {
  if (!ts) return '';
  const locale = language === 'kn' ? 'kn-IN' : language === 'hi' ? 'hi-IN' : 'en-IN';
  return new Date(ts).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}

function TypingDots() {
  return (
    <span className="ai-typing" aria-label="Assistant is typing">
      <span /><span /><span />
    </span>
  );
}

// ── AI Copilot Panel (right-side workspace) ──
function AiCopilotPanel({
  health, hotspots, escalation, riskScores, network,
  mapView, selectedDistrict, selectedWard, selectedCrimeType,
  dateFrom, dateTo, horizonDays, trendGranularity,
  onClose, onNavigate,
}) {
  const { t, language } = useTranslation();
  const [question, setQuestion] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [messages, setMessages] = useState([]);
  const [isListening, setIsListening] = useState(false);
  const inputRef = useRef(null);
  const scrollRef = useRef(null);
  const recognitionRef = useRef(null);

  const context = {
    health, hotspots, escalation, riskScores, network,
    mapView, selectedDistrict, selectedWard, selectedCrimeType,
    dateFrom, dateTo,
    prediction_horizon: horizonDays,
    granularity: trendGranularity,
    language,
  };

  const hasConversation = messages.length > 0;

  // Auto-focus input when panel opens or new chat starts
  useEffect(() => {
    const timer = window.setTimeout(() => inputRef.current?.focus(), 80);
    return () => window.clearTimeout(timer);
  }, [hasConversation]);

  // Keep newest message in view
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, aiLoading]);

  // Voice Microphone Speech-to-Text handler
  const toggleSpeechRecognition = () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert(t('micNotSupported'));
      return;
    }
    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
      return;
    }
    try {
      const rec = new SpeechRecognition();
      rec.continuous = false;
      rec.interimResults = true;
      rec.lang = language === 'kn' ? 'kn-IN' : language === 'hi' ? 'hi-IN' : 'en-IN';
      rec.onstart = () => setIsListening(true);
      rec.onresult = (event) => {
        const transcript = Array.from(event.results)
          .map((result) => result[0].transcript)
          .join('');
        setQuestion(transcript);
      };
      rec.onerror = (err) => {
        console.error('Speech recognition error:', err);
        setIsListening(false);
      };
      rec.onend = () => setIsListening(false);
      rec.start();
      recognitionRef.current = rec;
    } catch (err) {
      console.error('Failed to start speech recognition:', err);
      setIsListening(false);
    }
  };

  const askQuestion = async (raw) => {
    const trimmed = (raw || '').trim();
    if (!trimmed || aiLoading) return;

    if (isListening && recognitionRef.current) {
      recognitionRef.current.stop();
      setIsListening(false);
    }

    setMessages((prev) => [...prev, { role: 'user', text: trimmed, ts: Date.now() }]);
    setQuestion('');
    setAiLoading(true);

    try {
      const response = await fetch(`${API_URL}/api/copilot`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify({
          message: trimmed,
          language,
          context: { ...context, language },
          history: messages.slice(-8).map((m) => ({ role: m.role, content: m.text })),
        }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      setMessages((prev) => [...prev, {
        role: 'assistant',
        text: data.answer || t('noGroundedAnswer'),
        evidence: data.evidence || [],
        actions: data.actions || [],
        sources: data.sources || [],
        ts: Date.now(),
      }]);
    } catch {
      setMessages((prev) => [...prev, {
        role: 'assistant',
        text: language === 'kn'
          ? 'AI ಮಿತ್ರ ತಾತ್ಕಾಲಿಕವಾಗಿ ಲಭ್ಯವಿಲ್ಲ. ದಯವಿಟ್ಟು ನಂತರ ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.'
          : language === 'hi'
          ? 'AI मित्र अस्थायी रूप से अनुपलब्ध है। कृपया बाद में पुनः प्रयास करें।'
          : 'The AI Assistant is temporarily unavailable. Please try again after the backend responds.',
        ts: Date.now(),
      }]);
    } finally {
      setAiLoading(false);
    }
  };

  const handleAsk = (event) => {
    event.preventDefault();
    askQuestion(question);
  };

  const handleKeyDown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      askQuestion(question);
    }
  };

  const startNewChat = () => {
    if (isListening && recognitionRef.current) {
      recognitionRef.current.stop();
      setIsListening(false);
    }
    setMessages([]);
    setQuestion('');
    setAiLoading(false);
    window.setTimeout(() => inputRef.current?.focus(), 40);
  };

  const dateRangeLabel = dateFrom && dateTo
    ? `${formatDate(dateFrom)} – ${formatDate(dateTo)}`
    : t('allAvailableDates');

  const suggestionList = [
    t('sugQuestion1'),
    t('sugQuestion2'),
    t('sugQuestion3'),
    t('sugQuestion4'),
    t('sugQuestion5'),
  ];

  return (
    <aside className="ai-copilot-panel" aria-label={t('aiMitraTitle')}>
      {/* ── Panel Header ── */}
      <div className="ai-panel-header">
        <div className="ai-panel-header__identity">
          <div className="ai-panel-header__icon" aria-hidden="true">✦</div>
          <div className="min-w-0">
            <p className="ai-panel-header__title">{t('aiMitraTitle')}</p>
            <p className="ai-panel-header__subtitle">{t('aiMitraSubtitle')}</p>
          </div>
        </div>
        <div className="ai-panel-header__actions">
          {hasConversation && (
            <button type="button" className="ai-panel-btn" onClick={startNewChat} aria-label={t('newChat')}>
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v14M5 12h14" />
              </svg>
              {t('newChat')}
            </button>
          )}
          <button type="button" className="ai-panel-close" onClick={onClose} aria-label={t('closeAiMitra')}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* ── Messages / Empty State ── */}
      <div ref={scrollRef} className="ai-panel-messages custom-scrollbar">
        {!hasConversation ? (
          <div className="ai-empty-state">
            {/* Welcome */}
            <p className="ai-welcome-text">
              {t('aiWelcome')}
            </p>

            {/* Current context */}
            <div className="ai-context-section">
              <p className="ai-context-label">{t('currentContext')}</p>
              <div className="ai-context-chips">
                <AiContextChip label={t('contextView')} value={viewLabel(mapView)} />
                <AiContextChip label={t('contextDistrict')} value={selectedDistrict || t('allDistricts')} />
                {selectedWard && <AiContextChip label={t('contextWard')} value={selectedWard.name} />}
                <AiContextChip label={t('contextCrimeType')} value={selectedCrimeType || t('allTypes')} />
                <AiContextChip label={t('contextDate')} value={dateRangeLabel} />
              </div>
            </div>

            {/* Suggested questions */}
            <div className="ai-suggestions-section">
              <p className="ai-context-label">{t('suggestedQuestions')}</p>
              {suggestionList.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  className="ai-suggestion-btn"
                  disabled={aiLoading}
                  onClick={() => askQuestion(suggestion)}
                >
                  <span>{suggestion}</span>
                  <svg className="w-4 h-4 flex-shrink-0 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              ))}
              <button
                type="button"
                className="ai-suggestion-btn ai-suggestion-btn--primary"
                disabled={aiLoading}
                onClick={() => askQuestion(t('summarizeDashboard'))}
              >
                <span>{t('summarizeDashboard')}</span>
                <svg className="w-4 h-4 flex-shrink-0 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
            </div>
          </div>
        ) : (
          <>
            {messages.map((message, index) => {
              const isUser = message.role === 'user';
              return (
                <div
                  key={message.id || message.ts || `${message.role}:${index}`}
                  className={`ai-message-row ai-message-row--${isUser ? 'user' : 'assistant'}`}
                >
                  <div className={`ai-message-bubble ai-message-bubble--${isUser ? 'user' : 'assistant'}`}>
                    {isUser ? message.text : <AssistantMarkdown content={message.text} />}
                  </div>

                  {/* Evidence block for assistant messages */}
                  {message.role === 'assistant' && message.evidence?.length > 0 && (
                    <div className="ai-evidence-block">
                      <p className="ai-evidence-label">{t('evidence')}</p>
                      {message.evidence.map((item) => (
                        <p key={item.label} className="ai-evidence-item">
                          • {item.label}: <span>{item.value}</span>
                        </p>
                      ))}
                      {message.sources?.length > 0 && (
                        <p className="ai-sources-line">{t('basedOn')}: {message.sources.join(' · ')}</p>
                      )}
                      {message.actions?.length > 0 && (
                        <div className="ai-actions-row">
                          {message.actions.map((item) => (
                            <button
                              key={`${item.action}:${item.ward_id ?? item.label}`}
                              type="button"
                              className="ai-action-btn"
                              onClick={() => onNavigate?.(item.action, item)}
                            >
                              {item.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {message.ts && (
                    <span className="ai-timestamp">{formatChatTime(message.ts, language)}</span>
                  )}
                </div>
              );
            })}
            {aiLoading && (
              <div className="ai-message-row ai-message-row--assistant">
                <div className="ai-message-bubble ai-message-bubble--assistant" style={{ padding: '12px 16px' }}>
                  <TypingDots />
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Input Area ── */}
      <div className="ai-panel-input-area">
        <form onSubmit={handleAsk} className="ai-panel-input-form">
          <textarea
            ref={inputRef}
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={handleKeyDown}
            disabled={aiLoading}
            rows={1}
            placeholder={isListening ? t('micListening') : t('askPlaceholder')}
            className="ai-panel-textarea"
          />
          {/* Voice Microphone Input Button */}
          <button
            type="button"
            onClick={toggleSpeechRecognition}
            disabled={aiLoading}
            className={`ai-mic-btn ${isListening ? 'ai-mic-btn--listening' : ''}`}
            title={isListening ? t('micListening') : t('micClickToSpeak')}
            aria-label={isListening ? t('micListening') : t('micClickToSpeak')}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
            </svg>
          </button>
          <button
            type="submit"
            disabled={aiLoading || !question.trim()}
            className="ai-send-btn"
            aria-label={t('sendQuestion')}
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
      </div>
    </aside>
  );
}

function AiContextChip({ label, value }) {
  return (
    <span className="ai-context-chip">
      <span className="ai-context-chip__label">{label}:</span>
      <span className="ai-context-chip__value">{value}</span>
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

export default function App() {
  return (
    <LanguageProvider>
      <AppContent />
    </LanguageProvider>
  );
}
