from functools import wraps

from bson import Binary, ObjectId
from flask import Blueprint, Response, jsonify, request
from web3 import Web3

from . import config, db
from .chain import now_seconds, read_campaign, status_of
from .constants import CATEGORIES, JS_WHITESPACE, LIMITS, utf16_length
from .db import ServiceUnavailableError
from .details import InputError, parse_campaign_id, recover_details_signer, sha256_hex, validate_details_input
from .details_store import save_details_version
from .indexer import get_synced_block, sync_now
from .rate_limit import rate_limit
from .state import state
from .times import iso_millis, utc_now

api = Blueprint("api", __name__, url_prefix="/api")

write_limit = rate_limit(window_seconds=10 * 60, max_requests=20)
sync_limit = rate_limit(window_seconds=60, max_requests=30)

SORT_KEYS = {
    "newest": lambda item: -item["id"],
    # Running campaigns first (soonest deadline first), then ended ones (most recent first).
    "ending": lambda item: (0, item["deadline"]) if item["status"] == "active" else (1, -item["deadline"]),
    "raised": lambda item: -int(item["totalRaisedWei"]),
    "progress": lambda item: -item["progress"],
}


def require_ready(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        if not state.deployment:
            raise ServiceUnavailableError("The smart contract has not been deployed yet.")
        if not db.is_ready():
            raise ServiceUnavailableError("The database is not connected yet.")
        return view(*args, **kwargs)

    return wrapper


@api.get("/health")
def health():
    return jsonify(
        ok=True,
        contract=state.deployment["address"] if state.deployment else None,
        database=db.is_ready(),
        syncedBlock=get_synced_block(),
    )


@api.get("/config")
def client_config():
    return jsonify(
        chain=config.CHAIN,
        contractAddress=state.deployment["address"] if state.deployment else None,
        deployBlock=state.deployment["deployBlock"] if state.deployment else None,
        abi=config.ABI,
        categories=CATEGORIES,
        limits=LIMITS,
        databaseReady=db.is_ready(),
        devTools=not config.IS_PRODUCTION,
    )


@api.get("/campaigns")
@require_ready
def list_campaigns():
    search = request.args.get("q", "").strip(JS_WHITESPACE).lower()
    category = request.args.get("category", "")
    status = request.args.get("status", "")
    sort = request.args.get("sort", "newest")

    campaigns = list(db.campaigns().find())
    details_by_id = {doc["_id"]: doc for doc in db.details().find({}, {"category": 1, "description": 1, "imageId": 1})}
    now = now_seconds()

    items = [summarize(campaign, details_by_id.get(campaign["_id"]), now) for campaign in campaigns]
    if search:
        items = [item for item in items if search in item["title"].lower() or search in (item["description"] or "").lower()]
    if category:
        items = [item for item in items if item["category"] == category]
    if status:
        items = [item for item in items if item["status"] == status]
    items.sort(key=SORT_KEYS.get(sort, SORT_KEYS["newest"]))

    return jsonify(campaigns=[without_description(item) for item in items], syncedBlock=get_synced_block())


@api.get("/campaigns/<campaign_id>")
@require_ready
def get_campaign(campaign_id):
    campaign_id = parse_campaign_id(campaign_id)
    campaign = db.campaigns().find_one({"_id": campaign_id})
    if campaign is None:
        sync_now()  # it may have been created a moment ago
        campaign = db.campaigns().find_one({"_id": campaign_id})
    if campaign is None:
        raise InputError("Campaign not found.", 404)

    details = db.details().find_one({"_id": campaign_id})
    events = list(db.events().find({"campaignId": campaign_id}).sort([("blockNumber", 1), ("logIndex", 1)]))

    return jsonify(
        campaign=summarize(campaign, details, now_seconds()),
        details={
            "category": details["category"],
            "description": details["description"],
            "imageUrl": f"/api/images/{details['imageId']}" if details.get("imageId") else None,
            "signer": details["signer"],
            "updatedAt": details["updatedAt"],
        } if details else None,
        backers=summarize_backers(events),
        events=[{key: value for key, value in event.items() if key != "_id"} for event in events],
        syncedBlock=get_synced_block(),
    )


# Save description, category and cover image. Only the on-chain creator may do this,
# proven by a MetaMask signature over the exact content.
@api.post("/campaigns/<campaign_id>/metadata")
@require_ready
@write_limit
def save_details(campaign_id):
    campaign_id = parse_campaign_id(campaign_id)
    image = read_uploaded_image()
    details = validate_details_input(request.form, image)

    # Ask the contract who the creator is: the cache may not know a brand-new campaign yet.
    on_chain = read_campaign(state.contract, campaign_id)
    if on_chain is None:
        raise InputError("Campaign not found on the blockchain.", 404)
    creator = Web3.to_checksum_address(on_chain["creator"])

    image_sha256 = sha256_hex(image[1]) if image else None
    signer = recover_details_signer(
        campaign_id=campaign_id,
        contract_address=state.deployment["address"],
        chain_id=config.CHAIN["chainId"],
        details=details,
        image_sha256=image_sha256,
    )
    if signer != creator:
        raise InputError("Only the campaign creator can edit its details.", 403)

    existing = db.details().find_one({"_id": campaign_id})
    if existing and existing["issuedAt"] >= details["issuedAt"]:
        raise InputError("Newer details were already saved for this campaign.", 409)

    image_id = existing.get("imageId") if existing else None
    if image:
        mimetype, data = image
        image_id = db.images().insert_one({
            "campaignId": campaign_id,
            "contentType": mimetype,
            "size": len(data),
            "sha256": image_sha256,
            "data": Binary(data),
            "createdAt": utc_now(),
        }).inserted_id

    try:
        save_details_version(db.details(), campaign_id, existing, {
            "category": details["category"],
            "description": details["description"],
            "imageId": image_id,
            "signer": signer.lower(),
            "signature": details["signature"],
            "issuedAt": details["issuedAt"],
            "updatedAt": utc_now(),
        })
    except InputError as err:
        # Only a definite conflict proves the new image was not committed.
        # On an ambiguous database/network failure, preserve it for reconciliation.
        if err.status == 409 and image:
            delete_quietly(image_id)
        raise
    if image and existing and existing.get("imageId"):
        delete_quietly(existing["imageId"])
    return jsonify(ok=True), 200 if existing else 201


def read_uploaded_image():
    """Returns (mimetype, bytes) of the optional "image" upload, or None."""
    if any(name != "image" for name in request.files) or len(request.files.getlist("image")) > 1:
        raise InputError("Invalid upload.")
    upload = request.files.get("image")
    if upload is None:
        return None
    data = upload.read()
    if len(data) > LIMITS["imageMaxBytes"]:
        raise InputError("Cover image must be 2 MB or smaller.")
    return upload.mimetype, data


def delete_quietly(image_id):
    try:
        db.images().delete_one({"_id": image_id})
    except Exception:
        pass


@api.get("/images/<image_id>")
@require_ready
def get_image(image_id):
    if not ObjectId.is_valid(image_id):
        raise InputError("Image not found.", 404)
    image = db.images().find_one({"_id": ObjectId(image_id)})
    if image is None:
        raise InputError("Image not found.", 404)
    return Response(
        bytes(image["data"]),
        content_type=image["contentType"],
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


@api.get("/users/<address>")
@require_ready
def get_user(address):
    if not Web3.is_address(address):
        raise InputError("Invalid wallet address.")
    account = address.lower()
    now = now_seconds()

    created = list(db.campaigns().find({"creator": account}).sort("_id", -1))
    events = list(db.events().find({"account": account}))

    withdrawn_wei = 0
    my_totals = {}  # campaignId -> {"contributedWei": int, "refundedWei": int}
    for event in events:
        if event["name"] == "FundsWithdrawn":
            withdrawn_wei += int(event["amountWei"])
        if event["name"] not in ("Contributed", "Refunded"):
            continue
        entry = my_totals.setdefault(event["campaignId"], {"contributedWei": 0, "refundedWei": 0})
        if event["name"] == "Contributed":
            entry["contributedWei"] += int(event["amountWei"])
        else:
            entry["refundedWei"] += int(event["amountWei"])

    backed_campaigns = list(db.campaigns().find({"_id": {"$in": list(my_totals)}}).sort("_id", -1))
    ids = [campaign["_id"] for campaign in created + backed_campaigns]
    details_by_id = {doc["_id"]: doc for doc in db.details().find({"_id": {"$in": ids}}, {"category": 1, "imageId": 1})}

    contributed_wei = 0
    refunded_wei = 0
    backed = []
    for campaign in backed_campaigns:
        mine = my_totals[campaign["_id"]]
        contributed_wei += mine["contributedWei"]
        refunded_wei += mine["refundedWei"]
        summary = summarize(campaign, details_by_id.get(campaign["_id"]), now)
        backed.append({
            **without_description(summary),
            "myContributedWei": str(mine["contributedWei"]),
            "myRefundedWei": str(mine["refundedWei"]),
            "canRefund": summary["status"] == "failed" and mine["contributedWei"] > mine["refundedWei"],
        })

    created_summaries = []
    for campaign in created:
        summary = summarize(campaign, details_by_id.get(campaign["_id"]), now)
        created_summaries.append({**without_description(summary), "canWithdraw": summary["status"] == "successful"})

    return jsonify(
        address=Web3.to_checksum_address(account),
        totals={
            "contributedWei": str(contributed_wei),
            "refundedWei": str(refunded_wei),
            "withdrawnWei": str(withdrawn_wei),
            "campaignsBacked": len(backed),
            "campaignsCreated": len(created_summaries),
        },
        backed=backed,
        created=created_summaries,
        syncedBlock=get_synced_block(),
    )


@api.get("/stats")
@require_ready
def stats():
    campaigns = list(db.campaigns().find())
    backers = db.events().distinct("account", {"name": "Contributed"})
    now = now_seconds()
    counts = {"active": 0, "successful": 0, "failed": 0, "withdrawn": 0}
    total_raised_wei = 0
    for campaign in campaigns:
        counts[status_of(campaign, now)] += 1
        total_raised_wei += int(campaign["totalRaisedWei"])
    ended = counts["successful"] + counts["withdrawn"] + counts["failed"]

    return jsonify(
        campaigns=len(campaigns),
        **counts,
        totalRaisedWei=str(total_raised_wei),
        backers=len(backers),
        successRate=(counts["successful"] + counts["withdrawn"]) / ended if ended > 0 else None,
        syncedBlock=get_synced_block(),
    )


# The page calls this right after a transaction so the history updates without waiting.
@api.post("/sync")
@require_ready
@sync_limit
def sync():
    sync_now()
    return jsonify(syncedBlock=get_synced_block())


@api.route("/<path:unknown>", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
def not_found(unknown):
    return jsonify(error="Not found."), 404


def summarize(campaign, details, now):
    raised = int(campaign["totalRaisedWei"])
    goal = int(campaign["goalWei"])
    description = details.get("description") if details else None
    image_id = details.get("imageId") if details else None
    return {
        "id": campaign["_id"],
        "title": campaign["title"],
        "creator": campaign["creator"],
        "goalWei": campaign["goalWei"],
        "totalRaisedWei": campaign["totalRaisedWei"],
        "totalRefundedWei": campaign["totalRefundedWei"],
        "withdrawn": campaign["withdrawn"],
        "backerCount": campaign["backerCount"],
        "deadline": campaign["deadline"],
        "createdAt": campaign.get("createdAt"),
        "status": status_of(campaign, now),
        "progress": raised * 10_000 // goal / 10_000 if goal > 0 else 0,
        "category": details.get("category") if details else None,
        "description": description,
        "excerpt": excerpt(description) if description else None,
        "imageUrl": f"/api/images/{image_id}" if image_id else None,
    }


def without_description(summary):
    return {key: value for key, value in summary.items() if key != "description"}


def excerpt(text, limit=140):
    return f"{text[:limit - 1].rstrip(JS_WHITESPACE)}…" if utf16_length(text) > limit else text


def summarize_backers(events):
    backers = {}
    for event in events:
        if event["name"] not in ("Contributed", "Refunded"):
            continue
        entry = backers.setdefault(event["account"], {"address": event["account"], "contributedWei": 0, "refundedWei": 0, "contributions": 0})
        if event["name"] == "Contributed":
            entry["contributedWei"] += int(event["amountWei"])
            entry["contributions"] += 1
        else:
            entry["refundedWei"] += int(event["amountWei"])
    ranked = sorted(backers.values(), key=lambda entry: -entry["contributedWei"])
    return [{**entry, "contributedWei": str(entry["contributedWei"]), "refundedWei": str(entry["refundedWei"])} for entry in ranked]
