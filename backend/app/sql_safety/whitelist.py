"""
Blocked keywords and allowed SQL functions whitelist.
"""

# Keywords that should NEVER appear in user queries
BLOCKED_KEYWORDS = frozenset([
    "DROP", "DELETE", "TRUNCATE", "INSERT", "UPDATE", "CREATE", "ALTER",
    "REPLACE", "MERGE", "UPSERT", "GRANT", "REVOKE", "EXEC", "EXECUTE",
    "XP_CMDSHELL", "OPENROWSET", "BULK", "INTO", "LOAD", "OUTFILE",
    "DUMPFILE", "ATTACH", "DETACH", "PRAGMA", "VACUUM", "ANALYZE",
    "REINDEX", "EXPLAIN", "SHOW", "DESCRIBE", "USE", "SET", "CALL",
    "DECLARE", "CURSOR", "FETCH", "OPEN", "CLOSE", "DEALLOCATE",
    "COPY", "IMPORT", "EXPORT", "BACKUP", "RESTORE",
])

# System/internal tables that must not be referenced
BLOCKED_TABLE_PATTERNS = frozenset([
    "pg_catalog", "information_schema", "sqlite_master",
    "sqlite_sequence", "sys.", "master.", "msdb.",
    "pg_shadow", "pg_user", "pg_roles",
])

# SQL statement types allowed (only SELECT)
ALLOWED_STATEMENT_TYPES = frozenset(["select"])

# SQL functions that are explicitly allowed
ALLOWED_FUNCTIONS = frozenset([
    # Aggregates
    "count", "sum", "avg", "min", "max", "stddev", "variance",
    # String
    "upper", "lower", "trim", "ltrim", "rtrim", "length", "len",
    "substr", "substring", "replace", "concat", "coalesce", "nullif",
    "left", "right", "split_part", "string_agg",
    # Math
    "round", "floor", "ceil", "ceiling", "abs", "mod", "power", "sqrt",
    # Date/time
    "now", "current_date", "current_timestamp", "date_trunc", "extract",
    "date_part", "age", "to_char", "to_date", "to_timestamp",
    "year", "month", "day", "hour", "minute", "second",
    "strftime", "date", "time", "datetime", "julianday",
    # Conditional
    "case", "when", "then", "else", "end", "if", "iif",
    # Cast
    "cast", "convert",
    # Window
    "row_number", "rank", "dense_rank", "ntile",
    "lag", "lead", "first_value", "last_value",
    "over", "partition",
    # Other safe
    "distinct", "exists", "not", "in", "between", "like", "ilike",
])
