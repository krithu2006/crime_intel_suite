import json
import math
from datetime import datetime

from fastapi.encoders import jsonable_encoder

from app.database import SessionLocal
from app.trend_analysis import analyze_trends


DATE_FROM = datetime(2026, 5, 27)
DATE_TO = datetime(2026, 8, 24, 23, 59, 59)


def _trends(**kwargs):
    session = SessionLocal()
    try:
        return analyze_trends(
            session,
            date_from=DATE_FROM,
            date_to=DATE_TO,
            granularity="weekly",
            **kwargs,
        )
    finally:
        session.close()


def _assert_finite_or_none(value):
    if value is not None:
        assert isinstance(value, (int, float))
        assert math.isfinite(value)


def test_trend_summary_returns_current_previous_and_change_percent():
    data = _trends(district="Mysuru")
    summary = data["summary"]

    assert data["status"] == "ok"
    assert summary["current_value"] == 2
    assert summary["previous_value"] == 5
    assert summary["change_percent"] == -60.0
    assert summary["trend"] == "falling"


def test_emerging_trends_include_numeric_counts_and_percentages():
    data = _trends(district="Mysuru")
    trends = data["top_emerging_trends"]

    assert trends
    for item in trends:
        assert item["label"]
        _assert_finite_or_none(item["current_value"])
        _assert_finite_or_none(item["previous_value"])
        _assert_finite_or_none(item["baseline_value"])
        _assert_finite_or_none(item["change_percent"])
    assert any(item["change_percent"] is not None for item in trends)


def test_anomalies_include_observed_expected_and_percentage_change():
    data = _trends(district="Mysuru")
    anomalies = data["anomalies"]

    assert anomalies
    for item in anomalies:
        assert isinstance(item["observed_value"], int)
        _assert_finite_or_none(item["expected_value"])
        _assert_finite_or_none(item["percentage_change"])
        assert set(item["expected_range"]) == {"lower", "upper"}
        _assert_finite_or_none(item["expected_range"]["lower"])
        _assert_finite_or_none(item["expected_range"]["upper"])


def test_zero_previous_value_is_preserved_without_nan_or_infinity():
    session = SessionLocal()
    try:
        data = analyze_trends(
            session,
            district="Mysuru",
            date_from=DATE_FROM,
            date_to=DATE_TO,
            granularity="daily",
        )
    finally:
        session.close()

    summary = data["summary"]
    assert summary["current_value"] == 2
    assert summary["previous_value"] == 0
    assert summary["change_percent"] is None

    encoded = jsonable_encoder(data)
    payload = json.dumps(encoded, allow_nan=False)
    assert "NaN" not in payload
    assert "Infinity" not in payload
    assert "undefined" not in payload


def test_district_filter_changes_the_trend_scope():
    mysuru = _trends(district="Mysuru")["summary"]
    kalaburagi = _trends(district="Kalaburagi")["summary"]

    assert mysuru["current_value"] != kalaburagi["current_value"] or mysuru["previous_value"] != kalaburagi["previous_value"]


def test_crime_type_filter_changes_the_trend_scope():
    all_types = _trends(district="Mysuru")["summary"]
    theft = _trends(district="Mysuru", crime_type="Theft")["summary"]

    assert all_types["current_value"] != theft["current_value"] or all_types["previous_value"] != theft["previous_value"]
    assert theft["current_value"] == 2
    assert theft["previous_value"] == 2


def test_granularity_changes_the_comparison_period():
    session = SessionLocal()
    try:
        daily = analyze_trends(session, district="Mysuru", date_from=DATE_FROM, date_to=DATE_TO, granularity="daily")["summary"]
        weekly = analyze_trends(session, district="Mysuru", date_from=DATE_FROM, date_to=DATE_TO, granularity="weekly")["summary"]
        monthly = analyze_trends(session, district="Mysuru", date_from=DATE_FROM, date_to=DATE_TO, granularity="monthly")["summary"]
    finally:
        session.close()

    assert weekly["current_period"] != monthly["current_period"]
    assert daily["previous_value"] != weekly["previous_value"]
    assert weekly["current_value"] != monthly["current_value"]
    assert {daily["current_value"], weekly["current_value"], monthly["current_value"]} == {2, 26}


def test_trends_response_is_valid_json_without_non_finite_values():
    encoded = jsonable_encoder(_trends(district="Mysuru"))
    payload = json.dumps(encoded, allow_nan=False)

    assert "NaN" not in payload
    assert "Infinity" not in payload
    assert "undefined" not in payload
