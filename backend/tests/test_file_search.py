"""
Searching an uploaded CSV, and telling admin sentences apart from typed SQL.
"""

from app.api.routes import file_analysis as fa
from app.services.file_session_store import create_file_session, execute_on_file
from app.services.query_pipeline import is_direct_sql
from app.sql_safety.validator import validate_sql

CSV = b"""Order ID,Customer Name,City,Amount
1,Ram Sharma,Delhi,500
2,Vikram Singh,New Delhi,300
3,Ramesh Gupta,Mumbai,120
4, Kapil Sen ,Pune,900
"""


def _search(question: str) -> list[list]:
    sid, meta = create_file_session("orders.csv", CSV, "csv", "u1")
    table, info = meta["table_name"], meta["column_info"]
    hits = fa._find_values(sid, "u1", table, info, fa._search_terms(question, info))
    sql = validate_sql(
        fa._keyword_search_sql(table, hits), dialect="sqlite", allowed_tables={table}
    )
    return execute_on_file(sid, sql, "u1")[1]


def test_whole_word_beats_partial_match():
    rows = _search("show orders of ram")
    assert [r[1] for r in rows] == ["Ram Sharma"]  # not Vikram / Ramesh


def test_exact_cell_beats_word_match():
    rows = _search("orders from delhi")
    assert [r[2] for r in rows] == ["Delhi"]  # not "New Delhi"


def test_case_and_spaces_are_ignored():
    assert [r[0] for r in _search("KAPIL")] == [4]


def test_column_names_are_not_search_values():
    sid, meta = create_file_session("orders.csv", CSV, "csv", "u1")
    assert fa._search_terms("amount per city for pune", meta["column_info"]) == ["pune"]


def test_admin_sentences_go_to_the_ai():
    tables = {"employees", "orders"}
    assert not is_direct_sql("delete diana", True, "postgres", tables)
    assert not is_direct_sql("delete order id 92", True, "postgres", tables)
    assert is_direct_sql("DELETE FROM orders WHERE order_id = 6", True, "postgres", tables)
    assert is_direct_sql("DROP TABLE missing_table", True, "postgres", tables)


def test_check_violation_names_the_allowed_values():
    from app.core.friendly_errors import explain_error as _hint_for

    schema = {
        "tables": {
            "orders": {
                "checks": [
                    {"name": "orders_order_status_check", "rule": "order_status IN ('Completed')"}
                ]
            }
        }
    }
    exc = Exception('violates check constraint "orders_order_status_check"')
    assert "order_status must be one of: Completed" in _hint_for(exc, schema)


def test_missing_foreign_key_value_is_explained():
    from app.core.friendly_errors import explain_error as _hint_for

    exc = Exception(
        'insert or update on table "orders" violates foreign key constraint "fk" '
        'DETAIL:  Key (employee_id)=(45) is not present in table "employees".'
    )
    hint = _hint_for(exc)
    assert "employee_id 45 does not exist in the employees table" in hint
    assert "Other rows still point" not in hint  # that hint is for deletes
