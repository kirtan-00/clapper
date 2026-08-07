"""Retrieval index — BM25 over the plant knowledge corpus.

Why BM25 and not embeddings
---------------------------
Maintenance questions are dominated by exact identifiers: machine codes (M-102),
part SKUs (BRG-6314-C3), failure-mode names, ISO standards. Lexical retrieval is
*better* than dense retrieval at exactly those, needs no embedding model, no
vector store and no per-query API cost, and rebuilds the whole corpus in
milliseconds. For this corpus size and query shape it is the right tool, not a
compromise — and cost-effectiveness was an explicit requirement.

Two deliberate additions on top of textbook BM25:

* **Field boosting** — a term matching a document title counts for more than one
  buried in the body.
* **Identifier boosting** — an exact machine-code or SKU match is decisive, so it
  is scored separately rather than being diluted by term frequency statistics.

The index is rebuilt from SQLite on demand and held in memory.
"""

from __future__ import annotations

import math
import re
import threading
from collections import Counter, defaultdict
from typing import Any

from .. import db

# Hyphens, underscores and dots stay inside a token so identifiers survive
# ("m-102", "brg-6314-c3", "iso-10816", "vg220"). Slashes do NOT: they join two
# real words into one unsearchable token, so "lockout/tagout" would never match
# a search for "lockout" — and that is a safety procedure nobody could find.
TOKEN_RE = re.compile(r"[a-z0-9][a-z0-9\-_.]*")
# Identifier shapes that should be matched exactly: M-102, BRG-6314-C3, WO-1042.
IDENT_RE = re.compile(r"\b[A-Z]{1,4}-[A-Z0-9]{1,8}(?:-[A-Z0-9]{1,8})*\b")

STOPWORDS = {
    "the", "a", "an", "and", "or", "of", "to", "in", "is", "are", "for", "on",
    "with", "as", "at", "by", "it", "this", "that", "be", "from", "was", "were",
    "has", "have", "had", "will", "can", "should", "we", "you", "i", "if", "not",
    "but", "what", "why", "how", "when", "which", "do", "does", "me", "my",
}

K1 = 1.5
B = 0.75
TITLE_BOOST = 2.6
IDENT_BOOST = 6.0


def tokenize(text: str) -> list[str]:
    return [
        token
        for token in TOKEN_RE.findall((text or "").lower())
        if token not in STOPWORDS and len(token) > 1
    ]


def extract_identifiers(text: str) -> list[str]:
    return sorted(set(IDENT_RE.findall((text or "").upper())))


class Document:
    __slots__ = ("chunk_id", "doc_id", "kind", "title", "text", "source",
                 "machine_id", "tokens", "counts", "length", "identifiers")

    def __init__(
        self,
        chunk_id: int,
        doc_id: int,
        kind: str,
        title: str,
        text: str,
        source: str,
        machine_id: int | None,
    ) -> None:
        self.chunk_id = chunk_id
        self.doc_id = doc_id
        self.kind = kind
        self.title = title
        self.text = text
        self.source = source
        self.machine_id = machine_id
        self.tokens = tokenize(text)
        self.counts = Counter(self.tokens)
        self.length = len(self.tokens) or 1
        self.identifiers = set(extract_identifiers(f"{title} {text}"))


class BM25Index:
    def __init__(self) -> None:
        self.documents: list[Document] = []
        self.postings: dict[str, list[int]] = defaultdict(list)
        self.title_tokens: list[set[str]] = []
        self.avg_length = 1.0
        self.built_at: float | None = None
        self._lock = threading.RLock()

    # -- building -----------------------------------------------------------

    def build(self) -> dict[str, Any]:
        """(Re)build the index from the `doc_chunks` table."""
        import time

        with self._lock:
            rows = db.query(
                "SELECT c.id AS chunk_id, c.text, d.id AS doc_id, d.kind, d.title, "
                "d.source, d.machine_id FROM doc_chunks c "
                "JOIN documents d ON d.id = c.doc_id ORDER BY c.doc_id, c.ord"
            )
            self.documents = []
            self.postings = defaultdict(list)
            self.title_tokens = []

            for row in rows:
                doc = Document(
                    row["chunk_id"], row["doc_id"], row["kind"], row["title"],
                    row["text"], row["source"], row["machine_id"],
                )
                index = len(self.documents)
                self.documents.append(doc)
                self.title_tokens.append(set(tokenize(doc.title)))
                for token in doc.counts:
                    self.postings[token].append(index)

            self.avg_length = (
                sum(d.length for d in self.documents) / len(self.documents)
                if self.documents
                else 1.0
            )
            self.built_at = time.time()
            return {
                "chunks": len(self.documents),
                "vocabulary": len(self.postings),
                "avg_chunk_tokens": round(self.avg_length, 1),
            }

    def ensure_built(self) -> None:
        if self.built_at is None:
            self.build()

    # -- searching ----------------------------------------------------------

    def _idf(self, token: str) -> float:
        n = len(self.documents)
        df = len(self.postings.get(token, ()))
        if df == 0:
            return 0.0
        # BM25 IDF with the +0.5 smoothing that keeps common terms non-negative.
        return math.log(1.0 + (n - df + 0.5) / (df + 0.5))

    def search(
        self,
        query: str,
        top_k: int = 6,
        machine_id: int | None = None,
        kinds: tuple[str, ...] | None = None,
    ) -> list[dict[str, Any]]:
        self.ensure_built()
        with self._lock:
            if not self.documents:
                return []

            tokens = tokenize(query)
            identifiers = set(extract_identifiers(query))
            if not tokens and not identifiers:
                return []

            scores: dict[int, float] = defaultdict(float)
            for token in tokens:
                idf = self._idf(token)
                if idf <= 0:
                    continue
                for index in self.postings.get(token, ()):
                    doc = self.documents[index]
                    tf = doc.counts[token]
                    denominator = tf + K1 * (1 - B + B * doc.length / self.avg_length)
                    score = idf * (tf * (K1 + 1)) / denominator
                    if token in self.title_tokens[index]:
                        score *= TITLE_BOOST
                    scores[index] += score

            # Exact identifier hits are decisive — "why is M-102 critical" must
            # retrieve M-102's records, not a lexically similar machine.
            if identifiers:
                for index, doc in enumerate(self.documents):
                    overlap = identifiers & doc.identifiers
                    if overlap:
                        scores[index] += IDENT_BOOST * len(overlap)

            results: list[dict[str, Any]] = []
            for index, score in scores.items():
                doc = self.documents[index]
                if machine_id is not None and doc.machine_id not in (None, machine_id):
                    continue
                if kinds and doc.kind not in kinds:
                    continue
                results.append(
                    {
                        "chunk_id": doc.chunk_id,
                        "doc_id": doc.doc_id,
                        "kind": doc.kind,
                        "title": doc.title,
                        "text": doc.text,
                        "source": doc.source,
                        "machine_id": doc.machine_id,
                        "score": round(score, 4),
                    }
                )

            results.sort(key=lambda r: r["score"], reverse=True)
            return results[:top_k]

    def stats(self) -> dict[str, Any]:
        return {
            "chunks": len(self.documents),
            "vocabulary": len(self.postings),
            "built_at": self.built_at,
            "avg_chunk_tokens": round(self.avg_length, 1),
        }


index = BM25Index()


# --- corpus authoring ------------------------------------------------------

CHUNK_TARGET_CHARS = 620


def chunk_text(body: str) -> list[str]:
    """Split a document on paragraph boundaries into retrieval-sized chunks.

    Paragraph-aligned rather than fixed-width: splitting mid-sentence produces
    chunks that read as nonsense when cited back to the user, and a citation the
    user cannot read is not a citation.
    """
    paragraphs = [p.strip() for p in (body or "").split("\n\n") if p.strip()]
    chunks: list[str] = []
    current = ""
    for paragraph in paragraphs:
        if not current:
            current = paragraph
        elif len(current) + len(paragraph) + 2 <= CHUNK_TARGET_CHARS:
            current = f"{current}\n\n{paragraph}"
        else:
            chunks.append(current)
            current = paragraph
    if current:
        chunks.append(current)
    return chunks or [body.strip()] if body.strip() else []


def upsert_document(
    *, kind: str, title: str, body: str, source: str, machine_id: int | None = None
) -> int:
    """Insert or replace a document and its chunks, then invalidate the index."""
    import time

    existing = db.query_one(
        "SELECT id FROM documents WHERE title = ? AND source = ?", (title, source)
    )
    if existing:
        doc_id = int(existing["id"])
        db.execute(
            "UPDATE documents SET kind=?, body=?, machine_id=?, updated_at=? WHERE id=?",
            (kind, body, machine_id, time.time(), doc_id),
        )
        db.execute("DELETE FROM doc_chunks WHERE doc_id = ?", (doc_id,))
    else:
        doc_id = db.execute(
            "INSERT INTO documents(kind, machine_id, title, body, source, updated_at) "
            "VALUES(?,?,?,?,?,?)",
            (kind, machine_id, title, body, source, time.time()),
        )

    chunks = chunk_text(body)
    if chunks:
        db.execute_many(
            "INSERT INTO doc_chunks(doc_id, ord, text) VALUES(?,?,?)",
            [(doc_id, i, chunk) for i, chunk in enumerate(chunks)],
        )
    index.built_at = None  # force a rebuild on next search
    return doc_id
