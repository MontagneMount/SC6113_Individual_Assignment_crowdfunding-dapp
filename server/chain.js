import { Contract, Interface, JsonRpcProvider } from "ethers";
import { abi, config } from "./config.js";

export const contractInterface = new Interface(abi);

// staticNetwork: we know the chain, so skip the extra eth_chainId calls.
export const provider = new JsonRpcProvider(config.rpcUrl, config.chain.chainId, { staticNetwork: true });

export function getContract(address) {
  return new Contract(address, abi, provider);
}

export const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Same rules as Crowdfunding.sol `_statusOf`, applied to a cached campaign. */
export function statusOf(campaign, now = nowSeconds()) {
  if (now < campaign.deadline) return "active";
  if (BigInt(campaign.totalRaisedWei) < BigInt(campaign.goalWei)) return "failed";
  return campaign.withdrawn ? "withdrawn" : "successful";
}
