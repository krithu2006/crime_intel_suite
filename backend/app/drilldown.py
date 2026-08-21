"""
Crime Intel Suite — Module 7: District & Ward Intelligence Drilldown

Pure orchestration. Every real number here comes from an existing module —
this file never reimplements prediction, trend/anomaly detection, alerting,
or network analysis:

    detect_hotspots()  (analytics.py)      -> hotspot count/attribution
    predict_risk()     (prediction.py)     -> ward risk (Phase 1)
    analyze_trends()   (trend_analysis.py) -> trend + anomalies (Phase 2)
    generate_alerts()  (alert_engine.py)   -> alerts (Phase 3, reusing the
                                               trends/risk_result computed
                                               here so nothing reruns twice)
    build_network()    (network_analysis.py) -> repeat offenders / network

The only new logic is cheap presentation-layer aggregation with no existing
home: crime composition (group-by-count), a district's per-ward repeat-
offender count, and a ward's day/hour activity pattern.

Each district drilldown makes exactly ONE call each to detect_hotspots,
predict_risk and analyze_trends — regardless of how many wards the district
has — so the ward-ranking table never retrains a model per row.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .models import Incident, Ward, incident_accused
from .analytics import detect_hotspots
from .prediction import predict_risk, DEFAULT_HORIZON
from .trend_analysis import analyze_trends, DEFAULT_GRANULARITY, SEVERITY_RANK
from .alert_engine import generate_alerts
from .network_analysis import build_network

# ═══════════════════════════════════════════════════════════════════════════
#  Tunables
# ═══════════════════════════════════════════════════════════════════════════

DRILLDOWN_GRANULARITY = DEFAULT_GRANULARITY  # "weekly"
DRILLDOWN_HORIZON_DAYS = DEFAULT_HORIZON     # 14
CRIME_COMPOSITION_TOP_N = 6
REPEAT_OFFENDER_LIST_LIMIT = 5
HOTSPOT_LIST_LIMIT = 5
RISK_ALERT_KPI_LEVELS = {"high", "critical"}  # matches the app's existing "high-risk" convention

_HOUR_BUCKETS = [(0, 4), (4, 8), (8, 12), (12, 16), (16, 20), (20, 24)]
_WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


# ═══════════════════════════════════════════════════════════════════════════
#  Small shared aggregations (no existing module owns these)
# ═══════════════════════════════════════════════════════════════════════════

def _crime_composition(db: Session, district=None, ward_id=None) -> list[dict]:
    q = db.query(Incident.crime_type, func.count(Incident.id)).group_by(Incident.crime_type)
    if district:
        q = q.filter(Incident.district == district)
    if ward_id is not None:
        q = q.filter(Incident.ward_id == ward_id)
    rows = q.all()
    total = sum(c for _, c in rows)
    if total == 0:
        return []
    rows.sort(key=lambda r: r[1], reverse=True)
    top = rows[:CRIME_COMPOSITION_TOP_N]
    composition = [
        {"crime_type": ct, "count": c, "percent": round(c / total * 100, 1)} for ct, c in top
    ]
    other = total - sum(c for _, c in top)
    if other > 0 and len(rows) > CRIME_COMPOSITION_TOP_N:
        composition.append({"crime_type": "Other", "count": other, "percent": round(other / total * 100, 1)})
    return composition


def _repeat_offenders_by_ward(db: Session, district: str | None) -> dict[int, int]:
    """One grouped query -> {ward_id: repeat-offender count}, each accused
    attributed to the ward they appear in most (so summing values gives a
    correct district-wide total with no double-counting)."""
    inc_q = db.query(Incident.id, Incident.ward_id)
    if district:
        inc_q = inc_q.filter(Incident.district == district)
    inc_ward_map = {iid: wid for iid, wid in inc_q.all()}
    if not inc_ward_map:
        return {}
    links = db.execute(
        select(incident_accused.c.incident_id, incident_accused.c.accused_id)
        .where(incident_accused.c.incident_id.in_(list(inc_ward_map.keys())))
    ).fetchall()
    accused_incident_count = defaultdict(int)
    accused_ward_votes = defaultdict(lambda: defaultdict(int))
    for iid, aid in links:
        accused_incident_count[aid] += 1
        wid = inc_ward_map.get(iid)
        if wid is not None:
            accused_ward_votes[aid][wid] += 1

    counts: dict[int, int] = defaultdict(int)
    for aid, n in accused_incident_count.items():
        if n > 1 and accused_ward_votes[aid]:
            primary_ward = max(accused_ward_votes[aid].items(), key=lambda kv: kv[1])[0]
            counts[primary_ward] += 1
    return dict(counts)


def _hotspots_by_ward(clusters: list[dict]) -> dict[int, list[dict]]:
    by_ward = defaultdict(list)
    for c in clusters:
        if c.get("ward_id") is not None:
            by_ward[c["ward_id"]].append(c)
    return by_ward


def _time_pattern(db: Session, district=None, ward_id=None) -> dict | None:
    q = db.query(Incident.timestamp)
    if district:
        q = q.filter(Incident.district == district)
    if ward_id is not None:
        q = q.filter(Incident.ward_id == ward_id)
    timestamps = [r[0] for r in q.all()]
    if len(timestamps) < 5:
        return None

    hour_counts = [0] * len(_HOUR_BUCKETS)
    day_counts = [0] * 7
    for ts in timestamps:
        for i, (lo, hi) in enumerate(_HOUR_BUCKETS):
            if lo <= ts.hour < hi:
                hour_counts[i] += 1
                break
        day_counts[ts.weekday()] += 1

    top_hour_idx = max(range(len(hour_counts)), key=lambda i: hour_counts[i])
    top_day_idx = max(range(7), key=lambda i: day_counts[i])
    lo, hi = _HOUR_BUCKETS[top_hour_idx]

    return {
        "most_active_hour_range": f"{lo:02d}:00–{hi:02d}:00",
        "most_active_day": _WEEKDAY_NAMES[top_day_idx],
        "hour_buckets": [
            {"range": f"{lo:02d}-{hi:02d}", "count": hour_counts[i]} for i, (lo, hi) in enumerate(_HOUR_BUCKETS)
        ],
        "day_breakdown": [
            {"day": _WEEKDAY_NAMES[i], "count": day_counts[i]} for i in range(7)
        ],
    }


def _district_trend_movers(trends: dict) -> dict:
    """
    Pull "top increase" / "largest decline" straight out of analyze_trends()'s
    own already-computed breakdown (anomalies + top_emerging_trends) — no new
    trend math, just picking the extremes among crime-type-only entries
    (ward is None) from what Module 5 already returned.
    """
    candidates = []
    for a in trends.get("anomalies", []):
        if a.get("ward") is None and a.get("crime_type") and a.get("percentage_change") is not None:
            candidates.append({"crime_type": a["crime_type"], "change_percent": a["percentage_change"]})
    for t in trends.get("top_emerging_trends", []):
        if t.get("ward") is None and t.get("crime_type") and t.get("change_percent") is not None:
            candidates.append({"crime_type": t["crime_type"], "change_percent": t["change_percent"]})

    top_increase = None
    largest_decline = None
    for c in candidates:
        if c["change_percent"] > 0 and (top_increase is None or c["change_percent"] > top_increase["change_percent"]):
            top_increase = c
        if c["change_percent"] < 0 and (largest_decline is None or c["change_percent"] < largest_decline["change_percent"]):
            largest_decline = c
    return {"top_increase": top_increase, "largest_decline": largest_decline}


def _ward_trend_lookup(trends: dict) -> dict[int, dict]:
    """
    {ward_id: {direction, change_percent}} built from analyze_trends()'s own
    ward-level breakdown entries (anomalies + sustained top_emerging_trends),
    preferring the entry with the largest magnitude when a ward has more than
    one. Wards with no flagged movement simply won't appear here.
    """
    best: dict[int, dict] = {}

    def consider(ward_id, direction, change_percent):
        if ward_id is None:
            return
        mag = abs(change_percent) if change_percent is not None else 0
        cur = best.get(ward_id)
        if cur is None or mag > cur["_mag"]:
            best[ward_id] = {"direction": direction, "change_percent": change_percent, "_mag": mag}

    # Anomaly records use "spike"/"drop"; sustained-trend records use
    # "rising"/"falling". Normalize to the latter so the ward table's Trend
    # column has one consistent vocabulary regardless of which Module 5
    # signal produced it.
    _DIRECTION_MAP = {"spike": "rising", "drop": "falling", "rising": "rising", "falling": "falling"}

    for a in trends.get("anomalies", []):
        if a.get("ward_id") is not None:
            consider(a["ward_id"], _DIRECTION_MAP.get(a["direction"], a["direction"]), a.get("percentage_change"))
    for t in trends.get("top_emerging_trends", []):
        if t.get("ward_id") is not None:
            direction = t.get("direction") or ("rising" if (t.get("change_percent") or 0) > 0 else "falling")
            consider(t["ward_id"], direction, t.get("change_percent"))

    for v in best.values():
        v.pop("_mag", None)
    return best


# ═══════════════════════════════════════════════════════════════════════════
#  District drilldown
# ═══════════════════════════════════════════════════════════════════════════

def get_district_drilldown(
    db: Session,
    district: str,
    crime_type: str | None = None,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    granularity: str = DRILLDOWN_GRANULARITY,
    horizon_days: int = DRILLDOWN_HORIZON_DAYS,
) -> dict:
    ward_rows = db.query(Ward).filter(Ward.district == district).all()
    if not ward_rows:
        return {"status": "not_found", "district": district, "message": f"No wards found for district '{district}'."}
    ward_map = {w.id: w for w in ward_rows}

    total_incidents = db.query(func.count(Incident.id)).filter(Incident.district == district)
    if crime_type:
        total_incidents = total_incidents.filter(Incident.crime_type == crime_type)
    total_incidents = total_incidents.scalar() or 0

    # Exactly one call each — every ward's numbers come out of these three.
    hotspots = detect_hotspots(db, date_from=date_from, date_to=date_to, district=district, crime_type=crime_type)
    trends = analyze_trends(db, district=district, crime_type=crime_type, date_from=date_from, date_to=date_to,
                             granularity=granularity)
    try:
        risk_result = predict_risk(db, district=district, crime_type=crime_type, horizon_days=horizon_days)
    except Exception:
        risk_result = None
    alerts_result = generate_alerts(db, district=district, crime_type=crime_type, date_from=date_from,
                                     date_to=date_to, granularity=granularity, horizon_days=horizon_days,
                                     trends=trends, risk_result=risk_result)

    clusters_by_ward = _hotspots_by_ward(hotspots.get("clusters", []))
    alerts_by_ward: dict[int, list[dict]] = defaultdict(list)
    for a in alerts_result["alerts"]:
        if a.get("ward_id") is not None:
            alerts_by_ward[a["ward_id"]].append(a)
    repeat_by_ward = _repeat_offenders_by_ward(db, district)
    risk_by_ward = {p["ward_id"]: p for p in (risk_result.get("predictions", []) if risk_result else [])}
    ward_trend = _ward_trend_lookup(trends)

    ward_rankings = []
    high_risk_ward_count = 0
    for wid, ward in ward_map.items():
        p = risk_by_ward.get(wid)
        ward_incidents = db.query(func.count(Incident.id)).filter(Incident.ward_id == wid)
        if crime_type:
            ward_incidents = ward_incidents.filter(Incident.crime_type == crime_type)
        ward_incidents = ward_incidents.scalar() or 0

        risk_score = p["risk_score"] if p and not p.get("insufficient_data") else None
        risk_level = p["risk_level"] if p and not p.get("insufficient_data") else None
        if risk_level in RISK_ALERT_KPI_LEVELS:
            high_risk_ward_count += 1

        ward_alerts = alerts_by_ward.get(wid, [])
        max_severity = max((a["severity"] for a in ward_alerts), key=lambda s: SEVERITY_RANK.get(s, 0), default=None)
        trend_info = ward_trend.get(wid)

        # Priority: risk score first (Phase 1), alert severity second, then
        # recent volume — deterministic, no new model (see §9 of the brief).
        priority = (
            risk_score or 0,
            SEVERITY_RANK.get(max_severity, 0) * 20,
            ward_incidents,
        )

        ward_rankings.append({
            "ward_id": wid,
            "ward_name": ward.name,
            "incidents": ward_incidents,
            "risk_score": risk_score,
            "risk_level": risk_level,
            "trend_direction": trend_info["direction"] if trend_info else (p["trend"] if p and not p.get("insufficient_data") else None),
            "trend_change_percent": trend_info["change_percent"] if trend_info else None,
            "active_alerts": len(ward_alerts),
            "max_alert_severity": max_severity,
            "hotspots": len(clusters_by_ward.get(wid, [])),
            "repeat_offenders": repeat_by_ward.get(wid, 0),
            "_priority": priority,
        })

    ward_rankings.sort(key=lambda w: w["_priority"], reverse=True)
    for w in ward_rankings:
        w.pop("_priority", None)

    return {
        "status": "ok",
        "district": district,
        "summary": {
            "incidents": total_incidents,
            "active_hotspots": hotspots.get("n_clusters", 0),
            "high_risk_wards": high_risk_ward_count,
            "active_alerts": alerts_result["summary"]["total"],
            "repeat_offenders": sum(repeat_by_ward.values()),
        },
        "crime_composition": _crime_composition(db, district=district),
        "trend_summary": (
            {
                "granularity": granularity,
                **(trends.get("summary") or {}),
                **_district_trend_movers(trends),
            } if trends["status"] != "no_data" else None
        ),
        "trend_signals": {
            "anomalies": trends.get("anomalies", []),
            "top_emerging_trends": trends.get("top_emerging_trends", []),
            "sustained_trend": trends.get("sustained_trend", {"detected": False}),
        },
        "alert_summary": alerts_result.get("summary", {}),
        "ward_rankings": ward_rankings,
        "model_performance": risk_result.get("model_performance") if risk_result else None,
        "params": {
            "district": district, "crime_type": crime_type, "granularity": granularity,
            "prediction_horizon_days": horizon_days,
        },
    }


# ═══════════════════════════════════════════════════════════════════════════
#  Ward drilldown
# ═══════════════════════════════════════════════════════════════════════════

def get_ward_drilldown(
    db: Session,
    ward_id: int,
    crime_type: str | None = None,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    granularity: str = DRILLDOWN_GRANULARITY,
    horizon_days: int = DRILLDOWN_HORIZON_DAYS,
) -> dict:
    ward = db.query(Ward).filter(Ward.id == ward_id).first()
    if ward is None:
        return {"status": "not_found", "ward_id": ward_id, "message": f"Ward {ward_id} not found."}
    district = ward.district

    total_incidents = db.query(func.count(Incident.id)).filter(Incident.ward_id == ward_id)
    if crime_type:
        total_incidents = total_incidents.filter(Incident.crime_type == crime_type)
    total_incidents = total_incidents.scalar() or 0

    trends = analyze_trends(db, district=district, ward_id=ward_id, crime_type=crime_type,
                             date_from=date_from, date_to=date_to, granularity=granularity)
    try:
        risk_result = predict_risk(db, district=district, ward_id=ward_id, crime_type=crime_type,
                                    horizon_days=horizon_days)
    except Exception:
        risk_result = None
    # Default status filter (omitted) already returns only active alerts.
    alerts_result = generate_alerts(db, district=district, ward_id=ward_id, crime_type=crime_type,
                                     date_from=date_from, date_to=date_to, granularity=granularity,
                                     horizon_days=horizon_days, trends=trends, risk_result=risk_result)
    hotspots = detect_hotspots(db, date_from=date_from, date_to=date_to, district=district, crime_type=crime_type)
    ward_clusters = [c for c in hotspots.get("clusters", []) if c.get("ward_id") == ward_id][:HOTSPOT_LIST_LIMIT]

    network = build_network(db, ward_id=ward_id, district=district, crime_type=crime_type,
                             date_from=date_from, date_to=date_to)
    repeat_offenders = [
        {
            "id": n["id"], "name": n["name"], "alias": n["alias"],
            "incident_count": n["incident_count"], "last_activity": n["last_activity"],
            "tag": n["tag"], "community_label": n["community_label"],
        }
        for n in network.get("nodes", [])
        if n["incident_count"] > 1
    ][:REPEAT_OFFENDER_LIST_LIMIT]

    active_alerts = alerts_result["alerts"]
    p = next((x for x in (risk_result.get("predictions", []) if risk_result else []) if x["ward_id"] == ward_id), None)

    why_it_matters = _why_this_ward_matters(trends, p, ward_clusters, len(repeat_offenders))

    return {
        "status": "ok",
        "district": district,
        "ward": {"id": ward.id, "name": ward.name, "lat": ward.lat, "lng": ward.lng},
        "summary": {
            "incidents": total_incidents,
            "risk_score": p["risk_score"] if p and not p.get("insufficient_data") else None,
            "risk_level": p["risk_level"] if p and not p.get("insufficient_data") else None,
            "active_alerts": len(active_alerts),
            "hotspots": len(ward_clusters),
            "repeat_offenders": len(repeat_offenders),
        },
        "why_it_matters": why_it_matters,
        "crime_composition": _crime_composition(db, ward_id=ward_id),
        "trend": trends if trends["status"] != "no_data" else None,
        "risk": p,
        "alerts": active_alerts[:5],
        "alert_summary": {
            "total": len(active_alerts),
            **{level.lower(): sum(1 for a in active_alerts if a.get("severity") == level)
               for level in ("CRITICAL", "HIGH", "MEDIUM", "LOW")},
        },
        "hotspots": [
            {
                "cluster_id": c["cluster_id"], "dominant_crime_type": c["dominant_crime_type"],
                "incident_count": c["incident_count"], "severity_level": c["severity_level"],
                "risk_score": c["risk_score"], "avg_severity": c["avg_severity"],
                "centroid": c["centroid"],
            }
            for c in ward_clusters
        ],
        "repeat_offenders": repeat_offenders,
        "network_summary": network.get("summary") if network.get("summary", {}).get("n_nodes") else None,
        "time_pattern": _time_pattern(db, ward_id=ward_id),
        "model_performance": risk_result.get("model_performance") if risk_result else None,
        "params": {
            "ward_id": ward_id, "district": district, "crime_type": crime_type,
            "granularity": granularity, "prediction_horizon_days": horizon_days,
        },
    }


def _why_this_ward_matters(trends: dict, risk: dict | None, hotspot_clusters: list, repeat_offender_count: int) -> list[str]:
    """Short, purely-computed bullets — every line traces to a real field above. No LLM."""
    bullets = []

    if trends["status"] == "ok":
        scored = [a for a in trends["anomalies"] if a.get("percentage_change") is not None]
        if scored:
            top = max(scored, key=lambda a: a["anomaly_score"] or 0)
            label = top["crime_type"] or "Crime"
            verb = "above" if top["direction"] == "spike" else "below"
            bullets.append(f"{label} is {abs(top['percentage_change']):.0f}% {verb} its historical baseline.")
        if trends["sustained_trend"].get("detected"):
            st = trends["sustained_trend"]
            verb = "increased" if st["direction"] == "rising" else "decreased"
            bullets.append(f"Crime has {verb} for {st['periods']} consecutive periods.")

    if risk and not risk.get("insufficient_data") and risk["risk_level"] in ("high", "critical"):
        bullets.append(
            f"Predictive risk is {risk['risk_level'].upper()} for the next {risk['prediction_horizon_days']} days."
        )

    if hotspot_clusters:
        noun = "hotspot" if len(hotspot_clusters) == 1 else "hotspots"
        bullets.append(f"{len(hotspot_clusters)} active crime {noun} {'is' if len(hotspot_clusters) == 1 else 'are'} present.")

    if repeat_offender_count > 0:
        noun = "offender was" if repeat_offender_count == 1 else "offenders were"
        bullets.append(f"{repeat_offender_count} repeat {noun} recently active.")

    return bullets
