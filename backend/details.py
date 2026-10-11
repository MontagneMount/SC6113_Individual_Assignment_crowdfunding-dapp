"""Validation and signature checks for off-chain campaign details (description, category,
cover image). Only the on-chain creator may save them."""
import hashlib
import re
import time

from eth_account import Account
from eth_account.messages import encode_defunct
from web3 import Web3

from .constants import CATEGORIES, LIMITS, build_details_message, normalize_description, utf16_length
from .times import parse_iso_millis


class InputError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.message = message
        self.status = status


def sha256_hex(data):
    return hashlib.sha256(data).hexdigest()


# Check the real file bytes, not just the type the browser claims.
FILE_SIGNATURES = {
    "image/png": lambda data: len(data) > 8 and data[:4] == b"\x89PNG",
    "image/jpeg": lambda data: len(data) > 3 and data[:3] == b"\xff\xd8\xff",
    "image/webp": lambda data: len(data) > 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP",
}

ISO_TIME = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z")
SIGNATURE = re.compile(r"0x[0-9a-fA-F]{130}")
CAMPAIGN_ID = re.compile(r"[1-9][0-9]{0,15}")
MAX_SAFE_INTEGER = 2**53 - 1  # the largest id the browser can represent exactly


def parse_campaign_id(raw):
    if not isinstance(raw, str) or not CAMPAIGN_ID.fullmatch(raw) or int(raw) > MAX_SAFE_INTEGER:
        raise InputError("Invalid campaign id.")
    return int(raw)


def validate_details_input(form, image):
    """`form` holds the text fields; `image` is (mimetype, bytes) or None."""
    category = form.get("category")
    description = normalize_description(form.get("description"))
    issued_at = form.get("issuedAt")
    signature = form.get("signature")

    if category not in CATEGORIES:
        raise InputError("Please choose a valid category.")
    if len(description) == 0:
        raise InputError("Description is required.")
    if utf16_length(description) > LIMITS["descriptionMaxChars"]:
        raise InputError(f"Description must be at most {LIMITS['descriptionMaxChars']} characters.")
    if not isinstance(issued_at, str) or not ISO_TIME.fullmatch(issued_at):
        raise InputError("Invalid signing time.")
    issued_ms = parse_iso_millis(issued_at)
    if issued_ms is None:
        raise InputError("Invalid signing time.")
    if abs(time.time() * 1000 - issued_ms) > LIMITS["signatureMaxAgeMs"]:
        raise InputError("This signature has expired. Please try again.")
    if not isinstance(signature, str) or not SIGNATURE.fullmatch(signature):
        raise InputError("Missing or invalid signature.")

    if image is not None:
        mimetype, data = image
        check = FILE_SIGNATURES.get(mimetype)
        if mimetype not in LIMITS["imageTypes"] or check is None or not check(data):
            raise InputError("Cover image must be a PNG, JPEG or WebP file.")

    return {"category": category, "description": description, "issuedAt": issued_at, "signature": signature}


def recover_details_signer(campaign_id, contract_address, chain_id, details, image_sha256):
    """Rebuilds the message the creator signed and returns the address that signed it."""
    message = build_details_message(
        campaign_id=campaign_id,
        contract_address=contract_address,
        chain_id=chain_id,
        category=details["category"],
        description_sha256=sha256_hex(details["description"].encode("utf-8")),
        image_sha256=image_sha256,
        issued_at=details["issuedAt"],
    )
    try:
        signer = Account.recover_message(encode_defunct(text=message), signature=details["signature"])
    except Exception:
        raise InputError("The signature could not be verified.") from None
    return Web3.to_checksum_address(signer)
