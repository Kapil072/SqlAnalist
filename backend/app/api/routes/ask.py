"""
Natural Language Text-to-SQL endpoint: /ask
Translates business questions into safe MySQL queries, executes them,
and returns data tables, visualizations, and plain-English explanations.
"""

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
    engine_used: str  # "groq-llm" or "analytics-engine"


def _clean_sql_output(raw: str) -> str:
    """Remove markdown code blocks or stray formatting from LLM output."""
    clean = raw.strip()
    if clean.startswith("```"):
        clean = re.sub(r"^```(?:sql)?", "", clean, flags=re.IGNORECASE).strip()
    if clean.endswith("```"):
        clean = re.sub(r"```$", "", clean).strip()
    clean = clean.strip().rstrip(";")
    return clean


def _generate_sql_groq(question: str) -> Optional[str]:
    """Call Groq API using llama-3.3-70b-versatile if key is configured."""
    key = settings.groq_api_key.strip()
    if not key or key == "gsk_your_key_here" or not key.startswith("gsk_"):
        return None

    try:
        from groq import Groq
        client = Groq(api_key=key, base_url=settings.llm_base_url)

        schema_json = get_schema()
        # Use the LangChain prompt template for SQL generation
        system_prompt = SQL_GENERATION_PROMPT.format(context=schema_json, question=question)
        response = client.chat.completions.create(
            model=settings.llm_model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": question},
            ],
            temperature=0.0,
            max_tokens=500,
        )
        raw_sql = response.choices[0].message.content or ""
        return _clean_sql_output(raw_sql)
    except Exception as e:
        logger.warning(f"[ASK] Groq SQL generation failed, using analytical fallback: {e}")
        return None


def _fallback_sql_generator(q: str) -> str:
    """Intelligent analytical pattern matching for natural language questions."""
    lower = q.lower().strip()

    # Direct raw SQL query support
    if lower.startswith("select ") or lower.startswith("with "):
        return q.rstrip(";")

    # Top customers by spending
    if ("top" in lower or "best" in lower) and ("customer" in lower or "spender" in lower or "spending" in lower):
        limit = 5
        match = re.search(r"top\s+(\d+)", lower)
        if match:
            limit = int(match.group(1))
        return (
            f"SELECT c.customer_id, c.name, c.country, SUM(o.total_amount) AS total_spent "
            f"FROM customers c "
            f"JOIN orders o ON c.customer_id = o.customer_id "
            f"WHERE o.status = 'delivered' "
            f"GROUP BY c.customer_id, c.name, c.country "
            f"ORDER BY total_spent DESC "
            f"LIMIT {limit}"
        )

    # Category revenue
    if "category" in lower and ("revenue" in lower or "sales" in lower or "most" in lower or "highest" in lower):
        return (
            "SELECT p.category, SUM(oi.subtotal) AS category_revenue, SUM(oi.quantity) AS total_units_sold "
            "FROM products p "
            "JOIN order_items oi ON p.product_id = oi.product_id "
            "JOIN orders o ON oi.order_id = o.order_id "
            "WHERE o.status = 'delivered' "
            "GROUP BY p.category "
            "ORDER BY category_revenue DESC"
        )

    # Top selling products
    if ("product" in lower or "item" in lower) and ("sell" in lower or "sold" in lower or "popular" in lower or "top" in lower):
        limit = 5
        match = re.search(r"top\s+(\d+)", lower)
        if match:
            limit = int(match.group(1))
        return (
            f"SELECT p.product_id, p.name, p.category, SUM(oi.quantity) AS units_sold, SUM(oi.subtotal) AS total_sales "
            f"FROM products p "
            f"JOIN order_items oi ON p.product_id = oi.product_id "
            f"JOIN orders o ON oi.order_id = o.order_id "
            f"WHERE o.status = 'delivered' "
            f"GROUP BY p.product_id, p.name, p.category "
            f"ORDER BY units_sold DESC "
            f"LIMIT {limit}"
        )

    # Order status counts
    if "status" in lower or "pending" in lower or "order count" in lower:
        return (
            "SELECT status, COUNT(*) AS order_count, SUM(total_amount) AS total_amount "
            "FROM orders "
            "GROUP BY status "
            "ORDER BY order_count DESC"
        )

    # Country breakdown
    if "country" in lower:
        return (
            "SELECT country, COUNT(*) AS customer_count "
            "FROM customers "
            "GROUP BY country "
            "ORDER BY customer_count DESC"
        )

    # Total revenue
    if "total revenue" in lower or "how much revenue" in lower:
        return (
            "SELECT COUNT(*) AS delivered_orders, SUM(total_amount) AS total_revenue, AVG(total_amount) AS average_order_value "
            "FROM orders "
            "WHERE status = 'delivered'"
        )

    # Recent orders
    if "recent order" in lower or "latest order" in lower:
        return (
            "SELECT o.order_id, c.name AS customer_name, o.status, o.total_amount, o.created_at "
            "FROM orders o "
            "JOIN customers c ON o.customer_id = c.customer_id "
            "ORDER BY o.created_at DESC "
            "LIMIT 10"
        )

    # Inventory / Stock
    if "inventory" in lower or "stock" in lower:
        return (
            "SELECT name, category, price, stock_quantity "
            "FROM products "
            "ORDER BY stock_quantity ASC "
            "LIMIT 10"
        )

    # Default fallback
    return "SELECT customer_id, name, email, country, city FROM customers LIMIT 10"


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

    return None


def _generate_explanation(question: str, columns: List[str], rows: List[List[Any]]) -> str:
    """Generate a brief business summary of the results."""
    if not rows:
        return "No matching records were found in the analytics database for this question."

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

    return f"Retrieved {count} matching records from the MySQL database."


@router.post("/ask", response_model=AskResponse)
async def ask_question(
    body: AskRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Main Natural Language Text-to-SQL endpoint.
    1. Generates MySQL query from question.
    2. Validates SQL through 11 safety rules.
    3. Executes query on MySQL target DB or dynamic data source.
    4. Recommends interactive chart and business summary.
    """
    question = body.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="Question cannot be empty.")

    # Check if using dynamic data source
    data_source = None
    dialect = "mysql"  # default

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

            logger.info(f"[ASK] Using dynamic data source: {data_source.name} ({data_source.db_type})")

        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid data source ID format")

    # 1. SQL Generation (Groq LLM or analytical engine)
    generated_sql = _generate_sql_groq(question)
    engine_used = "groq-llm"

    if not generated_sql:
        generated_sql = _fallback_sql_generator(question)
        engine_used = "analytics-engine"

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
    chart = _infer_chart(res.columns, res.rows)
    explanation = _generate_explanation(question, res.columns, res.rows)

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
