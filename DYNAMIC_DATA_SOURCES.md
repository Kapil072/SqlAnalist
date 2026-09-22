# Dynamic SQL Data Source Connections - Implementation Guide

## Overview

This implementation adds dynamic SQL data source connections to the sqlanalyst application, allowing users to connect to multiple databases dynamically with enhanced security and performance features.

## Key Features Implemented

### 1. Dynamic Database Connections
- **Model**: `DataSource` model stores connection details securely with encrypted passwords
- **Service**: `ConnectionManager` handles dynamic connection creation with LRU caching
- **API**: Full CRUD endpoints for managing data sources (admin-only)
- **Support**: PostgreSQL, MySQL, SQLite, SQL Server, and Oracle

### 2. Security Enhancements
- **Password Encryption**: Uses Fernet encryption for stored database passwords
- **Read-Only Enforcement**: Enhanced SQL validator blocks DROP, DELETE, UPDATE, INSERT, ALTER, TRUNCATE
- **Admin-Only Access**: Only admin users can manage data sources
- **Query Timeouts**: 30-second timeout for PostgreSQL queries

### 3. Performance Optimizations
- **Query Caching**: Redis-based caching with 5-minute TTL for repeated queries
- **Connection Pooling**: LRU cache for database engine reuse
- **Pagination**: Cursor-based pagination for large result sets (default 50 rows/page)
- **Row Limits**: Strict enforcement of `db_max_rows` (default 10,000)

### 4. Dynamic Schema Reflection
- Automatic schema discovery using SQLAlchemy Inspector
- Returns table names, column details, types, and metadata
- Supports all major database types

## New API Endpoints

### Data Source Management (Admin Only)

#### POST /data-sources
Create a new data source connection.

```json
{
  "name": "Production Postgres",
  "db_type": "postgresql",
  "host": "localhost",
  "port": 5432,
  "username": "admin",
  "database_name": "analytics",
  "password": "secure_password"
}
```

#### GET /data-sources
List all data sources with pagination.

#### GET /data-sources/{id}
Get specific data source details.

#### PATCH /data-sources/{id}
Update data source configuration.

#### DELETE /data-sources/{id}
Delete a data source and clear cached connections.

#### POST /data-sources/test
Test a connection without saving it.

```json
{
  "db_type": "postgresql",
  "host": "localhost",
  "port": 5432,
  "username": "admin",
  "database_name": "analytics",
  "password": "secure_password"
}
```

### Schema & Query Operations

#### GET /data-sources/{id}/schema
Get database schema for a specific data source.

#### POST /data-sources/{id}/query
Execute a SQL query against a specific data source.

```json
{
  "sql": "SELECT * FROM users LIMIT 100",
  "max_rows": 1000,
  "page": 1,
  "page_size": 50
}
```

### Updated /ask Endpoint

The existing `/ask` endpoint now supports an optional `data_source_id` parameter:

```json
{
  "question": "Show me top customers by revenue",
  "data_source_id": "uuid-of-data-source",
  "session_id": "optional-session-id"
}
```

## Configuration

### Environment Variables

Add these to your `.env` file:

```bash
# Database password encryption (required for production)
DB_ENCRYPTION_KEY=your-encryption-key-here

# Generate with: openssl rand -base64 32
```

### Dependencies Added

```txt
cryptography==44.0.0          # Password encryption
aiomysql==0.2.0              # MySQL async support
aioodbc==0.5.0               # SQL Server async support
oracledb==2.4.0              # Oracle async support
```

## Database Schema

### New Table: data_sources

```sql
CREATE TABLE data_sources (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id),
    name VARCHAR(255) NOT NULL,
    db_type VARCHAR(50) NOT NULL,
    host VARCHAR(255),
    port INTEGER,
    username VARCHAR(255),
    database_name VARCHAR(255),
    encrypted_password TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

## Security Considerations

### Password Encryption
- Passwords are encrypted using Fernet symmetric encryption
- Encryption key must be set via `DB_ENCRYPTION_KEY` environment variable
- For development, a key is auto-generated (with warning)
- Never commit the encryption key to version control

### Read-Only Enforcement
- SQL validator enhanced to block all DML operations
- Check 8 in validator now includes TRUNCATE
- Error messages clearly indicate read-only restrictions
- Timeouts prevent long-running queries

### Access Control
- All data source endpoints require admin role
- Non-admin users receive 403 Forbidden
- Data sources are user-scoped for future multi-tenancy

## Usage Examples

### Adding a PostgreSQL Data Source

```bash
curl -X POST http://localhost:8000/data-sources \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Production Analytics",
    "db_type": "postgresql",
    "host": "prod-db.example.com",
    "port": 5432,
    "username": "analytics_user",
    "database_name": "analytics",
    "password": "secure_password"
  }'
```

### Querying a Dynamic Data Source

```bash
curl -X POST http://localhost:8000/data-sources/{id}/query \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "sql": "SELECT COUNT(*) as total_users FROM users",
    "page": 1,
    "page_size": 50
  }'
```

### Using Dynamic Data Source in /ask Endpoint

```bash
curl -X POST http://localhost:8000/ask \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "question": "What are the top 5 products by revenue?",
    "data_source_id": "uuid-of-your-data-source"
  }'
```

## Testing

### Running Tests

```bash
cd backend
pytest tests/test_data_sources.py -v
```

### Test Coverage

- Admin-only access control
- Password encryption/decryption
- Connection URL generation
- SQL validation (blocking dangerous queries)
- Query cache operations
- Schema reflection
- CRUD operations

## Performance Features

### Query Caching
- Identical queries within 5 minutes return cached results
- Cache keys include data source ID and SQL hash
- Automatic cache invalidation on data source updates/deletion
- Redis-based for scalability (fallback to no caching if Redis unavailable)

### Pagination
- Default page size: 50 rows
- Configurable via `page_size` parameter (1-1000)
- Returns pagination metadata:
  - `page`, `page_size`, `total_count`, `total_pages`
  - `has_next`, `has_prev` for navigation

### Connection Pooling
- LRU cache for database engines
- Prevents connection overhead for repeated queries
- Automatic cleanup on data source deletion

## Troubleshooting

### Redis Connection Issues
If Redis is not available, query caching will be disabled automatically. Check logs for:
```
[QUERY_CACHE] Redis connection failed, caching disabled
```

### Encryption Key Warnings
If you see:
```
[CONNECTION_MANAGER] Using auto-generated encryption key
```
Set the `DB_ENCRYPTION_KEY` environment variable for production.

### Connection Pool Exhaustion
If you experience connection issues, consider:
1. Increasing database connection limits
2. Reducing `db_max_rows` for queries
3. Implementing connection timeout settings

## Migration Guide

### For Existing Applications

1. **Update Dependencies**:
   ```bash
   pip install -r requirements.txt
   ```

2. **Set Environment Variables**:
   ```bash
   export DB_ENCRYPTION_KEY=$(openssl rand -base64 32)
   ```

3. **Run Database Migrations**:
   The new `data_sources` table will be created automatically on application startup.

4. **Update Frontend**:
   - Add data source management UI (admin only)
   - Update query interface to allow data source selection
   - Implement pagination controls for large result sets

### Frontend Integration

Add these new API calls to your frontend:

```javascript
// List data sources
const getDataSources = async () => {
  const response = await fetch('/data-sources', {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  return response.json();
};

// Create data source
const createDataSource = async (data) => {
  const response = await fetch('/data-sources', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(data)
  });
  return response.json();
};

// Get schema
const getSchema = async (dataSourceId) => {
  const response = await fetch(`/data-sources/${dataSourceId}/schema`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  return response.json();
};

// Execute query
const executeQuery = async (dataSourceId, sql, page = 1) => {
  const response = await fetch(`/data-sources/${dataSourceId}/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ sql, page, page_size: 50 })
  });
  return response.json();
};
```

## Future Enhancements

Potential improvements for future iterations:

1. **Connection Health Monitoring**: Regular health checks for data sources
2. **Query History**: Track and cache frequently used queries per user
3. **Advanced Caching**: Implement cache warming for popular queries
4. **Multi-User Data Sources**: Share data sources between users with permissions
5. **Connection Throttling**: Rate limiting per data source to prevent overload
6. **Query Optimization**: Automatic query suggestion and optimization
7. **Data Source Groups**: Organize data sources by environment/team

## Support

For issues or questions:
1. Check the application logs for detailed error messages
2. Verify Redis is running if caching is not working
3. Ensure database credentials are correct and encrypted properly
4. Review SQL validation logs for blocked queries

## License

This implementation maintains the same license as the parent sqlanalyst project.