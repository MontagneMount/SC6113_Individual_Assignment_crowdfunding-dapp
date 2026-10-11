import logging

from . import db
from .chain import get_contract
from .indexer import start_indexer, stop_indexer

log = logging.getLogger(__name__)


class _State:
    """The contract the server is currently working with (None until it is deployed)."""

    deployment = None
    contract = None


state = _State()


def activate_deployment(deployment):
    stop_indexer()
    state.deployment = deployment
    state.contract = get_contract(deployment["address"]) if deployment else None
    db.use_deployment_database(deployment)

    if not deployment:
        log.info("No contract deployed yet: open /deploy.html locally to deploy it")
        return
    if not db.is_ready():
        return

    db.ensure_indexes()
    start_indexer(deployment, state.contract)
