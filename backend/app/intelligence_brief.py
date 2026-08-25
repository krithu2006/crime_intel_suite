"""Phase 5: deterministic orchestration of trusted intelligence signals.

This module deliberately contains presentation logic only. District and ward
drilldowns perform the expensive Phase 1-4 work; the brief selects and labels
those results without training another model or inventing a signal.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import func
from sqlalchemy.orm import Session

from .drilldown import get_district_drilldown, get_ward_drilldown
from .models import Incident, Ward
from .network_analysis import build_network
from .drilldown import _time_pattern

SEVERITY_RANK = {"LOW": 1, "MEDIUM": 2, "HIGH": 3, "CRITICAL": 4}


def _level(score: float) -> str:
    if score >= 85:
        return "CRITICAL"
    if score >= 65:
        return "HIGH"
    if score >= 35:
        return "MEDIUM"
    return "LOW"


def _safe_number(value: Any):
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, (int, float)):
        return value if value == value and abs(value) != float("inf") else None
    return value


def _latest_window(db: Session, district: str | None, ward_id: int | None, crime_type: str | None,
                   date_from: datetime | None, date_to: datetime | None) -> dict:
    q = db.query(func.min(Incident.timestamp), func.max(Incident.timestamp))
    if district:
        q = q.filter(Incident.district == district)
    if ward_id is not None:
        q = q.filter(Incident.ward_id == ward_id)
    if crime_type:
        q = q.filter(Incident.crime_type == crime_type)
    if date_from:
        q = q.filter(Incident.timestamp >= date_from)
    if date_to:
        q = q.filter(Incident.timestamp <= date_to)
    lo, hi = q.one()
    return {"from": lo.isoformat() if lo else None, "to": hi.isoformat() if hi else None}


def _top_trend(trends: dict | None) -> dict | None:
    if not trends or trends.get("status") == "no_data":
        return None
    candidates = []
    for item in trends.get("anomalies", []):
        if item.get("percentage_change") is not None:
            candidates.append({**item, "direction": "rising" if item.get("direction") == "spike" else "falling"})
    for item in trends.get("top_emerging_trends", []):
        if item.get("change_percent") is not None:
            candidates.append({
                **item, "percentage_change": item.get("change_percent"),
                "direction": item.get("direction") or ("rising" if item["change_percent"] > 0 else "falling"),
            })
    if not candidates:
        return None
    return max(candidates, key=lambda x: (SEVERITY_RANK.get(str(x.get("severity", "")).upper(), 0),
                                          abs(x.get("percentage_change") or 0)))


def _priority(risk: dict | None, alerts: dict, trend: dict | None, hotspots: int, offenders: int) -> dict:
    """Weighted evidence score; missing evidence is excluded and not treated as zero risk."""
    parts = []
    if risk and risk.get("risk_score") is not None and not risk.get("insufficient_data"):
        parts.append((float(risk["risk_score"]) / 100, 40))
    max_alert = max((SEVERITY_RANK.get(str(k).upper(), 0) for k, v in alerts.items() if str(k).upper() in SEVERITY_RANK and v), default=0)
    if max_alert:
        parts.append((max_alert / 4, 30))
    if trend:
        anomaly = SEVERITY_RANK.get(str(trend.get("severity", "")).upper(), 0) / 4
        if anomaly == 0 and trend.get("direction") == "rising":
            anomaly = 0.6
        if anomaly:
            parts.append((anomaly, 20))
    if hotspots or offenders:
        parts.append((1, 10))
    total_weight = sum(w for _, w in parts)
    score = round(sum(v * w for v, w in parts) / total_weight * 100) if total_weight else 0
    return {"level": _level(score), "score": score, "method": "available signals: risk 40%, alerts 30%, trend/anomaly 20%, hotspot/offender 10%"}


def _followups(has_trend: bool, has_risk: bool, alerts: int, hotspots: int, network: int, ward: bool, top_ward: dict | None = None) -> list[dict]:
    items = []
    if has_trend: items.append({"type": "trend", "label": "Inspect the recent crime trend", "action": "view_trend"})
    if has_risk: items.append({"type": "risk", "label": "Review the predictive risk outlook", "action": "view_risk"})
    if alerts: items.append({"type": "alerts", "label": "Review the active intelligence alerts", "action": "view_alerts"})
    if hotspots: items.append({"type": "hotspot", "label": "Inspect the active hotspot", "action": "view_hotspots"})
    if network: items.append({"type": "network", "label": "Examine repeat-offender connections", "action": "view_network"})
    if not ward and top_ward:
        items.append({"type": "ward", "label": f"Open {top_ward['ward_name']} intelligence", "action": "view_ward", "ward_id": top_ward["ward_id"]})
    return items[:5]


def _brief_from_data(db: Session, data: dict, scope_type: str, district: str, ward_id: int | None,
                     crime_type: str | None, date_from: datetime | None, date_to: datetime | None,
                     horizon_days: int) -> dict:
    ward = data.get("ward")
    scope_name = ward["name"] if ward else district
    rankings = data.get("ward_rankings", [])
    top_ward = rankings[0] if rankings else None
    risk = data.get("risk") if scope_type == "ward" else None
    if scope_type == "district" and top_ward and top_ward.get("risk_score") is not None:
        risk = {"risk_score": top_ward["risk_score"], "risk_level": top_ward.get("risk_level"),
                "prediction_horizon_days": horizon_days, "predicted_incidents": None, "confidence": None,
                "insufficient_data": False}
    alerts_summary = data.get("alerts_summary") or {"total": data.get("summary", {}).get("active_alerts", 0)}
    trend_source = data.get("trend") if scope_type == "ward" else data.get("trend_signals")
    trend = _top_trend(trend_source)
    hotspots = len(data.get("hotspots", [])) if scope_type == "ward" else data.get("summary", {}).get("active_hotspots", 0)
    offenders = len(data.get("repeat_offenders", [])) if scope_type == "ward" else data.get("summary", {}).get("repeat_offenders", 0)
    network = data.get("network_summary") or {}
    if scope_type == "district":
        network = build_network(db, district=district, crime_type=crime_type, date_from=date_from, date_to=date_to).get("summary", {})
    priority = _priority(risk, alerts_summary, trend, hotspots, offenders)
    crime_mix = data.get("crime_composition") or []
    dominant = crime_mix[0].get("crime_type") if crime_mix else None
    key_crime = trend.get("crime_type") or dominant if trend else dominant
    key_dev = None
    if trend:
        key_dev = {"crime_type": key_crime, "direction": trend.get("direction"),
                   "change_percent": _safe_number(trend.get("percentage_change")),
                   "severity": str(trend.get("severity") or "MEDIUM").upper()}
    summary = data.get("summary", {})
    why = []
    if key_dev and key_dev.get("change_percent") is not None:
        why.append(f"{key_crime or 'Crime'} activity is {abs(key_dev['change_percent']):.0f}% {'above' if key_dev['change_percent'] >= 0 else 'below'} its historical baseline.")
    if risk and risk.get("risk_score") is not None: why.append(f"Predictive crime risk is {risk.get('risk_level', 'elevated').upper()} for the next {horizon_days} days.")
    if hotspots: why.append(f"{hotspots} active hotspot{'s' if hotspots != 1 else ''} remain{'' if hotspots != 1 else 's'} in this scope.")
    if offenders: why.append(f"{offenders} repeat offender{'s' if offenders != 1 else ''} are active in this scope.")
    if alerts_summary.get("critical"): why.append(f"{alerts_summary['critical']} critical intelligence alert{'s' if alerts_summary['critical'] != 1 else ''} require review.")
    headline = (f"{key_crime} activity is rising with additional intelligence signals present." if key_dev and key_dev["direction"] == "rising"
                else "Elevated crime activity and intelligence signals require analyst attention." if priority["level"] in ("HIGH", "CRITICAL")
                else "Crime remains relatively stable with no critical intelligence signals.")
    time_pattern = data.get("time_pattern") or _time_pattern(
        db, district=district, ward_id=ward_id, crime_type=crime_type,
        date_from=date_from, date_to=date_to,
    )
    return {
        "status": "ok", "scope": {"type": scope_type, "district": district, "ward_id": ward_id,
                                    "ward_name": ward["name"] if ward else None, "name": scope_name},
        "priority": priority, "headline": headline, "key_development": key_dev,
        "predictive_risk": risk, "alerts": {**alerts_summary, "top": data.get("alerts", [])[:3]},
        "hotspots": {"count": hotspots, "items": data.get("hotspots", [])[:3]},
        "repeat_offenders": {"count": offenders},
        "network": {"linked_offenders": network.get("n_nodes", 0), "communities": network.get("n_communities", 0),
                     "high_connectivity": (network.get("tag_breakdown") or {}).get("Connector", 0) + (network.get("tag_breakdown") or {}).get("Central Figure", 0)},
        "crime_pattern": {"dominant_crime_type": dominant}, "time_pattern": time_pattern,
        "recent_incidents": summary.get("incidents", 0), "why_it_matters": why[:5],
        "analytical_followups": _followups(bool(trend), bool(risk and risk.get("risk_score") is not None), alerts_summary.get("total", 0), hotspots, network.get("n_nodes", 0), scope_type == "ward", top_ward),
        "highest_priority_ward": top_ward if scope_type == "district" else None,
        "analysis_window": _latest_window(db, district, ward_id, crime_type, date_from, date_to),
        "params": {"district": district, "ward_id": ward_id, "crime_type": crime_type, "prediction_horizon": horizon_days},
        "responsible_analytics": "Decision-support intelligence generated from historical analytical signals. Analyst validation required.",
    }


def generate_intelligence_brief(db: Session, district: str | None = None, ward_id: int | None = None,
                               crime_type: str | None = None, date_from: datetime | None = None,
                               date_to: datetime | None = None, horizon_days: int = 14,
                               granularity: str = "weekly") -> dict:
    if ward_id is not None:
        ward = db.query(Ward).filter(Ward.id == ward_id).first()
        if not ward: return {"status": "not_found", "message": f"Ward {ward_id} not found."}
        data = get_ward_drilldown(db, ward_id, crime_type, date_from, date_to, granularity, horizon_days)
        if data.get("status") != "ok": return data
        data["alerts_summary"] = {"total": len(data.get("alerts", [])), **{k: sum(1 for a in data.get("alerts", []) if a.get("severity") == k.upper()) for k in ("critical", "high", "medium", "low")}}
        return _brief_from_data(db, data, "ward", ward.district, ward_id, crime_type, date_from, date_to, horizon_days)
    if not district:
        return {"status": "selection_required", "message": "Select a district to generate an Intelligence Brief."}
    data = get_district_drilldown(db, district, crime_type, date_from, date_to, granularity, horizon_days)
    if data.get("status") != "ok": return data
    data["alerts_summary"] = data.get("alert_summary") or {"total": data.get("summary", {}).get("active_alerts", 0)}
    return _brief_from_data(db, data, "district", district, None, crime_type, date_from, date_to, horizon_days)
