/**
 * WardDrilldown — Module 7 ward-level view. Every card here is a thin
 * presentation layer over GET /api/drilldown/ward/{id} (drilldown.py),
 * which itself only orchestrates Modules 1-4 — nothing here recomputes
 * risk, trend, anomaly, or network data.
 */
import { useEffect, useState } from 'react';
import { API_URL } from './config.js';
import { riskLevelMeta } from './PredictiveRisk.jsx';

const SEVERITY_BADGE = {
  CRITICAL: 'bg-red-500/20 text-red-300 border border-red-500/30',
  HIGH: 'bg-orange-500/20 text-orange-300 border border-orange-500/30',
  MEDIUM: 'bg-yellow-500/20 text-yellow-300 border border-yellow-500/30',
  LOW: 'bg-sky-500/20 text-sky-300 border border-sky-500/30',
};

const HOTSPOT_SEVERITY_BADGE = {
  High: 'bg-red-500/20 text-red-300 border border-red-500/30',
  Medium: 'bg-amber-500/20 text-amber-300 border border-amber-500/30',
  Low: 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30',
};

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function daysAgo(iso) {
  if (!iso) return null;
  const diffMs = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diffMs / 86400000);
  if (days < 0) return null;
  if (days === 0) return 'today';
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}

export default function WardDrilldown({ data, loading, district, ward, crimeType, dateFrom, dateTo, onGoToView }) {
  if (loading) {
    return (
      <div className="h-64 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-3 border-primary-500/30 border-t-primary-400 rounded-full animate-spin"></div>
          <p className="text-sm text-slate-400">Building ward intelligence...</p>
        </div>
      </div>
    );
  }

  if (!data) {
    return <div className="glass-card p-6 text-center text-slate-500 text-sm">Could not load ward intelligence. Try Update.</div>;
  }

  if (data.status === 'not_found') {
    return <div className="glass-card p-6 text-center text-slate-500 text-sm">{data.message}</div>;
  }

  const s = data.summary;
  const level = s.risk_level ? riskLevelMeta(s.risk_level) : null;

  return (
    <div className="space-y-5">
      {/* ── KPI cards ── */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <Kpi label="Incidents" value={s.incidents} color="text-white" />
        <Kpi label="Predictive Risk"
          value={s.risk_score != null ? `${Math.round(s.risk_score)}` : '—'}
          sub={s.risk_level ? s.risk_level.toUpperCase() : 'No data'}
          color={level ? level.text : 'text-slate-500'} />
        <Kpi label="Active Alerts" value={s.active_alerts} color={s.active_alerts > 0 ? 'text-rose-400' : 'text-slate-300'} />
        <Kpi label="Hotspots" value={s.hotspots} color={s.hotspots > 0 ? 'text-orange-400' : 'text-slate-300'} />
        <Kpi label="Repeat Offenders" value={s.repeat_offenders} color={s.repeat_offenders > 0 ? 'text-violet-400' : 'text-slate-300'} />
      </div>

      {/* ── Why this ward matters ── */}
      {data.why_it_matters?.length > 0 && (
        <div className="glass-card p-4 border-primary-500/20 bg-primary-500/[0.03]">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-primary-300 mb-2">Why This Ward Needs Attention</p>
          <ul className="space-y-1">
            {data.why_it_matters.map((line) => (
              <li key={line} className="text-sm text-slate-200 flex gap-2">
                <span className="text-primary-400">•</span> {line}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Trend + Risk row ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <TrendCard trend={data.trend} onGoToView={onGoToView} />
        <RiskCard risk={data.risk} onGoToView={onGoToView} />
      </div>

      {/* ── Alerts + Hotspots row ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <AlertsCard alerts={data.alerts} totalActive={s.active_alerts} onGoToView={onGoToView} />
        <HotspotsCard hotspots={data.hotspots} onGoToView={onGoToView} />
      </div>

      {/* ── Repeat offenders + Network row ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <RepeatOffendersCard offenders={data.repeat_offenders} total={s.repeat_offenders} />
        <NetworkCard summary={data.network_summary} onGoToView={onGoToView} />
      </div>

      {/* ── Crime composition + time pattern ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <CrimeComposition composition={data.crime_composition} />
        <TimePattern pattern={data.time_pattern} />
      </div>

      {/* ── Recent incidents ── */}
      <RecentIncidents district={district} wardId={ward?.id} crimeType={crimeType} dateFrom={dateFrom} dateTo={dateTo} />

      <p className="text-[10px] text-slate-600 italic text-center pt-1">
        For authorized analytical use. Decision-support intelligence only.
      </p>
    </div>
  );
}

function Kpi({ label, value, sub, color }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-3 text-center">
      <p className={`text-2xl font-bold tabular-nums ${color}`}>{value ?? '—'}</p>
      {sub && <p className={`text-[10px] font-semibold ${color}`}>{sub}</p>}
      <p className="text-[10px] uppercase tracking-wide text-slate-500 mt-0.5">{label}</p>
    </div>
  );
}

function CardShell({ title, action, children }) {
  return (
    <div className="glass-card p-4">
      <div className="flex items-center justify-between mb-2">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{title}</p>
        {action}
      </div>
      {children}
    </div>
  );
}

function LinkButton({ onClick, children }) {
  return (
    <button type="button" onClick={onClick} className="text-[11px] font-medium text-primary-300 hover:text-primary-200">
      {children} →
    </button>
  );
}

function TrendCard({ trend, onGoToView }) {
  return (
    <CardShell title="Recent Trend" action={<LinkButton onClick={() => onGoToView('trends')}>View Full Trend</LinkButton>}>
      {!trend ? (
        <p className="text-sm text-slate-500 italic">No unusual crime trend detected in this ward.</p>
      ) : (
        <div>
          <div className="flex items-baseline gap-3">
            <span className={`text-lg font-bold ${trend.summary.trend === 'rising' ? 'text-rose-400' : trend.summary.trend === 'falling' ? 'text-emerald-400' : 'text-slate-300'}`}>
              {trend.summary.trend === 'rising' ? '↑' : trend.summary.trend === 'falling' ? '↓' : '→'} {trend.summary.trend.toUpperCase()}
            </span>
            {trend.summary.change_percent != null && (
              <span className="text-sm text-slate-400">{trend.summary.change_percent > 0 ? '+' : ''}{trend.summary.change_percent}%</span>
            )}
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Current: <span className="text-slate-200 font-medium">{trend.summary.current_value}</span>
            {'  '}· Previous: <span className="text-slate-200 font-medium">{trend.summary.previous_value ?? '—'}</span>
          </p>
          {trend.anomalies?.length > 0 && (
            <p className="text-xs mt-1.5 font-semibold" style={{ color: '#f97316' }}>
              {trend.anomalies[0].severity} anomaly detected
            </p>
          )}
        </div>
      )}
    </CardShell>
  );
}

function RiskCard({ risk, onGoToView }) {
  return (
    <CardShell title="Predictive Risk" action={<LinkButton onClick={() => onGoToView('risk')}>View Risk Details</LinkButton>}>
      {!risk || risk.insufficient_data ? (
        <p className="text-sm text-slate-500 italic">Insufficient historical data for predictive risk.</p>
      ) : (
        <div>
          <div className="flex items-baseline gap-2">
            <span className={`text-2xl font-bold ${riskLevelMeta(risk.risk_level).text}`}>{Math.round(risk.risk_score)}</span>
            <span className="text-sm text-slate-500">/100</span>
            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${riskLevelMeta(risk.risk_level).badge}`}>
              {risk.risk_level.toUpperCase()}
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-1">Next {risk.prediction_horizon_days} days</p>
          <p className="text-xs text-slate-400">
            Expected incidents: <span className="text-slate-200 font-medium">{risk.predicted_incidents}</span>
            {'  '}· Confidence: <span className="text-slate-200 font-medium">{Math.round(risk.confidence * 100)}%</span>
          </p>
        </div>
      )}
    </CardShell>
  );
}

function AlertsCard({ alerts, totalActive, onGoToView }) {
  const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const a of alerts || []) counts[a.severity] = (counts[a.severity] || 0) + 1;
  return (
    <CardShell title="Active Alerts" action={<LinkButton onClick={() => onGoToView('alerts')}>View All Alerts</LinkButton>}>
      {!alerts || alerts.length === 0 ? (
        <p className="text-sm text-slate-500 italic">No active intelligence alerts.</p>
      ) : (
        <div>
          <div className="flex items-center gap-3 mb-2">
            <span className="text-2xl font-bold text-white">{totalActive}</span>
            <div className="flex gap-1.5 text-[10px]">
              {Object.entries(counts).filter(([, n]) => n > 0).map(([sev, n]) => (
                <span key={sev} className={`px-1.5 py-0.5 rounded font-bold ${SEVERITY_BADGE[sev]}`}>{sev} {n}</span>
              ))}
            </div>
          </div>
          <ul className="space-y-1">
            {alerts.slice(0, 3).map((a) => (
              <li key={a.id} className="text-xs text-slate-300 truncate">{a.title}</li>
            ))}
          </ul>
        </div>
      )}
    </CardShell>
  );
}

function HotspotsCard({ hotspots, onGoToView }) {
  return (
    <CardShell title="Hotspots" action={<LinkButton onClick={() => onGoToView('hotspots')}>View on Map</LinkButton>}>
      {!hotspots || hotspots.length === 0 ? (
        <p className="text-sm text-slate-500 italic">No active crime hotspots in this ward.</p>
      ) : (
        <div>
          <p className="text-sm text-slate-300 mb-1.5">{hotspots.length} active cluster{hotspots.length === 1 ? '' : 's'}</p>
          <ul className="space-y-1.5">
            {hotspots.map((h) => (
              <li key={h.cluster_id} className="flex items-center justify-between text-xs">
                <span className="text-slate-300">{h.dominant_crime_type} · {h.incident_count} incidents</span>
                <span className={`px-1.5 py-0.5 rounded font-bold text-[10px] ${HOTSPOT_SEVERITY_BADGE[h.severity_level] || ''}`}>
                  {h.severity_level?.toUpperCase()}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </CardShell>
  );
}

function RepeatOffendersCard({ offenders, total }) {
  return (
    <CardShell title="Repeat Offenders">
      {!offenders || offenders.length === 0 ? (
        <p className="text-sm text-slate-500 italic">No repeat offenders identified for this scope.</p>
      ) : (
        <div>
          <p className="text-sm text-slate-300 mb-1.5">{total} active repeat offender{total === 1 ? '' : 's'}</p>
          <ul className="space-y-1.5">
            {offenders.map((o) => (
              <li key={o.id} className="flex items-center justify-between text-xs">
                <span className="text-slate-300 truncate">{o.name}{o.alias ? ` (${o.alias})` : ''}</span>
                <span className="text-slate-500 flex-shrink-0 ml-2">
                  {o.incident_count} cases · {daysAgo(o.last_activity) || '—'} · {o.tag}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </CardShell>
  );
}

function NetworkCard({ summary, onGoToView }) {
  return (
    <CardShell title="Criminal Network" action={summary && <LinkButton onClick={() => onGoToView('network')}>Open Network</LinkButton>}>
      {!summary ? (
        <p className="text-sm text-slate-500 italic">No network activity identified for this scope.</p>
      ) : (
        <p className="text-sm text-slate-300">
          <span className="text-white font-semibold">{summary.n_nodes}</span> active linked offenders
          {'  '}·  <span className="text-white font-semibold">{summary.n_communities}</span> communities
          {'  '}·  <span className="text-white font-semibold">{summary.tag_breakdown?.['Connector'] || 0}</span> high-connectivity individuals
        </p>
      )}
    </CardShell>
  );
}

function CrimeComposition({ composition }) {
  const colors = ['#38bdf8', '#f97316', '#a78bfa', '#f43f5e', '#facc15', '#34d399', '#94a3b8'];
  return (
    <CardShell title="Crime Mix">
      {!composition || composition.length === 0 ? (
        <p className="text-sm text-slate-500 italic">No incidents in this scope.</p>
      ) : (
        <div className="space-y-1.5">
          {composition.map((c, i) => (
            <div key={c.crime_type} className="flex items-center gap-2">
              <span className="text-xs text-slate-400 w-28 truncate flex-shrink-0">{c.crime_type}</span>
              <div className="flex-1 h-2 rounded-full bg-white/5 overflow-hidden">
                <div className="h-full rounded-full" style={{ width: `${c.percent}%`, backgroundColor: colors[i % colors.length] }} />
              </div>
              <span className="text-xs text-slate-300 w-10 text-right flex-shrink-0">{c.percent}%</span>
            </div>
          ))}
        </div>
      )}
    </CardShell>
  );
}

function TimePattern({ pattern }) {
  return (
    <CardShell title="Activity Pattern">
      {!pattern ? (
        <p className="text-sm text-slate-500 italic">Not enough incidents to establish a time pattern.</p>
      ) : (
        <div className="space-y-1">
          <p className="text-xs text-slate-400">Most active time <span className="block text-base text-white font-semibold">{pattern.most_active_hour_range}</span></p>
          <p className="text-xs text-slate-400 mt-2">Most active day <span className="block text-base text-white font-semibold">{pattern.most_active_day}</span></p>
        </div>
      )}
    </CardShell>
  );
}

// ── Recent incidents (paginated via /api/incidents) + detail drawer ──
const PAGE_SIZE = 10;

function RecentIncidents({ district, wardId, crimeType, dateFrom, dateTo }) {
  const [incidents, setIncidents] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadMoreLoading, setLoadMoreLoading] = useState(false);
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    setIncidents([]);
    setLoading(true);
    setError(false);
    let cancelled = false;
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: '0' });
    if (district) params.set('district', district);
    if (wardId != null) params.set('ward_id', String(wardId));
    if (crimeType) params.set('crime_type', crimeType);
    if (dateFrom) params.set('from', dateFrom);
    if (dateTo) params.set('to', dateTo);
    fetch(`${API_URL}/api/incidents?${params}`)
      .then((res) => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); })
      .then((data) => { if (!cancelled) { setIncidents(data.data || []); setTotal(data.total || 0); setLoading(false); } })
      .catch(() => { if (!cancelled) { setError(true); setLoading(false); } });
    return () => { cancelled = true; };
  }, [district, wardId, crimeType, dateFrom, dateTo]);

  const loadMore = () => {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(incidents.length) });
    if (district) params.set('district', district);
    if (wardId != null) params.set('ward_id', String(wardId));
    if (crimeType) params.set('crime_type', crimeType);
    if (dateFrom) params.set('from', dateFrom);
    if (dateTo) params.set('to', dateTo);
    setLoadMoreLoading(true);
    setError(false);
    fetch(`${API_URL}/api/incidents?${params}`)
      .then((res) => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); })
      .then((data) => setIncidents((prev) => {
        const byId = new Map(prev.map((incident) => [incident.id, incident]));
        for (const incident of data.data || []) byId.set(incident.id, incident);
        return [...byId.values()];
      }))
      .catch(() => setError(true))
      .finally(() => setLoadMoreLoading(false));
  };

  return (
    <CardShell title={`Recent Incidents${total ? ` (${total})` : ''}`}>
      {loading ? (
        <div className="py-6 flex justify-center">
          <div className="w-6 h-6 border-2 border-primary-500/30 border-t-primary-400 rounded-full animate-spin"></div>
        </div>
      ) : error && incidents.length === 0 ? (
        <p className="text-sm text-rose-400">Unable to load incidents. Retry by reopening this ward or using Update.</p>
      ) : incidents.length === 0 ? (
        <p className="text-sm text-slate-500 italic">No incidents found for the selected district, ward, crime type, and date range.</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-slate-500 border-b border-white/10">
                  <th className="text-left font-medium py-1.5 pr-3">Date</th>
                  <th className="text-left font-medium py-1.5 pr-3">Crime</th>
                  <th className="text-right font-medium py-1.5 pr-3">Severity</th>
                  <th className="text-left font-medium py-1.5 pr-3">Ward</th>
                  <th className="text-right font-medium py-1.5">Accused</th>
                </tr>
              </thead>
              <tbody>
                {incidents.map((inc) => (
                  <tr
                    key={inc.id}
                    onClick={() => setSelected(inc)}
                    className="border-b border-white/5 hover:bg-white/[0.03] cursor-pointer transition-colors"
                  >
                    <td className="py-1.5 pr-3 text-slate-300 whitespace-nowrap">{formatDate(inc.timestamp)}</td>
                    <td className="py-1.5 pr-3 text-slate-200">{inc.crime_type}</td>
                    <td className="py-1.5 pr-3 text-right text-slate-300">{inc.severity}</td>
                    <td className="py-1.5 pr-3 text-slate-400 truncate max-w-[120px]">{inc.ward}</td>
                    <td className="py-1.5 text-right text-slate-300">{inc.accused_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {incidents.length < total && (
            <button type="button" onClick={loadMore} disabled={loadMoreLoading}
              className="mt-2 text-[11px] font-medium text-primary-300 hover:text-primary-200 disabled:opacity-50">
              {loadMoreLoading ? 'Loading…' : `Load More (${total - incidents.length} remaining)`}
            </button>
          )}
          {error && incidents.length > 0 && <p className="mt-2 text-[11px] text-rose-400">Unable to load more incidents. Try again.</p>}
        </>
      )}

      {selected && <IncidentDetailModal incident={selected} onClose={() => setSelected(null)} />}
    </CardShell>
  );
}

function IncidentDetailModal({ incident, onClose }) {
  return (
    <div className="incident-detail-backdrop fixed inset-0 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="glass-card p-5 max-w-md w-full" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-base font-bold text-white">Incident Details</h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-white text-lg leading-none">✕</button>
        </div>
        <div className="space-y-2 text-sm">
          <DetailRow label="Date/Time" value={new Date(incident.timestamp).toLocaleString('en-IN')} />
          <DetailRow label="Crime Type" value={incident.crime_type} />
          <DetailRow label="Severity" value={`${incident.severity} / 10`} />
          <DetailRow label="District" value={incident.district} />
          <DetailRow label="Ward" value={incident.ward} />
          <DetailRow label="Coordinates" value={`${incident.lat?.toFixed(4)}, ${incident.lng?.toFixed(4)}`} />
          <DetailRow label="Accused Linked" value={incident.accused_count} />
          {incident.description && <DetailRow label="Notes" value={incident.description} />}
        </div>
      </div>
    </div>
  );
}

function DetailRow({ label, value }) {
  return (
    <div className="flex justify-between gap-3 border-b border-white/5 pb-1.5">
      <span className="text-slate-500">{label}</span>
      <span className="text-slate-200 text-right">{value ?? '—'}</span>
    </div>
  );
}
