import { useTranslation } from './LanguageContext.jsx';

/**
 * RisingZones — Panel listing hotspot clusters ranked by computed risk score.
 */
export default function RisingZones({ hotspots, loading }) {
  const { t } = useTranslation();

  if (loading) {
    return (
      <div className="glass-card p-6 h-full flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-3 border-accent-amber/30 border-t-accent-amber rounded-full animate-spin"></div>
          <p className="text-sm text-slate-400">
            {t('hotspotClusters')}...
          </p>
        </div>
      </div>
    );
  }

  const clusters = hotspots?.clusters || [];

  if (clusters.length === 0) {
    return (
      <div className="glass-card p-6 text-center text-slate-500">
        {t('noHotspotsFound')}
      </div>
    );
  }

  const rankedClusters = [...clusters].sort(
    (a, b) => b.risk_score - a.risk_score
  );

  const highRiskClusters = rankedClusters.filter(
    (c) => c.severity_level === "High"
  );
  const mediumRiskClusters = rankedClusters.filter(
    (c) => c.severity_level === "Medium"
  );
  const lowRiskClusters = rankedClusters.filter(
    (c) => c.severity_level === "Low"
  );

  return (
    <div className="rising-zones flex flex-col gap-4 h-full">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-bold text-white flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse"></span>
            {t('risingZones')}
          </h3>

          <p className="text-xs text-slate-500 mt-0.5">
            {t('hotspotClustersRanked')}
          </p>
        </div>

        <div className="badge bg-rose-500/20 text-rose-300 border border-rose-500/30">
          {highRiskClusters.length} {t('highRisk')}
        </div>
      </div>

      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-slate-400">
        <span className="badge bg-red-500/15 text-red-300 border border-red-500/30">
          High Risk: {highRiskClusters.length}
        </span>

        <span className="badge bg-amber-500/15 text-amber-300 border border-amber-500/30">
          Medium Risk: {mediumRiskClusters.length}
        </span>

        <span className="badge bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
          Low Risk: {lowRiskClusters.length}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto space-y-2 pr-1 custom-scrollbar">
        {rankedClusters.map((cluster) => (
          <ClusterCard
            key={cluster.cluster_id}
            cluster={cluster}
          />
        ))}
      </div>

      <div className="text-xs text-slate-600 border-t border-white/5 pt-2">
        Sorted by risk score, computed from incident concentration and average
        severity.
      </div>
    </div>
  );
}

function ClusterCard({ cluster }) {
  const isHigh = cluster.severity_level === "High";
  const isMedium = cluster.severity_level === "Medium";

  const scoreClass = isHigh
    ? "text-rose-400"
    : isMedium
    ? "text-amber-400"
    : "text-emerald-400";

  const levelBadgeClass = isHigh
    ? "bg-rose-500/20 text-rose-300 border border-rose-500/30"
    : isMedium
    ? "bg-amber-500/20 text-amber-300 border border-amber-500/30"
    : "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30";

  const cardClass = isHigh
    ? "bg-rose-500/5 border-rose-500/20"
    : isMedium
    ? "bg-amber-500/5 border-amber-500/20"
    : "bg-white/[0.02] border-white/5";

  return (
    <div className={`hotspot-rank-card hotspot-rank-card--${cluster.severity_level.toLowerCase()} ward-card-hover rounded-xl border p-3 ${cardClass}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold text-white truncate">
              {cluster.district || `Hotspot #${cluster.cluster_id + 1}`}
            </p>

            <span
              className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${levelBadgeClass}`}
            >
              {cluster.severity_level.toUpperCase()}
            </span>
          </div>

          <p className="text-xs text-slate-500 truncate">
            Hotspot #{cluster.cluster_id + 1} · {cluster.dominant_crime_type}
          </p>
        </div>

        <div className="text-right flex-shrink-0">
          <p className={`text-lg font-bold tabular-nums ${scoreClass}`}>
            {cluster.risk_score.toFixed(1)}
          </p>

          <p className="text-[10px] text-slate-600">risk score</p>
        </div>
      </div>

      <div className="mt-1.5 flex items-center gap-3 text-xs text-slate-500">
        <span>
          Incidents:{" "}
          <span className="text-slate-300">{cluster.incident_count}</span>
        </span>

        <span>
          Avg Severity:{" "}
          <span className="text-slate-300">{cluster.avg_severity}</span>
        </span>

        <span>
          Radius:{" "}
          <span className="text-slate-300">{cluster.radius_m}m</span>
        </span>
      </div>
    </div>
  );
}
