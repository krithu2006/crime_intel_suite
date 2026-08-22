/**
 * TrendChart — dependency-free inline-SVG time-series chart for Module 5
 * (trend_analysis.py). Renders actual incident counts, the rolling baseline,
 * a shaded expected range, and anomaly markers. No charting library exists
 * in this project yet (only Leaflet + react-force-graph-2d), and the series
 * here is small (daily/weekly/monthly points for one filtered scope), so a
 * plain SVG keeps this dependency-free per the "no unnecessary large
 * dependency" constraint.
 */
import { useState } from 'react';

const WIDTH = 720;
const HEIGHT = 260;
const PAD = { top: 16, right: 16, bottom: 28, left: 36 };

const SEVERITY_COLOR = {
  CRITICAL: '#ef4444',
  HIGH: '#f97316',
  MEDIUM: '#eab308',
  LOW: '#38bdf8',
};

function formatPeriod(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}

export default function TrendChart({ series }) {
  const [hover, setHover] = useState(null);

  if (!series || series.length === 0) {
    return (
      <div className="glass-card p-6 text-center text-slate-500 text-sm">
        No time-series data available for this selection.
      </div>
    );
  }

  const innerW = WIDTH - PAD.left - PAD.right;
  const innerH = HEIGHT - PAD.top - PAD.bottom;

  const maxVal = Math.max(
    1,
    ...series.map((p) => Math.max(p.count, p.upper_bound ?? 0, p.baseline ?? 0)),
  );
  const n = series.length;
  const xFor = (i) => PAD.left + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const yFor = (v) => PAD.top + innerH - (v / maxVal) * innerH;

  const linePath = series.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i)} ${yFor(p.count)}`).join(' ');

  const hasBaseline = series.some((p) => p.baseline != null);
  const baselinePoints = series
    .map((p, i) => (p.baseline != null ? [xFor(i), yFor(p.baseline)] : null))
    .filter(Boolean);
  const baselinePath = hasBaseline
    ? baselinePoints.map(([x, y], idx) => `${idx === 0 ? 'M' : 'L'} ${x} ${y}`).join(' ')
    : null;

  const rangeAreaPoints = hasBaseline
    ? [
        ...series.map((p, i) => (p.upper_bound != null ? [xFor(i), yFor(p.upper_bound)] : null)).filter(Boolean),
        ...series
          .map((p, i) => (p.lower_bound != null ? [xFor(i), yFor(p.lower_bound)] : null))
          .filter(Boolean)
          .reverse(),
      ]
    : [];

  const xTickEvery = Math.max(1, Math.ceil(n / 7));

  return (
    <div className="trend-chart relative">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full h-auto" role="img" aria-label="Incident trend chart">
        {/* Expected range band */}
        {rangeAreaPoints.length > 2 && (
          <polygon
            points={rangeAreaPoints.map(([x, y]) => `${x},${y}`).join(' ')}
            fill="rgba(56,189,248,0.10)"
          />
        )}

        {/* Y-axis gridlines */}
        {[0, 0.25, 0.5, 0.75, 1].map((t) => (
          <line
            key={t}
            x1={PAD.left}
            x2={WIDTH - PAD.right}
            y1={PAD.top + innerH * (1 - t)}
            y2={PAD.top + innerH * (1 - t)}
            stroke="rgba(255,255,255,0.06)"
          />
        ))}

        {/* Baseline (dashed) */}
        {baselinePath && (
          <path d={baselinePath} fill="none" stroke="#94a3b8" strokeWidth="1.5" strokeDasharray="4 3" />
        )}

        {/* Actual line */}
        <path d={linePath} fill="none" stroke="#38bdf8" strokeWidth="2.5" />

        {/* Points + anomaly markers */}
        {series.map((p, i) => {
          const x = xFor(i);
          const y = yFor(p.count);
          const isAnomaly = p.is_anomaly;
          const color = isAnomaly ? SEVERITY_COLOR[p.severity] || '#ef4444' : '#38bdf8';
          return (
            <g key={p.period}>
              <circle
                cx={x}
                cy={y}
                r={isAnomaly ? 6 : 3}
                fill={color}
                stroke={isAnomaly ? '#0f172a' : 'none'}
                strokeWidth={isAnomaly ? 1.5 : 0}
                onMouseEnter={() => setHover({ ...p, x, y })}
                onMouseLeave={() => setHover(null)}
                style={{ cursor: 'pointer' }}
              />
              {isAnomaly && (
                <circle cx={x} cy={y} r={10} fill="none" stroke={color} strokeWidth="1" opacity="0.5" />
              )}
            </g>
          );
        })}

        {/* X-axis labels */}
        {series.map((p, i) =>
          i % xTickEvery === 0 ? (
            <text
              key={`lbl-${p.period}`}
              x={xFor(i)}
              y={HEIGHT - 8}
              fontSize="9"
              fill="#64748b"
              textAnchor="middle"
            >
              {formatPeriod(p.period)}
            </text>
          ) : null,
        )}
      </svg>

      {hover && (
        <div
          className="absolute z-10 pointer-events-none rounded-lg border border-white/10 bg-surface-900/95 px-3 py-2 text-[11px] text-slate-200 shadow-lg"
          style={{
            left: `min(${(hover.x / WIDTH) * 100}%, 70%)`,
            top: `${Math.max((hover.y / HEIGHT) * 100 - 15, 0)}%`,
            transform: 'translate(-10%, -100%)',
            minWidth: 170,
          }}
        >
          <p className="font-semibold text-white">{formatPeriod(hover.period)}</p>
          <p>Observed: <span className="font-medium">{hover.count}</span></p>
          {hover.lower_bound != null && (
            <p>Expected: {Math.round(hover.lower_bound)}–{Math.round(hover.upper_bound)}</p>
          )}
          {hover.percentage_change != null && (
            <p className={hover.direction === 'spike' ? 'text-rose-400' : 'text-emerald-400'}>
              {hover.percentage_change > 0 ? '+' : ''}{hover.percentage_change}% vs baseline
            </p>
          )}
          {hover.is_anomaly && (
            <p className="mt-1 font-bold" style={{ color: SEVERITY_COLOR[hover.severity] }}>
              {hover.severity} ANOMALY
            </p>
          )}
          {hover.insufficient_baseline && (
            <p className="italic text-slate-500">Insufficient baseline</p>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-4 mt-2 text-[10px] text-slate-500">
        <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-sky-400 inline-block" /> Actual</span>
        <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-slate-400 inline-block" style={{ borderTop: '1px dashed #94a3b8' }} /> Baseline</span>
        <span className="flex items-center gap-1"><span className="w-3 h-2.5 bg-sky-400/10 inline-block border border-sky-400/20" /> Expected range</span>
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-rose-500 inline-block" /> Anomaly</span>
      </div>
    </div>
  );
}
