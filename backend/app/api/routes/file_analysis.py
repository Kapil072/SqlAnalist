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

import asyncio
import io
import json
import re
from collections.abc import AsyncGenerator
from typing import Any

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.config import settings
from app.core.security import authenticate_request
from app.services.file_session_store import (
    create_file_session,
    execute_on_file,
    get_file_session,
)
from app.services.query_pipeline import infer_chart, llm_configured, public_error
from app.sql_safety.validator import SQLValidationError, validate_sql
from app.utils.logger import logger

router = APIRouter(tags=["analysis"])
MAX_SIZE_MB = 10
_MAX_BYTES = MAX_SIZE_MB * 1024 * 1024


def _groq_client():
    from groq import Groq

    return Groq(api_key=settings.groq_api_key.strip(), base_url=settings.llm_base_url)


async def _read_limited(file: UploadFile) -> bytes:
    """Read the upload in chunks and stop as soon as it exceeds the size limit."""
    chunks, total = [], 0
    while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > _MAX_BYTES:
            raise HTTPException(status_code=400, detail=f"File too large (max {MAX_SIZE_MB}MB).")
        chunks.append(chunk)
    return b"".join(chunks)


def _numeric_stats(contents: bytes, ext: str) -> tuple[list, str]:
    """CPU-bound pandas work — call via asyncio.to_thread()."""
    import pandas as pd

    df = (
        pd.read_csv(io.BytesIO(contents), nrows=50_000)
        if ext == "csv"
        else pd.read_excel(io.BytesIO(contents), nrows=50_000)
    )
    numeric_cols = list(df.select_dtypes(include="number").columns)
    stats_lines = []
    for c in numeric_cols[:6]:
        d = df[c].describe()
        stats_lines.append(f"{c}: min={d['min']:.2f}, max={d['max']:.2f}, mean={d['mean']:.2f}")
    return numeric_cols, "\n".join(stats_lines) or "No numeric columns."


# ─────────────────────────────────────────────────────────────
# 1.  Upload + analyse
# ─────────────────────────────────────────────────────────────
@router.post("/api/analyze-file")
async def analyze_file(
    request: Request,
    file: UploadFile = File(...),
):
    user = await authenticate_request(request)
    user_id = str(user.id)

    contents = await _read_limited(file)

    filename = file.filename or "upload"
    ext = filename.rsplit(".", 1)[-1].lower()
    if ext not in ("csv", "xlsx", "xls"):
        raise HTTPException(
            status_code=400, detail="Only CSV and Excel (.xlsx, .xls) files are supported."
        )

    # Create file session (loads into in-memory SQLite)
    try:
        file_session_id, meta = await asyncio.to_thread(
            create_file_session, filename, contents, ext, user_id
        )
    except Exception as exc:
        logger.warning(f"[FILE] Could not parse {filename}: {exc}")
        raise HTTPException(status_code=400, detail=public_error("Could not parse file", exc))

    rows = meta["rows"]
    columns = meta["columns"]
    table = meta["table_name"]

    # Preview — first 5 rows from SQLite
    try:
        _, preview_rows, _ = execute_on_file(
            file_session_id, f'SELECT * FROM "{table}" LIMIT 5', user_id
        )
        preview = [dict(zip(columns, r)) for r in preview_rows]
    except Exception:
        preview = []

    # Numeric stats for LLM
    try:
        numeric_cols, stats_text = await asyncio.to_thread(_numeric_stats, contents, ext)
    except Exception:
        numeric_cols = []
        stats_text = "Statistics unavailable."

    # LLM summary
    analysis = await asyncio.to_thread(_llm_analysis, filename, rows, columns, stats_text)
    if not analysis:
        analysis = _fallback_analysis(filename, rows, columns, numeric_cols)

    logger.info(f"[FILE] {filename}: {rows}r × {len(columns)}c  session={file_session_id}")

    return {
        "filename": filename,
        "file_session_id": file_session_id,  # ← client stores this
        "table_name": table,
        "rows": rows,
        "columns": columns,
        "preview": preview,
        "analysis": analysis,
    }


# ─────────────────────────────────────────────────────────────
# 2.  Ask a question about an uploaded file  (SSE streaming)
# ─────────────────────────────────────────────────────────────


class AskFileRequest(BaseModel):
    question: str
    file_session_id: str


def _sse(event: str, data: Any) -> str:
    payload = data if isinstance(data, str) else json.dumps(data, default=str)
    return f"event: {event}\ndata: {payload}\n\n"


async def _stream_file_answer(
    question: str,
    file_session_id: str,
    user_id: str,
) -> AsyncGenerator[str, None]:

    # Get session info (only the user who uploaded the file may query it)
    result = get_file_session(file_session_id, user_id)
    if result is None:
        yield _sse(
            "error", {"detail": "File session not found or expired. Please re-upload the file."}
        )
        return

    _, meta = result
    table = meta["table_name"]
    columns = meta["columns"]
    filename = meta["filename"]

    column_info = meta.get("column_info") or [
        {"name": c, "type": "TEXT", "samples": []} for c in columns
    ]
    schema_desc = _schema_description(table, column_info, filename, meta["rows"])
    history: list[dict[str, str]] = meta.setdefault("history", [])

    # Look up where the searched words actually occur in the file, so the
    # LLM filters the right column with the right spelling
    terms = _search_terms(question, column_info)
    try:
        hits = await asyncio.to_thread(
            _find_values, file_session_id, user_id, table, column_info, terms
        )
    except Exception as exc:
        logger.warning(f"[FILE] Value lookup failed: {exc}")
        hits = []

    # Generate SQL from LLM (or accept a direct SELECT)
    lower_q = question.lower()
    user_wrote_sql = lower_q.startswith("select ") or lower_q.startswith("with ")
    if user_wrote_sql:
        raw_sql = question
    else:
        raw_sql = await asyncio.to_thread(
            _generate_sql_for_file,
            question,
            schema_desc,
            table,
            _hints_text(terms, hits),
            history,
            hits,
        )

    # Same safety checks as database queries (blocks ATTACH, PRAGMA, multiple statements, ...)
    try:
        sql = validate_sql(raw_sql, dialect="sqlite", allowed_tables={table}, max_rows=5000)
    except SQLValidationError as exc:
        yield _sse("error", {"detail": f"Safety Check Failed: {exc.message}"})
        return

    # Execute
    try:
        col_names, rows, timing_ms = await asyncio.to_thread(
            execute_on_file, file_session_id, sql, user_id
        )
    except Exception as exc:
        yield _sse("error", {"detail": public_error("Query error", exc)})
        return

    # The generated filter matched nothing — retry as a search for the words
    # that really are in the file (returns only the best-matching rows)
    used_fallback = False
    if not rows and not user_wrote_sql:
        fallback = _keyword_search_sql(table, hits)
        if fallback:
            try:
                fb_sql = validate_sql(
                    fallback, dialect="sqlite", allowed_tables={table}, max_rows=5000
                )
                fb_cols, fb_rows, fb_ms = await asyncio.to_thread(
                    execute_on_file, file_session_id, fb_sql, user_id
                )
                if fb_rows:
                    logger.info(f"[FILE] LLM query returned 0 rows; keyword search found {len(fb_rows)}")
                    sql, col_names, rows, timing_ms = fb_sql, fb_cols, fb_rows, timing_ms + fb_ms
                    used_fallback = True
            except Exception as exc:
                logger.warning(f"[FILE] Keyword search fallback failed: {exc}")

    history.append({"question": question, "sql": sql})
    del history[:-3]  # keep the last 3 turns for follow-up questions

    chart = infer_chart(col_names, rows)

    # Meta frame — table and chart render immediately
    yield _sse(
        "meta",
        {
            "sql_query": sql,
            "columns": col_names,
            "rows": rows[:500],
            "row_count": len(rows),
            "timing_ms": timing_ms,
            "chart": chart,
            "engine_used": "file-sqlite",
            "session_id": file_session_id,
            "source": filename,
        },
    )

    # Stream explanation
    explanation = await asyncio.to_thread(
        _explain_results, question, sql, col_names, rows, filename, used_fallback
    )

    # Send as tokens
    words = explanation.split(" ")
    for i, word in enumerate(words):
        chunk = word + (" " if i < len(words) - 1 else "")
        yield _sse("token", {"token": chunk})
        await asyncio.sleep(0.01)  # smooth streaming

    yield _sse("done", {"explanation": explanation})


@router.post("/api/ask-file")
async def ask_file(request: Request, body: AskFileRequest):
    """Stream an answer to a question about an uploaded file."""
    user = await authenticate_request(request)

    question = body.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="Question cannot be empty.")

    return StreamingResponse(
        _stream_file_answer(question, body.file_session_id, str(user.id)),
        media_type="text/event-stream",
        headers={
            "X-Accel-Buffering": "no",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    )


# ── Helpers ───────────────────────────────────────────────────


_STOPWORDS = {
    "a", "an", "the", "and", "or", "of", "in", "on", "at", "to", "for", "from", "by", "with",
    "is", "are", "was", "were", "be", "me", "my", "i", "you", "it", "this", "that", "these",
    "those", "what", "which", "who", "whose", "where", "when", "how", "show", "find", "get",
    "give", "list", "display", "search", "all", "any", "some", "please", "can", "do", "does",
    "data", "row", "rows", "record", "records", "details", "info", "about", "whose", "has",
    "have", "named", "called", "value", "values", "file", "csv", "table", "per", "each",
    "total", "sum", "count", "average", "avg", "max", "min", "top", "number", "many", "much",
    "only", "ones", "also", "than", "more", "less", "between", "order", "orders", "by",
}  # fmt: skip


def _schema_description(table: str, column_info: list[dict], filename: str, n_rows: int) -> str:
    lines = [f'Table: "{table}"  (file: {filename}, {n_rows:,} rows)', "Columns:"]
    for c in column_info:
        samples = ", ".join(repr(s) for s in c["samples"]) or "no values"
        lines.append(f'  - "{c["name"]}" {c["type"]}  e.g. {samples}')
    return "\n".join(lines)


def _sql_str(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _word_match(col_expr: str, term: str) -> str:
    """*term* appears in the cell as a whole word ("ram" matches "Ram Sharma", not "Vikram")."""
    padded = f"(' ' || REPLACE(REPLACE(REPLACE({col_expr}, ',', ' '), '-', ' '), '.', ' ') || ' ')"
    return f"{padded} LIKE {_sql_str('% ' + term + ' %')}"


def _search_terms(question: str, column_info: list[dict]) -> list[str]:
    """
    Words / quoted phrases from the question that may be values in the file.
    Column names ("city", "amount") and filler words are left out — they
    describe what to look at, not what to look for.
    """
    q = question.lower()
    phrases = [a or b for a, b in re.findall(r'"([^"]+)"|\'([^\']+)\'', q)]
    q = re.sub(r'"[^"]*"|\'[^\']*\'', " ", q)
    col_words = set()
    for c in column_info:
        name = c["name"].lower()
        col_words.add(name)
        col_words.update(w for w in name.split("_") if w)
    words = [w.strip(".-") for w in re.findall(r"[\w@.\-]+", q)]
    words = [w for w in words if w not in _STOPWORDS and w not in col_words]
    terms: list[str] = []
    for t in [p.strip() for p in phrases] + words:
        if len(t) > 1 and t not in terms:
            terms.append(t)
    return terms[:8]


def _find_values(
    file_session_id: str, user_id: str, table: str, column_info: list[dict], terms: list[str]
) -> list[dict]:
    """
    For every search term, find the columns whose values equal it, contain it as
    a whole word ("ram" in "Ram Sharma") or only contain it inside another word
    ("ram" in "Vikram"). One scan per column.
    Returns [{term, column, exact, word, contains, examples}].
    """
    if not terms:
        return []
    hits = []
    for c in column_info:
        col = f'LOWER(TRIM(CAST("{c["name"]}" AS TEXT)))'
        parts = []
        for t in terms:
            parts.append(f"SUM({col} = {_sql_str(t)})")
            parts.append(f"SUM({_word_match(col, t)})")
            parts.append(f"SUM({col} LIKE {_sql_str('%' + t + '%')})")
        _, rows, _ = execute_on_file(
            file_session_id, f'SELECT {", ".join(parts)} FROM "{table}"', user_id
        )
        counts = rows[0] if rows else []
        for i, t in enumerate(terms):
            exact, word, contains = (int(n or 0) for n in counts[3 * i : 3 * i + 3])
            if not contains:
                continue
            if exact:
                cond = f"{col} = {_sql_str(t)}"
            elif word:
                cond = _word_match(col, t)
            else:
                cond = f"{col} LIKE {_sql_str('%' + t + '%')}"
            _, ex_rows, _ = execute_on_file(
                file_session_id,
                f'SELECT DISTINCT "{c["name"]}" FROM "{table}" WHERE {cond} LIMIT 3',
                user_id,
            )
            hits.append(
                {
                    "term": t,
                    "column": c["name"],
                    "exact": exact,
                    "word": word,
                    "contains": contains,
                    "examples": [str(r[0]) for r in ex_rows],
                }
            )
    return hits


def _hints_text(terms: list[str], hits: list[dict]) -> str:
    if not terms:
        return ""
    lines = []
    found = set()
    for h in hits:
        found.add(h["term"])
        if h["exact"]:
            how = f"EXACT: whole cell equals it in {h['exact']} row(s)"
        elif h["word"]:
            how = f"WORD: contains it as a whole word in {h['word']} row(s)"
        else:
            how = f"PARTIAL: only inside longer words in {h['contains']} row(s)"
        examples = ", ".join(repr(e) for e in h["examples"])
        lines.append(f'  - "{h["term"]}" → column "{h["column"]}" {how}, e.g. {examples}')
    missing = [t for t in terms if t not in found]
    if missing:
        lines.append(f"  - not found in any column: {', '.join(repr(t) for t in missing)}")
    return "\n".join(lines)


def _keyword_search_sql(table: str, hits: list[dict]) -> str | None:
    """
    Rows that contain the searched words in the columns where they were found.
    An exact cell match scores 3, a whole word 2, a partial one 1; only the best rows
    are returned, so a weak partial match never buries the real answer.
    """
    if not hits:
        return None
    by_term: dict[str, list[dict]] = {}
    for h in hits:
        by_term.setdefault(h["term"], []).append(h)

    scores = []
    for t, hs in by_term.items():
        cols = [f'LOWER(TRIM(CAST("{h["column"]}" AS TEXT)))' for h in hs]
        exact = " OR ".join(f"{c} = {_sql_str(t)}" for c in cols)
        word = " OR ".join(_word_match(c, t) for c in cols)
        partial = " OR ".join(f"{c} LIKE {_sql_str('%' + t + '%')}" for c in cols)
        scores.append(
            f"(CASE WHEN {exact} THEN 3 WHEN {word} THEN 2 WHEN {partial} THEN 1 ELSE 0 END)"
        )
    score = " + ".join(scores)
    return (
        f'SELECT * FROM (SELECT *, {score} AS match_score FROM "{table}") '
        f'WHERE match_score > 0 AND match_score = (SELECT MAX({score}) FROM "{table}") '
        f"LIMIT 500"
    )


def _generate_sql_for_file(
    question: str,
    schema: str,
    table: str,
    hints: str,
    history: list[dict[str, str]],
    hits: list[dict],
) -> str:
    """Generate SQL for the file's SQLite table."""
    if llm_configured():
        try:
            client = _groq_client()
            hints_block = (
                f"Where the words of the question occur in the data "
                f"(looked up in the actual file — trust this over guessing):\n{hints}\n\n"
                if hints
                else ""
            )
            history_block = (
                "Earlier questions in this conversation (for follow-ups like 'and in Pune?'):\n"
                + "\n".join(f"  Q: {h['question']}\n  SQL: {h['sql']}" for h in history)
                + "\n\n"
                if history
                else ""
            )
            prompt = (
                f"You are an expert SQLite data analyst.\n"
                f"Write ONE SQLite SELECT query that answers the question exactly.\n"
                f"Output ONLY the raw SQL, no markdown, no explanation.\n\n"
                f"Schema (with sample values from each column):\n{schema}\n\n"
                f"{hints_block}"
                f"{history_block}"
                f"Rules:\n"
                f'- Use only the table and columns listed above; quote column names with ""\n'
                f"- To filter on a searched value, use the column the lookup above found it in\n"
                f"- How to filter depends on the lookup result for that value:\n"
                f"    EXACT   → LOWER(TRIM(\"col\")) = 'value'\n"
                f"    WORD    → (' ' || LOWER(TRIM(\"col\")) || ' ') LIKE '% value %'   "
                f"(whole word: 'ram' finds 'Ram Sharma' but NOT 'Vikram' or 'Ramesh')\n"
                f"    PARTIAL → LOWER(\"col\") LIKE '%value%'\n"
                f"- Follow-up questions ('and in X?', 'what about Y', 'only the pending ones') "
                f"continue the LAST query above: keep all its filters and change or add only "
                f"what the new question mentions\n"
                f"- Words that describe columns (e.g. 'city', 'price') choose what to show "
                f"or group by — they are not values to filter on\n"
                f"- If a searched value was not found in any column, still filter on it in the "
                f"most likely column (the answer will then be empty) — do NOT drop the filter\n"
                f'- Numbers stored as TEXT: compare with CAST("col" AS REAL)\n'
                f"- Totals/averages/counts: use SUM/AVG/COUNT, with GROUP BY when asked 'per'/'by'\n"
                f"- Otherwise SELECT * so the user sees the whole matching rows, with LIMIT 500\n"
                f"- Exactly one SELECT statement, no comments, no semicolons\n"
                f"- NEVER use INSERT/UPDATE/DELETE/DROP/ATTACH/PRAGMA\n\n"
                f"Question: {question}"
            )
            resp = client.chat.completions.create(
                model=settings.llm_model,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.0,
                max_tokens=400,
            )
            sql = resp.choices[0].message.content or ""
            sql = re.sub(r"^```(?:sql)?", "", sql, flags=re.IGNORECASE).strip()
            sql = re.sub(r"```$", "", sql).strip().rstrip(";")
            if sql.upper().startswith(("SELECT", "WITH")):
                return sql
        except Exception as e:
            logger.warning(f"[FILE] LLM SQL gen failed: {e}")

    # Fallback — rows containing the searched words, else just show the data
    return _keyword_search_sql(table, hits) or f'SELECT * FROM "{table}" LIMIT 100'


def _explain_results(
    question: str,
    sql: str,
    columns: list[str],
    rows: list[list[Any]],
    filename: str,
    used_fallback: bool = False,
) -> str:
    fallback_note = (
        "Note: no row matched the question exactly, so these are the rows that contain "
        "the searched words. Say so plainly.\n"
        if used_fallback
        else ""
    )
    if llm_configured():
        try:
            client = _groq_client()
            preview = json.dumps({"columns": columns, "rows": rows[:10]}, default=str)
            prompt = (
                f'You are a data analyst. The user asked: "{question}"\n'
                f"The data comes from the file: {filename}\n"
                f"SQL used: {sql}\n"
                f"Total rows returned: {len(rows):,}\n"
                f"Results (first 10 rows): {preview}\n"
                f"{fallback_note}\n"
                "Write a concise 2-3 sentence plain-English answer. "
                "Focus on the business meaning, not the SQL. "
                "Only state facts that are in these results — never invent values. "
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


def _llm_analysis(filename: str, rows: int, columns: list[str], stats: str) -> str:
    if not llm_configured():
        return ""
    try:
        client = _groq_client()
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
    filename: str, rows: int, columns: list[str], numeric_cols: list[str]
) -> str:
    return (
        f"'{filename}' contains {rows:,} rows and {len(columns)} columns: "
        f"{', '.join(columns[:6])}{'…' if len(columns) > 6 else ''}. "
        "Ask any question about this data in the chat."
    )
