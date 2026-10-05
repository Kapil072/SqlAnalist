"""
File analysis endpoints.

POST /api/analyze-file
  Upload a CSV or Excel file.
  Returns: filename, rows, columns, preview, analysis summary,
           AND a file_session_id for follow-up queries.

POST /api/ask-file   (streaming SSE)
  Ask a natural-language question about an uploaded file.
  Uses the in-memory SQLite created by /api/analyze-file.
  Returns the same SSE events as /ask/stream:
    meta → token → done | error
"""

import io
import json
import re
import asyncio
from typing import Any, AsyncGenerator, Dict, List

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.core.security import decode_token
from app.models.user import User
from app.config import settings
from app.services.file_session_store import (
    create_file_session, execute_on_file, get_file_session,
)
from app.utils.logger import logger

router = APIRouter(tags=["analysis"])
MAX_SIZE_MB = 10


# ── Auth helper (same as ask_stream.py) ──────────────────────
async def _auth(request: Request) -> str:
    import jwt as _jwt
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing authentication token")
    token_str = auth[7:]
    try:
        payload = decode_token(token_str)
    except _jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token has expired")
    except _jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")
    if payload.get("type") != "access":
        raise HTTPException(status_code=401, detail="Invalid token type")
    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(status_code=401, detail="Token missing subject")

    from app.db.session import AsyncSessionLocal
    from sqlalchemy import select
    import uuid
    async with AsyncSessionLocal() as db:
        result = await db.execute(select(User).where(User.id == uuid.UUID(user_id)))
        user = result.scalar_one_or_none()
        if not user or not user.is_active:
            raise HTTPException(status_code=401, detail="User not found or inactive")
    return user_id


# ─────────────────────────────────────────────────────────────
# 1.  Upload + analyse
# ─────────────────────────────────────────────────────────────
@router.post("/api/analyze-file")
async def analyze_file(
    request: Request,
    file: UploadFile = File(...),
):
    await _auth(request)

    try:
        import pandas as pd
    except ImportError:
        raise HTTPException(status_code=500, detail="pandas is required")

    contents = await file.read()
    if len(contents) / (1024 * 1024) > MAX_SIZE_MB:
        raise HTTPException(status_code=400, detail=f"File too large (max {MAX_SIZE_MB}MB).")

    filename = file.filename or "upload"
    ext = filename.rsplit(".", 1)[-1].lower()
    if ext not in ("csv", "xlsx", "xls"):
        raise HTTPException(
            status_code=400,
            detail="Only CSV and Excel (.xlsx, .xls) files are supported."
        )

    # Create file session (loads into in-memory SQLite)
    try:
        file_session_id, meta = await asyncio.to_thread(
            create_file_session, filename, contents, ext
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not parse file: {exc}")

    rows     = meta["rows"]
    columns  = meta["columns"]
    table    = meta["table_name"]

    # Preview — first 5 rows from SQLite
    try:
        _, preview_rows, _ = execute_on_file(file_session_id, f"SELECT * FROM {table} LIMIT 5")
        preview = [dict(zip(columns, r)) for r in preview_rows]
    except Exception:
        preview = []

    # Numeric stats for LLM
    try:
        df = pd.read_csv(io.BytesIO(contents)) if ext == "csv" else pd.read_excel(io.BytesIO(contents))
        numeric_cols = list(df.select_dtypes(include="number").columns)
        stats_lines  = []
        for c in numeric_cols[:6]:
            s = df[c].describe()
            stats_lines.append(f"{c}: min={s['min']:.2f}, max={s['max']:.2f}, mean={s['mean']:.2f}")
        stats_text = "\n".join(stats_lines) or "No numeric columns."
    except Exception:
        numeric_cols = []
        stats_text   = "Statistics unavailable."

    # LLM summary
    analysis = await asyncio.to_thread(
        _llm_analysis, filename, rows, columns, stats_text
    )
    if not analysis:
        analysis = _fallback_analysis(filename, rows, columns, numeric_cols)

    logger.info(f"[FILE] {filename}: {rows}r × {len(columns)}c  session={file_session_id}")

    return {
        "filename":        filename,
        "file_session_id": file_session_id,   # ← client stores this
        "table_name":      table,
        "rows":            rows,
        "columns":         columns,
        "preview":         preview,
        "analysis":        analysis,
    }


# ─────────────────────────────────────────────────────────────
# 2.  Ask a question about an uploaded file  (SSE streaming)
# ─────────────────────────────────────────────────────────────

class AskFileRequest(BaseModel):
    question:        str
    file_session_id: str


def _sse(event: str, data: Any) -> str:
    payload = data if isinstance(data, str) else json.dumps(data, default=str)
    return f"event: {event}\ndata: {payload}\n\n"


def _infer_chart(columns: List[str], rows: List[List[Any]]) -> Dict | None:
    if not columns or not rows:
        return None
    return {
        "type":    "bar",
        "title":   f"{columns[0].replace('_',' ').title()} Overview",
        "x_axis":  columns[0],
        "y_axis":  columns[1] if len(columns) > 1 else None,
    }


async def _stream_file_answer(
    question: str,
    file_session_id: str,
) -> AsyncGenerator[str, None]:

    # Get session info
    result = get_file_session(file_session_id)
    if result is None:
        yield _sse("error", {"detail": "File session not found or expired. Please re-upload the file."})
        return

    _, meta = result
    table    = meta["table_name"]
    columns  = meta["columns"]
    filename = meta["filename"]

    # Build schema description for LLM
    schema_desc = (
        f"Table: {table}\n"
        f"Columns: {', '.join(columns)}\n"
        f"File: {filename} ({meta['rows']:,} rows)"
    )

    # Generate SQL from LLM
    sql = await asyncio.to_thread(_generate_sql_for_file, question, schema_desc, table)

    # Execute
    import time
    t0 = time.monotonic()
    try:
        col_names, rows, _ = await asyncio.to_thread(execute_on_file, file_session_id, sql)
    except Exception as exc:
        yield _sse("error", {"detail": f"Query error: {exc}"})
        return
    timing_ms = int((time.monotonic() - t0) * 1000)

    chart = _infer_chart(col_names, rows)

    # Meta frame — table and chart render immediately
    yield _sse("meta", {
        "sql_query":   sql,
        "columns":     col_names,
        "rows":        rows[:500],
        "row_count":   len(rows),
        "timing_ms":   timing_ms,
        "chart":       chart,
        "engine_used": "file-sqlite",
        "session_id":  file_session_id,
        "source":      filename,
    })

    # Stream explanation
    explanation = await asyncio.to_thread(
        _explain_results, question, sql, col_names, rows, filename
    )

    # Send as tokens
    words = explanation.split(' ')
    for i, word in enumerate(words):
        chunk = word + (' ' if i < len(words) - 1 else '')
        yield _sse("token", {"token": chunk})
        await asyncio.sleep(0.01)   # smooth streaming

    yield _sse("done", {"explanation": explanation})


@router.post("/api/ask-file")
async def ask_file(request: Request, body: AskFileRequest):
    """Stream an answer to a question about an uploaded file."""
    await _auth(request)

    question = body.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="Question cannot be empty.")

    return StreamingResponse(
        _stream_file_answer(question, body.file_session_id),
        media_type="text/event-stream",
        headers={
            "X-Accel-Buffering": "no",
            "Cache-Control":     "no-cache",
            "Connection":        "keep-alive",
        },
    )


# ── Helpers ───────────────────────────────────────────────────

def _generate_sql_for_file(question: str, schema: str, table: str) -> str:
    """Generate SQL for the file's SQLite table."""
    key = settings.groq_api_key.strip()
    if key and key.startswith("gsk_"):
        try:
            from groq import Groq
            client = Groq(api_key=key)
            prompt = (
                f"You are an expert SQLite data analyst.\n"
                f"Generate a valid SQLite SELECT query for this question.\n"
                f"Output ONLY the raw SQL, no markdown, no explanation.\n\n"
                f"Schema:\n{schema}\n\n"
                f"Rules:\n"
                f"- Use only the table and columns listed above\n"
                f"- SQLite syntax only (no LIMIT without ORDER BY for random)\n"
                f"- Always include LIMIT 500 unless asking for totals/counts\n"
                f"- NEVER use INSERT/UPDATE/DELETE/DROP\n\n"
                f"Question: {question}"
            )
            resp = client.chat.completions.create(
                model=settings.llm_model,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.0,
                max_tokens=300,
            )
            sql = resp.choices[0].message.content or ""
            sql = re.sub(r"^```(?:sql)?", "", sql, flags=re.IGNORECASE).strip()
            sql = re.sub(r"```$", "", sql).strip().rstrip(";")
            if sql.upper().startswith("SELECT"):
                return sql
        except Exception as e:
            logger.warning(f"[FILE] LLM SQL gen failed: {e}")

    # Fallback — simple column search
    return f"SELECT * FROM {table} LIMIT 100"


def _explain_results(
    question: str,
    sql: str,
    columns: List[str],
    rows: List[List[Any]],
    filename: str,
) -> str:
    key = settings.groq_api_key.strip()
    if key and key.startswith("gsk_"):
        try:
            from groq import Groq
            client = Groq(api_key=key)
            preview = json.dumps({"columns": columns, "rows": rows[:10]}, default=str)
            prompt = (
                f"You are a data analyst. The user asked: \"{question}\"\n"
                f"The data comes from the file: {filename}\n"
                f"SQL used: {sql}\n"
                f"Results (first 10 rows): {preview}\n\n"
                "Write a concise 2-3 sentence plain-English answer. "
                "Focus on the business meaning, not the SQL. "
                "If no rows returned, say no matching data was found."
            )
            resp = client.chat.completions.create(
                model=settings.llm_model,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.3,
                max_tokens=200,
            )
            return resp.choices[0].message.content or ""
        except Exception as e:
            logger.warning(f"[FILE] LLM explain failed: {e}")

    # Fallback
    if not rows:
        return "No matching data was found for this question."
    return (
        f"Found {len(rows):,} row(s) from {filename}. "
        f"Top result: {dict(zip(columns[:3], rows[0][:3]))}."
    )


def _llm_analysis(filename: str, rows: int, columns: List[str], stats: str) -> str:
    key = settings.groq_api_key.strip()
    if not key or not key.startswith("gsk_"):
        return ""
    try:
        from groq import Groq
        client = Groq(api_key=key)
        prompt = (
            f"A user uploaded '{filename}' with {rows:,} rows and columns: {', '.join(columns)}.\n"
            f"Numeric stats:\n{stats}\n\n"
            "Summarise this dataset in 2-3 plain-English sentences. No markdown."
        )
        resp = client.chat.completions.create(
            model=settings.llm_model,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.3,
            max_tokens=150,
        )
        return resp.choices[0].message.content or ""
    except Exception:
        return ""


def _fallback_analysis(
    filename: str, rows: int, columns: List[str], numeric_cols: List[str]
) -> str:
    return (
        f"'{filename}' contains {rows:,} rows and {len(columns)} columns: "
        f"{', '.join(columns[:6])}{'…' if len(columns) > 6 else ''}. "
        "Ask any question about this data in the chat."
    )
