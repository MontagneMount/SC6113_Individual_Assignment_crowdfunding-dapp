import { api, getConfig } from "../api.js";
import { getWriteContract, runTransaction } from "../contract.js";
import { ethLabel, percent } from "../format.js";
import { getCurrentAccount, initLayout, onAccountChange, requestConnection } from "../layout.js";
import { $, cover, el, emptyState, loading, progressBar, setBusy, statusBadge } from "../ui.js";
import { getEthereum, isMobileDevice, metaMaskDeepLink } from "../wallet.js";

const root = $("#me-root");

async function main() {
  await initLayout("me");
  onAccountChange(render);
  await render(getCurrentAccount());
}

async function render(account) {
  if (!getEthereum()) {
    const action = isMobileDevice()
      ? el("a", { class: "btn btn-primary", href: metaMaskDeepLink() }, "Open in MetaMask app")
      : el("a", { class: "btn btn-primary", href: "https://metamask.io/download/", target: "_blank", rel: "noopener" }, "Install MetaMask");
    root.replaceChildren(emptyState("👛", "No wallet found", "You need MetaMask to see your activity.", action));
    return;
  }
  if (!account) {
    root.replaceChildren(
      emptyState(
        "👛",
        "Connect your wallet",
        "See the campaigns you've backed or created.",
        el("button", { class: "btn btn-primary", type: "button", onclick: requestConnection }, "Connect wallet"),
      ),
    );
    return;
  }

  const config = await getConfig().catch(() => null);
  if (!config?.contractAddress) {
    root.replaceChildren(emptyState("🛠️", "Almost ready", "The smart contract hasn't been deployed yet."));
    return;
  }

  root.replaceChildren(loading("Loading your activity…"));
  try {
    const data = await api.user(account);
    if (account !== getCurrentAccount()) return; // the user switched accounts meanwhile
    root.replaceChildren(
      el("div", { class: "stack" }, summaryTiles(data.totals), attentionCard(data), backedCard(data.backed), createdCard(data.created)),
    );
  } catch (err) {
    root.replaceChildren(emptyState("⚠️", "Couldn't load your activity", err.message));
  }
}

function summaryTiles(totals) {
  const tile = (label, value) =>
    el("div", { class: "card stat" }, el("div", { class: "stat-label" }, label), el("div", { class: "stat-value" }, value));
  return el(
    "section",
    { class: "stats", "aria-label": "Summary" },
    tile("Total backed", ethLabel(totals.contributedWei)),
    tile("Refunded to you", ethLabel(totals.refundedWei)),
    tile("Campaigns created", totals.campaignsCreated),
    tile("Withdrawn as creator", ethLabel(totals.withdrawnWei)),
  );
}

/** Money waiting for the user: refunds to claim and funds to withdraw. */
function attentionCard(data) {
  const refunds = data.backed.filter((campaign) => campaign.canRefund);
  const withdrawals = data.created.filter((campaign) => campaign.canWithdraw);
  if (refunds.length === 0 && withdrawals.length === 0) return null;

  const items = [
    ...withdrawals.map((campaign) =>
      actionItem(campaign, `Goal reached: withdraw ${ethLabel(campaign.totalRaisedWei)}`, "Withdraw", "btn-success", () =>
        runTransaction("Withdraw funds", async () => (await getWriteContract()).withdraw(campaign.id)),
      ),
    ),
    ...refunds.map((campaign) => {
      const amount = BigInt(campaign.myContributedWei) - BigInt(campaign.myRefundedWei);
      return actionItem(campaign, `Not funded: claim back ${ethLabel(amount)}`, "Claim refund", "btn-primary", () =>
        runTransaction("Claim refund", async () => (await getWriteContract()).refund(campaign.id)),
      );
    }),
  ];

  return el(
    "section",
    { class: "card card-pad" },
    el("h2", {}, "Needs your action"),
    el("ul", { class: "list" }, items),
  );
}

function actionItem(campaign, text, buttonLabel, style, action) {
  const button = el("button", { class: `btn ${style} btn-sm`, type: "button" }, buttonLabel);
  button.addEventListener("click", async () => {
    setBusy(button, true, "Waiting…");
    try {
      await action();
      await render(getCurrentAccount());
    } catch {
      if (button.isConnected) setBusy(button, false); // the transaction tracker shows the reason
    }
  });
  return el("li", { class: "list-item" }, campaignLabel(campaign, el("div", { class: "small muted" }, text)), button);
}

function campaignLabel(campaign, subtitle) {
  return el(
    "div",
    { class: "list-main" },
    cover(campaign, "thumb"),
    el("div", { class: "list-text" }, el("a", { href: `/campaign.html?id=${campaign.id}` }, el("strong", {}, campaign.title)), subtitle),
  );
}

function backedCard(backed) {
  const card = el("section", { class: "card card-pad" }, el("h2", {}, "Campaigns I backed"));
  if (backed.length === 0) {
    card.append(el("p", { class: "muted" }, "You haven't backed any campaigns yet. ", el("a", { href: "/" }, "Explore campaigns")));
    return card;
  }
  card.append(
    el(
      "ul",
      { class: "list" },
      backed.map((campaign) => {
        const refunded = BigInt(campaign.myRefundedWei) > 0n ? ` · refunded ${ethLabel(campaign.myRefundedWei)}` : "";
        return el(
          "li",
          { class: "list-item" },
          campaignLabel(campaign, el("div", { class: "small muted" }, `You gave ${ethLabel(campaign.myContributedWei)}${refunded}`)),
          el("div", { class: "list-side" }, statusBadge(campaign.status)),
        );
      }),
    ),
  );
  return card;
}

function createdCard(created) {
  const card = el("section", { class: "card card-pad" }, el("h2", {}, "Campaigns I created"));
  if (created.length === 0) {
    card.append(el("p", { class: "muted" }, "You haven't created a campaign yet. ", el("a", { href: "/create.html" }, "Start one")));
    return card;
  }
  card.append(
    el(
      "ul",
      { class: "list" },
      created.map((campaign) =>
        el(
          "li",
          { class: "list-item" },
          campaignLabel(
            campaign,
            el(
              "div",
              { class: "small muted stack" },
              `${ethLabel(campaign.totalRaisedWei)} of ${ethLabel(campaign.goalWei)} (${percent(campaign.progress)}) · ${campaign.backerCount} backers`,
              progressBar(campaign.progress),
            ),
          ),
          el("div", { class: "list-side" }, statusBadge(campaign.status)),
        ),
      ),
    ),
  );
  return card;
}

main();
