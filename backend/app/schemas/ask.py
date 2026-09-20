# Simplified request/response schemas using dataclasses

from dataclasses import dataclass, field
from typing import List, Any, Optional


@dataclass
class AskRequest:
    """Input from client for an ask operation."""
    session_id: str
    question: str


@dataclass
class AskResponse:
    """Output returned after processing the ask request."""
    answer_text: str
    sql_used: Optional[str] = None
    chart_image: Optional[str] = None  # base64 data URI
    chart_type: Optional[str] = None
    row_count: int = 0
    timing_ms: int = 0
    insights: List[str] = field(default_factory=list)
    columns: List[str] = field(default_factory=list)
    rows: List[List[Any]] = field(default_factory=list)
    status: str = "success"
    error: Optional[str] = None
