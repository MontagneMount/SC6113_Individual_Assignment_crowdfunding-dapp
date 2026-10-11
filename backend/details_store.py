from pymongo.errors import DuplicateKeyError

from .details import InputError


def _conflict():
    return InputError("Details changed or this signature was already used. Please sign again.", 409)


# Compare-and-set protects the version AND image reference read by the request.
# A concurrent writer causes a conflict rather than overwriting its newer state.
def save_details_version(collection, campaign_id, existing, details):
    if existing and existing["issuedAt"] >= details["issuedAt"]:
        raise _conflict()
    if not existing:
        try:
            collection.insert_one({"_id": campaign_id, **details})
        except DuplicateKeyError:
            raise _conflict() from None
        return
    result = collection.update_one({"_id": campaign_id, "issuedAt": existing["issuedAt"]}, {"$set": details})
    if result.matched_count != 1:
        raise _conflict()
