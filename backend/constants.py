"""Rules shared with the browser. They must stay identical to public/js/shared/constants.js:
tests/test_shared_with_browser.py runs both versions with Node.js and compares the results."""
import re

SEPOLIA = {
    "chainId": 11155111,
    "chainIdHex": "0xaa36a7",
    "name": "Sepolia",
    "explorerUrl": "https://sepolia.etherscan.io",
    "rpcUrl": "https://ethereum-sepolia-rpc.publicnode.com",
    "currency": {"name": "Sepolia Ether", "symbol": "ETH", "decimals": 18},
}

CATEGORIES = [
    "Technology",
    "Arts & Design",
    "Games",
    "Community",
    "Sports",
    "Education",
    "Environment",
    "Other",
]

LIMITS = {
    "titleMaxBytes": 80,  # must match MAX_TITLE_LENGTH in Crowdfunding.sol
    "descriptionMaxChars": 2000,
    "imageMaxBytes": 2 * 1024 * 1024,
    "imageTypes": ["image/png", "image/jpeg", "image/webp"],
    "signatureMaxAgeMs": 10 * 60 * 1000,
    "minDurationSeconds": 60,  # must match MIN_DURATION in Crowdfunding.sol
    "maxDurationSeconds": 90 * 24 * 60 * 60,  # must match MAX_DURATION in Crowdfunding.sol
}

# The characters JavaScript's trim() removes. Python's strip() uses a different set, and a
# single differing character would change the description hash the creator signed.
JS_WHITESPACE = (
    "\t\n\v\f\r            "
    "      　﻿"
)


def normalize_description(text):
    """Browsers send form text with "\\r\\n" line breaks, so normalise before hashing."""
    return re.sub(r"\r\n?", "\n", "" if text is None else str(text)).strip(JS_WHITESPACE)


def utf16_length(text):
    """String length as JavaScript counts it, so length limits match the browser exactly."""
    return len(text.encode("utf-16-le")) // 2


def build_details_message(campaign_id, contract_address, chain_id, category, description_sha256, image_sha256, issued_at):
    """The exact text a creator signs in MetaMask before campaign details are saved."""
    return "\n".join([
        "CampusFund: save campaign details",
        "",
        f"Campaign ID: {campaign_id}",
        f"Contract: {contract_address}",
        f"Chain ID: {chain_id}",
        f"Category: {category}",
        f"Description SHA-256: {description_sha256}",
        f"New cover image SHA-256: {'none' if image_sha256 is None else image_sha256}",
        f"Issued at: {issued_at}",
    ])
