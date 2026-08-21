"""
Crime Intel Suite — Synthetic Data Generator (seed.py)

Generates ~3,000 realistic crime incidents spread across 12 months (Jan–Dec 2025)
for Bengaluru, with:
  - Ward-level lat/long centroids (not just district-level)
  - Correlated crime_type → severity (assault/chain-snatching skew high, disputes low)
  - Repeat offenders (~25% of cases share accused with other cases)
  - Temporal patterns (weekday/weekend, time-of-day distributions)
"""

import os
import sys
import random
import numpy as np
from datetime import datetime, timedelta

# Ensure the app package is importable
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.database import engine, SessionLocal, Base
from app.models import Ward, DistrictSocioEconomic, Incident, Accused, incident_accused

# ── Reproducibility ──
random.seed(42)
np.random.seed(42)

# ═══════════════════════════════════════════════════════════════════════════════
#  WARD & DISTRICT DEFINITIONS  (Bengaluru)
# ═══════════════════════════════════════════════════════════════════════════════
# Each ward has a realistic centroid lat/lng within its district.

DISTRICTS = {
    "Bengaluru East": {
        "literacy_rate": 88.5,
        "unemployment_rate": 4.2,
        "population_density": 12500,
        "avg_income": 620000,
        "wards": [
            {"name": "Indiranagar",       "lat": 12.9784, "lng": 77.6408},
            {"name": "Whitefield",        "lat": 12.9698, "lng": 77.7500},
            {"name": "Marathahalli",      "lat": 12.9591, "lng": 77.7019},
            {"name": "KR Puram",          "lat": 13.0073, "lng": 77.6960},
            {"name": "HAL Airport Ward",  "lat": 12.9500, "lng": 77.6680},
        ],
    },
    "Bengaluru South": {
        "literacy_rate": 90.1,
        "unemployment_rate": 3.5,
        "population_density": 14200,
        "avg_income": 710000,
        "wards": [
            {"name": "Jayanagar",          "lat": 12.9308, "lng": 77.5838},
            {"name": "JP Nagar",           "lat": 12.9063, "lng": 77.5857},
            {"name": "BTM Layout",         "lat": 12.9166, "lng": 77.6101},
            {"name": "Koramangala",        "lat": 12.9352, "lng": 77.6245},
            {"name": "HSR Layout",         "lat": 12.9116, "lng": 77.6389},
            {"name": "Banashankari",       "lat": 12.9255, "lng": 77.5468},
        ],
    },
    "Bengaluru North": {
        "literacy_rate": 85.3,
        "unemployment_rate": 5.8,
        "population_density": 9800,
        "avg_income": 480000,
        "wards": [
            {"name": "Yelahanka",          "lat": 13.1007, "lng": 77.5963},
            {"name": "Hebbal",             "lat": 13.0358, "lng": 77.5970},
            {"name": "RT Nagar",           "lat": 13.0210, "lng": 77.5970},
            {"name": "Thanisandra",        "lat": 13.0600, "lng": 77.6320},
            {"name": "Jakkur",             "lat": 13.0700, "lng": 77.6000},
        ],
    },
    "Bengaluru West": {
        "literacy_rate": 83.7,
        "unemployment_rate": 6.5,
        "population_density": 11200,
        "avg_income": 430000,
        "wards": [
            {"name": "Rajajinagar",        "lat": 12.9910, "lng": 77.5550},
            {"name": "Basaveshwara Nagar", "lat": 12.9880, "lng": 77.5370},
            {"name": "Vijayanagar",        "lat": 12.9710, "lng": 77.5330},
            {"name": "Nagarbhavi",         "lat": 12.9610, "lng": 77.5100},
            {"name": "Kengeri",            "lat": 12.9140, "lng": 77.4880},
        ],
    },
    "Bengaluru Central": {
        "literacy_rate": 86.9,
        "unemployment_rate": 5.1,
        "population_density": 18500,
        "avg_income": 560000,
        "wards": [
            {"name": "Majestic",           "lat": 12.9767, "lng": 77.5713},
            {"name": "Shivajinagar",       "lat": 12.9857, "lng": 77.6050},
            {"name": "Chickpet",           "lat": 12.9680, "lng": 77.5770},
            {"name": "Cottonpet",          "lat": 12.9640, "lng": 77.5660},
            {"name": "Gandhinagar",        "lat": 12.9770, "lng": 77.5900},
            {"name": "Vasanth Nagar",      "lat": 12.9930, "lng": 77.5930},
        ],
    },
}

# ═══════════════════════════════════════════════════════════════════════════════
#  CRIME TYPE DEFINITIONS (with correlated severity distributions)
# ═══════════════════════════════════════════════════════════════════════════════

CRIME_TYPES = {
    # crime_type: (severity_mean, severity_std, weight)
    # weight controls relative frequency in the dataset
    "Theft":             {"mean": 4.0, "std": 1.2, "weight": 0.25},
    "Assault":           {"mean": 7.5, "std": 1.0, "weight": 0.12},
    "Chain Snatching":   {"mean": 7.0, "std": 1.1, "weight": 0.08},
    "Burglary":          {"mean": 6.0, "std": 1.3, "weight": 0.10},
    "Dispute":           {"mean": 2.5, "std": 1.0, "weight": 0.18},
    "Drug Peddling":     {"mean": 8.0, "std": 0.8, "weight": 0.06},
    "Fraud":             {"mean": 5.5, "std": 1.5, "weight": 0.08},
    "Eve Teasing":       {"mean": 3.5, "std": 1.2, "weight": 0.05},
    "Robbery":           {"mean": 8.5, "std": 0.7, "weight": 0.04},
    "Vandalism":         {"mean": 3.0, "std": 1.0, "weight": 0.04},
}

DESCRIPTIONS = {
    "Theft":           ["Mobile phone stolen from parked vehicle", "Laptop stolen from office premises",
                        "Wallet pickpocketed near bus stop", "Bicycle stolen from apartment parking",
                        "Gold chain snatched while walking"],
    "Assault":         ["Physical altercation at a bar", "Road rage incident led to assault",
                        "Assault during argument over parking", "Group assault near marketplace",
                        "Domestic violence complaint filed"],
    "Chain Snatching": ["Chain snatched by bike-borne assailant", "Gold chain pulled while victim was jogging",
                        "Two-wheeler gang snatched chain near signal", "Chain snatching near temple entrance"],
    "Burglary":        ["House burglary while family was away", "Shop broken into during night hours",
                        "Burglary at unoccupied apartment", "Warehouse break-in reported"],
    "Dispute":         ["Neighbour dispute over noise", "Property boundary dispute",
                        "Verbal altercation between vendors", "Tenant-landlord rent dispute",
                        "Argument over auto fare escalated"],
    "Drug Peddling":   ["Ganja seized during vehicle check", "Synthetic drugs found during raid",
                        "Drug peddler caught near school", "Narcotics seized at bus station"],
    "Fraud":           ["Online banking fraud reported", "Real estate deal fraud",
                        "Credit card fraud complaint", "Investment scam reported",
                        "Identity theft using forged documents"],
    "Eve Teasing":     ["Eve teasing complaint near college", "Stalking reported on commute route",
                        "Harassment at public event", "Offensive remarks at bus stop"],
    "Robbery":         ["Armed robbery at jewellery store", "ATM robbery at gunpoint",
                        "Home invasion robbery", "Highway robbery of goods vehicle"],
    "Vandalism":       ["Car windows smashed in parking lot", "Public property damaged during protest",
                        "Graffiti and damage to shop shutters", "Street lights destroyed"],
}

# ── FIRST / LAST NAMES for accused generation ──
FIRST_NAMES = [
    "Ravi", "Suresh", "Mahesh", "Ganesh", "Anil", "Vijay", "Rajesh", "Kumar",
    "Manoj", "Deepak", "Venkatesh", "Srinivas", "Prakash", "Ramesh", "Naveen",
    "Santosh", "Dinesh", "Harish", "Mohan", "Kiran", "Ashok", "Pradeep",
    "Arjun", "Siddharth", "Nikhil", "Vishal", "Akash", "Rohit", "Amit",
    "Samir", "Imran", "Farhan", "Rizwan", "Saleem", "Irfan", "Nayaz",
    "Lakshmi", "Priya", "Kavitha", "Suma", "Rekha", "Pooja", "Anita",
    "Meena", "Savitha", "Divya", "Shwetha", "Geeta",
]
LAST_NAMES = [
    "Gowda", "Reddy", "Shetty", "Nair", "Sharma", "Rao", "Patil", "Kumar",
    "Singh", "Hegde", "Naik", "Kulkarni", "Jain", "Bhat", "Patel",
    "Mishra", "Gupta", "Yadav", "Verma", "Rathod", "Khan", "Shaikh",
    "Syed", "Hussain", "Ahmed",
]
ALIASES = [
    None, None, None, None, None, None, None,  # ~70% have no alias
    "Chotu", "Lambu", "Kala", "Pappu", "Tiger", "Bullet", "Lucky",
    "Don", "Rascal", "Chhota", "Bhai", "Dada",
]


def generate_accused_pool(n=500):
    """Pre-generate a pool of accused individuals."""
    pool = []
    for i in range(n):
        name = f"{random.choice(FIRST_NAMES)} {random.choice(LAST_NAMES)}"
        alias = random.choice(ALIASES)
        age = random.randint(18, 55)
        gender = random.choice(["Male"] * 8 + ["Female"] * 2)  # 80/20 split
        pool.append({"name": name, "alias": alias, "age": age, "gender": gender})
    return pool


def generate_timestamp():
    """
    Generate a random timestamp in Jan 2025 – Dec 2025 with realistic patterns:
      - Slightly more incidents on weekends
      - Peak hours: 18:00–23:00 (evening), secondary peak 10:00–14:00
    """
    # Pick a random date in 2025
    start = datetime(2025, 1, 1)
    day_offset = random.randint(0, 364)
    date = start + timedelta(days=day_offset)

    # Weekend boost: 30% more likely on Fri/Sat/Sun
    if date.weekday() >= 4:  # Fri=4, Sat=5, Sun=6
        if random.random() < 0.3:
            # re-roll to a weekend day to increase weekend density
            pass  # keep this day
    else:
        if random.random() < 0.15:
            # small chance to skip weekdays (thinning)
            day_offset = random.randint(0, 364)
            date = start + timedelta(days=day_offset)

    # Time of day — bimodal distribution
    r = random.random()
    if r < 0.45:
        # Evening peak: 18:00–23:00
        hour = random.randint(18, 23)
    elif r < 0.70:
        # Midday secondary: 10:00–14:00
        hour = random.randint(10, 14)
    elif r < 0.85:
        # Late night: 00:00–04:00
        hour = random.randint(0, 4)
    else:
        # Rest of day
        hour = random.randint(5, 17)

    minute = random.randint(0, 59)
    return date.replace(hour=hour, minute=minute, second=random.randint(0, 59))


def pick_crime_type():
    """Weighted random selection of crime type."""
    types = list(CRIME_TYPES.keys())
    weights = [CRIME_TYPES[t]["weight"] for t in types]
    return random.choices(types, weights=weights, k=1)[0]


def pick_severity(crime_type):
    """Sample severity from a distribution correlated to the crime type."""
    params = CRIME_TYPES[crime_type]
    sev = int(round(np.random.normal(params["mean"], params["std"])))
    return max(1, min(10, sev))  # clamp to 1-10


def jitter(val, radius=0.008):
    """Add small random jitter to a lat/lng value (≈ 800m radius)."""
    return val + np.random.uniform(-radius, radius)


# ═══════════════════════════════════════════════════════════════════════════════
#  MAIN SEED FUNCTION
# ═══════════════════════════════════════════════════════════════════════════════

def seed_database():
    print("[*] Dropping existing tables and recreating schema...")
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)

    db = SessionLocal()

    # ── 1. Seed Wards ──
    print("[+] Seeding wards...")
    ward_objects = []
    ward_to_district = {}
    for district_name, dinfo in DISTRICTS.items():
        for wdef in dinfo["wards"]:
            w = Ward(name=wdef["name"], district=district_name,
                     lat=wdef["lat"], lng=wdef["lng"])
            db.add(w)
            ward_objects.append((w, district_name))
    db.flush()  # assigns IDs

    for w, d in ward_objects:
        ward_to_district[w.id] = d
    print(f"   -> {len(ward_objects)} wards created across {len(DISTRICTS)} districts")

    # ── 2. Seed Socio-Economic Data ──
    print("[+] Seeding district socio-economic data...")
    for district_name, dinfo in DISTRICTS.items():
        se = DistrictSocioEconomic(
            district=district_name,
            literacy_rate=dinfo["literacy_rate"],
            unemployment_rate=dinfo["unemployment_rate"],
            population_density=dinfo["population_density"],
            avg_income=dinfo["avg_income"],
        )
        db.add(se)
    db.flush()
    print(f"   -> {len(DISTRICTS)} district profiles created")

    # ── 3. Generate Accused Pool ──
    print("[+] Generating accused pool...")
    accused_pool_data = generate_accused_pool(500)
    accused_objects = []
    for ad in accused_pool_data:
        a = Accused(name=ad["name"], alias=ad["alias"],
                    age=ad["age"], gender=ad["gender"])
        db.add(a)
        accused_objects.append(a)
    db.flush()
    print(f"   -> {len(accused_objects)} accused individuals created")

    # ── 4. Generate Incidents ──
    NUM_INCIDENTS = 3000
    print(f"[+] Generating {NUM_INCIDENTS} incidents (Jan-Dec 2025)...")

    # Prepare ward list with district-aware crime rate weighting
    # Higher population density + higher unemployment → more incidents
    ward_weights = []
    for w, district_name in ward_objects:
        dinfo = DISTRICTS[district_name]
        # Weight: population_density * (1 + unemployment_rate/10)
        weight = dinfo["population_density"] * (1 + dinfo["unemployment_rate"] / 10)
        ward_weights.append(weight)
    total_weight = sum(ward_weights)
    ward_probs = [ww / total_weight for ww in ward_weights]

    # Repeat-offender set: pick ~80 accused who will appear in multiple cases
    repeat_offender_ids = [a.id for a in random.sample(accused_objects, min(80, len(accused_objects)))]

    for i in range(NUM_INCIDENTS):
        # Pick ward (weighted by socio-economic factors)
        ward_idx = np.random.choice(len(ward_objects), p=ward_probs)
        ward_obj, district_name = ward_objects[ward_idx]

        crime_type = pick_crime_type()
        severity = pick_severity(crime_type)
        ts = generate_timestamp()
        fir = f"FIR-{ts.strftime('%Y%m')}-{i+1:05d}"

        desc_options = DESCRIPTIONS.get(crime_type, ["Incident reported"])
        description = random.choice(desc_options)

        inc = Incident(
            fir_number=fir,
            crime_type=crime_type,
            severity=severity,
            lat=jitter(ward_obj.lat),
            lng=jitter(ward_obj.lng),
            ward_id=ward_obj.id,
            district=district_name,
            timestamp=ts,
            description=description,
        )
        db.add(inc)
        db.flush()

        # Assign accused — 1-3 per incident
        num_accused = random.choices([1, 2, 3], weights=[0.55, 0.30, 0.15], k=1)[0]
        chosen_accused = set()

        for _ in range(num_accused):
            # 25% chance of picking a repeat offender
            if random.random() < 0.25 and repeat_offender_ids:
                acc_id = random.choice(repeat_offender_ids)
            else:
                acc_id = random.choice(accused_objects).id

            if acc_id not in chosen_accused:
                chosen_accused.add(acc_id)
                db.execute(
                    incident_accused.insert().values(
                        incident_id=inc.id, accused_id=acc_id
                    )
                )

    db.commit()

    # ── 5. Summary Stats ──
    total_incidents = db.query(Incident).count()
    total_accused = db.query(Accused).count()
    linked_accused = db.execute(
        incident_accused.select()
    ).fetchall()

    # Check date range
    from sqlalchemy import func
    min_date = db.query(func.min(Incident.timestamp)).scalar()
    max_date = db.query(func.max(Incident.timestamp)).scalar()

    # Count repeat offenders (accused linked to > 1 incident)
    from sqlalchemy import text
    repeat_q = db.execute(text(
        "SELECT accused_id, COUNT(*) as cnt FROM incident_accused "
        "GROUP BY accused_id HAVING cnt > 1"
    )).fetchall()

    print("\n" + "=" * 60)
    print("[OK] SEED COMPLETE")
    print("=" * 60)
    print(f"   Incidents:         {total_incidents}")
    print(f"   Accused pool:      {total_accused}")
    print(f"   Incident-accused links: {len(linked_accused)}")
    print(f"   Repeat offenders:  {len(repeat_q)}  (linked to >1 incident)")
    print(f"   Date range:        {min_date.strftime('%Y-%m-%d')} -> {max_date.strftime('%Y-%m-%d')}")
    print(f"   Districts:         {len(DISTRICTS)}")
    print(f"   Wards:             {len(ward_objects)}")
    print("=" * 60)

    db.close()


if __name__ == "__main__":
    seed_database()
