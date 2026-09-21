import os
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy import inspect
from cryptography.fernet import Fernet
from app.models.data_source import DataSource

# Ensure we have an encryption key (in production, this should come from env)
ENCRYPTION_KEY = os.getenv("DB_ENCRYPTION_KEY", Fernet.generate_key().decode())
fernet = Fernet(ENCRYPTION_KEY.encode())

# In-memory cache for engines to avoid creating new connections constantly
_engine_cache = {}

class ConnectionManager:
    @staticmethod
    def encrypt_password(password: str) -> str:
        return fernet.encrypt(password.encode()).decode()

    @staticmethod
    def decrypt_password(encrypted_password: str) -> str:
        if not encrypted_password:
            return ""
        return fernet.decrypt(encrypted_password.encode()).decode()

    @staticmethod
    def get_connection_url(data_source: DataSource) -> str:
        # Reconstruct the connection URL based on db_type
        password = ConnectionManager.decrypt_password(data_source.encrypted_password)
        if data_source.db_type == "sqlite":
            return f"sqlite+aiosqlite:///{data_source.database_name}"
        elif data_source.db_type == "postgresql":
            return f"postgresql+asyncpg://{data_source.username}:{password}@{data_source.host}:{data_source.port}/{data_source.database_name}"
        elif data_source.db_type == "mysql":
            return f"mysql+aiomysql://{data_source.username}:{password}@{data_source.host}:{data_source.port}/{data_source.database_name}"
        raise ValueError(f"Unsupported db_type: {data_source.db_type}")

    @staticmethod
    def get_engine(data_source: DataSource):
        if data_source.id in _engine_cache:
            return _engine_cache[data_source.id]

        url = ConnectionManager.get_connection_url(data_source)
        engine = create_async_engine(
            url,
            pool_pre_ping=True,
            # We use NullPool for dynamic external connections if we don't want to hold them open
            # But for performance, standard pooling is fine
        )
        _engine_cache[data_source.id] = engine
        return engine

    @staticmethod
    def get_session_maker(data_source: DataSource):
        engine = ConnectionManager.get_engine(data_source)
        return async_sessionmaker(bind=engine, class_=AsyncSession, expire_on_commit=False)
