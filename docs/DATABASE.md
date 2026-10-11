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

The default unique `_id` index protects initial metadata creation. Updates condition on the previously read `issuedAt`; conflicts return 409 and require refreshing/signing again. Event lookup indexes cover campaign/block/log and account; campaigns are indexed by creator. Currency strings avoid JavaScript Number precision loss.

## Recovery and submission scope

- A fresh database can rebuild campaigns, events and sync progress from the deployment block. Start with a new prefix instead of deleting live records. Cached data is not authoritative for transfers.
- The default public RPC keeps only about two days of event logs and answers older ranges with "pruned history unavailable". The indexer then reads those ranges from `SEPOLIA_HISTORY_RPC_URL` (default: Tenderly's public Sepolia gateway, which keeps the full history), so a rebuild or a server that slept for days still sees every event. A full rebuild of the demonstrated deployment took about 20 seconds and matched the existing records.
- Descriptions, categories, signatures and image bytes cannot be recovered from Ethereum. Back up `campaignDetails` and `images` together using MongoDB tooling; BSON-preserving exports retain ObjectId/Binary types. Store and transmit credentials separately from any export.
- For submission, include this schema/setup document, source and deployment configuration. If a database snapshot is required, add an approved export of the demonstration metadata and images. No live snapshot is included by this change; chain-replay instructions alone do not restore that metadata.
- Uploads and metadata span separate collections. After an ambiguous network failure, an unreferenced image may remain. Preserve such data until reconciliation; never remove images referenced by current metadata.
- The indexer currently has no reorganisation rollback. Rebuilding is a recovery option, not a substitute for finality-aware indexing.

## Synthetic example (not a chain record or a valid signature)

`campaigns`: `{ "_id": 1, "goalWei": "1000000000000000", "totalRaisedWei": "0", "totalRefundedWei": "0", "withdrawn": false, "backerCount": 0 }`

This partial example only illustrates types. Actual financial records must be obtained from the contract, and metadata writes require a real creator signature.
