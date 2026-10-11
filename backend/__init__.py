"""CampusFund backend: a Flask app that serves the web pages and the REST API, and keeps a
MongoDB copy of the contract's events for search and history."""
import logging
import mimetypes
from datetime import datetime
from urllib.parse import urlparse

from bson import ObjectId
from flask import Flask, jsonify, request, send_from_directory
from flask.json.provider import DefaultJSONProvider
from werkzeug.exceptions import HTTPException, RequestEntityTooLarge
from werkzeug.middleware.proxy_fix import ProxyFix

from . import config, db
from .api import api
from .constants import LIMITS
from .db import ServiceUnavailableError
from .details import InputError
from .state import activate_deployment
from .times import iso_millis
from .visits import visit_log

log = logging.getLogger(__name__)

# Windows can map .js to text/plain in the registry, and browsers refuse to run module
# scripts served with that type.
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("image/svg+xml", ".svg")

CONTENT_SECURITY_POLICY = "; ".join([
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    f"connect-src 'self' {urlparse(config.CHAIN['rpcUrl']).scheme}://{urlparse(config.CHAIN['rpcUrl']).netloc}",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
])


class JSONProvider(DefaultJSONProvider):
    """Keeps keys in the order they were written and formats dates like JavaScript does."""

    sort_keys = False
    ensure_ascii = False

    @staticmethod
    def default(value):
        if isinstance(value, datetime):
            return iso_millis(value)
        if isinstance(value, ObjectId):
            return str(value)
        return DefaultJSONProvider.default(value)


def create_app(start_services=True):
    app = Flask(__name__, static_folder=None)
    app.json = JSONProvider(app)
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1)  # Render runs the app behind one proxy
    # Keep Flask's default MAX_FORM_MEMORY_SIZE: Werkzeug holds uploads under 500 KB in memory
    # and counts them against that limit, so a smaller value would reject normal cover images.
    app.config.update(
        MAX_CONTENT_LENGTH=LIMITS["imageMaxBytes"] + 64 * 1024,  # the image plus the text fields
        MAX_FORM_PARTS=12,
    )

    app.after_request(add_security_headers)
    register_error_handlers(app)
    if not config.IS_PRODUCTION:
        from .dev import dev

        app.register_blueprint(dev)
    app.register_blueprint(visit_log)
    app.register_blueprint(api)
    register_pages(app)

    if start_services:
        connect_services()
    return app


def connect_services():
    try:
        db.connect_mongo()
    except Exception as err:
        log.error("Could not connect to MongoDB: %s", err)
    try:
        activate_deployment(config.load_deployment())
    except Exception as err:
        log.error("Could not start the blockchain indexer: %s", err)


def add_security_headers(response):
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Content-Security-Policy"] = CONTENT_SECURITY_POLICY
    return response


def register_pages(app):
    @app.get("/")
    def home():
        return send_page("index.html")

    @app.get("/<path:filename>")
    def page(filename):
        return send_page(filename)


def send_page(filename):
    # Pages also work without ".html", so /campaign serves campaign.html.
    if not (config.PUBLIC_DIR / filename).is_file() and (config.PUBLIC_DIR / f"{filename}.html").is_file():
        filename = f"{filename}.html"
    max_age = 7 * 24 * 3600 if filename.startswith("vendor/") else 0
    return send_from_directory(config.PUBLIC_DIR, filename, max_age=max_age)


def register_error_handlers(app):
    @app.errorhandler(InputError)
    @app.errorhandler(ServiceUnavailableError)
    def known_error(err):
        return jsonify(error=err.message), err.status

    @app.errorhandler(RequestEntityTooLarge)
    def too_large(err):
        image_too_large = (request.content_length or 0) > app.config["MAX_CONTENT_LENGTH"]
        return jsonify(error="Cover image must be 2 MB or smaller." if image_too_large else "Invalid upload."), 400

    @app.errorhandler(HTTPException)
    def http_error(err):
        if request.path.startswith("/api/"):
            return jsonify(error=err.description), err.code
        return err

    @app.errorhandler(Exception)
    def unexpected_error(err):
        log.exception("Unexpected error")
        return jsonify(error="Something went wrong on the server. Please try again."), 500
