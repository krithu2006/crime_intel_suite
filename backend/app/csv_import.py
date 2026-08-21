"""Import Karnataka crime records from ``data/karnataka_crime.csv``.

The importer deliberately uses the standard library so deployment does not
require another package. Each run replaces the existing incident dataset,
keeping the dashboard aligned with the supplied CSV.
"""

from __future__ import annotations

import csv
import hashlib
import sys
from datetime import datetime
from pathlib import Path

from sqlalchemy import func

from .database import Base, SessionLocal, engine
from .models import Accused, DistrictSocioEconomic, Incident, Ward, incident_accused


ROOT = Path(__file__).resolve().parents[2]
CSV_PATH = ROOT / "data" / "karnataka_crime.csv"

REQUIRED_COLUMNS = {"district", "crime_type", "timestamp", "latitude", "longitude"}
ALIASES = {
    "district": ("district", "district_name"),
    "crime_type": ("crime_type", "crime", "offence_type", "offense_type"),
    "timestamp": ("timestamp", "date_time", "incident_time", "date"),
    "latitude": ("latitude", "lat"),
    "longitude": ("longitude", "lng", "lon", "long"),
    "fir_number": ("fir_number", "fir_no", "case_number", "case_id"),
    "severity": ("severity", "risk_level"),
    "ward": ("ward", "police_station", "station"),
    "description": ("description", "details", "summary"),
    "accused_names": ("accused_names", "accused", "suspects"),
}


def _synthetic_profile(name: str) -> tuple[int, str]:
    """Return a stable fictional profile for a name in the synthetic demo data."""
    seed = int.from_bytes(hashlib.sha256(name.casefold().encode("utf-8")).digest()[:4], "big")
    return 19 + (seed % 37), "Female" if seed % 5 == 0 else "Male"


def _synthetic_district_metrics(district: str) -> dict[str, float]:
    """Return stable fictional socio-economic values for demo districts."""
    seed = int.from_bytes(hashlib.sha256(district.casefold().encode("utf-8")).digest()[:4], "big")
    return {
        "literacy_rate": round(72 + (seed % 210) / 10, 1),
        "unemployment_rate": round(3.0 + ((seed >> 8) % 66) / 10, 1),
        "population_density": float(900 + ((seed >> 16) % 15_100)),
        "avg_income": float(180_000 + ((seed >> 5) % 420_000)),
    }


def _value(row: dict[str, str], field: str, default: str = "") -> str:
    for name in ALIASES.get(field, (field,)):
        value = row.get(name, "").strip()
        if value:
            return value
    return default


def _parse_timestamp(value: str, row_number: int) -> datetime:
    value = value.strip().replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(value).replace(tzinfo=None)
    except ValueError as exc:
        raise ValueError(f"Row {row_number}: timestamp must be ISO-8601, got {value!r}") from exc


def _clear_existing_data(db) -> None:
    db.execute(incident_accused.delete())
    db.query(Incident).delete()
    db.query(Accused).delete()
    db.query(Ward).delete()
    db.query(DistrictSocioEconomic).delete()


def import_csv(path: Path = CSV_PATH) -> int:
    """Replace the dashboard dataset with validated incidents from *path*."""
    Base.metadata.create_all(bind=engine)
    if not path.exists():
        raise FileNotFoundError(f"Crime CSV not found: {path}")

    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        headers = {header.strip().lower() for header in (reader.fieldnames or [])}
        missing = [column for column in REQUIRED_COLUMNS if not any(name in headers for name in ALIASES[column])]
        if missing:
            raise ValueError(f"CSV is missing required columns: {', '.join(sorted(missing))}")
        rows = list(reader)

    db = SessionLocal()
    try:
        _clear_existing_data(db)
        wards: dict[tuple[str, str], Ward] = {}
        accused: dict[str, Accused] = {}
        districts: set[str] = set()

        for row_number, raw_row in enumerate(rows, start=2):
            row = {(key or "").strip().lower(): (value or "") for key, value in raw_row.items()}
            district = _value(row, "district")
            crime_type = _value(row, "crime_type")
            if not district or not crime_type:
                raise ValueError(f"Row {row_number}: district and crime_type are required")

            try:
                latitude = float(_value(row, "latitude"))
                longitude = float(_value(row, "longitude"))
                severity = max(1, min(10, int(float(_value(row, "severity", "5")))))
            except ValueError as exc:
                raise ValueError(f"Row {row_number}: latitude, longitude, and severity must be numeric") from exc

            ward_name = _value(row, "ward", district)
            ward_key = (district, ward_name)
            ward = wards.get(ward_key)
            if ward is None:
                ward = Ward(name=ward_name, district=district, lat=latitude, lng=longitude)
                db.add(ward)
                db.flush()
                wards[ward_key] = ward
                districts.add(district)

            incident_number = _value(row, "fir_number", f"CSV-{row_number - 1:08d}")
            incident = Incident(
                fir_number=incident_number,
                crime_type=crime_type,
                severity=severity,
                lat=latitude,
                lng=longitude,
                ward_id=ward.id,
                district=district,
                timestamp=_parse_timestamp(_value(row, "timestamp"), row_number),
                description=_value(row, "description") or None,
            )
            db.add(incident)
            db.flush()

            for name in {item.strip() for item in _value(row, "accused_names").split("|") if item.strip()}:
                person = accused.get(name)
                if person is None:
                    age, gender = _synthetic_profile(name)
                    person = Accused(name=name, age=age, gender=gender)
                    db.add(person)
                    db.flush()
                    accused[name] = person
                db.execute(incident_accused.insert().values(incident_id=incident.id, accused_id=person.id))

        for district in districts:
            db.add(DistrictSocioEconomic(district=district, **_synthetic_district_metrics(district)))
        db.commit()
        return len(rows)
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def main() -> int:
    try:
        imported = import_csv()
    except (FileNotFoundError, ValueError) as exc:
        print(f"[csv] {exc}", file=sys.stderr)
        return 1
    print(f"[csv] Imported {imported} incidents from {CSV_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
