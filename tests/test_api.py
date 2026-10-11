"""HTTP behaviour of the Flask app, checked without MongoDB or the blockchain."""
import io

import pytest

from backend import create_app, db
from backend.constants import LIMITS
from backend.state import state

CONTRACT = "0xc898d65cbB8f51D4811acd5911685eBD9731C968"


@pytest.fixture
def client():
    return create_app(start_services=False).test_client()


@pytest.fixture
def ready(monkeypatch):
    """Pretends the contract is deployed and the database is connected."""
    monkeypatch.setattr(state, "deployment", {"address": CONTRACT, "deployBlock": 1})
    monkeypatch.setattr(db, "is_ready", lambda: True)


def details_form(**changes):
    form = {"category": "Games", "description": "Hello", "issuedAt": "2026-02-30T00:00:00.000Z", "signature": "0x" + "ab" * 65}
    return {**form, **changes}


def test_health_works_without_a_database(client):
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.get_json() == {"ok": True, "contract": None, "database": False, "syncedBlock": None}


def test_data_endpoints_need_a_deployed_contract(client):
    response = client.get("/api/campaigns")
    assert response.status_code == 503
    assert response.get_json() == {"error": "The smart contract has not been deployed yet."}


def test_every_response_has_security_headers(client):
    headers = client.get("/api/health").headers
    assert headers["X-Content-Type-Options"] == "nosniff"
    assert headers["X-Frame-Options"] == "DENY"
    assert "connect-src 'self' https://ethereum-sepolia-rpc.publicnode.com" in headers["Content-Security-Policy"]


def test_unknown_api_routes_return_json_404(client):
    for response in (client.get("/api/nope"), client.get("/api/sync")):
        assert response.status_code == 404
        assert response.get_json() == {"error": "Not found."}


def test_serves_pages_scripts_and_the_ethers_bundle(client):
    home = client.get("/")
    assert home.status_code == 200 and home.mimetype == "text/html"
    assert client.get("/campaign").status_code == 200  # same as /campaign.html
    assert client.get("/js/api.js").mimetype == "text/javascript"  # module scripts need a JavaScript type
    ethers = client.get("/vendor/ethers/ethers.min.js")
    assert ethers.status_code == 200 and ethers.cache_control.max_age == 7 * 24 * 3600


def test_rejects_invalid_ids_and_addresses_before_using_the_database(client, ready):
    assert client.get("/api/campaigns/abc").get_json() == {"error": "Invalid campaign id."}
    assert client.get("/api/users/not-an-address").get_json() == {"error": "Invalid wallet address."}


def test_rejects_an_impossible_signing_date(client, ready):
    response = client.post("/api/campaigns/1/metadata", data=details_form())
    assert response.status_code == 400
    assert response.get_json() == {"error": "Invalid signing time."}


def test_normal_cover_images_get_through_the_upload_limits(client, ready):
    image = (io.BytesIO(b"\x89PNG" + b"\0" * 300_000), "cover.png", "image/png")
    response = client.post("/api/campaigns/1/metadata", data={**details_form(), "image": image})
    assert response.get_json() == {"error": "Invalid signing time."}  # reached validation, not an upload error


@pytest.mark.parametrize("extra_bytes", [1_000, 200_000], ids=["just over 2 MB", "far over 2 MB"])
def test_rejects_cover_images_over_2_mb(client, ready, extra_bytes):
    image = (io.BytesIO(b"\x89PNG" + b"\0" * (LIMITS["imageMaxBytes"] + extra_bytes)), "cover.png", "image/png")
    response = client.post("/api/campaigns/1/metadata", data={**details_form(), "image": image})
    assert response.status_code == 400
    assert response.get_json() == {"error": "Cover image must be 2 MB or smaller."}


def test_developer_routes_only_answer_this_computer(client):
    response = client.get("/api/dev/artifact", environ_base={"REMOTE_ADDR": "203.0.113.5"})
    assert response.status_code == 403
