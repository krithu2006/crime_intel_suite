/**
 * AlertsPanel — Module 6 UI (Intelligence Alert Center).
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from './LanguageContext.jsx';

const SEVERITY_OPTIONS = ['ALL', 'CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
const STATUS_OPTIONS = ['ACTIVE', 'ALL', 'NEW', 'REVIEWED', 'INVESTIGATING', 'CLOSED'];
const LIFECYCLE = ['NEW', 'REVIEWED', 'INVESTIGATING', 'CLOSED'];

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
  const { t } = useTranslation();
  const [sortBy, setSortBy] = useState('priority');

  const granularityOptions = [
    { value: 'daily', label: t('daily') },
    { value: 'weekly', label: t('weekly') },
    { value: 'monthly', label: t('monthly') },
  ];

  const alerts = alertsData?.alerts || [];
  const selectedAlert = alerts.find((alert) => alert.id === selectedAlertId);
  const sorted = useMemo(() => {
    if (sortBy === 'priority') return alerts;
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
            <span aria-hidden="true">🚨</span> {t('alertsTitle')}
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {t('alertsSubtitle')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => onMarkAllRead().catch(() => {})} disabled={!unreadCount}
            className="mark-all-read-button" title="Mark every unread intelligence alert as read">
            {t('markAllRead')}
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
            {granularityOptions.map((g) => (
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

          <div className="alert-summary-grid grid grid-cols-2 sm:grid-cols-4 gap-3">
            <SummaryItem label={t('totalAlerts')} count={alertsData.summary?.total || 0} color="text-slate-200" />
            <SummaryItem label={t('unreadSignals')} count={unreadCount || 0} color="text-sky-300" />
            <SummaryItem label={t('criticalHigh')} count={(alertsData.summary?.severity?.CRITICAL || 0) + (alertsData.summary?.severity?.HIGH || 0)} color="text-rose-400" />
            <SummaryItem label={t('activeOpen')} count={alertsData.summary?.active || 0} color="text-amber-300" />
          </div>

          <div className="alerts-list space-y-3 max-h-[540px] overflow-y-auto pr-1 custom-scrollbar">
            {sorted.length === 0 ? (
              <div className="glass-card p-6 text-center text-slate-500 text-sm">
                {t('noAlertsFound')}
              </div>
            ) : (
              sorted.map((alert) => (
                <AlertCard
                  key={alert.id}
                  alert={alert}
                  isHighlighted={alert.id === selectedAlertId}
                  onStatusChange={onStatusChange}
                  onAlertRead={onAlertRead}
                  onNavigate={onNavigate}
                  onSelectWard={onSelectWard}
                />
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}

function FilterSelect({ label, value, options, onChange, optionLabel }) {
  return (
    <div className="flex items-center gap-2">
      <label className="text-xs text-slate-500">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-surface-800 border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-white outline-none"
      >
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {optionLabel ? optionLabel(opt) : opt}
          </option>
        ))}
      </select>
    </div>
  );
}

function SummaryItem({ label, count, color }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
      <p className="text-[10px] uppercase tracking-wider font-semibold text-slate-500">{label}</p>
      <p className={`mt-1 text-xl font-bold tabular-nums ${color}`}>{count}</p>
    </div>
  );
}

function AlertCard({ alert, isHighlighted, onStatusChange, onAlertRead, onNavigate, onSelectWard }) {
  const { t } = useTranslation();
  const severityStyle = SEVERITY_STYLE[alert.severity] || SEVERITY_STYLE.LOW;
  const statusBadge = STATUS_BADGE[alert.status] || STATUS_BADGE.NEW;

  const severityKey = alert.severity === 'CRITICAL' ? 'sevCritical' :
    alert.severity === 'HIGH' ? 'sevHigh' :
    alert.severity === 'MEDIUM' ? 'sevMedium' : 'sevLow';

  const statusKey = alert.status === 'NEW' ? 'statusNew' :
    alert.status === 'REVIEWED' ? 'statusReviewed' :
    alert.status === 'INVESTIGATING' ? 'statusInvestigating' : 'statusClosed';

  const translatedTitle = alert.title === 'Crime Drop' ? t('crimeDrop') :
    alert.title === 'Volume Spike' ? t('volumeSpike') :
    alert.title === 'Night Incident Surge' ? t('nightSurge') :
    alert.title === 'Escalation Warning' ? t('escalationWarning') : alert.title;

  const evLabelMap = {
    'Observed incidents': t('observedIncidents'),
    'Historical baseline': t('historicalBaseline'),
    'Deviation': t('deviation'),
    'Anomaly score': t('anomalyScore'),
    'Severity': t('severity'),
  };

  return (
    <div
      data-alert-id={alert.id}
      onClick={() => { if (!alert.read) onAlertRead(alert.id).catch(() => {}); }}
      className={`alert-card p-4 rounded-xl border transition-all ${severityStyle.card} ${
        alert.read ? 'alert-card--read opacity-85' : 'alert-card--unread border-l-4'
      } ${isHighlighted ? 'ring-2 ring-primary-400 border-primary-400/50 shadow-lg shadow-primary-500/10' : ''}`}
    >
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="space-y-1 min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            {!alert.read && <span className="alert-unread-dot" title="Unread alert" />}
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-md uppercase tracking-wider ${severityStyle.badge}`}>
              {t(severityKey) || alert.severity}
            </span>
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-md uppercase tracking-wider ${statusBadge}`}>
              {t(statusKey) || alert.status}
            </span>
            <span className="text-xs text-slate-500">
              {alert.district}{alert.ward ? ` · ${alert.ward}` : ''}
            </span>
          </div>

          <h3 className="text-base font-bold text-white leading-snug">{translatedTitle}</h3>
          <p className="text-xs text-slate-300 leading-relaxed">{alert.description}</p>
        </div>

        <div className="flex flex-col items-end gap-2 flex-shrink-0">
          <span className="text-[11px] text-slate-500 font-mono">
            {formatDate(alert.period || alert.detected_at)}
          </span>
          <div className="alert-lifecycle flex items-center gap-1 bg-black/20 p-1 rounded-lg border border-white/10" onClick={(e) => e.stopPropagation()}>
            {LIFECYCLE.map((s) => {
              const btnKey = s === 'NEW' ? 'statusNew' : s === 'REVIEWED' ? 'statusReviewed' : s === 'INVESTIGATING' ? 'statusInvestigating' : 'statusClosed';
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => onStatusChange(alert.id, s)}
                  className={`px-2 py-1 text-[10px] font-semibold rounded-md transition-colors ${
                    alert.status === s
                      ? 'bg-primary-600 text-white shadow-sm'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
                  }`}
                >
                  {t(btnKey) || s}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {alert.evidence?.length > 0 && (
        <div className="mt-3 pt-3 border-t border-white/5 grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-slate-400">
          {alert.evidence.map((ev) => (
            <div key={ev.label} className="bg-black/20 rounded-lg p-2 border border-white/5 flex items-center justify-between">
              <span className="text-slate-400">{evLabelMap[ev.label] || ev.label}</span>
              <strong className="text-slate-200 font-semibold">{ev.value}</strong>
            </div>
          ))}
        </div>
      )}

      {alert.actions?.length > 0 && (
        <div className="mt-3 flex items-center justify-end gap-2 flex-wrap" onClick={(e) => e.stopPropagation()}>
          {alert.actions.map((act) => (
            <button
              key={`${act.action}:${act.ward_id ?? act.label}`}
              type="button"
              onClick={() => {
                if (act.action === 'view_ward' && act.ward_id) {
                  onSelectWard(act.ward_id, act.label, alert.district);
                } else if (onNavigate) {
                  onNavigate(act.action, act);
                }
              }}
              className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-white/5 hover:bg-white/10 text-primary-300 border border-primary-500/20 transition-colors flex items-center gap-1"
            >
              <span>{ACTION_LABEL[act.action] || act.label}</span>
              <span aria-hidden="true">→</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
