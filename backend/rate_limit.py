import threading
import time
from functools import wraps

from flask import jsonify, request


def rate_limit(window_seconds, max_requests):
    """Small in-memory rate limiter: at most `max_requests` per IP in each window."""
    hits = {}  # ip -> (window start, count)
    lock = threading.Lock()

    def decorator(view):
        @wraps(view)
        def wrapper(*args, **kwargs):
            now = time.monotonic()
            with lock:
                if len(hits) > 5_000:
                    for ip in [ip for ip, (start, _) in hits.items() if now - start > window_seconds]:
                        del hits[ip]
                start, count = hits.get(request.remote_addr, (None, 0))
                if start is None or now - start > window_seconds:
                    hits[request.remote_addr] = (now, 1)
                else:
                    hits[request.remote_addr] = (start, count + 1)
                    if count + 1 > max_requests:
                        return jsonify(error="Too many requests. Please wait a moment and try again."), 429
            return view(*args, **kwargs)

        return wrapper

    return decorator
