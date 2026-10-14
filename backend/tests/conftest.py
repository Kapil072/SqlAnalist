"""
Pytest configuration and fixtures for testing dynamic data sources.
"""

import sqlite3

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app.core.security import create_access_token, hash_password
from app.db.base import Base
from app.main import app
from app.models.data_source import DataSource
from app.models.user import User
from app.services.connection_manager import ConnectionManager

# Test database configuration
TEST_DATABASE_URL = "sqlite+aiosqlite:///:memory:"


@pytest.fixture(scope="function")
async def db_engine():
    """Create a test database engine."""
    engine = create_async_engine(
        TEST_DATABASE_URL,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    yield engine

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)

    await engine.dispose()


@pytest.fixture(scope="function")
async def db_session(db_engine):
    """Create a test database session."""
    async_session_maker = async_sessionmaker(
        bind=db_engine,
        class_=AsyncSession,
        expire_on_commit=False,
    )

    async with async_session_maker() as session:
        yield session


@pytest.fixture(scope="function")
async def client(db_session):
    """Create a test client with database dependency override."""
    from app.db.session import get_db

    async def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        yield ac

    app.dependency_overrides.clear()


@pytest.fixture(scope="function")
async def admin_user(db_session: AsyncSession):
    """Create a test admin user."""
    admin = User(
        email="admin@sqlanalyst.com",
        name="Test Admin",
        password_hash=hash_password("Admin1234"),
        role="admin",
        is_active=True,
        email_verified=True,
    )
    db_session.add(admin)
    await db_session.commit()
    await db_session.refresh(admin)
    return admin


@pytest.fixture(scope="function")
async def regular_user(db_session: AsyncSession):
    """Create a test regular user."""
    user = User(
        email="user@test.com",
        name="Test User",
        password_hash=hash_password("User1234"),
        role="user",
        is_active=True,
        email_verified=True,
    )
    db_session.add(user)
    await db_session.commit()
    await db_session.refresh(user)
    return user


@pytest.fixture(scope="function")
async def admin_token(admin_user: User):
    """Create an admin access token."""
    return create_access_token(data={"sub": str(admin_user.id), "role": admin_user.role})


@pytest.fixture(scope="function")
async def user_token(regular_user: User):
    """Create a regular user access token."""
    return create_access_token(data={"sub": str(regular_user.id), "role": regular_user.role})


@pytest.fixture(scope="function")
async def shop(db_session, admin_user, tmp_path):
    """An admin-added SQLite data source with an `items` table holding 2 rows."""
    path = tmp_path / "shop.db"
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, price INTEGER)")
    conn.executemany("INSERT INTO items (name, price) VALUES (?, ?)", [("pen", 2), ("book", 9)])
    conn.commit()
    conn.close()
    ds = DataSource(
        user_id=admin_user.id,
        name="Shop",
        db_type="sqlite",
        database_name=str(path),
        is_active=True,
    )
    db_session.add(ds)
    await db_session.commit()
    await db_session.refresh(ds)
    yield ds, str(path)
    ConnectionManager.invalidate_cache(ds.id)


@pytest.fixture(scope="function")
def shared_sessions(db_engine, monkeypatch):
    """
    Streaming routes and the audit log open their own sessions
    (AsyncSessionLocal) instead of using get_db — point them at the test DB.
    """
    from app.api.routes import admin_sql, ask_stream
    from app.core import security

    maker = async_sessionmaker(bind=db_engine, class_=AsyncSession, expire_on_commit=False)
    for module in (security, ask_stream, admin_sql):
        monkeypatch.setattr(module, "AsyncSessionLocal", maker)
    return maker
