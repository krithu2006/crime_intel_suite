import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { API_URL } from './config.js';
import ForceGraph2D from 'react-force-graph-2d';
import { useTranslation } from './LanguageContext.jsx';
import MapPopupButton from './MapPopupButton.jsx';

// ── Vibrant Multicolor Palette for Network Nodes ──
const MULTICOLOR_PALETTE = [
  '#0284c7', // vibrant cyan-blue
  '#e11d48', // vibrant rose-red
  '#059669', // vibrant emerald green
  '#d97706', // vibrant amber yellow
  '#7c3aed', // vibrant purple
  '#ea580c', // vibrant orange
  '#0284c7', // sky blue
  '#db2777', // pink
  '#65a30d', // lime green
  '#4f46e5', // indigo
  '#0891b2', // teal
  '#c026d3', // fuchsia
];

const COMMUNITY_COLORS = [
  '#0284c7', '#e11d48', '#059669', '#d97706', '#7c3aed',
  '#ea580c', '#db2777', '#65a30d', '#4f46e5', '#0891b2',
  '#c026d3', '#06b6d4', '#f43f5e', '#10b981', '#fbbf24',
];

function getDisplayName(node) {
  return node?.name || node?.accused_name || node?.label || `Individual ${node?.id ?? ''}`;
}

function getCommunityColor(id) {
  if (id === undefined || id === null || id < 0) return '#64748b';
  return COMMUNITY_COLORS[id % COMMUNITY_COLORS.length];
}

function getNodeColor(node) {
  if (!node) return '#64748b';
  const idVal = typeof node.id === 'number' ? node.id : String(node.id || '').length;
  const hash = Math.abs(idVal * 17 + (node.community_id || 0) * 31);
  return MULTICOLOR_PALETTE[hash % MULTICOLOR_PALETTE.length];
}

function getNodeId(value) {
  return typeof value === 'object' ? value?.id : value;
}

function initials(name) {
  return (name || '?')
    .split(' ')
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

function fmtDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? value
    : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

// ═══════════════════════════════════════════════════════════════════════════
//  NETWORK GRAPH
// ═══════════════════════════════════════════════════════════════════════════

export function NetworkGraph({ network, loading, onNodeSelect, selectedNodeId, dateFrom, dateTo }) {
  const { t } = useTranslation();
  const fgRef = useRef();
  const [hoverId, setHoverId] = useState(null);
  const [highlightedCommunity, setHighlightedCommunity] = useState(null);
  const [search, setSearch] = useState('');
  const [ready, setReady] = useState(false);

  // Fade-in the canvas once data is present.
  useEffect(() => {
    setReady(false);
    if (network?.nodes?.length) {
      const t = window.setTimeout(() => setReady(true), 60);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [network]);

  // ── Build the render graph: only connected offenders (drop isolated dots),
  //    sized compactly by centrality (PageRank), coloured by community. ──
  const { graphData, adjacency, maxComponent } = useMemo(() => {
    const allNodes = network?.nodes || [];
    const allEdges = network?.edges || [];

    const connected = allNodes.filter((n) => !n.is_isolated);
    const baseNodes = connected.length ? connected : allNodes;
    const nodeIds = new Set(baseNodes.map((n) => n.id));
    const edges = allEdges.filter(
      (e) => nodeIds.has(getNodeId(e.source)) && nodeIds.has(getNodeId(e.target))
    );

    // Centrality → compact radius (2.2px → 5.5px) so no two balls overlap.
    const influence = (n) => (n.pagerank && n.pagerank > 0 ? n.pagerank : (n.degree || 0) + 0.0001);
    const maxInf = Math.max(...baseNodes.map(influence), 1e-9);

    // Adjacency map powers neighbour highlighting when a node is selected.
    const adj = new Map();
    baseNodes.forEach((n) => adj.set(n.id, new Set()));
    edges.forEach((e) => {
      const s = getNodeId(e.source);
      const t = getNodeId(e.target);
      adj.get(s)?.add(t);
      adj.get(t)?.add(s);
    });

    const nodes = baseNodes.map((n) => {
      // Smaller nodes leave room for labels and make dense groups legible.
      const r = 6 + 7 * Math.sqrt(influence(n) / maxInf); // 6px → 13px radius
      return { ...n, _r: r, val: r * r };
    });

    // Largest community id (for legend emphasis)
    const largest = network?.communities?.[0]?.id ?? null;

    return {
      graphData: {
        nodes,
        links: edges.map((e) => ({
          source: getNodeId(e.source),
          target: getNodeId(e.target),
          weight: e.weight || 1,
        })),
      },
      adjacency: adj,
      maxComponent: largest,
    };
  }, [network]);

  const maxWeight = useMemo(
    () => Math.max(...graphData.links.map((l) => l.weight), 1),
    [graphData]
  );

  // Which node is the current "focus" (selection wins over hover).
  const focusId = selectedNodeId ?? hoverId;
  const focusNeighbors = useMemo(() => {
    if (focusId == null) return null;
    const set = new Set([focusId]);
    adjacency.get(focusId)?.forEach((id) => set.add(id));
    return set;
  }, [focusId, adjacency]);

  const searchMatches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return null;
    return new Set(
      graphData.nodes.filter((n) => getDisplayName(n).toLowerCase().includes(q)).map((n) => n.id)
    );
  }, [search, graphData]);

  // ── Tune forces + frame the graph whenever data/selection changes. ──
  useEffect(() => {
    if (!fgRef.current || !graphData.nodes.length) return undefined;
    // A compact investigation-board layout keeps related people readable
    // instead of scattering each community across the full canvas.
    fgRef.current.d3Force('charge')?.strength(-215);
    fgRef.current.d3Force('link')?.distance((l) => 64 - Math.min(16, l.weight * 2))?.strength(0.76);
    // react-force-graph exposes the simulation directly. This lightweight
    // collision force keeps an 8px air gap around every rendered node.
    const nodeSpacing = () => {
      const nodes = graphData.nodes;
      for (let i = 0; i < nodes.length; i += 1) {
        const a = nodes[i];
        if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) continue;
        for (let j = i + 1; j < nodes.length; j += 1) {
          const b = nodes[j];
          if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) continue;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const distance = Math.hypot(dx, dy) || 0.01;
          const minimumDistance = a._r + b._r + 8;
          if (distance >= minimumDistance) continue;
          const adjustment = ((minimumDistance - distance) / distance) * 0.5;
          const pushX = dx * adjustment;
          const pushY = dy * adjustment;
          a.vx = (a.vx || 0) - pushX;
          a.vy = (a.vy || 0) - pushY;
          b.vx = (b.vx || 0) + pushX;
          b.vy = (b.vy || 0) + pushY;
        }
      }
    };
    nodeSpacing.initialize = () => {};
    fgRef.current.d3Force('nodeSpacing', nodeSpacing);
    fgRef.current.d3ReheatSimulation();
    const t = window.setTimeout(() => fgRef.current?.zoomToFit(500, 70), 400);
    return () => window.clearTimeout(t);
  }, [graphData]);

  const isDimmed = useCallback(
    (nodeId, communityId) => {
      if (searchMatches) return !searchMatches.has(nodeId);
      if (focusNeighbors) return !focusNeighbors.has(nodeId);
      if (highlightedCommunity !== null) return communityId !== highlightedCommunity;
      return false;
    },
    [searchMatches, focusNeighbors, highlightedCommunity]
  );

  const drawNode = useCallback(
    (node, ctx, globalScale) => {
      const r = node._r;
      const color = getCommunityColor(node.community_id);
      const dimmed = isDimmed(node.id, node.community_id);
      const isFocus = node.id === focusId;
      const alpha = dimmed ? 0.12 : 1;

      ctx.globalAlpha = alpha;

      // Glow halo for focus / matches
      if (isFocus || (searchMatches && searchMatches.has(node.id))) {
        ctx.shadowColor = color;
        ctx.shadowBlur = 22;
      }

      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.shadowBlur = 0;

      if (!dimmed) {
        ctx.lineWidth = (isFocus ? 2.5 : 1) / globalScale;
        ctx.strokeStyle = isFocus ? '#0284c7' : 'rgba(15,23,42,0.25)';
        ctx.stroke();

        // Community leader → gold ring; bridge (Connector) → dashed cyan ring.
        if (node.is_leader) {
          ctx.beginPath();
          ctx.arc(node.x, node.y, r + 3 / globalScale, 0, 2 * Math.PI);
          ctx.lineWidth = 2.5 / globalScale;
          ctx.strokeStyle = '#d97706';
          ctx.stroke();
        } else if (node.is_bridge) {
          ctx.beginPath();
          ctx.setLineDash([3 / globalScale, 3 / globalScale]);
          ctx.arc(node.x, node.y, r + 3 / globalScale, 0, 2 * Math.PI);
          ctx.lineWidth = 2 / globalScale;
          ctx.strokeStyle = '#0284c7';
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }

      // Display name labels under every node in the active view
      if (!dimmed && globalScale > 0.35) {
        const label = getDisplayName(node);
        const fontSize = Math.max(9, (isFocus ? 13 : 11)) / globalScale;
        ctx.font = `700 ${fontSize}px Inter, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const y = node.y + r + 4 / globalScale;
        const w = ctx.measureText(label).width + 8 / globalScale;
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.fillRect(node.x - w / 2, y - 2 / globalScale, w, fontSize * 1.3);
        ctx.fillStyle = '#0f172a';
        ctx.fillText(label, node.x, y);
      }
      ctx.globalAlpha = 1;
    },
    [isDimmed, focusId, searchMatches]
  );

  // ── Zoom / view controls ──
  const zoomBy = (factor) => {
    if (!fgRef.current) return;
    fgRef.current.zoom(fgRef.current.zoom() * factor, 260);
  };
  const fit = () => fgRef.current?.zoomToFit(500, 70);
  const reset = () => {
    setHighlightedCommunity(null);
    setSearch('');
    onNodeSelect(null);
    fgRef.current?.d3ReheatSimulation();
    window.setTimeout(fit, 400);
  };

  const runSearch = () => {
    if (!searchMatches || searchMatches.size === 0) return;
    const first = graphData.nodes.find((n) => searchMatches.has(n.id));
    if (first) {
      onNodeSelect(first.id);
      if (first.x != null) fgRef.current?.centerAt(first.x, first.y, 600);
      fgRef.current?.zoom(3, 600);
    }
  };

  if (loading) {
    return (
      <div className="absolute inset-0 z-[1000] bg-white/90 backdrop-blur-sm flex items-center justify-center rounded-2xl">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-3 border-sky-500/30 border-t-sky-600 rounded-full animate-spin" />
          <p className="text-sm font-medium text-slate-700">{t('mappingNetwork')}</p>
        </div>
      </div>
    );
  }

  if (!network?.nodes?.length) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center gap-2 bg-white border border-slate-200 rounded-2xl">
        <svg className="w-10 h-10 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5" />
        </svg>
        <p className="text-sm font-medium text-slate-700">{t('noNetworkFound')}</p>
        <p className="text-xs text-slate-500">{t('noNetworkHint')}</p>
      </div>
    );
  }

  const s = network.summary || {};

  return (
      <div className="network-console relative w-full h-full rounded-2xl overflow-hidden bg-white border border-slate-200 shadow-sm">
      {/* Subtle grid backdrop for the clean light console feel */}
      <div
        className="network-console__grid pointer-events-none absolute inset-0 opacity-[0.5]"
        style={{
          backgroundImage:
            'linear-gradient(rgba(203,213,225,0.4) 1px, transparent 1px), linear-gradient(90deg, rgba(203,213,225,0.4) 1px, transparent 1px)',
          backgroundSize: '32px 32px',
        }}
      />

      <div
        className="absolute inset-0 transition-opacity duration-700"
        style={{ opacity: ready ? 1 : 0 }}
      >
        <ForceGraph2D
          ref={fgRef}
          graphData={graphData}
          backgroundColor="#ffffff"
          nodeRelSize={4}
          nodeLabel={(node) => {
            const flags = [
              node.is_leader ? `<span style="color:#d97706;font-weight:700">★ ${t('leader')}</span>` : '',
              node.is_bridge ? `<span style="color:#0284c7;font-weight:700">⇄ ${t('bridge')}</span>` : '',
            ].filter(Boolean).join(' · ');
            return `<div style="font-family:Inter,sans-serif;font-size:12px;color:#0f172a;background:#ffffff;border:1px solid #cbd5e1;padding:8px 10px;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.15)">
              <div style="font-weight:700;color:#0f172a;margin-bottom:2px">${getDisplayName(node)}</div>
              <div style="color:#0284c7;font-weight:600">${node.tag || 'Associate'} · Group ${node.community_label ?? '—'}</div>
              ${flags ? `<div style="margin-top:2px">${flags}</div>` : ''}
              <div style="color:#475569;margin-top:3px">${node.incident_count ?? 0} ${t('incidentsCount')} · ${node.degree_count ?? 0} ${t('connections')}</div>
              <div style="color:#64748b">${node.dominant_crime || ''} ${node.primary_district ? '· ' + node.primary_district : ''}</div>
            </div>`;
          }}
          nodeCanvasObjectMode={() => 'replace'}
          nodeCanvasObject={drawNode}
          nodePointerAreaPaint={(node, color, ctx) => {
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(node.x, node.y, node._r, 0, 2 * Math.PI);
            ctx.fill();
          }}
          linkCurvature={0.22}
          linkColor={(link) => {
            const src = getNodeId(link.source);
            const tgt = getNodeId(link.target);
            const active = focusId != null && (src === focusId || tgt === focusId);
            if (focusId != null) {
              return active ? '#0284c7' : 'rgba(14,165,233,0.16)';
            }
            if (highlightedCommunity !== null) {
              const sN = graphData.nodes.find((n) => n.id === src);
              const tN = graphData.nodes.find((n) => n.id === tgt);
              const inC =
                sN?.community_id === highlightedCommunity && tN?.community_id === highlightedCommunity;
              return inC ? '#0284c7' : 'rgba(14,165,233,0.12)';
            }
            const a = 0.34 + 0.42 * (link.weight / maxWeight);
            return `rgba(14, 165, 233, ${a.toFixed(2)})`;
          }}
          linkWidth={(link) => {
            const src = getNodeId(link.source);
            const tgt = getNodeId(link.target);
            const active = focusId != null && (src === focusId || tgt === focusId);
            if (active) return 2.8;
            return Math.min(3.2, 1.0 + (link.weight / maxWeight) * 2.4);
          }}
          linkDirectionalParticles={(link) => {
            const src = getNodeId(link.source);
            const tgt = getNodeId(link.target);
            const active = focusId != null && (src === focusId || tgt === focusId);
            return active ? 3 : 0;
          }}
          linkDirectionalParticleWidth={2.5}
          linkDirectionalParticleColor={() => '#0284c7'}
          onNodeHover={(node) => setHoverId(node ? node.id : null)}
          onNodeClick={(node) => {
            setHighlightedCommunity(null);
            onNodeSelect(node.id);
          }}
          onBackgroundClick={() => onNodeSelect(null)}
          cooldownTicks={120}
          onEngineStop={() => fgRef.current?.zoomToFit(500, 70)}
        />
      </div>

      {/* ── Search (top-left) ── */}
      <div className="absolute top-4 left-4 z-[1000] flex items-center gap-2">
        <div className="bg-white/95 backdrop-blur-md border border-slate-200 rounded-xl flex items-center gap-2 px-3 py-2 shadow-lg">
          <svg className="w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="m21 21-4.35-4.35m1.35-5.15a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0z" />
          </svg>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && runSearch()}
            placeholder={t('searchOffender')}
            className="bg-transparent text-sm text-slate-800 placeholder-slate-400 outline-none w-40 font-medium"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="text-slate-400 hover:text-slate-700"
              aria-label="Clear search"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
        {searchMatches && (
          <span className="text-[10px] font-bold text-sky-700 bg-sky-50 border border-sky-200 px-2.5 py-1 rounded-lg shadow-sm">
            {searchMatches.size} match{searchMatches.size === 1 ? '' : 'es'}
          </span>
        )}
      </div>

      {/* ── Analysis window banner (top-center) ── */}
      <div className="absolute top-4 left-1/2 -translate-x-1/2 z-[1000] bg-white/95 backdrop-blur-md border border-slate-200 rounded-xl px-3.5 py-1.5 shadow-md pointer-events-none hidden md:flex items-center gap-2">
        <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
        <p className="text-[11px] font-semibold text-slate-700">
          <span className="text-slate-500 uppercase tracking-wide text-[10px]">{t('analysisWindow')} · </span>
          {dateFrom && dateTo ? `${fmtDate(dateFrom)} – ${fmtDate(dateTo)}` : t('fullDataset')}
        </p>
      </div>

      {/* ── Statistics card (top-right) ── */}
      <div className="absolute top-4 right-4 z-[1000] bg-white/95 backdrop-blur-md border border-slate-200 rounded-xl px-4 py-3 shadow-lg pointer-events-none w-[185px]">
        <p className="text-[10px] font-bold tracking-[0.15em] text-sky-700 uppercase mb-2">{t('networkIntel')}</p>
        <div className="grid grid-cols-2 gap-x-3 gap-y-2 text-left">
          <Stat label={t('individuals')} value={s.n_nodes ?? graphData.nodes.length} />
          <Stat label={t('connections')} value={s.n_edges ?? graphData.links.length} />
          <Stat label={t('communities')} value={s.n_communities ?? 0} />
          <Stat label={t('avgDegree')} value={s.avg_degree ?? '—'} />
          <div className="col-span-2 border-t border-slate-200 pt-1.5">
            <Stat label={t('largestNetwork')} value={`${s.largest_community ?? 0}`} />
          </div>
        </div>
      </div>

      {/* ── Zoom & Full-screen controls (bottom-right) ── */}
      <div className="absolute bottom-4 right-4 z-[1000] flex flex-col gap-1.5">
        <ZoomBtn title="Zoom in" onClick={() => zoomBy(1.4)}>+</ZoomBtn>
        <ZoomBtn title="Zoom out" onClick={() => zoomBy(1 / 1.4)}>−</ZoomBtn>
        <MapPopupButton title={t('criminalNetwork')}>
          {() => (
            <NetworkGraph
              network={network}
              loading={loading}
              selectedNodeId={selectedNodeId}
              onNodeSelect={onNodeSelect}
              dateFrom={dateFrom}
              dateTo={dateTo}
            />
          )}
        </MapPopupButton>
        <ZoomBtn title="Reset graph" onClick={reset}>
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h5M20 20v-5h-5M20 9A8 8 0 0 0 5.6 5.6M4 15a8 8 0 0 0 14.4 3.4" />
          </svg>
        </ZoomBtn>
      </div>

      {/* ── Legend + community list (bottom-left) ── */}
      <div className="absolute bottom-4 left-4 z-[1000] bg-white/95 backdrop-blur-md border border-slate-200 rounded-xl px-3.5 py-2.5 max-w-[220px] shadow-lg">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] font-medium text-slate-600 mb-2">
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-slate-500" />
            {t('sizeInfluence')}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-4 h-[2px] rounded bg-slate-700" />
            {t('edgeShared')}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full border-2 border-amber-500" />
            {t('leader')}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full border-2 border-dashed border-sky-500" />
            {t('bridge')}
          </span>
        </div>
        <p className="text-[9px] uppercase tracking-wide font-semibold text-slate-500 mb-1">{t('communitiesIsolate')}</p>
        <div className="flex flex-col gap-0.5 max-h-20 overflow-y-auto pr-1 custom-scrollbar">
          {(network.communities || []).map((c) => (
            <button
              key={c.id}
              onClick={() => setHighlightedCommunity(highlightedCommunity === c.id ? null : c.id)}
              className={`flex items-center gap-1.5 text-left px-1.5 py-0.5 rounded transition-colors ${
                highlightedCommunity === c.id
                  ? 'bg-slate-100 text-slate-900 font-semibold'
                  : 'hover:bg-slate-50 text-slate-600'
              }`}
            >
              <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: getCommunityColor(c.id) }} />
              <span className="truncate text-[10px]">
                {c.label} ({c.member_count})
                {c.id === maxComponent && <span className="text-amber-500"> ★</span>}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div>
      <p className="text-[9px] uppercase tracking-wide font-semibold text-slate-500">{label}</p>
      <p className="text-sm font-bold text-slate-800 tabular-nums leading-tight">{value}</p>
    </div>
  );
}

function ZoomBtn({ children, onClick, title }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="w-9 h-9 flex items-center justify-center rounded-xl bg-white/95 border border-slate-200 text-slate-800 text-lg font-bold hover:bg-slate-100 transition-colors shadow-md"
    >
      {children}
    </button>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  NETWORK SIDEBAR — offender dossier
// ═══════════════════════════════════════════════════════════════════════════

export function NetworkSidebar({ selectedNodeId, network, onClear, onNodeSelect, filters }) {
  const { t } = useTranslation();
  const [person, setPerson] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  // The dossier is fetched with the SAME filters as the graph, so cases,
  // connections and risk score always match what's on screen.
  const filterKey = filters ? `${filters.district}|${filters.crimeType}|${filters.from}|${filters.to}` : '';

  useEffect(() => {
    if (!selectedNodeId) {
      setPerson(null);
      setError(false);
      return;
    }
    setLoading(true);
    setError(false);
    const params = new URLSearchParams();
    if (filters?.district) params.set('district', filters.district);
    if (filters?.crimeType) params.set('crime_type', filters.crimeType);
    if (filters?.from) params.set('from', filters.from);
    if (filters?.to) params.set('to', filters.to);
    const qs = params.toString();
    fetch(`${API_URL}/api/network/individual/${selectedNodeId}${qs ? `?${qs}` : ''}`)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((data) => {
        if (data?.error) throw new Error(data.error);
        setPerson(data);
        setLoading(false);
      })
      .catch(() => { setError(true); setLoading(false); });
  }, [selectedNodeId, filterKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) {
    return (
      <div className="network-sidebar-state h-full flex flex-col items-center justify-center text-center p-6 gap-3">
        <div className="w-12 h-12 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-center justify-center">
          <svg className="w-6 h-6 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          </svg>
        </div>
        <p className="text-sm font-medium text-slate-300">{t('couldNotLoadDossier')}</p>
        <button onClick={onClear} className="text-xs text-sky-300 border border-sky-400/25 bg-sky-400/10 px-3 py-1.5 rounded hover:bg-sky-400/20">
          {t('backToNetwork')}
        </button>
      </div>
    );
  }

  if (!selectedNodeId && !person) {
    return (
      <div className="network-sidebar-state h-full flex flex-col items-center justify-center text-center p-6 text-slate-500">
        <div className="w-14 h-14 rounded-2xl bg-white/[0.03] border border-white/10 flex items-center justify-center mb-4">
          <svg className="w-7 h-7 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a4 4 0 0 0-3-3.87M9 20H4v-2a4 4 0 0 1 3-3.87m6-1.13a4 4 0 1 0-4-4 4 4 0 0 0 4 4zm6 0a4 4 0 1 0-3-6.65" />
          </svg>
        </div>
        <p className="text-sm font-medium text-slate-400">{t('individuals')}</p>
        <p className="text-xs mt-2 max-w-[220px]">{t('offenderDossier')}</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="h-full flex flex-col gap-4 animate-pulse">
        <div className="flex items-start gap-3">
          <div className="w-14 h-14 rounded-xl bg-white/5" />
          <div className="flex-1 space-y-2 pt-1">
            <div className="h-4 w-2/3 rounded bg-white/5" />
            <div className="h-3 w-1/3 rounded bg-white/5" />
            <div className="h-3 w-1/2 rounded bg-white/5" />
          </div>
        </div>
        <div className="h-20 rounded-xl bg-white/5" />
        <div className="grid grid-cols-3 gap-2">
          <div className="h-10 rounded-lg bg-white/5" />
          <div className="h-10 rounded-lg bg-white/5" />
          <div className="h-10 rounded-lg bg-white/5" />
        </div>
        <div className="h-8 rounded bg-white/5" />
        <div className="h-8 rounded bg-white/5" />
        <div className="h-8 rounded bg-white/5" />
      </div>
    );
  }

  if (!person) return null;

  const nodeInfo = network?.nodes?.find((n) => n.id === selectedNodeId) || {};
  const commInfo = network?.communities?.find((c) => c.id === nodeInfo.community_id);
  const score = person.rfs_score ?? 0;
  const scoreColor = score >= 75 ? 'text-red-400' : score >= 40 ? 'text-orange-400' : 'text-emerald-400';
  const scoreRing = score >= 75 ? '#f87171' : score >= 40 ? '#fb923c' : '#34d399';
  const lastActivity = person.last_activity ? new Date(person.last_activity).toLocaleDateString() : '—';
  const maxShared = Math.max(1, ...(person.connections || []).map((c) => c.shared_incidents || 0));

  return (
    <div className="network-dossier flex flex-col h-full view-transition">
      {/* Header: photo placeholder + identity */}
      <div className="flex items-start gap-3 mb-4">
        <div
          className="network-avatar w-14 h-14 rounded-xl flex items-center justify-center text-lg font-bold text-white flex-shrink-0 border border-white/15"
          style={{ background: `linear-gradient(135deg, ${getCommunityColor(nodeInfo.community_id)}cc, #0b1120)` }}
        >
          {initials(person.name)}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-bold text-white truncate">{person.name}</h3>
          {person.alias && (
            <p className="text-xs text-slate-400 truncate">Alias: “{person.alias}”</p>
          )}
          <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
            <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wide uppercase
              ${nodeInfo.tag === 'Central Figure' ? 'bg-red-500/20 text-red-300 border border-red-500/25'
              : nodeInfo.tag === 'Connector' ? 'bg-purple-500/20 text-purple-300 border border-purple-500/25'
              : 'bg-primary-500/20 text-primary-300 border border-primary-500/25'}`}>
              {nodeInfo.tag || 'Associate'}
            </span>
            {nodeInfo.is_leader && (
              <span className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase bg-amber-400/15 text-amber-300 border border-amber-400/30 flex items-center gap-1">
                ★ Leader
              </span>
            )}
            {nodeInfo.is_bridge && (
              <span className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase bg-cyan-400/15 text-cyan-200 border border-cyan-400/30 flex items-center gap-1">
                ⇄ Bridge
              </span>
            )}
            {commInfo && (
              <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-white/5 text-slate-300 border border-white/10 flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: getCommunityColor(commInfo.id) }} />
                {commInfo.label}
              </span>
            )}
          </div>
        </div>
        <button onClick={onClear} className="p-1.5 rounded-md text-slate-400 hover:text-white hover:bg-white/10 transition-colors flex-shrink-0">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto pr-1 space-y-3 custom-scrollbar">
        {/* Risk score + quick facts */}
        <div className="network-dossier-card glass-card p-3 rounded-xl bg-white/[0.02] flex items-center gap-3">
          <div
            className="relative w-16 h-16 rounded-full flex items-center justify-center flex-shrink-0"
            style={{ background: `conic-gradient(${scoreRing} ${score * 3.6}deg, rgba(148,163,184,0.15) 0deg)` }}
          >
            <div className="network-risk-core absolute inset-[3px] rounded-full bg-surface-900 flex flex-col items-center justify-center">
              <span className={`text-lg font-bold leading-none ${scoreColor}`}>{score}</span>
              <span className="text-[8px] text-slate-500 uppercase tracking-wider">RFS</span>
            </div>
          </div>
          <div className="flex-1 grid grid-cols-2 gap-2 text-center">
            <Fact label="Cases" value={person.incident_count} />
            <Fact label="Connections" value={person.connection_count} />
            <Fact label="Age" value={person.age ? `${person.age}` : '—'} />
            <Fact label="Gender" value={person.gender || '—'} />
          </div>
        </div>

        {/* Profile grid */}
        <div className="grid grid-cols-3 gap-2 text-center">
          <Fact label="Dominant" value={person.dominant_crime || '—'} accent />
          <Fact label="District" value={person.district || '—'} accent />
          <Fact label="Last seen" value={lastActivity} accent />
        </div>

        {/* Connections — with relationship-strength bars */}
        <div>
          <h4 className="text-[10px] font-semibold text-slate-300 mb-1.5 uppercase tracking-wider">
            Direct associations ({person.connection_count})
          </h4>
          <div className="space-y-1">
            {person.connections?.slice(0, 6).map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => onNodeSelect(c.id)}
                title="Open this associate's dossier"
                className="network-association-row w-full text-left p-2 rounded bg-white/[0.02] border border-white/5 transition-colors hover:bg-sky-400/10 hover:border-sky-400/25"
              >
                <div className="flex justify-between items-center text-xs">
                  <span className="text-slate-300 truncate pr-2">{c.name}</span>
                  <span className="text-sky-300 whitespace-nowrap bg-sky-400/10 px-1.5 py-0.5 rounded text-[10px]">
                    {c.shared_incidents} shared
                  </span>
                </div>
                {/* strength bar = shared incidents relative to strongest tie */}
                <div className="mt-1 h-1 rounded-full bg-white/5 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-sky-500 to-cyan-300"
                    style={{ width: `${Math.max(8, (c.shared_incidents / maxShared) * 100)}%` }}
                  />
                </div>
              </button>
            ))}
            {person.connections?.length > 6 && (
              <p className="text-center text-[10px] text-slate-500 pt-1">+{person.connections.length - 6} more associates</p>
            )}
            {person.connections?.length === 0 && (
              <p className="text-xs text-slate-500 italic">No co-accused in the current filter.</p>
            )}
          </div>
        </div>

        {/* Incident history */}
        <div>
          <h4 className="text-[10px] font-semibold text-slate-300 mb-2 uppercase tracking-wider">Incident history</h4>
          <div className="space-y-2 border-l-2 border-white/10 pl-3 ml-1">
            {person.incidents?.map((inc) => (
              <div key={inc.id} className="relative">
                <div className="absolute w-2 h-2 rounded-full bg-sky-400/60 -left-[17px] top-1.5 border border-surface-900" />
                <p className="text-xs font-medium text-slate-300">{inc.crime_type}</p>
                <div className="flex justify-between items-center mt-0.5">
                  <p className="text-[10px] text-slate-500">{inc.ward || inc.district}</p>
                  <p className="text-[10px] font-mono text-slate-600">{new Date(inc.timestamp).toLocaleDateString()}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Fact({ label, value, accent }) {
  return (
    <div className="network-fact bg-surface-800/70 rounded-lg py-1.5 px-1 border border-white/5">
      <p className="text-[8px] text-slate-500 uppercase tracking-wide">{label}</p>
      <p className={`text-xs font-semibold mt-0.5 truncate ${accent ? 'text-sky-200' : 'text-slate-200'}`}>{value}</p>
    </div>
  );
}
