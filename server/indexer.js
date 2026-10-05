// Copies contract events from Sepolia into MongoDB so pages can search, sort and
// show history quickly. The blockchain stays the source of truth: this is a cache
// that can always be rebuilt from the chain.
import { contractInterface, provider } from "./chain.js";
import { collections } from "./db.js";

const POLL_INTERVAL_MS = 12_000; // about one Sepolia block
const RETRY_INTERVAL_MS = 30_000;
const BLOCK_CHUNK = 2_000; // small eth_getLogs ranges keep public RPC endpoints happy

const ACCOUNT_FIELD = { CampaignCreated: "creator", Contributed: "backer", FundsWithdrawn: "creator", Refunded: "backer" };
const AMOUNT_FIELD = { CampaignCreated: "goal", Contributed: "amount", FundsWithdrawn: "amount", Refunded: "amount" };

let active = null; // { deployment, contract } currently being indexed
let timer = null;
let running = null; // promise of the sync in progress, shared by concurrent callers
let syncedBlock = null;

export const getSyncedBlock = () => syncedBlock;

export async function startIndexer(deployment, contract) {
  stopIndexer();
  const progress = await collections.meta().findOne({ _id: "sync" });
  syncedBlock = progress?.lastBlock ?? deployment.deployBlock - 1;
  active = { deployment, contract };
  console.log(`Indexer watching ${deployment.address} from block ${syncedBlock + 1}`);
  schedule(0);
}

export function stopIndexer() {
  clearTimeout(timer);
  timer = null;
  active = null;
}

/** Runs one sync now. Used by the poll loop and right after a user's transaction. */
export function syncNow() {
  if (!active) return Promise.resolve();
  running ??= syncOnce(active).finally(() => {
    running = null;
  });
  return running;
}

function schedule(delayMs) {
  timer = setTimeout(async () => {
    if (!active) return;
    try {
      await syncNow();
      schedule(POLL_INTERVAL_MS);
    } catch (err) {
      console.error("Indexer error:", err.shortMessage ?? err.message);
      schedule(RETRY_INTERVAL_MS);
    }
  }, delayMs);
}

async function syncOnce(run) {
  const latest = await provider.getBlockNumber();
  let from = syncedBlock + 1;

  while (from <= latest) {
    const to = Math.min(from + BLOCK_CHUNK - 1, latest);
    const logs = await provider.getLogs({ address: run.deployment.address, fromBlock: from, toBlock: to });
    if (active !== run) return; // the deployment changed while we were waiting

    if (logs.length > 0) {
      const events = await toEventDocs(logs);
      await saveEvents(events);
      for (const campaignId of new Set(events.map((event) => event.campaignId))) {
        await refreshCampaign(run.contract, campaignId);
      }
    }

    await collections.meta().updateOne(
      { _id: "sync" },
      { $set: { lastBlock: to, updatedAt: new Date() } },
      { upsert: true },
    );
    syncedBlock = to;
    from = to + 1;
  }
}

async function toEventDocs(logs) {
  const timestamps = new Map();
  for (const blockNumber of new Set(logs.map((log) => log.blockNumber))) {
    const block = await provider.getBlock(blockNumber);
    timestamps.set(blockNumber, block.timestamp);
  }
  return logs.map((log) => toEventDoc(log, timestamps.get(log.blockNumber))).filter(Boolean);
}

function toEventDoc(log, timestamp) {
  let parsed = null;
  try {
    parsed = contractInterface.parseLog(log);
  } catch {
    return null;
  }
  if (!parsed || !(parsed.name in ACCOUNT_FIELD)) return null;

  return {
    _id: `${log.transactionHash}:${log.index}`,
    name: parsed.name,
    campaignId: Number(parsed.args.campaignId),
    account: parsed.args[ACCOUNT_FIELD[parsed.name]].toLowerCase(),
    amountWei: parsed.args[AMOUNT_FIELD[parsed.name]].toString(),
    txHash: log.transactionHash,
    logIndex: log.index,
    blockNumber: log.blockNumber,
    timestamp,
  };
}

async function saveEvents(events) {
  if (events.length === 0) return;
  await collections.events().bulkWrite(
    events.map((event) => ({ updateOne: { filter: { _id: event._id }, update: { $set: event }, upsert: true } })),
  );
}

/** Reads the campaign straight from the contract, so cached numbers always match the chain. */
async function refreshCampaign(contract, campaignId) {
  const [campaign] = await contract.getCampaign(campaignId);
  const created = await collections.events().findOne({ campaignId, name: "CampaignCreated" });

  await collections.campaigns().updateOne(
    { _id: campaignId },
    {
      $set: {
        creator: campaign.creator.toLowerCase(),
        title: campaign.title,
        goalWei: campaign.goal.toString(),
        deadline: Number(campaign.deadline),
        totalRaisedWei: campaign.totalRaised.toString(),
        totalRefundedWei: campaign.totalRefunded.toString(),
        withdrawn: campaign.withdrawn,
        backerCount: Number(campaign.backerCount),
        createdAt: created?.timestamp ?? null,
        createdTxHash: created?.txHash ?? null,
        syncedAt: new Date(),
      },
    },
    { upsert: true },
  );
}
