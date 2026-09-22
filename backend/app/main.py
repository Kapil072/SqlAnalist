"""
FastAPI application for SQLAnalyst.
Provides AI-powered SQL analysis, authentication, and admin panel.
"""

import os
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from sqlalchemy import text, select

from app.config import settings
from app.db.connection import get_target_connection, engine as target_engine
from app.db.session import engine as app_engine, AsyncSessionLocal
from app.db.base import Base
from app.utils.logger import logger
from app.api.routes import ask, auth, schema
from app.api.routes import admin as admin_routes
from app.api.routes import data_sources
from app.api.routes import ask_stream
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

# CORS — permissive for development (tighten for production)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include API routers
app.include_router(ask.router)
app.include_router(ask_stream.router)
app.include_router(auth.router)
app.include_router(schema.router)
app.include_router(admin_routes.router)
app.include_router(data_sources.router)


# ---------------------------------------------------------------------------
# Static frontend
# ---------------------------------------------------------------------------

FRONTEND_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "frontend")
)
if os.path.isdir(FRONTEND_DIR):
    from fastapi.staticfiles import StaticFiles
    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")


@app.get("/", include_in_schema=False)
def serve_index():
    index_path = os.path.join(FRONTEND_DIR, "index.html")
    if os.path.exists(index_path):
        return FileResponse(index_path)
    return {"message": "SQLAnalyst API is running. Visit /docs for Swagger UI."}


@app.get("/auth.html", include_in_schema=False)
def serve_auth():
    auth_path = os.path.join(FRONTEND_DIR, "auth.html")
    if os.path.exists(auth_path):
        return FileResponse(auth_path)
    raise HTTPException(status_code=404, detail="Auth page not found")


@app.get("/admin.html", include_in_schema=False)
def serve_admin():
    admin_path = os.path.join(FRONTEND_DIR, "admin.html")
    if os.path.exists(admin_path):
        return FileResponse(admin_path)
    raise HTTPException(status_code=404, detail="Admin page not found")


# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------

@app.get("/health", tags=["health"])
def health_check():
    try:
        with target_engine.connect() as conn:
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
# Simple query endpoint
# ---------------------------------------------------------------------------

@app.post("/api/query", tags=["analysis"])
def run_query(payload: dict):
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
