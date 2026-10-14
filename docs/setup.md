# Getting started

This guide gets SQLAnalyst running on your computer. It takes about 10 minutes.

## What you need

| Tool | Version | Notes |
|---|---|---|
| Python | 3.11 – 3.13 | The project is developed on 3.13 |
| Node.js | 18 or 20+ | Comes with `npm` |
| Git | any | |
| A Groq API key | — | Free at [console.groq.com](https://console.groq.com). Without it you can still type `SELECT …` queries directly |
| PostgreSQL | optional | For the app's own database. SQLite works for local development |
| Redis | optional | Caches admin data-source queries. The app runs fine without it |

## 1. Backend

```powershell
# Windows PowerShell — from the project folder
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r backend\requirements.txt

cd backend
copy .env.example .env      # then edit .env (see below)
..\.venv\Scripts\uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

```bash
# macOS / Linux — from the project folder
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt

cd backend
cp .env.example .env        # then edit .env (see below)
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

> Always start the backend **from the `backend` folder** — paths such as
> `./data/analytics.db` are relative to it.

### Minimum `.env` for local development

```env
APP_ENV=development
SECRET_KEY=any-long-random-string-at-least-32-characters
DATABASE_URL=sqlite+aiosqlite:///./data/app.db      # users, chat history, audit log
TARGET_DB_URL=sqlite:///./data/analytics.db         # the database you ask questions about
GROQ_API_KEY=gsk_...                                # optional but recommended
```

`DB_ENCRYPTION_KEY` can stay empty in development: on first start a key is
generated and saved to `backend/data/.encryption_key`. Copy it into `.env`
so it never changes. See [Configuration](configuration.md) for every option.

When the server starts you should see `Application startup complete`.
Interactive API docs are at <http://localhost:8000/docs>.

On first start the backend:

1. creates the app tables (and adds any new columns to an existing database),
2. reads the tables of `TARGET_DB_URL` into `backend/data/schema_cache.json`,
3. loads the embedding model used for chat memory,
4. creates the default admin account if no admin exists
   (`DEFAULT_ADMIN_EMAIL` / `DEFAULT_ADMIN_PASSWORD`, default
   `admin@sqlanalyst.com` / `Admin1234`). **Change this password.**

## 2. Frontend

```bash
cd frontend
npm install
```

Create `frontend/.env.local`:

```env
NEXT_PUBLIC_API_URL=http://localhost:8000
NEXT_PUBLIC_GOOGLE_CLIENT_ID=            # optional, same value as GOOGLE_CLIENT_ID in the backend
```

```bash
npm run dev
```

Open <http://localhost:3000>.

> Use `localhost` for **both** the frontend and the backend. If one is
> `localhost` and the other `127.0.0.1` the browser treats them as different
> sites and will not send the login cookie, so you get logged out every 15 minutes.

## 3. First login

1. Sign in with the default admin (you can type just `admin` as the email).
2. Open **Admin → Users** to change roles, **Admin → Data Sources** to connect
   more databases (see [Databases & data sources](data-sources.md)).
3. Go back to the dashboard, pick a database in the **Database** switcher in the top bar and ask a question.

Registering a new user sends a 6-digit code by email. If SMTP is not set up and
`APP_ENV=development`, the code is shown on screen and printed in the server log.

## Running with Docker

```bash
docker compose up --build -d
```

| Service | URL |
|---|---|
| Frontend | <http://localhost:3000> |
| Backend API | <http://localhost:8000> (docs at `/docs`) |
| PostgreSQL (app database) | `localhost:5432`, user/password `postgres` |
| Redis | `localhost:6379` |

`docker-compose.yml` reads `backend/.env` and overrides `DATABASE_URL`,
`REDIS_URL`, `FRONTEND_URL` and `CORS_ORIGINS` so the containers can reach each
other. The frontend container runs the Next.js dev server.

## Checking that everything works

On Windows double-click **`check_errors.bat`** in the project folder. It runs the
backend tests, an import check, the TypeScript check and ESLint, and writes the
results to `check_results.txt`. The individual commands are listed in
[Development & testing](development.md).
