"""Campaign-details validation and creator signatures."""
import hashlib
from datetime import datetime, timedelta, timezone

import pytest
from eth_account import Account
from eth_account.messages import encode_defunct
from web3 import Web3

from backend.constants import build_details_message, normalize_description
from backend.details import InputError, parse_campaign_id, recover_details_signer, validate_details_input
from backend.times import iso_millis

CONTRACT = "0x5FbDB2315678afecb367f032d93F642f64180aa3"
CHAIN_ID = 11155111
PNG_BYTES = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00])


def iso_now(offset=timedelta()):
    return iso_millis(datetime.now(timezone.utc) + offset)


def sign_details(account, campaign_id=1, category="Games", description="A cooperative board game.", issued_at=None):
    """Signs details the way public/js/contract.js does in the browser."""
    issued_at = issued_at or iso_now()
    message = build_details_message(
        campaign_id=campaign_id,
        contract_address=CONTRACT,
        chain_id=CHAIN_ID,
        category=category,
        description_sha256=hashlib.sha256(normalize_description(description).encode("utf-8")).hexdigest(),
        image_sha256=None,
        issued_at=issued_at,
    )
    signature = Account.sign_message(encode_defunct(text=message), account.key).signature
    return {"category": category, "description": description, "issuedAt": issued_at, "signature": Web3.to_hex(signature)}


def recover(details, campaign_id=1):
    return recover_details_signer(
        campaign_id=campaign_id, contract_address=CONTRACT, chain_id=CHAIN_ID, details=details, image_sha256=None
    )


class TestCreatorSignatures:
    def test_recovers_the_address_that_signed_the_details(self):
        creator = Account.create()
        details = validate_details_input(sign_details(creator), None)
        assert recover(details) == creator.address

    def test_detects_a_description_that_was_changed_after_signing(self):
        creator = Account.create()
        signed = sign_details(creator)
        tampered = validate_details_input({**signed, "description": "Something else entirely."}, None)
        assert recover(tampered) != creator.address

    def test_does_not_accept_a_signature_made_for_another_campaign(self):
        creator = Account.create()
        details = validate_details_input(sign_details(creator, campaign_id=1), None)
        assert recover(details, campaign_id=2) != creator.address

    def test_treats_browser_line_breaks_the_same_as_newlines(self):
        creator = Account.create()
        signed = sign_details(creator, description="Line one\nLine two")
        from_form = validate_details_input({**signed, "description": "Line one\r\nLine two"}, None)
        assert recover(from_form) == creator.address


def valid():
    return {"category": "Games", "description": "Hello", "issuedAt": iso_now(), "signature": "0x" + "ab" * 65}


class TestInputValidation:
    def test_accepts_a_well_formed_request(self):
        assert validate_details_input(valid(), None)["description"] == "Hello"

    @pytest.mark.parametrize(
        ("patch", "expected"),
        [
            ({"category": "Crypto"}, "category"),
            ({"description": "   "}, "required"),
            ({"description": "x" * 2001}, "at most"),
            ({"issuedAt": iso_now(-timedelta(minutes=11))}, "expired"),
            ({"issuedAt": "yesterday"}, "signing time"),
            ({"issuedAt": "2026-99-99T99:99:99.999Z"}, "signing time"),
            ({"issuedAt": "2026-02-30T00:00:00.000Z"}, "signing time"),
            ({"signature": "0x1234"}, "signature"),
        ],
        ids=[
            "an unknown category",
            "an empty description",
            "a description over 2000 characters",
            "an expired signing time",
            "a malformed signing time",
            "an impossible ISO date",
            "a date normalised into another day",
            "a malformed signature",
        ],
    )
    def test_rejects(self, patch, expected):
        with pytest.raises(InputError, match=expected):
            validate_details_input({**valid(), **patch}, None)

    def test_accepts_a_real_png_and_rejects_a_file_that_only_claims_to_be_one(self):
        assert validate_details_input(valid(), ("image/png", PNG_BYTES))
        with pytest.raises(InputError, match="PNG, JPEG or WebP"):
            validate_details_input(valid(), ("image/png", b"<script>alert(1)</script>"))

    def test_only_accepts_positive_whole_campaign_ids(self):
        assert parse_campaign_id("7") == 7
        for bad in ["0", "-1", "1.5", "abc", ""]:
            with pytest.raises(InputError):
                parse_campaign_id(bad)
