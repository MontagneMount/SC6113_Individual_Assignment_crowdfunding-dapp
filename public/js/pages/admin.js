// Visitor log for the admin wallet: sign in with MetaMask, then view, filter and delete records.
import { api, getConfig } from "../api.js";
import { explainError } from "../contract.js";
import { formatDateTime, shortAddress } from "../format.js";
import { initLayout } from "../layout.js";
import { buildAdminMessage } from "../shared/constants.js";
import { $, el, emptyState, loading, setBusy, toast } from "../ui.js";
import { getEthereum, getSigner } from "../wallet.js";

const root = $("#admin-root");

const PAGE_LABELS = {
  "/": "Explore",
  "/campaign": "Campaign",
  "/create": "Start a campaign",
  "/me": "My activity",
  "/deploy": "Deploy",
};

let auth = null; // { wallet, issuedAt, signature } once the admin has signed in
const filters = { page: "", wallet: "" };

async function main() {
  await initLayout("admin", { logVisit: false });
  const config = await getConfig().catch(() => null);
  if (config) {
    $("#admin-intro").append(` Records are deleted automatically after ${config.limits.visitRetentionDays} days.`);
  }
  renderSignIn();
}

function renderSignIn(problem) {
  const button = el("button", { class: "btn btn-primary", type: "button" }, "Sign in with MetaMask");
  button.addEventListener("click", () => signIn(button));
  const text = getEthereum()
    ? "Sign a message with the admin wallet to open the log. Signing is free and sends no transaction."
    : "You need MetaMask (the browser extension or the MetaMask app) to sign in as the admin.";
  const notice = problem ? el("div", { class: "callout callout-danger mb" }, el("p", {}, problem)) : null;
  root.replaceChildren(...[notice, emptyState("🔐", "Admin sign-in", text, button)].filter(Boolean));
}

async function signIn(button) {
  setBusy(button, true, "Confirm in MetaMask…");
  try {
    const config = await getConfig();
    const signer = await getSigner();
    const wallet = await signer.getAddress();
    const issuedAt = new Date().toISOString();
    const message = buildAdminMessage({ wallet, contractAddress: config.contractAddress, chainId: config.chain.chainId, issuedAt });
    auth = { wallet, issuedAt, signature: await signer.signMessage(message) };
  } catch (err) {
    setBusy(button, false);
    toast(await explainError(err), "error");
    return;
  }
  await load();
}

function activeFilters() {
  return Object.fromEntries(Object.entries(filters).filter(([, value]) => value));
}

async function load() {
  root.replaceChildren(loading("Loading the visitor log…"));
  try {
    render(await api.adminVisits(auth, activeFilters()));
  } catch (err) {
    if (!signOutOnAuthError(err)) {
      const retry = el("button", { class: "btn btn-primary", type: "button", onclick: load }, "Try again");
      root.replaceChildren(emptyState("⚠️", "Couldn't load the visitor log", err.message, retry));
    }
  }
}

/** 401 = the sign-in expired or is invalid, 403 = this wallet is not the admin. */
function signOutOnAuthError(err) {
  if (err.status !== 401 && err.status !== 403) return false;
  auth = null;
  renderSignIn(err.status === 403 ? `${err.message} Switch to the admin account in MetaMask and sign in again.` : err.message);
  return true;
}

function render(data) {
  root.replaceChildren(
    el(
      "div",
      { class: "stack" },
      el("p", { class: "muted small" }, "Signed in as ", el("span", { class: "address", title: data.admin }, shortAddress(data.admin))),
      statTiles(data.stats),
      filterForm(),
      visitsCard(data),
    ),
  );
}

function statTiles(stats) {
  const tile = (label, value) =>
    el("div", { class: "card stat" }, el("div", { class: "stat-label" }, label), el("div", { class: "stat-value" }, value));
  return el(
    "section",
    { class: "stats", "aria-label": "Visit statistics" },
    tile("Total visits", stats.total),
    tile("Last 24 hours", stats.last24h),
    tile("Unique visitors", stats.visitors),
    tile("Wallets seen", stats.wallets),
  );
}

function filterForm() {
  const form = el(
    "form",
    { class: "filters", role: "search" },
    el("input", {
      class: "input search",
      type: "search",
      name: "wallet",
      value: filters.wallet,
      placeholder: "Filter by wallet address (0x…)",
      "aria-label": "Filter by wallet address",
    }),
    el(
      "select",
      { class: "input", name: "page", "aria-label": "Page" },
      el("option", { value: "" }, "All pages"),
      Object.entries(PAGE_LABELS).map(([value, label]) => el("option", { value, selected: value === filters.page }, label)),
    ),
  );
  const apply = () => {
    const next = { wallet: form.elements.wallet.value.trim(), page: form.elements.page.value };
    if (next.wallet === filters.wallet && next.page === filters.page) return; // Enter fires "change" and "submit"
    Object.assign(filters, next);
    load();
  };
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    apply();
  });
  form.elements.wallet.addEventListener("change", apply);
  form.elements.page.addEventListener("change", apply);
  return form;
}

function visitsCard(data) {
  const filtered = Object.keys(activeFilters()).length > 0;
  const deleteAll = el(
    "button",
    { class: "btn btn-danger btn-sm", type: "button", disabled: data.matching === 0 },
    filtered ? `Delete ${data.matching} matching` : `Delete all ${data.matching}`,
  );
  deleteAll.addEventListener("click", () => deleteMatching(deleteAll, data.matching, filtered));
  // Reloading the whole page would forget the sign-in, so refresh the list in place.
  const refresh = el("button", { class: "btn btn-secondary btn-sm", type: "button", onclick: load }, "Refresh");

  const records = data.matching === 1 ? "1 record" : `${data.matching} records`;
  const shown =
    data.matching > data.visits.length
      ? `Showing the latest ${data.visits.length} of ${data.matching} records.`
      : filtered
        ? `${records} ${data.matching === 1 ? "matches" : "match"} the filters.`
        : `${records}.`;
  const card = el(
    "section",
    { class: "card card-pad" },
    el("div", { class: "section-title" }, el("h2", {}, "Visits"), el("div", { class: "row" }, refresh, deleteAll)),
    el("p", { class: "muted small" }, shown),
  );
  if (data.visits.length > 0) card.append(el("ul", { class: "list" }, data.visits.map(visitItem)));
  return card;
}

function visitItem(visit) {
  const label = PAGE_LABELS[visit.page] ?? visit.page;
  const page = visit.campaignId
    ? el("a", { href: `/campaign.html?id=${visit.campaignId}` }, `${label} #${visit.campaignId}`)
    : label;
  const remove = el("button", { class: "btn btn-secondary btn-sm", type: "button", "aria-label": "Delete this record" }, "Delete");
  remove.addEventListener("click", () => deleteOne(remove, visit.id));

  return el(
    "li",
    { class: "list-item" },
    el(
      "div",
      { class: "list-text" },
      el("strong", {}, page),
      el("div", { class: "small muted" }, `${formatDateTime(Date.parse(visit.at) / 1000)} · ${visit.browser}`),
      el(
        "div",
        { class: "small muted" },
        visit.wallet ? el("span", { class: "address", title: visit.wallet }, shortAddress(visit.wallet)) : "No wallet connected",
        ` · visitor ${visit.visitor.slice(0, 8)}`,
      ),
    ),
    el("div", { class: "list-side" }, remove),
  );
}

async function deleteOne(button, id) {
  setBusy(button, true, "Deleting…");
  try {
    await api.deleteVisit(auth, id);
  } catch (err) {
    setBusy(button, false);
    if (!signOutOnAuthError(err)) toast(err.message, "error");
    return;
  }
  toast("Record deleted.", "success");
  await load();
}

async function deleteMatching(button, count, filtered) {
  const what = filtered ? `the ${count} records that match the filters` : `all ${count} records`;
  if (!confirm(`Delete ${what}? This cannot be undone.`)) return;
  setBusy(button, true, "Deleting…");
  let deleted;
  try {
    ({ deleted } = await api.deleteVisits(auth, activeFilters()));
  } catch (err) {
    setBusy(button, false);
    if (!signOutOnAuthError(err)) toast(err.message, "error");
    return;
  }
  toast(`Deleted ${deleted} record${deleted === 1 ? "" : "s"}.`, "success");
  await load();
}

main();
