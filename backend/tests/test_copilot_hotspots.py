"""
Regression tests for the Copilot hotspot evidence path.

Bug being guarded against: detect_hotspots() returns every clustered incident
coordinate (~590KB for a global scope). That is far over _compact()'s size
limit, and _compact()'s generic truncation kept only whitelisted keys — none
of which were the hotspot counts — so the Copilot answered "0 active hotspot
clusters were detected from 0 incidents" while the Hotspots dashboard, reading
the same detect_hotspots() output via /api/hotspots, correctly showed 91
clusters from 2400 incidents.

These tests assert the Copilot's hotspot evidence agrees with detect_hotspots()
itself (the same function /api/hotspots returns), so the two can never silently
diverge again.
"""

import pytest

from app.analytics import detect_hotspots
from app.copilot import build_evidence_context, route_intent
from app.database import SessionLocal


@pytest.fixture(scope="module")
def db():
    session = SessionLocal()
    yield session
    session.close()


@pytest.fixture(scope="module")
def dashboard_global(db):
    """What the Hotspots workspace shows for the unfiltered/global scope."""
    return detect_hotspots(db)


def _hotspot_evidence(db, message, context=None):
    return build_evidence_context(db, message, context or {}).get("hotspots") or {}


HOTSPOT_QUESTIONS = [
    "Which districts currently have the most significant hotspots?",
    "Analyze the hotspots in Kalaburagi.",
    "Which hotspot has the highest risk score?",
    "What are the highest-risk hotspots?",
    "Show me the active hotspots.",
]


@pytest.mark.parametrize("question", HOTSPOT_QUESTIONS)
def test_hotspot_questions_route_to_hotspot_intent(question):
    """A hotspot noun must win over the generic "risk"/"where" keywords."""
    assert route_intent(question) == "HOTSPOT"


@pytest.mark.parametrize("question", HOTSPOT_QUESTIONS)
def test_hotspot_evidence_is_never_empty_when_data_exists(db, question, dashboard_global):
    """The core regression: never report zero while the scope really has hotspots."""
    if dashboard_global["n_clusters"] == 0:
        pytest.skip("no hotspots in the dataset at all; nothing to assert against")
    evidence = _hotspot_evidence(db, question)
    assert evidence.get("n_incidents", 0) > 0, f"lost incident count for: {question}"
    assert evidence.get("n_clusters", 0) > 0, f"lost cluster count for: {question}"


def test_global_evidence_matches_dashboard_exactly(db, dashboard_global):
    """Copilot and the Hotspots dashboard must report identical global numbers."""
    evidence = _hotspot_evidence(db, "Show me the active hotspots.")
    assert evidence["n_incidents"] == dashboard_global["n_incidents"]
    assert evidence["n_clusters"] == dashboard_global["n_clusters"]
    assert evidence["n_noise"] == dashboard_global["n_noise"]


def test_severity_breakdown_matches_dashboard(db, dashboard_global):
    """The high/medium/low split shown on the dashboard must survive compaction."""
    evidence = _hotspot_evidence(db, "Show me the active hotspots.")
    for level in ("High", "Medium", "Low"):
        expected = sum(1 for c in dashboard_global["clusters"] if c["severity_level"] == level)
        assert evidence["severity_breakdown"][level] == expected


def test_highest_risk_cluster_matches_dashboard(db, dashboard_global):
    """"Which hotspot has the highest risk score" must name the real top cluster."""
    if not dashboard_global["clusters"]:
        pytest.skip("no clusters to rank")
    expected_top = max(dashboard_global["clusters"], key=lambda c: c["risk_score"])
    evidence = _hotspot_evidence(db, "Which hotspot has the highest risk score?")
    actual_top = evidence["top_clusters"][0]
    assert actual_top["risk_score"] == expected_top["risk_score"]
    assert actual_top["district"] == expected_top["district"]


def test_district_scope_resolved_from_message(db):
    """"Analyze the hotspots in Kalaburagi" must scope to Kalaburagi, not global."""
    context_free = build_evidence_context(db, "Analyze the hotspots in Kalaburagi.", {})
    assert context_free["scope"]["district"] == "Kalaburagi"

    evidence = context_free.get("hotspots") or {}
    expected = detect_hotspots(db, district="Kalaburagi")
    assert evidence["n_incidents"] == expected["n_incidents"]
    assert evidence["n_clusters"] == expected["n_clusters"]


def test_district_scope_is_narrower_than_global(db, dashboard_global):
    """A district scope must actually filter, not silently fall back to global."""
    evidence = _hotspot_evidence(db, "Analyze the hotspots in Kalaburagi.")
    assert evidence["n_incidents"] < dashboard_global["n_incidents"]
    assert all(c["district"] == "Kalaburagi" for c in evidence["top_clusters"])


def test_genuinely_empty_scope_still_reports_zero(db):
    """The fix must not mask a real zero: an impossible date window has no hotspots."""
    context = {"date_from": "1990-01-01", "date_to": "1990-01-02"}
    evidence = _hotspot_evidence(db, "Show me the active hotspots.", context)
    assert evidence["n_incidents"] == 0
    assert evidence["n_clusters"] == 0
    assert evidence["top_clusters"] == []


def test_forecast_questions_still_route_to_risk():
    """Promoting hotspot nouns must not steal genuine prediction questions."""
    assert route_intent("Predict the crime risk for the next 30 days.") == "RISK"
    assert route_intent("Predict future hotspots.") == "RISK"
    assert route_intent("Which wards are high risk?") == "RISK"
