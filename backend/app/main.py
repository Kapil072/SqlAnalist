"""
FastAPI application for SQLAnalyst.
Provides AI-powered SQL analysis, authentication, and admin panel.
"""

import asyncio
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.routes import admin as admin_routes
from app.api.routes import (
    admin_sql,
    ask,
    ask_stream,
    auth,
    chat_history,
    data_sources,
    file_analysis,
    google_auth,
    schema,
)
from app.api.routes import sources as sources_routes
from app.config import settings, validate_production_settings
from app.core.rate_limit import install_rate_limiter
from app.core.security import get_current_user as get_current_user_dep
from app.db.base import Base
from app.db.connection import get_engine
from app.db.session import AsyncSessionLocal, get_db
from app.db.session import engine as app_engine
from app.models import otp, user  # noqa: F401 — ensures tables are registered
from app.services.query_cache import query_cache
from app.services.query_pipeline import (
    load_active_data_source,
    public_error,
    resolve_context,
)
from app.services.query_pipeline import (
    run_query as run_pipeline_query,
)
from app.sql_safety.validator import SQLValidationError, validate_sql
from app.utils.logger import logger

# Fail fast on insecure production configuration (weak SECRET_KEY, missing
# DB_ENCRYPTION_KEY, default admin password, ...).
validate_production_settings(settings)


# Columns added after the first release. create_all() does not alter existing
# tables, so add them here if missing. (Long term: move to Alembic migrations.)
_COLUMN_MIGRATIONS = [
    ("users", "avatar_url", "TEXT"),
    ("users", "token_version", "INTEGER NOT NULL DEFAULT 0"),
    ("otp_codes", "attempts", "INTEGER NOT NULL DEFAULT 0"),
]


# ---------------------------------------------------------------------------
# Startup / shutdown lifecycle
# ---------------------------------------------------------------------------


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Create all SQLAlchemy tables if they don't exist
    async with app_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

        def _sync_columns(sync_conn):
            from sqlalchemy import inspect

            inspector = inspect(sync_conn)
            existing_tables = set(inspector.get_table_names())
            for table, column, ddl in _COLUMN_MIGRATIONS:
                if table not in existing_tables:
                    continue
                columns = {c["name"] for c in inspector.get_columns(table)}
                if column in columns:
                    continue
                try:
                    sync_conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}"))
                    logger.info(f"[MIGRATION] Added {table}.{column}")
                except Exception as e:
                    logger.warning(f"[MIGRATION] {table}.{column}: {e}")

        await conn.run_sync(_sync_columns)

        def _fix_sqlite_audit_ids(sync_conn):
            """
            Older SQLite databases created audit_logs.id as BIGINT, which SQLite
            does not auto-number, so no audit row could ever be written.
            Rebuild the table with an INTEGER key, keeping existing rows.
            """
            if sync_conn.dialect.name != "sqlite":
                return
            row = sync_conn.execute(
                text("SELECT sql FROM sqlite_master WHERE type='table' AND name='audit_logs'")
            ).fetchone()
            if not row or "id BIGINT" not in (row[0] or ""):
                return
            sync_conn.execute(text("ALTER TABLE audit_logs RENAME TO audit_logs_old"))
            for idx in (
                "ix_audit_logs_user_id",
                "ix_audit_logs_session_id",
                "ix_audit_logs_status",
                "ix_audit_logs_created_at",
            ):
                sync_conn.execute(text(f"DROP INDEX IF EXISTS {idx}"))
            from app.models.audit_log import AuditLog

            AuditLog.__table__.create(sync_conn)
            sync_conn.execute(
                text(
                    "INSERT INTO audit_logs (user_id, session_id, question, sql_used, row_count, "
                    "status, error_msg, timing_ms, created_at) "
                    "SELECT user_id, session_id, question, sql_used, row_count, status, "
                    "error_msg, timing_ms, created_at FROM audit_logs_old"
                )
            )
            sync_conn.execute(text("DROP TABLE audit_logs_old"))
            logger.info("[MIGRATION] Rebuilt audit_logs with an auto-numbered id (SQLite).")

        await conn.run_sync(_fix_sqlite_audit_ids)
        logger.info("Database tables created / verified.")

    # Initialize query cache
    await query_cache.initialize()

    # Introspect the target DB and rebuild schema_cache.json.
    # Runs in a thread because SQLAlchemy's inspect() is synchronous.
    from app.db.schema_registry import refresh_schema

    try:
        schema = await asyncio.to_thread(refresh_schema)
        logger.info(f"[SCHEMA] Auto-refresh at startup: {list(schema.get('tables', {}).keys())}")
    except Exception as e:
        logger.warning(f"[SCHEMA] Startup schema refresh failed (non-fatal): {e}")

    # Pre-warm the RAG embedding model in a thread so the first real
    # request doesn't pay the 3-5s cold-load cost.
    from app.langchain_chains.rag_memory import warmup as rag_warmup

    try:
        await asyncio.to_thread(rag_warmup)
        logger.info("[RAG] Embedding model warmed up.")
    except Exception as e:
        logger.warning(f"[RAG] Warmup failed (non-fatal): {e}")

    # Seed a default admin user if no admin exists yet
    await _seed_default_admin()

    yield  # app runs here

    logger.info("Application shutdown.")


async def _seed_default_admin():
    from app.core.security import hash_password
    from app.models.user import User

    async with AsyncSessionLocal() as db:
        result = await db.execute(select(User).where(User.role == "admin").limit(1))
        if result.scalar_one_or_none() is None:
            admin = User(
                email=settings.default_admin_email,
                name=settings.default_admin_name,
                password_hash=hash_password(settings.default_admin_password),
                role="admin",
                is_active=True,
                email_verified=True,
            )
            db.add(admin)
            await db.commit()
            # Never log the password itself
            logger.info(f"[SEED] Default admin created: {settings.default_admin_email}")
            if settings.default_admin_password == "Admin1234":
                logger.warning(
                    "[SEED] The default admin password is still the built-in default — change it!"
                )


# ---------------------------------------------------------------------------
# Application setup
# ---------------------------------------------------------------------------

app = FastAPI(
    title="SQLAnalyst API",
    description="AI-powered SQL analyst with authentication and admin panel.",
    version="2.0.0",
    lifespan=lifespan,
)

# CORS — list explicit origins for production
# In development we allow localhost:3000 (Next.js) and localhost:8000 (API docs)
install_rate_limiter(app)

# CORS — configured with CORS_ORIGINS (comma-separated) + FRONTEND_URL
_cors_origins = sorted({*settings.cors_origins, settings.frontend_url.rstrip("/")})
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include API routers
app.include_router(ask.router)
app.include_router(ask_stream.router)
app.include_router(auth.router)
app.include_router(google_auth.router)
app.include_router(schema.router)
app.include_router(admin_routes.router)
app.include_router(data_sources.router)
app.include_router(chat_history.router)
app.include_router(file_analysis.router)
app.include_router(sources_routes.router)
app.include_router(admin_sql.router)


# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------


@app.get("/health", tags=["health"])
def health_check():
    """Liveness + target-DB connectivity. Works on every supported database."""
    target_version = None
    try:
        engine = get_engine()
        with engine.connect() as conn:
            conn.execute(
                text("SELECT 1" if engine.dialect.name != "oracle" else "SELECT 1 FROM dual")
            )
            info = engine.dialect.server_version_info
            version = ".".join(str(p) for p in info) if info else ""
            target_version = f"{engine.dialect.name} {version}".strip()
        target_db_ok = True
    except Exception as exc:
        logger.error(f"Target DB health error: {exc}")
        target_db_ok = False

    return {
        "status": "healthy" if target_db_ok else "degraded",
        "target_db": {"connected": target_db_ok, "version": target_version},
    }


# ---------------------------------------------------------------------------
# Raw SQL query endpoint  (authenticated, read-only, fully validated)
# ---------------------------------------------------------------------------


class RawQueryRequest(BaseModel):
    sql: str
    # "default"/None = TARGET_DB_URL, otherwise the id of an active data source
    data_source_id: str | None = None


@app.post("/api/query", tags=["analysis"])
async def run_query(
    payload: RawQueryRequest,
    current_user=Depends(get_current_user_dep),
    db: AsyncSession = Depends(get_db),
):
    """
    Execute a raw SELECT query against the default target database or a
    data source added by an admin. The SQL goes through the same 11-check
    validator as /ask (single statement, no DDL/DML, whitelisted tables of
    THAT database, row cap) and runs in a transaction that is always rolled back.
    """
    if not payload.sql or not payload.sql.strip():
        raise HTTPException(status_code=400, detail="Missing 'sql' in request payload")

    data_source = None
    if payload.data_source_id and payload.data_source_id != "default":
        data_source = await load_active_data_source(db, payload.data_source_id)
    dialect, _schema, allowed_tables = await resolve_context(data_source)

    try:
        safe_sql = validate_sql(payload.sql, dialect=dialect, allowed_tables=allowed_tables)
    except SQLValidationError as exc:
        raise HTTPException(status_code=400, detail=f"Safety Check Failed: {exc.message}")

    try:
        res = await run_pipeline_query(safe_sql, data_source)
    except Exception as exc:
        logger.error(f"Query execution error: {exc}")
        raise HTTPException(status_code=400, detail=public_error("Query execution failed", exc))

    return {
        "sql": safe_sql,
        "columns": res.columns,
        "rows": res.rows,
        "row_count": res.row_count,
        "truncated": res.truncated,
        "timing_ms": res.timing_ms,
    }
