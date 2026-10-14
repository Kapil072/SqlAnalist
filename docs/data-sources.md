# Databases & data sources

SQLAnalyst can answer questions about more than one database.

| | Default database | Data sources |
|---|---|---|
| Set up by | `TARGET_DB_URL` in `backend/.env` | An admin in **Admin → Data Sources** |
| Shown in the top-bar **Database** switcher as | its file/database name, marked *(default)* | the name the admin gave it |
| Tables read | at server start-up, saved to `backend/data/schema_cache.json` | the first time someone selects it, kept in memory |
| Row counts in sidebar | yes | no (column counts instead — counting rows on large external databases is slow) |
| Who can query it | every logged-in user | every logged-in user, while the source is **active** |

## How the database picker works

1. An admin adds a database in **Admin → Data Sources** (use **Test connection**
   first). It is saved in the app database with its password encrypted.
2. Every logged-in user sees it in the **Database** switcher in the top bar
   (`GET /sources`); the sidebar shows which database is selected. Only the name and type are shown — never the host
   or credentials.
3. When a user selects it:
   - its **own tables and columns** are read and shown in the sidebar
     (`GET /sources/{id}/schema`), with example questions for those tables;
   - the conversation restarts, because earlier answers were about another database;
   - the choice is remembered in that browser.
4. Every question in the chat and every query in the SQL console is sent with
   that database's id (`data_source_id`). The backend then:
   - gives the AI **that database's schema** and tells it which SQL dialect to write
     (PostgreSQL, MySQL, SQLite, T-SQL or Oracle);
   - validates the SQL against **that database's table list** — tables from other
     databases are rejected;
   - runs the query on that database (read-only, rolled back, 30-second timeout on
     PostgreSQL and MySQL, capped at `DB_MAX_ROWS` rows).

If the database cannot be reached, the switcher dot turns red and the sidebar
and chat show why (for example *"Could not connect to the database 'demo'…"*)
instead of an empty table list.

So yes: each data source has its own schema, and the chat uses exactly that set
of tables while it is selected. Nothing is copied into the default database and
`schema_cache.json` is not touched.

## Adding a database (admin)

**Admin → Data Sources → Add**:

| Field | PostgreSQL / MySQL / SQL Server / Oracle | SQLite |
|---|---|---|
| Name | any label users will recognise | same |
| Type | `postgresql`, `mysql`, `sqlserver`, `oracle` | `sqlite` |
| Host / Port | server address and port (5432, 3306, 1433, 1521) | – |
| Username / Password | a **read-only** user, unless admins need [write mode](security.md#admin-write-mode) | – |
| Database name | database (Oracle: service name) | path to the `.db` file **on the backend machine**, e.g. `D:/data/sales.db` or `./data/sales.db` (relative to `backend/`) |

**Host is a server address, never a web link.** `https://supabase.com/dashboard/…`
is the dashboard page, not the database — the form now rejects links. For
**Supabase** open *Project → Connect* and copy:

| Field | Value |
|---|---|
| Type | `postgresql` |
| Host | the pooler host, e.g. `aws-0-ap-south-1.pooler.supabase.com` (the direct `db.<ref>.supabase.co` host is IPv6-only on many networks) |
| Port | `5432` (session pooler) |
| Username | `postgres.<project-ref>` |
| Database name | `postgres` |
| Password | your database password (Project Settings → Database) |

All connection fields — host, port, username, database, password — can be
changed later with **Edit** in the data-source list.

Drivers used: `asyncpg` (PostgreSQL), `aiomysql` (MySQL), `aiosqlite` (SQLite),
`aioodbc` (SQL Server — needs an ODBC driver installed on the server), `oracledb`
(Oracle). Usernames and passwords may contain special characters; they are
URL-encoded automatically.

## When the database's tables change

The table list of a data source is cached in memory. After tables are added or
removed:

- **Admins:** click the refresh button in the sidebar (or the top bar) while that
  database is selected (`POST /sources/{id}/refresh`). For the default database
  this rebuilds `schema_cache.json`.
- Editing the data source in the admin panel, or restarting the backend, also
  clears the cache.

## Deactivating or deleting

- **Deactivate** (toggle in the admin panel): disappears from the picker
  immediately; requests that still use its id get `400 Data source is not active`.
  Users who had it selected fall back to the default database on next load.
- **Delete**: removes it, its cached connection and its cached query results.

## Admin-only tools for data sources

The admin panel also offers, for any data source: viewing the full schema with
column defaults (`GET /data-sources/{id}/schema`) and running paginated SQL with a
5-minute Redis cache (`POST /data-sources/{id}/query`). See the [API reference](api.md).

## Security notes

- Use a database account that can only `SELECT`. The SQL validator blocks writes,
  but least privilege on the database itself is the real safety net.
- Data-source passwords are encrypted with `DB_ENCRYPTION_KEY`. Keep that key
  stable and secret — if it changes, every saved password must be re-entered.
- System schemas (`information_schema`, `pg_catalog`, `sqlite_master`, `mysql`,
  `sys`, …) are always blocked.

## Limitations

- Only tables in the connection's default schema are read (e.g. `public` in
  PostgreSQL).
- Chat history does not record which database a question was asked against.
- Changes asked for in the chat are always shown for confirmation first; they are never run automatically.
