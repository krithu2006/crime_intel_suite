"""Generate a fresh, clearly synthetic Karnataka crime dataset for demos."""

from __future__ import annotations

import csv
import random
from datetime import datetime, timedelta
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
CSV_PATH = ROOT / "data" / "karnataka_crime.csv"

# District centroids are used only to place synthetic demo points on the map.
DISTRICT_CENTERS = {
    "Bagalkote": (16.172, 75.655), "Ballari": (15.140, 76.921),
    "Belagavi": (15.849, 74.498), "Bengaluru Rural": (13.285, 77.607),
    "Bengaluru Urban": (12.972, 77.595), "Bidar": (17.914, 77.519),
    "Chamarajanagar": (11.927, 76.943), "Chikkaballapur": (13.436, 77.731),
    "Chikkamagaluru": (13.316, 75.773), "Chitradurga": (14.225, 76.400),
    "Dakshina Kannada": (12.915, 74.856), "Davanagere": (14.464, 75.922),
    "Dharwad": (15.458, 75.007), "Gadag": (15.432, 75.638),
    "Hassan": (13.007, 76.102), "Haveri": (14.795, 75.404),
    "Kalaburagi": (17.329, 76.834), "Kodagu": (12.424, 75.738),
    "Kolar": (13.136, 78.130), "Koppal": (15.350, 76.155),
    "Mandya": (12.522, 76.896), "Mysuru": (12.295, 76.640),
    "Raichur": (16.208, 77.346), "Ramanagara": (12.722, 77.281),
    "Shivamogga": (13.929, 75.568), "Tumakuru": (13.339, 77.102),
    "Udupi": (13.340, 74.742), "Uttara Kannada": (14.818, 74.129),
    "Vijayapura": (16.830, 75.710), "Vijayanagara": (15.335, 76.461),
    "Yadgir": (16.762, 77.144),
}

CRIMES = [
    ("Theft", 4, 28), ("Assault", 7, 14), ("Burglary", 6, 12),
    ("Fraud", 5, 12), ("Dispute", 3, 15), ("Robbery", 8, 6),
    ("Vandalism", 2, 7), ("Chain Snatching", 7, 6),
]
FIRST_NAMES = [
    "Ravi", "Suresh", "Mahesh", "Ganesh", "Anil", "Vijay", "Rajesh", "Manoj",
    "Deepak", "Srinivas", "Prakash", "Ramesh", "Naveen", "Santosh", "Harish",
    "Mohan", "Kiran", "Ashok", "Pradeep", "Arjun", "Nikhil", "Rohit", "Imran",
    "Farhan", "Saleem", "Irfan", "Priya", "Kavitha", "Rekha", "Pooja", "Meena",
]
LAST_NAMES = [
    "Gowda", "Reddy", "Shetty", "Nair", "Sharma", "Rao", "Patil", "Kumar",
    "Singh", "Hegde", "Naik", "Kulkarni", "Jain", "Bhat", "Patel", "Mishra",
    "Gupta", "Yadav", "Verma", "Rathod", "Khan", "Shaikh", "Syed", "Ahmed",
]
DEMO_ASSOCIATES = [
    f"{FIRST_NAMES[(number - 1) % len(FIRST_NAMES)]} {LAST_NAMES[((number - 1) // len(FIRST_NAMES)) % len(LAST_NAMES)]}"
    for number in range(1, 241)
]


# Each district gets a handful of realistic "crime hubs" (market areas, bus
# stands, etc). Incidents cluster tightly around these hubs instead of being
# scattered uniformly across the whole district — real crime data is spatially
# clustered, and DBSCAN (eps ~800m) needs that structure to find hotspots at
# all. A uniform scatter across a ~10km box puts well under 1 point per eps
# radius on average, so almost no district would ever produce a cluster.
HUBS_PER_DISTRICT = (3, 6)
HUB_OFFSET_DEG = 0.03       # how far hubs are spread from the district centroid
HUB_JITTER_SIGMA_DEG = 0.0022  # ~245m stddev — keeps most points within DBSCAN's eps
BACKGROUND_SPREAD_DEG = 0.045  # a minority of incidents scattered more broadly (noise)


def _bounded_gauss(center: float, sigma: float, limit: float) -> float:
    offset = max(-limit, min(limit, random.gauss(0, sigma)))
    return center + offset


def generate_demo_csv(count: int = 2400) -> int:
    """Write a new randomized CSV for each local demo startup."""
    CSV_PATH.parent.mkdir(parents=True, exist_ok=True)
    now = datetime.now().replace(microsecond=0)
    districts = list(DISTRICT_CENTERS.items())
    crime_names = [crime[0] for crime in CRIMES]
    crime_weights = [crime[2] for crime in CRIMES]
    severity_by_crime = {crime[0]: crime[1] for crime in CRIMES}

    # Build a fixed set of hotspot hubs per district up front, so every
    # district has real spatial structure regardless of how many incidents
    # happen to land there.
    district_hubs = {}
    for district, (lat, lng) in districts:
        n_hubs = random.randint(*HUBS_PER_DISTRICT)
        hubs = [
            (
                lat + random.uniform(-HUB_OFFSET_DEG, HUB_OFFSET_DEG),
                lng + random.uniform(-HUB_OFFSET_DEG, HUB_OFFSET_DEG),
            )
            for _ in range(n_hubs)
        ]
        district_hubs[district] = hubs

    with CSV_PATH.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=[
            "fir_number", "district", "ward", "crime_type", "severity",
            "latitude", "longitude", "timestamp", "description", "accused_names",
        ])
        writer.writeheader()
        # Distribute incidents evenly across districts (equal share, +/- a
        # little variation) so every district gets a reasonable incident
        # count instead of relying on pure chance.
        base_share = count // len(districts)
        district_sequence = []
        for district, center in districts:
            district_sequence.extend([(district, center)] * base_share)
        while len(district_sequence) < count:
            district_sequence.append(random.choice(districts))
        random.shuffle(district_sequence)

        for index, (district, (lat, lng)) in enumerate(district_sequence[:count], start=1):
            crime = random.choices(crime_names, weights=crime_weights, k=1)[0]
            incident_time = now - timedelta(minutes=random.randint(0, 60 * 24 * 90))
            group = (districts.index((district, (lat, lng))) % 12) * 20
            associates = random.sample(DEMO_ASSOCIATES[group:group + 20], k=random.choices([1, 2, 3], [35, 45, 20])[0])

            # 80% of incidents cluster tightly around one of the district's
            # hotspot hubs; 20% scatter more broadly as background noise.
            if random.random() < 0.8:
                hub_lat, hub_lng = random.choice(district_hubs[district])
                point_lat = _bounded_gauss(hub_lat, HUB_JITTER_SIGMA_DEG, HUB_OFFSET_DEG)
                point_lng = _bounded_gauss(hub_lng, HUB_JITTER_SIGMA_DEG, HUB_OFFSET_DEG)
            else:
                point_lat = lat + random.uniform(-BACKGROUND_SPREAD_DEG, BACKGROUND_SPREAD_DEG)
                point_lng = lng + random.uniform(-BACKGROUND_SPREAD_DEG, BACKGROUND_SPREAD_DEG)

            writer.writerow({
                "fir_number": f"DEMO-{now:%Y%m%d}-{index:05d}",
                "district": district,
                "ward": f"{district} Demo Zone {random.randint(1, 4)}",
                "crime_type": crime,
                "severity": max(1, min(10, severity_by_crime[crime] + random.randint(-1, 1))),
                "latitude": round(point_lat, 6),
                "longitude": round(point_lng, 6),
                "timestamp": incident_time.isoformat(),
                "description": f"Synthetic demo record: {crime.lower()} reported in {district}.",
                "accused_names": "|".join(associates),
            })
    return count


if __name__ == "__main__":
    print(f"[demo] Generated {generate_demo_csv()} synthetic Karnataka incidents")
