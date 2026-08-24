/**
 * AlertsPanel — Module 6 UI (Intelligence Alert Center).
 * Turns Module 5 anomalies/sustained trends (and, for genuinely high-risk
 * wards, Module 3b predictions) into a police-style alert workflow: browse,
 * filter, inspect evidence, jump into the relevant existing view, and move
 * an alert through NEW → REVIEWED → INVESTIGATING → CLOSED.
 *
 * This panel never invents an alert — everything rendered here comes
 * straight from GET /api/alerts (alert_engine.py), which itself only
 * normalizes real analytics output.
 */
import { useEffect, useMemo, useState } from 'react';

const SEVERITY_OPTIONS = ['ALL', 'CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
const STATUS_OPTIONS = ['ACTIVE', 'ALL', 'NEW', 'REVIEWED', 'INVESTIGATING', 'CLOSED'];
const LIFECYCLE = ['NEW', 'REVIEWED', 'INVESTIGATING', 'CLOSED'];
const GRANULARITY_OPTIONS = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
];

const SEVERITY_STYLE = {
  CRITICAL: { dot: 'bg-red-500', text: 'text-red-400', badge: 'bg-red-500/20 text-red-300 border border-red-500/30', card: 'border-red-500/25 bg-red-500/[0.04]' },
  HIGH: { dot: 'bg-orange-500', text: 'text-orange-400', badge: 'bg-orange-500/20 text-orange-300 border border-orange-500/30', card: 'border-orange-500/20 bg-orange-500/[0.03]' },
  MEDIUM: { dot: 'bg-yellow-500', text: 'text-yellow-400', badge: 'bg-yellow-500/20 text-yellow-300 border border-yellow-500/30', card: 'border-yellow-500/20 bg-yellow-500/[0.02]' },
  LOW: { dot: 'bg-sky-500', text: 'text-sky-400', badge: 'bg-sky-500/20 text-sky-300 border border-sky-500/30', card: 'border-white/5 bg-white/[0.02]' },
};

const STATUS_BADGE = {
  NEW: 'bg-primary-500/20 text-primary-200 border border-primary-500/30',
  REVIEWED: 'bg-slate-500/20 text-slate-300 border border-slate-500/30',
  INVESTIGATING: 'bg-violet-500/20 text-violet-300 border border-violet-500/30',
  CLOSED: 'bg-white/5 text-slate-500 border border-white/10',
};

const ACTION_LABEL = {
  view_trend: 'View Trend',
  view_hotspot: 'View Hotspot',
  view_risk: 'View Risk',
  view_network: 'View Network',
};

function formatDate(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function AlertsPanel({
  alertsData, loading, granularity, onGranularityChange,
  severityFilter, onSeverityFilterChange, statusFilter, onStatusFilterChange,
  onStatusChange, onAlertRead, onMarkAllRead, unreadCount, selectedAlertId, onNavigate, onSelectWard,
}) {
  const [sortBy, setSortBy] = useState('priority'); // 'priority' | 'newest'

  const alerts = alertsData?.alerts || [];
  const selectedAlert = alerts.find((alert) => alert.id === selectedAlertId);
  const sorted = useMemo(() => {
    if (sortBy === 'priority') return alerts; // backend already ranks by priority
    return [...alerts].sort((a, b) => {
      const ad = a.period || a.detected_at || '';
      const bd = b.period || b.detected_at || '';
      return bd.localeCompare(ad);
    });
  }, [alerts, sortBy]);

  useEffect(() => {
    if (!selectedAlertId || loading) return;
    const target = document.querySelector(`[data-alert-id="${CSS.escape(selectedAlertId)}"]`);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [selectedAlertId, loading, sorted.length]);

  return (
    <div className="alerts-panel glass-card p-5 space-y-5">
      <div className="alerts-toolbar flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <span aria-hidden="true">🚨</span> Intelligence Alerts
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Decision-support signals from detected anomalies, sustained trends, and high future-risk wards.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => onMarkAllRead().catch(() => {})} disabled={!unreadCount}
            className="mark-all-read-button" title="Mark every unread intelligence alert as read">
            Mark all as read
          </button>
          <FilterSelect label="Severity" value={severityFilter} options={SEVERITY_OPTIONS} onChange={onSeverityFilterChange} />
          <FilterSelect label="Status" value={statusFilter} options={STATUS_OPTIONS} onChange={onStatusFilterChange}
            optionLabel={(o) => (o === 'ACTIVE' ? 'Active (default)' : o)} />
          <div className="flex items-center gap-2">
            <label className="text-xs text-slate-500">Sort</label>
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}
              className="bg-surface-800 border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-white outline-none">
              <option value="priority">Priority</option>
              <option value="newest">Newest</option>
            </select>
          </div>
          <div className="flex rounded-lg border border-white/10 overflow-hidden">
            {GRANULARITY_OPTIONS.map((g) => (
              <button key={g.value} type="button" onClick={() => onGranularityChange(g.value)}
                className={`px-2.5 py-1.5 text-xs font-medium transition-colors ${
                  granularity === g.value ? 'bg-primary-600 text-white' : 'bg-transparent text-slate-400 hover:text-slate-300 hover:bg-white/5'
                }`}>
                {g.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading ? (
        <div className="h-64 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <div className="w-8 h-8 border-3 border-rose-500/30 border-t-rose-400 rounded-full animate-spin"></div>
            <p className="text-sm text-slate-400">Scanning analytics for alerts...</p>
          </div>
        </div>
      ) : !alertsData ? (
        <div className="glass-card p-6 text-center text-slate-500 text-sm">
          Could not reach the Alert Center. Try Update or check the backend connection.
        </div>
      ) : (
        <>
          {selectedAlert && (
            <div className="selected-alert-banner" role="status">
              <span className="selected-alert-banner__icon" aria-hidden="true">↗</span>
              <span><strong>Opened from notification</strong><small>Alert ID: {selectedAlert.id} · Detected {formatDate(selectedAlert.period || selectedAlert.detected_at)} · {selectedAlert.severity}</small></span>
            </div>
          )}
          <AlertSummary summary={alertsData.summary} />

          {sorted.length === 0 ? (
            <div className="alerts-list custom-scrollbar glass-card p-10 text-center">
              <p className="text-base font-semibold text-slate-300">No active intelligence alerts</p>
              <p className="text-sm text-slate-500 mt-1 max-w-md mx-auto">
                No significant anomalies or high-priority risk signals were detected for the selected scope.
              </p>
            </div>
          ) : (
            <div className="alerts-list custom-scrollbar space-y-3">
              {sorted.map((alert) => (
                <AlertCard key={alert.id} alert={alert} selected={alert.id === selectedAlertId} onStatusChange={onStatusChange} onAlertRead={onAlertRead} onNavigate={onNavigate} onSelectWard={onSelectWard} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function FilterSelect({ label, value, options, onChange, optionLabel }) {
  return (
    <div className="flex items-center gap-2">
      <label className="text-xs text-slate-500">{label}</label>
      <select value={value} onChange={(e) => onChange(e.target.value)}
        className="bg-surface-800 border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-white outline-none">
        {options.map((o) => <option key={o} value={o}>{optionLabel ? optionLabel(o) : o}</option>)}
      </select>
    </div>
  );
}

function AlertSummary({ summary }) {
  if (!summary) return null;
  const tiles = [
    ['Total', summary.total, 'text-white'],
    ['Critical', summary.critical, 'text-red-400'],
    ['High', summary.high, 'text-orange-400'],
    ['Medium', summary.medium, 'text-yellow-400'],
    ['Low', summary.low, 'text-sky-400'],
    ['New', summary.new, 'text-primary-300'],
    ['Investigating', summary.investigating, 'text-violet-300'],
  ];
  return (
    <div className="alert-summary-grid grid grid-cols-3 sm:grid-cols-7 gap-3">
      {tiles.map(([label, value, color]) => (
        <div key={label} className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5 text-center">
          <p className={`text-xl font-bold tabular-nums ${color}`}>{value ?? 0}</p>
          <p className="text-[10px] uppercase tracking-wide text-slate-500">{label}</p>
        </div>
      ))}
    </div>
  );
}

function AlertCard({ alert, selected, onStatusChange, onAlertRead, onNavigate, onSelectWard }) {
  const [expanded, setExpanded] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [statusError, setStatusError] = useState(false);
  const [markingRead, setMarkingRead] = useState(false);
  const style = SEVERITY_STYLE[alert.severity] || SEVERITY_STYLE.LOW;

  const handleStatusSelect = (e) => {
    const next = e.target.value;
    if (next === alert.status) return;
    setUpdating(true);
    setStatusError(false);
    onStatusChange(alert.id, next)
      .catch(() => setStatusError(true))
      .finally(() => setUpdating(false));
  };

  const where = [alert.district, alert.ward].filter(Boolean).join(' → ');

  const handleOpen = () => {
    if (alert.is_read || markingRead || !onAlertRead) return;
    setMarkingRead(true);
    onAlertRead(alert.id).catch(() => {}).finally(() => setMarkingRead(false));
  };

  useEffect(() => {
    if (selected) setExpanded(true);
  }, [selected]);

  return (
    <div data-alert-id={alert.id} onClick={handleOpen} className={`alert-card alert-card--${alert.severity?.toLowerCase() || 'low'} ${alert.is_read ? 'alert-card--read' : 'alert-card--unread'} ${selected ? 'alert-card--selected' : ''} rounded-xl border p-4 ${style.card}`}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {!alert.is_read && <span className="alert-unread-dot" title="Unread" aria-label="Unread alert" />}
            <span className={`inline-flex items-center gap-1.5 text-[10px] font-bold px-2 py-0.5 rounded ${style.badge}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`}></span>
              {alert.severity}
            </span>
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${STATUS_BADGE[alert.status] || STATUS_BADGE.NEW}`}>
              {alert.status}
            </span>
          </div>
          <h3 className="text-base font-bold text-white mt-1.5">{alert.title}</h3>
          {where && (
            alert.ward_id != null && onSelectWard ? (
              <button
                type="button"
                onClick={() => onSelectWard(alert.ward_id, alert.ward, alert.district)}
                className="text-xs text-slate-500 hover:text-primary-300 hover:underline transition-colors"
                title="Open Ward Intelligence Drilldown"
              >
                {where}
              </button>
            ) : (
              <p className="text-xs text-slate-500">{where}</p>
            )
          )}
        </div>

        {/* Status control — supports forward AND backward transitions */}
        <div className="flex items-center gap-2 flex-shrink-0">
          {statusError && <span className="text-[10px] text-rose-400">Update failed</span>}
          <select
            value={alert.status}
            onChange={handleStatusSelect}
            disabled={updating}
            className="bg-surface-800 border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-white outline-none disabled:opacity-50"
            title="Update alert status"
          >
            {LIFECYCLE.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      </div>

      <p className="text-sm text-slate-300 mt-2 leading-relaxed">{alert.description}</p>

      {/* Key evidence, compact row */}
      <div className="flex flex-wrap gap-x-5 gap-y-1 mt-2 text-xs text-slate-400">
        {alert.observed_value != null && (
          <span>Observed <span className="text-slate-200 font-medium">{alert.observed_value}</span></span>
        )}
        {alert.expected_lower != null && alert.expected_upper != null && (
          <span>Expected <span className="text-slate-200 font-medium">{Math.round(alert.expected_lower)}–{Math.round(alert.expected_upper)}</span></span>
        )}
        {alert.change_percent != null && (
          <span className={alert.direction === 'drop' ? 'text-emerald-400' : 'text-rose-400'}>
            {alert.change_percent > 0 ? '+' : ''}{Math.round(alert.change_percent)}% baseline
          </span>
        )}
        {alert.risk_score != null && alert.type === 'predictive_risk' && (
          <span>Risk score <span className="text-slate-200 font-medium">{alert.risk_score}/100</span></span>
        )}
        {(alert.period || alert.detected_at) && (
          <span>Detected <span className="text-slate-200 font-medium">{formatDate(alert.period || alert.detected_at)}</span></span>
        )}
      </div>

      {/* Evidence panel */}
      <button type="button" onClick={() => setExpanded((v) => !v)}
        className="text-[11px] text-primary-300 hover:text-primary-200 mt-2 font-medium">
        {expanded ? 'Hide evidence ▲' : 'Why this alert was generated ▾'}
      </button>
      {expanded && alert.evidence?.length > 0 && (
        <div className="mt-2 rounded-lg border border-white/10 bg-black/20 p-3 space-y-1">
          {alert.evidence.map((e, i) => (
            <div key={i} className="flex items-center justify-between text-xs">
              <span className="text-slate-500">{e.label}</span>
              <span className="text-slate-200 font-medium">{String(e.value)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Navigation actions */}
      {alert.available_actions?.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-3">
          {alert.available_actions.map((action) => (
            <button
              key={action}
              type="button"
              onClick={() => onNavigate(action, alert)}
              className="px-3 py-1.5 rounded-lg border border-white/10 bg-white/5 text-xs font-medium text-slate-300 hover:border-primary-400/40 hover:bg-primary-500/10 hover:text-white transition-colors"
            >
              {ACTION_LABEL[action] || action}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
