import logging

from rq import Worker

from logging_config import setup_logging
from queueing import get_queue, get_redis_connection


def run_worker():
    setup_logging()
    logger = logging.getLogger("workflow.worker")
    redis = get_redis_connection()
    queue = get_queue(redis)
    logger.info("worker_started", extra={"queue": queue.name})
    worker = Worker([queue], connection=redis)
    worker.work()


if __name__ == "__main__":
    run_worker()
