// Talking to the Crowdfunding contract: reads, transactions, signed details and
// turning low-level errors into messages people can understand.
import { Contract, Interface, JsonRpcProvider } from "/vendor/ethers/ethers.min.js";
import { api, getConfig } from "./api.js";
import { buildDetailsMessage, normalizeDescription } from "./shared/constants.js";
import { txTracker } from "./ui.js";
import { getSigner, WalletMissingError } from "./wallet.js";

/** Status values returned by the contract's `getStatus` / `getCampaign`. */
export const CHAIN_STATUS = ["active", "successful", "failed", "withdrawn"];

const FRIENDLY_ERRORS = {
  CampaignNotFound: "This campaign does not exist.",
  InvalidTitle: "The title must be between 1 and 80 characters.",
  InvalidGoal: "The funding goal must be greater than 0.",
  InvalidDeadline: "The deadline must be between 1 minute and 90 days from now.",
  ZeroContribution: "Please enter an amount greater than 0.",
  CreatorCannotContribute: "Creators can't back their own campaign.",
  CampaignEnded: "This campaign has ended and no longer accepts contributions.",
  CampaignStillActive: "The campaign is still running. This is only possible after the deadline.",
  NotCreator: "Only the campaign creator can withdraw the funds.",
  GoalNotReached: "The goal was not reached, so the funds can't be withdrawn. Backers can claim refunds instead.",
  GoalReached: "The goal was reached, so refunds are not available.",
  AlreadyWithdrawn: "The funds have already been withdrawn.",
  NothingToRefund: "You have nothing to refund here (already refunded, or you never contributed).",
  TransferFailed: "The ETH transfer failed.",
  ReentrancyGuardReentrantCall: "This call was blocked by the re-entrancy guard.",
  SafeCastOverflowedUintDowncast: "The amount is too large.",
};

let readContractPromise = null;

/** Read-only contract on a public Sepolia node: works without MetaMask and checks our backend independently. */
export function getReadContract() {
  readContractPromise ??= getConfig().then((config) => {
    if (!config.contractAddress) throw new Error("The smart contract has not been deployed yet.");
    const provider = new JsonRpcProvider(config.chain.rpcUrl, config.chain.chainId, { staticNetwork: true });
    return new Contract(config.contractAddress, config.abi, provider);
  });
  return readContractPromise;
}

/** Contract connected to the user's MetaMask account, for sending transactions. */
export async function getWriteContract() {
  const config = await getConfig();
  if (!config.contractAddress) throw new Error("The smart contract has not been deployed yet.");
  const signer = await getSigner();
  return new Contract(config.contractAddress, config.abi, signer);
}

/**
 * Sends a transaction and shows its progress. `send` should start the transaction,
 * e.g. () => contract.contribute(id, { value }).
 */
export async function runTransaction(label, send) {
  const tracker = txTracker(label);
  try {
    const tx = await send();
    tracker.submitted(tx.hash);
    const receipt = await tx.wait();
    tracker.confirmed(receipt.blockNumber);
    await api.sync().catch(() => {}); // let the backend record the new event straight away
    return receipt;
  } catch (err) {
    tracker.failed(await explainError(err));
    throw err;
  }
}

/** Signs the campaign details with MetaMask (free, no gas) and uploads them. */
export async function saveCampaignDetails({ campaignId, category, description, file }) {
  const config = await getConfig();
  const signer = await getSigner();
  const text = normalizeDescription(description);
  const issuedAt = new Date().toISOString();

  const message = buildDetailsMessage({
    campaignId: Number(campaignId),
    contractAddress: config.contractAddress,
    chainId: config.chain.chainId,
    category,
    descriptionSha256: await sha256Hex(new TextEncoder().encode(text)),
    imageSha256: file ? await sha256Hex(await file.arrayBuffer()) : null,
    issuedAt,
  });
  const signature = await signer.signMessage(message);

  const form = new FormData();
  form.append("category", category);
  form.append("description", text);
  form.append("issuedAt", issuedAt);
  form.append("signature", signature);
  if (file) form.append("image", file);
  return api.saveDetails(campaignId, form);
}

async function sha256Hex(data) {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Turns wallet, network and contract errors into a short message. */
export async function explainError(err) {
  if (err instanceof WalletMissingError) return err.message;
  if (err?.code === "ACTION_REJECTED" || err?.code === 4001) return "You rejected the request in MetaMask.";
  if (err?.code === -32002) return "MetaMask is already waiting for you. Open MetaMask to continue.";
  if (err?.code === "INSUFFICIENT_FUNDS") return "Not enough Sepolia ETH to pay for this amount plus gas.";

  const errorName = await revertName(err);
  if (errorName) return FRIENDLY_ERRORS[errorName] ?? `The contract rejected this transaction (${errorName}).`;

  if (err?.status) return err.message; // message from our backend
  return err?.shortMessage ?? err?.message ?? "Something went wrong. Please try again.";
}

async function revertName(err) {
  if (err?.revert?.name) return err.revert.name;
  const { abi } = await getConfig();
  const contractInterface = new Interface(abi);
  for (const data of findHexData(err)) {
    try {
      const parsed = contractInterface.parseError(data);
      if (parsed) return parsed.name;
    } catch {
      // not one of our errors
    }
  }
  return null;
}

// MetaMask and ethers nest the revert data differently, so look in the usual places.
function findHexData(value, depth = 0, found = []) {
  if (!value || depth > 5) return found;
  if (typeof value === "string") {
    if (/^0x[0-9a-fA-F]{8,}$/.test(value)) found.push(value);
    return found;
  }
  if (typeof value === "object") {
    for (const key of ["data", "error", "info", "cause"]) findHexData(value[key], depth + 1, found);
  }
  return found;
}
