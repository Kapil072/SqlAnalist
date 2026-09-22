"""
Pydantic schemas for Data Source management.
"""
import uuid
from typing import Optional
from pydantic import BaseModel, Field, field_validator


class DataSourceCreate(BaseModel):
    """Schema for creating a new data source."""
    name: str = Field(..., min_length=1, max_length=255, description="Display name for the data source")
    db_type: str = Field(..., description="Database type: postgresql, mysql, sqlite, sqlserver, oracle")
    host: Optional[str] = Field(None, description="Database host (not required for SQLite)")
    port: Optional[int] = Field(None, description="Database port (not required for SQLite)")
    username: Optional[str] = Field(None, description="Database username (not required for SQLite)")
    database_name: Optional[str] = Field(None, description="Database name")
    password: Optional[str] = Field(None, description="Database password (will be encrypted)")

    @field_validator('db_type')
    @classmethod
    def validate_db_type(cls, v):
        allowed_types = {'postgresql', 'mysql', 'sqlite', 'sqlserver', 'oracle'}
        if v.lower() not in allowed_types:
            raise ValueError(f'db_type must be one of: {", ".join(allowed_types)}')
        return v.lower()

    @field_validator('port')
    @classmethod
    def validate_port(cls, v):
        if v is not None and (v < 1 or v > 65535):
            raise ValueError('Port must be between 1 and 65535')
        return v


class DataSourceUpdate(BaseModel):
    """Schema for updating an existing data source."""
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    host: Optional[str] = None
    port: Optional[int] = None
    username: Optional[str] = None
    database_name: Optional[str] = None
    password: Optional[str] = None  # If provided, will be encrypted and updated
    is_active: Optional[bool] = None


class DataSourceResponse(BaseModel):
    """Schema for data source response (without password)."""
    id: uuid.UUID
    user_id: uuid.UUID
    name: str
    db_type: str
    host: Optional[str]
    port: Optional[int]
    username: Optional[str]
    database_name: Optional[str]
    is_active: bool
    created_at: str
    updated_at: str

    class Config:
        from_attributes = True


class DataSourceTestRequest(BaseModel):
    """Schema for testing a data source connection."""
    db_type: str
    host: Optional[str] = None
    port: Optional[int] = None
    username: Optional[str] = None
    database_name: Optional[str] = None
    password: Optional[str] = None


class DataSourceTestResponse(BaseModel):
    """Schema for connection test response."""
    success: bool
    message: str
    execution_time_ms: Optional[int] = None


class SchemaReflectionResponse(BaseModel):
    """Schema for database schema reflection."""
    tables: list
    total_tables: int


class QueryExecutionRequest(BaseModel):
    """Schema for executing a query against a data source."""
    sql: str
    max_rows: Optional[int] = Field(None, ge=1, le=10000, description="Maximum rows to return")
    page: Optional[int] = Field(1, ge=1, description="Page number for pagination")
    page_size: Optional[int] = Field(50, ge=1, le=1000, description="Number of rows per page")


class QueryExecutionResponse(BaseModel):
    """Schema for query execution response."""
    columns: list
    rows: list
    row_count: int
    timing_ms: int
    truncated: bool
    sql: str
    pagination: Optional[dict] = None  # Pagination metadata