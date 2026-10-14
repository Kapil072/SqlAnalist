"""
Streaming Text-to-SQL endpoint: POST /ask/stream

Server-Sent Events (SSE) response flow
---------------------------------------
1. [event: meta]   — JSON with sql_query, columns, rows, chart, row_count, timing_ms
2. [event: token]  — one chunk of the explanation text per event (streamed from Groq)
3. [event: done]   — signals end of stream; data contains final full explanation
4. [event: error]  — sent if anything goes wrong; data contains detail string

RAG integration
---------------
Before generating the explanation the handler:
  a. Retrieves the top-3 most relevant past Q&A turns from the session's
     in-memory FAISS store (scoped to the authenticated user).
  b. Injects them into the RAG_EXPLANATION_PROMPT.
After the explanation is fully assembled it is stored back into the FAISS
store so future turns can reference it.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import AsyncGenerator
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.config import settings
from app.core.security import authenticate_request
from app.db.session import AsyncSessionLocal
from app.langchain_chains.prompts import RAG_EXPLANATION_PROMPT
from app.langchain_chains.rag_memory import get_session_rag
from app.services.query_pipeline import (
    SQLGenerationError,
    fallback_explanation,
    generate_sql,
    infer_chart,
    is_direct_sql,
    is_write_sql,
    llm_configured,
    load_active_data_source,
    public_error,
    resolve_context,
    run_query,
    source_label,
)
from app.sql_safety.admin_writes import AdminSQLError, validate_admin_sql
from app.sql_safety.validator import SQLValidationError, validate_sql
from app.utils.logger import logger

router = APIRouter(tags=["analysis"])

EXPLANATION_PREVIEW_ROWS = 20

# Strong references to fire-and-forget tasks — without this, asyncio may
# garbage-collect a task before it finishes.
_background_tasks: set[asyncio.Task] = set()


def _fire_and_forget(coro) -> None:
    task = asyncio.create_task(coro)
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)


async def _write_audit_log(
    user_id: str | None,
    question: str,
    sql_used: str | None = None,
    row_count: int | None = None,
    timing_ms: int | None = None,
    status: str = "success",
    error_msg: str | None = None,
    session_id: str | None = None,
) -> None:
    """Safely persist audit logs in background task without raising exceptions."""
    try:
        from app.models.audit_log import AuditLog

        uid = uuid.UUID(user_id) if user_id else None
        try:
            sid = uuid.UUID(session_id) if session_id else None
        except ValueError:
            sid = None
        async with AsyncSessionLocal() as db:
            db.add(
                AuditLog(
                    user_id=uid,
                    session_id=sid,
                    question=question,
                    sql_used=sql_used,
                    row_count=row_count,
                    timing_ms=timing_ms,
                    status=status,
                    error_msg=error_msg,
                )
            )
            await db.commit()
    except Exception as e:
        logger.warning(f"[AUDIT] Failed to write audit log: {e}")


# ---------------------------------------------------------------------------
# Request model
# ---------------------------------------------------------------------------


class AskStreamRequest(BaseModel):
    question: str
    session_id: str | None = None  # client-supplied or auto-generated
    data_source_id: str | None = None


# ---------------------------------------------------------------------------
# SSE helpers
# ---------------------------------------------------------------------------


def _sse(event: str, data: Any) -> str:
    """Format a single SSE frame."""
    payload = data if isinstance(data, str) else json.dumps(data, default=str)
    return f"event: {event}\ndata: {payload}\n\n"


async def _stream_explanation(prompt_text: str) -> AsyncGenerator[str, None]:
    """
    Stream explanation tokens from Groq. The Groq iterator is blocking, so it
    runs in a worker thread and tokens are piped back through an asyncio.Queue.
    """
    from groq import Groq

    done = object()
    queue: asyncio.Queue = asyncio.Queue()
    loop = asyncio.get_running_loop()

    def _worker():
        try:
            client = Groq(api_key=settings.groq_api_key.strip(), base_url=settings.llm_base_url)
            stream = client.chat.completions.create(
                model=settings.llm_model,
                messages=[{"role": "user", "content": prompt_text}],
                temperature=settings.llm_explanation_temperature,
                max_tokens=settings.llm_explanation_max_tokens,
                stream=True,
            )
            for chunk in stream:
                token = getattr(chunk.choices[0].delta, "content", None) or ""
                if token:
                    loop.call_soon_threadsafe(queue.put_nowait, token)
        except Exception as e:
            logger.warning(f"[STREAM] Groq thread error: {e}")
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, done)

    loop.run_in_executor(None, _worker)
    while True:
        item = await queue.get()
        if item is done:
            break
        yield item


# ---------------------------------------------------------------------------
# SSE generator
# ---------------------------------------------------------------------------


async def _stream_response(
    question: str,
    session_id: str,
    data_source_id: str | None,
    user_id: str,
    is_admin: bool = False,
) -> AsyncGenerator[str, None]:
    """Core async generator that drives the SSE stream. Never blocks the event loop."""

    def _audit_error(msg: str, sql: str | None = None) -> None:
        _fire_and_forget(
            _write_audit_log(
                user_id=user_id,
                question=question,
                sql_used=sql,
                status="error",
                error_msg=msg,
                session_id=session_id,
            )
        )

    # 0. RAG – history is scoped to this user (a client cannot read another
    #    user's history by sending their session_id)
    rag = get_session_rag(f"{user_id}:{session_id}")
    past_turns: list[str] = await asyncio.to_thread(rag.retrieve, question, 3)
    rag_context = "\n\n".join(past_turns) if past_turns else "No relevant conversation history yet."

    # 1. Resolve data source + dialect + schema
    data_source = None
    if data_source_id:
        try:
            async with AsyncSessionLocal() as db:
                data_source = await load_active_data_source(db, data_source_id)
        except HTTPException as exc:
            yield _sse("error", {"detail": exc.detail})
            return
    try:
        dialect, schema, allowed_tables = await resolve_context(data_source)
    except HTTPException as exc:
        _audit_error(str(exc.detail))
        yield _sse("error", {"detail": exc.detail})
        return

    # 2. SQL generation (admins may also ask for — or type — a change)
    can_write = is_admin and settings.admin_sql_writes
    if is_direct_sql(
        question, allow_writes=can_write, dialect=dialect, known_tables=allowed_tables
    ):
        generated_sql = question
        engine_used = "direct-sql"
    else:
        try:
            generated_sql = await asyncio.to_thread(
                generate_sql, question, schema, dialect, can_write
            )
        except SQLGenerationError as exc:
            _audit_error(exc.detail)
            yield _sse("error", {"detail": exc.detail})
            return
        engine_used = "groq-llm"

    # 2b. A change (INSERT/UPDATE/DELETE/DDL) is never run from the chat
    #     directly: the admin sees the statement and confirms it, and the
    #     frontend then runs it through POST /admin/sql/execute.
    if is_write_sql(generated_sql):
        if not can_write:
            msg = (
                "Only admins can change data, and only after confirming the change. "
                "Ask a question about the data instead."
            )
            _audit_error(msg, generated_sql)
            yield _sse("error", {"detail": msg})
            return
        try:
            stmt = validate_admin_sql(
                generated_sql,
                dialect=dialect,
                existing_tables=allowed_tables,
                allow_full_table=True,
            )
        except AdminSQLError as exc:
            _audit_error(exc.message, generated_sql)
            yield _sse("error", {"detail": f"This change is not allowed: {exc.message}"})
            return
        full_table = False
        try:
            validate_admin_sql(stmt.sql, dialect=dialect, existing_tables=allowed_tables)
        except AdminSQLError as exc:
            full_table = exc.needs_confirmation
        target = source_label(data_source)
        yield _sse(
            "confirm",
            {
                "sql": stmt.sql,
                "kind": stmt.kind,
                "full_table": full_table,
                "database": target,
                "data_source_id": data_source_id,
                "engine_used": engine_used,
            },
        )
        note = (
            f"This is a {stmt.kind.upper()} on {target}. Nothing has been changed yet — "
            "review the statement and click Run change to apply it."
        )
        if full_table:
            note += (
                " It affects every row of the table (or removes it), so you will be asked twice."
            )
        yield _sse("token", {"token": note})
        yield _sse("done", {"explanation": note, "pending_change": True})
        return

    # 3. Safety validation
    try:
        validated_sql = await asyncio.to_thread(
            validate_sql, generated_sql, dialect, allowed_tables
        )
    except SQLValidationError as val_err:
        _audit_error(str(val_err), generated_sql)
        yield _sse("error", {"detail": f"Safety Check Failed: {val_err.message}"})
        return

    # 4. Execute
    try:
        res = await run_query(validated_sql, data_source)
    except Exception as exec_err:
        logger.error(f"[STREAM] Execution error: {exec_err}")
        _audit_error(str(exec_err), validated_sql)
        yield _sse("error", {"detail": public_error("Database execution error", exec_err)})
        return

    # 5. Metadata frame — client renders table/chart now
    yield _sse(
        "meta",
        {
            "sql_query": validated_sql,
            "columns": res.columns,
            "rows": res.rows,
            "row_count": res.row_count,
            "truncated": res.truncated,
            "timing_ms": res.timing_ms,
            "chart": infer_chart(res.columns, res.rows),
            "engine_used": engine_used,
            "session_id": session_id,
            "rag_turns_used": len(past_turns),
        },
    )

    # 6. Stream explanation tokens via Groq
    full_explanation = ""
    if llm_configured():
        try:
            prompt_text = RAG_EXPLANATION_PROMPT.format(
                rag_context=rag_context,
                question=question,
                sql_query=validated_sql,
                preview_rows=min(EXPLANATION_PREVIEW_ROWS, res.row_count),
                total_rows=res.row_count,
                results=json.dumps(
                    {"columns": res.columns, "rows": res.rows[:EXPLANATION_PREVIEW_ROWS]},
                    default=str,
                ),
            )
            async for token in _stream_explanation(prompt_text):
                full_explanation += token
                yield _sse("token", {"token": token})
        except Exception as stream_err:
            logger.warning(f"[STREAM] Groq streaming setup failed: {stream_err}")

    # 7. Static fallback explanation if Groq didn't produce anything
    if not full_explanation:
        db_label = data_source.name if data_source else "the database"
        full_explanation = fallback_explanation(res.columns, res.rows, db_label=db_label)
        yield _sse("token", {"token": full_explanation})

    # 8. Store turn in RAG + write AuditLog (fire-and-forget)
    _fire_and_forget(asyncio.to_thread(rag.add, question, full_explanation))
    _fire_and_forget(
        _write_audit_log(
            user_id=user_id,
            question=question,
            sql_used=validated_sql,
            row_count=res.row_count,
            timing_ms=res.timing_ms,
            status="success",
            session_id=session_id,
        )
    )

    # 9. Done frame
    yield _sse(
        "done",
        {
            "explanation": full_explanation,
            "rag_store_size": rag.size(),
        },
    )


# ---------------------------------------------------------------------------
# Route
# ---------------------------------------------------------------------------


@router.post("/ask/stream")
async def ask_stream(
    request: Request,
    body: AskStreamRequest,
):
    """
    Streaming Text-to-SQL endpoint.
    Returns a text/event-stream (SSE) response.

    Events
    ------
    meta   – sql, columns, rows, chart config  (sent first)
    token  – one text chunk of the AI explanation
    done   – final explanation + RAG store size
    error  – detail string (stream ends after this)
    """
    # Auth is validated eagerly before opening the stream so the client
    # gets a clean HTTP 401 instead of a broken SSE connection.
    user = await authenticate_request(request)

    question = body.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="Question cannot be empty.")

    session_id = (body.session_id or str(uuid.uuid4()))[:64]

    return StreamingResponse(
        _stream_response(
            question=question,
            session_id=session_id,
            data_source_id=body.data_source_id,
            user_id=str(user.id),
            is_admin=user.role == "admin",
        ),
        media_type="text/event-stream",
        headers={
            "X-Accel-Buffering": "no",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    )
