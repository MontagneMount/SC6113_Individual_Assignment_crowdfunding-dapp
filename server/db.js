import { MongoClient } from "mongodb";
import { config } from "./config.js";

let client = null;
let database = null;

export class ServiceUnavailableError extends Error {
  status = 503;
}

/** Connects to MongoDB Atlas. Without MONGODB_URI the site still serves pages, but the API returns 503. */
export async function connectMongo() {
  if (!config.mongoUri) {
    console.warn("MONGODB_URI is not set: database features are off until it is added to .env");
    return;
  }
  const candidate = new MongoClient(config.mongoUri, { serverSelectionTimeoutMS: 10_000 });
  await candidate.connect();
  await candidate.db("admin").command({ ping: 1 });
  client = candidate;
  console.log("Connected to MongoDB");
}

/**
 * Each deployed contract gets its own database (e.g. crowdfunding_1a2b3c4d), so data
 * from an old deployment can never mix with a new one.
 */
export function useDeploymentDatabase(deployment) {
  database = client && deployment ? client.db(`${config.mongoDbName}_${deployment.address.slice(2, 10).toLowerCase()}`) : null;
}

export const isDbReady = () => database !== null;

function collection(name) {
  if (!database) throw new ServiceUnavailableError("The database is not available yet.");
  return database.collection(name);
}

export const collections = {
  campaigns: () => collection("campaigns"), // cached on-chain campaign data
  details: () => collection("campaignDetails"), // off-chain description, category, cover image id
  images: () => collection("images"), // uploaded cover images
  events: () => collection("events"), // every contract event, used for history
  meta: () => collection("meta"), // indexer progress
};

export async function ensureIndexes() {
  await collections.events().createIndex({ campaignId: 1, blockNumber: 1, logIndex: 1 });
  await collections.events().createIndex({ account: 1 });
  await collections.campaigns().createIndex({ creator: 1 });
}
