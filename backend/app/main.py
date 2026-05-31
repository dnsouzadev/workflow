import asyncio
import json
import logging
import os
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from croniter import croniter
from fastapi import (
    FastAPI,
    Header,
    HTTPException,
    Response,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from rq.exceptions import NoSuchJobError
from rq.job import Job

from jobs import execute_workflow_job
from logging_config import log_event, setup_logging
from metrics import build_metrics
from queueing import get_queue, get_redis_connection
from storage import RunStorage, utc_now

setup_logging()
logger = logging.getLogger("workflow.api")

JOB_TIMEOUT_SECONDS = int(os.getenv("JOB_TIMEOUT_SECONDS", "600"))
JOB_RESULT_TTL_SECONDS = int(os.getenv("JOB_RESULT_TTL_SECONDS", "3600"))
JOB_FAILURE_TTL_SECONDS = int(os.getenv("JOB_FAILURE_TTL_SECONDS", "3600"))
INTEGRATION_API_KEY = os.getenv("INTEGRATION_API_KEY")

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

workflow = {
  "nodes": [
    {"id": "1", "type": "input"},
    {"id": "2", "type": "filter"},
    {"id": "3", "type": "output"}
  ],
  "edges": [
    {"from": "1", "to": "2"},
    {"from": "2", "to": "3"}
  ],
  "config": {
      "max_workers": 1,
      "default_timeout_ms": 5000,
      "default_retries": 0,
      "retry_backoff_ms": 200
  }
}

BASE_DIR = Path(__file__).resolve().parent
RUNS_DB_PATH = Path(os.getenv("RUNS_DB_PATH", str(BASE_DIR / "runs.db")))
storage = RunStorage(RUNS_DB_PATH)
redis_connection = get_redis_connection()
queue = get_queue(redis_connection)


class ExecuteRequest(BaseModel):
    workflow: Optional[Dict[str, Any]] = None
    workflow_id: Optional[str] = None


class WorkflowCreateRequest(BaseModel):
    name: str
    description: Optional[str] = None
    payload: Dict[str, Any]


class WorkflowUpdateRequest(BaseModel):
    name: str
    description: Optional[str] = None
    payload: Dict[str, Any]


class IntegrationEvent(BaseModel):
    event_type: str
    source: Optional[str] = None
    payload: Optional[Dict[str, Any]] = None
    workflow: Optional[Dict[str, Any]] = None


def build_integration_workflow(event: IntegrationEvent):
    event_payload = {
        "event_type": event.event_type,
        "source": event.source,
        "payload": event.payload or {},
    }
    return {
        "nodes": [
            {"id": "1", "type": "input", "payload": event_payload},
            {"id": "2", "type": "filter"},
            {"id": "3", "type": "output"},
        ],
        "edges": [
            {"from": "1", "to": "2"},
            {"from": "2", "to": "3"},
        ],
        "config": workflow["config"],
    }


def require_integration_key(x_api_key: Optional[str]):
    if INTEGRATION_API_KEY and x_api_key != INTEGRATION_API_KEY:
        raise HTTPException(status_code=401, detail="Invalid API key")

@app.post("/execute")
def execute(payload: Optional[ExecuteRequest] = None):
    workflow_payload = None
    if payload:
        if payload.workflow:
            workflow_payload = payload.workflow
        elif payload.workflow_id:
            stored = storage.get_workflow(payload.workflow_id)
            if not stored:
                raise HTTPException(status_code=404, detail="Workflow not found")
            workflow_payload = stored["payload"]
    if workflow_payload is None:
        workflow_payload = workflow
    try:
        job = queue.enqueue(
            execute_workflow_job,
            workflow_payload,
            job_timeout=JOB_TIMEOUT_SECONDS,
            result_ttl=JOB_RESULT_TTL_SECONDS,
            failure_ttl=JOB_FAILURE_TTL_SECONDS,
        )
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err

    log_event(logger, "run_queued", job_id=job.id)
    return {"job_id": job.id}


@app.post("/integrations/webhook")
def integration_webhook(
    event: IntegrationEvent, x_api_key: Optional[str] = Header(None)
):
    require_integration_key(x_api_key)
    workflow_payload = event.workflow or build_integration_workflow(event)
    try:
        job = queue.enqueue(
            execute_workflow_job,
            workflow_payload,
            job_timeout=JOB_TIMEOUT_SECONDS,
            result_ttl=JOB_RESULT_TTL_SECONDS,
            failure_ttl=JOB_FAILURE_TTL_SECONDS,
        )
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err

    log_event(
        logger,
        "integration_received",
        job_id=job.id,
        event_type=event.event_type,
        source=event.source,
    )
    return {"job_id": job.id, "event_type": event.event_type}


@app.post("/workflows")
def create_workflow(payload: WorkflowCreateRequest):
    workflow_id = storage.create_workflow(
        name=payload.name, description=payload.description, payload=payload.payload
    )
    return {"workflow_id": workflow_id}


@app.get("/workflows")
def list_workflows(limit: int = 100):
    return {"workflows": storage.list_workflows(limit)}


@app.get("/workflows/{workflow_id}")
def get_workflow(workflow_id: str):
    workflow_item = storage.get_workflow(workflow_id)
    if not workflow_item:
        raise HTTPException(status_code=404, detail="Workflow not found")
    return workflow_item


@app.put("/workflows/{workflow_id}")
def update_workflow(workflow_id: str, payload: WorkflowUpdateRequest):
    updated = storage.update_workflow(
        workflow_id,
        name=payload.name,
        description=payload.description,
        payload=payload.payload,
    )
    if not updated:
        raise HTTPException(status_code=404, detail="Workflow not found")
    return {"workflow_id": workflow_id}


@app.get("/workflows/{workflow_id}/versions")
def get_workflow_versions(workflow_id: str):
    with storage._lock, storage._connect() as conn:
        rows = conn.execute(
            """
            SELECT version, payload_json, created_at
            FROM workflow_versions
            WHERE workflow_id = ?
            ORDER BY version DESC
            """,
            (workflow_id,),
        ).fetchall()
    return {"versions": [dict(row) for row in rows]}

class SecretRequest(BaseModel):
    name: str
    value: str

@app.get("/secrets")
def list_secrets():
    return {"secrets": storage.list_secrets()}

@app.post("/secrets")
def set_secret(payload: SecretRequest):
    storage.set_secret(payload.name, payload.value)
    return {"status": "ok"}

@app.delete("/secrets/{name}")
def delete_secret(name: str):
    storage.delete_secret(name)
    return {"status": "ok"}

class ScheduleRequest(BaseModel):
    workflow_id: str
    name: str
    cron: str

@app.get("/schedules")
def list_schedules():
    return {"schedules": storage.list_schedules()}

@app.post("/schedules")
def create_schedule(payload: ScheduleRequest):
    storage.create_schedule(payload.workflow_id, payload.name, payload.cron)
    return {"status": "ok"}

@app.delete("/schedules/{schedule_id}")
def delete_schedule(schedule_id: str):
    storage.delete_schedule(schedule_id)
    return {"status": "ok"}

@app.get("/stats/daily")
def get_daily_stats(days: int = 7):
    return {"stats": storage.get_daily_stats(days)}

def run_scheduler():
    logger.info("Scheduler thread started")
    while True:
        try:
            now = datetime.utcnow()
            schedules = storage.list_schedules()
            for s in schedules:
                if not s["enabled"]:
                    continue

                cron = s["cron"]
                last_run = s["last_run_at"]

                base = datetime.fromisoformat(last_run.replace("Z", "")) if last_run else datetime.fromisoformat(s["created_at"].replace("Z", ""))
                iter = croniter(cron, base)
                next_run = iter.get_next(datetime)

                if next_run <= now:
                    logger.info(f"Triggering scheduled workflow: {s['name']} ({s['workflow_id']})")
                    workflow_item = storage.get_workflow(s["workflow_id"])
                    if workflow_item:
                        queue.enqueue(
                            execute_workflow_job,
                            workflow_item["payload"],
                            job_timeout=JOB_TIMEOUT_SECONDS,
                        )
                        storage.update_schedule(s["schedule_id"], enabled=True, last_run=utc_now())
        except Exception as e:
            logger.error(f"Scheduler error: {e}")

        time.sleep(30)

# Start scheduler thread
threading.Thread(target=run_scheduler, daemon=True).start()

@app.websocket("/ws/execute")
async def execute_stream(websocket: WebSocket):

    await websocket.accept()
    workflow_payload = workflow
    pubsub = None

    try:
        start_message = await asyncio.wait_for(websocket.receive_json(), timeout=1.0)
        if isinstance(start_message, dict) and "workflow" in start_message:
            workflow_payload = start_message["workflow"]
        elif isinstance(start_message, dict) and "workflow_id" in start_message:
            stored = storage.get_workflow(start_message["workflow_id"])
            if not stored:
                await websocket.send_json(
                    {
                        "type": "run_failed",
                        "error": "Workflow not found",
                        "timestamp": utc_now(),
                    }
                )
                return
            workflow_payload = stored["payload"]
    except (asyncio.TimeoutError, WebSocketDisconnect):
        workflow_payload = workflow
    except Exception:
        workflow_payload = workflow

    try:
        job = queue.enqueue(
            execute_workflow_job,
            workflow_payload,
            job_timeout=JOB_TIMEOUT_SECONDS,
            result_ttl=JOB_RESULT_TTL_SECONDS,
            failure_ttl=JOB_FAILURE_TTL_SECONDS,
        )
        await websocket.send_json(
            {"type": "run_queued", "job_id": job.id, "timestamp": utc_now()}
        )
        log_event(logger, "run_queued", job_id=job.id)

        pubsub = redis_connection.pubsub()
        channel = f"workflow:{job.id}"
        pubsub.subscribe(channel)

        while True:
            message = await asyncio.to_thread(
                pubsub.get_message, ignore_subscribe_messages=True, timeout=1.0
            )
            if message and message.get("type") == "message":
                data = message.get("data")
                if isinstance(data, str):
                    event = json.loads(data)
                else:
                    event = json.loads(data.decode("utf-8"))
                await websocket.send_json(event)
                if event.get("type") in ("run_finished", "run_failed"):
                    break
    except WebSocketDisconnect:
        pass
    finally:
        if pubsub:
            try:
                pubsub.close()
            except Exception:
                pass


@app.get("/runs")
def list_runs(limit: int = 20):
    return {"runs": storage.list_runs(limit)}


@app.get("/runs/{run_id}")
def get_run(run_id: str):
    run = storage.get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    return run


@app.get("/jobs/{job_id}")
def get_job(job_id: str):
    try:
        job = Job.fetch(job_id, connection=redis_connection)
    except NoSuchJobError as err:
        raise HTTPException(status_code=404, detail="Job not found") from err

    response = {
        "job_id": job.id,
        "status": job.get_status(),
        "created_at": job.created_at,
        "enqueued_at": job.enqueued_at,
        "started_at": job.started_at,
        "ended_at": job.ended_at,
        "result": job.result,
    }

    return response


@app.get("/metrics")
def metrics():
    content = build_metrics(storage, queue)
    return Response(content, media_type="text/plain; version=0.0.4")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
