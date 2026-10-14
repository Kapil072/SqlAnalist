"""
Raw string pre-checks on SQL before AST parsing.
These are fast fail-fast checks. The AST checks in validator.py are the
real guarantee; these exist as a cheap first line of defence.

String literals ('...') are blanked out before checking, so a value like
WHERE status = 'open -- now' is not mistaken for a comment or keyword.
"""

import re

from app.sql_safety.whitelist import BLOCKED_KEYWORDS, BLOCKED_TABLE_PATTERNS


class SQLRuleError(Exception):
    """Raised when a raw-string SQL rule is violated."""

    pass


_STRING_LITERAL = re.compile(r"'(?:[^']|'')*'")


def strip_string_literals(sql: str) -> str:
    """Replace every single-quoted string literal with ''."""
    return _STRING_LITERAL.sub("''", sql)


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
    """Check 3: Must start with SELECT (or WITH for CTEs)."""
    stripped = sql.strip().upper()
    if not (stripped.startswith("SELECT") or stripped.startswith("WITH")):
        raise SQLRuleError("Query must start with SELECT or WITH")


def check_no_blocked_keywords(sql: str) -> None:
    """Check 4: No blocked keywords."""
    upper_sql = sql.upper()
    for kw in BLOCKED_KEYWORDS:
        # Word boundary avoids false positives (e.g. "CREATED_AT" vs "CREATE")
        if re.search(rf"\b{re.escape(kw)}\b", upper_sql):
            raise SQLRuleError(f"Blocked keyword: {kw}")


def check_no_system_tables(sql: str) -> None:
    """Check 9 (raw): No system table references."""
    lower_sql = sql.lower()
    for pattern in BLOCKED_TABLE_PATTERNS:
        if pattern.lower() in lower_sql:
            raise SQLRuleError(f"System table access is not allowed: {pattern}")


def run_raw_checks(sql: str) -> None:
    """Run all raw string checks in order. Raises SQLRuleError on first failure."""
    code_only = strip_string_literals(sql)
    check_no_comments(code_only)
    check_no_semicolons(code_only)
    check_starts_with_select(code_only)
    check_no_blocked_keywords(code_only)
    check_no_system_tables(code_only)
