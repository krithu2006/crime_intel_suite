"""
Crime Intel Suite — SQLAlchemy ORM models.

Schema:
  - Ward: ward name, district, lat/long centroid
  - DistrictSocioEconomic: district-level socio-economic metrics
  - Incident: crime incident with spatial-temporal data
  - Accused: individual persons linked to incidents
  - incident_accused: many-to-many association table
"""

from sqlalchemy import (
    Column, Integer, Float, String, DateTime, Table, ForeignKey, Text
)
from sqlalchemy.orm import relationship
from .database import Base

# ---------- Many-to-many association table ----------
incident_accused = Table(
    "incident_accused",
    Base.metadata,
    Column("incident_id", Integer, ForeignKey("incidents.id"), primary_key=True),
    Column("accused_id", Integer, ForeignKey("accused.id"), primary_key=True),
)

# ---------- Ward ----------
class Ward(Base):
    __tablename__ = "wards"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(120), nullable=False)
    district = Column(String(120), nullable=False)
    lat = Column(Float, nullable=False)        # centroid latitude
    lng = Column(Float, nullable=False)        # centroid longitude

    incidents = relationship("Incident", back_populates="ward_rel")

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "district": self.district,
            "lat": self.lat,
            "lng": self.lng,
        }

# ---------- District Socio-Economic ----------
class DistrictSocioEconomic(Base):
    __tablename__ = "district_socioeconomic"

    id = Column(Integer, primary_key=True, autoincrement=True)
    district = Column(String(120), unique=True, nullable=False)
    literacy_rate = Column(Float)          # percentage 0-100
    unemployment_rate = Column(Float)      # percentage 0-100
    population_density = Column(Float)     # people per sq km
    avg_income = Column(Float)             # INR per annum

    def to_dict(self):
        return {
            "id": self.id,
            "district": self.district,
            "literacy_rate": self.literacy_rate,
            "unemployment_rate": self.unemployment_rate,
            "population_density": self.population_density,
            "avg_income": self.avg_income,
        }

# ---------- Incident ----------
class Incident(Base):
    __tablename__ = "incidents"

    id = Column(Integer, primary_key=True, autoincrement=True)
    fir_number = Column(String(30), unique=True, nullable=False)
    crime_type = Column(String(80), nullable=False)
    severity = Column(Integer, nullable=False)          # 1-10
    lat = Column(Float, nullable=False)
    lng = Column(Float, nullable=False)
    ward_id = Column(Integer, ForeignKey("wards.id"), nullable=False)
    district = Column(String(120), nullable=False)
    timestamp = Column(DateTime, nullable=False)
    description = Column(Text, nullable=True)

    ward_rel = relationship("Ward", back_populates="incidents")
    accused_list = relationship("Accused", secondary=incident_accused, back_populates="incidents")

    def to_dict(self):
        return {
            "id": self.id,
            "fir_number": self.fir_number,
            "crime_type": self.crime_type,
            "severity": self.severity,
            "lat": self.lat,
            "lng": self.lng,
            "ward_id": self.ward_id,
            "ward": self.ward_rel.name if self.ward_rel else None,
            "district": self.district,
            "timestamp": self.timestamp.isoformat() if self.timestamp else None,
            "description": self.description,
        }

# ---------- Accused ----------
class Accused(Base):
    __tablename__ = "accused"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(120), nullable=False)
    alias = Column(String(120), nullable=True)
    age = Column(Integer, nullable=True)
    gender = Column(String(10), nullable=True)

    incidents = relationship("Incident", secondary=incident_accused, back_populates="accused_list")

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "alias": self.alias,
            "age": self.age,
            "gender": self.gender,
            "incident_count": len(self.incidents),
        }
