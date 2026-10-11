"""Exports every MongoDB collection of the deployed contract's database to JSON files.

Usage (from the crowdfunding-dapp folder, with MONGODB_URI in .env):
    .venv\\Scripts\\python scripts/export_database.py [output folder]

Each collection becomes <name>.json: a JSON array in MongoDB Extended JSON, readable in any
text editor and importable with `mongoimport --jsonArray` or MongoDB Compass (Import JSON).
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # lets this script import backend/

from bson import json_util  # noqa: E402

from backend import config, db  # noqa: E402
from backend.times import iso_millis, utc_now  # noqa: E402

COLLECTIONS = {
    "campaigns": db.campaigns,
    "events": db.events,
    "meta": db.meta,
    "campaignDetails": db.details,
    "images": db.images,
    "visits": db.visits,
}


def main():
    out_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else config.ROOT / "database-export"
    deployment = config.load_deployment()
    if not config.MONGO_URI or not deployment:
        sys.exit("Needs MONGODB_URI in .env and a deployed contract (deployments/sepolia.json).")

    db.connect_mongo()
    db.use_deployment_database(deployment)
    out_dir.mkdir(parents=True, exist_ok=True)

    counts = {}
    for name, collection in COLLECTIONS.items():
        documents = list(collection().find().sort("_id", 1))
        text = json_util.dumps(documents, json_options=json_util.RELAXED_JSON_OPTIONS, indent=2, ensure_ascii=False)
        (out_dir / f"{name}.json").write_text(text + "\n", encoding="utf-8")
        counts[name] = len(documents)
        print(f"{name}: {len(documents)} documents")

    summary = {
        "exportedAt": iso_millis(utc_now()),
        "database": f"{config.MONGO_DB_NAME}_{deployment['address'][2:10].lower()}",
        "contract": deployment["address"],
        "network": deployment["network"],
        "documents": counts,
    }
    (out_dir / "export-info.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(COLLECTIONS)} collections to {out_dir}")


if __name__ == "__main__":
    main()
