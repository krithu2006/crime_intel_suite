/**
 * TrendsPanel — Module 5 UI (Trend Analysis + Anomaly Detection).
 * Analytically distinct from Module 3b's Predictive Risk: this panel only
 * ever describes what already happened (trend direction + deviation from a
 * historical baseline), never a forecast. See trend_analysis.py.
 */
import TrendChart from './TrendChart.jsx';

export const GRANULARITY_OPTIONS = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
];

const SEVERITY_RANK = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
const SEVERITY_STYLE = {
  CRITICAL: { text: 'text-red-400', badge: 'bg-red-500/20 text-red-300 border border-red-500/30', bar: 'bg-red-500' },
  HIGH: { text: 'text-orange-400', badge: 'bg-orange-500/20 text-orange-300 border border-orange-500/30', bar: 'bg-orange-500' },
  MEDIUM: { text: 'text-yellow-400', badge: 'bg-yellow-500/20 text-yellow-300 border border-yellow-500/30', bar: 'bg-yellow-500' },
  LOW: { text: 'text-sky-400', badge: 'bg-sky-500/20 text-sky-300 border border-sky-500/30', bar: 'bg-sky-500' },
};

function trendMeta(trend) {
  if (trend === 'rising') return { icon: '↑', label: 'RISING', color: 'text-rose-400' };
  if (trend === 'falling') return { icon: '↓', label: 'FALLING', color: 'text-emerald-400' };
  return { icon: '→', label: 'STABLE', color: 'text-slate-400' };
}

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function TrendsPanel({ trends, loading, granularity, onGranularityChange }) {
  return (
    <div className="trends-panel glass-card p-5 space-y-5">
      {/* ── Header: granularity selector ── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-sky-500"></span>
            Trends &amp; Anomalies
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            What's unusual right now, compared with historical baseline — not a forecast.
          </p>
        </div>
        <div className="flex rounded-lg border border-white/10 overflow-hidden">
          {GRANULARITY_OPTIONS.map((g) => (
            <button
              key={g.value}
              type="button"
              onClick={() => onGranularityChange(g.value)}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                granularity === g.value
                  ? 'bg-primary-600 text-white'
                  : 'bg-transparent text-slate-400 hover:text-slate-300 hover:bg-white/5'
              }`}
            >
              {g.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="h-64 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <div className="w-8 h-8 border-3 border-sky-500/30 border-t-sky-400 rounded-full animate-spin"></div>
            <p className="text-sm text-slate-400">Analyzing trends...</p>
          </div>
        </div>
      ) : !trends || trends.status === 'no_data' ? (
        <div className="glass-card p-6 text-center text-slate-500 text-sm">
          No incidents match the current filters.
        </div>
      ) : (
        <>
          {trends.status === 'insufficient_data' && (
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-2.5 text-sm text-amber-300">
              Insufficient historical data for anomaly detection. Showing the raw series only.
            </div>
          )}

          <TrendSummary summary={trends.summary} sustained={trends.sustained_trend} />

          <TrendChart series={trends.series} />

          {trends.insights?.length > 0 && (
            <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3 space-y-1">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Insights</p>
              {trends.insights.map((line, i) => (
                <p key={i} className="text-xs text-slate-300">• {line}</p>
              ))}
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <AnomalyCards anomalies={trends.anomalies} />
            <TopEmergingTrends trends={trends.top_emerging_trends} granularity={granularity} />
          </div>
        </>
      )}
    </div>
  );
}

function TrendSummary({ summary, sustained }) {
  if (!summary) return null;
  const t = trendMeta(summary.trend);
  return (
    <div className="trend-summary-strip flex flex-wrap items-end gap-6">
      <div>
        <p className="text-[10px] uppercase tracking-wide text-slate-500">Trend</p>
        <p className={`text-2xl font-bold ${t.color}`}>{t.icon} {t.label}</p>
      </div>
      <div>
        <p className="text-[10px] uppercase tracking-wide text-slate-500">Current</p>
        <p className="text-xl font-bold text-white tabular-nums">{summary.current_value} incidents</p>
      </div>
      <div>
        <p className="text-[10px] uppercase tracking-wide text-slate-500">Previous</p>
        <p className="text-xl font-bold text-slate-300 tabular-nums">
          {summary.previous_value != null ? `${summary.previous_value} incidents` : '—'}
        </p>
      </div>
      <div>
        <p className="text-[10px] uppercase tracking-wide text-slate-500">Change</p>
        <p className={`text-xl font-bold tabular-nums ${t.color}`}>
          {summary.change_percent != null
            ? `${summary.change_percent > 0 ? '+' : ''}${summary.change_percent}%`
            : summary.change > 0 ? 'New activity' : '—'}
        </p>
      </div>
      {sustained?.detected && (
        <div className="badge bg-rose-500/15 text-rose-300 border border-rose-500/30">
          SUSTAINED {sustained.direction === 'rising' ? 'RISE' : 'DECLINE'} · {sustained.periods} periods
        </div>
      )}
    </div>
  );
}

function AnomalyCards({ anomalies }) {
  const sorted = [...(anomalies || [])].sort(
    (a, b) => (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0)
      || (b.anomaly_score || 0) - (a.anomaly_score || 0),
  );

  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 mb-2">
        Detected Anomalies {sorted.length > 0 && `(${sorted.length})`}
      </p>
      <div className="space-y-2 max-h-80 overflow-y-auto pr-1 custom-scrollbar">
        {sorted.length === 0 ? (
          <div className="glass-card p-4 text-center text-slate-500 text-sm">
            No anomalies detected in the current selection.
          </div>
        ) : (
          sorted.slice(0, 20).map((a) => <AnomalyCard key={a.id} anomaly={a} />)
        )}
      </div>
    </div>
  );
}

function AnomalyCard({ anomaly }) {
  const style = SEVERITY_STYLE[anomaly.severity] || SEVERITY_STYLE.LOW;
  const isSpike = anomaly.direction === 'spike';
  return (
    <div className={`anomaly-card anomaly-card--${anomaly.severity?.toLowerCase() || 'low'} rounded-xl border p-3 ${isSpike ? 'bg-rose-500/5 border-rose-500/20' : 'bg-white/[0.02] border-white/5'}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${style.badge}`}>
            {anomaly.severity} {isSpike ? 'SPIKE' : 'DROP'}
          </span>
          <p className="text-sm font-semibold text-white mt-1 truncate">
            {anomaly.crime_type || 'Crime'}{anomaly.ward ? ` — ${anomaly.ward}` : ''}
          </p>
        </div>
        <p className={`text-lg font-bold tabular-nums ${style.text}`}>
          {anomaly.percentage_change != null ? `${anomaly.percentage_change > 0 ? '+' : ''}${anomaly.percentage_change}%` : '—'}
        </p>
      </div>
      <p className="text-[11px] text-slate-400 mt-1">
        Observed: <span className="text-slate-200">{anomaly.observed_value}</span>
        {'  ·  '}Expected: <span className="text-slate-200">{Math.round(anomaly.expected_range.lower)}–{Math.round(anomaly.expected_range.upper)}</span>
      </p>
      <p className="text-[10px] text-slate-600 mt-1">Detected {formatDate(anomaly.period)}</p>
    </div>
  );
}

function TopEmergingTrends({ trends, granularity }) {
  const list = trends || [];
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 mb-2">Top Emerging Trends</p>
      <div className="space-y-2 max-h-80 overflow-y-auto pr-1 custom-scrollbar">
        {list.length === 0 ? (
          <div className="glass-card p-4 text-center text-slate-500 text-sm">
            Nothing stands out beyond the current filter's own trend.
          </div>
        ) : (
          list.map((t, i) => (
            <div key={i} className="emerging-trend-row rounded-xl border border-white/5 bg-white/[0.02] p-3 flex items-start gap-3">
              <span className="text-sm font-bold text-slate-500 w-4">{t.rank}.</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-white truncate">{t.label}</p>
                <p className="text-[11px] text-slate-400">
                  {t.change_percent != null ? `${t.change_percent > 0 ? '+' : ''}${t.change_percent}%` : 'New pattern'}
                  {t.kind === 'sustained' && ` over ${t.periods} ${granularity === 'daily' ? 'days' : granularity === 'monthly' ? 'months' : 'weeks'}`}
                  {t.ward && t.crime_type ? ` · ${t.ward}` : ''}
                </p>
              </div>
              {t.severity && (
                <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${(SEVERITY_STYLE[t.severity] || SEVERITY_STYLE.LOW).badge}`}>
                  {t.severity}
                </span>
              )}
              {!t.severity && t.kind === 'sustained' && (
                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-300 border border-violet-500/30">
                  SUSTAINED
                </span>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
