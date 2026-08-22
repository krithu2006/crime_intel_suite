/**
 * DrilldownPanel — Module 7 (District & Ward Intelligence Drilldown).
 * Karnataka -> District -> Ward -> incident/offender/pattern, connecting
 * views that already existed (Risk, Trends, Alerts, Hotspot, Network)
 * instead of re-deriving their numbers. See drilldown.py for the backend
 * orchestration this renders.
 */
import { useMemo, useState } from 'react';
import WardDrilldown from './WardDrilldown.jsx';

const RISK_BADGE = {
  critical: 'bg-red-500/20 text-red-300 border border-red-500/30',
  high: 'bg-orange-500/20 text-orange-300 border border-orange-500/30',
  moderate: 'bg-yellow-500/20 text-yellow-300 border border-yellow-500/30',
  low: 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30',
};
const SEVERITY_BADGE = {
  CRITICAL: 'bg-red-500/20 text-red-300 border border-red-500/30',
  HIGH: 'bg-orange-500/20 text-orange-300 border border-orange-500/30',
  MEDIUM: 'bg-yellow-500/20 text-yellow-300 border border-yellow-500/30',
  LOW: 'bg-sky-500/20 text-sky-300 border border-sky-500/30',
};

const SORT_OPTIONS = [
  { value: 'priority', label: 'Priority' },
  { value: 'risk', label: 'Risk' },
  { value: 'incidents', label: 'Incidents' },
  { value: 'alerts', label: 'Alerts' },
];

export default function DrilldownPanel({
  districtsList, selectedDistrict, selectedWard,
  onSelectDistrict, onSelectWard, onClearWard, onClearToKarnataka,
  districtData, districtLoading, wardData, wardLoading,
  horizonDays, onGoToView,
}) {
  return (
    <div className="district-intelligence space-y-5">
      <Breadcrumb
        district={selectedDistrict}
        ward={selectedWard}
        onClearToKarnataka={onClearToKarnataka}
        onClearWard={onClearWard}
      />

      {selectedWard ? (
        <WardDrilldown
          data={wardData}
          loading={wardLoading}
          district={selectedDistrict}
          ward={selectedWard}
          crimeType={null}
          onGoToView={onGoToView}
        />
      ) : selectedDistrict ? (
        <DistrictView
          district={selectedDistrict}
          data={districtData}
          loading={districtLoading}
          onSelectWard={onSelectWard}
          horizonDays={horizonDays}
        />
      ) : (
        <DistrictSelector districtsList={districtsList} onSelectDistrict={onSelectDistrict} />
      )}
    </div>
  );
}

function Breadcrumb({ district, ward, onClearToKarnataka, onClearWard }) {
  return (
    <div className="district-breadcrumb flex items-center gap-2 text-sm glass-card px-4 py-3">
      <button
        type="button"
        onClick={onClearToKarnataka}
        className={district ? 'text-slate-400 hover:text-white transition-colors' : 'text-white font-semibold'}
      >
        Karnataka
      </button>
      {district && (
        <>
          <span className="text-slate-600">›</span>
          <button
            type="button"
            onClick={onClearWard}
            className={ward ? 'text-slate-400 hover:text-white transition-colors' : 'text-white font-semibold'}
          >
            {district}
          </button>
        </>
      )}
      {ward && (
        <>
          <span className="text-slate-600">›</span>
          <span className="text-white font-semibold">{ward.name}</span>
        </>
      )}
    </div>
  );
}

function DistrictSelector({ districtsList, onSelectDistrict }) {
  return (
    <div className="district-selector glass-card p-8 text-center">
      <p className="text-base font-semibold text-slate-300 mb-1">Select a District to Explore</p>
      <p className="text-sm text-slate-500 mb-5">
        Choose a district to see its intelligence overview — incidents, hotspots, risk, alerts and repeat offenders.
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 max-w-3xl mx-auto">
        {districtsList.map((d) => (
          <button
            key={d.id}
            type="button"
            onClick={() => onSelectDistrict(d.district)}
            className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2.5 text-sm text-slate-200 hover:border-primary-400/40 hover:bg-primary-500/10 hover:text-white transition-colors truncate"
          >
            {d.district}
          </button>
        ))}
      </div>
    </div>
  );
}

function DistrictView({ district, data, loading, onSelectWard, horizonDays }) {
  const [sortBy, setSortBy] = useState('priority');

  const rankings = useMemo(() => {
    const list = data?.ward_rankings || [];
    if (sortBy === 'priority') return list; // backend order = risk, severity, volume
    if (sortBy === 'risk') return [...list].sort((a, b) => (b.risk_score || 0) - (a.risk_score || 0));
    if (sortBy === 'incidents') return [...list].sort((a, b) => b.incidents - a.incidents);
    if (sortBy === 'alerts') return [...list].sort((a, b) => b.active_alerts - a.active_alerts);
    return list;
  }, [data, sortBy]);

  if (loading) {
    return (
      <div className="h-64 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-3 border-primary-500/30 border-t-primary-400 rounded-full animate-spin"></div>
          <p className="text-sm text-slate-400">Building district intelligence...</p>
        </div>
      </div>
    );
  }

  if (!data) {
    return <div className="glass-card p-6 text-center text-slate-500 text-sm">Could not load district intelligence. Try Update.</div>;
  }

  if (data.status === 'not_found') {
    return <div className="glass-card p-6 text-center text-slate-500 text-sm">{data.message}</div>;
  }

  const s = data.summary;

  return (
    <div className="space-y-6">
      <div className="district-hero">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary-500">District intelligence</p>
        <h2 className="text-2xl sm:text-3xl font-bold text-white mt-1">{district}</h2>
        <p className="text-sm text-slate-500 mt-1">A focused view of current risk, activity, and ward priorities.</p>
      </div>

      {/* KPI cards */}
      <div className="district-kpis grid grid-cols-2 sm:grid-cols-5 gap-3">
        <Kpi label="Total Incidents" value={s.incidents.toLocaleString()} color="text-white" />
        <Kpi label="Active Hotspots" value={s.active_hotspots} color={s.active_hotspots > 0 ? 'text-orange-400' : 'text-slate-300'} />
        <Kpi label="High-Risk Wards" value={s.high_risk_wards} color={s.high_risk_wards > 0 ? 'text-red-400' : 'text-slate-300'} />
        <Kpi label="Active Alerts" value={s.active_alerts} color={s.active_alerts > 0 ? 'text-rose-400' : 'text-slate-300'} />
        <Kpi label="Repeat Offenders" value={s.repeat_offenders} color={s.repeat_offenders > 0 ? 'text-violet-400' : 'text-slate-300'} />
      </div>

      {/* Crime composition + trend summary */}
      <div className="district-insight-grid grid grid-cols-1 lg:grid-cols-2 gap-4">
        <CrimeComposition composition={data.crime_composition} />
        <TrendSummary trend={data.trend_summary} />
      </div>

      {/* Ward rankings table */}
      <div className="district-rankings glass-card p-5">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Ward Priorities</p>
          <div className="flex items-center gap-2">
            <label className="text-xs text-slate-500">Sort by</label>
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}
              className="bg-surface-800 border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-white outline-none">
              {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
        </div>

        {rankings.length === 0 ? (
          <p className="text-sm text-slate-500 italic py-4 text-center">No wards found for this district.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-slate-500 text-xs border-b border-white/10">
                  <th className="text-left font-medium py-2 pr-3">Ward</th>
                  <th className="text-right font-medium py-2 pr-3">Incidents</th>
                  <th className="text-left font-medium py-2 pr-3">Risk</th>
                  <th className="text-left font-medium py-2 pr-3">Trend</th>
                  <th className="text-right font-medium py-2 pr-3">Alerts</th>
                  <th className="text-right font-medium py-2">Hotspots</th>
                </tr>
              </thead>
              <tbody>
                {rankings.map((w) => (
                  <tr
                    key={w.ward_id}
                    onClick={() => onSelectWard(w.ward_id, w.ward_name, district)}
                    className="district-ranking-row border-b border-white/5 hover:bg-white/[0.03] cursor-pointer transition-colors"
                  >
                    <td className="py-2 pr-3 text-white font-medium">{w.ward_name}</td>
                    <td className="py-2 pr-3 text-right text-slate-300 tabular-nums">{w.incidents}</td>
                    <td className="py-2 pr-3">
                      {w.risk_level ? (
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${RISK_BADGE[w.risk_level]}`}>
                          {w.risk_level.toUpperCase()} {Math.round(w.risk_score)}
                        </span>
                      ) : (
                        <span className="text-[10px] text-slate-600 italic">no data</span>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      {w.trend_direction ? (
                        <span className={w.trend_direction === 'rising' ? 'text-rose-400' : w.trend_direction === 'falling' ? 'text-emerald-400' : 'text-slate-400'}>
                          {w.trend_direction === 'rising' ? '↑' : w.trend_direction === 'falling' ? '↓' : '→'}
                          {w.trend_change_percent != null ? ` ${Math.round(w.trend_change_percent)}%` : ` ${w.trend_direction}`}
                        </span>
                      ) : <span className="text-slate-600">—</span>}
                    </td>
                    <td className="py-2 pr-3 text-right">
                      {w.active_alerts > 0 ? (
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${SEVERITY_BADGE[w.max_alert_severity] || ''}`}>
                          {w.active_alerts}
                        </span>
                      ) : <span className="text-slate-600">0</span>}
                    </td>
                    <td className="py-2 text-right text-slate-300 tabular-nums">{w.hotspots}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {data.model_performance?.status === 'ok' && (
        <p className="text-[10px] text-slate-600 text-center">
          Predictive risk model — MAE {data.model_performance.mae}, RMSE {data.model_performance.rmse}, next {horizonDays} days.
        </p>
      )}
      <p className="text-[10px] text-slate-600 italic text-center">
        For authorized analytical use. Decision-support intelligence only.
      </p>
    </div>
  );
}

function Kpi({ label, value, color }) {
  return (
    <div className="district-kpi rounded-xl border border-white/10 bg-white/[0.03] px-3 py-4 text-center">
      <p className={`text-3xl font-bold tabular-nums ${color}`}>{value ?? '—'}</p>
      <p className="text-[10px] uppercase tracking-[0.12em] text-slate-500 mt-1">{label}</p>
    </div>
  );
}

function CrimeComposition({ composition }) {
  const colors = ['#38bdf8', '#f97316', '#a78bfa', '#f43f5e', '#facc15', '#34d399', '#94a3b8'];
  return (
    <div className="district-insight-card glass-card p-5">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 mb-2">Crime Composition</p>
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
    </div>
  );
}

function TrendSummary({ trend }) {
  return (
    <div className="district-insight-card glass-card p-5">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 mb-2">Recent Trend</p>
      {!trend ? (
        <p className="text-sm text-slate-500 italic">No unusual crime trend detected in this district.</p>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className={`text-lg font-bold ${trend.trend === 'rising' ? 'text-rose-400' : trend.trend === 'falling' ? 'text-emerald-400' : 'text-slate-300'}`}>
              {trend.trend === 'rising' ? '↑' : trend.trend === 'falling' ? '↓' : '→'} Crime {trend.change_percent != null ? `${trend.change_percent > 0 ? '+' : ''}${trend.change_percent}%` : trend.trend}
            </span>
          </div>
          {trend.top_increase && (
            <p className="text-xs text-slate-400">
              Top increase: <span className="text-rose-300 font-medium">{trend.top_increase.crime_type} +{Math.round(trend.top_increase.change_percent)}%</span>
            </p>
          )}
          {trend.largest_decline && (
            <p className="text-xs text-slate-400">
              Largest decline: <span className="text-emerald-300 font-medium">{trend.largest_decline.crime_type} {Math.round(trend.largest_decline.change_percent)}%</span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
