"""CampusFund web server (Flask).

Local:  python app.py            -> http://localhost:3000
Render: gunicorn app:app         (settings in gunicorn.conf.py)
"""
import logging

from backend import config, create_app

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

app = create_app()

if __name__ == "__main__":
    print(f"CampusFund is running at http://localhost:{config.PORT}", flush=True)
    app.run(port=config.PORT, threaded=True)
