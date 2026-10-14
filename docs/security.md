# Security

## Accounts and login

| Flow | How it works |
|---|---|
| Register | Name, email, password (≥ 8 chars, one uppercase letter, one digit). A 6-digit code is emailed |
| Verify code | `POST /auth/verify-otp`. Codes come from Python's `secrets` module, expire after 10 minutes and are burned after **5 wrong tries** |
| Login | Email + password (bcrypt, cost 12). Typing `admin` means `DEFAULT_ADMIN_EMAIL`. Unverified accounts are asked for a code |
| Google | ID-token popup (`/auth/google/token`) or redirect flow (`/auth/google/redirect` → `/callback`). Only Google-verified emails are accepted |
| Forgot password | Emails a reset link valid for `PASSWORD_RESET_EXPIRE_MINUTES`. Links are **single-use** — they stop working once the password changes |
| Reset password | Sets the new password and **logs the user out everywhere** |

### Development-only helpers

Only when `APP_ENV=development`:

- if an email cannot be sent, the code / reset link is returned to the browser
  and shown on screen;
- if Google is not configured, "Sign in with Google" logs in as `SMTP_USER`
  (or `user@gmail.com`).

In any other environment these never happen — otherwise anyone could take over
an account whenever email delivery failed.

### Sessions and tokens

- **Access token**: JWT (HS256, `SECRET_KEY`), 15 minutes, sent as
  `Authorization: Bearer …`, stored in the browser's `localStorage`.
- **Refresh token**: JWT, 7 days, httpOnly `SameSite=Lax` cookie (`Secure` in
  production). `POST /auth/refresh` issues a new pair; the frontend does this
  silently when the access token expires.
- **Revocation**: every token carries the user's `token_version`. Logout and
  password reset increase it, which instantly invalidates every token issued
  before — on all devices.
- The Google redirect flow puts the access token in the URL **fragment**
  (`#token=…`), which browsers never send to servers, and the page removes it
  from the address bar immediately.

### Rate limits (per IP, via `slowapi`)

| Endpoint | Limit |
|---|---|
| `/auth/register`, `/auth/send-otp`, `/auth/forgot-password` | 5 / minute |
| `/auth/login`, `/auth/verify-otp`, `/auth/reset-password`, `/auth/google/token` | 10 / minute |
| `/auth/refresh` | 30 / minute |

Exceeding a limit returns `429 Too Many Requests`. Disable with
`RATE_LIMIT_ENABLED=false` (for example in load tests). Behind a reverse proxy,
make sure the real client IP is forwarded, or all users share one limit.

### Roles

- `user`: chat, SQL console, file upload, own chat history.
- `admin`: everything above plus the admin panel, data sources and schema refresh.
- Admins can promote users; admins cannot be demoted and cannot deactivate
  themselves.

## The SQL safety engine (11 checks)

Every query — written by the AI, typed by a user, or generated for an uploaded
file — passes through `sql_safety/validator.py` before it reaches a database.

| # | Check |
|---|---|
| 1 | No comments (`--`, `/* */`) outside string values |
| 2 | No semicolons (one trailing `;` is removed first) |
| 3 | Must start with `SELECT` or `WITH` |
| 4 | No dangerous keywords: `DROP`, `DELETE`, `UPDATE`, `INSERT`, `ALTER`, `CREATE`, `TRUNCATE`, `GRANT`, `EXEC`, `INTO`, `ATTACH`, `PRAGMA`, `COPY`, `SLEEP`, `PG_READ_FILE`, … |
| 5 | Must parse cleanly with `sqlglot` in the target dialect |
| 6 | Exactly one statement |
| 7 | The statement is a `SELECT` (including `WITH … SELECT` and `UNION`) |
| 8 | No insert/update/delete/DDL/command node anywhere in the syntax tree |
| 9 | No system schemas or tables (`information_schema`, `pg_catalog`, `sqlite_master`, `mysql`, `sys`, …) |
| 10 | Every table must belong to the database being queried (CTE names are allowed) |
| 11 | A row cap is enforced: `LIMIT` / `TOP` / `FETCH FIRST`, at most `DB_MAX_ROWS` |

Checks 1–4 ignore text inside quotes, so `WHERE status = 'open -- now'` or a
column called `close` is fine. On top of the validator, queries run in a
transaction that is always rolled back, with a statement timeout; uploaded files
live in a SQLite database switched to `query_only`.

## Admin write mode

Regular users are **always read-only**. Admins can change data in two ways:

- **SQL console → Write mode**: type the statement and run it.
- **Chat**: ask in plain words ("delete the order with id 12", "add a product called Pen")
  or type the statement. The AI writes the SQL, the chat shows it in a yellow card with
  **Run change** / **Cancel**, and nothing happens until the admin clicks **Run change**.

Both go through the same checks:

- Allowed: `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `CREATE`/`DROP` `TABLE`|`VIEW`|`INDEX`,
  `ALTER TABLE`, `TRUNCATE TABLE` — one statement at a time, on the database selected
  in the top bar.
- Never allowed, even for admins: `GRANT`/`REVOKE`, `DROP`/`CREATE DATABASE` or
  `SCHEMA`, `EXEC`/`CALL`, `ATTACH`/`PRAGMA`, `COPY`, file access, sleep functions,
  comments, several statements chained with `;`, system tables, tables that don't exist.
- Every change asks for confirmation in the browser. `UPDATE`/`DELETE` without
  `WHERE`, `TRUNCATE` and `DROP` need a **second** confirmation (the API answers
  `409` until `confirm_full_table: true` is sent).
- Each statement runs in its own transaction (committed on success, rolled back on
  error, 60-second timeout on PostgreSQL) and is written to the audit log as
  `[ADMIN WRITE]`. After `CREATE`/`DROP`/`ALTER` the table list is refreshed.
- The database account itself must be allowed to write. With a read-only account
  the statement fails with a permission error — that is the database protecting itself.
- Turn the feature off completely with `ADMIN_SQL_WRITES=false`.

## Data protection

- Passwords: bcrypt. Data-source passwords: Fernet (`DB_ENCRYPTION_KEY`).
- Error messages sent to the browser hide driver details when
  `APP_ENV=production`.
- Conversation memory and uploaded files are private to the user who created them.
- Regular users never see data-source hosts, usernames or passwords.

## Production checklist

- [ ] `APP_ENV=production`
- [ ] `SECRET_KEY` — 32+ random characters
- [ ] `DB_ENCRYPTION_KEY` set, backed up, never rotated casually
- [ ] `DEFAULT_ADMIN_PASSWORD` changed (or the admin's password changed after first login)
- [ ] HTTPS in front of both frontend and backend; `COOKIE_SECURE=true`
- [ ] `FRONTEND_URL`, `APP_URL`, `CORS_ORIGINS` set to the real domains
- [ ] SMTP configured, so codes are emailed
- [ ] Read-only database accounts for `TARGET_DB_URL` and every data source — or, if admins need write mode, a separate account with only the write rights they need
- [ ] `ADMIN_SQL_WRITES=false` if admins should never change data from the app
- [ ] PostgreSQL for `DATABASE_URL`; backups enabled
- [ ] Run without `--reload`
