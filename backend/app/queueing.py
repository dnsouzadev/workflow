import os

from redis import Redis
from rq import Queue


REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
QUEUE_NAME = os.getenv("QUEUE_NAME", "workflow")


def get_redis_connection():
    return Redis.from_url(REDIS_URL)


def get_queue(connection=None):
    conn = connection or get_redis_connection()
    return Queue(QUEUE_NAME, connection=conn)
