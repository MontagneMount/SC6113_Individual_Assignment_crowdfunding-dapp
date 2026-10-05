import { parseEther } from "/vendor/ethers/ethers.min.js";
import { api, getConfig } from "../api.js";
import { CHAIN_STATUS, explainError, getReadContract, getWriteContract, runTransaction, saveCampaignDetails } from "../contract.js";
import { checkImage, field, showError, wireImagePreview } from "../forms.js";
import { addressUrl, ethLabel, formatDateTime, percent, sameAddress, shortAddress, timeLeft, txUrl } from "../format.js";
import { getCurrentAccount, initLayout, onAccountChange, requestConnection } from "../layout.js";
import { CATEGORIES, LIMITS } from "../shared/constants.js";
import { $, cover, el, emptyState, loading, progressBar, setBusy, statusBadge, toast } from "../ui.js";
import { getEthereum, isMobileDevice, metaMaskDeepLink } from "../wallet.js";

const root = $("#campaign");
const campaignId = new URLSearchParams(location.search).get("id");

let config = null;
let view = null; // backend data + numbers read straight from the contract
let countdown = null;
let editing = false;
let retriedSync = false;

const EVENT_TEXT = {
  CampaignCreated: (event) => ["🚀", `Campaign created with a goal of ${ethLabel(event.amountWei)}`],
  Contributed: (event) => ["💸", `${shortAddress(event.account)} backed ${ethLabel(event.amountWei)}`],
  FundsWithdrawn: (event) => ["🏦", `The creator withdrew ${ethLabel(event.amountWei)}`],
  Refunded: (event) => ["↩️", `${shortAddress(event.account)} was refunded ${ethLabel(event.amountWei)}`],
};

async function main() {
  await initLayout();
  if (!/^[1-9]\d*$/.test(campaignId ?? "")) {
    root.replaceChildren(emptyState("🤔", "Campaign not found", "This link doesn't point to a campaign.", homeButton()));
    return;
  }
  config = await getConfig().catch(() => null);
  root.replaceChildren(loading("Loading campaign…"));
  await load();
  onAccountChange(() => load());

  if (new URLSearchParams(location.search).has("created")) {
    toast("Your campaign is live! Share this page so people can back it.", "success");
    history.replaceState(null, "", `/campaign.html?id=${campaignId}`);
  }
}

const homeButton = () => el("a", { class: "btn btn-secondary", href: "/" }, "Back to all campaigns");

async function load() {
  try {
    const [data, chain] = await Promise.all([api.campaign(campaignId), readChain()]);
    const account = getCurrentAccount();
    let myContribution = 0n;
    if (account && chain) myContribution = await chain.contract.contributions(campaignId, account);
    else if (account) myContribution = myBalanceFromHistory(data.backers, account);

    view = { ...data, chain: chain?.campaign ?? null, myContribution };
    render();
  } catch (err) {
    const title = err.status === 404 ? "Campaign not found" : "Couldn't load this campaign";
    root.replaceChildren(emptyState("⚠️", title, err.message, homeButton()));
  }
}

/** Reads the campaign directly from the smart contract (independent of our backend). */
async function readChain() {
  try {
    const contract = await getReadContract();
    const [campaign] = await contract.getCampaign(campaignId);
    return { contract, campaign };
  } catch {
    return null; // blockchain node unreachable: fall back to the backend's copy
  }
}

function myBalanceFromHistory(backers, account) {
  const mine = backers.find((backer) => sameAddress(backer.address, account));
  return mine ? BigInt(mine.contributedWei) - BigInt(mine.refundedWei) : 0n;
}

/** Prefer numbers read from the contract; fall back to the backend's cached copy. */
function numbers() {
  const { campaign, chain } = view;
  return {
    raised: chain ? chain.totalRaised : BigInt(campaign.totalRaisedWei),
    goal: chain ? chain.goal : BigInt(campaign.goalWei),
    refunded: chain ? chain.totalRefunded : BigInt(campaign.totalRefundedWei),
    withdrawn: chain ? chain.withdrawn : campaign.withdrawn,
    backers: chain ? Number(chain.backerCount) : campaign.backerCount,
    deadline: campaign.deadline,
  };
}

// Same rules as the contract, using the current time so the page updates at the deadline.
function statusFrom(n) {
  if (Date.now() / 1000 < n.deadline) return "active";
  if (n.raised < n.goal) return "failed";
  return n.withdrawn ? "withdrawn" : "successful";
}

function render() {
  clearInterval(countdown);
  const { campaign } = view;
  const n = numbers();
  const status = statusFrom(n);
  const account = getCurrentAccount();
  const isCreator = sameAddress(account, campaign.creator);
  const progress = n.goal > 0n ? Number((n.raised * 10_000n) / n.goal) / 10_000 : 0;
  document.title = `${campaign.title} · CampusFund`;

  const timeText = el("dd", {}, timeLeft(n.deadline).text);
  countdown = setInterval(() => {
    const time = timeLeft(n.deadline);
    timeText.textContent = time.text;
    if (time.ended && status === "active") render(); // the deadline just passed
  }, 1000);

  const header = el(
    "div",
    { class: "campaign-header stack" },
    cover(campaign, "hero"),
    el("div", { class: "row" }, statusBadge(status), campaign.category ? el("span", { class: "tag" }, campaign.category) : null),
    el("h1", {}, campaign.title),
    el(
      "p",
      { class: "creator-line" },
      "Created by ",
      el("a", { class: "address", href: addressUrl(campaign.creator), target: "_blank", rel: "noopener" }, shortAddress(campaign.creator)),
      isCreator ? " (you)" : "",
      campaign.createdAt ? ` · ${formatDateTime(campaign.createdAt)}` : "",
    ),
  );

  const side = el(
    "aside",
    { class: "campaign-side stack" },
    el(
      "div",
      { class: "card card-pad stack" },
      el(
        "div",
        {},
        el("div", { class: "raised" }, ethLabel(n.raised)),
        el("div", { class: "muted" }, `raised of ${ethLabel(n.goal)} goal · ${percent(progress)}`),
      ),
      progressBar(progress),
      el(
        "dl",
        { class: "kv" },
        el("dt", {}, "Backers"),
        el("dd", {}, n.backers),
        el("dt", {}, "Time"),
        timeText,
        el("dt", {}, "Deadline"),
        el("dd", {}, formatDateTime(n.deadline)),
      ),
      verificationBadge(),
    ),
    actionCard(status, n, isCreator, account),
  );

  const body = el(
    "div",
    { class: "campaign-body stack" },
    aboutCard(isCreator),
    transparencyCard(n),
    backersCard(account),
    activityCard(),
  );

  root.replaceChildren(el("div", { class: "campaign-layout" }, header, side, body));
}

/** Compares the contract's numbers with our database copy. */
function verificationBadge() {
  const { campaign, chain } = view;
  if (!chain) return el("span", { class: "badge badge-syncing" }, "⚠ Showing saved data: couldn't reach the blockchain");

  const matches =
    chain.totalRaised === BigInt(campaign.totalRaisedWei) &&
    chain.totalRefunded === BigInt(campaign.totalRefundedWei) &&
    chain.withdrawn === campaign.withdrawn;
  if (matches) {
    return el(
      "span",
      { class: "badge badge-verified", title: "Read directly from the smart contract and matches our database." },
      "✓ Verified on-chain",
    );
  }
  if (!retriedSync) {
    retriedSync = true;
    setTimeout(() => api.sync().catch(() => {}).then(load), 4_000);
  }
  return el("span", { class: "badge badge-syncing", title: "Our database is catching up with the blockchain." }, "⟳ Syncing with the blockchain…");
}

function actionCard(status, n, isCreator, account) {
  const card = el("div", { class: "card card-pad stack" });
  const info = (text) => el("p", { class: "callout" }, text);

  if (!getEthereum()) {
    card.append(
      el("p", { class: "muted" }, "You need a wallet to take part."),
      isMobileDevice()
        ? el("a", { class: "btn btn-primary btn-block", href: metaMaskDeepLink() }, "Open in MetaMask app")
        : el("a", { class: "btn btn-secondary btn-block", href: "https://metamask.io/download/", target: "_blank", rel: "noopener" }, "Install MetaMask"),
    );
  }

  if (status === "active") {
    if (isCreator) {
      card.append(
        info("You created this campaign. Contributions stay in the contract until the deadline. You can withdraw only if the goal is reached."),
      );
    } else if (getEthereum()) {
      card.append(contributeForm(account));
    }
  } else if (status === "successful") {
    if (isCreator) {
      card.append(
        info(`🎉 Goal reached! You can now withdraw ${ethLabel(n.raised)}.`),
        actionButton("Withdraw funds", "btn-success", () =>
          runTransaction("Withdraw funds", async () => (await getWriteContract()).withdraw(campaignId)),
        ),
      );
    } else {
      card.append(info("🎉 This campaign reached its goal. The creator can now withdraw the funds."));
    }
  } else if (status === "withdrawn") {
    card.append(info(`✅ The creator has withdrawn ${ethLabel(n.raised)}.`));
  } else if (view.myContribution > 0n) {
    card.append(
      info(`This campaign didn't reach its goal. You can take back your ${ethLabel(view.myContribution)}.`),
      actionButton("Claim refund", "btn-primary", () =>
        runTransaction("Claim refund", async () => (await getWriteContract()).refund(campaignId)),
      ),
    );
  } else {
    card.append(info("This campaign didn't reach its goal. Everyone who backed it can claim a refund."));
  }

  if (view.myContribution > 0n && status !== "failed") {
    card.append(el("p", { class: "small muted" }, `You backed this campaign with ${ethLabel(view.myContribution)}.`));
  }
  return card;
}

function actionButton(label, style, action) {
  const button = el("button", { class: `btn ${style} btn-block`, type: "button" }, label);
  button.addEventListener("click", async () => {
    setBusy(button, true, "Waiting for MetaMask…");
    try {
      await action();
      await load();
    } catch {
      // the transaction tracker already explains what went wrong
    } finally {
      if (button.isConnected) setBusy(button, false);
    }
  });
  return button;
}

function contributeForm(account) {
  if (!account) {
    return el(
      "div",
      { class: "stack" },
      el("p", { class: "muted" }, "Connect your wallet to back this campaign."),
      el("button", { class: "btn btn-primary btn-block", type: "button", onclick: requestConnection }, "Connect wallet"),
    );
  }

  const input = el("input", { class: "input", id: "amount", type: "text", inputmode: "decimal", autocomplete: "off", placeholder: "0.01" });
  const error = el("p", { class: "field-error", hidden: true });
  const button = el("button", { class: "btn btn-primary btn-block", type: "submit" }, "Back this campaign");
  const chips = ["0.001", "0.005", "0.01"].map((amount) =>
    el("button", { class: "chip", type: "button", onclick: () => (input.value = amount) }, `${amount} ETH`),
  );

  const form = el(
    "form",
    { class: "stack", novalidate: true },
    el("label", { class: "label", for: "amount" }, "Amount (ETH)"),
    input,
    el("div", { class: "chips" }, chips),
    error,
    button,
    el("p", { class: "small muted" }, "Your ETH is held by the smart contract. If the goal isn't reached by the deadline, you can claim it back."),
  );

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    let value = 0n;
    try {
      value = parseEther(input.value.trim());
    } catch {
      // handled below
    }
    if (value <= 0n) {
      showError(error, "Enter an amount greater than 0, for example 0.01.");
      input.classList.add("invalid");
      return;
    }
    showError(error, null);
    input.classList.remove("invalid");

    setBusy(button, true, "Waiting for MetaMask…");
    try {
      await runTransaction(`Back with ${input.value.trim()} ETH`, async () =>
        (await getWriteContract()).contribute(campaignId, { value }),
      );
      await load();
    } catch {
      // the transaction tracker already explains what went wrong
    } finally {
      if (button.isConnected) setBusy(button, false);
    }
  });
  return form;
}

function aboutCard(isCreator) {
  const { details } = view;
  const title = el("div", { class: "section-title" }, el("h2", {}, "About this campaign"));
  if (isCreator && !editing) {
    title.append(
      el("button", { class: "btn btn-secondary btn-sm", type: "button", onclick: () => ((editing = true), render()) }, details ? "Edit details" : "Add details"),
    );
  }

  const card = el("section", { class: "card card-pad" }, title);
  if (editing && isCreator) {
    card.append(detailsForm());
  } else if (details) {
    card.append(
      el("p", { class: "description" }, details.description),
      el("p", { class: "small muted" }, `Signed by the creator's wallet · updated ${new Date(details.updatedAt).toLocaleString("en-GB")}`),
    );
  } else {
    card.append(
      el("p", { class: "muted" }, isCreator ? "Add a description and a cover image so backers know what you're building." : "The creator hasn't added a description yet."),
    );
  }
  return card;
}

function detailsForm() {
  const current = view.details ?? {};
  const category = el(
    "select",
    { class: "input", id: "details-category" },
    el("option", { value: "" }, "Choose a category"),
    CATEGORIES.map((name) => el("option", { value: name, selected: name === current.category }, name)),
  );
  const description = el("textarea", { class: "input", id: "details-description", maxlength: LIMITS.descriptionMaxChars }, current.description ?? "");
  const counter = el("span", { class: "hint" });
  const updateCounter = () => (counter.textContent = `${description.value.length} / ${LIMITS.descriptionMaxChars}`);
  description.addEventListener("input", updateCounter);
  updateCounter();

  const image = el("input", { class: "input", id: "details-image", type: "file", accept: LIMITS.imageTypes.join(",") });
  const preview = el("img", { class: "image-preview", alt: "Cover preview", hidden: true });
  wireImagePreview(image, preview);

  const error = el("p", { class: "field-error", hidden: true });
  const save = el("button", { class: "btn btn-primary", type: "submit" }, "Sign & save");
  const cancel = el("button", { class: "btn btn-secondary", type: "button", onclick: () => ((editing = false), render()) }, "Cancel");

  const form = el(
    "form",
    { novalidate: true },
    field("Category", category),
    field("Description", description, { counter }),
    field("Cover image (optional)", image, {
      hint: "PNG, JPEG or WebP, up to 2 MB. Leave empty to keep the current image.",
      extra: [preview],
    }),
    el("p", { class: "callout mb" }, "MetaMask will ask you to sign a message. Signing is free (no gas) and proves you are the creator."),
    error,
    el("div", { class: "row" }, save, cancel),
  );

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const problem = !category.value
      ? "Please choose a category."
      : !description.value.trim()
        ? "Please write a description."
        : checkImage(image.files[0]);
    if (problem) return showError(error, problem);
    showError(error, null);

    setBusy(save, true, "Waiting for your signature…");
    try {
      await saveCampaignDetails({ campaignId, category: category.value, description: description.value, file: image.files[0] ?? null });
      toast("Campaign details saved.", "success");
      editing = false;
      await load();
    } catch (err) {
      showError(error, await explainError(err));
      if (save.isConnected) setBusy(save, false);
    }
  });
  return form;
}

function transparencyCard(n) {
  const withdrawnAmount = n.withdrawn ? n.raised : 0n;
  const held = n.raised - withdrawnAmount - n.refunded;
  return el(
    "section",
    { class: "card card-pad stack" },
    el("h2", {}, "Fund transparency"),
    el("p", { class: "small muted" }, "These numbers come from the smart contract, and anyone can check them on Etherscan."),
    el(
      "dl",
      { class: "kv" },
      el("dt", {}, "Total raised"),
      el("dd", {}, ethLabel(n.raised)),
      el("dt", {}, "Withdrawn by the creator"),
      el("dd", {}, ethLabel(withdrawnAmount)),
      el("dt", {}, "Refunded to backers"),
      el("dd", {}, ethLabel(n.refunded)),
      el("dt", {}, "Still held by the contract"),
      el("dd", {}, ethLabel(held)),
    ),
    config?.contractAddress
      ? el("a", { class: "small", href: addressUrl(config.contractAddress), target: "_blank", rel: "noopener" }, "View the smart contract on Etherscan ↗")
      : null,
  );
}

function backersCard(account) {
  const { backers } = view;
  const card = el(
    "section",
    { class: "card card-pad" },
    el("div", { class: "section-title" }, el("h2", {}, "Backers"), el("span", { class: "muted small" }, backers.length)),
  );
  if (backers.length === 0) {
    card.append(el("p", { class: "muted" }, "No backers yet."));
    return card;
  }
  card.append(
    el(
      "ul",
      { class: "list" },
      backers.map((backer) =>
        el(
          "li",
          { class: "list-item" },
          el(
            "div",
            { class: "list-text" },
            el("a", { class: "address", href: addressUrl(backer.address), target: "_blank", rel: "noopener" }, shortAddress(backer.address)),
            sameAddress(backer.address, account) ? el("span", { class: "muted" }, " (you)") : null,
            el("div", { class: "small muted" }, `${backer.contributions} contribution${backer.contributions === 1 ? "" : "s"}`),
          ),
          el(
            "div",
            { class: "list-side" },
            el("strong", {}, ethLabel(backer.contributedWei)),
            BigInt(backer.refundedWei) > 0n ? el("div", { class: "small muted" }, `refunded ${ethLabel(backer.refundedWei)}`) : null,
          ),
        ),
      ),
    ),
  );
  return card;
}

function activityCard() {
  const events = [...view.events].reverse();
  const card = el("section", { class: "card card-pad" }, el("h2", {}, "Activity"));
  if (events.length === 0) {
    card.append(el("p", { class: "muted" }, "No activity yet."));
    return card;
  }
  card.append(
    el(
      "ul",
      { class: "list" },
      events.map((event) => {
        const [icon, text] = EVENT_TEXT[event.name]?.(event) ?? ["•", event.name];
        return el(
          "li",
          { class: "list-item" },
          el(
            "div",
            { class: "list-main" },
            el("span", { class: "timeline-icon", "aria-hidden": "true" }, icon),
            el(
              "div",
              { class: "list-text" },
              el("div", {}, text),
              el("div", { class: "small muted" }, event.timestamp ? formatDateTime(event.timestamp) : `Block ${event.blockNumber}`),
            ),
          ),
          el("a", { class: "small list-side", href: txUrl(event.txHash), target: "_blank", rel: "noopener" }, "Tx ↗"),
        );
      }),
    ),
  );
  return card;
}

main();
