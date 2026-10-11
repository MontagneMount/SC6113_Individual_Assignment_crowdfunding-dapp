"""Compare-and-set saving of campaign details. Uses an atomic in-memory collection double;
these are unit tests, not MongoDB integration tests."""
import threading
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest
from pymongo.errors import DuplicateKeyError

from backend.details import InputError
from backend.details_store import save_details_version


class FakeCollection:
    """Holds at most one document and changes it atomically, like MongoDB does."""

    def __init__(self, initial=None):
        self.row = dict(initial) if initial else None
        self.lock = threading.Lock()

    def read(self):
        return dict(self.row) if self.row else None

    def insert_one(self, doc):
        with self.lock:
            if self.row:
                raise DuplicateKeyError("Duplicate key", 11000)
            self.row = dict(doc)

    def update_one(self, query, update):
        with self.lock:
            if not self.row or self.row["_id"] != query["_id"] or self.row["issuedAt"] != query["issuedAt"]:
                return SimpleNamespace(matched_count=0)
            self.row = {**self.row, **update["$set"]}
            return SimpleNamespace(matched_count=1)


BASE = {"_id": 1, "issuedAt": "2026-10-06T00:00:00.000Z", "imageId": "original"}
NEWER = {"issuedAt": "2026-10-06T00:00:02.000Z", "imageId": "new"}
OLDER = {"issuedAt": "2026-10-06T00:00:01.000Z", "imageId": "old"}


def run_at_once(*calls):
    """Starts all calls at the same moment; returns None for each success and the error otherwise."""
    start = threading.Barrier(len(calls))

    def run(call):
        start.wait()
        try:
            call()
        except Exception as err:
            return err
        return None

    with ThreadPoolExecutor(len(calls)) as pool:
        return list(pool.map(run, calls))


def test_rejects_an_equal_time_replay_and_preserves_the_saved_record():
    db = FakeCollection(BASE)
    with pytest.raises(InputError) as conflict:
        save_details_version(db, 1, db.read(), BASE)
    assert conflict.value.status == 409
    assert db.read() == BASE


def test_a_delayed_older_writer_cannot_overwrite_a_newer_version_or_image():
    db = FakeCollection(BASE)
    snapshot = db.read()
    save_details_version(db, 1, snapshot, NEWER)
    with pytest.raises(InputError) as conflict:
        save_details_version(db, 1, snapshot, OLDER)
    assert conflict.value.status == 409
    assert db.read()["imageId"] == "new"


def test_concurrent_updates_from_the_same_snapshot_have_one_winner():
    db = FakeCollection(BASE)
    results = run_at_once(lambda: save_details_version(db, 1, BASE, OLDER), lambda: save_details_version(db, 1, BASE, NEWER))
    assert results.count(None) == 1
    assert next(err for err in results if err).status == 409


def test_concurrent_first_saves_cannot_replace_the_winning_document():
    db = FakeCollection()
    results = run_at_once(lambda: save_details_version(db, 1, None, NEWER), lambda: save_details_version(db, 1, None, OLDER))
    assert results.count(None) == 1
    assert next(err for err in results if err).status == 409
    winner = [NEWER, OLDER][results.index(None)]
    assert db.read()["issuedAt"] == winner["issuedAt"]


def test_a_fresh_snapshot_can_save_a_newer_version_after_a_conflict():
    db = FakeCollection(BASE)
    save_details_version(db, 1, db.read(), OLDER)
    save_details_version(db, 1, db.read(), NEWER)
    assert db.read()["issuedAt"] == NEWER["issuedAt"]


def test_database_failures_are_propagated_rather_than_reported_as_replay():
    failure = ConnectionError("Connection interrupted")

    class BrokenCollection:
        def insert_one(self, doc):
            raise failure

    with pytest.raises(ConnectionError) as raised:
        save_details_version(BrokenCollection(), 1, None, NEWER)
    assert raised.value is failure
