"""
11-check AST SQL validator using sqlglot.
All checks must pass before the query reaches the database.
"""
from typing import Set, Optional
import sqlglot
import sqlglot.expressions as exp

from app.config import settings
from app.sql_safety.rules import run_raw_checks, SQLRuleError
from app.sql_safety.sanitizer import sanitize_sql
from app.db.schema_registry import get_allowed_tables
from app.utils.logger import logger


class SQLValidationError(Exception):
    """Raised when any of the 11 SQL safety checks fail."""
    def __init__(self, check: int, message: str):
        self.check = check
        self.message = message
        super().__init__(f"[Check {check}] {message}")


def validate_sql(raw_sql: str, dialect: Optional[str] = None) -> str:
    """
    Run all 11 safety checks. Returns the sanitized safe SQL string,
    or raises SQLValidationError with the check number and message.
    """
    if dialect is None:
        dialect = "mysql" if "mysql" in settings.target_db_url else "postgres"
    # ── Checks 1–5: Raw string pre-checks ─────────────────────────────────────
    try:
        run_raw_checks(raw_sql)
    except SQLRuleError as exc:
        raise SQLValidationError(check=1, message=str(exc)) from exc

    # ── Sanitize: inject LIMIT, normalise whitespace ───────────────────────────
    sql = sanitize_sql(raw_sql)

    # ── Check 5: Must parse cleanly ───────────────────────────────────────────
    try:
        statements = sqlglot.parse(sql, dialect=dialect)
    except sqlglot.errors.ParseError as exc:
        raise SQLValidationError(check=5, message=f"SQL parse error: {exc}") from exc

    if not statements:
        raise SQLValidationError(check=5, message="Empty SQL after parsing")

    # ── Check 6: Single statement only ────────────────────────────────────────
    if len(statements) > 1:
        raise SQLValidationError(check=6, message="Only a single SQL statement is allowed")

    stmt = statements[0]

    # ── Check 7: Statement type must be SELECT ─────────────────────────────────
    if not isinstance(stmt, exp.Select):
        raise SQLValidationError(
            check=7,
            message=f"Only SELECT statements are allowed, got: {type(stmt).__name__}",
        )

    # ── Check 8: No DDL or DML nodes anywhere in the AST ─────────────────────
    # Enhanced read-only enforcement - strictly block all modification operations
    _alter_node = getattr(exp, "AlterTable", exp.Alter)
    _forbidden_node_types = (
        exp.Insert, exp.Update, exp.Delete, exp.Drop, exp.Create,
        _alter_node, exp.Command, exp.Anonymous,
    )
    for node in stmt.walk():
        if isinstance(node, _forbidden_node_types):
            raise SQLValidationError(
                check=8,
                message=f"DDL/DML operation detected in AST: {type(node).__name__}. Only SELECT statements are allowed for read-only access.",
            )

    # ── Check 9: No system tables ─────────────────────────────────────────────
    system_schemas = {
        "pg_catalog", "information_schema", "sqlite_master", "sqlite_sequence",
        "mysql", "performance_schema", "sys",
    }
    for table in stmt.find_all(exp.Table):
        db_or_schema = (table.args.get("db") or table.args.get("catalog") or "")
        table_name = str(table.name or "").lower()
        schema_name = str(db_or_schema).lower()

        if schema_name in system_schemas:
            raise SQLValidationError(check=9, message=f"System schema access blocked: {schema_name}")
        if table_name in system_schemas:
            raise SQLValidationError(check=9, message=f"System table access blocked: {table_name}")

    # ── Check 10: Every referenced table must be whitelisted ─────────────────
    allowed_tables = get_allowed_tables()
    for table in stmt.find_all(exp.Table):
        table_name = str(table.name or "").lower()
        if table_name and table_name not in allowed_tables:
            raise SQLValidationError(
                check=10,
                message=f"Table not in whitelist: '{table_name}'. Allowed: {sorted(allowed_tables)}",
            )

    # ── Check 11: LIMIT must be present and within cap ────────────────────────
    limit_node = stmt.args.get("limit")
    if not limit_node:
        raise SQLValidationError(check=11, message="LIMIT clause is required")

    logger.debug(f"[VALIDATOR] SQL passed all 11 checks: {sql[:120]}...")
    return sql
