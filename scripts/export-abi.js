// Copies the contract ABI from Hardhat's build output into abi/, which the web
// server reads at runtime. This way the deployed server never needs Hardhat.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactPath = path.join(root, "artifacts", "contracts", "Crowdfunding.sol", "Crowdfunding.json");
const outputPath = path.join(root, "abi", "Crowdfunding.json");

const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
const output = { contractName: artifact.contractName, abi: artifact.abi };

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(output, null, 2) + "\n");
console.log(`Exported ABI to ${path.relative(root, outputPath)}`);
