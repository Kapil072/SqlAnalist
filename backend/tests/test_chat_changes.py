"""
Admins asking for a change in the chat: the statement is shown for
confirmation (SSE `confirm` event) and is never run by /ask/stream itself.
Also checks that the audit log really records admin changes.
"""

import json
import sqlite3

from httpx import AsyncClient
from sqlalchemy import select

from app.models.audit_log import AuditLog


def _events(body: str):
    """Parse an SSE body into [(event, data), ...]."""
    out = []
    for frame in body.split("\n\n"):
        name, data = None, None
        for line in frame.splitlines():
            if line.startswith("event:"):
                name = line[6:].strip()
            elif line.startswith("data:"):
                data = json.loads(line[5:].strip())
        if name:
            out.append((name, data))
    return out


async def _ask(client, token, ds, question):
    r = await client.post(
        "/ask/stream",
        headers={"Authorization": f"Bearer {token}"},
        json={"question": question, "data_source_id": str(ds.id)},
    )
    assert r.status_code == 200, r.text
    return _events(r.text)


def _count(path):
    conn = sqlite3.connect(path)
    try:
        return conn.execute("SELECT COUNT(*) FROM items").fetchone()[0]
    finally:
        conn.close()


async def test_admin_change_in_chat_waits_for_confirmation(
    client: AsyncClient, admin_token, shop, shared_sessions
):
    ds, path = shop
    events = await _ask(client, admin_token, ds, "DELETE FROM items WHERE id = 1")
    names = [e for e, _ in events]
    assert "confirm" in names and "error" not in names
    change = dict(events)["confirm"]
    assert change["kind"] == "delete"
    assert change["full_table"] is False
    assert change["database"] == "Shop"
    assert _count(path) == 2  # nothing was run yet


async def test_whole_table_change_is_flagged(
    client: AsyncClient, admin_token, shop, shared_sessions
):
    ds, _ = shop
    events = await _ask(client, admin_token, ds, "DELETE FROM items")
    assert dict(events)["confirm"]["full_table"] is True


async def test_regular_user_cannot_request_changes(
    client: AsyncClient, user_token, shop, shared_sessions
):
    ds, path = shop
    events = await _ask(client, user_token, ds, "DELETE FROM items WHERE id = 1")
    assert events[0][0] == "error"
    assert _count(path) == 2


async def test_blocked_change_is_explained(client: AsyncClient, admin_token, shop, shared_sessions):
    ds, _ = shop
    events = await _ask(client, admin_token, ds, "DROP TABLE missing_table")
    assert events[0][0] == "error"
    assert "not allowed" in events[0][1]["detail"]


async def test_admin_changes_are_written_to_the_audit_log(
    client: AsyncClient, admin_token, shop, shared_sessions
):
    ds, _ = shop
    for sql in (
        "INSERT INTO items (name, price) VALUES ('cup', 4)",
        "UPDATE items SET price = 3 WHERE name = 'pen'",
    ):
        r = await client.post(
            "/admin/sql/execute",
            headers={"Authorization": f"Bearer {admin_token}"},
            json={"sql": sql, "data_source_id": str(ds.id)},
        )
        assert r.status_code == 200, r.text

    async with shared_sessions() as db:
        logs = (await db.execute(select(AuditLog).order_by(AuditLog.id))).scalars().all()
    assert [log.status for log in logs] == ["success", "success"]
    assert logs[0].id < logs[1].id  # auto-numbered ids (failed on SQLite before)
    assert logs[1].sql_used.startswith("UPDATE items")


async def test_plain_english_change_goes_to_the_ai(
    client: AsyncClient, admin_token, shop, shared_sessions, monkeypatch
):
    """'delete item id 1' starts with DELETE but is English: the AI writes the SQL."""
    from app.api.routes import ask_stream

    asked = {}

    def fake_generate(question, schema, dialect, allow_writes=False):
        asked["question"], asked["allow_writes"] = question, allow_writes
        return "DELETE FROM items WHERE id = 1"

    monkeypatch.setattr(ask_stream, "generate_sql", fake_generate)
    ds, path = shop
    events = await _ask(client, admin_token, ds, "delete item id 1")
    names = [e for e, _ in events]
    assert asked == {"question": "delete item id 1", "allow_writes": True}
    assert "confirm" in names and "error" not in names
    assert dict(events)["confirm"]["sql"] == "DELETE FROM items WHERE id = 1"
    assert _count(path) == 2  # still waiting for the admin to confirm


def test_sql_or_sentence_detection():
    from app.services.query_pipeline import is_direct_sql

    sql = [
        ("SELECT * FROM orders", False),
        ("select 1", False),
        ("WITH s AS (SELECT 1 AS x) SELECT * FROM s", False),
        ("DELETE FROM orders WHERE order_id = 92", True),
        ("UPDATE products SET price = 5 WHERE name = 'Pen'", True),
        ("DROP TABLE tmp", True),
    ]
    sentences = [
        ("delete order id 92", True),
        ("update the price of pen to 5", True),
        ("drop the old table", True),
        ("insert a new customer called Bob", True),
        ("select top customers", False),
        ("show me orders", False),
        ("DELETE FROM orders WHERE order_id = 92", False),  # users: writes are never SQL
    ]
    for dialect in ("sqlite", "mysql", "postgres"):
        for q, writes in sql:
            assert is_direct_sql(q, allow_writes=writes, dialect=dialect), (dialect, q)
        for q, writes in sentences:
            assert not is_direct_sql(q, allow_writes=writes, dialect=dialect), (dialect, q)
