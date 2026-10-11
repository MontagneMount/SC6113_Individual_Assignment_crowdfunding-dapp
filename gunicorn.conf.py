# Render starts the app with `gunicorn app:app`; gunicorn reads this file automatically.
import os

bind = f"0.0.0.0:{os.environ.get('PORT', '8000')}"
# One worker keeps a single indexer thread; extra threads serve requests while it polls the chain.
workers = 1
threads = 4
timeout = 60
