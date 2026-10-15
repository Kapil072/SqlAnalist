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

Performance notes
-----------------
- The SentenceTransformer model is loaded once and shared across all sessions.
- Call `warmup()` at app startup to pay the cold-load cost before the first
  real request arrives (avoids a 3-5s spike on the first question).
- `add()` and `retrieve()` run the CPU-bound encode() synchronously.
  Call them via asyncio.to_thread() from async contexts.
- With RAG_ENABLED=false, or when faiss / sentence-transformers are not
  installed, retrieval falls back to keyword overlap. That needs no model,
  which keeps memory low on small hosts (the model alone is ~500 MB of RAM).
"""

from __future__ import annotations

import importlib.util
import re
import threading
from dataclasses import dataclass, field
from typing import Any

from app.config import settings

# ---------------------------------------------------------------------------
# Lazy imports – keep startup fast; load heavy libs on first use
# ---------------------------------------------------------------------------
_faiss: Any = None
_SentenceTransformer: Any = None
_np: Any = None


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


_EMBEDDINGS_AVAILABLE = (
    settings.rag_enabled
    and importlib.util.find_spec("faiss") is not None
    and importlib.util.find_spec("sentence_transformers") is not None
)


def embeddings_enabled() -> bool:
    """True when the embedding model is used; False means keyword fallback."""
    return _EMBEDDINGS_AVAILABLE


_WORD_RE = re.compile(r"[a-z0-9_]+")


def _keywords(text: str) -> set[str]:
    return {w for w in _WORD_RE.findall(text.lower()) if len(w) > 2}


# ---------------------------------------------------------------------------
# Embedding model (shared across all sessions – loaded once)
# ---------------------------------------------------------------------------
_embed_model: object | None = None
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


def warmup() -> None:
    """
    Pre-load the embedding model and run one dummy encode.
    Call this once at app startup so the first real request is fast.
    """
    if not embeddings_enabled():
        return
    _load_libs()
    model = _get_embed_model()
    model.encode(["warmup"], convert_to_numpy=True)


def _embed(texts: list[str]):
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
    _texts: list[str] = field(default_factory=list)
    _index: Any = field(default=None, repr=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def add(self, question: str, answer: str) -> None:
        """Embed and store a completed Q&A pair. CPU-bound — use to_thread."""
        payload = f"Q: {question}\nA: {answer}"
        if not embeddings_enabled():
            with self._lock:
                self._texts.append(payload)
            return

        _load_libs()
        vec = _embed([payload])  # shape (1, dim)

        with self._lock:
            self._texts.append(payload)
            if self._index is None:
                dim = vec.shape[1]
                # Inner-product on L2-normalised vecs == cosine similarity
                self._index = _faiss.IndexFlatIP(dim)
            self._index.add(vec)

    def retrieve(self, query: str, top_k: int = 3) -> list[str]:
        """
        Return the top-k most relevant past Q&A snippets for *query*.
        Returns an empty list if the index is empty.
        CPU-bound — use to_thread when calling from async code.
        """
        if not embeddings_enabled():
            return self._retrieve_keywords(query, top_k)

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

    def _retrieve_keywords(self, query: str, top_k: int) -> list[str]:
        """Rank stored turns by shared words with *query* (no model needed)."""
        query_words = _keywords(query)
        with self._lock:
            texts = list(self._texts)
        scored = [(len(query_words & _keywords(t)), i) for i, t in enumerate(texts)]
        # Most overlap first; newer turns win ties
        scored.sort(key=lambda pair: (pair[0], pair[1]), reverse=True)
        return [texts[i] for score, i in scored[:top_k] if score > 0]

    def size(self) -> int:
        """Number of stored Q&A pairs."""
        return len(self._texts)


# ---------------------------------------------------------------------------
# Global session registry
# ---------------------------------------------------------------------------
_sessions: dict[str, SessionRAG] = {}
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
