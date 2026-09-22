"""
Data Source API endpoints for managing dynamic database connections.
All endpoints require admin privileges.
"""
import uuid
import time
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func

from app.db.session import get_db
from app.models.user import User
from app.models.data_source import DataSource
from app.core.security import require_admin
from app.services.connection_manager import ConnectionManager
from app.services.query_cache import query_cache
from app.schemas.data_source import (
    DataSourceCreate,
    DataSourceUpdate,
    DataSourceResponse,
    DataSourceTestRequest,
    DataSourceTestResponse,
    SchemaReflectionResponse,
    QueryExecutionRequest,
    QueryExecutionResponse,
)
from app.utils.logger import logger

router = APIRouter(prefix="/data-sources", tags=["data-sources"])


# ---------------------------------------------------------------------------
# Data Source CRUD Operations
# ---------------------------------------------------------------------------

@router.post("", response_model=DataSourceResponse, status_code=201)
async def create_data_source(
    data_source: DataSourceCreate,
    current_admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Create a new data source connection (admin only)."""
    # Validate required fields based on db_type
    if data_source.db_type != "sqlite":
        if not all([data_source.host, data_source.port, data_source.username, data_source.database_name]):
            raise HTTPException(
                status_code=400,
                detail="host, port, username, and database_name are required for non-SQLite databases"
            )
    else:
        if not data_source.database_name:
            raise HTTPException(status_code=400, detail="database_name is required for SQLite")

    # Encrypt the password
    encrypted_password = None
    if data_source.password:
        encrypted_password = ConnectionManager.encrypt_password(data_source.password)

    new_data_source = DataSource(
        user_id=current_admin.id,
        name=data_source.name,
        db_type=data_source.db_type,
        host=data_source.host,
        port=data_source.port,
        username=data_source.username,
        database_name=data_source.database_name,
        encrypted_password=encrypted_password,
        is_active=True,
    )

    db.add(new_data_source)
    await db.commit()
    await db.refresh(new_data_source)

    logger.info(f"[DATA_SOURCE] Created new data source: {new_data_source.name} by admin {current_admin.email}")
    return DataSourceResponse(
        id=new_data_source.id,
        user_id=new_data_source.user_id,
        name=new_data_source.name,
        db_type=new_data_source.db_type,
        host=new_data_source.host,
        port=new_data_source.port,
        username=new_data_source.username,
        database_name=new_data_source.database_name,
        is_active=new_data_source.is_active,
        created_at=new_data_source.created_at.isoformat(),
        updated_at=new_data_source.updated_at.isoformat(),
    )


@router.get("", response_model=dict)
async def list_data_sources(
    current_admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
):
    """List all data sources (admin only)."""
    result = await db.execute(
        select(DataSource).order_by(DataSource.created_at.desc()).offset(skip).limit(limit)
    )
    data_sources = result.scalars().all()
    total = (await db.execute(select(func.count()).select_from(DataSource))).scalar_one()

    return {
        "total": total,
        "skip": skip,
        "limit": limit,
        "data_sources": [
            DataSourceResponse(
                id=ds.id,
                user_id=ds.user_id,
                name=ds.name,
                db_type=ds.db_type,
                host=ds.host,
                port=ds.port,
                username=ds.username,
                database_name=ds.database_name,
                is_active=ds.is_active,
                created_at=ds.created_at.isoformat(),
                updated_at=ds.updated_at.isoformat(),
            )
            for ds in data_sources
        ],
    }


@router.get("/{data_source_id}", response_model=DataSourceResponse)
async def get_data_source(
    data_source_id: str,
    current_admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Get a specific data source by ID (admin only)."""
    try:
        data_source_uuid = uuid.UUID(data_source_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid data source ID format")

    result = await db.execute(
        select(DataSource).where(DataSource.id == data_source_uuid)
    )
    data_source = result.scalar_one_or_none()

    if not data_source:
        raise HTTPException(status_code=404, detail="Data source not found")

    return DataSourceResponse(
        id=data_source.id,
        user_id=data_source.user_id,
        name=data_source.name,
        db_type=data_source.db_type,
        host=data_source.host,
        port=data_source.port,
        username=data_source.username,
        database_name=data_source.database_name,
        is_active=data_source.is_active,
        created_at=data_source.created_at.isoformat(),
        updated_at=data_source.updated_at.isoformat(),
    )


@router.patch("/{data_source_id}", response_model=DataSourceResponse)
async def update_data_source(
    data_source_id: str,
    update_data: DataSourceUpdate,
    current_admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Update a data source (admin only)."""
    try:
        data_source_uuid = uuid.UUID(data_source_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid data source ID format")

    result = await db.execute(
        select(DataSource).where(DataSource.id == data_source_uuid)
    )
    data_source = result.scalar_one_or_none()

    if not data_source:
        raise HTTPException(status_code=404, detail="Data source not found")

    # Update fields if provided
    if update_data.name is not None:
        data_source.name = update_data.name
    if update_data.host is not None:
        data_source.host = update_data.host
    if update_data.port is not None:
        data_source.port = update_data.port
    if update_data.username is not None:
        data_source.username = update_data.username
    if update_data.database_name is not None:
        data_source.database_name = update_data.database_name
    if update_data.password is not None:
        data_source.encrypted_password = ConnectionManager.encrypt_password(update_data.password)
    if update_data.is_active is not None:
        data_source.is_active = update_data.is_active

    db.add(data_source)
    await db.commit()
    await db.refresh(data_source)

    # Clear query cache for this data source since connection details changed
    await query_cache.invalidate_data_source(str(data_source.id))

    logger.info(f"[DATA_SOURCE] Updated data source: {data_source.name} by admin {current_admin.email}")
    return DataSourceResponse(
        id=data_source.id,
        user_id=data_source.user_id,
        name=data_source.name,
        db_type=data_source.db_type,
        host=data_source.host,
        port=data_source.port,
        username=data_source.username,
        database_name=data_source.database_name,
        is_active=data_source.is_active,
        created_at=data_source.created_at.isoformat(),
        updated_at=data_source.updated_at.isoformat(),
    )


@router.delete("/{data_source_id}", status_code=204)
async def delete_data_source(
    data_source_id: str,
    current_admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Delete a data source (admin only)."""
    try:
        data_source_uuid = uuid.UUID(data_source_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid data source ID format")

    result = await db.execute(
        select(DataSource).where(DataSource.id == data_source_uuid)
    )
    data_source = result.scalar_one_or_none()

    if not data_source:
        raise HTTPException(status_code=404, detail="Data source not found")

    await db.delete(data_source)
    await db.commit()

    # Clear from connection manager cache
    from app.services.connection_manager import get_engine_cache
    engine_cache = get_engine_cache()
    if data_source_uuid in engine_cache:
        del engine_cache[data_source_uuid]

    # Clear query cache for this data source
    await query_cache.invalidate_data_source(str(data_source_uuid))

    logger.info(f"[DATA_SOURCE] Deleted data source: {data_source.name} by admin {current_admin.email}")


# ---------------------------------------------------------------------------
# Connection Testing
# ---------------------------------------------------------------------------

@router.post("/test", response_model=DataSourceTestResponse)
async def test_data_source_connection(
    test_request: DataSourceTestRequest,
    current_admin: User = Depends(require_admin),
):
    """Test a data source connection without saving it (admin only)."""
    start_time = time.monotonic()

    try:
        # Create a temporary DataSource object for testing
        temp_source = DataSource(
            user_id=current_admin.id,
            name="Test Connection",
            db_type=test_request.db_type,
            host=test_request.host,
            port=test_request.port,
            username=test_request.username,
            database_name=test_request.database_name,
            encrypted_password=ConnectionManager.encrypt_password(test_request.password) if test_request.password else None,
        )

        # Try to get an engine (this will test the connection)
        engine = ConnectionManager.get_engine(temp_source)

        # Test the connection with a simple query
        async with engine.connect() as conn:
            from sqlalchemy import text
            if test_request.db_type == "postgresql":
                await conn.execute(text("SELECT 1"))
            elif test_request.db_type == "mysql":
                await conn.execute(text("SELECT 1"))
            elif test_request.db_type == "sqlite":
                await conn.execute(text("SELECT 1"))
            elif test_request.db_type == "sqlserver":
                await conn.execute(text("SELECT 1"))
            elif test_request.db_type == "oracle":
                await conn.execute(text("SELECT 1 FROM dual"))

        execution_time_ms = int((time.monotonic() - start_time) * 1000)

        return DataSourceTestResponse(
            success=True,
            message="Connection successful",
            execution_time_ms=execution_time_ms,
        )

    except Exception as e:
        execution_time_ms = int((time.monotonic() - start_time) * 1000)
        logger.error(f"[DATA_SOURCE] Connection test failed: {e}")
        return DataSourceTestResponse(
            success=False,
            message=f"Connection failed: {str(e)}",
            execution_time_ms=execution_time_ms,
        )


# ---------------------------------------------------------------------------
# Schema Reflection
# ---------------------------------------------------------------------------

@router.get("/{data_source_id}/schema", response_model=SchemaReflectionResponse)
async def get_data_source_schema(
    data_source_id: str,
    current_admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Get the database schema for a specific data source (admin only)."""
    try:
        data_source_uuid = uuid.UUID(data_source_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid data source ID format")

    result = await db.execute(
        select(DataSource).where(DataSource.id == data_source_uuid)
    )
    data_source = result.scalar_one_or_none()

    if not data_source:
        raise HTTPException(status_code=404, detail="Data source not found")

    if not data_source.is_active:
        raise HTTPException(status_code=400, detail="Data source is not active")

    try:
        from sqlalchemy import inspect

        engine = ConnectionManager.get_engine(data_source)

        # Use SQLAlchemy's Inspector to get schema
        async with engine.connect() as conn:
            inspector = inspect(conn)
            tables = inspector.get_table_names()

            schema_data = []
            for table_name in tables:
                columns = []
                try:
                    column_info = inspector.get_columns(table_name)
                    for col in column_info:
                        columns.append({
                            "name": col["name"],
                            "type": str(col["type"]),
                            "nullable": col.get("nullable", True),
                            "default": col.get("default"),
                        })
                except Exception as e:
                    logger.warning(f"Failed to get columns for table {table_name}: {e}")
                    columns = []

                schema_data.append({
                    "name": table_name,
                    "columns": columns
                })

        return SchemaReflectionResponse(
            tables=schema_data,
            total_tables=len(schema_data),
        )

    except Exception as e:
        logger.error(f"[DATA_SOURCE] Schema reflection failed for {data_source.name}: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to reflect schema: {str(e)}")


# ---------------------------------------------------------------------------
# Query Execution
# ---------------------------------------------------------------------------

@router.post("/{data_source_id}/query", response_model=QueryExecutionResponse)
async def execute_query_on_data_source(
    data_source_id: str,
    query_request: QueryExecutionRequest,
    current_admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Execute a SQL query against a specific data source (admin only)."""
    try:
        data_source_uuid = uuid.UUID(data_source_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid data source ID format")

    result = await db.execute(
        select(DataSource).where(DataSource.id == data_source_uuid)
    )
    data_source = result.scalar_one_or_none()

    if not data_source:
        raise HTTPException(status_code=404, detail="Data source not found")

    if not data_source.is_active:
        raise HTTPException(status_code=400, detail="Data source is not active")

    # Validate SQL for safety
    from app.sql_safety.validator import validate_sql, SQLValidationError

    try:
        # Determine dialect based on db_type
        dialect_map = {
            "postgresql": "postgres",
            "mysql": "mysql",
            "sqlite": "sqlite",
            "sqlserver": "mssql",
            "oracle": "oracle",
        }
        dialect = dialect_map.get(data_source.db_type, "mysql")

        validated_sql = validate_sql(query_request.sql, dialect=dialect)
    except SQLValidationError as e:
        raise HTTPException(status_code=400, detail=f"SQL validation failed: {e.message}")

    try:
        from app.config import settings

        # Check cache first
        cached_result = await query_cache.get(validated_sql, data_source_id)

        if cached_result:
            logger.info(f"[DATA_SOURCE] Returning cached result for query on {data_source.name}")
            return QueryExecutionResponse(
                columns=cached_result["columns"],
                rows=cached_result["rows"],
                row_count=cached_result["row_count"],
                timing_ms=cached_result["timing_ms"],
                truncated=cached_result["truncated"],
                sql=validated_sql,
            )

        engine = ConnectionManager.get_engine(data_source)
        max_rows = query_request.max_rows or settings.db_max_rows
        page = query_request.page
        page_size = query_request.page_size

        start_time = time.monotonic()

        async with engine.connect() as conn:
            from sqlalchemy import text
            # Set timeout for PostgreSQL
            if data_source.db_type == "postgresql":
                try:
                    await conn.execute(text("SET statement_timeout = '30s'"))
                except Exception:
                    pass

            # For pagination, we need to modify the SQL to include OFFSET/LIMIT
            # But to keep it safe, we'll fetch all rows up to max_rows and paginate in memory
            # This ensures we respect the max_rows cap while providing pagination
            result = await conn.execute(text(validated_sql))

            columns = []
            rows = []
            truncated = False
            total_count = 0

            if result.returns_rows:
                columns = list(result.keys())
                # Fetch all rows up to max_rows for pagination
                raw_rows = result.fetchmany(max_rows + 1)
                total_count = len(raw_rows)

                if len(raw_rows) > max_rows:
                    raw_rows = raw_rows[:max_rows]
                    truncated = True

                # Apply pagination in memory
                start_idx = (page - 1) * page_size
                end_idx = start_idx + page_size
                paginated_rows = raw_rows[start_idx:end_idx]

                rows = [list(row) for row in paginated_rows]

            timing_ms = int((time.monotonic() - start_time) * 1000)

            logger.info(
                f"[DATA_SOURCE] Query executed on {data_source.name}: "
                f"{len(rows)} rows (page {page}) in {timing_ms}ms (truncated={truncated})"
            )

            # Cache the result (cache paginated result to save memory)
            cache_data = {
                "columns": columns,
                "rows": rows,
                "row_count": len(rows),
                "timing_ms": timing_ms,
                "truncated": truncated,
            }
            await query_cache.set(validated_sql, cache_data, data_source_id)

            # Calculate pagination metadata
            total_pages = (total_count + page_size - 1) // page_size if total_count > 0 else 0

            return QueryExecutionResponse(
                columns=columns,
                rows=rows,
                row_count=len(rows),
                timing_ms=timing_ms,
                truncated=truncated,
                sql=validated_sql,
                pagination={
                    "page": page,
                    "page_size": page_size,
                    "total_count": total_count,
                    "total_pages": total_pages,
                    "has_next": page < total_pages,
                    "has_prev": page > 1,
                } if total_count > 0 else None,
            )

    except Exception as e:
        logger.error(f"[DATA_SOURCE] Query execution failed on {data_source.name}: {e}")
        raise HTTPException(status_code=500, detail=f"Query execution failed: {str(e)}")