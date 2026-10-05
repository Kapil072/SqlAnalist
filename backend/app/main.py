"""
FastAPI application for SQLAnalyst.
Provides AI-powered SQL analysis, authentication, and admin panel.
"""

import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text, select

from app.config import settings
from app.db.connection import get_target_connection, get_engine
from app.db.session import engine as app_engine, AsyncSessionLocal
from app.db.base import Base
from app.models import user, otp  # noqa: F401 — ensures tables are registered
from app.utils.logger import logger
from app.core.security import get_current_user as get_current_user_dep
from app.api.routes import ask, auth, schema
from app.api.routes import admin as admin_routes
from app.api.routes import data_sources
from app.api.routes import ask_stream
from app.api.routes import chat_history
from app.api.routes import file_analysis
from app.api.routes import google_auth
from app.services.query_cache import query_cache


# ---------------------------------------------------------------------------
# Startup / shutdown lifecycle
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Create all SQLAlchemy tables if they don't exist
    async with app_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        logger.info("Database tables created / verified.")

    # Initialize query cache
    await query_cache.initialize()

    # Introspect the target DB and rebuild schema_cache.json.
    # Runs in a thread because SQLAlchemy's inspect() is synchronous.
    import asyncio
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
    from app.models.user import User
    from app.core.security import hash_password

    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(User).where(User.role == "admin").limit(1)
        )
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
            logger.info(
                f"[SEED] Default admin created: {settings.default_admin_email} "
                f"/ {settings.default_admin_password}"
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
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://localhost:8000",
        "http://127.0.0.1:3000",
    ],
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


# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------

@app.get("/health", tags=["health"])
def health_check():
    try:
        with get_engine().connect() as conn:
            target_version = conn.execute(text("SELECT VERSION()")).scalar()
            target_db_ok = True
    except Exception as exc:
        logger.error(f"Target DB health error: {exc}")
        target_db_ok = False
        target_version = None

    db_status = "healthy" if target_db_ok else "degraded"
    return {
        "status": db_status,
        "target_db": {"connected": target_db_ok, "version": target_version},
    }


# ---------------------------------------------------------------------------
# Raw SQL query endpoint  (authenticated, SELECT-only)
# ---------------------------------------------------------------------------

@app.post("/api/query", tags=["analysis"])
def run_query(
    payload: dict,
    current_user=Depends(get_current_user_dep),
):
    """Execute a raw SELECT query against the target database. Requires auth."""
    sql = payload.get("sql")
    if not sql:
        raise HTTPException(status_code=400, detail="Missing 'sql' in request payload")

    if not sql.strip().upper().startswith("SELECT"):
        raise HTTPException(status_code=400, detail="Only SELECT queries are allowed")

    start_time = time.monotonic()
    try:
        with get_target_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(sql)
            rows = cursor.fetchall()
            columns = [desc[0] for desc in cursor.description]

        timing_ms = int((time.monotonic() - start_time) * 1000)
        return {
            "columns": columns,
            "rows": rows,
            "row_count": len(rows),
            "timing_ms": timing_ms,
        }
    except Exception as exc:
        logger.error(f"Query execution error: {exc}")
        raise HTTPException(status_code=400, detail=str(exc))
