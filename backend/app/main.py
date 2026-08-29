"""
Crime Intel Suite — FastAPI Application (Modules 1–4).

Endpoints:
  GET /api/health                      → health check + summary stats
  GET /api/incidents                   → paginated incidents list
  GET /api/districts                   → district socio-economic data
  GET /api/wards                       → ward centroids and metadata
  GET /api/hotspots                    → DBSCAN crime hotspots for a date range
  GET /api/escalation                  → minor-crime escalation scores per ward
  GET /api/risk-scores                 → all wards ranked by risk score (descriptive, current window)
  GET /api/risk-score                  → single ward risk score with explanation
  GET /api/predictions/risk            → future-window crime prediction (temporal ML pipeline)
  GET /api/trends                      → trend direction + anomaly detection (historical baseline)
  GET /api/alerts                      → ranked intelligence alerts (from Modules 5 + 3b)
  PATCH /api/alerts/{alert_id}         → update an alert's workflow status
  GET /api/drilldown/district/{name}   → district intelligence overview (orchestrates Modules 1-3)
  GET /api/drilldown/ward/{id}         → ward intelligence overview (orchestrates Modules 1-4)
  GET /api/network                     → offender co-occurrence graph
  GET /api/network/individual/{id}     → single accused details + connections
  POST /api/ai-chat                    → AI assistant for dashboard and general Q&A
"""

import json
import os
import requests
from pathlib import Path
from datetime import datetime, time
from fastapi import FastAPI, Depends, Query, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ValidationError
from sqlalchemy.orm import Session
from sqlalchemy import func, select

from .database import engine, get_db, Base, migrate_alert_read_state
from .models import Incident, Accused, DistrictSocioEconomic, Ward, incident_accused
from .analytics import (
    DEFAULT_EPS,
    DEFAULT_MIN_SAMPLES,
    detect_hotspots,
    compute_escalation,
)
from .risk_scoring import compute_risk_scores
from .prediction import predict_risk, VALID_HORIZONS, DEFAULT_HORIZON
from .trend_analysis import analyze_trends, GRANULARITIES, DEFAULT_GRANULARITY
from .alert_engine import (
    generate_alerts, set_alert_status, mark_alert_read, mark_alerts_read,
    VALID_STATUSES,
)
from .drilldown import get_district_drilldown, get_ward_drilldown, DRILLDOWN_GRANULARITY, DRILLDOWN_HORIZON_DAYS
from .network_analysis import build_network, get_individual
from .intelligence_brief import generate_intelligence_brief
from .copilot import answer_copilot


class AiChatRequest(BaseModel):
    question: str
    dashboard_context: dict | None = None


class CopilotRequest(BaseModel):
    message: str
    language: str | None = None
    context: dict | None = None
    history: list[dict] | None = None


class AlertStatusUpdate(BaseModel):
    status: str
    note: str | None = None


def _load_local_env() -> None:
    """Load backend/.env during local development without requiring a package."""
    env_path = Path(__file__).resolve().parents[1] / ".env"
    if not env_path.exists():
        return

    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


_load_local_env()


# Create tables if they don't exist (idempotent)
Base.metadata.create_all(bind=engine)
migrate_alert_read_state()

app = FastAPI(
    title="Crime Intel Suite API",
    description="Backend API for the Karnataka State Police Crime Intelligence platform.",
    version="0.4.0",
)

_cors_raw = os.getenv("CORS_ORIGINS", "*")
_cors_origins = [origin.strip() for origin in _cors_raw.split(",") if origin.strip()]
_cors_wildcard = _cors_origins == ["*"]

# Local development defaults to wildcard; deployments can set a comma-separated
# allow-list, e.g. CORS_ORIGINS=https://dashboard.example.com.
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=not _cors_wildcard,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ═══════════════════════════════════════════════════════════════════════════════
#  MODULE 1 ENDPOINTS
# ═══════════════════════════════════════════════════════════════════════════════

@app.get("/api/health")
def health_check(db: Session = Depends(get_db)):
    """Health check endpoint — returns counts and date range."""
    incident_count = db.query(func.count(Incident.id)).scalar()
    accused_count = db.query(func.count(Accused.id)).scalar()
    ward_count = db.query(func.count(Ward.id)).scalar()
    district_count = db.query(func.count(DistrictSocioEconomic.id)).scalar()

    min_date = db.query(func.min(Incident.timestamp)).scalar()
    max_date = db.query(func.max(Incident.timestamp)).scalar()

    return {
        "status": "ok",
        "incidents": incident_count,
        "accused": accused_count,
        "wards": ward_count,
        "districts": district_count,
        "date_range": {
            "from": min_date.isoformat() if min_date else None,
            "to": max_date.isoformat() if max_date else None,
        },
    }


@app.get("/api/incidents")
def list_incidents(
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    crime_type: str = Query(None),
    district: str = Query(None),
    ward_id: int = Query(None),
    min_severity: int = Query(None, ge=1, le=10),
    max_severity: int = Query(None, ge=1, le=10),
    date_from: str = Query(None, alias="from", description="Start date ISO format"),
    date_to: str = Query(None, alias="to", description="End date ISO format"),
    db: Session = Depends(get_db),
):
    """Paginated, most-recent-first list of incidents with optional filters (Module 7's recent-incidents card)."""
    q = db.query(Incident)

    if crime_type:
        q = q.filter(Incident.crime_type == crime_type)
    if district:
        q = q.filter(Incident.district == district)
    if ward_id is not None:
        q = q.filter(Incident.ward_id == ward_id)
    if min_severity is not None:
        q = q.filter(Incident.severity >= min_severity)
    if max_severity is not None:
        q = q.filter(Incident.severity <= max_severity)
    dt_from = _parse_date(date_from)
    dt_to = _parse_date(date_to, end_of_day=True)
    if dt_from:
        q = q.filter(Incident.timestamp >= dt_from)
    if dt_to:
        q = q.filter(Incident.timestamp <= dt_to)

    total = q.count()
    incidents = q.order_by(Incident.timestamp.desc()).offset(offset).limit(limit).all()

    # accused_count per incident, batched in one query for the current page
    # (never one query per row).
    inc_ids = [inc.id for inc in incidents]
    accused_counts = {}
    if inc_ids:
        rows = db.execute(
            select(incident_accused.c.incident_id, func.count(incident_accused.c.accused_id))
            .where(incident_accused.c.incident_id.in_(inc_ids))
            .group_by(incident_accused.c.incident_id)
        ).fetchall()
        accused_counts = {iid: n for iid, n in rows}

    data = []
    for inc in incidents:
        d = inc.to_dict()
        d["accused_count"] = accused_counts.get(inc.id, 0)
        data.append(d)

    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "data": data,
    }


@app.get("/api/districts")
def list_districts(db: Session = Depends(get_db)):
    """List all districts with socio-economic data."""
    districts = db.query(DistrictSocioEconomic).all()
    return {"data": [d.to_dict() for d in districts]}


@app.get("/api/wards")
def list_wards(
    district: str = Query(None),
    db: Session = Depends(get_db),
):
    """List all wards with centroids. Optionally filter by district."""
    q = db.query(Ward)
    if district:
        q = q.filter(Ward.district == district)

    wards = q.order_by(Ward.district, Ward.name).all()
    return {"data": [w.to_dict() for w in wards]}


@app.get("/api/crime-types")
def list_crime_types(db: Session = Depends(get_db)):
    """Distinct crime types present in the dataset (sorted, for filter dropdowns)."""
    rows = db.query(Incident.crime_type).distinct().order_by(Incident.crime_type).all()
    return {"data": [r[0] for r in rows if r[0]]}


# ═══════════════════════════════════════════════════════════════════════════════
#  MODULE 2 ENDPOINTS — Hotspot Detection & Escalation
# ═══════════════════════════════════════════════════════════════════════════════

@app.get("/api/hotspots")
def get_hotspots(
    date_from: str = Query(None, alias="from",
                           description="Start date ISO format, e.g. 2025-01-01"),
    date_to: str = Query(None, alias="to",
                         description="End date ISO format, e.g. 2025-06-30"),
    eps: float = Query(DEFAULT_EPS, description="DBSCAN eps (degrees, ~0.008 = 800m)"),
    min_samples: int = Query(DEFAULT_MIN_SAMPLES, ge=2, description="DBSCAN min_samples"),
    crime_type: str = Query(None, description="Optional crime type filter"),
    district: str = Query(None, description="Optional district filter"),
    ward_id: int = Query(None, description="Optional ward ID filter"),
    db: Session = Depends(get_db),
):
    """
    Compute DBSCAN hotspot clusters for incidents within a date range.
    Hotspots shift when the time window changes — nothing is pre-computed.
    """
    dt_from = _parse_date(date_from)
    dt_to = _parse_date(date_to, end_of_day=True)

    result = detect_hotspots(
        db,
        date_from=dt_from,
        date_to=dt_to,
        eps=eps,
        min_samples=min_samples,
        crime_type=crime_type,
        district=district,
        ward_id=ward_id,
    )
    return result


@app.get("/api/escalation")
def get_escalation(
    ward_id: int = Query(None, description="Optional ward ID to filter"),
    district: str = Query(None, description="Optional district to filter"),
    period: str = Query("monthly", description="Aggregation period: 'weekly' or 'monthly'"),
    rolling_window: int = Query(4, ge=2, le=12,
                                description="Number of periods for rolling stats"),
    threshold: float = Query(1.0, ge=0,
                             description="Z-score threshold for trending_up flag"),
    db: Session = Depends(get_db),
):
    """
    Compute escalation scores for wards based on minor-crime frequency trends.
    Minor crimes (Dispute, Vandalism, Eve Teasing) are tracked as leading
    indicators — a rising trend signals potential escalation before major crimes.
    """
    result = compute_escalation(
        db,
        ward_id=ward_id,
        district=district,
        period=period,
        rolling_window=rolling_window,
        threshold=threshold,
    )
    return result


# ═══════════════════════════════════════════════════════════════════════════════
#  MODULE 3 ENDPOINTS — Risk Scoring + Explainability
# ═══════════════════════════════════════════════════════════════════════════════

@app.get("/api/risk-scores")
def get_risk_scores(
    date_from: str = Query(None, alias="from",
                           description="Start date ISO format, e.g. 2025-01-01"),
    date_to: str = Query(None, alias="to",
                         description="End date ISO format, e.g. 2025-12-31"),
    district: str = Query(None, description="Optional district filter"),
    ward_id: int = Query(None, description="Optional ward ID filter"),
    crime_type: str = Query(None, description="Optional crime type filter"),
    db: Session = Depends(get_db),
):
    """
    Compute risk scores for ALL wards using XGBoost + SHAP.
    Returns wards ranked by risk score (0-100) with plain-language explanations.
    """
    dt_from = _parse_date(date_from)
    dt_to = _parse_date(date_to, end_of_day=True)
    result = compute_risk_scores(
        db, date_from=dt_from, date_to=dt_to, ward_id=ward_id, crime_type=crime_type
    )
    if district and result and "wards" in result:
        result["wards"] = [w for w in result["wards"] if w["district"] == district]
    return result


@app.get("/api/risk-score")
def get_risk_score(
    ward_id: int = Query(..., description="Ward ID to score"),
    date_from: str = Query(None, alias="from",
                           description="Start date ISO format"),
    date_to: str = Query(None, alias="to",
                         description="End date ISO format"),
    crime_type: str = Query(None, description="Optional crime type filter"),
    db: Session = Depends(get_db),
):
    """
    Compute risk score for a SINGLE ward with full SHAP explanation.
    """
    dt_from = _parse_date(date_from)
    dt_to = _parse_date(date_to, end_of_day=True)
    result = compute_risk_scores(db, date_from=dt_from, date_to=dt_to,
                                 ward_id=ward_id, crime_type=crime_type)
    if result["wards"]:
        return result["wards"][0]
    return {"error": "Ward not found", "ward_id": ward_id}


@app.get("/api/predictions/risk")
def get_predictive_risk(
    district: str = Query(None, description="Optional district filter"),
    ward_id: int = Query(None, description="Optional single ward to predict"),
    crime_type: str = Query(None, description="Optional crime type filter"),
    prediction_horizon: int = Query(DEFAULT_HORIZON,
                                    description=f"Forecast horizon in days: one of {VALID_HORIZONS}"),
    date_to: str = Query(None, alias="to",
                         description="Anchor date the forecast is made from (defaults to the latest data available)"),
    db: Session = Depends(get_db),
):
    """
    Forecast crime risk for each ward over the next `prediction_horizon` days,
    using a temporal ML pipeline trained on sliding historical windows (see
    prediction.py). Unlike /api/risk-score (a descriptive snapshot of the
    current window), this trains on past-window -> future-window examples and
    validates with a strict old-to-new temporal split, so it is a genuine
    forecast rather than an in-sample fit.
    """
    as_of = _parse_date(date_to, end_of_day=True)
    return predict_risk(
        db,
        district=district,
        ward_id=ward_id,
        crime_type=crime_type,
        horizon_days=prediction_horizon,
        as_of=as_of,
    )


@app.get("/api/trends")
def get_trends(
    district: str = Query(None, description="Optional district filter"),
    ward_id: int = Query(None, description="Optional single ward to analyze"),
    crime_type: str = Query(None, description="Optional crime type filter"),
    date_from: str = Query(None, alias="from", description="Start date ISO format"),
    date_to: str = Query(None, alias="to", description="End date ISO format"),
    granularity: str = Query(DEFAULT_GRANULARITY,
                             description=f"Aggregation period: one of {GRANULARITIES}"),
    db: Session = Depends(get_db),
):
    """
    Trend + anomaly detection (Module 5) — a DIFFERENT question from
    /api/predictions/risk: this looks at what already happened and flags
    deviations from historical baseline, it does not forecast the future.
    See trend_analysis.py for the full method.
    """
    return analyze_trends(
        db,
        district=district,
        ward_id=ward_id,
        crime_type=crime_type,
        date_from=_parse_date(date_from),
        date_to=_parse_date(date_to, end_of_day=True),
        granularity=granularity,
    )


@app.get("/api/alerts")
def get_alerts(
    district: str = Query(None, description="Optional district filter"),
    ward_id: int = Query(None, description="Optional single ward filter"),
    crime_type: str = Query(None, description="Optional crime type filter"),
    date_from: str = Query(None, alias="from", description="Start date ISO format"),
    date_to: str = Query(None, alias="to", description="End date ISO format"),
    granularity: str = Query(DEFAULT_GRANULARITY, description=f"One of {GRANULARITIES}"),
    severity: str = Query(None, description="ALL | CRITICAL | HIGH | MEDIUM | LOW"),
    status: str = Query(None, description="ALL | NEW | REVIEWED | INVESTIGATING | CLOSED "
                                          "(omit to show only active alerts)"),
    db: Session = Depends(get_db),
):
    """
    Intelligence Alert Center (Module 6) — normalizes real Module 5 anomalies
    / sustained trends (and, for meaningfully high-risk wards, Module 3b
    predictions) into ranked, stateful alerts. Never fabricates an alert:
    an empty scope returns an empty list, not synthetic data.
    """
    return generate_alerts(
        db,
        district=district,
        ward_id=ward_id,
        crime_type=crime_type,
        date_from=_parse_date(date_from),
        date_to=_parse_date(date_to, end_of_day=True),
        granularity=granularity,
        severity=severity,
        status=status,
    )


def _global_alerts(db: Session) -> list[dict]:
    """Return the current generated alert set without changing its logic."""
    return generate_alerts(db, status="ALL").get("alerts", [])


def _require_current_alert(db: Session, alert_id: str) -> None:
    """Only persist workflow state for a generated, stable alert ID.

    Alerts are generated analytics rather than stored records.  Rejecting an
    unknown ID avoids orphaned status rows and makes a stale notification fail
    explicitly instead of appearing to update a different/nonexistent alert.
    """
    if not any(alert["id"] == alert_id for alert in _global_alerts(db)):
        raise HTTPException(status_code=404, detail="Intelligence alert not found")


@app.get("/api/notifications/count")
def get_notification_count(db: Session = Depends(get_db)):
    """Return only the number of current intelligence alerts not yet viewed."""
    alerts = _global_alerts(db)
    return {"unread_count": sum(1 for alert in alerts if not alert["is_read"])}


@app.get("/api/notifications")
def get_notifications(limit: int = Query(5, ge=1, le=20), db: Session = Depends(get_db)):
    """Return a compact, ranked unread-alert list for the header dropdown."""
    unread = [alert for alert in _global_alerts(db) if not alert["is_read"]]
    severity_counts = {
        severity: sum(1 for alert in unread if alert.get("severity") == severity)
        for severity in ("CRITICAL", "HIGH", "MEDIUM", "LOW")
    }
    return {"unread_count": len(unread), "severity_counts": severity_counts, "alerts": unread[:limit]}


# These three mutations are POST, not PATCH, despite being pure state
# updates — this is deliberate, not a REST-style choice. PATCH (like PUT and
# DELETE) is never a CORS "simple method": the browser always sends an OPTIONS
# preflight for it, regardless of body/headers. On this deployment, Catalyst's
# gateway answers that preflight itself before it ever reaches FastAPI, and
# its response carries no Access-Control-* headers — so the browser blocks
# the real request and every PATCH call fails with a bare "NetworkError",
# even though the endpoint works fine when hit directly (curl, no CORS
# involved). POST with a text/plain body is a CORS "simple request" (see
# /api/copilot and /api/ai-chat above for the same, older workaround) and
# skips the preflight entirely, so it isn't subject to the gateway's broken
# OPTIONS handling. The request/response shapes are otherwise unchanged.
@app.post("/api/alerts/{alert_id}/read")
def post_alert_read(alert_id: str, db: Session = Depends(get_db)):
    _require_current_alert(db, alert_id)
    return mark_alert_read(db, alert_id)


@app.post("/api/notifications/read-all")
def post_all_notifications_read(db: Session = Depends(get_db)):
    unread_ids = [alert["id"] for alert in _global_alerts(db) if not alert["is_read"]]
    return {"success": True, "marked_read": mark_alerts_read(db, unread_ids)}


@app.post(
    "/api/alerts/{alert_id}",
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {"application/json": {"schema": AlertStatusUpdate.model_json_schema()}},
        }
    },
)
async def post_alert_status(alert_id: str, request: Request, db: Session = Depends(get_db)):
    """
    Update an alert's workflow status. This is the only part of an alert
    that's persisted. Body is parsed manually (see the module-level comment
    above this route group) because the browser sends it as text/plain to
    avoid a CORS preflight; FastAPI only auto-parses JSON when Content-Type
    is application/json.
    """
    try:
        body = AlertStatusUpdate.model_validate_json(await request.body())
    except ValidationError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    _require_current_alert(db, alert_id)
    new_status = (body.status or "").upper()
    if new_status not in VALID_STATUSES:
        raise HTTPException(status_code=422, detail=f"Invalid status '{body.status}'. Must be one of {VALID_STATUSES}.")
    try:
        return set_alert_status(db, alert_id, new_status, note=body.note)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e


# ═══════════════════════════════════════════════════════════════════════════════
#  MODULE 7 ENDPOINTS — District & Ward Intelligence Drilldown
# ═══════════════════════════════════════════════════════════════════════════════

@app.get("/api/drilldown/district/{district}")
def get_district_drilldown_endpoint(
    district: str,
    crime_type: str = Query(None, description="Optional crime type filter"),
    date_from: str = Query(None, alias="from", description="Start date ISO format"),
    date_to: str = Query(None, alias="to", description="End date ISO format"),
    granularity: str = Query(DRILLDOWN_GRANULARITY, description="Aggregation period for the trend summary"),
    prediction_horizon: int = Query(DRILLDOWN_HORIZON_DAYS, description="Forecast horizon in days"),
    db: Session = Depends(get_db),
):
    """
    District Intelligence Overview (Module 7) — orchestrates existing Modules
    1/2/3 (predict_risk, analyze_trends, generate_alerts) plus detect_hotspots
    into one response: KPIs, crime composition, trend summary, and a ranked
    ward table. Never retrains a model per ward — one call each, district-wide.
    """
    return get_district_drilldown(
        db, district=district, crime_type=crime_type,
        date_from=_parse_date(date_from), date_to=_parse_date(date_to, end_of_day=True),
        granularity=granularity, horizon_days=prediction_horizon,
    )


@app.get("/api/intelligence-brief")
def get_intelligence_brief(
    district: str = Query(None), ward_id: int = Query(None), crime_type: str = Query(None),
    date_from: str = Query(None, alias="from"), date_to: str = Query(None, alias="to"),
    prediction_horizon: int = Query(DRILLDOWN_HORIZON_DAYS), granularity: str = Query(DRILLDOWN_GRANULARITY),
    db: Session = Depends(get_db),
):
    """Structured, deterministic Phase 5 brief composed from drilldown outputs."""
    return generate_intelligence_brief(db, district=district, ward_id=ward_id, crime_type=crime_type,
        date_from=_parse_date(date_from), date_to=_parse_date(date_to, end_of_day=True),
        horizon_days=prediction_horizon, granularity=granularity)


@app.get("/api/drilldown/ward/{ward_id}")
def get_ward_drilldown_endpoint(
    ward_id: int,
    crime_type: str = Query(None, description="Optional crime type filter"),
    date_from: str = Query(None, alias="from", description="Start date ISO format"),
    date_to: str = Query(None, alias="to", description="End date ISO format"),
    granularity: str = Query(DRILLDOWN_GRANULARITY, description="Aggregation period for the trend card"),
    prediction_horizon: int = Query(DRILLDOWN_HORIZON_DAYS, description="Forecast horizon in days"),
    db: Session = Depends(get_db),
):
    """
    Ward Intelligence Overview (Module 7) — the same orchestration as the
    district drilldown, scoped to one ward, plus repeat-offender/network
    context (build_network) and a descriptive day/hour activity pattern.
    """
    return get_ward_drilldown(
        db, ward_id=ward_id, crime_type=crime_type,
        date_from=_parse_date(date_from), date_to=_parse_date(date_to, end_of_day=True),
        granularity=granularity, horizon_days=prediction_horizon,
    )


# ═══════════════════════════════════════════════════════════════════════════════
#  MODULE 4 ENDPOINTS — Offender Network Analysis
# ═══════════════════════════════════════════════════════════════════════════════

@app.get("/api/network")
def get_network(
    ward_id: int = Query(None, description="Filter to incidents in this ward"),
    district: str = Query(None, description="Filter to incidents in this district"),
    crime_type: str = Query(None, description="Filter to incidents of this crime type"),
    date_from: str = Query(None, alias="from", description="Start date ISO format"),
    date_to: str = Query(None, alias="to", description="End date ISO format"),
    db: Session = Depends(get_db),
):
    """
    Build the offender co-occurrence network graph.
    Returns nodes with plain-language tags, edges, and community groupings.
    """
    return build_network(
        db,
        ward_id=ward_id,
        district=district,
        crime_type=crime_type,
        date_from=_parse_date(date_from),
        date_to=_parse_date(date_to, end_of_day=True),
    )


@app.get("/api/network/individual/{accused_id}")
def get_network_individual(
    accused_id: int,
    district: str = Query(None, description="Scope the dossier to this district"),
    crime_type: str = Query(None, description="Scope the dossier to this crime type"),
    date_from: str = Query(None, alias="from", description="Start date ISO format"),
    date_to: str = Query(None, alias="to", description="End date ISO format"),
    db: Session = Depends(get_db),
):
    """
    Get details for a single accused: connections, incidents, community.
    Filters mirror /api/network so the dossier stays consistent with the graph.
    """
    result = get_individual(
        db,
        accused_id,
        district=district,
        crime_type=crime_type,
        date_from=_parse_date(date_from),
        date_to=_parse_date(date_to, end_of_day=True),
    )
    if result is None:
        return {"error": "Individual not found", "accused_id": accused_id}
    return result


@app.post(
    "/api/ai-chat",
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {
                "application/json": {"schema": AiChatRequest.model_json_schema()}
            },
        }
    },
)
async def ai_chat(request: Request):
    """AI assistant endpoint.

    The body is read and validated manually rather than via a typed parameter
    because the browser sends it as text/plain. That is deliberate: the
    Catalyst gateway answers CORS preflight (OPTIONS) requests itself without
    Access-Control-* headers, so any request needing a preflight is blocked by
    the browser. text/plain keeps the POST a CORS "simple request".
    FastAPI only auto-parses a JSON body when Content-Type is application/json,
    hence the explicit parse here. The request and response shapes are
    unchanged: {"question", "dashboard_context"} in, {"answer"} out.
    """
    try:
        payload = AiChatRequest.model_validate_json(await request.body())
    except ValidationError:
        return {"answer": "Sorry, I could not read that question. Please try again."}

    question = payload.question.strip()

    if not question:
        return {
            "answer": "Ask me anything about the dashboard or a general question."
        }

    api_key = os.getenv("OPENAI_API_KEY")
    if api_key:
        answer = _call_openai_chat(question, payload.dashboard_context or {}, api_key)
        if answer:
            return {"answer": answer}

    return {"answer": _offline_chat_answer(question, payload.dashboard_context or {})}


@app.post("/api/copilot")
async def copilot(request: Request, db: Session = Depends(get_db)):
    """Evidence-grounded Phase 6 Intelligence Copilot endpoint."""
    try:
        payload = CopilotRequest.model_validate_json(await request.body())
    except ValidationError:
        return {"answer": "I could not read that request. Please ask an intelligence question.", "evidence": [], "actions": [], "scope": {}, "sources": []}
    context = payload.context or {}
    # Accept the language both at the request root and in context.  Keeping it
    # in one authoritative place prevents an English default when a client
    # submits only the root-level field.
    if payload.language in {"en", "kn", "hi"}:
        context = {**context, "language": payload.language}
    message = (payload.message or "").strip()
    if not message:
        return {"answer": "Ask about risk, trends, alerts, hotspots, incidents, offenders, networks, or the current intelligence brief.", "evidence": [], "actions": [], "scope": context, "sources": []}
    return answer_copilot(db, message, context, payload.history or [])


def _parse_date(s: str | None, end_of_day: bool = False) -> datetime | None:
    """Parse an ISO date string or return None."""
    if not s:
        return None
    try:
        parsed = datetime.fromisoformat(s)
        if end_of_day and "T" not in s and " " not in s:
            return datetime.combine(parsed.date(), time.max)
        return parsed
    except ValueError:
        return None


def _call_openai_chat(question: str, dashboard_context: dict, api_key: str) -> str | None:
    """
    Call Groq (OpenAI-compatible Chat Completions API)
    """

    base_url = os.getenv("OPENAI_BASE_URL", "https://api.groq.com/openai/v1")
    model = os.getenv("OPENAI_MODEL", "llama-3.3-70b-versatile")

    body = {
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are the Crime Intel Suite assistant. "
                    "Answer any user question clearly and briefly. "
                    "Use dashboard context whenever relevant. "
                    "Do not claim synthetic demo data is real."
                ),
            },
            {
                "role": "user",
                "content": (
                    f"Dashboard context:\n"
                    f"{json.dumps(dashboard_context, ensure_ascii=False)[:12000]}\n\n"
                    f"Question: {question}"
                ),
            },
        ],
        "temperature": 0.7,
        "max_tokens": 450,
    }

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
        # Groq's API is fronted by Cloudflare, which blocks the default
        # urllib/requests User-Agent as a bot signature (HTTP 403, "error
        # code: 1010"). A normal-looking User-Agent avoids the block.
        "User-Agent": "CrimeIntelSuite/1.0 (+https://github.com)",
    }

    try:
        response = requests.post(
            f"{base_url}/chat/completions",
            headers=headers,
            json=body,
            timeout=20,
        )
        response.raise_for_status()
        data = response.json()

    except requests.exceptions.HTTPError as e:
        return None

    except Exception as e:
        return None

    try:
        return data["choices"][0]["message"]["content"].strip()
    except Exception:
        return None

def _offline_chat_answer(question: str, dashboard_context: dict) -> str:
    q = question.lower()
    summary = dashboard_context.get("summary", {})

    if any(word in q for word in ["hello", "hi", "hey"]):
        return "Hi. Ask me about this dashboard, crime analytics, policing strategy, or any general topic. Full open-ended AI answers are enabled when OPENAI_API_KEY is set on the backend."
    if "summary" in q or "summar" in q:
        return (
            f"Dashboard summary: {summary.get('incidents', 'available')} incidents, "
            f"{summary.get('hotspot_clusters', 0)} hotspot clusters, "
            f"{summary.get('high_risk_wards', 0)} high-risk wards, "
            f"{summary.get('rising_wards', 0)} rising zones, and "
            f"{summary.get('network_groups', 0)} network groups in the current filter."
        )
    if "crime" in q and ("prevent" in q or "reduce" in q):
        return "Practical prevention usually combines hotspot patrols, repeat-offender monitoring, community reporting, better lighting/CCTV at repeat locations, and quick follow-up on minor-crime escalation signals."
    if "ai" in q or "machine learning" in q:
        return "AI can help by finding hotspot clusters, predicting ward-level risk, explaining top risk factors, and detecting offender networks. It should support investigators, not replace human review."
    if "police" in q or "patrol" in q:
        return "A good patrol plan prioritizes high-risk wards, recent hotspot clusters, rising minor-crime zones, and times with repeated incidents, while keeping enough coverage for routine calls."

    return (
        "Ask-anything mode needs an OpenAI API key on the backend. Add OPENAI_API_KEY to backend/.env, "
        "restart the backend, and I will answer general questions like ChatGPT. Until then I can answer "
        "dashboard, crime analytics, policing, AI, and summary questions."
    )
