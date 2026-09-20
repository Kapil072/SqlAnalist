"""
Raw string pre-checks on SQL before AST parsing.
These are fast fail-fast checks.
"""
import re
from app.sql_safety.whitelist import BLOCKED_KEYWORDS, BLOCKED_TABLE_PATTERNS


class SQLRuleError(Exception):
    """Raised when a raw-string SQL rule is violated."""
    pass


def check_no_comments(sql: str) -> None:
    """Check 1: No SQL comments (-- or /* */)."""
    if "--" in sql:
        raise SQLRuleError("SQL comments (--) are not allowed")
    if re.search(r"/\*", sql):
        raise SQLRuleError("SQL block comments (/* */) are not allowed")


def check_no_semicolons(sql: str) -> None:
    """Check 2: No semicolons (prevents statement chaining)."""
    if ";" in sql:
        raise SQLRuleError("Semicolons are not allowed in queries")


def check_starts_with_select(sql: str) -> None:
    """Check 3: Must start with SELECT."""
    stripped = sql.strip().upper()
    if not stripped.startswith("SELECT"):
        raise SQLRuleError("Query must start with SELECT")


def check_no_blocked_keywords(sql: str) -> None:
    """Check 4: No blocked keywords."""
    upper_sql = sql.upper()
    for kw in BLOCKED_KEYWORDS:
        # Use word boundary to avoid false positives (e.g., "SELECTED" contains "SELECT")
        pattern = rf"\b{re.escape(kw)}\b"
        if re.search(pattern, upper_sql):
            raise SQLRuleError(f"Blocked keyword: {kw}")


def check_no_system_tables(sql: str) -> None:
    """Check 9 (raw): No system table references."""
    lower_sql = sql.lower()
    for pattern in BLOCKED_TABLE_PATTERNS:
        if pattern.lower() in lower_sql:
            raise SQLRuleError(f"System table access is not allowed: {pattern}")


def run_raw_checks(sql: str) -> None:
    """Run all raw string checks in order. Raises SQLRuleError on first failure."""
    check_no_comments(sql)
    check_no_semicolons(sql)
    check_starts_with_select(sql)
    check_no_blocked_keywords(sql)
    check_no_system_tables(sql)
