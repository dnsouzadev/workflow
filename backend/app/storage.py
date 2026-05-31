import json
import sqlite3
import threading
import uuid
from datetime import datetime
from pathlib import Path


def utc_now():
    return datetime.utcnow().isoformat() + "Z"


class RunStorage:
    def __init__(self, db_path: str):
        self.db_path = str(db_path)
        self._lock = threading.Lock()
        self._init_db()

    def _connect(self):
        conn = sqlite3.connect(self.db_path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self):
        Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
        with self._lock, self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS runs (
                    run_id TEXT PRIMARY KEY,
                    status TEXT NOT NULL,
                    started_at TEXT NOT NULL,
                    finished_at TEXT,
                    error TEXT
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS node_runs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_id TEXT NOT NULL,
                    node_id TEXT NOT NULL,
                    attempt INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    started_at TEXT NOT NULL,
                    finished_at TEXT NOT NULL,
                    output_json TEXT,
                    error TEXT,
                    logs TEXT,
                    FOREIGN KEY(run_id) REFERENCES runs(run_id)
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS workflows (
                    workflow_id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    description TEXT,
                    payload_json TEXT NOT NULL,
                    version INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS workflow_versions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    workflow_id TEXT NOT NULL,
                    version INTEGER NOT NULL,
                    payload_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(workflow_id) REFERENCES workflows(workflow_id)
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS secrets (
                    secret_id TEXT PRIMARY KEY,
                    name TEXT NOT NULL UNIQUE,
                    value TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS schedules (
                    schedule_id TEXT PRIMARY KEY,
                    workflow_id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    cron TEXT NOT NULL,
                    last_run_at TEXT,
                    next_run_at TEXT,
                    enabled INTEGER DEFAULT 1,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(workflow_id) REFERENCES workflows(workflow_id)
                )
                """
            )
            conn.commit()

    def create_run(self):
        run_id = str(uuid.uuid4())
        started_at = utc_now()
        with self._lock, self._connect() as conn:
            conn.execute(
                "INSERT INTO runs (run_id, status, started_at) VALUES (?, ?, ?)",
                (run_id, "running", started_at),
            )
            conn.commit()
        return run_id

    def finish_run(self, run_id, status, error=None):
        finished_at = utc_now()
        with self._lock, self._connect() as conn:
            conn.execute(
                "UPDATE runs SET status = ?, finished_at = ?, error = ? WHERE run_id = ?",
                (status, finished_at, error, run_id),
            )
            conn.commit()

    def record_node_attempt(
        self,
        run_id,
        node_id,
        attempt,
        status,
        started_at,
        finished_at,
        output=None,
        error=None,
        logs=None,
    ):
        output_json = None
        if output is not None:
            output_json = json.dumps(output)
        with self._lock, self._connect() as conn:
            conn.execute(
                """
                INSERT INTO node_runs
                    (run_id, node_id, attempt, status, started_at, finished_at, output_json, error, logs)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (run_id, node_id, attempt, status, started_at, finished_at, output_json, error, logs),
            )
            conn.commit()

    def record_node_skipped(self, run_id, node_id):
        timestamp = utc_now()
        self.record_node_attempt(
            run_id=run_id,
            node_id=node_id,
            attempt=0,
            status="skipped",
            started_at=timestamp,
            finished_at=timestamp,
            output=None,
            error=None,
        )

    def list_runs(self, limit=50):
        with self._lock, self._connect() as conn:
            rows = conn.execute(
                """
                SELECT run_id, status, started_at, finished_at, error
                FROM runs
                ORDER BY started_at DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        return [dict(row) for row in rows]

    def get_run(self, run_id):
        with self._lock, self._connect() as conn:
            run_row = conn.execute(
                """
                SELECT run_id, status, started_at, finished_at, error
                FROM runs
                WHERE run_id = ?
                """,
                (run_id,),
            ).fetchone()

            if not run_row:
                return None

            node_rows = conn.execute(
                """
                SELECT node_id, attempt, status, started_at, finished_at, output_json, error, logs
                FROM node_runs
                WHERE run_id = ?
                ORDER BY node_id, attempt
                """,
                (run_id,),
            ).fetchall()

        nodes = []
        for row in node_rows:
            output = None
            if row["output_json"] is not None:
                output = json.loads(row["output_json"])
            nodes.append(
                {
                    "node_id": row["node_id"],
                    "attempt": row["attempt"],
                    "status": row["status"],
                    "started_at": row["started_at"],
                    "finished_at": row["finished_at"],
                    "output": output,
                    "error": row["error"],
                    "logs": row["logs"],
                }
            )

        return {
            "run": dict(run_row),
            "nodes": nodes,
        }

    def get_run_metrics(self):
        with self._lock, self._connect() as conn:
            total_runs = conn.execute("SELECT COUNT(1) FROM runs").fetchone()[0]
            status_rows = conn.execute(
                "SELECT status, COUNT(1) as count FROM runs GROUP BY status"
            ).fetchall()
            last_started = conn.execute(
                "SELECT MAX(started_at) FROM runs"
            ).fetchone()[0]
            last_finished = conn.execute(
                "SELECT MAX(finished_at) FROM runs"
            ).fetchone()[0]

        status_counts = {row["status"]: row["count"] for row in status_rows}

        return {
            "total": total_runs,
            "status_counts": status_counts,
            "last_started_at": last_started,
            "last_finished_at": last_finished,
        }

    def create_workflow(self, name, payload, description=None):
        workflow_id = str(uuid.uuid4())
        timestamp = utc_now()
        with self._lock, self._connect() as conn:
            conn.execute(
                """
                INSERT INTO workflows
                    (workflow_id, name, description, payload_json, version, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    workflow_id,
                    name,
                    description,
                    json.dumps(payload),
                    1,
                    timestamp,
                    timestamp,
                ),
            )
            conn.execute(
                """
                INSERT INTO workflow_versions (workflow_id, version, payload_json, created_at)
                VALUES (?, ?, ?, ?)
                """,
                (workflow_id, 1, json.dumps(payload), timestamp),
            )
            conn.commit()
        return workflow_id

    def update_workflow(self, workflow_id, name, payload, description=None):
        timestamp = utc_now()
        with self._lock, self._connect() as conn:
            # Get current version
            row = conn.execute(
                "SELECT version FROM workflows WHERE workflow_id = ?", (workflow_id,)
            ).fetchone()
            if not row:
                return False
            
            new_version = row["version"] + 1
            
            conn.execute(
                """
                UPDATE workflows
                SET name = ?, description = ?, payload_json = ?, version = ?, updated_at = ?
                WHERE workflow_id = ?
                """,
                (
                    name,
                    description,
                    json.dumps(payload),
                    new_version,
                    timestamp,
                    workflow_id,
                ),
            )
            conn.execute(
                """
                INSERT INTO workflow_versions (workflow_id, version, payload_json, created_at)
                VALUES (?, ?, ?, ?)
                """,
                (workflow_id, new_version, json.dumps(payload), timestamp),
            )
            conn.commit()
            return True

    def list_workflows(self, limit=100):
        with self._lock, self._connect() as conn:
            rows = conn.execute(
                """
                SELECT workflow_id, name, description, created_at, updated_at
                FROM workflows
                ORDER BY updated_at DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        return [dict(row) for row in rows]

    def get_workflow(self, workflow_id):
        with self._lock, self._connect() as conn:
            row = conn.execute(
                """
                SELECT workflow_id, name, description, payload_json, created_at, updated_at
                FROM workflows
                WHERE workflow_id = ?
                """,
                (workflow_id,),
            ).fetchone()
        if not row:
            return None
        payload = json.loads(row["payload_json"])
        return {
            "workflow_id": row["workflow_id"],
            "name": row["name"],
            "description": row["description"],
            "payload": payload,
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def set_secret(self, name, value):
        timestamp = utc_now()
        with self._lock, self._connect() as conn:
            conn.execute(
                """
                INSERT INTO secrets (secret_id, name, value, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(name) DO UPDATE SET
                    value=excluded.value,
                    updated_at=excluded.updated_at
                """,
                (str(uuid.uuid4()), name, value, timestamp, timestamp),
            )
            conn.commit()

    def list_secrets(self):
        with self._lock, self._connect() as conn:
            rows = conn.execute("SELECT name, created_at, updated_at FROM secrets").fetchall()
        return [dict(row) for row in rows]

    def get_secret(self, name):
        with self._lock, self._connect() as conn:
            row = conn.execute("SELECT value FROM secrets WHERE name = ?", (name,)).fetchone()
        return row["value"] if row else None

    def delete_secret(self, name):
        with self._lock, self._connect() as conn:
            conn.execute("DELETE FROM secrets WHERE name = ?", (name,))
            conn.commit()

    def get_daily_stats(self, days=7):
        with self._lock, self._connect() as conn:
            rows = conn.execute(
                """
                SELECT strftime('%Y-%m-%d', started_at) as date, status, COUNT(1) as count
                FROM runs
                WHERE started_at >= date('now', ?)
                GROUP BY date, status
                """,
                (f"-{days} days",),
            ).fetchall()
        return [dict(row) for row in rows]

    def create_schedule(self, workflow_id, name, cron):
        schedule_id = str(uuid.uuid4())
        timestamp = utc_now()
        with self._lock, self._connect() as conn:
            conn.execute(
                "INSERT INTO schedules (schedule_id, workflow_id, name, cron, created_at) VALUES (?, ?, ?, ?, ?)",
                (schedule_id, workflow_id, name, cron, timestamp),
            )
            conn.commit()
        return schedule_id

    def list_schedules(self):
        with self._lock, self._connect() as conn:
            rows = conn.execute("SELECT * FROM schedules").fetchall()
        return [dict(row) for row in rows]

    def update_schedule(self, schedule_id, enabled, last_run=None, next_run=None):
        with self._lock, self._connect() as conn:
            if last_run:
                conn.execute("UPDATE schedules SET last_run_at = ? WHERE schedule_id = ?", (last_run, schedule_id))
            if next_run:
                conn.execute("UPDATE schedules SET next_run_at = ? WHERE schedule_id = ?", (next_run, schedule_id))
            conn.execute("UPDATE schedules SET enabled = ? WHERE schedule_id = ?", (int(enabled), schedule_id))
            conn.commit()

    def delete_schedule(self, schedule_id):
        with self._lock, self._connect() as conn:
            conn.execute("DELETE FROM schedules WHERE schedule_id = ?", (schedule_id,))
            conn.commit()
