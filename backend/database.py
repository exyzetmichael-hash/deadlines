import os
from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

# Если задан DATABASE_URL (Postgres на проде) — используем его.
# Иначе локальный SQLite-файл в DATA_DIR.
_database_url = os.getenv("DATABASE_URL")

if _database_url:
    # Neon/Heroku отдают URL вида postgres://... — приводим к драйверу psycopg v3
    if _database_url.startswith("postgres://"):
        _database_url = _database_url.replace("postgres://", "postgresql+psycopg://", 1)
    elif _database_url.startswith("postgresql://"):
        _database_url = _database_url.replace("postgresql://", "postgresql+psycopg://", 1)
    DATABASE_URL = _database_url
    connect_args = {}
else:
    _data_dir = os.getenv("DATA_DIR", ".")
    DATABASE_URL = f"sqlite:///{_data_dir}/deadlines.db"
    connect_args = {"check_same_thread": False}

engine = create_engine(DATABASE_URL, connect_args=connect_args, pool_pre_ping=True)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
