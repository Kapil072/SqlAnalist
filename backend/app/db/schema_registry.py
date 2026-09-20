"""
Schema registry — loads the whitelist of allowed tables and columns from
data/schema_cache.json. Cached at startup.
"""
import json
import os
from functools import lru_cache
from typing import Set, Dict, Any

from app.utils.logger import logger

_SCHEMA_CACHE_PATH = os.path.join(
    os.path.dirname(__file__), "..", "..", "data", "schema_cache.json"
)


@lru_cache(maxsize=1)
def _load_schema() -> Dict[str, Any]:
    path = os.path.abspath(_SCHEMA_CACHE_PATH)
    if not os.path.exists(path):
        logger.warning(f"[SCHEMA] schema_cache.json not found at {path}. All tables will be blocked.")
        return {"tables": {}}

    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    logger.info(f"[SCHEMA] Loaded schema cache: {list(data.get('tables', {}).keys())}")
    return data


def get_allowed_tables() -> Set[str]:
    """Return the set of allowed table names (lowercase)."""
    schema = _load_schema()
    return {t.lower() for t in schema.get("tables", {}).keys()}


def get_schema() -> Dict[str, Any]:
    """Return the entire schema cache dictionary."""
    return _load_schema()
