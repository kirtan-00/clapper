"""SQLite persistence layer.

Design notes
------------
* One process-wide connection in WAL mode, guarded by a re-entrant lock. The
  workload is a single FastAPI process with a background simulator task, so a
  connection pool would add complexity without buying anything.
* `row_factory = sqlite3.Row` everywhere, so callers get dict-like rows and no
  hand-written column-index code leaks into the domain layer.
* High-frequency `readings` are retention-trimmed on a schedule; everything
  else is durable history.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterable, Iterator, Sequence

from .config import settings

_LOCK = threading.RLock()
_CONN: sqlite3.Connection | None = None

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT UNIQUE NOT NULL,
    name          TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    salt          TEXT NOT NULL,
    role          TEXT NOT NULL,              -- admin | manager | engineer | technician | viewer
    skills        TEXT NOT NULL DEFAULT '[]', -- JSON array of skill codes
    phone         TEXT,
    shift         TEXT NOT NULL DEFAULT 'A',
    plant_id      INTEGER,
    active        INTEGER NOT NULL DEFAULT 1,
    created_at    REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS plants (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    name     TEXT NOT NULL,
    industry TEXT NOT NULL,
    location TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS machines (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    plant_id       INTEGER NOT NULL REFERENCES plants(id),
    code           TEXT UNIQUE NOT NULL,
    name           TEXT NOT NULL,
    machine_type   TEXT NOT NULL,
    industry       TEXT NOT NULL,
    criticality    TEXT NOT NULL,          -- critical | high | medium | low
    retrofit       INTEGER NOT NULL,       -- 1 = legacy machine, no onboard sensors
    manufacturer   TEXT,
    model          TEXT,
    install_year   INTEGER,
    rated_power_kw REAL,
    line           TEXT,
    status         TEXT NOT NULL DEFAULT 'running',
    notes          TEXT
);

CREATE TABLE IF NOT EXISTS sensors (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    machine_id  INTEGER NOT NULL REFERENCES machines(id),
    tag         TEXT NOT NULL,
    kind        TEXT NOT NULL,            -- vibration | temperature | current | ...
    unit        TEXT NOT NULL,
    source      TEXT NOT NULL,            -- onboard | edge
    device      TEXT NOT NULL,            -- physical device providing the signal
    placement   TEXT NOT NULL,
    distance_m  REAL NOT NULL DEFAULT 0,  -- distance to machine (edge retrofit)
    nominal     REAL NOT NULL,
    warn_high   REAL,
    crit_high   REAL,
    noise_sigma REAL NOT NULL DEFAULT 0.02,
    status      TEXT NOT NULL DEFAULT 'ok',
    last_seen   REAL,
    UNIQUE(machine_id, tag)
);

CREATE TABLE IF NOT EXISTS readings (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    sensor_id INTEGER NOT NULL REFERENCES sensors(id),
    ts        REAL NOT NULL,
    value     REAL,                       -- NULL encodes a dropped sample
    quality   TEXT NOT NULL DEFAULT 'good'-- good | noisy | missing | stuck | out_of_range
);
CREATE INDEX IF NOT EXISTS idx_readings_sensor_ts ON readings(sensor_id, ts DESC);

CREATE TABLE IF NOT EXISTS health_snapshots (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    machine_id    INTEGER NOT NULL REFERENCES machines(id),
    ts            REAL NOT NULL,
    health_score  REAL NOT NULL,
    anomaly_score REAL NOT NULL,
    confidence    REAL NOT NULL,
    fusion_json   TEXT NOT NULL DEFAULT '{}',
    sensors_json  TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_health_machine_ts ON health_snapshots(machine_id, ts DESC);

CREATE TABLE IF NOT EXISTS predictions (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    machine_id       INTEGER NOT NULL REFERENCES machines(id),
    ts               REAL NOT NULL,
    failure_prob     REAL NOT NULL,
    rul_hours        REAL NOT NULL,
    confidence       REAL NOT NULL,
    failure_category TEXT NOT NULL,
    root_cause       TEXT NOT NULL,
    explanation_json TEXT NOT NULL DEFAULT '[]',
    model_version    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pred_machine_ts ON predictions(machine_id, ts DESC);

CREATE TABLE IF NOT EXISTS alerts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    machine_id    INTEGER NOT NULL REFERENCES machines(id),
    ts            REAL NOT NULL,
    severity      TEXT NOT NULL,          -- critical | high | medium | low
    title         TEXT NOT NULL,
    detail        TEXT NOT NULL,
    source_agent  TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'open',  -- open | acknowledged | resolved | suppressed
    prediction_id INTEGER REFERENCES predictions(id),
    evidence_json TEXT NOT NULL DEFAULT '{}',
    dedupe_key    TEXT,
    ack_by        INTEGER REFERENCES users(id),
    ack_at        REAL,
    resolved_at   REAL,
    resolved_by   INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_alerts_status_ts ON alerts(status, ts DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_dedupe ON alerts(dedupe_key, status);

CREATE TABLE IF NOT EXISTS work_orders (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    code             TEXT UNIQUE NOT NULL,
    machine_id       INTEGER NOT NULL REFERENCES machines(id),
    alert_id         INTEGER REFERENCES alerts(id),
    created_at       REAL NOT NULL,
    priority         TEXT NOT NULL,          -- P1 | P2 | P3 | P4
    action           TEXT NOT NULL,
    rationale        TEXT NOT NULL DEFAULT '',
    skill_required   TEXT NOT NULL,
    parts_json       TEXT NOT NULL DEFAULT '[]',
    est_downtime_h   REAL NOT NULL,
    est_cost         REAL NOT NULL,
    scheduled_start  REAL,
    scheduled_end    REAL,
    status           TEXT NOT NULL DEFAULT 'pending_approval',
    assignee_id      INTEGER REFERENCES users(id),
    approved_by      INTEGER REFERENCES users(id),
    approved_at      REAL,
    completed_at     REAL,
    resolution_notes TEXT,
    actual_downtime_h REAL,
    actual_cost      REAL
);
CREATE INDEX IF NOT EXISTS idx_wo_status ON work_orders(status, created_at DESC);

CREATE TABLE IF NOT EXISTS maintenance_history (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    machine_id     INTEGER NOT NULL REFERENCES machines(id),
    work_order_id  INTEGER REFERENCES work_orders(id),
    ts             REAL NOT NULL,
    kind           TEXT NOT NULL,      -- preventive | corrective | predictive | inspection
    description    TEXT NOT NULL,
    downtime_hours REAL NOT NULL,
    cost           REAL NOT NULL,
    technician     TEXT,
    parts_json     TEXT NOT NULL DEFAULT '[]',
    outcome        TEXT NOT NULL DEFAULT 'completed',
    failure_mode   TEXT
);
CREATE INDEX IF NOT EXISTS idx_hist_machine_ts ON maintenance_history(machine_id, ts DESC);

CREATE TABLE IF NOT EXISTS spare_parts (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    sku            TEXT UNIQUE NOT NULL,
    name           TEXT NOT NULL,
    machine_type   TEXT NOT NULL,
    failure_category TEXT NOT NULL,
    unit_cost      REAL NOT NULL,
    stock          INTEGER NOT NULL,
    lead_time_days INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    channel    TEXT NOT NULL,       -- inapp | email | sms | webhook
    subject    TEXT NOT NULL,
    body       TEXT NOT NULL,
    severity   TEXT NOT NULL DEFAULT 'medium',
    ref_type   TEXT,
    ref_id     INTEGER,
    created_at REAL NOT NULL,
    delivered  INTEGER NOT NULL DEFAULT 1,
    read_at    REAL
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS documents (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    kind       TEXT NOT NULL,   -- manual | sop | failure_mode | history | policy
    machine_id INTEGER REFERENCES machines(id),
    title      TEXT NOT NULL,
    body       TEXT NOT NULL,
    source     TEXT NOT NULL,
    updated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS doc_chunks (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id  INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    ord     INTEGER NOT NULL,
    text    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunk_doc ON doc_chunks(doc_id);

CREATE TABLE IF NOT EXISTS agent_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          REAL NOT NULL,
    agent       TEXT NOT NULL,
    machine_id  INTEGER,
    duration_ms REAL NOT NULL,
    status      TEXT NOT NULL,
    summary     TEXT NOT NULL DEFAULT '',
    detail_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_agentrun_ts ON agent_runs(ts DESC);

CREATE TABLE IF NOT EXISTS audit_log (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       REAL NOT NULL,
    user_id  INTEGER,
    actor    TEXT NOT NULL,
    action   TEXT NOT NULL,
    resource TEXT NOT NULL,
    detail   TEXT NOT NULL DEFAULT '',
    ip       TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts DESC);

CREATE TABLE IF NOT EXISTS feedback (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       REAL NOT NULL,
    user_id  INTEGER NOT NULL REFERENCES users(id),
    ref_type TEXT NOT NULL,   -- alert | prediction | work_order | copilot
    ref_id   INTEGER NOT NULL,
    verdict  TEXT NOT NULL,   -- useful | false_positive | missed | wrong_action
    note     TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


def connect() -> sqlite3.Connection:
    """Return the process-wide connection, creating the schema on first call."""
    global _CONN
    with _LOCK:
        if _CONN is None:
            Path(settings.db_path).parent.mkdir(parents=True, exist_ok=True)
            conn = sqlite3.connect(
                settings.db_path, check_same_thread=False, timeout=30.0
            )
            conn.row_factory = sqlite3.Row
            conn.executescript(SCHEMA)
            conn.commit()
            _CONN = conn
        return _CONN


def close() -> None:
    global _CONN
    with _LOCK:
        if _CONN is not None:
            _CONN.close()
            _CONN = None


@contextmanager
def tx() -> Iterator[sqlite3.Connection]:
    """Serialized write transaction. Commits on success, rolls back on error."""
    conn = connect()
    with _LOCK:
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise


def query(sql: str, params: Sequence[Any] = ()) -> list[sqlite3.Row]:
    conn = connect()
    with _LOCK:
        return conn.execute(sql, params).fetchall()


def query_one(sql: str, params: Sequence[Any] = ()) -> sqlite3.Row | None:
    rows = query(sql, params)
    return rows[0] if rows else None


def execute(sql: str, params: Sequence[Any] = ()) -> int:
    """Run a single statement, returning `lastrowid`."""
    with tx() as conn:
        cur = conn.execute(sql, params)
        return int(cur.lastrowid or 0)


def execute_many(sql: str, seq: Iterable[Sequence[Any]]) -> None:
    with tx() as conn:
        conn.executemany(sql, seq)


def row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    return dict(row) if row is not None else None


def rows_to_dicts(rows: Iterable[sqlite3.Row]) -> list[dict[str, Any]]:
    return [dict(r) for r in rows]


# --- small helpers used across the app ------------------------------------


def kv_get(key: str, default: Any = None) -> Any:
    row = query_one("SELECT value FROM kv WHERE key = ?", (key,))
    if row is None:
        return default
    try:
        return json.loads(row["value"])
    except json.JSONDecodeError:
        return default


def kv_set(key: str, value: Any) -> None:
    execute(
        "INSERT INTO kv(key, value) VALUES(?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, json.dumps(value)),
    )


def is_seeded() -> bool:
    row = query_one("SELECT COUNT(*) AS n FROM machines")
    return bool(row and row["n"] > 0)


def trim_readings(keep_per_sensor: int = 400) -> int:
    """Retention: keep only the most recent N readings per sensor.

    High-frequency sensor data is unbounded by nature; the analytical value is
    in the derived snapshots, not raw samples, so raw retention is short.
    """
    deleted = 0
    with tx() as conn:
        cur = conn.execute(
            """
            DELETE FROM readings
            WHERE id IN (
                SELECT id FROM (
                    SELECT id, ROW_NUMBER() OVER (
                        PARTITION BY sensor_id ORDER BY ts DESC
                    ) AS rn
                    FROM readings
                ) WHERE rn > ?
            )
            """,
            (keep_per_sensor,),
        )
        deleted = cur.rowcount or 0
    return deleted


def audit(
    action: str,
    resource: str,
    *,
    user_id: int | None = None,
    actor: str = "system",
    detail: str = "",
    ip: str | None = None,
) -> None:
    """Append-only audit trail. Never raises — auditing must not break a request."""
    try:
        execute(
            "INSERT INTO audit_log(ts, user_id, actor, action, resource, detail, ip) "
            "VALUES(?,?,?,?,?,?,?)",
            (time.time(), user_id, actor, action, resource, detail[:2000], ip),
        )
    except sqlite3.Error:
        pass
