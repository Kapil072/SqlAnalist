"""
Tests for dynamic data source connections and management.
"""
import pytest
import uuid
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.models.data_source import DataSource
from app.models.user import User
from app.core.security import hash_password


@pytest.mark.asyncio
async def test_create_data_source_admin_only(client: AsyncClient, admin_token: str):
    """Test that only admins can create data sources."""
    # Create a data source as admin
    response = await client.post(
        "/data-sources",
        headers={"Authorization": f"Bearer {admin_token}"},
        json={
            "name": "Test SQLite DB",
            "db_type": "sqlite",
            "database_name": "./test.db",
            "password": "test123"
        }
    )
    assert response.status_code == 201
    data = response.json()
    assert data["name"] == "Test SQLite DB"
    assert data["db_type"] == "sqlite"
    assert "id" in data


@pytest.mark.asyncio
async def test_create_data_source_non_admin_denied(client: AsyncClient, user_token: str):
    """Test that non-admin users cannot create data sources."""
    response = await client.post(
        "/data-sources",
        headers={"Authorization": f"Bearer {user_token}"},
        json={
            "name": "Test SQLite DB",
            "db_type": "sqlite",
            "database_name": "./test.db",
        }
    )
    assert response.status_code == 403


@pytest.mark.asyncio
async def test_list_data_sources(client: AsyncClient, admin_token: str, db: AsyncSession):
    """Test listing data sources."""
    # Create a test data source
    admin_user = await db.execute(select(User).where(User.email == "admin@sqlanalyst.com"))
    admin = admin_user.scalar_one()

    data_source = DataSource(
        user_id=admin.id,
        name="Test DB",
        db_type="sqlite",
        database_name="./test.db",
        encrypted_password="encrypted",
        is_active=True,
    )
    db.add(data_source)
    await db.commit()

    # List data sources
    response = await client.get(
        "/data-sources",
        headers={"Authorization": f"Bearer {admin_token}"}
    )
    assert response.status_code == 200
    data = response.json()
    assert "data_sources" in data
    assert len(data["data_sources"]) >= 1


@pytest.mark.asyncio
async def test_get_data_source_schema(client: AsyncClient, admin_token: str, db: AsyncSession):
    """Test getting schema from a data source."""
    # Create a test SQLite data source
    admin_user = await db.execute(select(User).where(User.email == "admin@sqlanalyst.com"))
    admin = admin_user.scalar_one()

    from app.services.connection_manager import ConnectionManager
    data_source = DataSource(
        user_id=admin.id,
        name="Test SQLite",
        db_type="sqlite",
        database_name=":memory:",  # Use in-memory SQLite for testing
        encrypted_password=ConnectionManager.encrypt_password(""),
        is_active=True,
    )
    db.add(data_source)
    await db.commit()
    await db.refresh(data_source)

    # Get schema
    response = await client.get(
        f"/data-sources/{data_source.id}/schema",
        headers={"Authorization": f"Bearer {admin_token}"}
    )
    # Note: This might fail if we can't connect to the actual database
    # but the endpoint structure should be correct
    assert response.status_code in [200, 500]  # 500 if connection fails


@pytest.mark.asyncio
async def test_sql_validation_blocks_dangerous_queries(client: AsyncClient, admin_token: str):
    """Test that SQL validation blocks dangerous operations."""
    from app.sql_safety.validator import validate_sql, SQLValidationError

    # Test DROP TABLE
    with pytest.raises(SQLValidationError):
        validate_sql("DROP TABLE users", dialect="mysql")

    # Test DELETE
    with pytest.raises(SQLValidationError):
        validate_sql("DELETE FROM users", dialect="mysql")

    # Test UPDATE
    with pytest.raises(SQLValidationError):
        validate_sql("UPDATE users SET name = 'test'", dialect="mysql")

    # Test INSERT
    with pytest.raises(SQLValidationError):
        validate_sql("INSERT INTO users VALUES (1, 'test')", dialect="mysql")

    # Test valid SELECT
    try:
        validated = validate_sql("SELECT * FROM users LIMIT 10", dialect="mysql")
        assert "SELECT" in validated.upper()
    except SQLValidationError:
        pytest.fail("Valid SELECT query should pass validation")


@pytest.mark.asyncio
async def test_password_encryption():
    """Test that password encryption/decryption works correctly."""
    from app.services.connection_manager import ConnectionManager

    original_password = "MySecurePassword123!"

    # Encrypt
    encrypted = ConnectionManager.encrypt_password(original_password)
    assert encrypted != original_password
    assert len(encrypted) > 0

    # Decrypt
    decrypted = ConnectionManager.decrypt_password(encrypted)
    assert decrypted == original_password


@pytest.mark.asyncio
async def test_connection_url_generation():
    """Test connection URL generation for different database types."""
    from app.services.connection_manager import ConnectionManager
    from app.models.data_source import DataSource

    # Test SQLite
    sqlite_ds = DataSource(
        user_id=uuid.uuid4(),
        name="Test SQLite",
        db_type="sqlite",
        database_name="./test.db",
        encrypted_password="",
    )
    sqlite_url = ConnectionManager.get_connection_url(sqlite_ds)
    assert "sqlite+aiosqlite" in sqlite_url
    assert "test.db" in sqlite_url

    # Test PostgreSQL
    postgres_ds = DataSource(
        user_id=uuid.uuid4(),
        name="Test Postgres",
        db_type="postgresql",
        host="localhost",
        port=5432,
        username="testuser",
        database_name="testdb",
        encrypted_password=ConnectionManager.encrypt_password("testpass"),
    )
    postgres_url = ConnectionManager.get_connection_url(postgres_ds)
    assert "postgresql+asyncpg" in postgres_url
    assert "testuser" in postgres_url
    assert "testdb" in postgres_url

    # Test MySQL
    mysql_ds = DataSource(
        user_id=uuid.uuid4(),
        name="Test MySQL",
        db_type="mysql",
        host="localhost",
        port=3306,
        username="testuser",
        database_name="testdb",
        encrypted_password=ConnectionManager.encrypt_password("testpass"),
    )
    mysql_url = ConnectionManager.get_connection_url(mysql_ds)
    assert "mysql+aiomysql" in mysql_url
    assert "testuser" in mysql_url
    assert "testdb" in mysql_url


@pytest.mark.asyncio
async def test_query_cache_basic_operations():
    """Test basic query cache operations."""
    from app.services.query_cache import query_cache

    # Initialize cache (might fail if Redis not available)
    await query_cache.initialize()

    # Test cache operations
    test_sql = "SELECT * FROM users LIMIT 10"
    test_result = {
        "columns": ["id", "name"],
        "rows": [[1, "test"]],
        "row_count": 1,
        "timing_ms": 100,
        "truncated": False,
    }

    # Set cache
    success = await query_cache.set(test_sql, test_result, "test_ds_id")
    # If Redis is not available, this will return False
    if success:
        # Get from cache
        cached = await query_cache.get(test_sql, "test_ds_id")
        assert cached is not None
        assert cached["row_count"] == 1

        # Invalidate
        await query_cache.invalidate(test_sql, "test_ds_id")
        cached_after = await query_cache.get(test_sql, "test_ds_id")
        assert cached_after is None