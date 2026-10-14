"""
Mapping between database types / URLs and sqlglot dialect names.
Single source of truth — previously copied in several route files
(and SQL Server was mapped to "mssql", which sqlglot does not know; it is "tsql").
"""

DB_TYPE_TO_DIALECT = {
    "postgresql": "postgres",
    "mysql": "mysql",
    "sqlite": "sqlite",
    "sqlserver": "tsql",
    "oracle": "oracle",
}


def dialect_for_db_type(db_type: str | None) -> str:
    return DB_TYPE_TO_DIALECT.get((db_type or "").lower(), "postgres")


def dialect_from_url(url: str | None) -> str:
    """Best-effort sqlglot dialect from a SQLAlchemy URL."""
    u = (url or "").lower()
    if u.startswith("sqlite"):
        return "sqlite"
    if u.startswith("mysql") or u.startswith("mariadb"):
        return "mysql"
    if u.startswith("mssql"):
        return "tsql"
    if u.startswith("oracle"):
        return "oracle"
    return "postgres"


def human_dialect_name(dialect: str) -> str:
    """Readable name for prompts."""
    return {
        "postgres": "PostgreSQL",
        "mysql": "MySQL",
        "sqlite": "SQLite",
        "tsql": "Microsoft SQL Server (T-SQL)",
        "oracle": "Oracle",
    }.get(dialect, dialect)
