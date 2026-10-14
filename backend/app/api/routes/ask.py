"""
Natural Language Text-to-SQL endpoint: /ask
Translates business questions into safe SQL queries, executes them,
and returns data tables, visualizations, and plain-English explanations.

The heavy lifting lives in app/services/query_pipeline.py (shared with /ask/stream).
"""

import asyncio
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import get_current_user
from app.db.session import get_db
from app.models.user import User
from app.services.query_pipeline import (
    SQLGenerationError,
    fallback_explanation,
    generate_sql,
    infer_chart,
    is_direct_sql,
    load_active_data_source,
    public_error,
    resolve_context,
    run_query,
)
from app.sql_safety.validator import SQLValidationError, validate_sql
from app.utils.logger import logger

router = APIRouter(tags=["analysis"])


class AskRequest(BaseModel):
    question: str
    session_id: str | None = None
    data_source_id: str | None = None  # Optional: query against specific data source


class ChartConfig(BaseModel):
    type: str  # "bar", "pie", "line"
    title: str
    x_axis: str | None = None
    y_axis: str | None = None


class AskResponse(BaseModel):
    question: str
    sql_query: str
    columns: list[str]
    rows: list[list[Any]]
    row_count: int
    timing_ms: int
    explanation: str
    chart: ChartConfig | None = None
    engine_used: str  # "groq-llm" or "direct-sql"
    truncated: bool = False


@router.post("/ask", response_model=AskResponse)
async def ask_question(
    body: AskRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Main Natural Language Text-to-SQL endpoint.
    1. Generates dialect-correct SQL using the active schema and AI (or accepts direct SELECT/WITH).
    2. Validates SQL through 11 safety rules (against the tables of the queried source).
    3. Executes query on target DB or dynamic data source (without blocking the event loop).
    4. Recommends a chart and a business summary.
    """
    question = body.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="Question cannot be empty.")

    data_source = None
    if body.data_source_id:
        data_source = await load_active_data_source(db, body.data_source_id)
        logger.info(f"[ASK] Using data source: {data_source.name} ({data_source.db_type})")

    dialect, schema, allowed_tables = await resolve_context(data_source)

    # 1. SQL generation (direct SQL or LLM — LLM call runs in a worker thread)
    if is_direct_sql(question, dialect=dialect, known_tables=allowed_tables):
        generated_sql = question
        engine_used = "direct-sql"
    else:
        try:
            generated_sql = await asyncio.to_thread(generate_sql, question, schema, dialect)
        except SQLGenerationError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.detail)
        engine_used = "groq-llm"

    # 2. Safety validation
    try:
        validated_sql = validate_sql(generated_sql, dialect=dialect, allowed_tables=allowed_tables)
    except SQLValidationError as val_err:
        logger.warning(f"[ASK] SQL validation failed for {generated_sql!r}: {val_err}")
        raise HTTPException(status_code=400, detail=f"Safety Check Failed: {val_err.message}")

    # 3. Execution
    try:
        res = await run_query(validated_sql, data_source)
    except Exception as exec_err:
        logger.error(f"[ASK] Query execution failed: {exec_err}")
        raise HTTPException(
            status_code=400, detail=public_error("Database execution error", exec_err)
        )

    # 4. Chart & explanation
    db_label = data_source.name if data_source else "the database"
    chart = infer_chart(res.columns, res.rows)

    return AskResponse(
        question=question,
        sql_query=validated_sql,
        columns=res.columns,
        rows=res.rows,
        row_count=res.row_count,
        timing_ms=res.timing_ms,
        explanation=fallback_explanation(res.columns, res.rows, db_label=db_label),
        chart=ChartConfig(**chart) if chart else None,
        engine_used=engine_used,
        truncated=res.truncated,
    )
