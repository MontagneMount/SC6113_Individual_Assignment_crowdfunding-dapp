// MetaMask connection. Private keys never leave MetaMask: the site only asks it
// to sign, and the user approves every request in the MetaMask window.
import { BrowserProvider } from "/vendor/ethers/ethers.min.js";
import { SEPOLIA } from "./shared/constants.js";

export class WalletMissingError extends Error {
  constructor() {
    super("MetaMask was not found. Install the MetaMask extension, or open this site in the MetaMask app on your phone.");
  }
}

export function getEthereum() {
  const { ethereum } = window;
  if (!ethereum) return null;
  // If several wallet extensions are installed, prefer MetaMask.
  if (Array.isArray(ethereum.providers)) return ethereum.providers.find((p) => p.isMetaMask) ?? ethereum.providers[0];
  return ethereum;
}

export const isMobileDevice = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

/** Opens the current page inside the MetaMask mobile app's built-in browser. */
export const metaMaskDeepLink = () => `https://metamask.app.link/dapp/${location.host}${location.pathname}${location.search}`;

/** The connected account, without showing a MetaMask popup. */
export async function getAccount() {
  const ethereum = getEthereum();
  if (!ethereum) return null;
  const [account] = await ethereum.request({ method: "eth_accounts" });
  return account ?? null;
}

export async function connectWallet() {
  const ethereum = getEthereum();
  if (!ethereum) throw new WalletMissingError();
  const [account] = await ethereum.request({ method: "eth_requestAccounts" });
  return account ?? null;
}

export async function isOnSepolia() {
  const ethereum = getEthereum();
  if (!ethereum) return false;
  const chainId = await ethereum.request({ method: "eth_chainId" });
  return Number.parseInt(chainId, 16) === SEPOLIA.chainId;
}

export async function switchToSepolia() {
  const ethereum = getEthereum();
  if (!ethereum) throw new WalletMissingError();
  try {
    await ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: SEPOLIA.chainIdHex }] });
  } catch (err) {
    if (err.code !== 4902) throw err; // 4902 = MetaMask doesn't know Sepolia yet, so add it
    await ethereum.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: SEPOLIA.chainIdHex,
          chainName: SEPOLIA.name,
          nativeCurrency: SEPOLIA.currency,
          rpcUrls: [SEPOLIA.rpcUrl],
          blockExplorerUrls: [SEPOLIA.explorerUrl],
        },
      ],
    });
  }
}

/** Connects, makes sure MetaMask is on Sepolia, and returns an ethers signer. */
export async function getSigner() {
  await connectWallet();
  if (!(await isOnSepolia())) await switchToSepolia();
  return new BrowserProvider(getEthereum()).getSigner();
}

export function watchWallet(onAccountChange) {
  const ethereum = getEthereum();
  if (!ethereum?.on) return;
  ethereum.on("accountsChanged", (accounts) => onAccountChange(accounts[0] ?? null));
  ethereum.on("chainChanged", () => location.reload()); // simplest safe reaction, as MetaMask recommends
}
