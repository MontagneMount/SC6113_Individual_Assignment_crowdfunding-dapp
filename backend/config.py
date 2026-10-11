import json
import os
from pathlib import Path

from dotenv import load_dotenv
from web3 import Web3

from .constants import SEPOLIA

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")  # fills in variables that are not already set

PUBLIC_DIR = ROOT / "public"
ABI_PATH = ROOT / "abi" / "Crowdfunding.json"
ARTIFACT_PATH = ROOT / "artifacts" / "contracts" / "Crowdfunding.sol" / "Crowdfunding.json"
DEPLOYMENT_PATH = ROOT / "deployments" / "sepolia.json"

PORT = int(os.environ.get("PORT") or 3000)
# Render sets RENDER=true on its servers; APP_ENV=production does the same anywhere else.
IS_PRODUCTION = os.environ.get("APP_ENV") == "production" or os.environ.get("RENDER") == "true"
MONGO_URI = os.environ.get("MONGODB_URI", "")
MONGO_DB_NAME = os.environ.get("MONGODB_DB") or "crowdfunding"
# Server-side RPC (may contain a private API key, so it is never sent to browsers).
RPC_URL = os.environ.get("SEPOLIA_RPC_URL") or SEPOLIA["rpcUrl"]
# The public RPC above only keeps about two days of event logs ("pruned history unavailable"),
# so older logs are read from an endpoint that keeps the full history.
HISTORY_RPC_URL = os.environ.get("SEPOLIA_HISTORY_RPC_URL") or "https://sepolia.gateway.tenderly.co"
CHAIN = SEPOLIA
# Wallets that may open the visitor log. Empty means the wallet that deployed the contract.
ADMIN_ADDRESSES = [address.strip() for address in os.environ.get("ADMIN_ADDRESSES", "").split(",") if address.strip()]

ABI = json.loads(ABI_PATH.read_text(encoding="utf-8"))["abi"]


def load_deployment():
    """Returns the deployed contract info, or None if the contract has not been deployed yet."""
    if not DEPLOYMENT_PATH.exists():
        return None
    data = json.loads(DEPLOYMENT_PATH.read_text(encoding="utf-8"))
    return {**data, "address": Web3.to_checksum_address(data["address"])}


def save_deployment(deployment):
    DEPLOYMENT_PATH.parent.mkdir(parents=True, exist_ok=True)
    DEPLOYMENT_PATH.write_text(json.dumps(deployment, indent=2) + "\n", encoding="utf-8")
