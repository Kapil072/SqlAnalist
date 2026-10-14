# Configuration

All backend settings are environment variables, read from `backend/.env`
(via `python-dotenv`) or from the real environment. Real environment variables
win over `.env`. The code lives in `backend/app/config.py`;
`backend/.env.example` is a commented template.

## Backend

### Application

| Variable | Default | Description |
|---|---|---|
| `APP_ENV` | `development` | `development` enables dev-only helpers (OTP codes and reset links shown on screen when email fails, Google dev auto-login). Use `production` for any deployed server — it also turns on the startup security checks |
| `APP_URL` | `http://localhost:8000` | Public URL of the backend. Used to build the Google OAuth callback URL |
| `FRONTEND_URL` | `http://localhost:3000` | Public URL of the frontend. Used in email links and redirects, and always allowed by CORS |
| `CORS_ORIGINS` | `http://localhost:3000,http://127.0.0.1:3000,http://localhost:8000` | Comma-separated browser origins allowed to call the API |
| `SECRET_KEY` | `change-me` | Signs every JWT. **Production: at least 32 random characters** — `python -c "import secrets; print(secrets.token_urlsafe(48))"` |
| `COOKIE_SECURE` | `true` in production, else `false` | Send the refresh-token cookie only over HTTPS |
| `RATE_LIMIT_ENABLED` | `true` | Rate limits on login, registration, OTP and password-reset endpoints |
| `ADMIN_SQL_WRITES` | `true` | Lets admins run INSERT/UPDATE/DELETE/DDL from the SQL console in write mode. `false` makes the whole app read-only |

### Tokens

| Variable | Default | Description |
|---|---|---|
| `ACCESS_TOKEN_EXPIRE_MINUTES` | `15` | Lifetime of the access token (sent as `Authorization: Bearer`) |
| `REFRESH_TOKEN_EXPIRE_DAYS` | `7` | Lifetime of the refresh token (httpOnly cookie) |
| `PASSWORD_RESET_EXPIRE_MINUTES` | `60` | Password-reset link lifetime (links are also single-use) |

### Databases

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgresql+asyncpg://postgres:postgres@localhost:5432/sqlanalyst` | The **app database**: users, OTP codes, chat history, audit log, saved data sources. Must use an async driver (`sqlite+aiosqlite:///./data/app.db` or `postgresql+asyncpg://…`) |
| `TARGET_DB_URL` | `sqlite:///./data/analytics.db` | The **default database** users ask questions about. Sync SQLAlchemy URL, e.g. `postgresql://user:pass@host/db`, `mysql+pymysql://…`, `sqlite:///./data/x.db` |
| `DB_MAX_ROWS` | `10000` | Maximum rows any query may return |
| `DB_ENCRYPTION_KEY` | *(empty)* | Fernet key that encrypts saved data-source passwords. **Required in production. Never change it** once data sources are saved — they become unreadable. In development an empty value generates one and stores it in `backend/data/.encryption_key`. Generate: `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` |
| `REDIS_URL` | `redis://localhost:6379` | Optional cache for admin data-source queries (5-minute TTL). If Redis is unreachable caching is simply off |

### AI model (Groq)

| Variable | Default | Description |
|---|---|---|
| `GROQ_API_KEY` | *(empty)* | Key from console.groq.com (starts with `gsk_`). Without it, questions must be typed as SQL (`SELECT …` / `WITH …`) and explanations use a simple built-in summary |
| `LLM_MODEL` | `llama-3.3-70b-versatile` | Model used for SQL generation and explanations |
| `LLM_BASE_URL` | `https://api.groq.com` | API base URL |
| `LLM_TEMPERATURE` | `0.0` | Temperature for SQL generation (keep at 0) |
| `LLM_MAX_TOKENS` | `500` | Max tokens for generated SQL |
| `LLM_EXPLANATION_TEMPERATURE` | `0.3` | Temperature for the plain-English explanation |
| `LLM_EXPLANATION_MAX_TOKENS` | `300` | Max tokens for the explanation |

### Email (SMTP)

Used for the 6-digit verification code and password-reset links. Port 465 uses
SSL; any other port (usually 587) uses STARTTLS. For Gmail, turn on 2-Step
Verification and create an *App password* — your normal password will not work.

| Variable | Default | Description |
|---|---|---|
| `SMTP_HOST` | *(empty)* | e.g. `smtp.gmail.com` |
| `SMTP_PORT` | `465` | `465` (SSL) or `587` (STARTTLS) |
| `SMTP_USER` | *(empty)* | Login address |
| `SMTP_PASSWORD` | *(empty)* | App password (spaces are ignored) |
| `SMTP_FROM` | `noreply@sqlanalyst.local` | From address — for Gmail use the same as `SMTP_USER` |
| `SMTP_TIMEOUT` | `15` | Seconds before giving up on the mail server |

If any of host, user or password is empty, email is "not configured": codes are
printed in the server log, and shown on screen only when `APP_ENV=development`.

**Test the settings:** from the `backend` folder run
`..\.venv\Scripts\python test_smtp.py you@example.com`. It sends one test email
and prints the exact reason if it fails (wrong app password, blocked port, wrong
host…). The same explanation is written to the server log whenever an OTP or
reset email fails.

### Logging

| Variable | Default | Description |
|---|---|---|
| `SQL_ECHO` | `false` | Print every SQL statement the app runs. Noisy — leave off unless debugging. |

### Default admin and Google sign-in

| Variable | Default | Description |
|---|---|---|
| `DEFAULT_ADMIN_EMAIL` | `admin@sqlanalyst.com` | Created on startup if no admin exists. Typing `admin` on the login screen means this email |
| `DEFAULT_ADMIN_PASSWORD` | `Admin1234` | **Change it.** Production refuses to start with the default |
| `DEFAULT_ADMIN_NAME` | `Admin` | |
| `GOOGLE_CLIENT_ID` | *(placeholder)* | OAuth client ID from Google Cloud Console. Leave unset to disable Google sign-in |
| `GOOGLE_CLIENT_SECRET` | *(empty)* | Needed for the redirect flow |

For Google sign-in add `{APP_URL}/auth/google/callback` as an authorised
redirect URI and `FRONTEND_URL` as an authorised JavaScript origin.

### Production start-up checks

With `APP_ENV=production` the backend refuses to start if `SECRET_KEY` is weak,
`DB_ENCRYPTION_KEY` is missing, or `DEFAULT_ADMIN_PASSWORD` is still the default.

## Frontend (`frontend/.env.local`)

| Variable | Description |
|---|---|
| `NEXT_PUBLIC_API_URL` | Backend URL as seen by the **browser**, e.g. `http://localhost:8000` |
| `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | Same as `GOOGLE_CLIENT_ID`; enables the Google button |

`NEXT_PUBLIC_*` values are baked in when Next.js starts or builds — restart
`npm run dev` after changing them.
