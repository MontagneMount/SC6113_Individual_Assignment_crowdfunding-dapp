import time

from web3 import Web3
from web3.exceptions import ContractCustomError

from . import config

w3 = Web3(Web3.HTTPProvider(config.RPC_URL, request_kwargs={"timeout": 30}))
history_w3 = Web3(Web3.HTTPProvider(config.HISTORY_RPC_URL, request_kwargs={"timeout": 30}))

# getCampaign returns the Campaign struct as a plain tuple, in the order the ABI lists its fields.
_GET_CAMPAIGN = next(item for item in config.ABI if item.get("name") == "getCampaign")
CAMPAIGN_FIELDS = [component["name"] for component in _GET_CAMPAIGN["outputs"][0]["components"]]
CAMPAIGN_NOT_FOUND = Web3.to_hex(Web3.keccak(text="CampaignNotFound(uint256)")[:4])


def get_contract(address):
    return w3.eth.contract(address=address, abi=config.ABI)


def now_seconds():
    return int(time.time())


def read_campaign(contract, campaign_id):
    """Reads a campaign straight from the contract, or returns None if it does not exist."""
    try:
        values, _status = contract.functions.getCampaign(campaign_id).call()
    except ContractCustomError as err:
        if str(err.data or "").lower().startswith(CAMPAIGN_NOT_FOUND):
            return None
        raise
    return dict(zip(CAMPAIGN_FIELDS, values))


def status_of(campaign, now=None):
    """Same rules as Crowdfunding.sol `_statusOf`, applied to a cached campaign."""
    now = now_seconds() if now is None else now
    if now < campaign["deadline"]:
        return "active"
    if int(campaign["totalRaisedWei"]) < int(campaign["goalWei"]):
        return "failed"
    return "withdrawn" if campaign["withdrawn"] else "successful"
