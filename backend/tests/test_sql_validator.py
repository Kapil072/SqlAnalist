"""
Unit tests for the SQL safety validator (no database needed).
"""

import pytest

from app.sql_safety.validator import SQLValidationError, validate_sql

TABLES = {"customers", "orders", "stock_prices"}


def ok(sql, dialect="sqlite", **kw):
    return validate_sql(sql, dialect=dialect, allowed_tables=TABLES, **kw)


@pytest.mark.parametrize(
    "sql",
    [
        "DROP TABLE customers",
        "DELETE FROM customers",
        "UPDATE customers SET name = 'x'",
        "INSERT INTO customers VALUES (1)",
        "SELECT 1; DROP TABLE customers",
        "SELECT * FROM customers -- comment",
        "SELECT * FROM customers /* comment */",
        "SELECT * FROM sqlite_master",
        "SELECT * FROM users",  # not whitelisted
        "ATTACH DATABASE 'x.db' AS x",
        "PRAGMA table_info(customers)",
        "SELECT * INTO backup FROM customers",
    ],
)
def test_blocks_dangerous_sql(sql):
    with pytest.raises(SQLValidationError):
        ok(sql)


def test_allows_simple_select_and_adds_limit():
    out = ok("SELECT * FROM customers", max_rows=50)
    assert out.upper().endswith("LIMIT 50")


def test_trailing_semicolon_is_tolerated():
    out = ok("SELECT * FROM customers;", max_rows=10)
    assert ";" not in out


def test_keeps_existing_small_limit():
    assert ok("SELECT * FROM customers LIMIT 5", max_rows=100) == "SELECT * FROM customers LIMIT 5"


def test_caps_large_limit():
    out = ok("SELECT * FROM customers LIMIT 999999", max_rows=100)
    assert "999999" not in out and "100" in out


def test_allows_cte():
    out = ok("WITH big AS (SELECT * FROM orders) SELECT COUNT(*) AS n FROM big")
    assert "big" in out


def test_string_literals_do_not_trigger_rules():
    # '--', ';' and keywords inside a string value are data, not SQL
    ok("SELECT * FROM orders WHERE status = 'drop -- ship; now'")


def test_columns_named_like_old_keywords_are_allowed():
    ok("SELECT open, close FROM stock_prices")


def test_sql_server_uses_top():
    out = ok("SELECT name FROM customers", dialect="tsql", max_rows=10)
    assert "TOP 10" in out.upper()


def test_oracle_uses_fetch_first():
    out = ok("SELECT name FROM customers", dialect="oracle", max_rows=10)
    assert "FETCH FIRST 10" in out.upper()
