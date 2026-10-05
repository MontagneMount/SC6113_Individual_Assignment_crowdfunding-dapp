// Developer-only routes for deploying the contract with MetaMask from /deploy.html.
// Mounted only when NODE_ENV is not "production", and only answer this computer.
import fs from "node:fs";
import express from "express";
import { getAddress } from "ethers";
import { config, paths, saveDeployment } from "../config.js";
import { provider } from "../chain.js";
import { InputError } from "../details.js";
import { activateDeployment } from "../state.js";

const LOCAL_IPS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

export function createDevRouter() {
  const router = express.Router();

  router.use((req, res, next) => {
    if (LOCAL_IPS.has(req.ip)) return next();
    res.status(403).json({ error: "Developer tools are only available on the developer's computer." });
  });

  router.get("/artifact", (req, res) => {
    const { abi, bytecode } = readArtifact();
    res.json({ abi, bytecode });
  });

  // Called by /deploy.html after MetaMask deployed the contract. The server checks the
  // transaction on Sepolia itself before saving deployments/sepolia.json.
  router.post("/deployment", async (req, res) => {
    const txHash = String(req.body?.txHash ?? "");
    if (!TX_HASH.test(txHash)) throw new InputError("Invalid transaction hash.");

    const receipt = await waitForReceipt(txHash);
    if (!receipt || receipt.status !== 1 || !receipt.contractAddress) {
      throw new InputError("That transaction did not deploy a contract.");
    }

    const code = await provider.getCode(receipt.contractAddress);
    if (code.toLowerCase() !== readArtifact().deployedBytecode.toLowerCase()) {
      throw new InputError("The deployed code does not match the compiled Crowdfunding contract.");
    }

    const deployment = {
      network: "sepolia",
      chainId: config.chain.chainId,
      address: getAddress(receipt.contractAddress),
      deployBlock: receipt.blockNumber,
      txHash,
      deployer: getAddress(receipt.from),
      deployedAt: new Date().toISOString(),
    };
    saveDeployment(deployment);
    await activateDeployment(deployment);
    res.json(deployment);
  });

  return router;
}

function readArtifact() {
  if (!fs.existsSync(paths.artifact)) {
    throw new InputError("The contract is not compiled yet. Run `npm run compile` first.", 404);
  }
  return JSON.parse(fs.readFileSync(paths.artifact, "utf8"));
}

// The public RPC node can be a block behind MetaMask's node, so retry for a short while.
async function waitForReceipt(txHash, attempts = 10) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (receipt) return receipt;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  return null;
}
