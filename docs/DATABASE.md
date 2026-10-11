# Database setup, submission and recovery

Use a separate MongoDB database for assessment or recovery; the deployed site and the developer's usual local server currently share Atlas data. Do not clear that shared database to test recovery.

## Setup

1. Install dependencies using the README. Configure your own MongoDB URI privately and select a distinct `MONGODB_DB` prefix, such as `crowdfunding_assessment`.
2. Keep the existing `deployments/sepolia.json` to read the demonstrated Sepolia contract. A new contract deployment is not necessary to replay its public events.
3. Run `python app.py` (or `gunicorn app:app` on a server). The application connects to Atlas, creates indexes and starts the indexer. The effective database name appends the first eight address hex digits to the prefix.
4. Check `/api/health` for database readiness and indexed block progress. Synchronisation depends on RPC availability; no fixed completion time is guaranteed.

## Collections

| Collection | Primary key | Fields and representation |
|---|---|---|
| campaigns | `_id`: numeric campaign id | creator/title; goalWei/totalRaisedWei/totalRefundedWei as decimal strings; deadline Unix seconds; withdrawn boolean; backerCount; creation transaction and time |
| events | `_id`: `txHash:logIndex` | campaignId, event name, account, amountWei string, transaction hash, block number/index and timestamp |
| meta | `_id`: `sync` | lastBlock and updatedAt |
| campaignDetails | `_id`: campaign id | category, description, imageId, signer, signature, issuedAt canonical ISO string, updatedAt |
| images | `_id`: ObjectId | campaignId, contentType, size, sha256, BSON Binary data, createdAt |
| visits | `_id`: ObjectId | at (BSON date), page path, campaignId or null, wallet (lower case) or null, visitor (random id from the browser), browser label such as "Edge on Windows" |

The default unique `_id` index protects initial metadata creation. Updates condition on the previously read `issuedAt`; conflicts return 409 and require refreshing/signing again. Event lookup indexes cover campaign/block/log and account; campaigns are indexed by creator. Currency strings avoid JavaScript Number precision loss.

`visits` is the visitor log. Every page sends one record when it opens; only the admin wallet can read or delete records through `/api/admin/visits`. Its `at` index is a TTL index (`expireAfterSeconds` = 30 days), so MongoDB deletes old records by itself. No IP address or full User-Agent string is stored. The connected wallet is reported by the browser and not verified, so the log describes visits; it is not proof of identity.

## Recovery and submission scope

- A fresh database can rebuild campaigns, events and sync progress from the deployment block. Start with a new prefix instead of deleting live records. Cached data is not authoritative for transfers.
- The default public RPC keeps only about two days of event logs and answers older ranges with "pruned history unavailable". The indexer then reads those ranges from `SEPOLIA_HISTORY_RPC_URL` (default: Tenderly's public Sepolia gateway, which keeps the full history), so a rebuild or a server that slept for days still sees every event. A full rebuild of the demonstrated deployment took about 20 seconds and matched the existing records.
- Descriptions, categories, signatures and image bytes cannot be recovered from Ethereum. Back up `campaignDetails` and `images` together using MongoDB tooling; BSON-preserving exports retain ObjectId/Binary types. Store and transmit credentials separately from any export.
- `visits` cannot be rebuilt either, but it is short-lived by design (30-day TTL) and needs no backup.
- For submission, the demonstration database is exported to JSON (next section) and handed in separately, together with this document. The export is not committed to this public repository.
- Uploads and metadata span separate collections. After an ambiguous network failure, an unreferenced image may remain. Preserve such data until reconciliation; never remove images referenced by current metadata.
- The indexer currently has no reorganisation rollback. Rebuilding is a recovery option, not a substitute for finality-aware indexing.

## Export

`python scripts/export_database.py [folder]` (with `MONGODB_URI` in `.env`) writes every collection of the deployment's database to `<collection>.json` in the folder (default `database-export/`, which git ignores), plus `export-info.json` with the database name, contract and document counts. Each file is a JSON array in MongoDB Extended JSON, so it opens in any text editor and imports with `mongoimport --db <name> --collection <collection> --jsonArray --file <collection>.json` or MongoDB Compass (Add Data → Import JSON). The export contains no credentials.

## Synthetic example (not a chain record or a valid signature)

`campaigns`: `{ "_id": 1, "goalWei": "1000000000000000", "totalRaisedWei": "0", "totalRefundedWei": "0", "withdrawn": false, "backerCount": 0 }`

This partial example only illustrates types. Actual financial records must be obtained from the contract, and metadata writes require a real creator signature.
