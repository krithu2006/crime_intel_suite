"""
Crime Intel Suite — Module 2: Hotspot Detection & Escalation Analysis

Contains:
  1. Spatial hotspot detection via DBSCAN clustering on incident lat/lng
  2. Escalation / early-warning detection via rolling z-score on minor-crime
     frequency per ward (weekly/monthly), producing escalation_score and
     trending_up flag.
"""

import numpy as np
import pandas as pd
import logging
import math
from datetime import datetime, timedelta
from sklearn.cluster import DBSCAN
from sqlalchemy.orm import Session
from sqlalchemy import and_

from .models import Incident, Ward

logger = logging.getLogger(__name__)


# ═══════════════════════════════════════════════════════════════════════════════
#  1. SPATIAL HOTSPOT DETECTION (DBSCAN)
# ═══════════════════════════════════════════════════════════════════════════════

# DBSCAN parameters tuned for Bengaluru ward-scale data:
#   eps ≈ 0.008 degrees (~800m radius at this latitude)
#   min_samples = 5  (supports sparser statewide datasets without overfitting)
DEFAULT_EPS = 0.008
DEFAULT_MIN_SAMPLES = 5


def detect_hotspots(
    db: Session,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    eps: float = DEFAULT_EPS,
    min_samples: int = DEFAULT_MIN_SAMPLES,
    crime_type: str | None = None,
    district: str | None = None,
    ward_id: int | None = None,
) -> dict:
    """
    Run DBSCAN on incidents within the given time window.

    Returns:
      {
        "params": { eps, min_samples, date_from, date_to },
        "n_incidents": int,
        "n_clusters": int,
        "n_noise": int,
        "clusters": [
            {
                "cluster_id": int,
                "centroid": { "lat": float, "lng": float },
                "incident_count": int,
                "radius_m": float,
                "district": str,  # majority district in the cluster
                "dominant_crime_type": str,
                "risk_score": float,
                "severity_level": "High" | "Medium" | "Low",
                "avg_severity": float,
                "points": [ { "lat", "lng", "crime_type", "severity", "timestamp" }, ... ]
            }, ...
        ]
      }
    """
    total_incidents_loaded = db.query(Incident).count()

    # ── Build query with optional filters ──
    q = db.query(Incident)

    if date_from:
        q = q.filter(Incident.timestamp >= date_from)
    if date_to:
        q = q.filter(Incident.timestamp <= date_to)
    if crime_type:
        q = q.filter(Incident.crime_type == crime_type)
    if district:
        q = q.filter(Incident.district == district)
    if ward_id is not None:
        q = q.filter(Incident.ward_id == ward_id)

    incidents = q.all()
    incidents_after_filtering = len(incidents)

    logger.warning(
        "hotspot_pipeline total_incidents_loaded=%d incidents_after_filtering=%d "
        "filters[from=%s,to=%s,district=%s,ward_id=%s,crime_type=%s] params[eps=%.6f,min_samples=%d]",
        total_incidents_loaded,
        incidents_after_filtering,
        date_from.isoformat() if date_from else None,
        date_to.isoformat() if date_to else None,
        district,
        ward_id,
        crime_type,
        eps,
        min_samples,
    )

    valid_incidents = []
    for inc in incidents:
        try:
            if math.isfinite(float(inc.lat)) and math.isfinite(float(inc.lng)):
                valid_incidents.append(inc)
        except (TypeError, ValueError):
            continue

    invalid_coordinate_count = incidents_after_filtering - len(valid_incidents)
    if invalid_coordinate_count:
        logger.warning(
            "hotspot_pipeline dropped_invalid_coordinates=%d incidents_after_filtering=%d",
            invalid_coordinate_count,
            incidents_after_filtering,
        )

    point_details = [_incident_point(inc) for inc in valid_incidents]

    if len(valid_incidents) < min_samples:
        logger.warning(
            "hotspot_pipeline clusters_generated=0 reason=insufficient_points usable_incidents=%d min_samples=%d",
            len(valid_incidents),
            min_samples,
        )
        return {
            "params": _params_dict(eps, min_samples, date_from, date_to),
            "n_incidents": len(valid_incidents),
            "n_clusters": 0,
            "n_noise": len(valid_incidents),
            "clusters": [],
            "points": point_details,
        }

    # ── Prepare coordinate matrix ──
    coords = np.array([[inc.lat, inc.lng] for inc in valid_incidents])

    # ── Run DBSCAN, auto-relaxing params if nothing clusters ──
    # A district/date-range filter can leave incidents too sparse for the
    # requested eps/min_samples (e.g. a small district with points spread
    # wider than the default ~800m radius). Rather than silently reporting
    # zero hotspots for a district that clearly has incidents, progressively
    # loosen min_samples and then eps until real clusters emerge.
    effective_eps = eps
    effective_min_samples = min_samples
    labels = None
    n_clusters = 0
    auto_tuned = False

    for attempt in range(8):
        db_model = DBSCAN(eps=effective_eps, min_samples=effective_min_samples, metric="euclidean")
        labels = db_model.fit_predict(coords)
        n_clusters = len(set(labels) - {-1})

        if n_clusters > 0 or len(valid_incidents) < 2:
            break

        auto_tuned = True
        if effective_min_samples > 2:
            effective_min_samples -= 1
        else:
            effective_eps *= 1.6

    n_noise = int(np.sum(labels == -1))

    if auto_tuned:
        logger.warning(
            "hotspot_pipeline auto_tuned=true eps=%.6f->%.6f min_samples=%d->%d clusters_found=%d",
            eps, effective_eps, min_samples, effective_min_samples, n_clusters,
        )

    # ── Build cluster summaries ──
    clusters = []
    for cid in range(n_clusters):
        mask = labels == cid
        cluster_incidents = [inc for inc, lbl in zip(valid_incidents, labels) if lbl == cid]
        cluster_coords = coords[mask]

        centroid_lat = float(np.mean(cluster_coords[:, 0]))
        centroid_lng = float(np.mean(cluster_coords[:, 1]))

        # Approximate radius in meters (1 degree lat ≈ 111,320m at equator)
        max_dist_deg = float(np.max(np.sqrt(
            (cluster_coords[:, 0] - centroid_lat) ** 2 +
            (cluster_coords[:, 1] - centroid_lng) ** 2
        )))
        radius_m = round(max_dist_deg * 111_320, 1)

        # Dominant crime type
        crime_counts = {}
        district_counts = {}
        ward_counts = {}
        severities = []
        for inc in cluster_incidents:
            crime_counts[inc.crime_type] = crime_counts.get(inc.crime_type, 0) + 1
            district_counts[inc.district] = district_counts.get(inc.district, 0) + 1
            ward_counts[inc.ward_id] = ward_counts.get(inc.ward_id, 0) + 1
            severities.append(inc.severity)
        dominant = max(crime_counts, key=crime_counts.get)
        majority_district = sorted(
            district_counts.items(),
            key=lambda item: (-item[1], item[0]),
        )[0][0]
        # Majority ward — lets the district/ward drilldown (Module 7) attribute
        # a cluster to a ward for ranking/counting without a new algorithm.
        majority_ward_id = sorted(
            ward_counts.items(),
            key=lambda item: (-item[1], item[0] if item[0] is not None else -1),
        )[0][0]

        # Point details (limit to avoid huge payloads — send up to 200 per cluster)
        cluster_points = [_incident_point(inc) for inc in cluster_incidents[:200]]

        clusters.append({
            "cluster_id": cid,
            "centroid": {"lat": centroid_lat, "lng": centroid_lng},
            "incident_count": len(cluster_incidents),
            "radius_m": radius_m,
            "dominant_crime_type": dominant,
            "district": majority_district,
            "ward_id": majority_ward_id,
            "avg_severity": round(float(np.mean(severities)), 2),
            "crime_breakdown": crime_counts,
            "points": cluster_points,
        })

    # Sort clusters by incident count descending
    clusters.sort(key=lambda c: c["incident_count"], reverse=True)
    _assign_cluster_risk_scores(clusters)

    logger.warning(
        "hotspot_pipeline clusters_generated=%d noise_points=%d usable_incidents=%d",
        n_clusters,
        n_noise,
        len(valid_incidents),
    )

    return {
        "params": _params_dict(effective_eps, effective_min_samples, date_from, date_to),
        "auto_tuned": auto_tuned,
        "n_incidents": len(valid_incidents),
        "n_clusters": n_clusters,
        "n_noise": n_noise,
        "clusters": clusters,
        "points": point_details,
    }


def _incident_point(incident: Incident) -> dict:
    return {
        "id": incident.id,
        "lat": incident.lat,
        "lng": incident.lng,
        "crime_type": incident.crime_type,
        "severity": incident.severity,
        "timestamp": incident.timestamp.isoformat(),
    }


def _params_dict(eps, min_samples, date_from, date_to):
    return {
        "eps": eps,
        "min_samples": min_samples,
        "date_from": date_from.isoformat() if date_from else None,
        "date_to": date_to.isoformat() if date_to else None,
    }


def _min_max_normalize(values: np.ndarray) -> np.ndarray:
    mn = values.min()
    mx = values.max()
    if mx - mn < 1e-9:
        return np.full(values.shape, 0.5, dtype=float)
    return (values - mn) / (mx - mn)


def _assign_cluster_risk_scores(clusters: list[dict]) -> None:
    if not clusters:
        return

    incident_counts = np.array([c["incident_count"] for c in clusters], dtype=float)
    avg_severities = np.array([c["avg_severity"] for c in clusters], dtype=float)
    incident_component = _min_max_normalize(incident_counts)
    severity_component = _min_max_normalize(avg_severities)
    risk_scores = (0.65 * incident_component + 0.35 * severity_component) * 100.0

    n_clusters = len(clusters)
    high_cutoff_rank = math.ceil(n_clusters / 3)
    medium_cutoff_rank = math.ceil((2 * n_clusters) / 3)
    ranked_indices = np.argsort(risk_scores)[::-1].tolist()

    for rank, idx in enumerate(ranked_indices):
        score = round(float(risk_scores[idx]), 1)

        if n_clusters >= 3:
            if rank < high_cutoff_rank:
                level = "High"
            elif rank < medium_cutoff_rank:
                level = "Medium"
            else:
                level = "Low"
        else:
            level = "High" if rank == 0 else "Low"

        cluster = clusters[idx]
        cluster["risk_score"] = score
        cluster["severity_level"] = level


# ═══════════════════════════════════════════════════════════════════════════════
#  2. ESCALATION / EARLY-WARNING DETECTION
# ═══════════════════════════════════════════════════════════════════════════════
#
# Strategy:
#   For each ward, build a time series of MINOR crime frequency (Dispute,
#   Vandalism, Eve Teasing) aggregated by period (weekly or monthly).
#   Apply a rolling z-score to detect wards where minor-crime frequency is
#   rising abnormally — a leading indicator before major incidents.
#
#   - rolling_window = 4 periods (4 weeks or 4 months)
#   - escalation_score = z-score of the latest period relative to the
#     rolling mean/std of the preceding window
#   - trending_up = True if escalation_score > threshold (default 1.0)

MINOR_CRIME_TYPES = {"Dispute", "Vandalism", "Eve Teasing"}
DEFAULT_ROLLING_WINDOW = 4
DEFAULT_ESCALATION_THRESHOLD = 1.0


def compute_escalation(
    db: Session,
    ward_id: int | None = None,
    district: str | None = None,
    period: str = "monthly",      # "weekly" or "monthly"
    rolling_window: int = DEFAULT_ROLLING_WINDOW,
    threshold: float = DEFAULT_ESCALATION_THRESHOLD,
) -> dict:
    """
    Compute escalation scores for wards based on minor-crime frequency trends.

    Returns:
      {
        "period": "monthly" | "weekly",
        "rolling_window": int,
        "threshold": float,
        "minor_crime_types": [...],
        "wards": [
            {
                "ward_id": int,
                "ward_name": str,
                "district": str,
                "escalation_score": float,
                "trending_up": bool,
                "latest_period": str,
                "latest_count": int,
                "rolling_mean": float,
                "rolling_std": float,
                "time_series": [ { "period": str, "count": int }, ... ]
            }, ...
        ]
      }
    """
    # ── Fetch all minor-crime incidents ──
    q = db.query(Incident).filter(Incident.crime_type.in_(MINOR_CRIME_TYPES))
    if ward_id is not None:
        q = q.filter(Incident.ward_id == ward_id)
    if district is not None:
        q = q.filter(Incident.district == district)

    incidents = q.all()

    if not incidents:
        return _empty_escalation_result(period, rolling_window, threshold)

    # ── Build a DataFrame ──
    rows = [{"ward_id": inc.ward_id, "timestamp": inc.timestamp} for inc in incidents]
    df = pd.DataFrame(rows)
    df["timestamp"] = pd.to_datetime(df["timestamp"])

    # ── Determine period grouping key ──
    if period == "weekly":
        df["period_key"] = df["timestamp"].dt.isocalendar().year.astype(str) + "-W" + \
                           df["timestamp"].dt.isocalendar().week.astype(str).str.zfill(2)
        df["period_sort"] = df["timestamp"].dt.isocalendar().year * 100 + \
                            df["timestamp"].dt.isocalendar().week
    else:  # monthly
        df["period_key"] = df["timestamp"].dt.strftime("%Y-%m")
        df["period_sort"] = df["timestamp"].dt.year * 100 + df["timestamp"].dt.month

    # ── Get all wards ──
    ward_q = db.query(Ward)
    if ward_id is not None:
        ward_q = ward_q.filter(Ward.id == ward_id)
    if district is not None:
        ward_q = ward_q.filter(Ward.district == district)
    wards = ward_q.all()
    ward_map = {w.id: w for w in wards}

    # ── Generate the full set of periods so wards with 0 counts still show ──
    all_periods = sorted(df[["period_key", "period_sort"]].drop_duplicates()
                         .values.tolist(), key=lambda x: x[1])

    # ── Compute per-ward escalation ──
    ward_results = []

    for w in wards:
        wdf = df[df["ward_id"] == w.id]

        # Build complete time series with 0-filled gaps
        ts_map = wdf.groupby("period_key").size().to_dict()
        ts = [{"period": pk, "count": ts_map.get(pk, 0)} for pk, _ in all_periods]

        counts = [t["count"] for t in ts]

        if len(counts) < rolling_window + 1:
            # Not enough data for a meaningful z-score
            ward_results.append({
                "ward_id": w.id,
                "ward_name": w.name,
                "district": w.district,
                "escalation_score": 0.0,
                "trending_up": False,
                "latest_period": ts[-1]["period"] if ts else None,
                "latest_count": counts[-1] if counts else 0,
                "rolling_mean": None,
                "rolling_std": None,
                "time_series": ts,
            })
            continue

        # Rolling stats over the window preceding the latest period
        window_counts = counts[-(rolling_window + 1):-1]
        latest_count = counts[-1]
        r_mean = float(np.mean(window_counts))
        r_std = float(np.std(window_counts, ddof=1)) if len(window_counts) > 1 else 0.0

        # Z-score
        if r_std > 0:
            z = (latest_count - r_mean) / r_std
        else:
            # If std is 0 (constant counts), any increase is anomalous
            z = float(latest_count - r_mean) * 2.0 if latest_count > r_mean else 0.0

        escalation_score = round(z, 3)
        trending_up = escalation_score > threshold

        ward_results.append({
            "ward_id": w.id,
            "ward_name": w.name,
            "district": w.district,
            "escalation_score": escalation_score,
            "trending_up": trending_up,
            "latest_period": ts[-1]["period"],
            "latest_count": latest_count,
            "rolling_mean": round(r_mean, 2),
            "rolling_std": round(r_std, 2),
            "time_series": ts,
        })

    # Sort by escalation score descending
    ward_results.sort(key=lambda w: w["escalation_score"], reverse=True)

    return {
        "period": period,
        "rolling_window": rolling_window,
        "threshold": threshold,
        "minor_crime_types": sorted(MINOR_CRIME_TYPES),
        "wards": ward_results,
    }


def _empty_escalation_result(period, rolling_window, threshold):
    return {
        "period": period,
        "rolling_window": rolling_window,
        "threshold": threshold,
        "minor_crime_types": sorted(MINOR_CRIME_TYPES),
        "wards": [],
    }
