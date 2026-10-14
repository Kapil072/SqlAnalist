"""
Tests for choosing which database the chat talks to (/sources) and for
asking questions / running SQL against an admin-added data source.
"""

import sqlite3

import pytest
from httpx import AsyncClient

from app.models.data_source import DataSource
from app.services.connection_manager import ConnectionManager


@pytest.fixture
def sales_db(tmp_path):
    """A small SQLite database used as an admin-added data source."""
    path = tmp_path / "sales.db"
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE regions (name TEXT, revenue INTEGER)")
    conn.executemany(
        "INSERT INTO regions VALUES (?, ?)", [("North", 120), ("South", 80), ("East", 60)]
    )
    conn.commit()
    conn.close()
    return str(path)


@pytest.fixture
async def sales_source(db_session, admin_user, sales_db):
    ds = DataSource(
        user_id=admin_user.id,
        name="Sales DB",
        db_type="sqlite",
        database_name=sales_db,
        is_active=True,
    )
    inactive = DataSource(
        user_id=admin_user.id,
        name="Old DB",
        db_type="sqlite",
        database_name=sales_db,
        is_active=False,
    )
    db_session.add_all([ds, inactive])
    await db_session.commit()
    await db_session.refresh(ds)
    yield ds
    ConnectionManager.invalidate_cache(ds.id)


async def test_list_sources_shows_default_and_active_only(
    client: AsyncClient, user_token, sales_source
):
    r = await client.get("/sources", headers={"Authorization": f"Bearer {user_token}"})
    assert r.status_code == 200
    sources = r.json()["sources"]
    assert sources[0]["id"] == "default" and sources[0]["is_default"]
    names = [s["name"] for s in sources]
    assert "Sales DB" in names and "Old DB" not in names
    # No connection details are exposed to regular users
    assert all(set(s) == {"id", "name", "db_type", "is_default"} for s in sources)


async def test_sources_require_login(client: AsyncClient):
    r = await client.get("/sources")
    assert r.status_code == 401


async def test_data_source_schema_is_its_own(client: AsyncClient, user_token, sales_source):
    r = await client.get(
        f"/sources/{sales_source.id}/schema", headers={"Authorization": f"Bearer {user_token}"}
    )
    assert r.status_code == 200
    body = r.json()
    assert [t["name"] for t in body["tables"]] == ["regions"]
    assert body["suggestions"]


async def test_refresh_is_admin_only(client: AsyncClient, user_token, admin_token, sales_source):
    url = f"/sources/{sales_source.id}/refresh"
    r = await client.post(url, headers={"Authorization": f"Bearer {user_token}"})
    assert r.status_code == 403
    r = await client.post(url, headers={"Authorization": f"Bearer {admin_token}"})
    assert r.status_code == 200
    assert [t["name"] for t in r.json()["tables"]] == ["regions"]


async def test_ask_uses_selected_data_source(client: AsyncClient, user_token, sales_source):
    r = await client.post(
        "/ask",
        headers={"Authorization": f"Bearer {user_token}"},
        json={
            "question": "SELECT name, revenue FROM regions ORDER BY revenue DESC",
            "data_source_id": str(sales_source.id),
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["rows"][0] == ["North", 120]
    assert body["chart"]["type"] == "pie"


async def test_sql_console_uses_selected_data_source(client: AsyncClient, user_token, sales_source):
    headers = {"Authorization": f"Bearer {user_token}"}
    r = await client.post(
        "/api/query",
        headers=headers,
        json={
            "sql": "SELECT COUNT(*) AS n FROM regions",
            "data_source_id": str(sales_source.id),
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["rows"] == [[3]]

    # Tables of OTHER databases are rejected for this source
    r = await client.post(
        "/api/query",
        headers=headers,
        json={
            "sql": "SELECT * FROM customers",
            "data_source_id": str(sales_source.id),
        },
    )
    assert r.status_code == 400


async def test_inactive_source_is_rejected(
    client: AsyncClient, user_token, db_session, sales_source
):
    sales_source.is_active = False
    await db_session.commit()
    r = await client.get(
        f"/sources/{sales_source.id}/schema", headers={"Authorization": f"Bearer {user_token}"}
    )
    assert r.status_code == 400
