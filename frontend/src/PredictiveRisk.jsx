/**
 * PredictiveRisk — shared UI pieces for the Predictive Risk feature.
 * Renders forecast blocks (ward cards, map popups), the horizon selector,
 * and the Model Performance panel. Kept separate from the existing
 * "descriptive" risk components (RiskRankings/RiskWardCard in App.jsx,
 * RiskScoreMap's popup) so the two concepts stay visually distinct, per the
 * Descriptive vs Predictive Risk requirement.
 */

export const HORIZON_OPTIONS = [7, 14, 30];
export const DEFAULT_HORIZON = 14;

export const PREDICTION_DISCLAIMER =
  'Decision-support prediction based on historical patterns. Requires analyst validation.';

export function riskLevelMeta(level) {
  switch (level) {
    case 'critical':
      return { label: 'CRITICAL', text: 'text-red-400', badge: 'bg-red-500/20 text-red-300 border border-red-500/30' };
    case 'high':
      return { label: 'HIGH', text: 'text-orange-400', badge: 'bg-orange-500/20 text-orange-300 border border-orange-500/30' };
    case 'moderate':
      return { label: 'MODERATE', text: 'text-yellow-400', badge: 'bg-yellow-500/20 text-yellow-300 border border-yellow-500/30' };
    default:
      return { label: 'LOW', text: 'text-emerald-400', badge: 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' };
  }
}

export function trendMeta(trend) {
  if (trend === 'rising') return { icon: '↑', label: 'Rising', color: 'text-rose-400' };
  if (trend === 'falling') return { icon: '↓', label: 'Falling', color: 'text-emerald-400' };
  return { icon: '→', label: 'Stable', color: 'text-slate-400' };
}

/** Horizon selector — 7 / 14 / 30 days. Only meaningful in Risk Score View. */
export function HorizonSelector({ value, onChange }) {
  return (
    <div className="flex items-center gap-2">
      <label className="text-xs text-slate-500">Predict</label>
      <div className="flex rounded-lg border border-white/10 overflow-hidden">
        {HORIZON_OPTIONS.map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => onChange(d)}
            aria-pressed={value === d}
            className={`px-2.5 py-1 text-xs font-medium transition-colors ${
              value === d
                ? 'bg-primary-600 text-white'
                : 'bg-transparent text-slate-400 hover:text-slate-300 hover:bg-white/5'
            }`}
          >
            {d}d
          </button>
        ))}
      </div>
    </div>
  );
}

/** Compact predictive block appended to a ward card / popup. */
export function PredictiveRiskBlock({ prediction, compact = false }) {
  if (!prediction) {
    return (
      <div className="mt-2 pt-2 border-t border-white/5">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 mb-1">Predictive Risk</p>
        <p className="text-[11px] text-slate-500 italic">Prediction not available for this selection.</p>
      </div>
    );
  }

  if (prediction.insufficient_data) {
    return (
      <div className="mt-2 pt-2 border-t border-white/5">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 mb-1">Predictive Risk</p>
        <p className="text-[11px] text-slate-500 italic">
          {prediction.message || 'Insufficient historical data for reliable prediction.'}
        </p>
      </div>
    );
  }

  const level = riskLevelMeta(prediction.risk_level);
  const trend = trendMeta(prediction.trend);

  return (
    <div className="mt-2 pt-2 border-t border-white/5">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          Predictive Risk · Next {prediction.prediction_horizon_days}d
        </p>
        <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${level.badge}`}>{level.label}</span>
      </div>
      <div className="flex items-center gap-3 mt-1">
        <p className={`text-xl font-bold tabular-nums ${level.text}`}>{Math.round(prediction.risk_score)}</p>
        <div className="text-[11px] text-slate-400 leading-tight">
          <p>
            Expected incidents: <span className="text-slate-200 font-medium">{prediction.predicted_incidents?.toFixed(1)}</span>
          </p>
          <p>
            Confidence: <span className="text-slate-200 font-medium">{Math.round(prediction.confidence * 100)}%</span>
            {' · '}
            <span className={trend.color}>{trend.icon} {trend.label}</span>
          </p>
        </div>
      </div>
      {!compact && prediction.top_factors?.length > 0 && (
        <div className="mt-1.5">
          <p className="text-[10px] text-slate-500 mb-0.5">Why this ward is flagged</p>
          <ul className="space-y-0.5">
            {prediction.top_factors.slice(0, 4).map((f, i) => (
              <li key={`${f.label}:${f.direction || ''}`} className="text-[10.5px] text-slate-400 flex gap-1">
                <span className="text-slate-600">{i + 1}.</span> {f.label}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Compact Model Performance panel — only ever shows real computed metrics. */
export function ModelPerformanceCard({ modelPerformance }) {
  if (!modelPerformance) return null;
  const mp = modelPerformance;

  if (mp.status !== 'ok') {
    return (
      <div className="glass-card p-3 rounded-lg text-[11px] text-slate-500 italic">
        {mp.message || 'Not enough historical data yet to validate the prediction model for this selection.'}
      </div>
    );
  }

  return (
    <div className="glass-card p-3 rounded-lg space-y-1.5">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Model Performance</p>
      <div className="grid grid-cols-3 gap-2 text-center">
        <div>
          <p className="text-sm font-bold text-sky-300">{mp.mae?.toFixed(2) ?? '—'}</p>
          <p className="text-[9px] text-slate-500">MAE (incidents)</p>
        </div>
        <div>
          <p className="text-sm font-bold text-violet-300">{mp.rmse?.toFixed(2) ?? '—'}</p>
          <p className="text-[9px] text-slate-500">RMSE</p>
        </div>
        <div>
          <p className="text-sm font-bold text-emerald-300">
            {mp.precision_at_topk != null ? `${Math.round(mp.precision_at_topk * 100)}%` : '—'}
          </p>
          <p className="text-[9px] text-slate-500">Top-{mp.top_k ?? 5} Precision</p>
        </div>
      </div>
      <p className="text-[10px] text-slate-600">
        Train: {mp.training_period?.from} → {mp.training_period?.to}
        {' · '}Test: {mp.test_period?.from} → {mp.test_period?.to}
      </p>
      <p className="text-[10px] text-slate-600">
        {mp.n_train_samples} train / {mp.n_test_samples} test samples · {mp.algorithm}
      </p>
    </div>
  );
}
