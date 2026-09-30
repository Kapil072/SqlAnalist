"""
Natural Language Text-to-SQL endpoint: /ask
Translates business questions into safe MySQL queries, executes them,
and returns data tables, visualizations, and plain-English explanations.
"""

import json
import re
import uuid
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.config import settings
from app.db.schema_registry import get_schema
from app.db.executor import execute_safe_query, QueryResult
from app.db.session import get_db
from app.models.data_source import DataSource
from app.sql_safety.validator import validate_sql
from app.utils.logger import logger
from app.langchain_chains.prompts import SQL_GENERATION_PROMPT
from app.services.connection_manager import ConnectionManager
from app.core.security import get_current_user
from app.models.user import User
router = APIRouter(tags=["analysis"])


class AskRequest(BaseModel):
    question: str
    session_id: Optional[str] = None
    data_source_id: Optional[str] = None  # Optional: query against specific data source


class ChartConfig(BaseModel):
    type: str  # "bar", "pie", "doughnut", "line", "table"
    title: str
    x_axis: Optional[str] = None
    y_axis: Optional[str] = None


class AskResponse(BaseModel):
    question: str
    sql_query: str
    columns: List[str]
    rows: List[List[Any]]
    row_count: int
    timing_ms: int
    explanation: str
    chart: Optional[ChartConfig] = None
    engine_used: str  # "groq-llm" or "direct-sql"


def _clean_sql_output(raw: str) -> str:
    """Remove markdown code blocks or stray formatting from LLM output."""
    clean = raw.strip()
    if clean.startswith("```"):
        clean = re.sub(r"^```(?:sql)?", "", clean, flags=re.IGNORECASE).strip()
    if clean.endswith("```"):
        clean = re.sub(r"```$", "", clean).strip()
    clean = clean.strip().rstrip(";")
    return clean


def _generate_sql_groq(
    question: str,
    schema_context: Optional[Dict[str, Any]] = None,
    dialect: str = "mysql",
) -> str:
    """Call Groq API using configured model to generate dialect-specific SQL."""
    key = settings.groq_api_key.strip()
    if not key or key == "gsk_your_key_here" or not key.startswith("gsk_"):
        raise HTTPException(
            status_code=503,
            detail="Groq LLM API key is not configured. Please set GROQ_API_KEY in backend/.env to enable AI query generation.",
        )

    try:
        from groq import Groq
        client = Groq(api_key=key, base_url=settings.llm_base_url)

        if schema_context is None:
            schema_context = get_schema()

        context_str = json.dumps(schema_context, indent=2) if isinstance(schema_context, dict) else str(schema_context)
        system_prompt = SQL_GENERATION_PROMPT.format(context=context_str, question=question)

        response = client.chat.completions.create(
            model=settings.llm_model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": question},
            ],
            temperature=settings.llm_temperature,
            max_tokens=settings.llm_max_tokens,
        )
        raw_sql = response.choices[0].message.content or ""
        cleaned = _clean_sql_output(raw_sql)

        # Check if the LLM output is not a query
        lower_cleaned = cleaned.lower()
        if not cleaned or "cannot answer" in lower_cleaned or not (lower_cleaned.startswith("select") or lower_cleaned.startswith("with")):
            logger.warning(f"[ASK] Groq did not return a valid SELECT/WITH query. Output was: {raw_sql}")
            raise HTTPException(
                status_code=400,
                detail=f"The AI could not generate a SQL query for this question with the current database schema: {raw_sql.strip() or 'No SQL generated'}"
            )

        return cleaned
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[ASK] Groq SQL generation failed: {e}")
        raise HTTPException(
            status_code=502,
            detail=f"AI query generation failed: {str(e)}"
        )


def _infer_chart(columns: List[str], rows: List[List[Any]]) -> Optional[ChartConfig]:
    """Always generate a pie chart based on the first two columns of the result.

    If the query returns at least two columns, the first column is used as the
    category (x_axis) and the second column as the value (y_axis). If only one
    column is present, a pie chart with a single segment is returned.
    """
    if not columns or not rows:
        return None

    # Use the first column as the label and the second as the value when available.
    x_axis = columns[0]
    y_axis = columns[1] if len(columns) > 1 else None

    return ChartConfig(
        type="pie",
        title=f"{x_axis.replace('_', ' ').title()} Distribution",
        x_axis=x_axis,
        y_axis=y_axis,
    )


def _generate_explanation(question: str, columns: List[str], rows: List[List[Any]], db_label: str = "database") -> str:
    """Generate a brief business summary of the results."""
    if not rows:
        return f"No matching records were found in {db_label} for this question."

    count = len(rows)
    if count == 1 and len(columns) >= 1:
        metrics = ", ".join(f"{col.replace('_', ' ').title()}: {val}" for col, val in zip(columns, rows[0]))
        return f"Summary metric found: {metrics}."

    first_item = rows[0]
    if len(columns) >= 2:
        return (
            f"Returned {count} rows. The top entry is '{first_item[1] if len(columns) > 1 else first_item[0]}' "
            f"with {columns[-1].replace('_', ' ')} of {first_item[-1]}."
        )

    return f"Retrieved {count} matching records from {db_label}."


@router.post("/ask", response_model=AskResponse)
async def ask_question(
    body: AskRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Main Natural Language Text-to-SQL endpoint.
    1. Generates dialect-correct SQL using active schema and AI (or accepts direct SELECT/WITH).
    2. Validates SQL through 11 safety rules.
    3. Executes query on target DB or dynamic data source.
    4. Recommends interactive chart and business summary.
    """
    question = body.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="Question cannot be empty.")

    # Check if using dynamic data source
    data_source = None
    dialect = "mysql"  # default
    active_schema = None

    if body.data_source_id:
        try:
            data_source_uuid = uuid.UUID(body.data_source_id)
            result = await db.execute(
                select(DataSource).where(DataSource.id == data_source_uuid)
            )
            data_source = result.scalar_one_or_none()

            if not data_source:
                raise HTTPException(status_code=404, detail="Data source not found")

            if not data_source.is_active:
                raise HTTPException(status_code=400, detail="Data source is not active")

            # Determine dialect based on db_type
            dialect_map = {
                "postgresql": "postgres",
                "mysql": "mysql",
                "sqlite": "sqlite",
                "sqlserver": "mssql",
                "oracle": "oracle",
            }
            dialect = dialect_map.get(data_source.db_type, "mysql")
            active_schema = await ConnectionManager.get_schema(data_source)

            logger.info(f"[ASK] Using dynamic data source: {data_source.name} ({data_source.db_type})")

        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid data source ID format")
    else:
        active_schema = get_schema()

    # 1. SQL Generation (Direct raw SQL or Groq LLM)
    lower_q = question.lower()
    if lower_q.startswith("select ") or lower_q.startswith("with "):
        generated_sql = question.rstrip(";")
        engine_used = "direct-sql"
    else:
        generated_sql = _generate_sql_groq(question, schema_context=active_schema, dialect=dialect)
        engine_used = "groq-llm"

    # 2. Safety Validation (11 AST checks)
    try:
        validated_sql = validate_sql(generated_sql, dialect=dialect)
    except Exception as val_err:
        logger.error(f"[ASK] SQL validation failed for '{generated_sql}': {val_err}")
        raise HTTPException(status_code=400, detail=f"Safety Check Failed: {val_err}")

    # 3. Execution on Target DB or Dynamic Data Source
    try:
        if data_source:
            # Execute against dynamic data source
            from sqlalchemy import text
            from app.config import settings

            engine = ConnectionManager.get_engine(data_source)
            max_rows = settings.db_max_rows

            import time
            start_time = time.monotonic()

            async with engine.connect() as conn:
                # Set timeout for PostgreSQL
                if data_source.db_type == "postgresql":
                    try:
                        await conn.execute(text("SET statement_timeout = '30s'"))
                    except Exception:
                        pass

                result = await conn.execute(text(validated_sql))

                columns = []
                rows = []
                truncated = False

                if result.returns_rows:
                    columns = list(result.keys())
                    raw_rows = result.fetchmany(max_rows + 1)

                    if len(raw_rows) > max_rows:
                        raw_rows = raw_rows[:max_rows]
                        truncated = True

                    rows = [list(row) for row in raw_rows]

                timing_ms = int((time.monotonic() - start_time) * 1000)

                res = QueryResult(
                    columns=columns,
                    rows=rows,
                    row_count=len(rows),
                    timing_ms=timing_ms,
                    truncated=truncated,
                )

                logger.info(
                    f"[ASK] Query executed on {data_source.name}: "
                    f"{len(rows)} rows in {timing_ms}ms (truncated={truncated})"
                )
        else:
            # Execute against default target DB
            res: QueryResult = execute_safe_query(validated_sql)

    except Exception as exec_err:
        logger.error(f"[ASK] Query execution failed: {exec_err}")
        raise HTTPException(status_code=400, detail=f"Database Execution Error: {exec_err}")

    # 4. Chart & Explanation Inference
    db_label = data_source.name if data_source else "database"
    chart = _infer_chart(res.columns, res.rows)
    explanation = _generate_explanation(question, res.columns, res.rows, db_label=db_label)

    return AskResponse(
        question=question,
        sql_query=validated_sql,
        columns=res.columns,
        rows=res.rows,
        row_count=res.row_count,
        timing_ms=res.timing_ms,
        explanation=explanation,
        chart=chart,
        engine_used=engine_used,
    )
