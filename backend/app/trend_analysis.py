"""
Crime Intel Suite — Module 5: Trend Analysis & Anomaly Detection

Answers a different question from Module 3b's prediction.py:

    prediction.py  -> "What may happen in the NEXT N days?"      (forecast)
    trend_analysis.py -> "What unusual thing is happening NOW / recently?" (anomaly)

These stay analytically separate on purpose — a prediction is a forecast
with its own confidence interval, an anomaly is a statistical judgement
about data that already happened. They are never mixed in one function or
one API response.

Pipeline for a given (district, ward, crime_type) scope:
  1. Aggregate incidents into periods (daily/weekly/monthly).
  2. For each period, compute a rolling baseline (mean/std of the preceding
     N periods only — the period being judged is NEVER part of its own
     baseline, so there is no leakage, same principle as prediction.py).
  3. Score the deviation as a z-score, map it to a severity tier via a
     single documented threshold table.
  4. Separately look for SUSTAINED trends (multi-period drift) — a distinct
     signal from a one-period spike/drop.
  5. Optionally repeat the whole pipeline per-ward and per-crime-type (and
     per ward+crime_type when neither is already filtered) to find the most
     "interesting" breakdowns — this feeds the Top Emerging Trends list and
     Phase 3's future Alert Center.

All history needed to build a period's baseline is loaded regardless of the
UI date range (mirrors prediction.py's precedent) — district/ward/crime_type
filters are always respected, but the *date range* only controls which
periods are returned/displayed, not what data can inform their baselines.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from datetime import datetime
from sqlalchemy.orm import Session

from .models import Incident, Ward

# ═══════════════════════════════════════════════════════════════════════════
#  Tunables — single source of truth for every threshold used below
# ═══════════════════════════════════════════════════════════════════════════

GRANULARITIES = ("daily", "weekly", "monthly")
DEFAULT_GRANULARITY = "weekly"

MIN_BASELINE_PERIODS = 3        # fewer prior periods than this -> baseline is untrustworthy
BASELINE_LOOKBACK_PERIODS = 6   # rolling baseline = mean/std of up to this many prior periods
EXPECTED_RANGE_MULT = 1.5       # displayed expected range = mean ± MULT * std

# z-score magnitude -> severity tier. Checked high-to-low; anything below the
# lowest cutoff is "NORMAL" (not an anomaly). Keeping this as one ordered
# table means every severity decision in the module goes through one place.
ANOMALY_SEVERITY_THRESHOLDS = [
    (3.0, "CRITICAL"),
    (2.5, "HIGH"),
    (2.0, "MEDIUM"),
    (1.5, "LOW"),
]
SEVERITY_RANK = {"CRITICAL": 4, "HIGH": 3, "MEDIUM": 2, "LOW": 1, "NORMAL": 0}

TREND_PCT_THRESHOLD = 10.0      # period-over-period % change beyond this -> rising/falling

SUSTAINED_MIN_CONSECUTIVE = 3          # 3+ strictly-increasing/decreasing periods in a row
SUSTAINED_ROLLING_WINDOW = 3           # compare avg(last W) vs avg(previous W)
SUSTAINED_PCT_THRESHOLD = 30.0         # rolling-average change needed to call it "sustained"

MIN_GROUP_INCIDENTS = 5         # skip ward/crime-type breakdown groups this thin
TOP_EMERGING_LIMIT = 8
MAX_ANOMALIES_RETURNED = 20
MIN_WARD_SHARE_PCT = 15.0       # below this, a ward's contribution isn't worth calling out

# Sparse-count guard: a very large relative/z-score movement from a near-zero
# baseline is still retained as an anomaly, but it cannot become CRITICAL
# unless the absolute movement is large enough to support that interpretation.
LOW_VOLUME_BASELINE_MAX = 2.0
LOW_VOLUME_MIN_ABSOLUTE_DELTA = 5.0
LOW_VOLUME_MAX_SEVERITY = "MEDIUM"

_GRANULARITY_NOUN = {"daily": "days", "weekly": "weeks", "monthly": "months"}


# ═══════════════════════════════════════════════════════════════════════════
#  Small numeric helpers (shared so every % / severity decision is consistent)
# ═══════════════════════════════════════════════════════════════════════════

def _safe_pct_change(current: float, previous: float) -> float | None:
    """
    Percentage change from `previous` to `current`. Returns None (never Inf
    or NaN) when `previous` is 0 and `current` > 0 — growth "from zero" has
    no finite percentage, so callers should treat None as a distinct
    "new activity" case rather than an error.
    """
    if previous and previous > 0:
        return round(((current - previous) / previous) * 100.0, 1)
    if current > 0:
        return None
    return 0.0


def _severity_for_abs_z(abs_z: float) -> str:
    for cutoff, label in ANOMALY_SEVERITY_THRESHOLDS:
        if abs_z >= cutoff:
            return label
    return "NORMAL"


def _calibrate_sparse_severity(observed: float, mean: float, severity: str) -> str:
    """Keep sparse anomalies visible without over-ranking tiny absolute counts."""
    if mean <= LOW_VOLUME_BASELINE_MAX and abs(observed - mean) < LOW_VOLUME_MIN_ABSOLUTE_DELTA:
        cap_rank = SEVERITY_RANK[LOW_VOLUME_MAX_SEVERITY]
        if SEVERITY_RANK.get(severity, 0) > cap_rank:
            return LOW_VOLUME_MAX_SEVERITY
    return severity


def _period_start(ts: pd.Series, granularity: str) -> pd.Series:
    if granularity == "daily":
        return ts.dt.normalize()
    if granularity == "monthly":
        return ts.dt.to_period("M").dt.to_timestamp()
    # weekly (default): Monday-anchored ISO week
    return ts.dt.normalize() - pd.to_timedelta(ts.dt.weekday, unit="D")


def _full_period_index(min_start, max_start, granularity: str) -> pd.DatetimeIndex:
    """Every period between min_start and max_start, so zero-incident periods are represented."""
    if granularity == "daily":
        return pd.date_range(start=min_start, end=max_start, freq="D")
    if granularity == "monthly":
        return pd.date_range(start=min_start, end=max_start, freq="MS")
    return pd.date_range(start=min_start, end=max_start, freq="7D")  # weekly


# ═══════════════════════════════════════════════════════════════════════════
#  1. Load scoped incidents
# ═══════════════════════════════════════════════════════════════════════════

def _load_scope(db: Session, district, ward_id, crime_type) -> pd.DataFrame:
    """
    All incidents matching district/ward/crime_type (NOT date — see module
    docstring), with the columns every downstream grouping needs.
    """
    q = db.query(Incident.timestamp, Incident.ward_id, Incident.district, Incident.crime_type)
    if district:
        q = q.filter(Incident.district == district)
    if ward_id is not None:
        q = q.filter(Incident.ward_id == ward_id)
    if crime_type:
        q = q.filter(Incident.crime_type == crime_type)
    rows = q.all()
    if not rows:
        return pd.DataFrame(columns=["timestamp", "ward_id", "district", "crime_type"])
    return pd.DataFrame(rows, columns=["timestamp", "ward_id", "district", "crime_type"])


# ═══════════════════════════════════════════════════════════════════════════
#  2/3. Core pipeline: aggregate -> rolling baseline -> anomaly score
# ═══════════════════════════════════════════════════════════════════════════

def _build_full_series(timestamps: pd.Series, granularity: str):
    """
    Bucket `timestamps` into periods and compute, for every period, a
    leak-free rolling baseline from strictly preceding periods. Returns
    (period_index, counts, baseline_mean, baseline_std, has_baseline) — all
    aligned numpy/pandas arrays covering the group's ENTIRE history (the
    caller slices to the requested date range afterwards).
    """
    starts = _period_start(timestamps, granularity)
    counts_by_period = starts.value_counts().sort_index()
    full_index = _full_period_index(counts_by_period.index.min(), counts_by_period.index.max(), granularity)
    counts = counts_by_period.reindex(full_index, fill_value=0).values.astype(float)
    n = len(counts)

    baseline_mean = np.full(n, np.nan)
    baseline_std = np.full(n, np.nan)
    has_baseline = np.zeros(n, dtype=bool)
    for i in range(n):
        lo = max(0, i - BASELINE_LOOKBACK_PERIODS)
        window = counts[lo:i]  # strictly before i — never includes the period itself
        if len(window) >= MIN_BASELINE_PERIODS:
            baseline_mean[i] = float(window.mean())
            baseline_std[i] = float(window.std(ddof=1)) if len(window) > 1 else 0.0
            has_baseline[i] = True

    return full_index, counts, baseline_mean, baseline_std, has_baseline


def _score_period(observed: float, mean: float, std: float):
    """
    z-score (or a documented fallback when the baseline has ~zero variance),
    mapped to a severity tier. Returns (z, severity, direction).
    """
    if std < 1e-9:
        # Degenerate (near-constant, e.g. all-zero) baseline: a real z-score
        # is undefined, so scale by relative deviation instead. This only
        # ever fires for low-volume groups where the ordinary z-score branch
        # below would divide by ~0.
        if mean < 1e-9:
            z = 0.0 if observed < 1e-9 else 3.0  # any activity where history had ~none
        else:
            z = ((observed - mean) / mean) * 2.0
    else:
        z = (observed - mean) / std

    severity = _calibrate_sparse_severity(observed, mean, _severity_for_abs_z(abs(z)))
    direction = "spike" if observed > mean else "drop" if observed < mean else "none"
    return round(float(z), 2), severity, direction


def _period_label(ts: pd.Timestamp) -> str:
    return ts.date().isoformat()


# ═══════════════════════════════════════════════════════════════════════════
#  Sustained (multi-period) trend detection — separate from single-period anomalies
# ═══════════════════════════════════════════════════════════════════════════

def _sustained_trend(values: np.ndarray) -> dict:
    n = len(values)
    if n < SUSTAINED_MIN_CONSECUTIVE + 1:
        return {"detected": False}

    consec_rise = 0
    for i in range(n - 1, 0, -1):
        if values[i] > values[i - 1]:
            consec_rise += 1
        else:
            break
    consec_fall = 0
    for i in range(n - 1, 0, -1):
        if values[i] < values[i - 1]:
            consec_fall += 1
        else:
            break

    rolling = None
    W = SUSTAINED_ROLLING_WINDOW
    if n >= 2 * W:
        recent_avg = float(np.mean(values[-W:]))
        prior_avg = float(np.mean(values[-2 * W:-W]))
        pct = _safe_pct_change(recent_avg, prior_avg)
        if pct is not None and pct >= SUSTAINED_PCT_THRESHOLD:
            rolling = ("rising", pct)
        elif pct is not None and pct <= -SUSTAINED_PCT_THRESHOLD:
            rolling = ("falling", pct)
        elif pct is None and recent_avg > 0:
            rolling = ("rising", None)

    if consec_rise >= SUSTAINED_MIN_CONSECUTIVE:
        pct = _safe_pct_change(float(values[-1]), float(values[-1 - consec_rise]))
        return {"detected": True, "direction": "rising", "periods": consec_rise + 1,
                "change_percent": pct, "method": "consecutive_periods"}
    if consec_fall >= SUSTAINED_MIN_CONSECUTIVE:
        pct = _safe_pct_change(float(values[-1]), float(values[-1 - consec_fall]))
        return {"detected": True, "direction": "falling", "periods": consec_fall + 1,
                "change_percent": pct, "method": "consecutive_periods"}
    if rolling:
        direction, pct = rolling
        return {"detected": True, "direction": direction, "periods": 2 * W,
                "change_percent": pct, "method": "rolling_average"}
    return {"detected": False}


# ═══════════════════════════════════════════════════════════════════════════
#  Group analysis — the one function every level (overall/ward/crime_type/combo) calls
# ═══════════════════════════════════════════════════════════════════════════

def _analyze_group(timestamps: pd.Series, granularity: str, date_from: datetime | None, date_to: datetime | None):
    """
    Full pipeline for one group's timestamps. Returns None if there's no
    data at all, else a dict with the full leak-free series (sliced to the
    requested date range for display), the current/previous comparison, and
    sustained-trend info for that displayed slice.
    """
    if len(timestamps) == 0:
        return None

    full_index, counts, b_mean, b_std, has_b = _build_full_series(timestamps, granularity)

    disp_mask = np.ones(len(full_index), dtype=bool)
    if date_from is not None:
        disp_mask &= full_index >= _period_start(pd.Series([pd.Timestamp(date_from)]), granularity).iloc[0]
    if date_to is not None:
        disp_mask &= full_index <= _period_start(pd.Series([pd.Timestamp(date_to)]), granularity).iloc[0]

    idxs = np.where(disp_mask)[0]
    if len(idxs) == 0:
        # Requested date range doesn't overlap this group's data at all.
        idxs = np.array([len(full_index) - 1])  # fall back to the latest period only

    series = []
    for i in idxs:
        observed = float(counts[i])
        entry = {
            "period": _period_label(full_index[i]),
            "count": int(observed),
            "baseline": round(float(b_mean[i]), 2) if has_b[i] else None,
            "lower_bound": round(max(0.0, b_mean[i] - EXPECTED_RANGE_MULT * b_std[i]), 2) if has_b[i] else None,
            "upper_bound": round(b_mean[i] + EXPECTED_RANGE_MULT * b_std[i], 2) if has_b[i] else None,
            "is_anomaly": False,
            "severity": None,
            "anomaly_score": None,
            "direction": None,
            "percentage_change": None,
            "insufficient_baseline": not bool(has_b[i]),
        }
        if has_b[i]:
            z, severity, direction = _score_period(observed, b_mean[i], b_std[i])
            entry["anomaly_score"] = abs(z)
            entry["severity"] = severity
            entry["direction"] = direction
            entry["is_anomaly"] = severity != "NORMAL"
            entry["percentage_change"] = _safe_pct_change(observed, b_mean[i])
        series.append(entry)

    disp_counts = counts[idxs]
    current_value = float(disp_counts[-1]) if len(disp_counts) else 0.0
    previous_value = float(disp_counts[-2]) if len(disp_counts) >= 2 else None
    if previous_value is None:
        change, change_percent, trend = 0.0, None, "stable"
    else:
        change = current_value - previous_value
        change_percent = _safe_pct_change(current_value, previous_value)
        if change_percent is None:
            trend = "rising" if current_value > 0 else "stable"
        elif change_percent > TREND_PCT_THRESHOLD:
            trend = "rising"
        elif change_percent < -TREND_PCT_THRESHOLD:
            trend = "falling"
        else:
            trend = "stable"

    summary = {
        "trend": trend,
        "current_value": int(current_value),
        "previous_value": int(previous_value) if previous_value is not None else None,
        "change": round(change, 1),
        "change_percent": change_percent,
        "current_period": series[-1]["period"] if series else None,
        "previous_period": series[-2]["period"] if len(series) >= 2 else None,
    }

    sustained = _sustained_trend(disp_counts)

    return {
        "series": series,
        "summary": summary,
        "sustained_trend": sustained,
        "total_incidents_in_scope": int(counts.sum()),
        "periods_with_baseline": int(has_b.sum()),
    }


# ═══════════════════════════════════════════════════════════════════════════
#  Anomaly / emerging-trend records (Phase-3-ready shape)
# ═══════════════════════════════════════════════════════════════════════════

def _anomaly_records(group_result: dict, granularity: str, district, ward_name, ward_id, crime_type) -> list[dict]:
    """Turn a group's series into Phase-3-ready anomaly records for periods flagged as anomalies."""
    out = []
    scope_key = f"{district or 'all'}:{ward_id or 'all'}:{crime_type or 'all'}"
    label = crime_type or "Crime"
    where = ward_name or district or "selected area"
    for entry in group_result["series"]:
        if not entry["is_anomaly"]:
            continue
        spike = entry["direction"] == "spike"
        pct = entry["percentage_change"]
        pct_txt = f"{pct:+.0f}%" if pct is not None else "a new pattern"
        out.append({
            "id": f"{granularity}:{scope_key}:{entry['period']}",
            "period": entry["period"],
            "district": district,
            "ward": ward_name,
            "ward_id": ward_id,
            "crime_type": crime_type,
            "severity": entry["severity"],
            "direction": entry["direction"],
            "title": f"{label} {'spike' if spike else 'drop'} in {where}",
            "description": (
                f"Observed {entry['count']} vs expected "
                f"{entry['lower_bound']:.0f}–{entry['upper_bound']:.0f} ({pct_txt} baseline)."
            ),
            "observed_value": entry["count"],
            "expected_value": entry["baseline"],
            "expected_range": {"lower": entry["lower_bound"], "upper": entry["upper_bound"]},
            "deviation": round(entry["count"] - entry["baseline"], 2) if entry["baseline"] is not None else None,
            "percentage_change": pct,
            "anomaly_score": round(entry["anomaly_score"], 2) if entry["anomaly_score"] is not None else None,
        })
    return out


# ═══════════════════════════════════════════════════════════════════════════
#  Breakdown (multi-level) analysis — ward / crime_type / combo
# ═══════════════════════════════════════════════════════════════════════════

def _breakdown_groups(df: pd.DataFrame, ward_id, crime_type, ward_name_map, granularity, date_from, date_to,
                       district):
    """
    When ward and/or crime_type aren't already pinned down, run the same
    pipeline per-ward and/or per-crime_type (and per combo, when neither is
    pinned) to surface the most "interesting" breakdown for Top Emerging
    Trends and the anomaly list. Groups thinner than MIN_GROUP_INCIDENTS are
    skipped as not statistically meaningful.
    """
    anomalies = []
    trend_candidates = []  # sustained trends, for Top Emerging Trends

    def run_one(sub_df, g_ward_id, g_crime_type):
        if len(sub_df) < MIN_GROUP_INCIDENTS:
            return
        result = _analyze_group(sub_df["timestamp"], granularity, date_from, date_to)
        if result is None:
            return
        g_ward_name = ward_name_map.get(g_ward_id) if g_ward_id is not None else None
        anomalies.extend(_anomaly_records(result, granularity, district, g_ward_name, g_ward_id, g_crime_type))
        if result["sustained_trend"].get("detected"):
            trend_candidates.append({
                "kind": "sustained",
                "ward": g_ward_name,
                "ward_id": g_ward_id,
                "crime_type": g_crime_type,
                "current_period": result["summary"]["current_period"],
                **result["sustained_trend"],
            })

    if ward_id is None:
        for wid, sub in df.groupby("ward_id"):
            # groupby on an integer column yields numpy.int64 keys, which
            # FastAPI's jsonable_encoder cannot serialize on its own — cast
            # to a plain Python int right at the source.
            run_one(sub, int(wid), crime_type)
    if crime_type is None:
        for ct, sub in df.groupby("crime_type"):
            run_one(sub, ward_id, ct)
    if ward_id is None and crime_type is None:
        for (wid, ct), sub in df.groupby(["ward_id", "crime_type"]):
            run_one(sub, int(wid), ct)

    return anomalies, trend_candidates


# ═══════════════════════════════════════════════════════════════════════════
#  Insights — plain-language, purely computed (no LLM)
# ═══════════════════════════════════════════════════════════════════════════

def _build_insights(label: str, granularity: str, main_result: dict, main_anomalies: list,
                     breakdown_anomalies: list, ward_share: tuple | None) -> list[str]:
    noun = _GRANULARITY_NOUN[granularity]
    insights = []

    sustained = main_result["sustained_trend"]
    if sustained.get("detected"):
        verb = "increased" if sustained["direction"] == "rising" else "decreased"
        insights.append(f"{label} has {verb} for {sustained['periods']} consecutive {noun}.")

    # Most severe single-period anomaly in the main scope, described via its z-score.
    scored = [a for a in main_anomalies if a["anomaly_score"] is not None]
    if scored:
        top = max(scored, key=lambda a: a["anomaly_score"])
        above_below = "above" if top["direction"] == "spike" else "below"
        insights.append(
            f"Current {label} volume is {top['anomaly_score']:.1f} standard deviations {above_below} "
            f"its historical baseline."
        )

    if ward_share and ward_share[1] >= MIN_WARD_SHARE_PCT:
        ward_name, share_pct = ward_share
        insights.append(f"{ward_name} accounts for {share_pct:.0f}% of the area's increase this {noun[:-1]}.")

    if not sustained.get("detected") and not scored:
        insights.append(f"{label} remains within its expected historical range.")

    return insights


def _ward_contribution(df: pd.DataFrame, ward_name_map: dict, granularity: str, date_to, district_delta: float):
    """Which ward contributed the most to this period's increase, as a (name, pct) tuple or None."""
    if district_delta <= 0:
        return None
    best = None
    for wid, sub in df.groupby("ward_id"):
        if len(sub) < MIN_GROUP_INCIDENTS:
            continue
        result = _analyze_group(sub["timestamp"], granularity, None, date_to)
        if result is None:
            continue
        cur = result["summary"]["current_value"]
        prev = result["summary"]["previous_value"] or 0
        delta = cur - prev
        if delta > 0 and (best is None or delta > best[1]):
            best = (ward_name_map.get(wid, f"Ward {wid}"), delta)
    if best is None:
        return None
    share = min(100.0, (best[1] / district_delta) * 100.0)
    return (best[0], share)


# ═══════════════════════════════════════════════════════════════════════════
#  Public entry point
# ═══════════════════════════════════════════════════════════════════════════

def analyze_trends(
    db: Session,
    district: str | None = None,
    ward_id: int | None = None,
    crime_type: str | None = None,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    granularity: str = DEFAULT_GRANULARITY,
) -> dict:
    granularity = granularity if granularity in GRANULARITIES else DEFAULT_GRANULARITY

    df = _load_scope(db, district, ward_id, crime_type)
    params = {
        "district": district, "ward_id": ward_id, "crime_type": crime_type,
        "granularity": granularity,
        "date_from": date_from.isoformat() if date_from else None,
        "date_to": date_to.isoformat() if date_to else None,
    }

    if df.empty:
        return {
            "status": "no_data",
            "params": params,
            "summary": None, "series": [], "anomalies": [], "sustained_trend": {"detected": False},
            "top_emerging_trends": [], "insights": ["No incidents match the current filters."],
            "baseline_config": _baseline_config(),
        }

    main_result = _analyze_group(df["timestamp"], granularity, date_from, date_to)
    if main_result is None or main_result["periods_with_baseline"] == 0:
        # We have incidents, but not enough historical periods to judge
        # normality — an explicit "we can't tell" state, distinct from "normal".
        status = "insufficient_data"
    else:
        status = "ok"

    ward_map = {w.id: w.name for w in db.query(Ward).all()}
    ward_name = ward_map.get(ward_id) if ward_id is not None else None
    label = " ".join(filter(None, [crime_type, ward_name or district])) or "Overall crime"

    main_anomalies = _anomaly_records(main_result, granularity, district, ward_name, ward_id, crime_type)

    breakdown_anomalies, sustained_candidates = [], []
    if status == "ok":
        breakdown_anomalies, sustained_candidates = _breakdown_groups(
            df, ward_id, crime_type, ward_map, granularity, date_from, date_to, district,
        )

    all_anomalies = main_anomalies + breakdown_anomalies
    all_anomalies.sort(key=lambda a: (SEVERITY_RANK.get(a["severity"], 0), a["anomaly_score"] or 0), reverse=True)
    all_anomalies = all_anomalies[:MAX_ANOMALIES_RETURNED]

    # Top Emerging Trends: breakdown anomalies + sustained-trend groups, ranked.
    top_trends = []
    for a in breakdown_anomalies:
        top_trends.append({
            "kind": "anomaly",
            "label": a["crime_type"] or a["ward"] or label,
            "ward": a["ward"], "ward_id": a["ward_id"], "crime_type": a["crime_type"],
            "change_percent": a["percentage_change"],
            "severity": a["severity"], "anomaly_score": a["anomaly_score"],
            "detected_period": a["period"],
        })
    for t in sustained_candidates:
        top_trends.append({
            "kind": "sustained",
            "label": t["crime_type"] or t["ward"] or label,
            "ward": t["ward"], "ward_id": t["ward_id"], "crime_type": t["crime_type"],
            "change_percent": t["change_percent"],
            "severity": None, "anomaly_score": None,
            "periods": t["periods"], "direction": t["direction"],
            "detected_period": t["current_period"],
        })
    top_trends.sort(key=lambda t: abs(t["change_percent"]) if t["change_percent"] is not None else 0, reverse=True)
    top_trends = top_trends[:TOP_EMERGING_LIMIT]
    for i, t in enumerate(top_trends, start=1):
        t["rank"] = i

    ward_share = None
    if ward_id is None and status == "ok":
        district_delta = (main_result["summary"]["current_value"] or 0) - (main_result["summary"]["previous_value"] or 0)
        ward_share = _ward_contribution(df, ward_map, granularity, date_to, district_delta)

    insights = (
        ["Insufficient historical data for anomaly detection."]
        if status == "insufficient_data"
        else _build_insights(label, granularity, main_result, main_anomalies, breakdown_anomalies, ward_share)
    )

    return {
        "status": status,
        "params": params,
        "summary": main_result["summary"],
        "series": main_result["series"],
        "anomalies": all_anomalies,
        "sustained_trend": main_result["sustained_trend"],
        "top_emerging_trends": top_trends,
        "insights": insights,
        "baseline_config": _baseline_config(),
    }


def _baseline_config() -> dict:
    return {
        "method": "rolling mean/std of preceding periods (z-score)",
        "lookback_periods": BASELINE_LOOKBACK_PERIODS,
        "min_baseline_periods": MIN_BASELINE_PERIODS,
        "expected_range_multiplier": EXPECTED_RANGE_MULT,
        "severity_thresholds": {label: cutoff for cutoff, label in ANOMALY_SEVERITY_THRESHOLDS},
        "sparse_count_calibration": {
            "baseline_max": LOW_VOLUME_BASELINE_MAX,
            "minimum_absolute_delta_for_uncapped_severity": LOW_VOLUME_MIN_ABSOLUTE_DELTA,
            "severity_cap_below_delta": LOW_VOLUME_MAX_SEVERITY,
        },
    }
