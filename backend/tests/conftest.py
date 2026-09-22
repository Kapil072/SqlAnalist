"""
Pytest configuration and fixtures for testing dynamic data sources.
"""
import pytest
import asyncio
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker
from sqlalchemy.pool import StaticPool

from app.main import app
from app.db.base import Base
from app.models.user import User
from app.core.security import create_access_token, hash_password


# Test database configuration
TEST_DATABASE_URL = "sqlite+aiosqlite:///:memory:"


@pytest.fixture(scope="session")
def event_loop():
    """Create an instance of the default event loop for the test session."""
    loop = asyncio.get_event_loop_policy().new_event_loop()
    yield loop
    loop.close()


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

    async with AsyncClient(app=app, base_url="http://test") as ac:
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
def admin_token(admin_user: User):
    """Create an admin access token."""
    return create_access_token(data={"sub": str(admin_user.id), "role": admin_user.role})


@pytest.fixture(scope="function")
def user_token(regular_user: User):
    """Create a regular user access token."""
    return create_access_token(data={"sub": str(regular_user.id), "role": regular_user.role})