import json
import logging
import os
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


logger = logging.getLogger("workflow.alerts")


def send_alert(event_type, run_id, job_id=None, error=None, extra=None):
    webhook_url = os.getenv("ALERT_WEBHOOK_URL")
    if not webhook_url:
        return

    payload = {
        "event_type": event_type,
        "run_id": run_id,
        "job_id": job_id,
        "error": error,
        "extra": extra or {},
    }

    request = Request(
        webhook_url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urlopen(request, timeout=5) as response:
            response.read()
    except (URLError, HTTPError) as err:
        logger.warning(
            "alert_delivery_failed",
            extra={"job_id": job_id, "run_id": run_id, "error": str(err)},
        )
