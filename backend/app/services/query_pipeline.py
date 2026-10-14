"""
Shared Text-to-SQL pipeline used by /ask, /ask/stream and /data-sources.

Before this module existed, ask.py and ask_stream.py each carried their own
copy of: SQL generation, dialect mapping, data-source lookup, query
execution and chart inference. Keep that logic here so a fix lands everywhere.
"""

from __future__ import annotations

import asyncio
import json
import re
import time
import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Any, cast

from fastapi import HTTPException
from sqlalchemy import CursorResult, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.friendly_errors import friendly_message
from app.db.executor import QueryResult, execute_safe_query
from app.db.schema_registry import get_schema
from app.langchain_chains.prompts import (
    ADMIN_WRITE_RULES,
    READ_ONLY_RULES,
    SQL_GENERATION_PROMPT,
)
from app.models.data_source import DataSource
from app.services.connection_manager import ConnectionManager
from app.services.sql_dialect import dialect_for_db_type, human_dialect_name
from app.sql_safety.validator import default_target_dialect
from app.utils.logger import logger

DYNAMIC_QUERY_TIMEOUT_MS = 30_000


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class SQLGenerationError(Exception):
    """Raised when the LLM cannot produce a usable SQL query."""

    def __init__(self, status_code: int, detail: str):
        self.status_code = status_code
        self.detail = detail
        super().__init__(detail)


def public_error(message: str, exc: Exception) -> str:
    """
    Error text that is safe to show to the browser: a plain-English reason
    (see core/friendly_errors.py). The short driver message is only added,
    outside production, when the error is not recognised.
    """
    return friendly_message(message, exc, show_details=not settings.is_production)


# ---------------------------------------------------------------------------
# LLM SQL generation
# ---------------------------------------------------------------------------


def llm_configured() -> bool:
    key = (settings.groq_api_key or "").strip()
    return bool(key) and key.startswith("gsk_") and key != "gsk_your_key_here"


def clean_sql_output(raw: str) -> str:
    """Remove markdown code fences / trailing semicolons from LLM output."""
    clean = (raw or "").strip()
    clean = re.sub(r"^```(?:sql)?", "", clean, flags=re.IGNORECASE).strip()
    clean = re.sub(r"```$", "", clean).strip()
    return clean.rstrip(";").strip()


_READ_PREFIXES = ("select", "with")
_WRITE_PREFIXES = ("insert", "update", "delete", "merge", "create", "drop", "alter", "truncate")


def _first_word(sql: str) -> str:
    words = (sql or "").strip().split(None, 1)
    return words[0].lower() if words else ""


def is_write_sql(sql: str) -> bool:
    """True when the statement changes data or tables (INSERT, UPDATE, DROP, ...)."""
    return _first_word(sql) in _WRITE_PREFIXES


def _parses_as_sql(
    text_: str, dialect: str | None, known_tables: set[str] | None = None
) -> bool:
    """True when *text_* is a real SQL statement, not an English sentence.

    "delete order id 92" or "select the top customers" start with a SQL word
    but are plain English — those must go to the LLM instead of the parser.
    "delete diana" even parses (DELETE FROM diana), so with *known_tables*
    a statement naming a table that does not exist is treated as a sentence too.
    """
    import sqlglot
    import sqlglot.expressions as exp

    try:
        statements = [s for s in sqlglot.parse(text_.strip().rstrip(";"), read=dialect) if s]
    except (sqlglot.errors.ParseError, sqlglot.errors.TokenError):
        return False
    if len(statements) != 1:
        return len(statements) > 1  # several statements: let the validator reject it
    stmt = statements[0]
    if isinstance(stmt, exp.Command):  # sqlglot's "could not really parse this"
        return False
    # Real SQL naming a wrong table should get the validator's clear error;
    # only loose phrases ("delete diana", no FROM/TABLE/...) go to the LLM
    looks_like_sql = re.search(
        r"\b(from|into|set|table|view|index|where|values|join)\b", text_, re.IGNORECASE
    )
    if known_tables is not None and not looks_like_sql:
        known = {t.lower() for t in known_tables}
        ctes = {str(c.alias_or_name).lower() for c in stmt.find_all(exp.CTE)}
        for table in stmt.find_all(exp.Table):
            name = str(table.name or "").lower()
            if name and name not in known and name not in ctes:
                if not isinstance(stmt, exp.Create):  # CREATE TABLE names a new table
                    return False
    if isinstance(stmt, exp.Select) and not (stmt.args.get("from_") or stmt.args.get("from")):
        # "select top customers" parses as columns named top/customers
        return not any(isinstance(e.unalias(), exp.Column) for e in stmt.expressions)
    return True


def is_direct_sql(
    question: str,
    allow_writes: bool = False,
    dialect: str | None = None,
    known_tables: set[str] | None = None,
) -> bool:
    """The user typed SQL themselves (admins may also type write statements).

    The first word alone is not enough: an admin asking "delete order id 92"
    means a sentence for the AI, not a broken DELETE statement.
    """
    word = _first_word(question)
    if not (word in _READ_PREFIXES or (allow_writes and word in _WRITE_PREFIXES)):
        return False
    return _parses_as_sql(question, dialect, known_tables)


def source_label(data_source: DataSource | None) -> str:
    """Readable name of a data source or of TARGET_DB_URL ('analytics' for .../analytics.db)."""
    if data_source is not None:
        return data_source.name
    try:
        import os

        from sqlalchemy.engine import make_url

        db = make_url(settings.target_db_url).database or ""
        return os.path.splitext(os.path.basename(db))[0] or "default"
    except Exception:
        return "default"


def generate_sql(
    question: str,
    schema_context: Any,
    dialect: str,
    allow_writes: bool = False,
) -> str:
    """
    Blocking call to Groq — run it with asyncio.to_thread() from async code.
    allow_writes=True (admins only) lets the model answer "delete order 5"
    with a write statement; the caller must get the admin's confirmation
    before running it. Raises SQLGenerationError on any failure.
    """
    if not llm_configured():
        raise SQLGenerationError(
            503,
            "Groq LLM API key is not configured. Please set GROQ_API_KEY in backend/.env "
            "to enable AI query generation, or type a SELECT query directly.",
        )
    try:
        from groq import Groq

        client = Groq(api_key=settings.groq_api_key.strip(), base_url=settings.llm_base_url)
        if schema_context is None:
            schema_context = get_schema()
        context_str = (
            json.dumps(schema_context, indent=2)
            if isinstance(schema_context, dict)
            else str(schema_context)
        )
        system_prompt = SQL_GENERATION_PROMPT.format(
            dialect_name=human_dialect_name(dialect),
            context=context_str,
            statement_rules=ADMIN_WRITE_RULES if allow_writes else READ_ONLY_RULES,
        )
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
    except Exception as exc:
        logger.error(f"[PIPELINE] Groq SQL generation failed: {exc}")
        raise SQLGenerationError(502, public_error("AI query generation failed", exc)) from exc

    cleaned = clean_sql_output(raw_sql)
    lower_cleaned = cleaned.lower()
    if (
        not cleaned
        or "cannot answer" in lower_cleaned
        or not (_first_word(cleaned) in _READ_PREFIXES or (allow_writes and is_write_sql(cleaned)))
    ):
        logger.warning(
            f"[PIPELINE] LLM did not return a SELECT/WITH query. Output was: {raw_sql!r}"
        )
        raise SQLGenerationError(
            400,
            "The AI could not generate a SQL query for this question with the current "
            "database schema. Try rephrasing, or check that the relevant tables exist.",
        )
    return cleaned


# ---------------------------------------------------------------------------
# Data sources
# ---------------------------------------------------------------------------


async def load_active_data_source(db: AsyncSession, data_source_id: str) -> DataSource:
    """Return an active DataSource or raise HTTP 400/404."""
    try:
        ds_uuid = uuid.UUID(str(data_source_id))
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid data source ID format")
    result = await db.execute(select(DataSource).where(DataSource.id == ds_uuid))
    data_source = result.scalar_one_or_none()
    if not data_source:
        raise HTTPException(status_code=404, detail="Data source not found")
    if not data_source.is_active:
        raise HTTPException(status_code=400, detail="Data source is not active")
    return data_source


def tables_of(schema: dict[str, Any]) -> set[str]:
    return {str(t).lower() for t in (schema or {}).get("tables", {}).keys()}


async def load_data_source_schema(data_source: DataSource) -> dict[str, Any]:
    """
    Tables of a data source, or a clear HTTP error explaining why there are none
    (wrong host, wrong password, empty database) instead of silently answering
    "table not in whitelist" for every question.
    """
    try:
        schema = await ConnectionManager.get_schema(data_source, raise_errors=True)
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=public_error(
                f"Could not connect to the database '{data_source.name}'. "
                "Check its host, port, database name, username and password in Admin → Data Sources",
                exc,
            ),
        )
    if not schema.get("tables"):
        raise HTTPException(
            status_code=400,
            detail=f"The database '{data_source.name}' has no tables that this account can read.",
        )
    return schema


async def resolve_context(data_source: DataSource | None) -> tuple[str, dict[str, Any], set[str]]:
    """
    Return (dialect, schema, allowed_tables) for either a dynamic data
    source or the default target database.
    """
    if data_source is not None:
        schema = await load_data_source_schema(data_source)
        return dialect_for_db_type(data_source.db_type), schema, tables_of(schema)
    schema = get_schema()
    return default_target_dialect(), schema, tables_of(schema)


async def _set_timeout(conn, db_type: str) -> None:
    """Best-effort per-statement timeout on dynamic connections."""
    stmt = None
    if db_type == "postgresql":
        stmt = f"SET statement_timeout = {DYNAMIC_QUERY_TIMEOUT_MS}"
    elif db_type == "mysql":
        stmt = f"SET SESSION max_execution_time = {DYNAMIC_QUERY_TIMEOUT_MS}"
    if stmt:
        try:
            await conn.execute(text(stmt))
        except Exception:
            pass  # not critical


async def run_on_data_source(
    data_source: DataSource,
    sql: str,
    max_rows: int | None = None,
) -> QueryResult:
    """Execute validated SQL on a dynamic data source (always rolled back)."""
    cap = max_rows or settings.db_max_rows
    engine = ConnectionManager.get_engine(data_source)
    start = time.monotonic()
    async with engine.connect() as conn:
        try:
            await _set_timeout(conn, data_source.db_type)
            result = cast(CursorResult, await conn.execute(text(sql)))
            columns: list[str] = []
            rows: list[list[Any]] = []
            truncated = False
            if result.returns_rows:
                columns = list(result.keys())
                raw_rows = result.fetchmany(cap + 1)
                if len(raw_rows) > cap:
                    raw_rows = raw_rows[:cap]
                    truncated = True
                rows = [list(r) for r in raw_rows]
        finally:
            await conn.rollback()  # never keep side effects
    timing_ms = int((time.monotonic() - start) * 1000)
    logger.info(
        f"[PIPELINE] Query on {data_source.name}: {len(rows)} rows in {timing_ms}ms (truncated={truncated})"
    )
    return QueryResult(
        columns=columns, rows=rows, row_count=len(rows), timing_ms=timing_ms, truncated=truncated
    )


async def run_query(sql: str, data_source: DataSource | None = None) -> QueryResult:
    """Execute validated SQL on a data source or (in a worker thread) on the default target DB."""
    if data_source is not None:
        return await run_on_data_source(data_source, sql)
    return await asyncio.to_thread(execute_safe_query, sql)


# ---------------------------------------------------------------------------
# Charts & fallback explanations
# ---------------------------------------------------------------------------

_TEMPORAL_NAME = re.compile(r"(date|time|day|week|month|year|quarter|period|created|updated)", re.I)
_ISO_DATE = re.compile(r"^\d{4}-\d{2}(-\d{2})?")


def _is_number(v: Any) -> bool:
    if isinstance(v, bool):
        return False
    if isinstance(v, (int, float, Decimal)):
        return True
    if isinstance(v, str):
        try:
            float(v)
            return True
        except ValueError:
            return False
    return False


def _numeric_columns(columns: list[str], rows: list[list[Any]]) -> list[int]:
    numeric = []
    for i in range(len(columns)):
        values = [r[i] for r in rows if i < len(r) and r[i] is not None]
        if values and all(_is_number(v) for v in values):
            numeric.append(i)
    return numeric


def _looks_temporal(name: str, values: list[Any]) -> bool:
    if any(isinstance(v, (date, datetime)) for v in values):
        return True
    str_values = [v for v in values if isinstance(v, str)]
    if str_values and all(_ISO_DATE.match(v) for v in str_values):
        return True
    return bool(_TEMPORAL_NAME.search(name or ""))


def _title(name: str) -> str:
    return (name or "").replace("_", " ").title()


def infer_chart(columns: list[str], rows: list[list[Any]]) -> dict[str, Any] | None:
    """
    Pick a sensible chart for the result set:
      - time-like label column        → line
      - few categories (≤ 6, all ≥ 0) → pie
      - otherwise                     → bar
      - single row / no numeric value → no chart (table + summary only)
    """
    if not columns or not rows or len(rows) < 2 or len(columns) < 2:
        return None

    numeric = _numeric_columns(columns, rows)
    if not numeric:
        return None

    label_idx = next((i for i in range(len(columns)) if i not in numeric), None)
    if label_idx is None:
        # All columns numeric (e.g. year + total) — use the first as label
        if len(numeric) < 2:
            return None
        label_idx = numeric[0]
    value_candidates = [i for i in numeric if i != label_idx]
    if not value_candidates:
        return None
    value_idx = value_candidates[0]

    x_axis, y_axis = columns[label_idx], columns[value_idx]
    labels = [r[label_idx] for r in rows]
    values = [float(r[value_idx]) for r in rows if r[value_idx] is not None]

    if _looks_temporal(x_axis, labels):
        chart_type = "line"
    elif len(rows) <= 6 and values and all(v >= 0 for v in values):
        chart_type = "pie"
    else:
        chart_type = "bar"

    return {
        "type": chart_type,
        "title": f"{_title(y_axis)} by {_title(x_axis)}",
        "x_axis": x_axis,
        "y_axis": y_axis,
    }


def fallback_explanation(
    columns: list[str], rows: list[list[Any]], db_label: str = "the database"
) -> str:
    """Plain summary used when the LLM is not available."""
    if not rows:
        return f"No matching records were found in {db_label} for this question."
    if len(rows) == 1:
        metrics = ", ".join(f"{_title(c)}: {v}" for c, v in zip(columns, rows[0]))
        return f"Summary: {metrics}."
    chart = infer_chart(columns, rows)
    if chart:
        x_i = columns.index(chart["x_axis"])
        y_i = columns.index(chart["y_axis"])
        top = rows[0]
        return (
            f"Returned {len(rows)} rows. The first entry is '{top[x_i]}' "
            f"with {_title(chart['y_axis']).lower()} of {top[y_i]}."
        )
    return f"Retrieved {len(rows)} matching records from {db_label}."
