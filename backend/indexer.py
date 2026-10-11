"""Copies contract events from Sepolia into MongoDB so pages can search, sort and show
history quickly. The blockchain stays the source of truth: this is a cache that can be
rebuilt from the chain."""
import logging
import threading
import time

from pymongo import UpdateOne
from web3 import Web3

from . import config, db
from .chain import history_w3, read_campaign, w3
from .times import utc_now

log = logging.getLogger(__name__)

POLL_INTERVAL = 12  # seconds, about one Sepolia block
RETRY_INTERVAL = 30
BLOCK_CHUNK = 2_000  # small eth_getLogs ranges keep public RPC endpoints happy
LOG_ATTEMPTS = 4  # tries per range against the main RPC before waiting for the next poll

ACCOUNT_FIELD = {"CampaignCreated": "creator", "Contributed": "backer", "FundsWithdrawn": "creator", "Refunded": "backer"}
AMOUNT_FIELD = {"CampaignCreated": "goal", "Contributed": "amount", "FundsWithdrawn": "amount", "Refunded": "amount"}


def _event_topic(item):
    types = ",".join(field["type"] for field in item["inputs"])
    return Web3.to_hex(Web3.keccak(text=f"{item['name']}({types})"))


EVENT_BY_TOPIC = {
    _event_topic(item): item["name"]
    for item in config.ABI
    if item.get("type") == "event" and item["name"] in ACCOUNT_FIELD
}


class _Run:
    """One deployment being indexed. Setting `stopped` ends its polling thread."""

    def __init__(self, deployment, contract):
        self.deployment = deployment
        self.contract = contract
        self.stopped = threading.Event()


_active = None
_sync_lock = threading.Lock()  # one sync at a time, shared by the poll loop and requests
_synced_block = None


def get_synced_block():
    return _synced_block


def start_indexer(deployment, contract):
    global _active, _synced_block
    stop_indexer()
    progress = db.meta().find_one({"_id": "sync"})
    run = _Run(deployment, contract)
    with _sync_lock:
        _synced_block = progress["lastBlock"] if progress else deployment["deployBlock"] - 1
        _active = run
    log.info("Indexer watching %s from block %s", deployment["address"], _synced_block + 1)
    threading.Thread(target=_poll, args=(run,), name="indexer", daemon=True).start()


def stop_indexer():
    global _active
    if _active is not None:
        _active.stopped.set()
    _active = None


def sync_now():
    """Runs one sync now. Used by the poll loop and right after a user's transaction."""
    run = _active
    if run is not None:
        _sync(run)


def _poll(run):
    delay = 0
    while not run.stopped.wait(delay):
        try:
            _sync(run)
            delay = POLL_INTERVAL
        except Exception as err:
            log.error("Indexer error: %s", err)
            delay = RETRY_INTERVAL


def _sync(run):
    with _sync_lock:
        if _active is run:
            _sync_once(run)


def _sync_once(run):
    global _synced_block
    latest = w3.eth.block_number
    start = _synced_block + 1

    while start <= latest:
        end = min(start + BLOCK_CHUNK - 1, latest)
        logs, provider = _get_logs(run.deployment["address"], start, end)
        if _active is not run:
            return  # the deployment changed while we were waiting

        if logs:
            events = _to_event_docs(run.contract, logs, provider)
            _save_events(events)
            for campaign_id in dict.fromkeys(event["campaignId"] for event in events):
                _refresh_campaign(run.contract, campaign_id)

        db.meta().update_one({"_id": "sync"}, {"$set": {"lastBlock": end, "updatedAt": utc_now()}}, upsert=True)
        _synced_block = end
        start = end + 1


def _get_logs(address, start, end):
    """Returns the range's logs and the Web3 connection that served them. Ranges the main RPC
    has pruned are read from the full-history RPC instead, so no event is ever skipped."""
    query = {"address": address, "fromBlock": start, "toBlock": end}
    for attempt in range(1, LOG_ATTEMPTS + 1):
        try:
            return w3.eth.get_logs(query), w3
        except Exception as err:
            if _is_pruned(err):
                log.info("Blocks %s-%s are pruned on the main RPC; reading them from %s", start, end, config.HISTORY_RPC_URL)
                return history_w3.eth.get_logs(query), history_w3
            if attempt == LOG_ATTEMPTS:
                raise
            log.warning("eth_getLogs %s-%s failed (%s); retrying", start, end, err)
            time.sleep(2 * attempt)


def _is_pruned(err):
    text = str(err).lower()
    return "4444" in text or "pruned" in text


def _to_event_docs(contract, logs, provider):
    block_numbers = dict.fromkeys(entry["blockNumber"] for entry in logs)
    timestamps = {number: provider.eth.get_block(number)["timestamp"] for number in block_numbers}
    docs = (_to_event_doc(contract, entry, timestamps[entry["blockNumber"]]) for entry in logs)
    return [doc for doc in docs if doc is not None]


def _to_event_doc(contract, entry, timestamp):
    name = EVENT_BY_TOPIC.get(Web3.to_hex(entry["topics"][0])) if entry["topics"] else None
    if name is None:
        return None
    try:
        args = getattr(contract.events, name)().process_log(entry)["args"]
    except Exception:
        return None

    tx_hash = Web3.to_hex(entry["transactionHash"])
    return {
        "_id": f"{tx_hash}:{entry['logIndex']}",
        "name": name,
        "campaignId": int(args["campaignId"]),
        "account": args[ACCOUNT_FIELD[name]].lower(),
        "amountWei": str(args[AMOUNT_FIELD[name]]),
        "txHash": tx_hash,
        "logIndex": entry["logIndex"],
        "blockNumber": entry["blockNumber"],
        "timestamp": timestamp,
    }


def _save_events(events):
    if events:
        db.events().bulk_write([
            UpdateOne({"_id": event["_id"]}, {"$set": {key: value for key, value in event.items() if key != "_id"}}, upsert=True)
            for event in events
        ])


def _refresh_campaign(contract, campaign_id):
    """Reads the campaign straight from the contract, so cached numbers always match the chain."""
    campaign = read_campaign(contract, campaign_id)
    if campaign is None:
        return
    created = db.events().find_one({"campaignId": campaign_id, "name": "CampaignCreated"})
    db.campaigns().update_one(
        {"_id": campaign_id},
        {
            "$set": {
                "creator": campaign["creator"].lower(),
                "title": campaign["title"],
                "goalWei": str(campaign["goal"]),
                "deadline": int(campaign["deadline"]),
                "totalRaisedWei": str(campaign["totalRaised"]),
                "totalRefundedWei": str(campaign["totalRefunded"]),
                "withdrawn": bool(campaign["withdrawn"]),
                "backerCount": int(campaign["backerCount"]),
                "createdAt": created["timestamp"] if created else None,
                "createdTxHash": created["txHash"] if created else None,
                "syncedAt": utc_now(),
            }
        },
        upsert=True,
    )
