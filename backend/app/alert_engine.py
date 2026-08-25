"""
Crime Intel Suite — Module 6: Intelligence Alert Center

Converts the REAL outputs of Module 5 (trend_analysis.py) — and, where it's
cheap to do so, Module 3b (prediction.py) — into ranked, stateful "alert"
records with a police-workflow status lifecycle (NEW/REVIEWED/
INVESTIGATING/CLOSED).

This module does NOT reimplement anomaly detection, trend classification,
or predictive risk. It only:
  1. Calls analyze_trends() and predict_risk() ONCE each per request.
  2. Normalizes their existing records into a common alert shape.
  3. Assigns each alert a deterministic ID (so status survives a refresh —
     see _alert_id) and merges in persisted workflow status from the
     alert_status table.
  4. Ranks alerts by a documented, deterministic priority (no ML/LLM).
  5. Optionally enriches the highest-priority alerts with a cheap
     repeat-offender count (bounded to a handful of extra queries, never a
     full network-graph rebuild).

No alert is ever fabricated: if analyze_trends()/predict_risk() found
nothing notable for the given scope, generate_alerts() returns an empty list.
"""

from __future__ import annotations

import re
from datetime import datetime
from sqlalchemy import select, func
from sqlalchemy.orm import Session

from .models import AlertStatus, Incident, Ward, incident_accused
from .trend_analysis import analyze_trends, SEVERITY_RANK, SUSTAINED_ROLLING_WINDOW, GRANULARITIES, DEFAULT_GRANULARITY
from .prediction import predict_risk, DEFAULT_HORIZON

# ═══════════════════════════════════════════════════════════════════════════
#  Tunables
# ═══════════════════════════════════════════════════════════════════════════

VALID_STATUSES = ("NEW", "REVIEWED", "INVESTIGATING", "CLOSED")
DEFAULT_STATUS = "NEW"
# Status values a plain "active alerts" view should show by default —
# CLOSED alerts stay queryable but don't clutter the default list.
ACTIVE_STATUSES = ("NEW", "REVIEWED", "INVESTIGATING")

# A predictive-risk alert is only worth raising for genuinely elevated risk —
# not every ward, every time. prediction.py's risk_level is a PERCENTILE rank
# against the training distribution, so "high" alone already covers roughly
# the top 40% of wards in practice — too noisy for a dedicated alert. Restrict
# the dedicated "High Future Crime Risk" alert to "critical" (its own
# documented top band); "high" still flows into enrichment of anomaly/
# sustained alerts for the same ward (see the enrichment step below), just
# not as a standalone alert.
RISK_ALERT_LEVELS = {"critical"}
RISK_ENRICHMENT_LEVELS = {"critical", "high"}

# Enrichment is bounded so /api/alerts stays cheap even with many anomalies.
OFFENDER_ENRICHMENT_TOP_N = 10
MIN_REPEAT_OFFENDERS_TO_SHOW = 1

VALID_SEVERITIES = ("CRITICAL", "HIGH", "MEDIUM", "LOW")


# ═══════════════════════════════════════════════════════════════════════════
#  Deterministic alert IDs
# ═══════════════════════════════════════════════════════════════════════════

def _slug(value: str | None) -> str:
    if not value:
        return "all"
    return re.sub(r"[^a-z0-9]+", "_", value.lower()).strip("_") or "all"


def _alert_id(alert_type: str, district, ward_id, crime_type, period_key) -> str:
    """
    Deterministic — the SAME underlying alert (type + district + ward +
    crime_type + period) always produces the SAME id, so a status update
    persists across refresh without needing random UUIDs.
    """
    ward_part = f"ward{ward_id}" if ward_id is not None else "all"
    return ":".join([alert_type, _slug(district), ward_part, _slug(crime_type), period_key or "na"])


# ═══════════════════════════════════════════════════════════════════════════
#  Alert record builders — pure formatting over already-computed analytics
# ═══════════════════════════════════════════════════════════════════════════

def _base_alert(alert_type, title, description, severity, district, ward, ward_id, crime_type, period, evidence,
                 actions):
    return {
        "id": None,  # filled in by caller
        "type": alert_type,
        "title": title,
        "description": description,
        "severity": severity,
        "status": DEFAULT_STATUS,  # overwritten with persisted status later
        "district": district,
        "ward": ward,
        "ward_id": ward_id,
        "crime_type": crime_type,
        "period": period,
        "detected_at": datetime.utcnow().isoformat(),
        "observed_value": None,
        "expected_lower": None,
        "expected_upper": None,
        "change_percent": None,
        "anomaly_score": None,
        "direction": None,
        "risk_score": None,
        "prediction_horizon_days": None,
        "evidence": evidence,
        "available_actions": actions,
    }


def _anomaly_alert(a: dict) -> dict:
    direction_word = "Spike" if a["direction"] == "spike" else "Drop"
    crime_label = a["crime_type"] or "Crime"
    where = a["ward"] or a["district"] or "the selected area"
    pct = a["percentage_change"]
    pct_txt = f"{pct:+.0f}%" if pct is not None else "an unusual amount"

    alert = _base_alert(
        alert_type="anomaly_spike",
        title=f"{crime_label} {direction_word}",
        description=(
            f"{crime_label} in {where} is {pct_txt} versus its historical baseline "
            f"({'unusual increase' if a['direction'] == 'spike' else 'unusual drop'} detected)."
        ),
        severity=a["severity"],
        district=a["district"], ward=a["ward"], ward_id=a["ward_id"], crime_type=a["crime_type"],
        period=a["period"],
        evidence=[
            {"label": "Observed incidents", "value": a["observed_value"]},
            {"label": "Historical baseline", "value": f"{a['expected_range']['lower']:.0f}–{a['expected_range']['upper']:.0f}"},
            {"label": "Deviation", "value": pct_txt},
            {"label": "Anomaly score", "value": a["anomaly_score"]},
            {"label": "Severity", "value": a["severity"]},
        ],
        actions=["view_trend", "view_hotspot"],
    )
    alert["id"] = _alert_id("anomaly_spike", a["district"], a["ward_id"], a["crime_type"], a["period"])
    alert["observed_value"] = a["observed_value"]
    alert["expected_lower"] = a["expected_range"]["lower"]
    alert["expected_upper"] = a["expected_range"]["upper"]
    alert["change_percent"] = pct
    alert["anomaly_score"] = a["anomaly_score"]
    alert["direction"] = a["direction"]
    return alert


def _sustained_alert_from_main(trends: dict, district, ward_id, ward_name, crime_type, granularity) -> dict | None:
    st = trends["sustained_trend"]
    if not st.get("detected"):
        return None

    period = trends["summary"]["current_period"]
    crime_label = crime_type or "Crime"
    where = ward_name or district or "the selected area"
    verb = "Increase" if st["direction"] == "rising" else "Decline"
    pct = st.get("change_percent")
    pct_txt = f"{pct:+.0f}%" if pct is not None else None

    # Recompute the two rolling averages the "rolling_average" method compared
    # (presentation only — analyze_trends() already made the sustained-trend
    # decision; this just re-derives the two numbers for the evidence panel).
    evidence = [{"label": "Consecutive periods", "value": st["periods"]}]
    counts = [p["count"] for p in trends["series"]]
    W = SUSTAINED_ROLLING_WINDOW
    if len(counts) >= 2 * W:
        recent_avg = sum(counts[-W:]) / W
        prior_avg = sum(counts[-2 * W:-W]) / W
        evidence.append({"label": "Previous average", "value": round(prior_avg, 1)})
        evidence.append({"label": "Recent average", "value": round(recent_avg, 1)})
    if pct_txt:
        evidence.append({"label": "Change", "value": pct_txt})
    evidence.append({"label": "Direction", "value": st["direction"].upper()})

    severity = "HIGH" if st["direction"] == "rising" else "MEDIUM"

    alert = _base_alert(
        alert_type="sustained_trend",
        title=f"Sustained {crime_label} {verb}",
        description=(
            f"{crime_label} in {where} has {'increased' if st['direction'] == 'rising' else 'decreased'} "
            f"for {st['periods']} consecutive {_noun(granularity)}."
        ),
        severity=severity,
        district=district, ward=ward_name, ward_id=ward_id, crime_type=crime_type,
        period=period,
        evidence=evidence,
        actions=["view_trend", "view_hotspot"],
    )
    alert["id"] = _alert_id("sustained_trend", district, ward_id, crime_type, period)
    alert["change_percent"] = pct
    alert["direction"] = st["direction"]
    return alert


def _sustained_alert_from_breakdown(t: dict, district, granularity) -> dict:
    crime_label = t["crime_type"] or "Crime"
    where = t["ward"] or district or "the selected area"
    verb = "Increase" if t["direction"] == "rising" else "Decline"
    pct = t.get("change_percent")
    pct_txt = f"{pct:+.0f}%" if pct is not None else None
    severity = "HIGH" if t["direction"] == "rising" else "MEDIUM"

    evidence = [{"label": "Consecutive periods", "value": t["periods"]}]
    if pct_txt:
        evidence.append({"label": "Change", "value": pct_txt})
    evidence.append({"label": "Direction", "value": t["direction"].upper()})

    period = t.get("detected_period")
    alert = _base_alert(
        alert_type="sustained_trend",
        title=f"Sustained {crime_label} {verb}",
        description=(
            f"{crime_label} in {where} has {'increased' if t['direction'] == 'rising' else 'decreased'} "
            f"for {t['periods']} consecutive {_noun(granularity)}."
        ),
        severity=severity,
        district=district, ward=t["ward"], ward_id=t.get("ward_id"), crime_type=t["crime_type"],
        period=period,
        evidence=evidence,
        actions=["view_trend", "view_hotspot"],
    )
    alert["id"] = _alert_id("sustained_trend", district, t.get("ward_id"), t["crime_type"], period)
    alert["change_percent"] = pct
    alert["direction"] = t["direction"]
    return alert


def _risk_alert(p: dict, horizon_days: int) -> dict:
    alert = _base_alert(
        alert_type="predictive_risk",
        title="High Future Crime Risk",
        description=(
            f"Historical patterns suggest an elevated risk signal for {p['ward_name']} over the next "
            f"{horizon_days} days. This is a forecast, not an observed anomaly."
        ),
        severity=p["risk_level"].upper(),
        district=p["district"], ward=p["ward_name"], ward_id=p["ward_id"], crime_type=None,
        period=None,
        evidence=[
            {"label": "Predicted risk score", "value": f"{p['risk_score']}/100"},
            {"label": "Risk level", "value": p["risk_level"].upper()},
            {"label": "Predicted incidents", "value": p["predicted_incidents"]},
            {"label": "Confidence", "value": f"{round(p['confidence'] * 100)}%"},
            {"label": "Prediction horizon", "value": f"Next {horizon_days} days"},
        ],
        actions=["view_risk", "view_trend"],
    )
    alert["id"] = _alert_id("predictive_risk", p["district"], p["ward_id"], None, f"h{horizon_days}")
    alert["risk_score"] = p["risk_score"]
    alert["prediction_horizon_days"] = horizon_days
    return alert


def _noun(granularity: str) -> str:
    return {"daily": "days", "weekly": "weeks", "monthly": "months"}.get(granularity, "periods")


# ═══════════════════════════════════════════════════════════════════════════
#  Cheap enrichment (bounded — never a full network-graph rebuild)
# ═══════════════════════════════════════════════════════════════════════════

def _repeat_offender_count(db: Session, ward_id: int | None, crime_type: str | None) -> int | None:
    if ward_id is None:
        return None
    q = db.query(Incident.id).filter(Incident.ward_id == ward_id)
    if crime_type:
        q = q.filter(Incident.crime_type == crime_type)
    inc_ids = [r[0] for r in q.all()]
    if not inc_ids:
        return 0
    stmt = (
        select(incident_accused.c.accused_id)
        .where(incident_accused.c.incident_id.in_(inc_ids))
        .group_by(incident_accused.c.accused_id)
        .having(func.count(incident_accused.c.incident_id) > 1)
    )
    return len(db.execute(stmt).fetchall())


# ═══════════════════════════════════════════════════════════════════════════
#  Priority ranking — simple, deterministic, documented
# ═══════════════════════════════════════════════════════════════════════════

def _priority_key(alert: dict):
    """
    Higher tuple = higher priority. Considered, in order:
      1. severity (CRITICAL > HIGH > MEDIUM > LOW)
      2. anomaly magnitude (|anomaly_score|, 0 for non-anomaly alerts)
      3. recency (the alert's period, ISO strings sort correctly)
      4. sustained trend gets a small boost over a one-off spike at equal severity
      5. predictive risk score, as a final tiebreaker
    """
    return (
        SEVERITY_RANK.get(alert["severity"], 0),
        abs(alert["anomaly_score"]) if alert["anomaly_score"] is not None else 0.0,
        alert["period"] or alert["detected_at"] or "",
        1 if alert["type"] == "sustained_trend" else 0,
        alert["risk_score"] or 0,
    )


# ═══════════════════════════════════════════════════════════════════════════
#  Status persistence
# ═══════════════════════════════════════════════════════════════════════════

def _load_statuses(db: Session, alert_ids: list[str]) -> dict[str, AlertStatus]:
    if not alert_ids:
        return {}
    rows = db.query(AlertStatus).filter(AlertStatus.alert_id.in_(alert_ids)).all()
    return {r.alert_id: r for r in rows}


def get_alert_status(db: Session, alert_id: str) -> dict:
    row = db.query(AlertStatus).filter(AlertStatus.alert_id == alert_id).first()
    if row:
        return row.to_dict()
    return {"alert_id": alert_id, "status": DEFAULT_STATUS, "note": None, "created_at": None, "updated_at": None}


def set_alert_status(db: Session, alert_id: str, status: str, note: str | None = None) -> dict:
    if status not in VALID_STATUSES:
        raise ValueError(f"Invalid status '{status}'. Must be one of {VALID_STATUSES}.")
    now = datetime.utcnow()
    row = db.query(AlertStatus).filter(AlertStatus.alert_id == alert_id).first()
    if row is None:
        row = AlertStatus(alert_id=alert_id, status=status, note=note, created_at=now, updated_at=now)
        db.add(row)
    else:
        row.status = status
        if note is not None:
            row.note = note
        row.updated_at = now
    db.commit()
    db.refresh(row)
    return row.to_dict()


def mark_alert_read(db: Session, alert_id: str) -> dict:
    """Persist notification read state without changing investigation status."""
    now = datetime.utcnow()
    row = db.query(AlertStatus).filter(AlertStatus.alert_id == alert_id).first()
    if row is None:
        row = AlertStatus(
            alert_id=alert_id, status=DEFAULT_STATUS, read_at=now,
            created_at=now, updated_at=now,
        )
        db.add(row)
    elif row.read_at is None:
        row.read_at = now
        row.updated_at = now
    db.commit()
    db.refresh(row)
    return {"success": True, **row.to_dict()}


def mark_alerts_read(db: Session, alert_ids: list[str]) -> int:
    """Mark the supplied generated alerts read while preserving workflow state."""
    if not alert_ids:
        return 0
    now = datetime.utcnow()
    existing = _load_statuses(db, alert_ids)
    changed = 0
    for alert_id in alert_ids:
        row = existing.get(alert_id)
        if row is None:
            db.add(AlertStatus(
                alert_id=alert_id, status=DEFAULT_STATUS, read_at=now,
                created_at=now, updated_at=now,
            ))
            changed += 1
        elif row.read_at is None:
            row.read_at = now
            row.updated_at = now
            changed += 1
    db.commit()
    return changed


# ═══════════════════════════════════════════════════════════════════════════
#  Public entry point
# ═══════════════════════════════════════════════════════════════════════════

def generate_alerts(
    db: Session,
    district: str | None = None,
    ward_id: int | None = None,
    crime_type: str | None = None,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    granularity: str = DEFAULT_GRANULARITY,
    severity: str | None = None,
    status: str | None = None,
    horizon_days: int = DEFAULT_HORIZON,
    trends: dict | None = None,
    risk_result: dict | None = None,
) -> dict:
    """
    `trends`/`risk_result` let a caller that already ran analyze_trends()/
    predict_risk() for this exact scope (e.g. the district/ward drilldown —
    see drilldown.py) pass them in directly, so the model is never retrained
    and the trend pipeline never reruns just to also list alerts. Only
    /api/alerts itself (which has nothing precomputed) leaves these None.
    """
    granularity = granularity if granularity in GRANULARITIES else DEFAULT_GRANULARITY

    if trends is None:
        trends = analyze_trends(
            db, district=district, ward_id=ward_id, crime_type=crime_type,
            date_from=date_from, date_to=date_to, granularity=granularity,
        )

    alerts: list[dict] = []

    if trends["status"] in ("ok", "insufficient_data"):
        # A. Anomaly spike/drop alerts — one per flagged period, straight from Module 5.
        for a in trends["anomalies"]:
            alerts.append(_anomaly_alert(a))

        # B. Sustained-trend alerts — the exact requested scope, plus any
        # ward/crime_type breakdown sustained trends Module 5 already found.
        ward_name = None
        if ward_id is not None:
            ward_name = db.query(Ward.name).filter(Ward.id == ward_id).scalar()
        main_sustained = _sustained_alert_from_main(trends, district, ward_id, ward_name, crime_type, granularity)
        if main_sustained:
            alerts.append(main_sustained)
        for t in trends["top_emerging_trends"]:
            if t["kind"] == "sustained":
                alerts.append(_sustained_alert_from_breakdown(t, district, granularity))

    # C. Predictive-risk alerts (Phase 1) — one predict_risk() call, reused
    # both to raise dedicated alerts AND to enrich anomaly/sustained alerts
    # for the same ward, so the model is never retrained more than once here.
    risk_by_ward: dict[int, dict] = {}
    if risk_result is None and trends["status"] != "no_data":
        try:
            risk_result = predict_risk(db, district=district, ward_id=ward_id, crime_type=crime_type,
                                        horizon_days=horizon_days)
        except Exception:
            # Predictive risk is an enhancement, not the core evidence source
            # (that's Module 5) — never let it break the Alert Center.
            risk_result = None
    if risk_result:
        for p in risk_result.get("predictions", []):
            if p.get("insufficient_data"):
                continue
            risk_by_ward[p["ward_id"]] = p
            if p["risk_level"] in RISK_ALERT_LEVELS:
                alerts.append(_risk_alert(p, horizon_days))

    # The main sustained signal can also appear in Module 5's ranked
    # breakdown. Both normalize to the same deterministic alert ID, so retain
    # one canonical record before summaries, notifications, and rendering.
    alerts = list({alert["id"]: alert for alert in alerts}.values())

    # Enrich anomaly/sustained alerts with a matching ward's predictive risk
    # (cheap — reuses risk_by_ward computed above, no extra model calls).
    for alert in alerts:
        if alert["type"] == "predictive_risk" or alert["ward_id"] is None:
            continue
        p = risk_by_ward.get(alert["ward_id"])
        if p and p["risk_level"] in RISK_ENRICHMENT_LEVELS:
            alert["risk_score"] = p["risk_score"]
            alert["evidence"].append({
                "label": "Predictive risk", "value": f"{p['risk_score']}/100 {p['risk_level'].upper()}",
            })
            if "view_risk" not in alert["available_actions"]:
                alert["available_actions"].append("view_risk")

    # Rank BEFORE enrichment-bound truncation, so the top-N enrichment budget
    # is spent on the alerts that will actually be seen first.
    alerts.sort(key=_priority_key, reverse=True)

    for alert in alerts[:OFFENDER_ENRICHMENT_TOP_N]:
        if alert["type"] == "predictive_risk":
            continue
        count = _repeat_offender_count(db, alert["ward_id"], alert["crime_type"])
        if count is not None and count >= MIN_REPEAT_OFFENDERS_TO_SHOW:
            alert["evidence"].append({"label": "Repeat offenders active", "value": count})
            if "view_network" not in alert["available_actions"]:
                alert["available_actions"].append("view_network")

    # Merge persisted workflow and independent notification-read state.
    statuses = _load_statuses(db, [a["id"] for a in alerts])
    for alert in alerts:
        row = statuses.get(alert["id"])
        alert["status"] = row.status if row else DEFAULT_STATUS
        alert["note"] = row.note if row else None
        alert["is_read"] = row.read_at is not None if row else False
        alert["read_at"] = row.read_at.isoformat() if row and row.read_at else None

    summary = _summarize(alerts)

    # Apply filters to the returned list (summary reflects the whole scope).
    filtered = alerts
    if severity and severity.upper() != "ALL":
        filtered = [a for a in filtered if a["severity"] == severity.upper()]
    if status and status.upper() != "ALL":
        filtered = [a for a in filtered if a["status"] == status.upper()]
    elif not status:
        filtered = [a for a in filtered if a["status"] in ACTIVE_STATUSES]

    return {
        "status": "ok" if trends["status"] != "no_data" else "no_data",
        "params": {
            "district": district, "ward_id": ward_id, "crime_type": crime_type,
            "granularity": granularity, "severity": severity, "status": status,
        },
        "summary": summary,
        "alerts": filtered,
    }


def _summarize(alerts: list[dict]) -> dict:
    def count(pred):
        return sum(1 for a in alerts if pred(a))

    return {
        "total": len(alerts),
        "critical": count(lambda a: a["severity"] == "CRITICAL"),
        "high": count(lambda a: a["severity"] == "HIGH"),
        "medium": count(lambda a: a["severity"] == "MEDIUM"),
        "low": count(lambda a: a["severity"] == "LOW"),
        "new": count(lambda a: a["status"] == "NEW"),
        "reviewed": count(lambda a: a["status"] == "REVIEWED"),
        "investigating": count(lambda a: a["status"] == "INVESTIGATING"),
        "closed": count(lambda a: a["status"] == "CLOSED"),
    }
