"""
Validator for ADMIN write statements (INSERT / UPDATE / DELETE / DDL).

Regular users — and the AI chat — stay strictly read-only (validator.py).
Admins may change data from the SQL console in "write mode"; every such
statement still goes through these checks:

  1. No comments, and exactly one statement (no chaining with ';').
  2. No dangerous keywords: GRANT/REVOKE, EXEC/CALL, ATTACH/PRAGMA, COPY,
     file access (OUTFILE, LOAD_FILE, PG_READ_FILE), SLEEP/WAITFOR, DBLINK …
  3. Must parse cleanly in the target dialect.
  4. Only these statement types:
       SELECT, INSERT, UPDATE, DELETE, MERGE,
       CREATE/DROP TABLE | VIEW | INDEX, ALTER TABLE, TRUNCATE TABLE.
     Never: DROP/CREATE DATABASE or SCHEMA, users, functions, triggers.
  5. No system schemas or tables (information_schema, pg_catalog, sqlite_master …).
  6. Every table it touches must already exist in that database
     (except the new table / view a CREATE makes).
  7. UPDATE / DELETE without WHERE, and TRUNCATE, change every row:
     they need an explicit second confirmation (allow_full_table=True).
"""

import re
from collections.abc import Iterable
from dataclasses import dataclass

import sqlglot
import sqlglot.expressions as exp

from app.core.friendly_errors import sql_parse_error
from app.sql_safety.rules import strip_string_literals

WRITE_BLOCKED_KEYWORDS = frozenset(
    [
        "GRANT",
        "REVOKE",
        "EXEC",
        "EXECUTE",
        "CALL",
        "XP_CMDSHELL",
        "OPENROWSET",
        "OPENQUERY",
        "OPENDATASOURCE",
        "BULK",
        "OUTFILE",
        "DUMPFILE",
        "LOAD_FILE",
        "ATTACH",
        "DETACH",
        "PRAGMA",
        "COPY",
        "SLEEP",
        "PG_SLEEP",
        "BENCHMARK",
        "WAITFOR",
        "PG_READ_FILE",
        "PG_LS_DIR",
        "DBLINK",
        "LO_IMPORT",
        "LO_EXPORT",
        "SHUTDOWN",
        "KILL",
    ]
)

_SYSTEM_SCHEMAS = {
    "pg_catalog",
    "information_schema",
    "sqlite_master",
    "sqlite_schema",
    "sqlite_sequence",
    "sqlite_temp_master",
    "mysql",
    "performance_schema",
    "sys",
}

_CREATE_DROP_KINDS = {"TABLE", "VIEW", "INDEX"}


class AdminSQLError(Exception):
    """The statement is not allowed. `needs_confirmation` = only allowed after a second confirmation."""

    def __init__(self, message: str, needs_confirmation: bool = False):
        self.message = message
        self.needs_confirmation = needs_confirmation
        super().__init__(message)


@dataclass
class AdminStatement:
    sql: str  # the statement to run (trailing ';' removed)
    kind: str  # select | insert | update | delete | merge | create | drop | alter | truncate
    tables: set[str]  # existing tables it touches
    changes_schema: bool


def _kind_of(stmt: exp.Expr) -> str:
    if isinstance(stmt, (exp.Select, getattr(exp, "SetOperation", exp.Union))):
        return "select"
    if isinstance(stmt, exp.Insert):
        return "insert"
    if isinstance(stmt, exp.Update):
        return "update"
    if isinstance(stmt, exp.Delete):
        return "delete"
    if isinstance(stmt, exp.Merge):
        return "merge"
    if isinstance(stmt, exp.Create):
        return "create"
    if isinstance(stmt, exp.Drop):
        return "drop"
    if isinstance(stmt, getattr(exp, "AlterTable", exp.Alter)):
        return "alter"
    if isinstance(stmt, exp.TruncateTable):
        return "truncate"
    return type(stmt).__name__.lower()


def validate_admin_sql(
    raw_sql: str,
    dialect: str,
    existing_tables: Iterable[str],
    allow_full_table: bool = False,
) -> AdminStatement:
    sql = (raw_sql or "").strip()
    while sql.endswith(";"):
        sql = sql[:-1].rstrip()
    if not sql:
        raise AdminSQLError("Empty SQL")

    # 1–2. Raw checks on the code outside string values
    code = strip_string_literals(sql)
    if "--" in code or "/*" in code:
        raise AdminSQLError("SQL comments are not allowed")
    if ";" in code:
        raise AdminSQLError("Only one statement at a time — remove the extra ';'")
    upper = code.upper()
    for kw in WRITE_BLOCKED_KEYWORDS:
        if re.search(rf"\b{re.escape(kw)}\b", upper):
            raise AdminSQLError(f"'{kw}' is not allowed, even for admins")

    # 3. Parse
    try:
        statements = [s for s in sqlglot.parse(sql, dialect=dialect) if s is not None]
    except (sqlglot.errors.ParseError, sqlglot.errors.TokenError) as exc:
        raise AdminSQLError(sql_parse_error(exc)) from exc
    if len(statements) != 1:
        raise AdminSQLError("Exactly one SQL statement is required")
    stmt = statements[0]

    # 4. Statement type
    kind = _kind_of(stmt)
    allowed = {
        "select",
        "insert",
        "update",
        "delete",
        "merge",
        "create",
        "drop",
        "alter",
        "truncate",
    }
    if kind not in allowed:
        raise AdminSQLError(f"This kind of statement is not allowed: {type(stmt).__name__}")
    if kind in ("create", "drop"):
        obj = str(stmt.args.get("kind") or "").upper()
        if obj not in _CREATE_DROP_KINDS:
            raise AdminSQLError(
                f"{kind.upper()} {obj or '?'} is not allowed — only TABLE, VIEW and INDEX"
            )
    # Any nested statement that slipped into the tree (e.g. GRANT inside something odd)
    for node in stmt.walk():
        node = node[0] if isinstance(node, tuple) else node
        if isinstance(node, (exp.Command, getattr(exp, "Grant", exp.Command))):
            raise AdminSQLError("This statement contains a command that is not allowed")

    # 5. System schemas
    for table in stmt.find_all(exp.Table):
        schema_name = str(table.args.get("db") or table.args.get("catalog") or "").lower()
        if schema_name in _SYSTEM_SCHEMAS or str(table.name or "").lower() in _SYSTEM_SCHEMAS:
            raise AdminSQLError("System schemas and tables cannot be changed")

    # 6. Tables must exist (except what a CREATE makes, and CTE names)
    existing = {str(t).lower() for t in existing_tables}
    created: set[str] = set()
    if kind == "create" and str(stmt.args.get("kind") or "").upper() in ("TABLE", "VIEW"):
        target = stmt.this
        first = (
            target
            if isinstance(target, exp.Table)
            else (target.find(exp.Table) if target else None)
        )
        if first is not None:
            created.add(str(first.name).lower())
    if kind == "create" and str(stmt.args.get("kind") or "").upper() == "INDEX":
        idx = stmt.this
        if idx is not None and getattr(idx, "name", None):
            created.add(str(idx.name).lower())
    ctes = {str(c.alias_or_name).lower() for c in stmt.find_all(exp.CTE)}
    touched: set[str] = set()
    drop_if_exists = kind == "drop" and bool(stmt.args.get("exists"))
    for table in stmt.find_all(exp.Table):
        name = str(table.name or "").lower()
        if not name or name in created or name in ctes:
            continue
        if name not in existing and not drop_if_exists:
            raise AdminSQLError(
                f"Table '{name}' does not exist in this database. Known tables: {sorted(existing)}"
            )
        touched.add(name)

    # 7. Whole-table changes need a second confirmation
    if not allow_full_table:
        if kind in ("update", "delete") and not stmt.args.get("where"):
            raise AdminSQLError(
                f"{kind.upper()} without a WHERE clause changes EVERY row of the table. "
                "Confirm to run it anyway.",
                needs_confirmation=True,
            )
        if kind == "truncate":
            raise AdminSQLError(
                "TRUNCATE deletes every row of the table. Confirm to run it anyway.",
                needs_confirmation=True,
            )
        if kind == "drop":
            raise AdminSQLError(
                f"DROP permanently removes {', '.join(sorted(touched)) or 'the object'}. "
                "Confirm to run it anyway.",
                needs_confirmation=True,
            )

    return AdminStatement(
        sql=sql,
        kind=kind,
        tables=touched | created,
        changes_schema=kind in ("create", "drop", "alter"),
    )
