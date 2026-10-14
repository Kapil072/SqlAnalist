"""
Schema endpoints.

GET  /api/schema         — returns current cached schema + live row counts
POST /api/schema/refresh — re-introspects the target DB and rebuilds the cache
"""

from fastapi import APIRouter, Depends

from app.core.security import get_current_user, require_admin
from app.db.schema_registry import get_schema, refresh_schema
from app.utils.logger import logger

router = APIRouter(tags=["schema"])


@router.get("/api/schema")
def get_database_schema(_=Depends(get_current_user)):
    """
    Returns tables, columns, row counts, and query suggestions.
    Data comes from the in-memory cache — no extra DB round-trip needed
    because row counts are stored in schema_cache.json at introspection time.
    """
    try:
        schema_data = get_schema()
        tables = []

        for table_name, table_info in schema_data.get("tables", {}).items():
            tables.append(
                {
                    "name": table_name,
                    "row_count": table_info.get("row_count", 0),
                    "columns": table_info.get("columns", []),
                }
            )

        # Example questions based on the tables that actually exist
        from app.api.routes.sources import build_suggestions

        suggestions = build_suggestions([t["name"] for t in tables])

        return {"tables": tables, "suggestions": suggestions}

    except Exception as e:
        logger.error(f"[SCHEMA] get_database_schema failed: {e}")
        return {"tables": [], "suggestions": []}


@router.post("/api/schema/refresh")
def refresh_database_schema(_=Depends(require_admin)):
    """
    Re-introspects the target database and rebuilds schema_cache.json.
    Requires admin role.

    Use this after:
      - Changing TARGET_DB_URL in .env (+ server restart reloads the env)
      - Adding/removing tables in the connected database
    """
    try:
        schema = refresh_schema()
        table_names = list(schema.get("tables", {}).keys())
        logger.info(f"[SCHEMA] Manual refresh complete: {table_names}")
        return {
            "status": "ok",
            "tables_found": len(table_names),
            "tables": table_names,
        }
    except Exception as e:
        logger.error(f"[SCHEMA] Manual refresh failed: {e}")
        return {"status": "error", "detail": str(e)}
