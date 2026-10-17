from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, DeclarativeBase

# SQLite for the POC. For production, switch to Postgres + PostGIS:
# DATABASE_URL = "postgresql+psycopg://user:pass@localhost/foodfit"
DATABASE_URL = "sqlite:///./foodfit.db"

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(bind=engine, autoflush=False)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
