// Header, mobile bottom navigation and the wallet button shared by every page.
import { explainError } from "./contract.js";
import { shortAddress } from "./format.js";
import { $, el, toast } from "./ui.js";
import {
  connectWallet,
  getAccount,
  getEthereum,
  isMobileDevice,
  isOnSepolia,
  metaMaskDeepLink,
  switchToSepolia,
  watchWallet,
} from "./wallet.js";

const NAV = [
  { key: "explore", href: "/", label: "Explore", short: "Explore", icon: "🔎" },
  { key: "create", href: "/create.html", label: "Start a campaign", short: "Start", icon: "➕" },
  { key: "me", href: "/me.html", label: "My activity", short: "Mine", icon: "👤" },
];

let currentAccount = null;
const listeners = new Set();

export const getCurrentAccount = () => currentAccount;

/** Run `callback(account)` whenever the user connects, disconnects or switches account. */
export function onAccountChange(callback) {
  listeners.add(callback);
}

export async function initLayout(activeKey) {
  renderHeader(activeKey);
  renderBottomNav(activeKey);
  renderMobileWalletBanner();

  currentAccount = await getAccount().catch(() => null);
  await renderWalletButton();

  watchWallet(async (account) => {
    await setAccount(account);
  });
  return currentAccount;
}

/** Asks MetaMask to connect (used by "Connect wallet" buttons on pages too). */
export async function requestConnection() {
  try {
    const account = await connectWallet();
    await setAccount(account);
    return account;
  } catch (err) {
    toast(await explainError(err), "error");
    return null;
  }
}

async function setAccount(account) {
  currentAccount = account;
  await renderWalletButton();
  for (const listener of listeners) listener(account);
}

function renderHeader(activeKey) {
  const header = $("#site-header");
  header.replaceChildren(
    el(
      "div",
      { class: "header-inner" },
      el("a", { class: "brand", href: "/" }, el("span", { class: "brand-mark", "aria-hidden": "true" }, "C"), "CampusFund"),
      el(
        "nav",
        { class: "header-nav", "aria-label": "Main" },
        NAV.map((item) =>
          el("a", { href: item.href, class: item.key === activeKey ? "active" : null, "aria-current": item.key === activeKey ? "page" : null }, item.label),
        ),
      ),
      el("div", { class: "wallet-slot", id: "wallet-slot" }),
    ),
  );
}

function renderBottomNav(activeKey) {
  const nav = $("#bottom-nav");
  if (!nav) return;
  nav.replaceChildren(
    ...NAV.map((item) =>
      el(
        "a",
        { href: item.href, class: item.key === activeKey ? "active" : null, "aria-current": item.key === activeKey ? "page" : null },
        el("span", { class: "nav-icon", "aria-hidden": "true" }, item.icon),
        item.short,
      ),
    ),
  );
}

// Phone browsers like Safari or Chrome have no MetaMask extension, so offer the MetaMask app.
function renderMobileWalletBanner() {
  if (getEthereum() || !isMobileDevice()) return;
  const main = $("main");
  main?.prepend(
    el(
      "div",
      { class: "wallet-banner" },
      el("span", {}, "To back or create campaigns on your phone, open this page in the MetaMask app."),
      el("a", { class: "btn btn-warning", href: metaMaskDeepLink() }, "Open in MetaMask app"),
    ),
  );
}

async function renderWalletButton() {
  const slot = $("#wallet-slot");
  if (!slot) return;

  if (!getEthereum()) {
    slot.replaceChildren(
      isMobileDevice()
        ? el("a", { class: "btn btn-primary btn-sm btn-pill", href: metaMaskDeepLink() }, "Open in MetaMask")
        : el("a", { class: "btn btn-secondary btn-sm btn-pill", href: "https://metamask.io/download/", target: "_blank", rel: "noopener" }, "Install MetaMask"),
    );
    return;
  }

  if (!currentAccount) {
    slot.replaceChildren(
      el("button", { class: "btn btn-primary btn-sm btn-pill", type: "button", onclick: requestConnection }, "Connect wallet"),
    );
    return;
  }

  if (!(await isOnSepolia())) {
    const button = el("button", { class: "btn btn-warning btn-sm btn-pill", type: "button" }, "Switch to Sepolia");
    button.addEventListener("click", async () => {
      try {
        await switchToSepolia();
      } catch (err) {
        toast(await explainError(err), "error");
      }
    });
    slot.replaceChildren(button);
    return;
  }

  slot.replaceChildren(
    el(
      "a",
      { class: "wallet-pill", href: "/me.html", title: currentAccount },
      el("span", { class: "wallet-dot", "aria-hidden": "true" }),
      el("span", { class: "address" }, shortAddress(currentAccount)),
    ),
  );
}
