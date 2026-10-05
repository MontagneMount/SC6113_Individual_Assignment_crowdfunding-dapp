// Developer tool: deploy Crowdfunding.sol to Sepolia with MetaMask, then tell the
// local server the new address (it checks the transaction on-chain itself).
import { ContractFactory } from "/vendor/ethers/ethers.min.js";
import { api, getConfig } from "../api.js";
import { explainError } from "../contract.js";
import { addressUrl, ethLabel, shortAddress } from "../format.js";
import { initLayout } from "../layout.js";
import { $, el, setBusy, txTracker } from "../ui.js";
import { getSigner } from "../wallet.js";

const root = $("#deploy-root");

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
  const current = config.contractAddress
    ? el(
        "div",
        { class: "callout callout-warning" },
        el("p", {}, "A contract is already deployed: ", el("a", { class: "address", href: addressUrl(config.contractAddress), target: "_blank", rel: "noopener" }, config.contractAddress)),
        el("p", {}, "Deploying again creates a brand-new, empty contract and the site will switch to it. Only do this if the contract code changed."),
      )
    : el("p", { class: "callout" }, "No contract has been deployed yet.");

  const status = el("div", { class: "stack" });
  const button = el("button", { class: "btn btn-primary btn-block", type: "button" }, "Deploy with MetaMask");
  button.addEventListener("click", () => deploy(artifact, button, status));

  root.replaceChildren(
    current,
    el("p", { class: "muted small" }, "Use the account that should pay for the deployment (it needs a little Sepolia ETH for gas). The deployer gets no special rights in the contract."),
    button,
    status,
  );
}

async function deploy(artifact, button, status) {
  setBusy(button, true, "Waiting for MetaMask…");
  status.replaceChildren();
  let tracker = null;
  try {
    const signer = await getSigner();
    const balance = await signer.provider.getBalance(signer.address);
    status.append(el("p", { class: "small muted" }, `Deploying from ${shortAddress(signer.address)} (balance ${ethLabel(balance)})`));

    tracker = txTracker("Deploy Crowdfunding contract");
    const factory = new ContractFactory(artifact.abi, artifact.bytecode, signer);
    const contract = await factory.deploy();
    const tx = contract.deploymentTransaction();
    tracker.submitted(tx.hash);
    const receipt = await tx.wait();
    tracker.confirmed(receipt.blockNumber);

    const deployment = await api.saveDeployment(tx.hash);
    status.append(
      el(
        "div",
        { class: "callout callout-success stack" },
        el("p", {}, "Deployed and saved to deployments/sepolia.json. The site now uses this contract."),
        el("a", { class: "address", href: addressUrl(deployment.address), target: "_blank", rel: "noopener" }, deployment.address),
        el("a", { class: "btn btn-primary", href: "/" }, "Open the site"),
      ),
    );
    button.hidden = true;
  } catch (err) {
    const message = await explainError(err);
    if (tracker) tracker.failed(message);
    status.append(el("p", { class: "callout callout-danger" }, message));
    setBusy(button, false);
  }
}

main();
