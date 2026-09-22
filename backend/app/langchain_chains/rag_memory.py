"""
In-memory RAG for chat history.

Each user session gets its own SessionRAG instance stored in a process-level
dict.  There is NO persistence — data lives only while the process is running
and is automatically discarded when the session entry is removed or the server
restarts.

Flow
----
1. User asks a question  →  retrieve relevant past turns via FAISS
2. Inject retrieved context into the LLM prompt
3. After the LLM answers  →  embed & store the new (question, answer) pair
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from typing import Dict, List, Optional

# ---------------------------------------------------------------------------
# Lazy imports – keep startup fast; load heavy libs on first use
# ---------------------------------------------------------------------------
_faiss = None
_SentenceTransformer = None
_np = None


def _load_libs():
    global _faiss, _SentenceTransformer, _np
    if _faiss is None:
        import faiss as _f
        _faiss = _f
    if _SentenceTransformer is None:
        from sentence_transformers import SentenceTransformer as _ST
        _SentenceTransformer = _ST
    if _np is None:
        import numpy as _n
        _np = _n


# ---------------------------------------------------------------------------
# Embedding model (shared across all sessions – loaded once)
# ---------------------------------------------------------------------------
_embed_model: Optional[object] = None
_embed_lock = threading.Lock()
EMBED_MODEL_NAME = "all-MiniLM-L6-v2"  # small, fast, 384-dim


def _get_embed_model():
    global _embed_model
    if _embed_model is None:
        with _embed_lock:
            if _embed_model is None:
                _load_libs()
                _embed_model = _SentenceTransformer(EMBED_MODEL_NAME)
    return _embed_model


def _embed(texts: List[str]):
    """Return a (n, dim) float32 numpy array."""
    _load_libs()
    model = _get_embed_model()
    vecs = model.encode(texts, convert_to_numpy=True, normalize_embeddings=True)
    return _np.array(vecs, dtype=_np.float32)


# ---------------------------------------------------------------------------
# Single-session RAG store
# ---------------------------------------------------------------------------
@dataclass
class SessionRAG:
    """
    Holds an in-memory FAISS index and the corresponding text payloads
    for one user session.

    Thread safety: protected by a per-instance lock so concurrent SSE
    streams on the same session_id don't corrupt the index.
    """

    session_id: str
    _texts: List[str] = field(default_factory=list)
    _index: Optional[object] = field(default=None, repr=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def add(self, question: str, answer: str) -> None:
        """Embed and store a completed Q&A pair."""
        _load_libs()
        payload = f"Q: {question}\nA: {answer}"
        vec = _embed([payload])  # shape (1, dim)

        with self._lock:
            self._texts.append(payload)
            if self._index is None:
                dim = vec.shape[1]
                # Inner-product on L2-normalised vecs == cosine similarity
                self._index = _faiss.IndexFlatIP(dim)
            self._index.add(vec)

    def retrieve(self, query: str, top_k: int = 3) -> List[str]:
        """
        Return the top-k most relevant past Q&A snippets for *query*.
        Returns an empty list if the index is empty.
        """
        with self._lock:
            if self._index is None or self._index.ntotal == 0:
                return []

            _load_libs()
            qvec = _embed([query])  # shape (1, dim)
            k = min(top_k, self._index.ntotal)
            _scores, indices = self._index.search(qvec, k)

            results = []
            for idx in indices[0]:
                if 0 <= idx < len(self._texts):
                    results.append(self._texts[idx])
            return results

    def size(self) -> int:
        """Number of stored Q&A pairs."""
        return len(self._texts)


# ---------------------------------------------------------------------------
# Global session registry
# ---------------------------------------------------------------------------
_sessions: Dict[str, SessionRAG] = {}
_registry_lock = threading.Lock()

MAX_SESSIONS = 500  # safety cap – oldest sessions evicted if exceeded


def get_session_rag(session_id: str) -> SessionRAG:
    """Return (creating if needed) the SessionRAG for *session_id*."""
    with _registry_lock:
        if session_id not in _sessions:
            # Evict oldest session if cap exceeded
            if len(_sessions) >= MAX_SESSIONS:
                oldest_key = next(iter(_sessions))
                del _sessions[oldest_key]
            _sessions[session_id] = SessionRAG(session_id=session_id)
        return _sessions[session_id]


def clear_session_rag(session_id: str) -> None:
    """Remove a session's RAG store (call on explicit logout/clear)."""
    with _registry_lock:
        _sessions.pop(session_id, None)


def session_count() -> int:
    """Diagnostic: number of active RAG sessions in memory."""
    return len(_sessions)
