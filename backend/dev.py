"""Developer-only routes for deploying the contract with MetaMask from /deploy.html.
Registered only outside production, and they only answer this computer."""
import json
import re
import time

from flask import Blueprint, jsonify, request
from web3 import Web3
from web3.exceptions import TransactionNotFound

from . import config
from .chain import w3
from .details import InputError
from .state import activate_deployment
from .times import iso_millis, utc_now

dev = Blueprint("dev", __name__, url_prefix="/api/dev")

LOCAL_IPS = {"127.0.0.1", "::1", "::ffff:127.0.0.1"}
TX_HASH = re.compile(r"0x[0-9a-fA-F]{64}")


@dev.before_request
def only_this_computer():
    if request.remote_addr not in LOCAL_IPS:
        return jsonify(error="Developer tools are only available on the developer's computer."), 403


@dev.get("/artifact")
def artifact():
    compiled = read_artifact()
    return jsonify(abi=compiled["abi"], bytecode=compiled["bytecode"])


# Called by /deploy.html after MetaMask deployed the contract. The server checks the
# transaction on Sepolia itself before saving deployments/sepolia.json.
@dev.post("/deployment")
def save_deployment():
    body = request.get_json(silent=True) or {}
    tx_hash = str(body.get("txHash") or "")
    if not TX_HASH.fullmatch(tx_hash):
        raise InputError("Invalid transaction hash.")

    receipt = wait_for_receipt(tx_hash)
    if not receipt or receipt["status"] != 1 or not receipt.get("contractAddress"):
        raise InputError("That transaction did not deploy a contract.")

    code = Web3.to_hex(w3.eth.get_code(receipt["contractAddress"]))
    if code.lower() != read_artifact()["deployedBytecode"].lower():
        raise InputError("The deployed code does not match the compiled Crowdfunding contract.")

    deployment = {
        "network": "sepolia",
        "chainId": config.CHAIN["chainId"],
        "address": Web3.to_checksum_address(receipt["contractAddress"]),
        "deployBlock": receipt["blockNumber"],
        "txHash": tx_hash,
        "deployer": Web3.to_checksum_address(receipt["from"]),
        "deployedAt": iso_millis(utc_now()),
    }
    config.save_deployment(deployment)
    activate_deployment(deployment)
    return jsonify(deployment)


def read_artifact():
    if not config.ARTIFACT_PATH.exists():
        raise InputError("The contract is not compiled yet. Run `npm run compile` first.", 404)
    return json.loads(config.ARTIFACT_PATH.read_text(encoding="utf-8"))


def wait_for_receipt(tx_hash, attempts=10):
    """The public RPC node can be a block behind MetaMask's node, so retry for a short while."""
    for _ in range(attempts):
        try:
            return w3.eth.get_transaction_receipt(tx_hash)
        except TransactionNotFound:
            time.sleep(3)
    return None
