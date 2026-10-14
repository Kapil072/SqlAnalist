"""
Blocked keywords and allowed SQL functions whitelist.
"""

# Keywords that should NEVER appear in user queries
# Keywords that should NEVER appear in user queries.
#
# Only words that are dangerous AND unlikely to be ordinary column names are
# listed here. Words such as OPEN, CLOSE, SET, SHOW, LOAD, REPLACE, FETCH,
# IMPORT, EXPORT were removed because they blocked legitimate queries like
# "SELECT open, close FROM stock_prices" or the REPLACE() string function.
# Statements starting with those words are still impossible: the AST validator
# only accepts a single SELECT statement and walks every node for DDL/DML.
BLOCKED_KEYWORDS = frozenset(
    [
        "DROP",
        "DELETE",
        "TRUNCATE",
        "INSERT",
        "UPDATE",
        "CREATE",
        "ALTER",
        "MERGE",
        "UPSERT",
        "GRANT",
        "REVOKE",
        "EXEC",
        "EXECUTE",
        "XP_CMDSHELL",
        "OPENROWSET",
        "OPENQUERY",
        "OPENDATASOURCE",
        "BULK",
        "INTO",
        "OUTFILE",
        "DUMPFILE",
        "LOAD_FILE",
        "ATTACH",
        "DETACH",
        "PRAGMA",
        "VACUUM",
        "REINDEX",
        "CALL",
        "DECLARE",
        "DEALLOCATE",
        "COPY",
        "PG_SLEEP",
        "SLEEP",
        "BENCHMARK",
        "WAITFOR",
        "PG_READ_FILE",
        "PG_LS_DIR",
        "DBLINK",
        "LO_IMPORT",
        "LO_EXPORT",
    ]
)

# System/internal tables that must not be referenced
BLOCKED_TABLE_PATTERNS = frozenset(
    [
        "pg_catalog",
        "information_schema",
        "sqlite_master",
        "sqlite_sequence",
        "sys.",
        "master.",
        "msdb.",
        "pg_shadow",
        "pg_user",
        "pg_roles",
    ]
)

# SQL statement types allowed (only SELECT)

# SQL functions that are explicitly allowed
