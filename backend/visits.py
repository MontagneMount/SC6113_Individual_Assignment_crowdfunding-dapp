"""Visitor log: every page view is stored in MongoDB, and only the admin wallet can list or
delete the records. No IP address is stored: a random id kept in the visitor's browser tells
repeat visits apart, and MongoDB deletes each record after 30 days (a TTL index, see db.py)."""
import logging
import re
import time
from datetime import timedelta
from functools import wraps

from bson import ObjectId
from eth_account import Account
from eth_account.messages import encode_defunct
from flask import Blueprint, g, jsonify, request
from web3 import Web3

from . import config, db
from .api import require_ready
from .constants import LIMITS, build_admin_message
from .details import ISO_TIME, MAX_SAFE_INTEGER, SIGNATURE, InputError
from .rate_limit import rate_limit
from .state import state
from .times import parse_iso_millis, utc_now

log = logging.getLogger(__name__)

visit_log = Blueprint("visit_log", __name__, url_prefix="/api")

visit_limit = rate_limit(window_seconds=60, max_requests=30)

# Page paths the browser may report -> the page name stored in the log.
PAGES = {
    "/": "/",
    "/index.html": "/",
    "/campaign": "/campaign",
    "/campaign.html": "/campaign",
    "/create": "/create",
    "/create.html": "/create",
    "/me": "/me",
    "/me.html": "/me",
    "/deploy": "/deploy",
    "/deploy.html": "/deploy",
}
VISITOR_ID = re.compile(r"[0-9a-f]{8}(-?[0-9a-f]{4}){3}-?[0-9a-f]{12}")  # crypto.randomUUID(), dashes optional
LIST_LIMIT = 200

# (text in the User-Agent, label), checked in order: Edge and Opera also say "Chrome",
# Chrome also says "Safari", and phones also mention "Linux" or "Mac OS".
BROWSERS = [
    ("MetaMaskMobile", "MetaMask app"),
    ("HeadlessChrome", "Headless Chrome"),
    ("Edg", "Edge"),
    ("OPR", "Opera"),
    ("Firefox", "Firefox"),
    ("FxiOS", "Firefox"),
    ("CriOS", "Chrome"),
    ("Chrome", "Chrome"),
    ("Safari", "Safari"),
]
SYSTEMS = [
    ("Android", "Android"),
    ("iPhone", "iOS"),
    ("iPad", "iOS"),
    ("Windows", "Windows"),
    ("Mac OS", "macOS"),
    ("Linux", "Linux"),
]


@visit_log.post("/visits")
@require_ready
@visit_limit
def record_visit():
    visit = parse_visit(request.get_json(silent=True), request.headers.get("User-Agent", ""))
    db.visits().insert_one({"at": utc_now(), **visit})
    return "", 204


def parse_visit(body, user_agent):
    """Checks what the browser reported and returns the fields to store (never the IP address)."""
    if not isinstance(body, dict):
        raise InputError("Invalid visit.")
    page = PAGES.get(body.get("page")) if isinstance(body.get("page"), str) else None
    campaign_id = body.get("campaignId")
    wallet = body.get("wallet")
    visitor = body.get("visitor")

    if page is None:
        raise InputError("Invalid visit.")
    if campaign_id is not None and (
        page != "/campaign" or type(campaign_id) is not int or not 1 <= campaign_id <= MAX_SAFE_INTEGER
    ):
        raise InputError("Invalid visit.")
    if wallet is not None and not (isinstance(wallet, str) and Web3.is_address(wallet)):
        raise InputError("Invalid visit.")
    if not isinstance(visitor, str) or not VISITOR_ID.fullmatch(visitor):
        raise InputError("Invalid visit.")

    return {
        "page": page,
        "campaignId": campaign_id,
        "wallet": wallet.lower() if wallet else None,
        "visitor": visitor,
        "browser": browser_summary(user_agent),
    }


def browser_summary(user_agent):
    """A short label such as "Edge on Windows" instead of the full User-Agent string."""
    browser = next((label for text, label in BROWSERS if text in user_agent), "Other browser")
    system = next((label for text, label in SYSTEMS if text in user_agent), "other system")
    return f"{browser} on {system}"


# ---------- Admin: view and delete the log ----------


def admin_wallets():
    """Lower-case addresses that may open the visitor log: ADMIN_ADDRESSES, or else the deployer."""
    if config.ADMIN_ADDRESSES:
        return {address.lower() for address in config.ADMIN_ADDRESSES}
    deployer = (state.deployment or {}).get("deployer")
    return {deployer.lower()} if deployer else set()


def require_admin(view):
    """The admin signs a message in MetaMask once; the page sends it with every request
    for the next 10 minutes, and each request is checked again. No password, no cookie."""

    @wraps(view)
    def wrapper(*args, **kwargs):
        g.admin = verify_admin(
            request.headers.get("X-Admin-Wallet", ""),
            request.headers.get("X-Admin-Issued-At", ""),
            request.headers.get("X-Admin-Signature", ""),
        )
        return view(*args, **kwargs)

    return wrapper


def verify_admin(wallet, issued_at, signature):
    """Returns the admin's address, or raises 401 (not signed in) or 403 (not an admin)."""
    issued_ms = parse_iso_millis(issued_at) if ISO_TIME.fullmatch(issued_at) else None
    if not Web3.is_address(wallet) or issued_ms is None or not SIGNATURE.fullmatch(signature):
        raise InputError("Please sign in with the admin wallet.", 401)
    if abs(time.time() * 1000 - issued_ms) > LIMITS["signatureMaxAgeMs"]:
        raise InputError("Your admin sign-in has expired. Please sign in again.", 401)

    wallet = Web3.to_checksum_address(wallet)
    message = build_admin_message(wallet, state.deployment["address"], config.CHAIN["chainId"], issued_at)
    try:
        signer = Web3.to_checksum_address(Account.recover_message(encode_defunct(text=message), signature=signature))
    except Exception:
        signer = None
    if signer != wallet:
        raise InputError("The signature could not be verified.", 401)
    if wallet.lower() not in admin_wallets():
        raise InputError("This wallet is not an admin.", 403)
    return wallet


@visit_log.get("/admin/visits")
@require_ready
@require_admin
def list_visits():
    query = visit_query(request.args)
    collection = db.visits()
    rows = collection.find(query).sort("at", -1).limit(LIST_LIMIT)
    return jsonify(
        visits=[public_visit(row) for row in rows],
        matching=collection.count_documents(query),
        stats={
            "total": collection.count_documents({}),
            "last24h": collection.count_documents({"at": {"$gte": utc_now() - timedelta(hours=24)}}),
            "visitors": len(collection.distinct("visitor")),
            "wallets": len([wallet for wallet in collection.distinct("wallet") if wallet]),
        },
        limit=LIST_LIMIT,
        admin=g.admin,
    )


@visit_log.delete("/admin/visits/<visit_id>")
@require_ready
@require_admin
def delete_visit(visit_id):
    if not ObjectId.is_valid(visit_id) or db.visits().delete_one({"_id": ObjectId(visit_id)}).deleted_count == 0:
        raise InputError("Visit not found.", 404)
    log.info("Admin %s deleted visit %s", g.admin, visit_id)
    return jsonify(deleted=1)


@visit_log.delete("/admin/visits")
@require_ready
@require_admin
def delete_visits():
    """Deletes every record that matches the filters, or all records without filters."""
    query = visit_query(request.args)
    deleted = db.visits().delete_many(query).deleted_count
    log.info("Admin %s deleted %d visit records matching %s", g.admin, deleted, query or "everything")
    return jsonify(deleted=deleted)


def visit_query(args):
    """The ?page= and ?wallet= filters as a MongoDB query."""
    query = {}
    page = args.get("page", "")
    wallet = args.get("wallet", "").strip()
    if page:
        if page not in PAGES.values():
            raise InputError("Unknown page filter.")
        query["page"] = page
    if wallet:
        if not Web3.is_address(wallet):
            raise InputError("Invalid wallet address.")
        query["wallet"] = wallet.lower()
    return query


def public_visit(row):
    return {
        "id": str(row["_id"]),
        "at": row["at"],
        "page": row["page"],
        "campaignId": row.get("campaignId"),
        "wallet": row.get("wallet"),
        "visitor": row["visitor"],
        "browser": row["browser"],
    }
