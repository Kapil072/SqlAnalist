"""
SQL sanitizer: strips comments, injects LIMIT if missing.
"""

import re

from app.config import settings


def inject_limit(sql: str, max_rows: int | None = None) -> str:
    """
    Ensure the SQL has a LIMIT clause. If already present, enforce the cap.
    Text-based fallback — validator.py prefers the AST-based approach.
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
