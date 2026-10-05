import { formatEther } from "/vendor/ethers/ethers.min.js";
import { SEPOLIA } from "./shared/constants.js";

/** Wei (string or bigint) to a short ETH string, e.g. "0.0125". */
export function formatEth(wei, maxDecimals = 4) {
  const value = BigInt(wei);
  const [whole, fraction = ""] = formatEther(value).split(".");
  const trimmed = fraction.slice(0, maxDecimals).replace(/0+$/, "");
  const text = trimmed ? `${whole}.${trimmed}` : whole;
  if (text === "0" && value > 0n) return `<0.${"0".repeat(maxDecimals - 1)}1`;
  return text;
}

export const ethLabel = (wei, maxDecimals) => `${formatEth(wei, maxDecimals)} ETH`;

export const percent = (progress) => `${Math.floor(progress * 100)}%`;

export const shortAddress = (address) => (address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "");

export const txUrl = (hash) => `${SEPOLIA.explorerUrl}/tx/${hash}`;

export const addressUrl = (address) => `${SEPOLIA.explorerUrl}/address/${address}`;

export const sameAddress = (a, b) => Boolean(a && b) && a.toLowerCase() === b.toLowerCase();

export function formatDateTime(seconds) {
  return new Date(seconds * 1000).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function duration(totalSeconds) {
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** "2h 5m left" before the deadline, "Ended 3d 1h ago" after it. */
export function timeLeft(deadline, now = Date.now() / 1000) {
  const diff = Math.round(deadline - now);
  if (diff <= 0) return { ended: true, text: `Ended ${duration(-diff)} ago` };
  return { ended: false, text: `${duration(diff)} left` };
}
