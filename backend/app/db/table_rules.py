"""
Table rules (primary key, foreign keys, unique and CHECK constraints) read
with SQLAlchemy's inspector, so the LLM can write INSERT / UPDATE statements
the database will accept — e.g. order_status = 'Completed', not 'completed'.
"""

from typing import Any

from app.utils.logger import logger


def table_rules(insp: Any, table: str) -> dict[str, Any]:
    """Return {primary_key, foreign_keys, unique, checks} for *table*; missing parts are left out."""
    rules: dict[str, Any] = {}
    try:
        pk = insp.get_pk_constraint(table).get("constrained_columns") or []
        if pk:
            rules["primary_key"] = pk
    except Exception as e:
        logger.debug(f"[SCHEMA] No primary key info for {table}: {e}")
    try:
        fks = [
            f"{', '.join(fk['constrained_columns'])} → "
            f"{fk['referred_table']}({', '.join(fk['referred_columns'])})"
            for fk in insp.get_foreign_keys(table)
        ]
        if fks:
            rules["foreign_keys"] = fks
    except Exception as e:
        logger.debug(f"[SCHEMA] No foreign key info for {table}: {e}")
    try:
        uniques = [u["column_names"] for u in insp.get_unique_constraints(table)]
        if uniques:
            rules["unique"] = uniques
    except Exception as e:
        logger.debug(f"[SCHEMA] No unique constraint info for {table}: {e}")
    try:
        checks = [
            {"name": c.get("name"), "rule": str(c.get("sqltext"))}
            for c in insp.get_check_constraints(table)
        ]
        if checks:
            rules["checks"] = checks
    except Exception as e:
        logger.debug(f"[SCHEMA] No check constraint info for {table}: {e}")
    return rules
