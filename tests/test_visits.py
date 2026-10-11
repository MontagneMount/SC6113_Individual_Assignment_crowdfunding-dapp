"""Visitor log: what is stored for each page view, and who may read or delete the records.
Uses an in-memory collection double; these are unit tests, not MongoDB integration tests."""
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from bson import ObjectId
from eth_account import Account
from eth_account.messages import encode_defunct
from web3 import Web3

from backend import config, create_app, db, visits
from backend.constants import build_admin_message
from backend.details import InputError
from backend.state import state
from backend.times import iso_millis, utc_now

CONTRACT = "0xc898d65cbB8f51D4811acd5911685eBD9731C968"
VISITOR = "0f8fad5b-d9cb-469f-a165-70867728950e"
EDGE_ON_WINDOWS = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0"
)
ADMIN = Account.create()
STRANGER = Account.create()


class FakeCursor:
    def __init__(self, rows):
        self.rows = rows

    def sort(self, key, direction):
        self.rows = sorted(self.rows, key=lambda row: row[key], reverse=direction < 0)
        return self

    def limit(self, count):
        self.rows = self.rows[:count]
        return self

    def __iter__(self):
        return iter(self.rows)


class FakeVisits:
    """Just enough of a MongoDB collection for the visitor log: equality filters and $gte."""

    def __init__(self):
        self.rows = []

    @staticmethod
    def matches(row, query):
        for key, condition in query.items():
            if isinstance(condition, dict):
                if not row.get(key) >= condition["$gte"]:
                    return False
            elif row.get(key) != condition:
                return False
        return True

    def insert_one(self, doc):
        self.rows.append({"_id": ObjectId(), **doc})

    def find(self, query):
        return FakeCursor([row for row in self.rows if self.matches(row, query)])

    def count_documents(self, query):
        return len(self.find(query).rows)

    def distinct(self, field):
        return list({row.get(field) for row in self.rows})

    def delete_one(self, query):
        match = next((row for row in self.rows if self.matches(row, query)), None)
        if match is not None:
            self.rows.remove(match)
        return SimpleNamespace(deleted_count=0 if match is None else 1)

    def delete_many(self, query):
        kept = [row for row in self.rows if not self.matches(row, query)]
        deleted, self.rows = len(self.rows) - len(kept), kept
        return SimpleNamespace(deleted_count=deleted)


@pytest.fixture
def client():
    return create_app(start_services=False).test_client()


@pytest.fixture
def log(monkeypatch):
    """A deployed contract whose deployer is ADMIN, and an empty in-memory visitor log."""
    fake = FakeVisits()
    monkeypatch.setattr(state, "deployment", {"address": CONTRACT, "deployBlock": 1, "deployer": ADMIN.address})
    monkeypatch.setattr(db, "is_ready", lambda: True)
    monkeypatch.setattr(db, "visits", lambda: fake)
    monkeypatch.setattr(config, "ADMIN_ADDRESSES", [])
    return fake


def admin_headers(account=ADMIN, issued_at=None):
    """Signs in the way public/js/pages/admin.js does in the browser."""
    issued_at = issued_at or iso_millis(datetime.now(timezone.utc))
    message = build_admin_message(account.address, CONTRACT, 11155111, issued_at)
    signature = Account.sign_message(encode_defunct(text=message), account.key).signature
    return {"X-Admin-Wallet": account.address, "X-Admin-Issued-At": issued_at, "X-Admin-Signature": Web3.to_hex(signature)}


def visit_row(minutes_ago, page="/", wallet=None, visitor=VISITOR):
    return {
        "_id": ObjectId(),
        "at": utc_now() - timedelta(minutes=minutes_ago),
        "page": page,
        "campaignId": None,
        "wallet": wallet,
        "visitor": visitor,
        "browser": "Edge on Windows",
    }


@pytest.mark.parametrize(
    "user_agent, label",
    [
        (EDGE_ON_WINDOWS, "Edge on Windows"),
        ("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36", "Chrome on Android"),
        ("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", "Safari on iOS"),
        ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:131.0) Gecko/20100101 Firefox/131.0", "Firefox on macOS"),
        ("", "Other browser on other system"),
    ],
    ids=["Edge", "Chrome on Android", "Safari on iPhone", "Firefox on Mac", "empty"],
)
def test_keeps_only_the_browser_and_system_from_the_user_agent(user_agent, label):
    assert visits.browser_summary(user_agent) == label


def test_a_visit_keeps_page_campaign_wallet_visitor_and_browser():
    visit = visits.parse_visit(
        {"page": "/campaign.html", "campaignId": 2, "wallet": ADMIN.address, "visitor": VISITOR, "extra": "dropped"},
        EDGE_ON_WINDOWS,
    )
    assert visit == {
        "page": "/campaign",
        "campaignId": 2,
        "wallet": ADMIN.address.lower(),
        "visitor": VISITOR,
        "browser": "Edge on Windows",
    }


@pytest.mark.parametrize(
    "change",
    [
        {"page": "/admin"},
        {"page": ["/"]},
        {"page": "/", "campaignId": 2},
        {"campaignId": "2"},
        {"campaignId": True},
        {"campaignId": 0},
        {"wallet": "0x123"},
        {"visitor": "not-random"},
        {"visitor": None},
    ],
    ids=["unlogged page", "page not text", "id on another page", "id as text", "id as boolean", "id zero", "bad wallet", "bad visitor", "no visitor"],
)
def test_rejects_malformed_visits(change):
    with pytest.raises(InputError):
        visits.parse_visit({"page": "/campaign", "campaignId": 2, "wallet": None, "visitor": VISITOR, **change}, "")


def test_recording_a_visit_stores_no_ip_address(client, log):
    response = client.post(
        "/api/visits",
        json={"page": "/", "campaignId": None, "wallet": None, "visitor": VISITOR},
        headers={"User-Agent": EDGE_ON_WINDOWS},
        environ_base={"REMOTE_ADDR": "203.0.113.5"},
    )
    assert response.status_code == 204
    [row] = log.rows
    assert set(row) == {"_id", "at", "page", "campaignId", "wallet", "visitor", "browser"}
    assert "203.0.113.5" not in str(row)


def test_the_visitor_log_needs_an_admin_signature(client, log):
    response = client.get("/api/admin/visits")
    assert response.status_code == 401
    assert response.get_json() == {"error": "Please sign in with the admin wallet."}
    assert client.delete("/api/admin/visits").status_code == 401
    assert client.get("/admin").status_code == 200  # the page itself is public; its data is not


def test_other_wallets_cannot_open_the_visitor_log(client, log):
    response = client.get("/api/admin/visits", headers=admin_headers(STRANGER))
    assert response.status_code == 403
    assert response.get_json() == {"error": "This wallet is not an admin."}


def test_rejects_expired_or_borrowed_signatures(client, log):
    expired = admin_headers(issued_at=iso_millis(datetime.now(timezone.utc) - timedelta(minutes=11)))
    assert client.get("/api/admin/visits", headers=expired).get_json() == {
        "error": "Your admin sign-in has expired. Please sign in again."
    }
    borrowed = {**admin_headers(STRANGER), "X-Admin-Wallet": ADMIN.address}  # someone else's signature
    response = client.delete("/api/admin/visits", headers=borrowed)
    assert response.status_code == 401
    assert response.get_json() == {"error": "The signature could not be verified."}


def test_admin_can_list_filter_and_delete_visits(client, log):
    log.rows = [
        visit_row(5),
        visit_row(3 * 24 * 60, page="/me", wallet=STRANGER.address.lower()),
        visit_row(1, visitor="1" * 32),
    ]
    headers = admin_headers()

    data = client.get("/api/admin/visits", headers=headers).get_json()
    assert data["stats"] == {"total": 3, "last24h": 2, "visitors": 2, "wallets": 1}
    assert [visit["visitor"] for visit in data["visits"]] == ["1" * 32, VISITOR, VISITOR]  # newest first
    assert data["admin"] == ADMIN.address

    filtered = client.get(f"/api/admin/visits?wallet={STRANGER.address}", headers=headers).get_json()
    assert filtered["matching"] == 1 and filtered["visits"][0]["page"] == "/me"

    newest = data["visits"][0]["id"]
    assert client.delete(f"/api/admin/visits/{newest}", headers=headers).get_json() == {"deleted": 1}
    assert client.delete(f"/api/admin/visits/{newest}", headers=headers).status_code == 404
    assert client.delete("/api/admin/visits?page=/me", headers=headers).get_json() == {"deleted": 1}
    assert client.delete("/api/admin/visits", headers=headers).get_json() == {"deleted": 1}
    assert log.rows == []


def test_admin_wallets_can_be_configured(client, log, monkeypatch):
    monkeypatch.setattr(config, "ADMIN_ADDRESSES", [STRANGER.address])
    assert client.get("/api/admin/visits", headers=admin_headers(STRANGER)).status_code == 200
    assert client.get("/api/admin/visits", headers=admin_headers()).status_code == 403


def test_visits_expire_through_a_ttl_index(monkeypatch):
    created = {}

    def collection(name):
        return SimpleNamespace(create_index=lambda keys, **options: created.setdefault(name, []).append((keys, options)))

    monkeypatch.setattr(db, "_collection", collection)
    db.ensure_indexes()
    assert created["visits"] == [([("at", 1)], {"expireAfterSeconds": 30 * 24 * 3600})]
