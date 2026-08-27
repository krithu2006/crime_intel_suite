"""
Crime Intel Suite — Module 3b: Temporal Crime Prediction (Future Risk)

This is a genuine *forecast*, not a snapshot index. The older Module 3
(`risk_scoring.py`) scores the CURRENT window: it builds features from the
selected date range and fits a target that is itself derived from that same
window, then predicts on the same rows it trained on (in-sample). That is a
descriptive risk index — useful for "how does this ward look right now" —
but it cannot answer "what happens next," and training/predicting on the
same rows has no temporal generalization guarantee.

This module instead builds many (ward, anchor_date) training examples of the
form:

    features from (anchor_date - LOOKBACK_DAYS, anchor_date]
        ->  target = incident count in (anchor_date, anchor_date + horizon_days]

by sliding `anchor_date` across each ward's history. The feature window and
the target window never overlap, and every feature is computed using only
data timestamped on or before `anchor_date` (repeat-offender status,
network-activity status, and the ward baseline rate are all evaluated "as of"
the anchor) — so there is no leakage from the future into the inputs.

Validation is a strict temporal split: the oldest anchor dates are used for
training, the newest for testing (never shuffled). The final production
model is then refit on the full dataset (train + test) to make live
predictions, which is standard practice once validation metrics are in hand.

Target choice: predicted incident COUNT over the horizon, converted to a
0-100 risk score by percentile rank against the historical target
distribution. A count is simpler to validate (MAE/RMSE mean something to a
judge) and easier to sanity-check than a synthetic composite score, and the
score conversion keeps the same 0-100 / low-moderate-high-critical scheme the
rest of the UI already uses.
"""

from __future__ import annotations

import numpy as np
from collections import defaultdict
from datetime import datetime, timedelta
from sqlalchemy.orm import Session
from sqlalchemy import select

from .models import Incident, Ward, DistrictSocioEconomic, incident_accused
from .analytics import MINOR_CRIME_TYPES

# ── Tunables ──
LOOKBACK_DAYS = 60                 # historical input window
STEP_DAYS = 3                       # spacing between sliding training anchors
MIN_LOOKBACK_INCIDENTS = 3          # below this, a window is too thin to trust
# The demo dataset is ~90 days and split across many districts. Twelve rows
# still leaves a chronological holdout (normally 9 train / 3 test) while
# allowing a supported 14-day district forecast; narrower/30-day scopes can
# and should still return insufficient data.
MIN_TRAINING_SAMPLES = 12
TEST_FRACTION = 0.2                 # most-recent slice of anchors held out for testing
TOP_K_PRECISION = 5                 # Precision@Top-K highest-risk wards

VALID_HORIZONS = (7, 14, 30)
DEFAULT_HORIZON = 14

FEATURE_NAMES = [
    "incidents_7d",
    "incidents_30d",
    "incidents_60d",
    "incident_trend_pct",
    "avg_severity",
    "high_severity_ratio",
    "offender_count",
    "repeat_offender_count",
    "repeat_offender_ratio",
    "network_linked_offenders",
    "minor_crime_escalation_pct",
    "hotspot_persistence_weeks",
    "top_crime_type_share",
    "ward_baseline_incidents",
    "literacy_rate",
    "unemployment_rate",
    "population_density",
]

FACTOR_LABELS = {
    "incidents_7d":               ("crime incidents rose in the last week", "crime incidents fell in the last week"),
    "incidents_30d":               ("elevated incident volume over the last month", "low incident volume over the last month"),
    "incidents_60d":               ("high incident volume over the last 60 days", "low incident volume over the last 60 days"),
    "incident_trend_pct":          ("crime incidents increased recently", "crime incidents declined recently"),
    "avg_severity":                ("severity increased above baseline", "severity below baseline"),
    "high_severity_ratio":         ("many high-severity incidents", "few high-severity incidents"),
    "offender_count":              ("elevated offender presence", "low offender presence"),
    "repeat_offender_count":       ("repeat offenders recently active", "few repeat offenders active"),
    "repeat_offender_ratio":       ("high repeat-offender density", "low repeat-offender density"),
    "network_linked_offenders":    ("offenders linked to active networks", "few network-linked offenders"),
    "minor_crime_escalation_pct":  ("minor-crime frequency escalating (early warning signal)", "minor-crime levels stable"),
    "hotspot_persistence_weeks":   ("persistent hotspot detected across multiple weeks", "no persistent hotspot pattern"),
    "top_crime_type_share":        ("crime concentrated in one dominant type", "crime spread across multiple types"),
    "ward_baseline_incidents":     ("ward has a high historical baseline rate", "ward has a low historical baseline rate"),
    "literacy_rate":               ("lower literacy in the area", "higher literacy in the area"),
    "unemployment_rate":           ("higher unemployment", "lower unemployment"),
    "population_density":          ("high population density", "low population density"),
}


# ═══════════════════════════════════════════════════════════════════════════
#  1. Load & index raw data for fast windowed feature computation
# ═══════════════════════════════════════════════════════════════════════════

def _load_scope(db: Session, district: str | None, crime_type: str | None):
    """
    Load all incidents/links for the requested district/crime_type scope
    (NOT date-filtered — history must extend past any UI date range so we
    have enough anchors to train on) and index them per-ward as sorted numpy
    arrays for O(log n) windowed lookups via searchsorted.
    """
    wards = db.query(Ward).all()
    if district:
        wards = [w for w in wards if w.district == district]
    ward_map = {w.id: w for w in wards}
    ward_ids = set(ward_map)

    se_map = {s.district: s for s in db.query(DistrictSocioEconomic).all()}

    inc_q = db.query(Incident)
    if district:
        inc_q = inc_q.filter(Incident.district == district)
    if crime_type:
        inc_q = inc_q.filter(Incident.crime_type == crime_type)
    incidents = [i for i in inc_q.all() if i.ward_id in ward_ids]

    if not incidents or not ward_map:
        return None

    inc_ids = {i.id for i in incidents}
    links = db.execute(
        select(incident_accused.c.incident_id, incident_accused.c.accused_id)
    ).fetchall()
    links = [(iid, aid) for iid, aid in links if iid in inc_ids]

    inc_accused = defaultdict(list)
    for iid, aid in links:
        inc_accused[iid].append(aid)

    inc_by_id = {i.id: i for i in incidents}
    accused_ts_list = defaultdict(list)
    accused_multi_ts_list = defaultdict(list)
    for iid, aids in inc_accused.items():
        ts = inc_by_id[iid].timestamp
        is_multi = len(aids) >= 2
        for aid in aids:
            accused_ts_list[aid].append(ts)
            if is_multi:
                accused_multi_ts_list[aid].append(ts)

    accused_all_ts = {aid: np.array(sorted(v), dtype="datetime64[ns]") for aid, v in accused_ts_list.items()}
    accused_multi_ts = {aid: np.array(sorted(v), dtype="datetime64[ns]") for aid, v in accused_multi_ts_list.items()}

    ward_incidents = defaultdict(list)
    for inc in incidents:
        ward_incidents[inc.ward_id].append(inc)

    ward_series = {}
    for wid, incs in ward_incidents.items():
        incs_sorted = sorted(incs, key=lambda x: x.timestamp)
        ts_arr = np.array([i.timestamp for i in incs_sorted], dtype="datetime64[ns]")
        sev_arr = np.array([i.severity for i in incs_sorted], dtype=float)
        crime_arr = np.array([i.crime_type for i in incs_sorted])
        ids_list = [i.id for i in incs_sorted]
        minor_mask = np.array([c in MINOR_CRIME_TYPES for c in crime_arr])
        ward_series[wid] = {
            "ts": ts_arr,
            "sev": sev_arr,
            "crime": crime_arr,
            "ids": ids_list,
            "minor_ts": ts_arr[minor_mask],
        }

    global_max_ts = max(i.timestamp for i in incidents)
    global_min_ts = min(i.timestamp for i in incidents)

    return {
        "ward_map": ward_map,
        "se_map": se_map,
        "ward_series": ward_series,
        "inc_accused": inc_accused,
        "accused_all_ts": accused_all_ts,
        "accused_multi_ts": accused_multi_ts,
        "global_max_ts": global_max_ts,
        "global_min_ts": global_min_ts,
    }


# ═══════════════════════════════════════════════════════════════════════════
#  2. Feature row for one (ward, anchor_date)
# ═══════════════════════════════════════════════════════════════════════════

def _feature_row(ward_id: int, anchor: datetime, data: dict, horizon_days: int, want_target: bool):
    """
    Build one feature row for `ward_id` as of `anchor`, using only data
    timestamped <= anchor (features) and, if `want_target`, the incident
    count strictly after anchor through anchor+horizon_days (target).
    Returns (features_dict, target_or_None) or None if there isn't enough
    history in the lookback window to trust this row.
    """
    s = data["ward_series"].get(ward_id)
    if s is None or len(s["ts"]) == 0:
        return None

    ts = s["ts"]
    anchor64 = np.datetime64(anchor)
    start_excl = np.datetime64(anchor - timedelta(days=LOOKBACK_DAYS))

    idx_start = int(np.searchsorted(ts, start_excl, side="right"))
    idx_end = int(np.searchsorted(ts, anchor64, side="right"))
    n_window = idx_end - idx_start
    if n_window < MIN_LOOKBACK_INCIDENTS:
        return None

    window_ids = s["ids"][idx_start:idx_end]
    window_sev = s["sev"][idx_start:idx_end]
    window_crime = s["crime"][idx_start:idx_end]

    def count_since(days: int) -> int:
        start = np.datetime64(anchor - timedelta(days=days))
        i0 = int(np.searchsorted(ts, start, side="right"))
        return idx_end - i0

    c7 = count_since(7)
    c30 = count_since(30)
    c60 = n_window  # LOOKBACK_DAYS == 60

    # Trend: second half of the lookback window vs the first half.
    mid64 = np.datetime64(anchor - timedelta(days=LOOKBACK_DAYS / 2))
    idx_mid = int(np.searchsorted(ts, mid64, side="right"))
    first_half_n = idx_mid - idx_start
    second_half_n = idx_end - idx_mid
    trend_pct = ((second_half_n - first_half_n) / max(first_half_n, 1)) * 100.0

    avg_sev = float(window_sev.mean()) if n_window else 0.0
    high_sev_ratio = float((window_sev >= 7).sum()) / max(n_window, 1)

    # Offenders active in this ward/window, evaluated "as of" anchor so
    # repeat/network status never peeks at incidents after the anchor.
    offenders = set()
    for iid in window_ids:
        offenders.update(data["inc_accused"].get(iid, []))
    offender_count = len(offenders)
    repeat_count = 0
    network_active = 0
    for aid in offenders:
        ats = data["accused_all_ts"].get(aid)
        if ats is not None and int(np.searchsorted(ats, anchor64, side="right")) > 1:
            repeat_count += 1
        mts = data["accused_multi_ts"].get(aid)
        if mts is not None and int(np.searchsorted(mts, anchor64, side="right")) > 0:
            network_active += 1
    repeat_ratio = repeat_count / max(offender_count, 1)

    # Minor-crime escalation: growth in Dispute/Vandalism/Eve-Teasing
    # frequency over the last 14 days vs the 14 days before that — a leading
    # indicator, same crime set Module 2's escalation detector uses.
    minor_ts = s["minor_ts"]
    a14 = np.datetime64(anchor - timedelta(days=14))
    a28 = np.datetime64(anchor - timedelta(days=28))
    recent_minor = int(np.searchsorted(minor_ts, anchor64, side="right") - np.searchsorted(minor_ts, a14, side="right"))
    prior_minor = int(np.searchsorted(minor_ts, a14, side="right") - np.searchsorted(minor_ts, a28, side="right"))
    escalation_pct = ((recent_minor - prior_minor) / max(prior_minor, 1)) * 100.0

    # Hotspot persistence: distinct weeks within the lookback window that had
    # 2+ incidents (a spike-vs-sustained-pattern proxy). Full DBSCAN re-run
    # per training row would be far too slow across thousands of samples, so
    # this is a lightweight temporal stand-in for spatial persistence.
    if n_window:
        week_idx = ((ts[idx_start:idx_end] - ts[idx_start]) // np.timedelta64(1, "D")).astype(int) // 7
        _, week_counts = np.unique(week_idx, return_counts=True)
        persistence_weeks = int((week_counts >= 2).sum())
    else:
        persistence_weeks = 0

    if n_window:
        _, crime_counts = np.unique(window_crime, return_counts=True)
        top_crime_share = float(crime_counts.max()) / n_window
    else:
        top_crime_share = 0.0

    # Ward baseline: this ward's own average daily rate over ALL its history
    # up to (and including) the anchor, scaled to a 60-day window. Fully
    # causal — uses only data <= anchor, so it cannot leak the target.
    elapsed_days = max(int((anchor64 - ts[0]) / np.timedelta64(1, "D")), 1)
    ward_baseline = (idx_end / elapsed_days) * LOOKBACK_DAYS

    district = data["ward_map"][ward_id].district
    se = data["se_map"].get(district)
    literacy = se.literacy_rate if se else 85.0
    unemployment = se.unemployment_rate if se else 5.0
    density = se.population_density if se else 10000.0

    features = {
        "incidents_7d": float(c7),
        "incidents_30d": float(c30),
        "incidents_60d": float(c60),
        "incident_trend_pct": round(trend_pct, 2),
        "avg_severity": round(avg_sev, 2),
        "high_severity_ratio": round(high_sev_ratio, 3),
        "offender_count": float(offender_count),
        "repeat_offender_count": float(repeat_count),
        "repeat_offender_ratio": round(repeat_ratio, 3),
        "network_linked_offenders": float(network_active),
        "minor_crime_escalation_pct": round(escalation_pct, 2),
        "hotspot_persistence_weeks": float(persistence_weeks),
        "top_crime_type_share": round(top_crime_share, 3),
        "ward_baseline_incidents": round(ward_baseline, 2),
        "literacy_rate": literacy if literacy is not None else 85.0,
        "unemployment_rate": unemployment if unemployment is not None else 5.0,
        "population_density": density if density is not None else 10000.0,
    }

    target = None
    if want_target:
        h_end = np.datetime64(anchor + timedelta(days=horizon_days))
        idx_h = int(np.searchsorted(ts, h_end, side="right"))
        target = idx_h - idx_end  # strictly after anchor, so no overlap with features

    return features, target


# ═══════════════════════════════════════════════════════════════════════════
#  3. Build the training set by sliding anchors across each ward's history
# ═══════════════════════════════════════════════════════════════════════════

def _build_training_set(data: dict, horizon_days: int):
    """
    Slide an anchor date across each ward's history, generating one training
    row per (ward, anchor). Anchors only run up to (global_max_ts -
    horizon_days) so every target window is fully observed — never a
    prediction disguised as a training label.
    """
    global_max = data["global_max_ts"]
    last_usable_anchor = global_max - timedelta(days=horizon_days)

    rows = []
    for wid, s in data["ward_series"].items():
        if len(s["ts"]) == 0:
            continue
        ward_start = s["ts"][0].astype("M8[s]").astype(datetime)
        first_anchor = ward_start + timedelta(days=LOOKBACK_DAYS)
        if first_anchor > last_usable_anchor:
            continue

        anchor = first_anchor
        while anchor <= last_usable_anchor:
            result = _feature_row(wid, anchor, data, horizon_days, want_target=True)
            if result is not None:
                features, target = result
                rows.append({"ward_id": wid, "anchor": anchor, "target": target, **features})
            anchor += timedelta(days=STEP_DAYS)

    return rows


# ═══════════════════════════════════════════════════════════════════════════
#  4. Train, validate (temporal split), and predict
# ═══════════════════════════════════════════════════════════════════════════

def _make_model():
    try:
        import xgboost as xgb
        return xgb.XGBRegressor(
            n_estimators=150, max_depth=4, learning_rate=0.08,
            subsample=0.8, colsample_bytree=0.8,
            reg_alpha=0.1, reg_lambda=1.0, random_state=42, verbosity=0,
        ), "XGBoost"
    except ImportError:
        from sklearn.ensemble import GradientBoostingRegressor
        return GradientBoostingRegressor(
            n_estimators=150, max_depth=4, learning_rate=0.08, random_state=42,
        ), "GradientBoosting"


def _risk_level(score: float) -> str:
    if score >= 75:
        return "critical"
    if score >= 50:
        return "high"
    if score >= 25:
        return "moderate"
    return "low"


def _precision_at_top_k(rows_df, preds, k=TOP_K_PRECISION):
    """
    Precision@Top-K: for each distinct test anchor date, rank wards by
    predicted incident count and by actual incident count, and measure the
    overlap of the top-K in each ranking. Averaged across anchor dates.
    """
    import pandas as pd
    tmp = rows_df.copy()
    tmp["pred"] = preds
    precisions = []
    for _, group in tmp.groupby("anchor"):
        if len(group) < 2:
            continue
        kk = min(k, len(group))
        actual_top = set(group.sort_values("target", ascending=False).head(kk)["ward_id"])
        pred_top = set(group.sort_values("pred", ascending=False).head(kk)["ward_id"])
        precisions.append(len(actual_top & pred_top) / kk)
    return float(np.mean(precisions)) if precisions else None


def _train_and_validate(rows: list, horizon_days: int):
    """
    Temporal train/test split (oldest anchors -> train, newest -> test),
    compute real validation metrics, then refit on all data for production
    predictions. Returns (final_model, model_kind, X_train_full, performance_dict,
    target_distribution).
    """
    import pandas as pd

    n = len(rows)
    if n < MIN_TRAINING_SAMPLES:
        return None, None, None, {
            "status": "insufficient_data",
            "message": "Not enough historical training examples to validate a prediction model for this selection.",
            "n_train_samples": 0,
            "n_test_samples": 0,
        }, None

    df = pd.DataFrame(rows).sort_values("anchor").reset_index(drop=True)

    split_idx = int(n * (1 - TEST_FRACTION))
    split_idx = max(min(split_idx, n - 1), 1)  # ensure both splits non-empty
    train_df = df.iloc[:split_idx]
    test_df = df.iloc[split_idx:]

    X_train = train_df[FEATURE_NAMES].values
    y_train = train_df["target"].values.astype(float)
    X_test = test_df[FEATURE_NAMES].values
    y_test = test_df["target"].values.astype(float)

    val_model, model_kind = _make_model()
    val_model.fit(X_train, y_train)
    preds_test = np.clip(val_model.predict(X_test), 0, None)

    mae = float(np.mean(np.abs(preds_test - y_test)))
    rmse = float(np.sqrt(np.mean((preds_test - y_test) ** 2)))
    ss_res = float(np.sum((y_test - preds_test) ** 2))
    ss_tot = float(np.sum((y_test - y_test.mean()) ** 2))
    r2 = (1 - ss_res / ss_tot) if ss_tot > 1e-9 else None

    precision_topk = _precision_at_top_k(test_df, preds_test)

    performance = {
        "status": "ok",
        "algorithm": model_kind,
        "mae": round(mae, 2),
        "rmse": round(rmse, 2),
        "r2": round(r2, 3) if r2 is not None else None,
        "precision_at_topk": round(precision_topk, 3) if precision_topk is not None else None,
        "top_k": TOP_K_PRECISION,
        "n_train_samples": int(len(train_df)),
        "n_test_samples": int(len(test_df)),
        "training_period": {
            "from": train_df["anchor"].min().date().isoformat(),
            "to": train_df["anchor"].max().date().isoformat(),
        },
        "test_period": {
            "from": test_df["anchor"].min().date().isoformat(),
            "to": test_df["anchor"].max().date().isoformat(),
        },
        "last_trained": datetime.utcnow().isoformat(),
        "prediction_horizon_days": horizon_days,
        "lookback_days": LOOKBACK_DAYS,
    }

    # Refit on everything for the live/production model used to score wards now.
    X_full = df[FEATURE_NAMES].values
    y_full = df["target"].values.astype(float)
    final_model, _ = _make_model()
    final_model.fit(X_full, y_full)

    return final_model, model_kind, X_full, performance, y_full


# ═══════════════════════════════════════════════════════════════════════════
#  5. Explainability (SHAP if available, else feature-importance fallback)
# ═══════════════════════════════════════════════════════════════════════════

def _top_factors(model, X_full, x_row, feature_names=FEATURE_NAMES, top_n=4):
    try:
        # Force Exception to bypass SHAP TreeExplainer hangs on Windows/scikit-learn
        raise Exception("SHAP disabled")
        import shap
        explainer = shap.TreeExplainer(model)
        contributions = explainer.shap_values(x_row.reshape(1, -1))[0]
    except Exception:
        importances = np.asarray(getattr(model, "feature_importances_", np.ones(len(feature_names))), dtype=float)
        means = X_full.mean(axis=0)
        stds = X_full.std(axis=0)
        stds[stds < 1e-9] = 1.0
        contributions = ((x_row - means) / stds) * importances

    abs_c = np.abs(contributions)
    total = float(np.sum(abs_c)) or 1.0
    order = np.argsort(abs_c)[::-1][:top_n]

    factors = []
    for idx in order:
        name = feature_names[idx]
        contrib = float(contributions[idx])
        pos_label, neg_label = FACTOR_LABELS.get(name, (name, name))
        pct = round((abs(contrib) / total) * 100, 1)
        impact = "high" if pct >= 30 else "medium" if pct >= 12 else "low"
        factors.append({
            "feature": name,
            "label": pos_label if contrib > 0 else neg_label,
            "direction": "up" if contrib > 0 else "down",
            "impact": impact,
            "contribution_pct": pct,
        })
    return factors


# ═══════════════════════════════════════════════════════════════════════════
#  6. Public entry point
# ═══════════════════════════════════════════════════════════════════════════

def predict_risk(
    db: Session,
    district: str | None = None,
    ward_id: int | None = None,
    crime_type: str | None = None,
    horizon_days: int = DEFAULT_HORIZON,
    as_of: datetime | None = None,
) -> dict:
    """
    Predict ward-level crime risk for the next `horizon_days`.

    `as_of` is the anchor date the prediction is made from — the UI's
    selected date-range end, or (if not given) the latest timestamp in the
    scoped dataset. It is never a hard-coded date, so this stays correct as
    new data is imported.
    """
    horizon_days = horizon_days if horizon_days in VALID_HORIZONS else DEFAULT_HORIZON

    data = _load_scope(db, district, crime_type)
    if data is None:
        return {
            "predictions": [],
            "model_performance": {"status": "insufficient_data", "message": "No data available for this selection."},
            "params": {"district": district, "crime_type": crime_type, "prediction_horizon_days": horizon_days},
        }

    live_anchor = min(as_of, data["global_max_ts"]) if as_of else data["global_max_ts"]

    rows = _build_training_set(data, horizon_days)
    model, model_kind, X_full, performance, y_full = _train_and_validate(rows, horizon_days)

    target_ward_ids = [ward_id] if ward_id is not None else sorted(data["ward_map"].keys())

    predictions = []
    for wid in target_ward_ids:
        ward = data["ward_map"].get(wid)
        if ward is None:
            continue

        base = {
            "ward_id": wid,
            "ward_name": ward.name,
            "district": ward.district,
            "lat": ward.lat,
            "lng": ward.lng,
            "prediction_horizon_days": horizon_days,
        }

        row = _feature_row(wid, live_anchor, data, horizon_days, want_target=False)
        if row is None or model is None:
            predictions.append({
                **base,
                "insufficient_data": True,
                "message": "Insufficient historical data for reliable prediction.",
                "risk_score": None,
                "risk_level": None,
                "predicted_incidents": None,
                "confidence": None,
                "trend": None,
                "top_factors": [],
                "explanation": None,
            })
            continue

        features, _ = row
        x_row = np.array([features[f] for f in FEATURE_NAMES], dtype=float)
        predicted_incidents = float(max(model.predict(x_row.reshape(1, -1))[0], 0.0))

        # Risk score = percentile rank of the predicted count against the
        # historical distribution of real observed targets for this scope.
        rank = float(np.searchsorted(np.sort(y_full), predicted_incidents, side="right"))
        risk_score = round(min(max((rank / len(y_full)) * 100.0, 0.0), 100.0), 1)
        risk_level = _risk_level(risk_score)

        # Confidence: combines validation error (relative to the typical
        # target magnitude) with how much lookback history this ward
        # actually has — a heuristic, not a calibrated probability, but it
        # is computed from real numbers rather than hard-coded.
        mean_target = float(np.mean(y_full)) if len(y_full) else 0.0
        rel_error = (performance.get("rmse", 0.0) or 0.0) / max(mean_target, 1.0)
        error_component = float(np.clip(1.0 - rel_error, 0.2, 0.95))
        data_component = float(np.clip(features["incidents_60d"] / (MIN_LOOKBACK_INCIDENTS * 4), 0.3, 1.0))
        confidence = round(float(np.clip(0.5 * error_component + 0.5 * data_component, 0.15, 0.95)), 2)

        # Trend: predicted rate vs. the ward's own causal baseline rate,
        # both scaled to the same horizon length for a fair comparison.
        baseline_horizon = features["ward_baseline_incidents"] * (horizon_days / LOOKBACK_DAYS)
        if baseline_horizon <= 1e-6:
            trend = "rising" if predicted_incidents > 0 else "stable"
        elif predicted_incidents > baseline_horizon * 1.1:
            trend = "rising"
        elif predicted_incidents < baseline_horizon * 0.9:
            trend = "falling"
        else:
            trend = "stable"

        top_factors = _top_factors(model, X_full, x_row)
        explanation = _generate_explanation(ward.name, risk_level, horizon_days, top_factors)

        predictions.append({
            **base,
            "insufficient_data": False,
            "risk_score": risk_score,
            "risk_level": risk_level,
            "predicted_incidents": round(predicted_incidents, 1),
            "confidence": confidence,
            "trend": trend,
            "top_factors": top_factors,
            "explanation": explanation,
        })

    predictions.sort(key=lambda p: (p["risk_score"] if p["risk_score"] is not None else -1), reverse=True)

    return {
        "predictions": predictions,
        "model_performance": performance,
        "params": {
            "district": district,
            "crime_type": crime_type,
            "ward_id": ward_id,
            "prediction_horizon_days": horizon_days,
            "lookback_days": LOOKBACK_DAYS,
            "as_of": live_anchor.isoformat(),
        },
    }


def _generate_explanation(ward_name: str, risk_level: str, horizon_days: int, top_factors: list) -> str:
    level_labels = {"critical": "Critical", "high": "High", "moderate": "Moderate", "low": "Low"}
    prefix = f"{level_labels.get(risk_level, 'Moderate')} predicted risk in {ward_name} over the next {horizon_days} days"
    increasing = [f for f in top_factors if f["direction"] == "up"]
    if increasing:
        drivers = "; ".join(f["label"] for f in increasing[:3])
        return f"{prefix}, driven by {drivers}."
    return f"{prefix}."
