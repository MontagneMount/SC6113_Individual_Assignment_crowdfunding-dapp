import logging
import os
from urllib.parse import urlparse

import dns.resolver
from pymongo import ASCENDING, MongoClient

from . import config
from .constants import LIMITS

log = logging.getLogger(__name__)

_client = None
_database = None


class ServiceUnavailableError(Exception):
    status = 503

    def __init__(self, message):
        super().__init__(message)
        self.message = message


def connect_mongo():
    """Connects to MongoDB Atlas. Without MONGODB_URI the site still serves pages, but the API returns 503."""
    global _client
    if not config.MONGO_URI:
        log.warning("MONGODB_URI is not set: database features are off until it is added to .env")
        return
    _ensure_srv_lookup_works(config.MONGO_URI)
    candidate = MongoClient(config.MONGO_URI, serverSelectionTimeoutMS=10_000, tz_aware=True)
    candidate.admin.command("ping")
    _client = candidate
    log.info("Connected to MongoDB")


def _ensure_srv_lookup_works(uri):
    """mongodb+srv:// addresses need a DNS SRV lookup. VPN and proxy tools often point the
    system DNS at 127.0.0.1, which cannot answer it, so fall back to public DNS servers
    (override with DNS_SERVERS=1.1.1.1,8.8.8.8 in .env)."""
    if not uri.startswith("mongodb+srv://"):
        return
    srv_name = f"_mongodb._tcp.{urlparse(uri).hostname}"
    try:
        dns.resolver.resolve(srv_name, "SRV", lifetime=5)
    except Exception as err:
        fallback = [server.strip() for server in os.environ.get("DNS_SERVERS", "8.8.8.8,1.1.1.1").split(",") if server.strip()]
        log.warning("System DNS could not resolve the MongoDB address (%s); using %s instead", type(err).__name__, ", ".join(fallback))
        resolver = dns.resolver.Resolver(configure=False)
        resolver.nameservers = fallback
        dns.resolver.default_resolver = resolver  # pymongo resolves SRV records through this resolver


def use_deployment_database(deployment):
    """Each deployed contract gets its own database (e.g. crowdfunding_1a2b3c4d), so data
    from an old deployment can never mix with a new one."""
    global _database
    if _client is None or not deployment:
        _database = None
    else:
        _database = _client[f"{config.MONGO_DB_NAME}_{deployment['address'][2:10].lower()}"]


def is_ready():
    return _database is not None


def _collection(name):
    if _database is None:
        raise ServiceUnavailableError("The database is not available yet.")
    return _database[name]


def campaigns():
    return _collection("campaigns")  # cached on-chain campaign data


def details():
    return _collection("campaignDetails")  # off-chain description, category, cover image id


def images():
    return _collection("images")  # uploaded cover images


def events():
    return _collection("events")  # every contract event, used for history


def meta():
    return _collection("meta")  # indexer progress


def visits():
    return _collection("visits")  # page visits for the admin's visitor log


def ensure_indexes():
    events().create_index([("campaignId", ASCENDING), ("blockNumber", ASCENDING), ("logIndex", ASCENDING)])
    events().create_index([("account", ASCENDING)])
    campaigns().create_index([("creator", ASCENDING)])
    # A TTL index: MongoDB deletes each visit by itself once it is older than the retention period.
    visits().create_index([("at", ASCENDING)], expireAfterSeconds=LIMITS["visitRetentionDays"] * 24 * 3600)
