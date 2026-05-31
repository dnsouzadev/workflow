from datetime import datetime, timezone


def parse_iso_timestamp(value):
    if not value:
        return None
    if value.endswith("Z"):
        value = value[:-1]
    return datetime.fromisoformat(value).replace(tzinfo=timezone.utc).timestamp()


def build_metrics(storage, queue):
    metrics = []
    run_metrics = storage.get_run_metrics()

    metrics.append("# HELP workflow_runs_total Total workflow runs by status.")
    metrics.append("# TYPE workflow_runs_total counter")
    total = run_metrics.get("total", 0)
    metrics.append(f'workflow_runs_total{{status="all"}} {total}')

    for status, count in run_metrics.get("status_counts", {}).items():
        metrics.append(f'workflow_runs_total{{status="{status}"}} {count}')

    last_started = parse_iso_timestamp(run_metrics.get("last_started_at"))
    last_finished = parse_iso_timestamp(run_metrics.get("last_finished_at"))
    if last_started is not None:
        metrics.append("# HELP workflow_last_started_at Last run start timestamp.")
        metrics.append("# TYPE workflow_last_started_at gauge")
        metrics.append(f"workflow_last_started_at {last_started}")
    if last_finished is not None:
        metrics.append("# HELP workflow_last_finished_at Last run finish timestamp.")
        metrics.append("# TYPE workflow_last_finished_at gauge")
        metrics.append(f"workflow_last_finished_at {last_finished}")

    def resolve_count(value):
        return value() if callable(value) else value

    metrics.append("# HELP workflow_queue_jobs Queue jobs by state.")
    metrics.append("# TYPE workflow_queue_jobs gauge")
    metrics.append(
        f'workflow_queue_jobs{{state="queued"}} {resolve_count(queue.count)}'
    )
    metrics.append(
        f'workflow_queue_jobs{{state="started"}} {resolve_count(queue.started_job_registry.count)}'
    )
    metrics.append(
        f'workflow_queue_jobs{{state="failed"}} {resolve_count(queue.failed_job_registry.count)}'
    )
    metrics.append(
        f'workflow_queue_jobs{{state="finished"}} {resolve_count(queue.finished_job_registry.count)}'
    )

    return "\n".join(metrics) + "\n"
