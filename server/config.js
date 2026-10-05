import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress } from "ethers";
import { SEPOLIA } from "../public/js/shared/constants.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const paths = {
  root: rootDir,
  public: path.join(rootDir, "public"),
  abi: path.join(rootDir, "abi", "Crowdfunding.json"),
  artifact: path.join(rootDir, "artifacts", "contracts", "Crowdfunding.sol", "Crowdfunding.json"),
  deployment: path.join(rootDir, "deployments", "sepolia.json"),
  ethersDist: path.join(rootDir, "node_modules", "ethers", "dist"),
};

export const config = {
  port: Number(process.env.PORT) || 3000,
  isProduction: process.env.NODE_ENV === "production",
  mongoUri: process.env.MONGODB_URI || "",
  mongoDbName: process.env.MONGODB_DB || "crowdfunding",
  // Server-side RPC (may contain a private API key, so it is never sent to browsers).
  rpcUrl: process.env.SEPOLIA_RPC_URL || SEPOLIA.rpcUrl,
  chain: SEPOLIA,
};

export const abi = JSON.parse(fs.readFileSync(paths.abi, "utf8")).abi;

/** Returns the deployed contract info, or null if the contract has not been deployed yet. */
export function loadDeployment() {
  if (!fs.existsSync(paths.deployment)) return null;
  const data = JSON.parse(fs.readFileSync(paths.deployment, "utf8"));
  return { ...data, address: getAddress(data.address) };
}

export function saveDeployment(deployment) {
  fs.mkdirSync(path.dirname(paths.deployment), { recursive: true });
  fs.writeFileSync(paths.deployment, JSON.stringify(deployment, null, 2) + "\n");
}
