# Simple DB connection module

from sqlalchemy import create_engine
from sqlalchemy.engine import Engine
from contextlib import contextmanager
from app.config import settings

# Create a single engine based on the configured URL
engine: Engine = create_engine(settings.target_db_url, future=True)
# Alias for backward compatibility
target_engine = engine

@contextmanager
def get_target_connection():
    """Yield a raw DBAPI connection and ensure it is closed."""
    conn = engine.raw_connection()
    try:
        yield conn
    finally:
        conn.close()
