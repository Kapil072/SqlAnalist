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
     in-memory FAISS store.
  b. Injects them into the RAG_EXPLANATION_PROMPT.
After the explanation is fully assembled it is stored back into the FAISS
store so future turns can reference it.
"""

from __future__ import annotations

import json
import re
import time
import uuid
from typing import Any, AsyncGenerator, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.security import get_current_user
from app.db.executor import execute_safe_query, QueryResult
from app.db.schema_registry import get_schema
from app.db.session import get_db
from app.langchain_chains.prompts import SQL_GENERATION_PROMPT, RAG_EXPLANATION_PROMPT
from app.langchain_chains.rag_memory import get_session_rag
from app.models.data_source import DataSource
from app.models.user import User
from app.services.connection_manager import ConnectionManager
from app.sql_safety.validator import validate_sql
from app.utils.logger import logger

router = APIRouter(tags=["analysis"])


# ---------------------------------------------------------------------------
# Request model
# ---------------------------------------------------------------------------

class AskStreamRequest(BaseModel):
    question: str
    session_id: Optional[str] = None        # client-supplied or auto-generated
    data_source_id: Optional[str] = None


# ---------------------------------------------------------------------------
# Helpers (shared with ask.py logic, kept local to avoid tight coupling)
# ---------------------------------------------------------------------------

def _clean_sql(raw: str) -> str:
    clean = raw.strip()
    clean = re.sub(r"^```(?:sql)?", "", clean, flags=re.IGNORECASE).strip()
    clean = re.sub(r"```$", "", clean).strip()
    return clean.rstrip(";")


def _groq_sql(question: str) -> Optional[str]:
    key = settings.groq_api_key.strip()
    if not key or key == "gsk_your_key_here" or not key.startswith("gsk_"):
        return None
    try:
        from groq import Groq
        client = Groq(api_key=key, base_url=settings.llm_base_url)
        schema_json = get_schema()
        system_prompt = SQL_GENERATION_PROMPT.format(
            context=schema_json, question=question
        )
        resp = client.chat.completions.create(
            model=settings.llm_model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": question},
            ],
            temperature=0.0,
            max_tokens=500,
        )
        return _clean_sql(resp.choices[0].message.content or "")
    except Exception as exc:
        logger.warning(f"[STREAM] Groq SQL gen failed: {exc}")
        return None


def _fallback_sql(q: str) -> str:
    """Minimal analytical fallback — identical logic to ask.py."""
    lower = q.lower().strip()
    if lower.startswith("select ") or lower.startswith("with "):
        return q.rstrip(";")
    if ("top" in lower or "best" in lower) and (
        "customer" in lower or "spend" in lower
    ):
        limit = 5
        m = re.search(r"top\s+(\d+)", lower)
        if m:
            limit = int(m.group(1))
        return (
            f"SELECT c.customer_id, c.name, c.country, SUM(o.total_amount) AS total_spent "
            f"FROM customers c JOIN orders o ON c.customer_id = o.customer_id "
            f"WHERE o.status = 'delivered' "
            f"GROUP BY c.customer_id, c.name, c.country "
            f"ORDER BY total_spent DESC LIMIT {limit}"
        )
    if "category" in lower and ("revenue" in lower or "sales" in lower):
        return (
            "SELECT p.category, SUM(oi.subtotal) AS category_revenue "
            "FROM products p JOIN order_items oi ON p.product_id = oi.product_id "
            "JOIN orders o ON oi.order_id = o.order_id WHERE o.status = 'delivered' "
            "GROUP BY p.category ORDER BY category_revenue DESC"
        )
    if ("product" in lower or "item" in lower) and (
        "sell" in lower or "sold" in lower or "popular" in lower
    ):
        limit = 5
        m = re.search(r"top\s+(\d+)", lower)
        if m:
            limit = int(m.group(1))
        return (
            f"SELECT p.name, p.category, SUM(oi.quantity) AS units_sold "
            f"FROM products p JOIN order_items oi ON p.product_id = oi.product_id "
            f"JOIN orders o ON oi.order_id = o.order_id WHERE o.status = 'delivered' "
            f"GROUP BY p.product_id, p.name, p.category "
            f"ORDER BY units_sold DESC LIMIT {limit}"
        )
    if "status" in lower or "pending" in lower:
        return (
            "SELECT status, COUNT(*) AS order_count, SUM(total_amount) AS total_amount "
            "FROM orders GROUP BY status ORDER BY order_count DESC"
        )
    if "country" in lower:
        return (
            "SELECT country, COUNT(*) AS customer_count FROM customers "
            "GROUP BY country ORDER BY customer_count DESC"
        )
    if "total revenue" in lower or "how much revenue" in lower:
        return (
            "SELECT COUNT(*) AS delivered_orders, SUM(total_amount) AS total_revenue "
            "FROM orders WHERE status = 'delivered'"
        )
    if "recent order" in lower or "latest order" in lower:
        return (
            "SELECT o.order_id, c.name AS customer_name, o.status, "
            "o.total_amount, o.created_at FROM orders o "
            "JOIN customers c ON o.customer_id = c.customer_id "
            "ORDER BY o.created_at DESC LIMIT 10"
        )
    if "inventory" in lower or "stock" in lower:
        return (
            "SELECT name, category, price, stock_quantity FROM products "
            "ORDER BY stock_quantity ASC LIMIT 10"
        )
    return "SELECT customer_id, name, email, country, city FROM customers LIMIT 10"


def _infer_chart(columns: List[str], rows: List[List[Any]]) -> Optional[Dict]:
    if not columns or not rows:
        return None
    x = columns[0]
    y = columns[1] if len(columns) > 1 else None
    return {
        "type": "pie",
        "title": f"{x.replace('_', ' ').title()} Distribution",
        "x_axis": x,
        "y_axis": y,
    }


# ---------------------------------------------------------------------------
# SSE generator
# ---------------------------------------------------------------------------

def _sse(event: str, data: Any) -> str:
    """Format a single SSE frame."""
    payload = data if isinstance(data, str) else json.dumps(data, default=str)
    return f"event: {event}\ndata: {payload}\n\n"


async def _stream_response(
    question: str,
    session_id: str,
    data_source_id: Optional[str],
    db: AsyncSession,
) -> AsyncGenerator[str, None]:
    """
    Core async generator that drives the SSE stream.
    Yields SSE-formatted strings.
    """

    # ------------------------------------------------------------------
    # 0. RAG – retrieve relevant history
    # ------------------------------------------------------------------
    rag = get_session_rag(session_id)
    past_turns = rag.retrieve(question, top_k=3)
    rag_context = (
        "\n\n".join(past_turns)
        if past_turns
        else "No relevant conversation history yet."
    )

    # ------------------------------------------------------------------
    # 1. Resolve data source + dialect
    # ------------------------------------------------------------------
    data_source = None
    dialect = "mysql"

    if data_source_id:
        try:
            ds_uuid = uuid.UUID(data_source_id)
            result = await db.execute(
                select(DataSource).where(DataSource.id == ds_uuid)
            )
            data_source = result.scalar_one_or_none()
            if not data_source:
                yield _sse("error", {"detail": "Data source not found"})
                return
            if not data_source.is_active:
                yield _sse("error", {"detail": "Data source is not active"})
                return
            dialect_map = {
                "postgresql": "postgres",
                "mysql": "mysql",
                "sqlite": "sqlite",
                "sqlserver": "mssql",
                "oracle": "oracle",
            }
            dialect = dialect_map.get(data_source.db_type, "mysql")
        except ValueError:
            yield _sse("error", {"detail": "Invalid data source ID"})
            return

    # ------------------------------------------------------------------
    # 2. SQL generation
    # ------------------------------------------------------------------
    generated_sql = _groq_sql(question)
    engine_used = "groq-llm"
    if not generated_sql:
        generated_sql = _fallback_sql(question)
        engine_used = "analytics-engine"

    # ------------------------------------------------------------------
    # 3. Safety validation
    # ------------------------------------------------------------------
    try:
        validated_sql = validate_sql(generated_sql, dialect=dialect)
    except Exception as val_err:
        yield _sse("error", {"detail": f"Safety Check Failed: {val_err}"})
        return

    # ------------------------------------------------------------------
    # 4. Execute query
    # ------------------------------------------------------------------
    try:
        if data_source:
            engine = ConnectionManager.get_engine(data_source)
            max_rows = settings.db_max_rows
            t0 = time.monotonic()
            async with engine.connect() as conn:
                if data_source.db_type == "postgresql":
                    try:
                        await conn.execute(text("SET statement_timeout = '30s'"))
                    except Exception:
                        pass
                result = await conn.execute(text(validated_sql))
                columns: List[str] = []
                rows: List[List[Any]] = []
                truncated = False
                if result.returns_rows:
                    columns = list(result.keys())
                    raw_rows = result.fetchmany(max_rows + 1)
                    if len(raw_rows) > max_rows:
                        raw_rows = raw_rows[:max_rows]
                        truncated = True
                    rows = [list(r) for r in raw_rows]
                timing_ms = int((time.monotonic() - t0) * 1000)
                res = QueryResult(
                    columns=columns,
                    rows=rows,
                    row_count=len(rows),
                    timing_ms=timing_ms,
                    truncated=truncated,
                )
        else:
            res: QueryResult = execute_safe_query(validated_sql)
    except Exception as exec_err:
        logger.error(f"[STREAM] Execution error: {exec_err}")
        yield _sse("error", {"detail": f"Database Execution Error: {exec_err}"})
        return

    # ------------------------------------------------------------------
    # 5. Send metadata frame — client can render table/chart immediately
    # ------------------------------------------------------------------
    chart = _infer_chart(res.columns, res.rows)
    yield _sse("meta", {
        "sql_query": validated_sql,
        "columns": res.columns,
        "rows": res.rows,
        "row_count": res.row_count,
        "timing_ms": res.timing_ms,
        "chart": chart,
        "engine_used": engine_used,
        "session_id": session_id,
        "rag_turns_used": len(past_turns),
    })

    # ------------------------------------------------------------------
    # 6. Stream explanation tokens via Groq
    # ------------------------------------------------------------------
    key = settings.groq_api_key.strip()
    full_explanation = ""

    if key and key.startswith("gsk_") and key != "gsk_your_key_here":
        try:
            from groq import Groq

            client = Groq(api_key=key, base_url=settings.llm_base_url)

            # Build the RAG-augmented explanation prompt
            results_preview = json.dumps(
                {"columns": res.columns, "rows": res.rows[:20]},
                default=str,
            )
            prompt_text = RAG_EXPLANATION_PROMPT.format(
                rag_context=rag_context,
                question=question,
                sql_query=validated_sql,
                results=results_preview,
            )

            # Groq streaming
            stream = client.chat.completions.create(
                model=settings.llm_model,
                messages=[{"role": "user", "content": prompt_text}],
                temperature=0.3,
                max_tokens=300,
                stream=True,
            )

            for chunk in stream:
                delta = chunk.choices[0].delta
                token = getattr(delta, "content", None) or ""
                if token:
                    full_explanation += token
                    yield _sse("token", {"token": token})

        except Exception as stream_err:
            logger.warning(f"[STREAM] Groq streaming failed: {stream_err}")
            # Fall through to static explanation below

    # ------------------------------------------------------------------
    # 7. Fallback static explanation if streaming failed or no key
    # ------------------------------------------------------------------
    if not full_explanation:
        if not res.rows:
            full_explanation = "No matching records were found for this question."
        elif len(res.rows) == 1:
            metrics = ", ".join(
                f"{c.replace('_', ' ').title()}: {v}"
                for c, v in zip(res.columns, res.rows[0])
            )
            full_explanation = f"Summary metric: {metrics}."
        else:
            top = res.rows[0]
            label = top[1] if len(res.columns) > 1 else top[0]
            full_explanation = (
                f"Returned {res.row_count} rows. "
                f"Top result: '{label}' with "
                f"{res.columns[-1].replace('_', ' ')} of {top[-1]}."
            )
        # Emit the static explanation as a single token so the frontend
        # animation still fires
        yield _sse("token", {"token": full_explanation})

    # ------------------------------------------------------------------
    # 8. Store this turn in the in-memory RAG store
    # ------------------------------------------------------------------
    try:
        rag.add(question, full_explanation)
    except Exception as rag_err:
        # Non-fatal — RAG storage failure should not break the response
        logger.warning(f"[STREAM] RAG store failed: {rag_err}")

    # ------------------------------------------------------------------
    # 9. Done frame
    # ------------------------------------------------------------------
    yield _sse("done", {
        "explanation": full_explanation,
        "rag_store_size": rag.size(),
    })


# ---------------------------------------------------------------------------
# Route
# ---------------------------------------------------------------------------

@router.post("/ask/stream")
async def ask_stream(
    body: AskStreamRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
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
    question = body.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="Question cannot be empty.")

    # Assign a session_id — client should persist and re-send this across turns
    session_id = body.session_id or str(uuid.uuid4())

    return StreamingResponse(
        _stream_response(
            question=question,
            session_id=session_id,
            data_source_id=body.data_source_id,
            db=db,
        ),
        media_type="text/event-stream",
        headers={
            # Prevent proxies / nginx from buffering the stream
            "X-Accel-Buffering": "no",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    )
