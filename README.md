# Crime Intel Suite

AI-driven crime analytics platform for law enforcement — predicts crime
escalation before it peaks using hotspot detection, explainable risk scoring
(XGBoost + SHAP), and offender network analysis.

> While traditional systems show what already happened, Crime Intel Suite
> predicts where crime is escalating before it peaks, explains why in plain
> language, and highlights who's likely involved — turning fragmented crime
> records into actionable intelligence.

## Problem Statement

Current crime analytics systems rely on siloed data and manual reporting,
limiting advanced analytics and proactive policing capabilities. This project
addresses that gap with a modern AI-powered analytics platform that transforms
fragmented records into actionable intelligence.

## Key Features

| Feature | How it's implemented |
|---|---|
| Interactive dashboards & geospatial maps | React + Leaflet map with date-range and district filters |
| Crime hotspot detection | DBSCAN clustering, recomputed live per selected time window |
| District-level drilldowns | District selector with aggregated summary stats, drilling into ward-level detail |
| Trend alerts & anomaly detection | Rolling z-score on minor-crime frequency per ward — an early-warning signal before major incidents |
| Network & link analysis of criminals | NetworkX co-accused graph with centrality metrics and community detection |
| Repeat offender tracking | Per-individual profile with a Recency-Frequency-Severity concern score |
| Socio-economic crime correlation | District literacy, unemployment, and population density feed directly into the risk model |
| Predictive risk scoring | XGBoost model producing a 0–100 risk score per ward |
| AI/ML-based pattern detection | DBSCAN (spatial), rolling z-score (temporal), XGBoost (predictive), NetworkX (relational) |
| Explainable AI | SHAP values converted into plain-language explanations — no jargon shown to the user |

## Tech Stack

**Frontend:** React (Vite), Tailwind CSS, Leaflet.js, Recharts, react-force-graph
**Backend:** Python, FastAPI, SQLAlchemy
**Database:** SQLite
**ML/Data:** Pandas, NumPy, scikit-learn, XGBoost, SHAP, NetworkX

## Data

This prototype uses synthetic data modeled on realistic crime patterns
(incident locations, timestamps, crime types, severity, and co-accused
linkages), combined with publicly available socio-economic indicators. In a
production deployment, this would integrate with existing systems such as
CCTNS and e-FIR platforms rather than requiring new data collection.

## Getting Started

### One command
```bash
python run.py
```

This starts the FastAPI API on `http://localhost:8000` and the React dashboard
on `http://localhost:5173`. You can also run the same launcher with:

```bash
npm run dev
```

By default, the launcher generates a fresh **synthetic** Karnataka dataset on
each startup, then imports it into SQLite. To use your own CSV unchanged, set
`DATA_MODE=csv` in `backend/.env`; the launcher then validates and imports
`data/karnataka_crime.csv` on every startup, replacing the previous imported
dataset. Required columns are `district`, `crime_type`,
`timestamp` (ISO-8601), `latitude`, and `longitude`; optional columns are
`fir_number`, `ward`, `severity` (1-10), and `description`.

### Backend only
```bash
cd backend
pip install -r requirements.txt
python -m app.csv_import  # imports data/karnataka_crime.csv
python run.py         # starts the API on http://localhost:8000
```

To enable optional external-model explanations, create `backend/.env`, set
`OPENAI_API_KEY` and the compatible `OPENAI_BASE_URL`/`OPENAI_MODEL` values,
then restart the backend. The grounded deterministic fallback works without a
key. Never place the key in frontend environment variables.

### Frontend only
```bash
cd frontend
npm install
npm run dev           # starts the app on http://localhost:5173
```

### Verify
- `http://localhost:8000/api/health` — should return status and record counts
- `http://localhost:5173` — the dashboard, with Hotspot / Risk Score / Network views

## API Overview

| Endpoint | Description |
|---|---|
| `GET /api/health` | Health check + summary stats |
| `GET /api/incidents` | Paginated, filterable incident list |
| `GET /api/districts` | District socio-economic data |
| `GET /api/wards` | Ward centroids and metadata |
| `GET /api/hotspots` | DBSCAN hotspot clusters for a date range |
| `GET /api/escalation` | Minor-crime escalation scores per ward |
| `GET /api/risk-scores` | All wards ranked by predictive risk score |
| `GET /api/risk-score` | Single ward risk score with SHAP explanation |
| `GET /api/network` | Offender co-occurrence network graph |
| `GET /api/network/individual/{id}` | Individual profile, connections, and concern score |

### Intelligence endpoints

| Endpoint | Description |
|---|---|
| `GET /api/predictions/risk` | Temporal 7/14/30-day ward forecast |
| `GET /api/trends` | Historical trend and anomaly analysis |
| `GET /api/alerts` | Evidence-backed intelligence alerts |
| `PATCH /api/alerts/{id}` | Persist alert workflow status |
| `GET /api/drilldown/district/{district}` | District-to-ward intelligence overview |
| `GET /api/drilldown/ward/{ward_id}` | Ward intelligence and offender context |
| `GET /api/intelligence-brief` | Deterministic structured intelligence brief |
| `POST /api/copilot` | Grounded Intelligence Copilot Q&A |

## Architecture

```text
Crime Data → SQLite / SQLAlchemy
          → Analytics Engine
             ├─ DBSCAN hotspots
             ├─ Temporal predictive risk
             ├─ Rolling trend/anomaly detection
             ├─ NetworkX offender graph
             ├─ Repeat-offender tracking
             └─ Socio-economic contextual features
          → Intelligence Layer
             ├─ Alerts
             ├─ District/Ward drilldown
             ├─ Intelligence Brief
             └─ Grounded Intelligence Copilot
          → Analyst dashboard
```

## Running locally

```bash
python run.py
```

The default demo mode generates 2,400 reproducible synthetic incidents using
`DEMO_SEED=20260821`, imports them into SQLite, and starts the API and Vite
frontend. Use `DATA_MODE=csv` in `backend/.env` to use the supplied CSV instead.

Useful environment variables (names only):

- `DATA_MODE` — `demo` or `csv`
- `DEMO_SEED` — reproducible synthetic-demo seed
- `OPENAI_API_KEY` — optional server-side compatible LLM key
- `OPENAI_BASE_URL` — optional OpenAI-compatible endpoint
- `OPENAI_MODEL` — optional model name
- `CORS_ORIGINS` — comma-separated production frontend origins; defaults to `*` locally

## Responsible AI and model governance

This is decision-support software. Predictive risk is probabilistic, confidence
and model performance are displayed, and explanations use computed factors.
Trend signals describe historical activity; they do not establish causation.
Socio-economic indicators are contextual features and correlation does not imply
causation. The Copilot receives compact structured analytics, keeps numeric
evidence application-controlled, acknowledges insufficient data, and does not
make automated enforcement decisions.

## Recommended demo scenario

With the default seed, use `Tumakuru` as the primary district and select
`Tumakuru Demo Zone 2` (ward id `99`) from the District Intelligence ranking.
Keep the crime-type filter at **All Types**, use a 14-day horizon, and use the
weekly trend view; narrowing this ward to Theft alone correctly returns an
insufficient-data prediction. Use `Hassan` / `Hassan Demo Zone 3` (ward id
`10`) as the backup scope. Confirm the live 14-day availability after startup;
the 30-day horizon is intentionally often insufficient on the approximately
90-day dataset.

Suggested flow: District Intelligence → highest-priority ward → Why This Ward
Matters → Trends & Anomalies → Predictive Risk → Intelligence Alerts → Network →
Intelligence Brief → Intelligence Copilot.

## Judge Q&A notes

- **Leakage prevention:** prediction features use a past 60-day window and future non-overlapping targets with a chronological split.
- **Hotspots:** DBSCAN groups spatially close incident coordinates without requiring a fixed number of clusters.
- **Anomalies:** trends use rolling baselines from strictly preceding periods; sparse near-zero baselines are capped at Medium severity unless the absolute movement is sufficiently large.
- **Networks:** nodes are recorded accused identities and edges represent shared-case co-occurrence; connector labels describe graph connectivity, not guilt or leadership.
- **Socio-economic data:** density, literacy, and unemployment are contextual model features, not labels or causal proof.
- **AI grounding:** the Copilot routes questions to existing analytics and renders evidence separately from any LLM prose.
- **Operational decisions:** analysts must validate signals; the platform does not dispatch officers, arrest people, or make enforcement decisions.

## Disclaimer

All data in this prototype is synthetic and generated for demonstration
purposes only. It does not represent real individuals, incidents, or law
enforcement records.
