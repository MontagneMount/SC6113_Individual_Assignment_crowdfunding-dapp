import { api, getConfig } from "../api.js";
import { ethLabel, percent, timeLeft } from "../format.js";
import { initLayout } from "../layout.js";
import { $, cover, el, emptyState, loading, progressBar, statusBadge } from "../ui.js";

const list = $("#campaign-list");
const filters = $("#filters");
let latestRequest = 0;

async function main() {
  await initLayout("explore");

  let config;
  try {
    config = await getConfig();
  } catch {
    list.replaceChildren(emptyState("⚠️", "Can't reach the server", "Please check your connection and reload the page."));
    return;
  }

  for (const category of config.categories) filters.elements.category.append(el("option", { value: category }, category));

  if (!config.contractAddress) {
    const deployLink = config.devTools ? el("a", { class: "btn btn-primary", href: "/deploy.html" }, "Deploy the contract") : null;
    list.replaceChildren(emptyState("🛠️", "Almost ready", "The smart contract hasn't been deployed yet.", deployLink));
    return;
  }

  loadStats();
  loadCampaigns();

  let timer = null;
  filters.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(loadCampaigns, 250);
  });
  filters.addEventListener("submit", (event) => {
    event.preventDefault();
    loadCampaigns();
  });
}

async function loadStats() {
  const box = $("#stats");
  try {
    const stats = await api.stats();
    box.replaceChildren(
      statTile("Total raised", ethLabel(stats.totalRaisedWei)),
      statTile("Campaigns", stats.campaigns),
      statTile("Success rate", stats.successRate === null ? "—" : `${Math.round(stats.successRate * 100)}%`),
      statTile("Backers", stats.backers),
    );
  } catch {
    box.replaceChildren();
  }
}

const statTile = (label, value) =>
  el("div", { class: "card stat" }, el("div", { class: "stat-label" }, label), el("div", { class: "stat-value" }, value));

async function loadCampaigns() {
  const requestId = ++latestRequest;
  const params = Object.fromEntries(new FormData(filters));
  list.replaceChildren(loading("Loading campaigns…"));

  try {
    const { campaigns } = await api.campaigns(params);
    if (requestId !== latestRequest) return; // a newer search has started

    if (campaigns.length === 0) {
      const filtered = Boolean(params.q || params.category || params.status);
      list.replaceChildren(
        filtered
          ? emptyState("🔍", "No matching campaigns", "Try another search or filter.")
          : emptyState("🌱", "No campaigns yet", "Be the first to start one!", el("a", { class: "btn btn-primary", href: "/create.html" }, "Start a campaign")),
      );
      return;
    }
    list.replaceChildren(el("div", { class: "grid-cards" }, campaigns.map(campaignCard)));
  } catch (err) {
    if (requestId !== latestRequest) return;
    list.replaceChildren(emptyState("⚠️", "Couldn't load campaigns", err.message));
  }
}

function campaignCard(campaign) {
  return el(
    "a",
    { class: "card campaign-card", href: `/campaign.html?id=${campaign.id}` },
    cover(campaign, "card"),
    el(
      "div",
      { class: "card-body" },
      el("div", { class: "card-meta" }, statusBadge(campaign.status), campaign.category ? el("span", { class: "tag" }, campaign.category) : null),
      el("h3", { class: "card-title" }, campaign.title),
      campaign.excerpt ? el("p", { class: "card-excerpt" }, campaign.excerpt) : null,
      progressBar(campaign.progress),
      el(
        "div",
        { class: "card-numbers" },
        el("span", {}, el("strong", {}, ethLabel(campaign.totalRaisedWei)), ` of ${ethLabel(campaign.goalWei)}`),
        el("span", { class: "muted" }, percent(campaign.progress)),
      ),
      el(
        "div",
        { class: "card-footer muted" },
        el("span", {}, `${campaign.backerCount} backer${campaign.backerCount === 1 ? "" : "s"}`),
        el("span", {}, timeLeft(campaign.deadline).text),
      ),
    ),
  );
}

main();
