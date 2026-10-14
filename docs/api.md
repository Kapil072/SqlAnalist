# API reference

Base URL: `http://localhost:8000`. Interactive docs with request/response schemas:
`/docs` (Swagger) and `/redoc`.

**Auth column:** — = public, **User** = any logged-in user
(`Authorization: Bearer <access_token>`), **Admin** = role `admin`.

## Authentication — `/auth`

| Method | Path | Auth | Description |
|---|---|:-:|---|
| POST | `/auth/register` | — | Create an account and email a 6-digit code |
| POST | `/auth/send-otp` | — | Send a fresh code |
| POST | `/auth/verify-otp` | — | Verify the code → tokens (user is logged in) |
| POST | `/auth/login` | — | Email + password → tokens |
| POST | `/auth/refresh` | cookie | New access token from the refresh cookie |
| POST | `/auth/logout` | cookie | Revoke all of the user's tokens and clear the cookie |
| POST | `/auth/forgot-password` | — | Email a single-use reset link |
| POST | `/auth/reset-password` | — | `{token, new_password}` |
| GET | `/auth/me` | User | Current profile (includes `avatar_url`) |
| POST | `/auth/google/token` | — | `{credential}` from Google Identity Services → tokens |
| GET | `/auth/google/redirect` | — | Start the Google redirect flow |
| GET | `/auth/google/callback` | — | Google returns here; redirects to the frontend |

Token responses look like:

```json
{
  "access_token": "eyJ…",
  "token_type": "bearer",
  "user": { "id": "…", "name": "Asha", "email": "asha@example.com", "role": "user",
            "email_verified": true, "avatar_url": "https://www.gravatar.com/avatar/…" }
}
```

The refresh token is set as an httpOnly cookie — call these endpoints with
`credentials: 'include'` from the browser.

## Asking questions

| Method | Path | Auth | Description |
|---|---|:-:|---|
| POST | `/ask/stream` | User | Question → Server-Sent Events (`meta`, `token`…, `done` or `error`; for admins asking for a change: `confirm`) |
| POST | `/ask` | User | Same, single JSON response |
| POST | `/api/query` | User | Run a SELECT directly (SQL console) |

Request body for `/ask` and `/ask/stream`:

```json
{
  "question": "Top 5 customers by revenue",
  "session_id": "optional — keeps conversation memory",
  "data_source_id": "optional — a data source id; omit for the default database"
}
```

`/api/query`: `{"sql": "SELECT …", "data_source_id": "optional"}`.

When an **admin** asks for a change ("delete order 12", or types `DELETE …`), nothing is run:
the stream sends a `confirm` event `{sql, kind, full_table, database, data_source_id}` and
the app runs the statement through `POST /admin/sql/execute` only after the admin clicks
**Run change**. Regular users get an `error` event instead.

`meta` event / `/ask` response fields: `sql_query`, `columns`, `rows`,
`row_count`, `truncated`, `timing_ms`, `chart` (`{type, title, x_axis, y_axis}`
or `null`), `engine_used` (`groq-llm` or `direct-sql`), `session_id`.

Common errors: `400 Safety Check Failed: …` (validator), `400` / `404` unknown
or inactive data source, `502 Could not connect to the database '…'` (wrong host,
port, user or password), `503` Groq key not configured (only when the question
is not SQL), `502` Groq request failed.

## Databases the user can choose

| Method | Path | Auth | Description |
|---|---|:-:|---|
| GET | `/sources` | User | Default database + active data sources (`id`, `name`, `db_type`, `is_default`) |
| GET | `/sources/{id}/schema` | User | `{tables: [{name, row_count, columns}], suggestions}` — `id` is `default` or a data-source id |
| POST | `/sources/{id}/refresh` | Admin | Re-read that database's tables |
| GET | `/api/schema` | User | Schema of the default database (kept for compatibility) |
| POST | `/api/schema/refresh` | Admin | Re-read the default database |

## Uploaded files

| Method | Path | Auth | Description |
|---|---|:-:|---|
| POST | `/api/analyze-file` | User | Multipart `file` (CSV / XLSX / XLS, ≤ 10 MB) → summary, preview, `file_session_id` |
| POST | `/api/ask-file` | User | `{question, file_session_id}` → SSE like `/ask/stream` |

## Chat history

| Method | Path | Auth | Description |
|---|---|:-:|---|
| GET | `/chat/history?limit=30` | User | Latest saved turns (max 200) |
| POST | `/chat/save` | User | `{question, sql_query, explanation, engine_used, session_id}` |
| DELETE | `/chat/history` | User | Delete all of the user's history |

## Administration — `/admin`

| Method | Path | Auth | Description |
|---|---|:-:|---|
| GET | `/admin/stats` | Admin | User counts and query success/failure totals |
| GET | `/admin/users?skip=&limit=` | Admin | Users (with `avatar_url`) |
| PATCH | `/admin/users/{id}` | Admin | `{role?, is_active?}` — admins cannot be demoted |
| POST | `/admin/sql/execute` | Admin | Write mode: `{sql, data_source_id?, confirm_full_table?}` → `{kind, rows_affected, timing_ms, schema_refreshed, database}`. `409` = whole-table change needs `confirm_full_table: true`. See [Security](security.md#admin-write-mode) |
| GET | `/admin/audit-logs?status=&skip=&limit=` | Admin | Query audit trail (`status` = `success` / `error`) |

## Data sources — `/data-sources` (admin management)

| Method | Path | Auth | Description |
|---|---|:-:|---|
| GET | `/data-sources` | Admin | List with connection details (never passwords) |
| POST | `/data-sources` | Admin | Create |
| GET | `/data-sources/{id}` | Admin | Details |
| PATCH | `/data-sources/{id}` | Admin | Update any field, including `host`, `port`, `username`, `database_name`, `is_active` and `password` |
| DELETE | `/data-sources/{id}` | Admin | Delete (also clears caches) |
| POST | `/data-sources/test` | Admin | Test connection settings without saving |
| GET | `/data-sources/{id}/schema` | Admin | Tables and columns with types, nullability, defaults |
| POST | `/data-sources/{id}/query` | Admin | `{sql, max_rows?, page?, page_size?}` — validated, paginated, cached 5 min in Redis |

Create body:

```json
{
  "name": "Sales (Postgres)",
  "db_type": "postgresql",
  "host": "db.internal",
  "port": 5432,
  "username": "readonly_user",
  "password": "…",
  "database_name": "sales"
}
```

`db_type`: `postgresql`, `mysql`, `sqlite`, `sqlserver`, `oracle`. `host` must
be a plain server address — web links and connection strings are rejected with `422`. For SQLite
only `database_name` (the file path) is required.

## Health

| Method | Path | Auth | Description |
|---|---|:-:|---|
| GET | `/health` | — | `{status, target_db: {connected, version}}` — status is `healthy` or `degraded` for the default database |
