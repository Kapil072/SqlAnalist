"""
Pydantic schemas for Data Source management.
"""

import uuid

from pydantic import BaseModel, ConfigDict, Field, field_validator


def clean_host(v):
    """
    The host must be a server address (e.g. db.abcd.supabase.co or 10.0.0.5),
    not a web page link or a full connection string.
    """
    if v is None:
        return v
    v = v.strip()
    if not v:
        return None
    if "://" in v or "/" in v or "@" in v or " " in v:
        raise ValueError(
            "Host must be only the server address, e.g. 'db.<project-ref>.supabase.co' or "
            "'aws-0-<region>.pooler.supabase.com' — not a web link or a full connection string. "
            "In Supabase: Project → Connect → Connection string shows the host, port, user and database."
        )
    return v


class DataSourceCreate(BaseModel):
    """Schema for creating a new data source."""

    name: str = Field(
        ..., min_length=1, max_length=255, description="Display name for the data source"
    )
    db_type: str = Field(
        ..., description="Database type: postgresql, mysql, sqlite, sqlserver, oracle"
    )
    host: str | None = Field(None, description="Database host (not required for SQLite)")
    port: int | None = Field(None, description="Database port (not required for SQLite)")
    username: str | None = Field(None, description="Database username (not required for SQLite)")
    database_name: str | None = Field(None, description="Database name")
    password: str | None = Field(None, description="Database password (will be encrypted)")

    @field_validator("db_type")
    @classmethod
    def validate_db_type(cls, v):
        allowed_types = {"postgresql", "mysql", "sqlite", "sqlserver", "oracle"}
        if v.lower() not in allowed_types:
            raise ValueError(f"db_type must be one of: {', '.join(allowed_types)}")
        return v.lower()

    @field_validator("port")
    @classmethod
    def validate_port(cls, v):
        if v is not None and (v < 1 or v > 65535):
            raise ValueError("Port must be between 1 and 65535")
        return v

    @field_validator("host")
    @classmethod
    def validate_host(cls, v):
        return clean_host(v)


class DataSourceUpdate(BaseModel):
    """Schema for updating an existing data source."""

    name: str | None = Field(None, min_length=1, max_length=255)
    host: str | None = None
    port: int | None = None
    username: str | None = None
    database_name: str | None = None
    password: str | None = None  # If provided, will be encrypted and updated
    is_active: bool | None = None

    @field_validator("host")
    @classmethod
    def validate_host(cls, v):
        return clean_host(v)


class DataSourceResponse(BaseModel):
    """Schema for data source response (without password)."""

    id: uuid.UUID
    user_id: uuid.UUID
    name: str
    db_type: str
    host: str | None
    port: int | None
    username: str | None
    database_name: str | None
    is_active: bool
    created_at: str
    updated_at: str
    model_config = ConfigDict(from_attributes=True)


class DataSourceTestRequest(BaseModel):
    """Schema for testing a data source connection."""

    db_type: str
    host: str | None = None
    port: int | None = None
    username: str | None = None
    database_name: str | None = None
    password: str | None = None

    @field_validator("host")
    @classmethod
    def validate_host(cls, v):
        return clean_host(v)


class DataSourceTestResponse(BaseModel):
    """Schema for connection test response."""

    success: bool
    message: str
    execution_time_ms: int | None = None


class SchemaReflectionResponse(BaseModel):
    """Schema for database schema reflection."""

    tables: list
    total_tables: int


class QueryExecutionRequest(BaseModel):
    """Schema for executing a query against a data source."""

    sql: str
    max_rows: int | None = Field(None, ge=1, le=10000, description="Maximum rows to return")
    page: int | None = Field(1, ge=1, description="Page number for pagination")
    page_size: int | None = Field(50, ge=1, le=1000, description="Number of rows per page")


class QueryExecutionResponse(BaseModel):
    """Schema for query execution response."""

    columns: list
    rows: list
    row_count: int
    timing_ms: int
    truncated: bool
    sql: str
    pagination: dict | None = None  # Pagination metadata
