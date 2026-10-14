"""
Admin write mode (POST /admin/sql/execute) and data-source error reporting.
"""

import sqlite3

from httpx import AsyncClient

from app.models.data_source import DataSource


def _rows(path, sql):
    conn = sqlite3.connect(path)
    try:
        return conn.execute(sql).fetchall()
    finally:
        conn.close()


async def _exec(client, token, ds, sql, **extra):
    return await client.post(
        "/admin/sql/execute",
        headers={"Authorization": f"Bearer {token}"},
        json={"sql": sql, "data_source_id": str(ds.id), **extra},
    )


async def test_admin_can_insert_update_delete(client: AsyncClient, admin_token, shop):
    ds, path = shop
    r = await _exec(client, admin_token, ds, "INSERT INTO items (name, price) VALUES ('cup', 4)")
    assert r.status_code == 200, r.text
    assert r.json()["kind"] == "insert" and r.json()["rows_affected"] == 1

    r = await _exec(client, admin_token, ds, "UPDATE items SET price = 5 WHERE name = 'cup'")
    assert r.status_code == 200 and r.json()["rows_affected"] == 1

    r = await _exec(client, admin_token, ds, "DELETE FROM items WHERE name = 'pen'")
    assert r.status_code == 200 and r.json()["rows_affected"] == 1

    assert _rows(path, "SELECT name, price FROM items ORDER BY id") == [("book", 9), ("cup", 5)]


async def test_regular_user_cannot_write(client: AsyncClient, user_token, shop):
    ds, path = shop
    r = await _exec(client, user_token, ds, "DELETE FROM items WHERE id = 1")
    assert r.status_code == 403
    assert len(_rows(path, "SELECT * FROM items")) == 2


async def test_whole_table_changes_need_confirmation(client: AsyncClient, admin_token, shop):
    ds, path = shop
    r = await _exec(client, admin_token, ds, "DELETE FROM items")
    assert r.status_code == 409
    assert len(_rows(path, "SELECT * FROM items")) == 2  # nothing deleted

    r = await _exec(client, admin_token, ds, "DELETE FROM items", confirm_full_table=True)
    assert r.status_code == 200 and r.json()["rows_affected"] == 2


async def test_ddl_refreshes_the_table_list(client: AsyncClient, admin_token, user_token, shop):
    ds, _ = shop
    r = await _exec(client, admin_token, ds, "CREATE TABLE notes (id INTEGER, body TEXT)")
    assert r.status_code == 200 and r.json()["schema_refreshed"] is True
    r = await client.get(
        f"/sources/{ds.id}/schema", headers={"Authorization": f"Bearer {user_token}"}
    )
    assert sorted(t["name"] for t in r.json()["tables"]) == ["items", "notes"]


async def test_dangerous_statements_stay_blocked(client: AsyncClient, admin_token, shop):
    ds, path = shop
    for sql in [
        "ATTACH DATABASE 'x.db' AS x",
        "DELETE FROM items WHERE id=1; DROP TABLE items",
        "PRAGMA writable_schema = 1",
        "DELETE FROM sqlite_master WHERE 1=1",
        "INSERT INTO missing_table VALUES (1)",
    ]:
        r = await _exec(client, admin_token, ds, sql)
        assert r.status_code == 400, sql
    assert len(_rows(path, "SELECT * FROM items")) == 2


async def test_chat_stays_read_only_for_admins(client: AsyncClient, admin_token, shop):
    ds, _ = shop
    r = await client.post(
        "/ask",
        headers={"Authorization": f"Bearer {admin_token}"},
        json={"question": "DELETE FROM items WHERE id = 1", "data_source_id": str(ds.id)},
    )
    assert r.status_code in (400, 503)  # not executed


async def test_select_in_write_mode_returns_rows(client: AsyncClient, admin_token, shop):
    ds, _ = shop
    r = await _exec(client, admin_token, ds, "SELECT name FROM items ORDER BY id")
    assert r.status_code == 200
    assert r.json()["rows"] == [["pen"], ["book"]]


async def test_host_must_not_be_a_web_link(client: AsyncClient, admin_token):
    r = await client.post(
        "/data-sources",
        headers={"Authorization": f"Bearer {admin_token}"},
        json={
            "name": "demo",
            "db_type": "postgresql",
            "port": 5432,
            "username": "postgres",
            "database_name": "postgres",
            "host": "https://supabase.com/dashboard/project/abcd",
        },
    )
    assert r.status_code == 422
    assert "server address" in r.text


async def test_unreachable_source_reports_why(
    client: AsyncClient, user_token, db_session, admin_user, tmp_path
):
    # A SQLite path inside a folder that does not exist cannot be opened
    ds = DataSource(
        user_id=admin_user.id,
        name="Broken",
        db_type="sqlite",
        database_name=str(tmp_path / "nope" / "x.db"),
        is_active=True,
    )
    db_session.add(ds)
    await db_session.commit()
    await db_session.refresh(ds)
    r = await client.get(
        f"/sources/{ds.id}/schema", headers={"Authorization": f"Bearer {user_token}"}
    )
    assert r.status_code == 502
    assert "Could not connect to the database 'Broken'" in r.json()["detail"]
