import express from "express";
import multer from "multer";
import { Binary, ObjectId } from "mongodb";
import { getAddress, isAddress } from "ethers";
import { CATEGORIES, LIMITS } from "../../public/js/shared/constants.js";
import { abi, config } from "../config.js";
import { nowSeconds, statusOf } from "../chain.js";
import { collections, isDbReady, ServiceUnavailableError } from "../db.js";
import { InputError, parseCampaignId, recoverDetailsSigner, sha256Hex, validateDetailsInput } from "../details.js";
import { getSyncedBlock, syncNow } from "../indexer.js";
import { rateLimit } from "../rate-limit.js";
import { state } from "../state.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: LIMITS.imageMaxBytes, files: 1, fields: 10, fieldSize: 16 * 1024 },
});

const writeLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 20 });
const syncLimit = rateLimit({ windowMs: 60 * 1000, max: 30 });

const compareBigInt = (a, b) => (a > b ? 1 : a < b ? -1 : 0);

const SORTS = {
  newest: (a, b) => b.id - a.id,
  // Running campaigns first (soonest deadline first), then ended ones (most recent first).
  ending: (a, b) => {
    const aActive = a.status === "active";
    const bActive = b.status === "active";
    if (aActive !== bActive) return aActive ? -1 : 1;
    return aActive ? a.deadline - b.deadline : b.deadline - a.deadline;
  },
  raised: (a, b) => compareBigInt(BigInt(b.totalRaisedWei), BigInt(a.totalRaisedWei)),
  progress: (a, b) => b.progress - a.progress,
};

export function createApiRouter() {
  const router = express.Router();

  router.get("/health", (req, res) => {
    res.json({
      ok: true,
      contract: state.deployment?.address ?? null,
      database: isDbReady(),
      syncedBlock: getSyncedBlock(),
    });
  });

  router.get("/config", (req, res) => {
    res.json({
      chain: config.chain,
      contractAddress: state.deployment?.address ?? null,
      deployBlock: state.deployment?.deployBlock ?? null,
      abi,
      categories: CATEGORIES,
      limits: LIMITS,
      databaseReady: isDbReady(),
      devTools: !config.isProduction,
    });
  });

  router.get("/campaigns", requireReady, async (req, res) => {
    const { q = "", category = "", status = "", sort = "newest" } = req.query;
    const [campaigns, details] = await Promise.all([
      collections.campaigns().find().toArray(),
      collections.details().find({}, { projection: { category: 1, description: 1, imageId: 1 } }).toArray(),
    ]);
    const detailsById = new Map(details.map((doc) => [doc._id, doc]));
    const now = nowSeconds();
    const search = String(q).trim().toLowerCase();

    let items = campaigns.map((campaign) => summarize(campaign, detailsById.get(campaign._id), now));
    if (search) {
      items = items.filter(
        (item) => item.title.toLowerCase().includes(search) || (item.description ?? "").toLowerCase().includes(search),
      );
    }
    if (category) items = items.filter((item) => item.category === category);
    if (status) items = items.filter((item) => item.status === status);
    items.sort(SORTS[sort] ?? SORTS.newest);

    res.json({ campaigns: items.map(withoutDescription), syncedBlock: getSyncedBlock() });
  });

  router.get("/campaigns/:id", requireReady, async (req, res) => {
    const campaignId = parseCampaignId(req.params.id);
    let campaign = await collections.campaigns().findOne({ _id: campaignId });
    if (!campaign) {
      await syncNow(); // it may have been created a moment ago
      campaign = await collections.campaigns().findOne({ _id: campaignId });
    }
    if (!campaign) throw new InputError("Campaign not found.", 404);

    const [details, events] = await Promise.all([
      collections.details().findOne({ _id: campaignId }),
      collections.events().find({ campaignId }).sort({ blockNumber: 1, logIndex: 1 }).toArray(),
    ]);

    res.json({
      campaign: summarize(campaign, details, nowSeconds()),
      details: details
        ? {
            category: details.category,
            description: details.description,
            imageUrl: details.imageId ? `/api/images/${details.imageId}` : null,
            signer: details.signer,
            updatedAt: details.updatedAt,
          }
        : null,
      backers: summarizeBackers(events),
      events: events.map(({ _id, ...event }) => event),
      syncedBlock: getSyncedBlock(),
    });
  });

  // Save description, category and cover image. Only the on-chain creator may do this,
  // proven by a MetaMask signature over the exact content.
  router.post("/campaigns/:id/metadata", requireReady, writeLimit, upload.single("image"), async (req, res) => {
    const campaignId = parseCampaignId(req.params.id);
    const input = validateDetailsInput(req.body, req.file);

    // Ask the contract who the creator is: the cache may not know a brand-new campaign yet.
    let creator;
    try {
      const [campaign] = await state.contract.getCampaign(campaignId);
      creator = getAddress(campaign.creator);
    } catch (err) {
      if (err.revert?.name === "CampaignNotFound") throw new InputError("Campaign not found on the blockchain.", 404);
      throw err;
    }

    const imageSha256 = req.file ? sha256Hex(req.file.buffer) : null;
    const signer = recoverDetailsSigner({
      campaignId,
      contractAddress: state.deployment.address,
      chainId: config.chain.chainId,
      input,
      imageSha256,
    });
    if (signer !== creator) throw new InputError("Only the campaign creator can edit its details.", 403);

    const existing = await collections.details().findOne({ _id: campaignId });
    if (existing && existing.issuedAt >= input.issuedAt) {
      throw new InputError("Newer details were already saved for this campaign.", 409);
    }

    let imageId = existing?.imageId ?? null;
    if (req.file) {
      const { insertedId } = await collections.images().insertOne({
        campaignId,
        contentType: req.file.mimetype,
        size: req.file.size,
        sha256: imageSha256,
        data: new Binary(req.file.buffer),
        createdAt: new Date(),
      });
      if (imageId) await collections.images().deleteOne({ _id: imageId });
      imageId = insertedId;
    }

    await collections.details().updateOne(
      { _id: campaignId },
      {
        $set: {
          category: input.category,
          description: input.description,
          imageId,
          signer: signer.toLowerCase(),
          signature: input.signature,
          issuedAt: input.issuedAt,
          updatedAt: new Date(),
        },
      },
      { upsert: true },
    );
    res.status(existing ? 200 : 201).json({ ok: true });
  });

  router.get("/images/:id", requireReady, async (req, res) => {
    if (!ObjectId.isValid(req.params.id)) throw new InputError("Image not found.", 404);
    const image = await collections.images().findOne({ _id: new ObjectId(req.params.id) });
    if (!image) throw new InputError("Image not found.", 404);

    res.set({ "Content-Type": image.contentType, "Cache-Control": "public, max-age=31536000, immutable" });
    res.send(Buffer.from(image.data.buffer));
  });

  router.get("/users/:address", requireReady, async (req, res) => {
    if (!isAddress(req.params.address)) throw new InputError("Invalid wallet address.");
    const account = req.params.address.toLowerCase();
    const now = nowSeconds();

    const [created, events] = await Promise.all([
      collections.campaigns().find({ creator: account }).sort({ _id: -1 }).toArray(),
      collections.events().find({ account }).toArray(),
    ]);

    let withdrawnWei = 0n;
    const myTotals = new Map(); // campaignId -> { contributedWei, refundedWei }
    for (const event of events) {
      if (event.name === "FundsWithdrawn") withdrawnWei += BigInt(event.amountWei);
      if (event.name !== "Contributed" && event.name !== "Refunded") continue;
      const entry = myTotals.get(event.campaignId) ?? { contributedWei: 0n, refundedWei: 0n };
      if (event.name === "Contributed") entry.contributedWei += BigInt(event.amountWei);
      else entry.refundedWei += BigInt(event.amountWei);
      myTotals.set(event.campaignId, entry);
    }

    const backedCampaigns = await collections
      .campaigns()
      .find({ _id: { $in: [...myTotals.keys()] } })
      .sort({ _id: -1 })
      .toArray();
    const ids = [...created, ...backedCampaigns].map((campaign) => campaign._id);
    const details = await collections
      .details()
      .find({ _id: { $in: ids } }, { projection: { category: 1, imageId: 1 } })
      .toArray();
    const detailsById = new Map(details.map((doc) => [doc._id, doc]));

    let contributedWei = 0n;
    let refundedWei = 0n;
    const backed = backedCampaigns.map((campaign) => {
      const mine = myTotals.get(campaign._id);
      contributedWei += mine.contributedWei;
      refundedWei += mine.refundedWei;
      const summary = summarize(campaign, detailsById.get(campaign._id), now);
      return {
        ...withoutDescription(summary),
        myContributedWei: mine.contributedWei.toString(),
        myRefundedWei: mine.refundedWei.toString(),
        canRefund: summary.status === "failed" && mine.contributedWei > mine.refundedWei,
      };
    });
    const createdSummaries = created.map((campaign) => {
      const summary = summarize(campaign, detailsById.get(campaign._id), now);
      return { ...withoutDescription(summary), canWithdraw: summary.status === "successful" };
    });

    res.json({
      address: getAddress(account),
      totals: {
        contributedWei: contributedWei.toString(),
        refundedWei: refundedWei.toString(),
        withdrawnWei: withdrawnWei.toString(),
        campaignsBacked: backed.length,
        campaignsCreated: createdSummaries.length,
      },
      backed,
      created: createdSummaries,
      syncedBlock: getSyncedBlock(),
    });
  });

  router.get("/stats", requireReady, async (req, res) => {
    const [campaigns, backers] = await Promise.all([
      collections.campaigns().find().toArray(),
      collections.events().distinct("account", { name: "Contributed" }),
    ]);
    const now = nowSeconds();
    const counts = { active: 0, successful: 0, failed: 0, withdrawn: 0 };
    let totalRaisedWei = 0n;
    for (const campaign of campaigns) {
      counts[statusOf(campaign, now)] += 1;
      totalRaisedWei += BigInt(campaign.totalRaisedWei);
    }
    const ended = counts.successful + counts.withdrawn + counts.failed;

    res.json({
      campaigns: campaigns.length,
      ...counts,
      totalRaisedWei: totalRaisedWei.toString(),
      backers: backers.length,
      successRate: ended > 0 ? (counts.successful + counts.withdrawn) / ended : null,
      syncedBlock: getSyncedBlock(),
    });
  });

  // The page calls this right after a transaction so the history updates without waiting.
  router.post("/sync", requireReady, syncLimit, async (req, res) => {
    await syncNow();
    res.json({ syncedBlock: getSyncedBlock() });
  });

  return router;
}

function requireReady(req, res, next) {
  if (!state.deployment) return next(new ServiceUnavailableError("The smart contract has not been deployed yet."));
  if (!isDbReady()) return next(new ServiceUnavailableError("The database is not connected yet."));
  next();
}

function summarize(campaign, details, now) {
  const raised = BigInt(campaign.totalRaisedWei);
  const goal = BigInt(campaign.goalWei);
  return {
    id: campaign._id,
    title: campaign.title,
    creator: campaign.creator,
    goalWei: campaign.goalWei,
    totalRaisedWei: campaign.totalRaisedWei,
    totalRefundedWei: campaign.totalRefundedWei,
    withdrawn: campaign.withdrawn,
    backerCount: campaign.backerCount,
    deadline: campaign.deadline,
    createdAt: campaign.createdAt,
    status: statusOf(campaign, now),
    progress: goal > 0n ? Number((raised * 10_000n) / goal) / 10_000 : 0,
    category: details?.category ?? null,
    description: details?.description ?? null,
    excerpt: details?.description ? excerpt(details.description) : null,
    imageUrl: details?.imageId ? `/api/images/${details.imageId}` : null,
  };
}

function withoutDescription({ description, ...rest }) {
  return rest;
}

function excerpt(text, max = 140) {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function summarizeBackers(events) {
  const backers = new Map();
  for (const event of events) {
    if (event.name !== "Contributed" && event.name !== "Refunded") continue;
    const entry = backers.get(event.account) ?? { address: event.account, contributedWei: 0n, refundedWei: 0n, contributions: 0 };
    if (event.name === "Contributed") {
      entry.contributedWei += BigInt(event.amountWei);
      entry.contributions += 1;
    } else {
      entry.refundedWei += BigInt(event.amountWei);
    }
    backers.set(event.account, entry);
  }
  return [...backers.values()]
    .sort((a, b) => compareBigInt(b.contributedWei, a.contributedWei))
    .map((entry) => ({ ...entry, contributedWei: entry.contributedWei.toString(), refundedWei: entry.refundedWei.toString() }));
}
