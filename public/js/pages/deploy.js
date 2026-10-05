// Developer tool: deploy Crowdfunding.sol to Sepolia with MetaMask, then tell the
// local server the new address (it checks the transaction on-chain itself).
import { ContractFactory } from "/vendor/ethers/ethers.min.js";
import { api, getConfig } from "../api.js";
import { explainError } from "../contract.js";
import { addressUrl, ethLabel, shortAddress, txUrl } from "../format.js";
import { initLayout } from "../layout.js";
import { $, el, setBusy, txTracker } from "../ui.js";
import { getSigner } from "../wallet.js";

const root = $("#deploy-root");

// Remember the deployment transaction until the server has saved it, so a failed
// save can be retried later instead of paying for a second deployment.
const PENDING_KEY = "campusfund:pendingDeployTx";
const pendingTx = {
  get: () => {
    try {
      return localStorage.getItem(PENDING_KEY);
    } catch {
      return null;
    }
  },
  set: (hash) => {
    try {
      localStorage.setItem(PENDING_KEY, hash);
    } catch {
      // private mode: the retry button below still works for this visit
    }
  },
  clear: () => {
    try {
      localStorage.removeItem(PENDING_KEY);
    } catch {
      // nothing to clear
    }
  },
};

async function main() {
  await initLayout(null);

  let artifact;
  try {
    artifact = await api.devArtifact();
  } catch (err) {
    const text = err.status === 404 && err.message === "Not found." ? "Developer tools are turned off on this server." : err.message;
    root.replaceChildren(el("p", {}, text));
    return;
  }

  const config = await getConfig();
  const status = el("div", { class: "stack" });
  const button = el("button", { class: "btn btn-primary btn-block", type: "button" }, "Deploy with MetaMask");
  button.addEventListener("click", () => deploy(artifact, button, status));

  root.replaceChildren(
    currentDeployment(config),
    el("p", { class: "muted small" }, "Use the account that should pay for the deployment (it needs a little Sepolia ETH for gas). The deployer gets no special rights in the contract."),
    button,
    status,
  );

  const unsaved = pendingTx.get();
  if (unsaved && config.contractAddress) pendingTx.clear();
  if (unsaved && !config.contractAddress) {
    const finish = el("button", { class: "btn btn-primary", type: "button" }, "Finish saving it");
    const box = el(
      "div",
      { class: "callout callout-warning stack" },
      el("p", {}, "An earlier deployment was sent but its address was never saved. You don't need to deploy again."),
      el("a", { class: "address small", href: txUrl(unsaved), target: "_blank", rel: "noopener" }, `Transaction ${shortAddress(unsaved)} ↗`),
      finish,
    );
    finish.addEventListener("click", () => {
      box.remove();
      button.hidden = true;
      finishSaving(unsaved, status);
    });
    status.append(box);
  }
}

function currentDeployment(config) {
  if (!config.contractAddress) return el("p", { class: "callout" }, "No contract has been deployed yet.");
  return el(
    "div",
    { class: "callout callout-warning" },
    el("p", {}, "A contract is already deployed: ", el("a", { class: "address", href: addressUrl(config.contractAddress), target: "_blank", rel: "noopener" }, config.contractAddress)),
    el("p", {}, "Deploying again creates a brand-new, empty contract and the site will switch to it. Only do this if the contract code changed."),
  );
}

async function deploy(artifact, button, status) {
  setBusy(button, true, "Waiting for MetaMask…");
  status.replaceChildren();
  let tracker = null;
  let txHash = null;

  try {
    const signer = await getSigner();
    const balance = await signer.provider.getBalance(signer.address);
    status.append(el("p", { class: "small muted" }, `Deploying from ${shortAddress(signer.address)} (balance ${ethLabel(balance)})`));

    tracker = txTracker("Deploy Crowdfunding contract");
    const factory = new ContractFactory(artifact.abi, artifact.bytecode, signer);
    const contract = await factory.deploy();
    const tx = contract.deploymentTransaction();
    txHash = tx.hash;
    pendingTx.set(txHash);
    tracker.submitted(txHash);
    const receipt = await tx.wait();
    tracker.confirmed(receipt.blockNumber);
  } catch (err) {
    const message = await explainError(err);
    tracker?.failed(message);
    status.append(el("p", { class: "callout callout-danger" }, message));
    if (!txHash) {
      setBusy(button, false);
      return;
    }
    // The transaction was sent, so it may still have gone through: let the server check.
  }

  button.hidden = true;
  await finishSaving(txHash, status);
}

async function finishSaving(txHash, status) {
  const note = el("p", { class: "small muted" }, "Checking the transaction and saving the new address…");
  status.append(note);
  try {
    const deployment = await saveWithRetry(txHash);
    pendingTx.clear();
    note.remove();
    status.append(
      el(
        "div",
        { class: "callout callout-success stack" },
        el("p", {}, "Deployed and saved to deployments/sepolia.json. The site now uses this contract."),
        el("a", { class: "address", href: addressUrl(deployment.address), target: "_blank", rel: "noopener" }, deployment.address),
        el("a", { class: "btn btn-primary", href: "/" }, "Open the site"),
      ),
    );
  } catch (err) {
    note.remove();
    const retry = el("button", { class: "btn btn-primary", type: "button" }, "Retry saving");
    const box = el(
      "div",
      { class: "callout callout-warning stack" },
      el("p", {}, `Saving the address failed: ${await explainError(err)}`),
      el("p", {}, "You don't need to deploy again. Make sure the server is running, then retry."),
      el("a", { class: "small", href: txUrl(txHash), target: "_blank", rel: "noopener" }, "View the transaction on Etherscan ↗"),
      retry,
    );
    retry.addEventListener("click", () => {
      box.remove();
      finishSaving(txHash, status);
    });
    status.append(box);
  }
}

// A network error (e.g. the dev server restarting) is retried; a real answer from the server is not.
async function saveWithRetry(txHash, attempts = 3) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await api.saveDeployment(txHash);
    } catch (err) {
      if (err.status || attempt >= attempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
}

main();
