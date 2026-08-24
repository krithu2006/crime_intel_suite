"""
Crime Intel Suite — Database connection helper.
Uses SQLite for local development (no external DB required).
"""

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import sessionmaker, declarative_base
import os

DATABASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATABASE_URL = f"sqlite:///{os.path.join(DATABASE_DIR, 'crime_intel.db')}"

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False}, echo=False)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def migrate_alert_read_state():
    """Add read state to databases created before notification support existed."""
    inspector = inspect(engine)
    if "alert_status" not in inspector.get_table_names():
        return
    columns = {column["name"] for column in inspector.get_columns("alert_status")}
    if "read_at" not in columns:
        with engine.begin() as connection:
            connection.execute(text("ALTER TABLE alert_status ADD COLUMN read_at DATETIME"))


def get_db():
    """FastAPI dependency — yields a DB session and closes it after use."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
