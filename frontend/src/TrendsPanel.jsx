/**
 * TrendsPanel — Module 5 UI (Trend Analysis + Anomaly Detection).
 * Analytically distinct from Module 3b's Predictive Risk: this panel only
 * ever describes what already happened (trend direction + deviation from a
 * historical baseline), never a forecast. See trend_analysis.py.
 */
import TrendChart from './TrendChart.jsx';
import { useTranslation } from './LanguageContext.jsx';

const SEVERITY_RANK = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
const SEVERITY_STYLE = {
  CRITICAL: { text: 'text-red-400', badge: 'bg-red-500/20 text-red-300 border border-red-500/30', bar: 'bg-red-500' },
  HIGH: { text: 'text-orange-400', badge: 'bg-orange-500/20 text-orange-300 border border-orange-500/30', bar: 'bg-orange-500' },
  MEDIUM: { text: 'text-yellow-400', badge: 'bg-yellow-500/20 text-yellow-300 border border-yellow-500/30', bar: 'bg-yellow-500' },
  LOW: { text: 'text-sky-400', badge: 'bg-sky-500/20 text-sky-300 border border-sky-500/30', bar: 'bg-sky-500' },
};

function trendMeta(trend, t) {
  if (trend === 'rising') return { icon: '↑', label: t('rising'), color: 'text-rose-400' };
  if (trend === 'falling') return { icon: '↓', label: t('falling'), color: 'text-emerald-400' };
  return { icon: '→', label: t('stable'), color: 'text-slate-400' };
}

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function TrendsPanel({ trends, loading, granularity, onGranularityChange }) {
  const { t } = useTranslation();

  const granularityOptions = [
    { value: 'daily', label: t('daily') },
    { value: 'weekly', label: t('weekly') },
    { value: 'monthly', label: t('monthly') },
  ];

  return (
    <div className="trends-panel glass-card p-5 space-y-5">
      {/* ── Header: granularity selector ── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-sky-500"></span>
            {t('trendsAnomaliesTitle')}
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {t('trendsSubtitle')}
          </p>
        </div>
        <div className="flex rounded-lg border border-white/10 overflow-hidden">
          {granularityOptions.map((g) => (
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
              <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{t('insights')}</p>
              {trends.insights.map((line) => (
                <p key={line} className="text-xs text-slate-300">• {line}</p>
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
  const { t } = useTranslation();
  if (!summary) return null;
  const tm = trendMeta(summary.trend, t);
  const changePct = summary.change_pct != null ? `${summary.change_pct > 0 ? '+' : ''}${summary.change_pct}%` : '—';
  const changeColor = summary.change_pct > 0 ? 'text-rose-400' : summary.change_pct < 0 ? 'text-emerald-400' : 'text-slate-400';

  return (
    <div className="trend-summary-strip flex flex-wrap items-end gap-6">
      <div>
        <p className="text-[10px] uppercase tracking-wide text-slate-500">{t('trendStatus')}</p>
        <p className={`text-2xl font-bold ${tm.color}`}>{tm.icon} {tm.label}</p>
      </div>
      <div>
        <p className="text-[10px] uppercase tracking-wide text-slate-500">{t('current')}</p>
        <p className="text-xl font-bold text-white tabular-nums">{summary.current_value} incidents</p>
      </div>
      <div>
        <p className="text-[10px] uppercase tracking-wide text-slate-500">{t('previous')}</p>
        <p className="text-xl font-bold text-slate-300 tabular-nums">{summary.baseline_mean} incidents</p>
      </div>
      <div>
        <p className="text-[10px] uppercase tracking-wide text-slate-500">{t('change')}</p>
        <p className={`text-2xl font-bold tabular-nums ${changeColor}`}>{changePct}</p>
      </div>
      {sustained && (
        <div className="ml-auto text-right">
          <span className="inline-block px-2.5 py-1 text-xs font-semibold rounded-full border border-rose-500/30 bg-rose-500/10 text-rose-300">
            Sustained {sustained.direction} ({sustained.consecutive_periods} periods)
          </span>
        </div>
      )}
    </div>
  );
}

function AnomalyCards({ anomalies }) {
  const { t } = useTranslation();
  const sorted = [...(anomalies || [])].sort((a, b) => (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white flex items-center gap-2">
          <svg className="w-4 h-4 text-rose-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
          </svg>
          {t('detectedAnomalies')} ({sorted.length})
        </h3>
      </div>

      {sorted.length === 0 ? (
        <div className="glass-card p-4 text-center text-xs text-slate-500">
          {t('noAnomalies')}
        </div>
      ) : (
        <div className="space-y-2 max-h-80 overflow-y-auto pr-1 custom-scrollbar">
          {sorted.map((item) => {
            const style = SEVERITY_STYLE[item.severity] || SEVERITY_STYLE.LOW;
            return (
              <div key={`${item.timestamp}:${item.crime_type}`} className="anomaly-card p-3 rounded-lg border flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-md uppercase tracking-wider ${style.badge}`}>
                    {item.severity} SPIKE
                  </span>
                  <span className="text-xs font-bold text-rose-400 tabular-nums">
                    +{item.percentage_increase}%
                  </span>
                </div>
                <p className="text-sm font-semibold text-white">{item.crime_type}</p>
                <div className="flex items-center justify-between text-xs text-slate-400">
                  <span>Observed: <strong className="text-slate-200">{item.observed_count}</strong> &middot; Expected: <strong className="text-slate-200">{item.expected_range?.[0]}-{item.expected_range?.[1]}</strong></span>
                  <span className="text-[11px] text-slate-500">{formatDate(item.timestamp)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TopEmergingTrends({ trends, granularity }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-white flex items-center gap-2">
        <svg className="w-4 h-4 text-sky-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
        </svg>
        {t('topEmergingTrends')}
      </h3>
      {!trends || trends.length === 0 ? (
        <div className="glass-card p-4 text-center text-xs text-slate-500">
          No emerging trends in this view.
        </div>
      ) : (
        <div className="space-y-2 max-h-80 overflow-y-auto pr-1 custom-scrollbar">
          {trends.map((item, idx) => (
            <div key={item.label} className="emerging-trend-row p-3 rounded-lg border flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <span className="text-sm font-bold text-slate-500 tabular-nums">{idx + 1}.</span>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-white truncate">{item.label}</p>
                  <p className="text-xs text-slate-400 truncate">{item.subtext}</p>
                </div>
              </div>
              <div className="text-right flex-shrink-0">
                <span className={`text-xs font-bold ${item.trend_pct > 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                  {item.trend_pct > 0 ? '+' : ''}{item.trend_pct}%
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
