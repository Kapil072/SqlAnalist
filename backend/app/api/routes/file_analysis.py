"""
File analysis endpoint — POST /api/analyze-file
Accepts CSV or Excel uploads, parses them with pandas,
and uses the LLM to produce a plain-English analysis.
No data is stored — everything is in memory.
"""
import io
import json
from typing import Any, Dict, List
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from app.core.security import get_current_user
from app.models.user import User
from app.config import settings
from app.utils.logger import logger

router = APIRouter(tags=["analysis"])

ALLOWED_TYPES = {
    "text/csv",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/octet-stream",
}
MAX_SIZE_MB = 10


@router.post("/api/analyze-file")
async def analyze_file(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
):
    """
    Parse a CSV or Excel file and return:
      - filename, row count, column names
      - first 5 rows as preview
      - a plain-English analysis from the LLM (or rule-based fallback)
    """
    try:
        import pandas as pd
    except ImportError:
        raise HTTPException(status_code=500, detail="pandas is required for file analysis")

    # Size guard
    contents = await file.read()
    size_mb = len(contents) / (1024 * 1024)
    if size_mb > MAX_SIZE_MB:
        raise HTTPException(status_code=400, detail=f"File too large. Max {MAX_SIZE_MB}MB.")

    filename = file.filename or "upload"
    ext = filename.rsplit(".", 1)[-1].lower()

    # Parse
    try:
        if ext == "csv":
            df = pd.read_csv(io.BytesIO(contents), nrows=10000)
        elif ext in ("xlsx", "xls"):
            df = pd.read_excel(io.BytesIO(contents), nrows=10000)
        else:
            raise HTTPException(status_code=400, detail="Only CSV and Excel (.xlsx, .xls) files are supported.")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not parse file: {exc}")

    rows, cols = df.shape
    columns: List[str] = list(df.columns.astype(str))

    # Preview — first 5 rows, serialise safely
    preview_df = df.head(5).fillna("").astype(str)
    preview: List[Dict[str, Any]] = preview_df.to_dict(orient="records")

    # Stats summary for LLM / fallback
    numeric_cols = list(df.select_dtypes(include="number").columns)
    stats_lines = []
    for c in numeric_cols[:6]:
        s = df[c].describe()
        stats_lines.append(
            f"{c}: min={s['min']:.2f}, max={s['max']:.2f}, mean={s['mean']:.2f}"
        )

    stats_text = "\n".join(stats_lines) if stats_lines else "No numeric columns found."

    # Try LLM analysis
    analysis = _llm_analysis(filename, rows, columns, stats_text)
    if not analysis:
        analysis = _fallback_analysis(filename, rows, columns, numeric_cols, df)

    logger.info(f"[FILE] Analysed {filename}: {rows} rows × {len(columns)} cols by {current_user.email}")

    return {
        "filename": filename,
        "rows": rows,
        "columns": columns,
        "preview": preview,
        "analysis": analysis,
    }


def _llm_analysis(filename: str, rows: int, columns: List[str], stats: str) -> str:
    key = settings.groq_api_key.strip()
    if not key or not key.startswith("gsk_"):
        return ""
    try:
        from groq import Groq
        client = Groq(api_key=key)
        prompt = (
            f"You are a data analyst. A user uploaded a file called '{filename}' "
            f"with {rows} rows and these columns: {', '.join(columns)}.\n\n"
            f"Numeric column statistics:\n{stats}\n\n"
            "Write a concise 3-4 sentence plain-English summary of what this dataset contains, "
            "its structure, and one interesting insight visible in the statistics. "
            "Do not use markdown. Be direct and professional."
        )
        resp = client.chat.completions.create(
            model=settings.llm_model,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.3,
            max_tokens=200,
        )
        return resp.choices[0].message.content or ""
    except Exception as e:
        logger.warning(f"[FILE] LLM analysis failed: {e}")
        return ""


def _fallback_analysis(
    filename: str,
    rows: int,
    columns: List[str],
    numeric_cols: List[str],
    df: Any,
) -> str:
    parts = [
        f"The file '{filename}' contains {rows:,} rows and {len(columns)} columns: "
        f"{', '.join(columns[:8])}{'...' if len(columns) > 8 else ''}."
    ]
    if numeric_cols:
        top = numeric_cols[0]
        mn = df[top].min()
        mx = df[top].max()
        parts.append(f"The column '{top}' ranges from {mn} to {mx}.")
    parts.append("You can ask questions about this data using the chat below.")
    return " ".join(parts)
