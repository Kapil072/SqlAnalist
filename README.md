# SQLAnalyst AI 🚀
### Ask your databases questions in plain English

[![Python](https://img.shields.io/badge/Python-3.11%20%7C%203.12%20%7C%203.13-blue.svg)](https://www.python.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.141-009688.svg)](https://fastapi.tiangolo.com)
[![Next.js](https://img.shields.io/badge/Next.js-14.2-black.svg)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue.svg)](https://www.typescriptlang.org/)
[![TailwindCSS](https://img.shields.io/badge/TailwindCSS-3.4-38B2AC.svg)](https://tailwindcss.com/)

SQLAnalyst turns business questions into safe, **read-only** SQL, runs them
against the database you choose, and answers with a table, a chart and a
short explanation streamed in real time.

📚 **Full documentation: [`docs/`](docs/README.md)**

---

## 🌟 Features

- **Chat with your data** — questions become SQL via Groq (`llama-3.3-70b-versatile`),
  results stream back over Server-Sent Events with an automatic chart
  (line for dates, pie for a few categories, bar otherwise).
- **Several databases, one picker** — the default database (`TARGET_DB_URL`)
  plus any PostgreSQL, MySQL, SQLite, SQL Server or Oracle database an admin adds.
  Users switch between them in the top bar; the AI and the safety checks use **that
  database's own tables**. → [Databases & data sources](docs/data-sources.md)
- **11-check SQL safety engine** (`sqlglot`) — single read-only `SELECT`, no
  system tables, only that database's tables, enforced row cap, always rolled back.
- **SQL console** for typing queries directly, with the same safety checks.
  Admins can tick **Write mode** to run `INSERT`/`UPDATE`/`DELETE`/`CREATE`/`ALTER`/`DROP`,
  or simply ask the chat ("delete order 12") — every change is shown first and runs only
  after the admin confirms it. Regular users stay read-only.
- **CSV / Excel analysis** — upload a file (≤ 10 MB) and ask questions about it.
- **Conversation memory** — earlier answers in the same chat inform new ones
  (sentence-transformers + FAISS, per user).
- **Accounts** — email + 6-digit code verification, Google sign-in, single-use
  password-reset links, silent token refresh, logout that revokes every session,
  profile pictures from Google or Gravatar.
- **Admin panel** — usage stats, user management, full audit log, data-source
  management with connection testing.
- **Hardened** — rate-limited auth endpoints, encrypted data-source passwords,
  production start-up checks. → [Security](docs/security.md)

## 🏛 Architecture

```text
 Browser (Next.js 14, React 18, Tailwind, Chart.js)
        │  REST + SSE, Bearer token + httpOnly refresh cookie
        ▼
 FastAPI backend ──► Groq LLM (SQL + explanations)
   │        │
   │        ├──► Default database (TARGET_DB_URL)        ┐ read-only,
   │        └──► Data sources added by admins            ┘ validated SQL
   │
   ├──► App database (DATABASE_URL): users, codes, chat history, audit log, data sources
   └──► Redis (optional): cache for admin data-source queries
```

Details: [Architecture](docs/architecture.md).

## 🚀 Quick start

**Backend** (from the project folder):

```powershell
python -m venv 
.\.venv\Scripts\Activate.ps1            # macOS/Linux: source .venv/bin/activate
pip install -r backend\requirements.txt
cd backend
copy .env.example .env                  # macOS/Linux: cp .env.example .env — then edit it
..\.venv\Scripts\uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Minimum `.env` for local use:

```env
APP_ENV=development
SECRET_KEY=any-long-random-string-at-least-32-characters
DATABASE_URL=sqlite+aiosqlite:///./data/app.db
TARGET_DB_URL=sqlite:///./data/analytics.db
GROQ_API_KEY=gsk_...
```

**Frontend:**

Create `frontend/.env.local` containing `NEXT_PUBLIC_API_URL=http://localhost:8000`, then:

```bash
cd frontend
npm install
npm run dev
```

Open <http://localhost:3000> and sign in as `admin` / `Admin1234`
(**change this password**). API docs: <http://localhost:8000/docs>.

Use `localhost` for both apps (not `127.0.0.1` for one of them), or the login
cookie is not sent. Full guide: [Getting started](docs/setup.md).

**Docker:** `docker compose up --build -d` (PostgreSQL app database, Redis,
backend on :8000, frontend on :3000).

## ⚙ Configuration

All settings are environment variables in `backend/.env` — see
[`backend/.env.example`](backend/.env.example) and
[Configuration](docs/configuration.md). The most important:

| Variable | Purpose |
|---|---|
| `APP_ENV` | `development` or `production` (production enables strict start-up checks) |
| `SECRET_KEY` | Signs login tokens — 32+ random characters in production |
| `DATABASE_URL` | App database (async URL: `sqlite+aiosqlite://…` or `postgresql+asyncpg://…`) |
| `TARGET_DB_URL` | Default database users ask about |
| `DB_ENCRYPTION_KEY` | Encrypts saved data-source passwords — set once, never change |
| `GROQ_API_KEY` | Enables AI SQL generation and explanations |
| `SMTP_*` | Email for verification codes and reset links |
| `FRONTEND_URL`, `CORS_ORIGINS` | Where the frontend runs |

Frontend (`frontend/.env.local`): `NEXT_PUBLIC_API_URL`, optional `NEXT_PUBLIC_GOOGLE_CLIENT_ID`.

## 🧪 Tests & checks

```bash
cd backend && python -m pytest -q        # 58 tests, no network or API key needed
cd frontend && npx tsc --noEmit && npm run lint
cd backend && ruff format . && ruff check .      # formatting / lint (backend)
cd frontend && npm run format                    # formatting (frontend)
```

On Windows, `check_errors.bat` runs all of these and writes `check_results.txt`.
More: [Development & testing](docs/development.md).

## 📁 Project structure

```text
sqlanalyst/
├── backend/
│   ├── app/
│   │   ├── api/routes/     auth, google_auth, ask, ask_stream, sources, schema,
│   │   │                   file_analysis, chat_history, admin, data_sources
│   │   ├── core/           security (JWT, passwords), email, rate limiting, avatars
│   │   ├── db/             default-database engine, executor, schema cache
│   │   ├── langchain_chains/  LLM prompts, conversation memory
│   │   ├── models/ schemas/   database tables, request/response models
│   │   ├── services/       query pipeline, data-source connections, file sessions, cache
│   │   ├── sql_safety/     11-check SQL validator
│   │   ├── config.py       settings
│   │   └── main.py         app entry point
│   ├── tests/              pytest suite
│   ├── .env.example
│   └── requirements.txt
├── frontend/
│   ├── app/                auth/, dashboard/ (chat, SQL console), admin/
│   ├── components/         Navbar (database switcher), Sidebar (schema), ChartBlock, Avatar
│   └── lib/api.ts          API client
├── docs/                   full documentation
├── docker-compose.yml
└── mypy.ini
```

## 📡 API at a glance

| Area | Endpoints |
|---|---|
| Auth | `/auth/register`, `/auth/send-otp`, `/auth/verify-otp`, `/auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/forgot-password`, `/auth/reset-password`, `/auth/me`, `/auth/google/*` |
| Questions | `POST /ask/stream` (SSE), `POST /ask`, `POST /api/query` — all accept optional `data_source_id` |
| Databases | `GET /sources`, `GET /sources/{id}/schema`, `POST /sources/{id}/refresh` (admin) |
| Files | `POST /api/analyze-file`, `POST /api/ask-file` |
| History | `GET/DELETE /chat/history`, `POST /chat/save` |
| Admin | `/admin/stats`, `/admin/users`, `/admin/audit-logs`, `/admin/sql/execute` (write mode), `/data-sources/*` |

Full reference: [API](docs/api.md).
