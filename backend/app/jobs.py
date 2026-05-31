import json
import logging
import os
from pathlib import Path

from rq import get_current_job

from alerts import send_alert
from engine import WorkflowEngine
from logging_config import log_event, setup_logging
from queueing import get_redis_connection
from storage import RunStorage, utc_now


BASE_DIR = Path(__file__).resolve().parent
RUNS_DB_PATH = Path(os.getenv("RUNS_DB_PATH", str(BASE_DIR / "runs.db")))


def execute_workflow_job(workflow):
    setup_logging()
    logger = logging.getLogger("workflow.job")
    job = get_current_job()
    job_id = job.id if job else "unknown"

    redis = get_redis_connection()
    channel = f"workflow:{job_id}"

    storage = RunStorage(RUNS_DB_PATH)
    engine = WorkflowEngine(storage)

    def handle_event(event):
        event["job_id"] = job_id
        redis.publish(channel, json.dumps(event))

        log_event(
            logger,
            event.get("type", "workflow_event"),
            job_id=job_id,
            run_id=event.get("run_id"),
            node_id=event.get("node_id"),
            status=event.get("status"),
            attempt=event.get("attempt"),
            error=event.get("error"),
        )

        if event.get("type") == "run_finished" and event.get("status") == "failed":
            send_alert(
                event_type="run_failed",
                run_id=event.get("run_id"),
                job_id=job_id,
                error=event.get("error"),
                extra={"node_status": event.get("node_status")},
            )

    try:
        result = engine.execute_workflow(workflow, handle_event)
    except Exception as err:
        error_event = {
            "type": "run_failed",
            "job_id": job_id,
            "error": str(err),
            "timestamp": utc_now(),
        }
        redis.publish(channel, json.dumps(error_event))
        log_event(logger, "run_failed", job_id=job_id, error=str(err))
        send_alert(
            event_type="run_failed",
            run_id=None,
            job_id=job_id,
            error=str(err),
            extra={"reason": "workflow_execution_error"},
        )
        raise

    return result
