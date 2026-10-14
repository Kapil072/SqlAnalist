# Development & testing

## Running the checks

| What | Command (from the project folder) |
|---|---|
| Everything at once (Windows) | double-click `check_errors.bat` → `check_results.txt` |
| Backend tests | `cd backend` then `..\.venv\Scripts\python -m pytest -q` (Windows) or `python -m pytest -q` |
| Backend import check | `cd backend` then `python -c "import app.main"` |
| Type check (frontend) | `cd frontend` then `npx tsc --noEmit` |
| Lint (frontend) | `cd frontend` then `npm run lint` |
| Format backend | `cd backend` then `ruff format . && ruff check --fix .` (settings in `backend/pyproject.toml`) |
| Format frontend | `cd frontend` then `npm run format` (Prettier, settings in `.prettierrc.json`) |
| Production build (frontend) | `cd frontend` then `npm run build` — stop `npm run dev` first, both use `.next/` |

Run pytest from **inside `backend/`** — `pytest.ini` and the `app` package live there.

### Test suite (`backend/tests`)

| File | Covers |
|---|---|
| `test_sql_validator.py` | The 11 SQL checks: blocked statements, comments, system tables, CTEs, `UNION`, string literals, row caps for SQLite / SQL Server / Oracle |
| `test_auth_flow.py` | Register → code → login → refresh → logout revocation, code lockout, single-use reset links, dev-only helpers, Google fallback, avatars, `/api/query` safety |
| `test_sources.py` | Database picker: listing, per-source schema, admin-only refresh, `/ask` and `/api/query` against a data source, inactive sources |
| `test_data_sources.py` | Admin data-source CRUD, encryption, connection URLs, query cache |
| `test_chat_changes.py` | Admins asking for a change in the chat get a confirmation (never auto-run), users are refused, the audit log records changes |
| `test_admin_sql.py` | Admin write mode (insert/update/delete, confirmations, DDL refresh, blocked statements), host validation, connection-error messages |

Tests use an in-memory SQLite app database (`tests/conftest.py`) and never send
email. They need no Groq key, Redis or network.

### Type checking (mypy)

`mypy.ini` in the project folder tells mypy that the `app` package lives in
`backend/`. The VS Code Mypy extension picks it up automatically.

## Conventions

- **One query path.** All "ask" and "run SQL" endpoints use
  `services/query_pipeline.py` (`resolve_context`, `generate_sql`, `run_query`,
  `infer_chart`). Change behaviour there, not in individual routes.
- **Always validate.** Never execute SQL that has not gone through
  `validate_sql(sql, dialect=…, allowed_tables=…)`.
- **Never block the event loop.** Groq calls, pandas work and the synchronous
  default-database executor run via `asyncio.to_thread()`.
- **Dialect names** come from `services/sql_dialect.py` (`tsql` for SQL Server).
- **Browser-facing errors** go through `public_error()` so production hides
  driver messages.
- **New columns on existing tables:** add the model field and a line to
  `_COLUMN_MIGRATIONS` in `main.py` (until Alembic migrations are introduced).
- **Frontend API calls** go through `authFetch()` / `apiPost()` in `lib/api.ts`,
  which handle tokens, cookies and silent refresh.

## Adding an endpoint

1. Add a route in `backend/app/api/routes/<area>.py` (or a new file, then
   `app.include_router(...)` in `main.py`).
2. Protect it with `Depends(get_current_user)` or `Depends(require_admin)`.
3. Add a test in `backend/tests/`.
4. Add a typed helper in `frontend/lib/api.ts`.
5. Document it in [api.md](api.md).

## Reference data not used by the code yet

`backend/docs/` contains schema descriptions, a business glossary and few-shot
examples for the sample analytics database. They are not loaded by the backend
today; they are a starting point for improving SQL generation.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Logged out every ~15 minutes | Use `localhost` for both frontend and backend (not one `127.0.0.1`); check `CORS_ORIGINS` includes the frontend URL |
| "Groq LLM API key is not configured" | Set `GROQ_API_KEY` (starts with `gsk_`), or type the question as SQL |
| "Table not in whitelist" | The table is not in the selected database, or its tables changed — admin: click refresh in the sidebar |
| "Stored password cannot be decrypted" | `DB_ENCRYPTION_KEY` changed — re-enter the data source's password in the admin panel |
| OTP email never arrives | Check SMTP settings; in development the code is in the server log |
| `429 Too Many Requests` on login | Rate limit — wait a minute |
| VS Code shows "Cannot find implementation … app.xxx" | Make sure `mypy.ini` is in the project folder and reload VS Code |
| Server refuses to start: "Insecure production configuration" | Fix the listed settings, see [Security](security.md#production-checklist) |
| Data source added but not in the switcher | It must be **active**; reload the dashboard |
| Red dot / "Could not connect to the database" | Fix host, port, user, database or password with **Edit** in Admin → Data Sources. Host is a server address, not a web link |
| Admin change fails with "permission denied" | The database account is read-only — give it write rights or use another account |
| "UPDATE/DELETE without WHERE…" confirmation | Intended: whole-table changes need a second confirmation |
| "Other rows still point to this row (foreign key)" | Delete or update the rows that reference it first (e.g. order items before the order) |
| Excel upload fails | `pip install -r backend/requirements.txt` (needs `openpyxl` / `xlrd`) |
| Admin panel shows 0 queries / empty audit log | Fixed: SQLite could not number audit rows. Restart the backend once; it repairs the table |
