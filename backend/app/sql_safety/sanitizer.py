"""
SQL sanitizer: strips comments, injects LIMIT if missing.
"""
import re
from app.config import settings


def strip_comments(sql: str) -> str:
    """Remove -- comments and /* */ block comments from SQL."""
    # Remove block comments
    sql = re.sub(r"/\*.*?\*/", " ", sql, flags=re.DOTALL)
    # Remove line comments
    sql = re.sub(r"--[^\n]*", " ", sql)
    return sql.strip()


def inject_limit(sql: str, max_rows: int | None = None) -> str:
    """
    Ensure the SQL has a LIMIT clause. If already present, enforce the cap.
    """
    cap = max_rows or settings.db_max_rows
    upper = sql.upper()

    limit_match = re.search(r"\bLIMIT\s+(\d+)", upper)
    if limit_match:
        existing = int(limit_match.group(1))
        if existing > cap:
            # Replace the existing LIMIT with the cap
            sql = re.sub(
                r"\bLIMIT\s+\d+",
                f"LIMIT {cap}",
                sql,
                flags=re.IGNORECASE,
            )
    else:
        # Append a LIMIT
        sql = f"{sql.rstrip()} LIMIT {cap}"

    return sql


def sanitize_sql(sql: str, inject_limit_cap: bool = True) -> str:
    """Full sanitize pipeline: strip comments → inject LIMIT."""
    sql = strip_comments(sql)
    if inject_limit_cap:
        sql = inject_limit(sql)
    return sql.strip()
