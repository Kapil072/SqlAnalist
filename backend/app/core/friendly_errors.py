"""
Turn database / driver / LLM exceptions into one plain-English sentence for
the UI — the reason the query did not run and what to do about it — instead
of driver class names, echoed SQL and documentation links.

The full exception is still written to the log by the caller.
"""

import re
from typing import Any


def _text(exc: BaseException) -> str:
    return str(getattr(exc, "orig", None) or exc)


def short_db_error(exc: BaseException) -> str:
    """The driver message without SQLAlchemy's class names, echoed SQL and doc link."""
    t = str(exc)
    t = re.sub(r"\[SQL:.*", "", t, flags=re.DOTALL)
    t = re.sub(r"\[parameters:.*", "", t, flags=re.DOTALL)
    t = re.sub(r"\(Background on this error at:.*", "", t, flags=re.DOTALL)
    t = re.sub(r"\x1b\[[0-9;]*m", "", t)  # terminal colour codes from sqlglot
    t = re.sub(r"^\([\w.]+\)\s*(<class '[\w.]+'>:\s*)?", "", t.strip())
    return " ".join(t.split())


def _check_rule(msg: str, schema: dict[str, Any] | None) -> str | None:
    m = re.search(r'check constraint "?([\w.]+)"?', msg, re.IGNORECASE)
    if not m:
        return None
    for info in (schema or {}).get("tables", {}).values():
        for check in info.get("checks", []):
            if str(check.get("name", "")).lower() == m.group(1).lower():
                return _readable_check(check["rule"])
    return None


def _readable_check(rule: str) -> str:
    """"order_status::text = ANY (ARRAY['Pending'::character varying, ...])" → "order_status must be one of: Pending, ..."."""
    values = re.findall(r"'([^']*)'(?:::[\w ]+)?", rule)
    col = re.match(r"\(*\s*\"?(\w+)", rule)
    if values and col and ("ANY" in rule.upper() or " IN " in rule.upper()):
        return f"{col.group(1)} must be one of: {', '.join(values)}"
    m = re.match(r"\(*\s*\"?(\w+)\"?\s*(>=|<=|>|<|<>|!=)\s*\(*(-?[\d.]+)", rule)
    if m:
        words = {">=": "0 or more" if m.group(3) == "0" else f"at least {m.group(3)}",
                 ">": f"more than {m.group(3)}", "<=": f"at most {m.group(3)}",
                 "<": f"less than {m.group(3)}"}  # fmt: skip
        return f"{m.group(1)} must be {words.get(m.group(2), m.group(2) + ' ' + m.group(3))}"
    return rule


def missing_reference(exc: BaseException) -> tuple[str, str, str] | None:
    """(column, value, table) from 'Key (employee_id)=(45) is not present in table "employees"'."""
    m = re.search(
        r'Key \(([^)]+)\)=\(([^)]*)\) is not present in table "?([\w.]+)"?', _text(exc)
    )
    return (m.group(1), m.group(2), m.group(3)) if m else None


def explain_error(exc: BaseException, schema: dict[str, Any] | None = None) -> str | None:
    """A simple reason for the most common failures, or None when we do not recognise it."""
    raw = _text(exc)
    msg = raw.lower()

    # ── Data rules (INSERT / UPDATE / DELETE) ──
    missing = missing_reference(exc)
    if missing:
        col, value, table = missing
        return (
            f"{col} {value} does not exist in the {table} table. Use an existing "
            f"{col}, or add it to {table} first."
        )
    if "cannot add or update a child row" in msg:
        return "A value points to a row that does not exist in the linked table."
    if "still referenced" in msg or "cannot delete or update a parent row" in msg:
        m = re.search(r'referenced from table "?([\w.]+)"?', raw)
        where = f" in {m.group(1)}" if m else ""
        return (
            f"Other rows{where} still use this row, so it cannot be removed. "
            "Delete or change those rows first."
        )
    if "foreign key constraint failed" in msg:  # SQLite does not say which way
        return "This change breaks a link between tables (a value must match a row in another table)."
    if "check constraint" in msg or "checkviolation" in msg:
        rule = _check_rule(raw, schema)
        if not rule:
            return "A value is not allowed by the table's rules."
        spelling = " Spelling and capital letters must match." if "one of" in rule else ""
        return f"A value is not allowed: {rule}.{spelling}"
    m = re.search(r"Key \(([^)]+)\)=\(([^)]*)\) already exists", raw)
    if m:
        return f"{m.group(1)} {m.group(2)} already exists. Use a different value."
    if "unique constraint" in msg or "duplicate entry" in msg or "duplicate key" in msg:
        return "A row with the same unique value already exists. Use a different value."
    m = re.search(r'null value in column "?(\w+)"?', raw, re.IGNORECASE) or re.search(
        r"NOT NULL constraint failed: [\w.]*?(\w+)$", raw.strip()
    )
    if m or "cannot be null" in msg:
        col = f" {m.group(1)}" if m else ""
        return f"The required column{col} was left empty. Give it a value."
    if "invalid input syntax for type" in msg or ("incorrect" in msg and "value" in msg):
        m = re.search(r'for type (\w+(?: \w+)?): "([^"]*)"', raw)
        if m:
            return f'"{m.group(2)}" is not a valid {m.group(1)}.'
        return "A value has the wrong format for its column (for example text in a number column)."
    if "date/time field value out of range" in msg or "invalid date" in msg:
        return "A date is not valid. Use the format YYYY-MM-DD, e.g. 2023-11-26."
    if "value too long" in msg or "data too long" in msg:
        return "A text value is longer than the column allows."
    if "numeric field overflow" in msg or "out of range" in msg:
        return "A number is too large for its column."

    # ── Query problems ──
    m = re.search(r'column "?([\w.]+)"? does not exist', raw, re.IGNORECASE) or re.search(
        r"no such column: ([\w.]+)", raw
    ) or re.search(r"Unknown column '([\w.]+)'", raw)
    if m:
        return f"The column {m.group(1)} does not exist in this table."
    m = re.search(r'relation "?([\w.]+)"? does not exist', raw) or re.search(
        r"no such table: ([\w.]+)", raw
    ) or re.search(r"Table '([\w.]+)' doesn't exist", raw)
    if m:
        return f"The table {m.group(1)} does not exist in this database."
    if "syntax error" in msg or "parse error" in msg or "unexpected token" in msg:
        m = re.search(r'at or near "([^"]+)"', raw) or re.search(r"near \"?([^\"]+?)\"?:", raw)
        near = f" near '{m.group(1)}'" if m else ""
        return f"The SQL has a mistake{near}. Check the spelling, or ask the question in words."
    if "division by zero" in msg:
        return "The query divides by zero."
    if "statement timeout" in msg or "canceling statement" in msg or "timed out" in msg:
        return "The query took too long and was stopped. Try a narrower question."

    # ── Permissions / connection ──
    if "permission denied" in msg or "access denied" in msg or "read-only" in msg or "readonly" in msg:
        return (
            "The database account is not allowed to do this. Give it permission, "
            "or connect with another account."
        )
    if "password authentication failed" in msg or "authentication failed" in msg:
        return "Wrong username or password for this database."
    if "could not translate host name" in msg or "name or service not known" in msg or "getaddrinfo" in msg:
        return "The database host name could not be found. Check the host."
    if "connection refused" in msg or "could not connect" in msg or "connect call failed" in msg:
        return "Could not reach the database. Check that it is running and the host and port are right."
    if "database" in msg and "does not exist" in msg:
        return "That database name does not exist on the server."
    if "locked" in msg:
        return "The database is busy or locked by another program. Try again in a moment."
    if "stored password cannot be decrypted" in msg:
        return "The saved password for this database can no longer be read. Re-enter it."

    # ── AI ──
    if "rate limit" in msg or "rate_limit" in msg or "error code: 429" in msg:
        return "The AI service is busy (rate limit). Wait a moment and try again."
    if "invalid api key" in msg or "invalid_api_key" in msg or "error code: 401" in msg:
        return "The AI service key is not valid. Check GROQ_API_KEY in backend/.env."

    # ── Files ──
    if "no columns to parse" in msg or ("empty" in msg and "file" in msg):
        return "The file is empty."
    if "codec can't decode" in msg or "unicodedecodeerror" in msg:
        return "The file's text encoding could not be read. Save it as UTF-8 CSV and upload again."
    if "error tokenizing data" in msg or ("expected" in msg and "fields" in msg):
        return "Some rows have a different number of columns than the header."
    if "file session not found" in msg:
        return "The uploaded file has expired. Please upload it again."

    return None


def friendly_message(
    message: str,
    exc: BaseException,
    schema: dict[str, Any] | None = None,
    show_details: bool = False,
) -> str:
    """'<message>: <simple reason>' — falls back to the short driver message outside production."""
    reason = explain_error(exc, schema)
    if reason:
        return f"{message}: {reason}"
    if show_details:
        detail = short_db_error(exc)
        if detail:
            return f"{message}: {detail[:300]}"
    return f"{message}."


def sql_parse_error(exc: BaseException) -> str:
    """'The SQL has a mistake near '92'.' instead of sqlglot's coloured multi-line report."""
    near = None
    errors = getattr(exc, "errors", None) or []
    if errors and isinstance(errors[0], dict):
        near = (errors[0].get("highlight") or "").strip() or None
    if near is None:
        m = re.search(r"\x1b\[4m(.*?)\x1b\[0m", str(exc))
        near = m.group(1).strip() if m else None
    where = f" near '{near}'" if near else ""
    return f"The SQL has a mistake{where}. Check the spelling, or ask the question in words."
